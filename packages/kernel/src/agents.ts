// Agents as org members (ADR-0029 Phase 1, issue #79): positions in an org chart shared with humans, agents that
// hold them, tasks with a checkout lease, and wake-ups that run on the outbox and jobs.
//
// Who may do what:
// - The chart and the agents are managed by humans only: position, holder, template, agent, budget and kill-switch
//   commands declare no agent access, so the runtime refuses every agent actor, and the database refuses any write
//   to those tables made in an agent context (refuse_agent_write).
// - Agents work only through tasks: checkout, comment, status, escalate, delegate. Every write is made under the
//   lease the run holds (fencing token checked here, run checked by the database triggers).
// - The worker starts and finishes runs as the system; an agent enters a context only through a live run.
import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import { zCheck, zId } from '@crove/kernel-contract';
import type { AgentScope, Database, MemberRole, TaskStatus } from '@crove/db';
import {
  DomainError,
  defineCommand,
  defineQuery,
  type AgentActor,
  type AgentGrant,
  type AgentProgram,
  type CommandContext,
  agentRuntime,
  type QueryContext,
  type Runtime,
} from '@crove/kernel-runtime';
import { memberProfiles } from './profiles.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const MEMBERS: readonly MemberRole[] = ['owner', 'admin', 'member'];
const OWNER: readonly MemberRole[] = ['owner'];

// A run lives at most this long; a checkout lease never outlives its run.
export const RUN_MINUTES = 15;
export const LEASE_MINUTES = 10;
// request_depth cap (ADR-0029 section 4; also a CHECK on task.request_depth).
export const MAX_REQUEST_DEPTH = 5;
// Reasons kept on a coalesced wake-up.
const MAX_WAKE_REASONS = 50;

const zModule = z.string().regex(/^[a-z][a-z0-9_]*$/).max(50);
const zRoleKey = z.string().regex(/^[a-z][a-z0-9_.]*$/).max(100);
const zJobDescription = z.record(z.string(), z.unknown());
const zAgentRisk = z.enum(['R0', 'R1', 'R2']);
const zScope = z.enum(['org', 'module', 'agent']);
// A non-negative amount with up to 6 decimals, as a decimal string (never a JS number for money).
const zAmount = z.string().regex(/^\d{1,12}(\.\d{1,6})?$/);
const zFence = z.union([z.string().regex(/^\d{1,18}$/), z.number().int().nonnegative()]).transform((v) => String(v));

function requireUser(ctx: CommandContext): string {
  if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
  return ctx.actor.userId;
}

function requireAgent(ctx: QueryContext): AgentGrant {
  if (ctx.actor.type !== 'agent' || !ctx.agent) throw new DomainError('FORBIDDEN', 403, 'Chỉ tác tử AI mới thực hiện được việc này');
  return ctx.agent;
}

type Trx = Transaction<Database>;

async function lockPosition(trx: Trx, orgId: string, id: string) {
  const position = await trx.selectFrom('crove_kernel.position').selectAll().where('org_id', '=', orgId).where('id', '=', id).forUpdate().executeTakeFirst();
  if (!position) throw new DomainError('POSITION_NOT_FOUND', 404, 'Không tìm thấy vị trí này');
  return position;
}

async function lockAgent(trx: Trx, orgId: string, id: string) {
  const agent = await trx
    .selectFrom('crove_kernel.agent as a')
    .innerJoin('crove_kernel.agent_template as t', 't.key', 'a.template_key')
    .selectAll('a')
    .select(['t.role_key as template_role_key', 't.module as template_module'])
    .where('a.org_id', '=', orgId)
    .where('a.id', '=', id)
    .forUpdate('a')
    .executeTakeFirst();
  if (!agent) throw new DomainError('AGENT_NOT_FOUND', 404, 'Không tìm thấy tác tử AI này');
  return agent;
}

// Releases every lease held by the agent's runs and ends its running runs (pause, retire, kill switch).
async function stopAgentRuns(trx: Trx, orgId: string, agentIds: string[], reason: string, now: Date): Promise<number> {
  if (agentIds.length === 0) return 0;
  const runs = await trx
    .selectFrom('crove_kernel.ai_run')
    .select('id')
    .where('org_id', '=', orgId)
    .where('agent_id', 'in', agentIds)
    .where('status', '=', 'running')
    .execute();
  const runIds = runs.map((r) => r.id);
  if (runIds.length === 0) return 0;
  await trx
    .updateTable('crove_kernel.task')
    .set({ checkout_run_id: null, lock_expires_at: null })
    .where('org_id', '=', orgId)
    .where('checkout_run_id', 'in', runIds)
    .execute();
  await trx
    .updateTable('crove_kernel.ai_run')
    .set({ status: 'cancelled', finished_at: now, error: reason })
    .where('org_id', '=', orgId)
    .where('id', 'in', runIds)
    .execute();
  await trx
    .updateTable('crove_kernel.agent_wakeup')
    .set({ status: 'done', updated_at: now })
    .where('org_id', '=', orgId)
    .where('run_id', 'in', runIds)
    .where('status', '=', 'claimed')
    .execute();
  return runIds.length;
}

// Wakes the active agent holding the position, if any (ADR-0029 section 5). Requests are coalesced per agent: at most
// one pending row, which collects the reasons. The event goes out on every request: the worker's queue keeps at most
// one queued and one active job per agent, so repeats cost nothing, and a pending row whose run was refused earlier
// (daily cap, kill switch, budget) is picked up again. A tainted task makes the wake-up, and so the run that claims
// it, tainted. An agent of a module this deployment does not enable (CROVE_MODULES) keeps its pending request but is
// not woken: no run starts until the module is enabled again, when the sweep finds the request.
async function requestWakeup(ctx: CommandContext, positionId: string | null, reason: { taskId: string; why: string }, tainted: boolean, depth: number) {
  if (!positionId) return null;
  const holder = await ctx.trx
    .selectFrom('crove_kernel.position as p')
    .innerJoin('crove_kernel.agent as a', (j) => j.onRef('a.org_id', '=', 'p.org_id').onRef('a.id', '=', 'p.holder_agent_id'))
    .innerJoin('crove_kernel.agent_template as t', 't.key', 'a.template_key')
    .select(['a.id', 't.module'])
    .where('p.org_id', '=', ctx.orgId)
    .where('p.id', '=', positionId)
    .where('p.status', '=', 'active')
    .where('a.status', '=', 'active')
    .executeTakeFirst();
  if (!holder) return null;
  await sql`
    INSERT INTO crove_kernel.agent_wakeup AS w (org_id, agent_id, reasons, tainted, request_depth)
    VALUES (${ctx.orgId}::uuid, ${holder.id}::uuid, ${JSON.stringify([reason])}::jsonb, ${tainted}, ${depth})
    ON CONFLICT (org_id, agent_id) WHERE status = 'pending' DO UPDATE SET
      reasons = CASE WHEN pg_catalog.jsonb_array_length(w.reasons) >= ${MAX_WAKE_REASONS} THEN w.reasons ELSE w.reasons || EXCLUDED.reasons END,
      request_count = w.request_count + 1,
      tainted = w.tainted OR EXCLUDED.tainted,
      request_depth = GREATEST(w.request_depth, EXCLUDED.request_depth),
      updated_at = pg_catalog.now()`.execute(ctx.trx);
  if (ctx.installed(holder.module)) await ctx.emit('kernel.agent.wakeup_requested', { agentId: holder.id });
  return holder.id;
}

// Wakes again the agents (all of the org, or the given ones) whose wake-up is still pending, after a change that may
// let a refused run start: a kill switch released, an agent reactivated or placed, a budget changed.
async function rewakePending(ctx: CommandContext, agentIds?: string[]): Promise<void> {
  if (agentIds && agentIds.length === 0) return;
  let query = ctx.trx
    .selectFrom('crove_kernel.agent_wakeup as w')
    .innerJoin('crove_kernel.agent as a', (j) => j.onRef('a.org_id', '=', 'w.org_id').onRef('a.id', '=', 'w.agent_id'))
    .innerJoin('crove_kernel.agent_template as t', 't.key', 'a.template_key')
    .select(['w.agent_id', 't.module'])
    .where('w.org_id', '=', ctx.orgId)
    .where('w.status', '=', 'pending');
  if (agentIds) query = query.where('w.agent_id', 'in', agentIds);
  for (const row of await query.execute()) {
    if (ctx.installed(row.module)) await ctx.emit('kernel.agent.wakeup_requested', { agentId: row.agent_id });
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The chart (owner only, R3: role keys, holders and reporting lines decide what agents may do)
// ---------------------------------------------------------------------------------------------------------------

export const createPosition = defineCommand({
  name: 'kernel.position.create',
  input: z.object({
    title: z.string().trim().min(1).max(200),
    module: zModule,
    roleKey: zRoleKey,
    reportsTo: zId.nullable().optional(),
    jobDescription: zJobDescription.optional(),
  }),
  risk: 'R3',
  access: OWNER,
  handler: async (ctx, input) => {
    requireUser(ctx);
    if (input.reportsTo) await lockPosition(ctx.trx, ctx.orgId, input.reportsTo);
    const position = await ctx.trx
      .insertInto('crove_kernel.position')
      .values({
        org_id: ctx.orgId,
        title: input.title,
        module: input.module,
        role_key: input.roleKey,
        reports_to: input.reportsTo ?? null,
        job_description: JSON.stringify(input.jobDescription ?? {}),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    ctx.audit({ position: position.id, role_key: input.roleKey, reports_to: input.reportsTo ?? null });
    await ctx.activity('kernel.position', position.id, 'position.created', `Tạo vị trí ${input.title}`);
    await ctx.emit('kernel.position.created', { positionId: position.id });
    return { positionId: position.id };
  },
});

export const updatePosition = defineCommand({
  name: 'kernel.position.update',
  input: z.object({
    id: zId,
    title: z.string().trim().min(1).max(200).optional(),
    roleKey: zRoleKey.optional(),
    reportsTo: zId.nullable().optional(),
    jobDescription: zJobDescription.optional(),
    status: z.enum(['active', 'paused', 'archived']).optional(),
  }),
  risk: 'R3',
  access: OWNER,
  target: (input) => ({ type: 'kernel.position', id: input.id }),
  handler: async (ctx, input) => {
    requireUser(ctx);
    const before = await lockPosition(ctx.trx, ctx.orgId, input.id);
    const set: Record<string, unknown> = {};
    if (input.title !== undefined) set.title = input.title;
    if (input.roleKey !== undefined) set.role_key = input.roleKey;
    if (input.reportsTo !== undefined) set.reports_to = input.reportsTo;
    if (input.jobDescription !== undefined) set.job_description = JSON.stringify(input.jobDescription);
    if (input.status !== undefined) set.status = input.status;
    ctx.audit({
      position: input.id,
      previous: { title: before.title, role_key: before.role_key, reports_to: before.reports_to, status: before.status },
      changed: Object.keys(set),
    });
    if (Object.keys(set).length === 0) return { positionId: input.id };
    await ctx.trx.updateTable('crove_kernel.position').set(set).where('org_id', '=', ctx.orgId).where('id', '=', input.id).execute();
    await ctx.activity('kernel.position', input.id, 'position.updated', `Sửa vị trí ${input.title ?? before.title}`);
    await ctx.emit('kernel.position.updated', { positionId: input.id });
    return { positionId: input.id };
  },
});

const zHolder = z.discriminatedUnion('type', [z.object({ type: z.literal('user'), userId: zId }), z.object({ type: z.literal('agent'), agentId: zId })]).nullable();

// Gives a position to a member or an agent, or vacates it. An agent must be active, hold no other position, and be of
// a template whose role key is the position's. The database releases the leases on the position's tasks.
export const assignPosition = defineCommand({
  name: 'kernel.position.assign',
  input: z.object({ id: zId, holder: zHolder }),
  risk: 'R3',
  access: OWNER,
  target: (input) => ({ type: 'kernel.position', id: input.id }),
  handler: async (ctx, input) => {
    requireUser(ctx);
    const position = await lockPosition(ctx.trx, ctx.orgId, input.id);
    let holderUser: string | null = null;
    let holderAgent: string | null = null;
    if (input.holder?.type === 'user') {
      const member = await ctx.trx
        .selectFrom('crove_kernel.tenant_member')
        .select('user_id')
        .where('org_id', '=', ctx.orgId)
        .where('user_id', '=', input.holder.userId)
        .executeTakeFirst();
      if (!member) throw new DomainError('MEMBER_NOT_FOUND', 404, 'Không tìm thấy thành viên này trong tổ chức');
      holderUser = member.user_id;
    } else if (input.holder?.type === 'agent') {
      const agent = await lockAgent(ctx.trx, ctx.orgId, input.holder.agentId);
      if (agent.status !== 'active') throw new DomainError('AGENT_NOT_ACTIVE', 409, 'Tác tử AI này không hoạt động');
      if (agent.template_role_key !== position.role_key) {
        throw new DomainError('AGENT_ROLE_MISMATCH', 422, 'Vai trò của vị trí không khớp với mẫu của tác tử AI');
      }
      const placed = await ctx.trx
        .selectFrom('crove_kernel.position')
        .select('id')
        .where('org_id', '=', ctx.orgId)
        .where('holder_agent_id', '=', agent.id)
        .where('id', '<>', position.id)
        .executeTakeFirst();
      if (placed) throw new DomainError('AGENT_ALREADY_PLACED', 409, 'Tác tử AI này đang giữ một vị trí khác');
      holderAgent = agent.id;
    }
    ctx.audit({
      position: position.id,
      holder: input.holder,
      previous_holder: position.holder_agent_id
        ? { type: 'agent', agentId: position.holder_agent_id }
        : position.holder_user_id
          ? { type: 'user', userId: position.holder_user_id }
          : null,
    });
    await ctx.trx
      .updateTable('crove_kernel.position')
      .set({ holder_user_id: holderUser, holder_agent_id: holderAgent })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', position.id)
      .execute();
    if (holderAgent) {
      // One wake-up for the open tasks, as tainted as the most tainted of them, so the run that takes them over can
      // read every one (an untainted run sees only untainted tasks).
      const open = await ctx.trx
        .selectFrom('crove_kernel.task')
        .select((eb) => [
          eb.fn.min<string>(sql`id::text`).as('first_id'),
          eb.fn<boolean>('bool_or', ['tainted']).as('tainted'),
          eb.fn.max('request_depth').as('request_depth'),
        ])
        .where('org_id', '=', ctx.orgId)
        .where('assignee_position_id', '=', position.id)
        .where('status', 'in', ['todo', 'in_progress'])
        .executeTakeFirst();
      if (open?.first_id) {
        await requestWakeup(ctx, position.id, { taskId: open.first_id, why: 'holder_changed' }, open.tainted === true, Number(open.request_depth ?? 0));
      } else await rewakePending(ctx, [holderAgent]);
    }
    await ctx.activity('kernel.position', position.id, 'position.assigned', `Đổi người giữ vị trí ${position.title}`);
    await ctx.emit('kernel.position.assigned', { positionId: position.id });
    return { positionId: position.id };
  },
});

// Installs a module's agent template: an agent and a position it holds, from the template's data. Refused when this
// deployment does not enable the template's module (CROVE_MODULES, ADR-0031): its program and role keys are not here.
export const installAgentTemplate = defineCommand({
  name: 'kernel.agent.template.install',
  input: z.object({ templateKey: z.string().min(1).max(100), reportsTo: zId.nullable().optional(), displayName: z.string().trim().min(1).max(200).optional() }),
  risk: 'R3',
  access: OWNER,
  handler: async (ctx, input) => {
    const userId = requireUser(ctx);
    const template = await ctx.trx.selectFrom('crove_kernel.agent_template').selectAll().where('key', '=', input.templateKey).executeTakeFirst();
    if (!template) throw new DomainError('TEMPLATE_NOT_FOUND', 404, 'Không có mẫu tác tử AI này');
    if (!ctx.installed(template.module)) {
      throw new DomainError('MODULE_DISABLED', 409, 'Phân hệ của mẫu tác tử AI này chưa được bật', { module: template.module });
    }
    if (input.reportsTo) await lockPosition(ctx.trx, ctx.orgId, input.reportsTo);
    const agent = await ctx.trx
      .insertInto('crove_kernel.agent')
      .values({
        org_id: ctx.orgId,
        template_key: template.key,
        display_name: input.displayName ?? template.title,
        max_risk: template.max_risk,
        daily_run_cap: template.daily_run_cap,
        created_by: userId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const position = await ctx.trx
      .insertInto('crove_kernel.position')
      .values({
        org_id: ctx.orgId,
        title: template.title,
        module: template.module,
        role_key: template.role_key,
        reports_to: input.reportsTo ?? null,
        holder_agent_id: agent.id,
        job_description: JSON.stringify(template.job_description),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    ctx.audit({ template: template.key, agent: agent.id, position: position.id, max_risk: template.max_risk });
    await ctx.activity('kernel.agent', agent.id, 'agent.installed', `Thêm tác tử AI ${template.title}`);
    await ctx.emit('kernel.agent.installed', { agentId: agent.id, positionId: position.id, templateKey: template.key });
    return { agentId: agent.id, positionId: position.id };
  },
});

// Changes an agent's status, max_risk, name or daily run cap. Pausing or retiring stops its runs and releases its
// leases at once; its in-progress tasks wait; retiring also vacates its position.
export const updateAgent = defineCommand({
  name: 'kernel.agent.update',
  input: z.object({
    id: zId,
    status: z.enum(['active', 'paused', 'retired']).optional(),
    maxRisk: zAgentRisk.optional(),
    displayName: z.string().trim().min(1).max(200).optional(),
    dailyRunCap: z.number().int().min(1).max(10000).optional(),
  }),
  risk: 'R3',
  access: OWNER,
  target: (input) => ({ type: 'kernel.agent', id: input.id }),
  handler: async (ctx, input) => {
    requireUser(ctx);
    const agent = await lockAgent(ctx.trx, ctx.orgId, input.id);
    if (agent.status === 'retired' && input.status && input.status !== 'retired') {
      throw new DomainError('AGENT_RETIRED', 409, 'Tác tử AI đã ngừng hẳn, không bật lại được');
    }
    const set: Record<string, unknown> = { updated_at: ctx.now };
    if (input.status !== undefined) set.status = input.status;
    if (input.maxRisk !== undefined) set.max_risk = input.maxRisk;
    if (input.displayName !== undefined) set.display_name = input.displayName;
    if (input.dailyRunCap !== undefined) set.daily_run_cap = input.dailyRunCap;
    ctx.audit({
      agent: agent.id,
      previous: { status: agent.status, max_risk: agent.max_risk, daily_run_cap: agent.daily_run_cap },
      status: input.status ?? agent.status,
      max_risk: input.maxRisk ?? agent.max_risk,
    });
    const stopping = input.status !== undefined && input.status !== 'active' && agent.status === 'active';
    if (stopping) {
      await stopAgentRuns(ctx.trx, ctx.orgId, [agent.id], `agent ${input.status}`, ctx.now);
      const position = await ctx.trx
        .selectFrom('crove_kernel.position')
        .select('id')
        .where('org_id', '=', ctx.orgId)
        .where('holder_agent_id', '=', agent.id)
        .executeTakeFirst();
      if (position) {
        await ctx.trx
          .updateTable('crove_kernel.task')
          .set({ status: 'waiting' })
          .where('org_id', '=', ctx.orgId)
          .where('assignee_position_id', '=', position.id)
          .where('status', '=', 'in_progress')
          .execute();
      }
    }
    await ctx.trx.updateTable('crove_kernel.agent').set(set).where('org_id', '=', ctx.orgId).where('id', '=', agent.id).execute();
    if (input.status === 'retired') {
      await ctx.trx
        .updateTable('crove_kernel.position')
        .set({ holder_agent_id: null })
        .where('org_id', '=', ctx.orgId)
        .where('holder_agent_id', '=', agent.id)
        .execute();
    }
    if (input.status === 'active' && agent.status !== 'active') await rewakePending(ctx, [agent.id]);
    await ctx.activity('kernel.agent', agent.id, 'agent.updated', `Sửa tác tử AI ${input.displayName ?? agent.display_name}`);
    await ctx.emit('kernel.agent.updated', { agentId: agent.id });
    return { agentId: agent.id };
  },
});

// The canonical target of a scope: '*' for the org, the module id, or the agent id as the database prints it (lowercase),
// so the text comparisons at context entry always match (the tables also refuse any other form).
async function checkScopeTarget(ctx: CommandContext, scope: AgentScope, target: string): Promise<string> {
  if (scope === 'org' ? target !== '*' : scope === 'module' ? !zModule.safeParse(target).success : !zId.safeParse(target).success) {
    throw new DomainError('INVALID_TARGET', 422, 'Phạm vi không hợp lệ');
  }
  if (scope !== 'agent') return target;
  const agent = await ctx.trx.selectFrom('crove_kernel.agent').select('id').where('org_id', '=', ctx.orgId).where('id', '=', target).executeTakeFirst();
  if (!agent) throw new DomainError('AGENT_NOT_FOUND', 404, 'Không tìm thấy tác tử AI này');
  return agent.id;
}

// Sets the monthly budget of the org, a module or an agent (ai_run cost). A spent hard-stop budget refuses every
// agent context it covers.
export const setAgentBudget = defineCommand({
  name: 'kernel.agent.budget.set',
  input: z.object({ scope: zScope, target: z.string().min(1).max(100), monthlyLimit: zAmount, warnPercent: z.number().int().min(1).max(100).optional(), hardStop: z.boolean().optional() }),
  risk: 'R3',
  access: OWNER,
  handler: async (ctx, input) => {
    const userId = requireUser(ctx);
    const target = await checkScopeTarget(ctx, input.scope, input.target);
    const row = await ctx.trx
      .insertInto('crove_kernel.budget_policy')
      .values({
        org_id: ctx.orgId,
        scope: input.scope,
        target,
        monthly_limit: input.monthlyLimit,
        warn_percent: input.warnPercent ?? 80,
        hard_stop: input.hardStop ?? true,
        updated_by: userId,
      })
      .onConflict((oc) =>
        oc.columns(['org_id', 'scope', 'target']).doUpdateSet((eb) => ({
          monthly_limit: eb.ref('excluded.monthly_limit'),
          warn_percent: eb.ref('excluded.warn_percent'),
          hard_stop: eb.ref('excluded.hard_stop'),
          updated_by: eb.ref('excluded.updated_by'),
          updated_at: ctx.now,
        })),
      )
      .returning('id')
      .executeTakeFirstOrThrow();
    ctx.audit({ budget: row.id, scope: input.scope, target, monthly_limit: input.monthlyLimit, hard_stop: input.hardStop ?? true });
    await rewakePending(ctx);
    await ctx.activity('kernel.agent', row.id, 'agent.budget_set', `Đặt ngân sách AI (${input.scope} ${target}): ${input.monthlyLimit}`);
    return { budgetId: row.id };
  },
});

// Stops agents at once: every agent of the org, a module or one agent. R1 for owners and admins, so "Stop AI" is
// never behind a second factor; releasing it is R3 and owner only.
export const engageKillSwitch = defineCommand({
  name: 'kernel.agent.kill_switch.engage',
  input: z.object({ scope: zScope, target: z.string().min(1).max(100), reason: z.string().max(500).optional() }),
  risk: 'R1',
  access: ['owner', 'admin'],
  handler: async (ctx, input) => {
    const userId = requireUser(ctx);
    const target = await checkScopeTarget(ctx, input.scope, input.target);
    await sql`
      INSERT INTO crove_kernel.kill_switch (org_id, scope, target, reason, engaged_by)
      VALUES (${ctx.orgId}::uuid, ${input.scope}, ${target}, ${input.reason ?? null}, ${userId}::uuid)
      ON CONFLICT (org_id, scope, target) WHERE released_at IS NULL DO NOTHING`.execute(ctx.trx);
    const active = await ctx.trx
      .selectFrom('crove_kernel.kill_switch')
      .select('id')
      .where('org_id', '=', ctx.orgId)
      .where('scope', '=', input.scope)
      .where('target', '=', target)
      .where('released_at', 'is', null)
      .executeTakeFirstOrThrow();
    let covered = ctx.trx.selectFrom('crove_kernel.agent as a').select('a.id').where('a.org_id', '=', ctx.orgId);
    if (input.scope === 'agent') covered = covered.where('a.id', '=', target);
    if (input.scope === 'module') {
      covered = covered.where((eb) =>
        eb.exists(
          eb
            .selectFrom('crove_kernel.position as p')
            .select('p.id')
            .whereRef('p.org_id', '=', 'a.org_id')
            .whereRef('p.holder_agent_id', '=', 'a.id')
            .where('p.module', '=', target),
        ),
      );
    }
    const agents = (await covered.execute()).map((a) => a.id);
    const stopped = await stopAgentRuns(ctx.trx, ctx.orgId, agents, 'kill switch', ctx.now);
    ctx.audit({ kill_switch: active.id, scope: input.scope, target, stopped_runs: stopped });
    await ctx.activity('kernel.agent', active.id, 'agent.kill_switch_engaged', `Dừng AI (${input.scope} ${target})`);
    return { killSwitchId: active.id, stoppedRuns: stopped };
  },
});

export const releaseKillSwitch = defineCommand({
  name: 'kernel.agent.kill_switch.release',
  input: z.object({ id: zId }),
  risk: 'R3',
  access: OWNER,
  target: (input) => ({ type: 'kernel.kill_switch', id: input.id }),
  handler: async (ctx, input) => {
    const userId = requireUser(ctx);
    const released = await ctx.trx
      .updateTable('crove_kernel.kill_switch')
      .set({ released_at: ctx.now, released_by: userId })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.id)
      .where('released_at', 'is', null)
      .returning(['scope', 'target'])
      .executeTakeFirst();
    if (!released) throw new DomainError('NOT_FOUND', 404, 'Không tìm thấy công tắc dừng AI đang bật');
    ctx.audit({ kill_switch: input.id, scope: released.scope, target: released.target });
    await rewakePending(ctx);
    await ctx.activity('kernel.agent', input.id, 'agent.kill_switch_released', `Bật lại AI (${released.scope} ${released.target})`);
    return { ok: true as const };
  },
});

// ---------------------------------------------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------------------------------------------

const zTaskTitle = z.string().trim().min(1).max(300);

// A human gives work to a position (or, with no position, to the owner at the root of the chart).
export const createTask = defineCommand({
  name: 'kernel.task.create',
  input: z.object({ title: zTaskTitle, description: z.string().max(10000).optional(), assigneePositionId: zId.nullable(), due: z.iso.datetime().optional() }),
  risk: 'R1',
  access: MEMBERS,
  handler: async (ctx, input) => {
    requireUser(ctx);
    if (input.assigneePositionId) {
      const position = await lockPosition(ctx.trx, ctx.orgId, input.assigneePositionId);
      if (position.status === 'archived') throw new DomainError('POSITION_ARCHIVED', 409, 'Vị trí này đã ngừng sử dụng');
    }
    const task = await ctx.trx
      .insertInto('crove_kernel.task')
      .values({
        org_id: ctx.orgId,
        title: input.title,
        description: input.description ?? null,
        assignee_position_id: input.assigneePositionId,
        source: 'human',
        created_by_type: 'user',
        due: input.due ?? null,
      })
      .returning(['id', 'tainted', 'request_depth'])
      .executeTakeFirstOrThrow();
    await requestWakeup(ctx, input.assigneePositionId, { taskId: task.id, why: 'assigned' }, task.tainted, task.request_depth);
    await ctx.emit('kernel.task.created', { taskId: task.id });
    return { taskId: task.id };
  },
});

// The task row an agent's run holds the lease on with this fencing token, locked; refused once the lease was lost
// (expired, taken by another run, or released).
async function requireLease(ctx: CommandContext, taskId: string, fence: string) {
  const agent = requireAgent(ctx);
  const task = await ctx.trx
    .selectFrom('crove_kernel.task')
    .selectAll()
    .where('org_id', '=', ctx.orgId)
    .where('id', '=', taskId)
    .where('assignee_position_id', '=', agent.positionId)
    .forUpdate()
    .executeTakeFirst();
  if (!task) throw new DomainError('TASK_NOT_FOUND', 404, 'Không tìm thấy việc này');
  if (task.checkout_run_id !== agent.runId || task.fence !== fence || !task.lock_expires_at || task.lock_expires_at.getTime() <= ctx.now.getTime()) {
    throw new DomainError('LEASE_LOST', 409, 'Tác tử AI không còn giữ việc này');
  }
  return task;
}

// Claims a task of the agent's own position: free or expired leases only; the fencing token increments.
export const checkoutTask = defineCommand({
  name: 'kernel.task.checkout',
  input: z.object({ id: zId }),
  risk: 'R1',
  access: [],
  agent: { roles: 'any', taint: 'propagate' },
  target: (input) => ({ type: 'kernel.task', id: input.id }),
  handler: async (ctx, input) => {
    const agent = requireAgent(ctx);
    const { rows: runs } = await sql<{ expires_at: Date }>`
      SELECT expires_at FROM crove_kernel.ai_run WHERE org_id = ${ctx.orgId}::uuid AND id = ${agent.runId}::uuid`.execute(ctx.trx);
    const runEnds = runs[0]?.expires_at;
    if (!runEnds) throw new DomainError('AGENT_RUN_NOT_LIVE', 403, 'Lượt chạy của tác tử AI đã kết thúc');
    const leaseEnds = new Date(Math.min(runEnds.getTime(), ctx.now.getTime() + LEASE_MINUTES * 60_000));
    const claimed = await ctx.trx
      .updateTable('crove_kernel.task')
      .set(() => ({
        checkout_run_id: agent.runId,
        lock_expires_at: leaseEnds,
        fence: sql<string>`fence + 1`,
        status: sql<TaskStatus>`CASE WHEN status = 'todo' THEN 'in_progress' ELSE status END`,
      }))
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.id)
      .where('assignee_position_id', '=', agent.positionId)
      .where('status', 'in', ['todo', 'in_progress', 'waiting'])
      .where((eb) => eb.or([eb('checkout_run_id', 'is', null), eb('lock_expires_at', '<=', sql<Date>`now()`)]))
      .returning(['fence', 'lock_expires_at'])
      .executeTakeFirst();
    if (!claimed) {
      const task = await ctx.trx
        .selectFrom('crove_kernel.task')
        .select(['status', 'checkout_run_id'])
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', input.id)
        .where('assignee_position_id', '=', agent.positionId)
        .executeTakeFirst();
      if (!task) throw new DomainError('TASK_NOT_FOUND', 404, 'Không tìm thấy việc này');
      if (task.checkout_run_id) throw new DomainError('TASK_CHECKED_OUT', 409, 'Việc này đang được xử lý');
      throw new DomainError('TASK_CLOSED', 409, 'Việc này đã kết thúc hoặc đang chờ người khác');
    }
    ctx.audit({ task: input.id, fence: claimed.fence });
    return { fence: claimed.fence, lockExpiresAt: claimed.lock_expires_at?.toISOString() ?? null };
  },
});

export const commentTask = defineCommand({
  name: 'kernel.task.comment',
  input: z.object({ id: zId, body: z.string().trim().min(1).max(10000), fence: zFence.optional() }),
  risk: 'R1',
  access: MEMBERS,
  agent: { roles: 'any', taint: 'propagate' },
  target: (input) => ({ type: 'kernel.task', id: input.id }),
  handler: async (ctx, input) => {
    if (ctx.actor.type === 'agent') {
      if (input.fence === undefined) throw new DomainError('LEASE_LOST', 409, 'Tác tử AI không còn giữ việc này');
      await requireLease(ctx, input.id, input.fence);
    } else {
      requireUser(ctx);
      const task = await ctx.trx.selectFrom('crove_kernel.task').select('id').where('org_id', '=', ctx.orgId).where('id', '=', input.id).executeTakeFirst();
      if (!task) throw new DomainError('TASK_NOT_FOUND', 404, 'Không tìm thấy việc này');
    }
    const comment = await ctx.trx
      .insertInto('crove_kernel.task_comment')
      .values({ org_id: ctx.orgId, task_id: input.id, body: input.body, author_type: ctx.actor.type })
      .returning('id')
      .executeTakeFirstOrThrow();
    return { commentId: comment.id };
  },
});

// Statuses an agent may set on a task it holds; every one but in_progress ends its lease.
const AGENT_STATUSES = ['in_progress', 'waiting', 'in_review', 'done'] as const;

export const setTaskStatus = defineCommand({
  name: 'kernel.task.set_status',
  input: z.object({ id: zId, status: z.enum(['todo', 'in_progress', 'waiting', 'in_review', 'done', 'cancelled']), fence: zFence.optional() }),
  risk: 'R1',
  access: MEMBERS,
  agent: { roles: 'any', taint: 'propagate' },
  target: (input) => ({ type: 'kernel.task', id: input.id }),
  handler: async (ctx, input) => {
    const release = input.status !== 'in_progress';
    if (ctx.actor.type === 'agent') {
      if (!(AGENT_STATUSES as readonly string[]).includes(input.status)) throw new DomainError('FORBIDDEN', 403, 'Tác tử AI không được đặt trạng thái này');
      if (input.fence === undefined) throw new DomainError('LEASE_LOST', 409, 'Tác tử AI không còn giữ việc này');
      await requireLease(ctx, input.id, input.fence);
    } else {
      requireUser(ctx);
    }
    const updated = await ctx.trx
      .updateTable('crove_kernel.task')
      .set(release ? { status: input.status, checkout_run_id: null, lock_expires_at: null } : { status: input.status })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.id)
      .returning(['assignee_position_id', 'tainted', 'request_depth'])
      .executeTakeFirst();
    if (!updated) throw new DomainError('TASK_NOT_FOUND', 404, 'Không tìm thấy việc này');
    ctx.audit({ task: input.id, status: input.status });
    if (ctx.actor.type === 'user' && input.status === 'todo') {
      await requestWakeup(ctx, updated.assignee_position_id, { taskId: input.id, why: 'reopened' }, updated.tainted, updated.request_depth);
    }
    return { taskId: input.id, status: input.status };
  },
});

// Where an escalation goes: the nearest active position up the chart held by a human, otherwise the owner (null). Phase
// 1 escalates to humans only: an agent-held supervisor would get work no template program handles (ADR-0029, Phase 1
// as built).
async function escalationTarget(trx: Trx, orgId: string, positionId: string): Promise<string | null> {
  const { rows } = await sql<{ id: string; depth: number; holder_user_id: string | null; status: string }>`
    WITH RECURSIVE up (id, depth) AS (
      SELECT p.reports_to, 1 FROM crove_kernel.position p WHERE p.org_id = ${orgId}::uuid AND p.id = ${positionId}::uuid AND p.reports_to IS NOT NULL
      UNION ALL
      SELECT p.reports_to, up.depth + 1 FROM up JOIN crove_kernel.position p ON p.org_id = ${orgId}::uuid AND p.id = up.id
      WHERE p.reports_to IS NOT NULL AND up.depth < 100
    )
    SELECT p.id, up.depth, p.holder_user_id, p.status
    FROM up JOIN crove_kernel.position p ON p.org_id = ${orgId}::uuid AND p.id = up.id
    ORDER BY up.depth`.execute(trx);
  return rows.find((r) => r.status === 'active' && r.holder_user_id)?.id ?? null;
}

async function inSubtree(trx: Trx, orgId: string, root: string, candidate: string): Promise<boolean> {
  const { rows } = await sql<{ found: boolean }>`
    WITH RECURSIVE up (id, depth) AS (
      SELECT p.reports_to, 1 FROM crove_kernel.position p WHERE p.org_id = ${orgId}::uuid AND p.id = ${candidate}::uuid
      UNION ALL
      SELECT p.reports_to, up.depth + 1 FROM up JOIN crove_kernel.position p ON p.org_id = ${orgId}::uuid AND p.id = up.id
      WHERE up.id IS NOT NULL AND up.depth < 100
    )
    SELECT EXISTS (SELECT 1 FROM up WHERE up.id = ${root}::uuid) AS found`.execute(trx);
  return rows[0]?.found === true;
}

function depthLimit(): DomainError {
  return new DomainError('DEPTH_LIMIT', 422, `Chuỗi giao việc đã quá ${MAX_REQUEST_DEPTH} bước; cần người xử lý`, { rule: 'request_depth' });
}

// An agent hands a task it holds up the chart: a child task for the escalation target, and its own task waits.
export const escalateTask = defineCommand({
  name: 'kernel.task.escalate',
  input: z.object({ id: zId, fence: zFence, title: zTaskTitle, reason: z.string().trim().min(1).max(10000) }),
  risk: 'R1',
  access: [],
  agent: { roles: 'any', taint: 'propagate' },
  target: (input) => ({ type: 'kernel.task', id: input.id }),
  handler: async (ctx, input) => {
    const agent = requireAgent(ctx);
    const parent = await requireLease(ctx, input.id, input.fence);
    if (parent.request_depth >= MAX_REQUEST_DEPTH) throw depthLimit();
    const target = await escalationTarget(ctx.trx, ctx.orgId, agent.positionId);
    const child = await ctx.trx
      .insertInto('crove_kernel.task')
      .values({
        org_id: ctx.orgId,
        title: input.title,
        description: input.reason,
        kind: 'escalation',
        assignee_position_id: target,
        parent_task_id: parent.id,
        source: parent.source,
        source_ref: parent.source_ref === null ? null : JSON.stringify(parent.source_ref),
        created_by_type: 'agent',
      })
      .returning(['id', 'tainted', 'request_depth'])
      .executeTakeFirstOrThrow();
    await ctx.trx
      .updateTable('crove_kernel.task')
      .set({ status: 'waiting', checkout_run_id: null, lock_expires_at: null })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', parent.id)
      .execute();
    await requestWakeup(ctx, target, { taskId: child.id, why: 'escalated' }, child.tainted, child.request_depth);
    ctx.audit({ task: parent.id, escalated_to: target, child: child.id, request_depth: child.request_depth, tainted: child.tainted });
    await ctx.emit('kernel.task.escalated', { taskId: child.id, parentTaskId: parent.id });
    return { taskId: child.id, assigneePositionId: target };
  },
});

// An agent gives part of a task it holds to a position in its own subtree (never up or sideways).
export const delegateTask = defineCommand({
  name: 'kernel.task.delegate',
  input: z.object({ id: zId, fence: zFence, assigneePositionId: zId, title: zTaskTitle, description: z.string().max(10000).optional() }),
  risk: 'R1',
  access: [],
  agent: { roles: 'any', taint: 'propagate' },
  target: (input) => ({ type: 'kernel.task', id: input.id }),
  handler: async (ctx, input) => {
    const agent = requireAgent(ctx);
    const parent = await requireLease(ctx, input.id, input.fence);
    if (input.assigneePositionId === agent.positionId || !(await inSubtree(ctx.trx, ctx.orgId, agent.positionId, input.assigneePositionId))) {
      throw new DomainError('OUTSIDE_SUBTREE', 403, 'Tác tử AI chỉ giao việc cho vị trí cấp dưới của mình', { rule: 'delegation_subtree' });
    }
    // Read without a row lock: the run already holds the task, and chart commands lock positions before tasks.
    const target = await ctx.trx
      .selectFrom('crove_kernel.position')
      .select('status')
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.assigneePositionId)
      .executeTakeFirst();
    if (target?.status === 'archived') throw new DomainError('POSITION_ARCHIVED', 409, 'Vị trí này đã ngừng sử dụng');
    if (parent.request_depth >= MAX_REQUEST_DEPTH) throw depthLimit();
    const child = await ctx.trx
      .insertInto('crove_kernel.task')
      .values({
        org_id: ctx.orgId,
        title: input.title,
        description: input.description ?? null,
        kind: 'delegation',
        assignee_position_id: input.assigneePositionId,
        parent_task_id: parent.id,
        source: parent.source,
        source_ref: parent.source_ref === null ? null : JSON.stringify(parent.source_ref),
        created_by_type: 'agent',
      })
      .returning(['id', 'tainted', 'request_depth'])
      .executeTakeFirstOrThrow();
    await requestWakeup(ctx, input.assigneePositionId, { taskId: child.id, why: 'delegated' }, child.tainted, child.request_depth);
    ctx.audit({ task: parent.id, delegated_to: input.assigneePositionId, child: child.id, request_depth: child.request_depth });
    await ctx.emit('kernel.task.delegated', { taskId: child.id, parentTaskId: parent.id });
    return { taskId: child.id };
  },
});

// ---------------------------------------------------------------------------------------------------------------
// Wake-ups and runs (system, in the worker)
// ---------------------------------------------------------------------------------------------------------------

const zProposalRef = z.object({ type: z.literal('kernel.proposal'), id: zId });
const zChecksPayload = z.object({ checks: z.array(zCheck).max(50) });

// Inbox triage: a subscribed event creates a task for every active agent position whose template subscribes to it,
// and wakes the agent. The event is read from the outbox in the database, never taken from the job payload. Agents
// of a module this deployment does not enable get no task.
export const dispatchAgentEvent = defineCommand({
  name: 'kernel.agent.dispatch_event',
  input: z.object({ eventId: zId }),
  risk: 'R1',
  access: 'system',
  handler: async (ctx, input) => {
    const event = await ctx.trx
      .selectFrom('crove_kernel.outbox_event')
      .select(['id', 'type', 'payload'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.eventId)
      .executeTakeFirst();
    if (!event || event.type !== 'kernel.proposal.created') return { tasks: 0 };
    const proposalId = z.object({ proposalId: zId }).safeParse(event.payload);
    if (!proposalId.success) return { tasks: 0 };
    const proposal = await ctx.trx
      .selectFrom('crove_kernel.proposal as p')
      .leftJoin('crove_kernel.extraction as e', (j) => j.onRef('e.org_id', '=', 'p.org_id').onRef('e.id', '=', 'p.extraction_id'))
      .select(['p.id', 'p.title', 'p.status', 'p.extraction_id', 'e.tainted'])
      .where('p.org_id', '=', ctx.orgId)
      .where('p.id', '=', proposalId.data.proposalId)
      .executeTakeFirst();
    if (!proposal || proposal.status !== 'pending') return { tasks: 0 };
    // Content read from a file is tainted; a missing extraction row is treated as tainted too.
    const tainted = proposal.extraction_id !== null ? proposal.tainted !== false : false;
    const seats = await ctx.trx
      .selectFrom('crove_kernel.agent as a')
      .innerJoin('crove_kernel.agent_template as t', 't.key', 'a.template_key')
      .innerJoin('crove_kernel.position as p', (j) => j.onRef('p.org_id', '=', 'a.org_id').onRef('p.holder_agent_id', '=', 'a.id'))
      .select(['p.id as position_id', 't.module'])
      .where('a.org_id', '=', ctx.orgId)
      .where('a.status', '=', 'active')
      .where('p.status', '=', 'active')
      .where(sql<boolean>`t.subscribes @> ARRAY[${event.type}]::text[]`)
      .execute();
    let created = 0;
    for (const seat of seats.filter((s) => ctx.installed(s.module))) {
      const task = await ctx.trx
        .insertInto('crove_kernel.task')
        .values({
          org_id: ctx.orgId,
          title: `Rà soát đề xuất: ${proposal.title}`.slice(0, 300),
          kind: 'proposal_review',
          assignee_position_id: seat.position_id,
          source: 'event',
          source_ref: JSON.stringify({ type: 'kernel.proposal', id: proposal.id }),
          source_event_id: event.id,
          created_by_type: 'system',
          tainted,
        })
        .onConflict((oc) => oc.columns(['org_id', 'source_event_id', 'assignee_position_id']).where('source_event_id', 'is not', null).doNothing())
        .returning(['id', 'tainted', 'request_depth'])
        .executeTakeFirst();
      if (!task) continue;
      created += 1;
      await requestWakeup(ctx, seat.position_id, { taskId: task.id, why: 'event' }, task.tainted, task.request_depth);
    }
    ctx.audit({ event: event.id, type: event.type, tasks: created });
    return { tasks: created };
  },
});

export type RunStartResult =
  | { runId: string; templateKey: string; tainted: boolean }
  | { runId: null; reason: 'not_runnable' | 'module_disabled' | 'kill_switch' | 'budget' | 'daily_cap' | 'busy' | 'idle' };

// Starts a run for an agent with pending wake-ups: one running run per agent (the agent row lock here, a unique index
// in the database), within its daily run cap, budgets and kill switches. Runs past their expiry are closed first and
// their leases released. The run is tainted when any wake-up it claims is.
export const startAgentRun = defineCommand({
  name: 'kernel.agent.run.start',
  input: z.object({ agentId: zId }),
  risk: 'R1',
  access: 'system',
  target: (input) => ({ type: 'kernel.agent', id: input.agentId }),
  handler: async (ctx, input): Promise<RunStartResult> => {
    const agent = await lockAgent(ctx.trx, ctx.orgId, input.agentId);
    const position = await ctx.trx
      .selectFrom('crove_kernel.position')
      .select(['id', 'module', 'role_key'])
      .where('org_id', '=', ctx.orgId)
      .where('holder_agent_id', '=', agent.id)
      .where('status', '=', 'active')
      .executeTakeFirst();
    const done = (reason: Exclude<RunStartResult, { runId: string }>['reason']): RunStartResult => {
      ctx.audit({ agent: agent.id, started: false, reason });
      return { runId: null, reason };
    };
    if (agent.status !== 'active' || !position || position.role_key !== agent.template_role_key) return done('not_runnable');
    if (!ctx.installed(agent.template_module)) return done('module_disabled');
    const { rows: gates } = await sql<{ killed: boolean; spent: boolean; today: number }>`
      SELECT
        EXISTS (SELECT 1 FROM crove_kernel.kill_switch k WHERE k.org_id = ${ctx.orgId}::uuid AND k.released_at IS NULL
                AND (k.scope = 'org' OR (k.scope = 'module' AND k.target = ${position.module}) OR (k.scope = 'agent' AND k.target = ${agent.id}))) AS killed,
        EXISTS (SELECT 1 FROM crove_kernel.budget_policy b
                WHERE b.org_id = ${ctx.orgId}::uuid AND b.hard_stop
                  AND (b.scope = 'org' OR (b.scope = 'module' AND b.target = ${position.module}) OR (b.scope = 'agent' AND b.target = ${agent.id}))
                  AND (SELECT coalesce(sum(r.cost), 0) FROM crove_kernel.ai_run r
                       WHERE r.org_id = b.org_id
                         AND r.started_at >= date_trunc('month', now() AT TIME ZONE 'Asia/Ho_Chi_Minh') AT TIME ZONE 'Asia/Ho_Chi_Minh'
                         AND (b.scope = 'org' OR (b.scope = 'module' AND r.module = b.target) OR (b.scope = 'agent' AND r.agent_id::text = b.target)))
                      >= b.monthly_limit) AS spent,
        (SELECT count(*)::int FROM crove_kernel.ai_run r WHERE r.org_id = ${ctx.orgId}::uuid AND r.agent_id = ${agent.id}::uuid
           AND r.started_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Ho_Chi_Minh') AT TIME ZONE 'Asia/Ho_Chi_Minh') AS today`.execute(ctx.trx);
    const gate = gates[0];
    if (gate?.killed) return done('kill_switch');
    if (gate?.spent) return done('budget');
    if ((gate?.today ?? 0) >= agent.daily_run_cap) return done('daily_cap');

    // Close runs that outlived their expiry (a crashed worker): release their leases, finish their wake-ups.
    const stale = await ctx.trx
      .selectFrom('crove_kernel.ai_run')
      .select('id')
      .where('org_id', '=', ctx.orgId)
      .where('agent_id', '=', agent.id)
      .where('status', '=', 'running')
      .where('expires_at', '<=', sql<Date>`now()`)
      .execute();
    if (stale.length > 0) {
      const ids = stale.map((r) => r.id);
      await ctx.trx.updateTable('crove_kernel.task').set({ checkout_run_id: null, lock_expires_at: null }).where('org_id', '=', ctx.orgId).where('checkout_run_id', 'in', ids).execute();
      await ctx.trx.updateTable('crove_kernel.ai_run').set({ status: 'expired', finished_at: ctx.now }).where('org_id', '=', ctx.orgId).where('id', 'in', ids).execute();
      await ctx.trx.updateTable('crove_kernel.agent_wakeup').set({ status: 'done', updated_at: ctx.now }).where('org_id', '=', ctx.orgId).where('run_id', 'in', ids).where('status', '=', 'claimed').execute();
    }
    const live = await ctx.trx
      .selectFrom('crove_kernel.ai_run')
      .select('id')
      .where('org_id', '=', ctx.orgId)
      .where('agent_id', '=', agent.id)
      .where('status', '=', 'running')
      .executeTakeFirst();
    if (live) return done('busy');
    const pending = await ctx.trx
      .selectFrom('crove_kernel.agent_wakeup')
      .select(['id', 'tainted', 'request_depth'])
      .where('org_id', '=', ctx.orgId)
      .where('agent_id', '=', agent.id)
      .where('status', '=', 'pending')
      .forUpdate()
      .execute();
    if (pending.length === 0) return done('idle');
    const tainted = pending.some((w) => w.tainted);
    const depth = Math.max(...pending.map((w) => w.request_depth));
    const run = await ctx.trx
      .insertInto('crove_kernel.ai_run')
      .values({
        org_id: ctx.orgId,
        agent_id: agent.id,
        module: position.module,
        tainted,
        request_depth: depth,
        expires_at: sql<Date>`now() + make_interval(mins => ${RUN_MINUTES})`,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await ctx.trx
      .updateTable('crove_kernel.agent_wakeup')
      .set({ status: 'claimed', run_id: run.id, updated_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('id', 'in', pending.map((w) => w.id))
      .execute();
    ctx.audit({ agent: agent.id, started: true, run: run.id, tainted, wakeups: pending.length });
    return { runId: run.id, templateKey: agent.template_key, tainted };
  },
});

// Ends a run: its leases are released and its wake-ups done; a wake-up that arrived meanwhile wakes the agent again.
export const finishAgentRun = defineCommand({
  name: 'kernel.agent.run.finish',
  input: z.object({ runId: zId, outcome: z.enum(['succeeded', 'failed']), error: z.string().max(1000).nullable().optional() }),
  risk: 'R1',
  access: 'system',
  target: (input) => ({ type: 'kernel.ai_run', id: input.runId }),
  handler: async (ctx, input) => {
    const run = await ctx.trx
      .updateTable('crove_kernel.ai_run')
      .set({ status: input.outcome, finished_at: ctx.now, error: input.error ?? null })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.runId)
      .where('status', '=', 'running')
      .returning('agent_id')
      .executeTakeFirst();
    await ctx.trx.updateTable('crove_kernel.task').set({ checkout_run_id: null, lock_expires_at: null }).where('org_id', '=', ctx.orgId).where('checkout_run_id', '=', input.runId).execute();
    await ctx.trx.updateTable('crove_kernel.agent_wakeup').set({ status: 'done', updated_at: ctx.now }).where('org_id', '=', ctx.orgId).where('run_id', '=', input.runId).where('status', '=', 'claimed').execute();
    if (!run) return { finished: false };
    const pending = await ctx.trx
      .selectFrom('crove_kernel.agent_wakeup')
      .select('id')
      .where('org_id', '=', ctx.orgId)
      .where('agent_id', '=', run.agent_id)
      .where('status', '=', 'pending')
      .executeTakeFirst();
    if (pending) await ctx.emit('kernel.agent.wakeup_requested', { agentId: run.agent_id });
    ctx.audit({ run: input.runId, outcome: input.outcome });
    return { finished: true };
  },
});

const AGENT_SYSTEM = { type: 'system', component: 'kernel.agent' } as const;

// One wake-up job (the worker's agent queue): start a run, run the template's program as the agent, finish the run.
// The program acts only through the runtime as the agent, so every write meets the agent rules above.
export async function runAgentWake(
  deps: { runtime: Runtime; programs: Readonly<Record<string, AgentProgram>> },
  orgId: string,
  agentId: string,
): Promise<RunStartResult & { outcome?: 'succeeded' | 'failed' }> {
  const started = await deps.runtime.execute<RunStartResult>('kernel.agent.run.start', { agentId }, { actor: AGENT_SYSTEM, orgId });
  if (started.runId === null) return started;
  const actor: AgentActor = { type: 'agent', agentId, runId: started.runId };
  let outcome: 'succeeded' | 'failed' = 'succeeded';
  let error: string | null = null;
  try {
    const program = Object.hasOwn(deps.programs, started.templateKey) ? deps.programs[started.templateKey] : undefined;
    if (!program) throw new DomainError('AGENT_PROGRAM_MISSING', 500, `No program for ${started.templateKey}`);
    // The program gets only a facade bound to this run's agent actor, never the Runtime.
    await program(agentRuntime(deps.runtime, orgId, actor));
  } catch (e) {
    outcome = 'failed';
    // Codes only: messages can quote tainted content.
    error = e instanceof DomainError ? e.code : 'INTERNAL';
  }
  await deps.runtime.execute('kernel.agent.run.finish', { runId: started.runId, outcome, error }, { actor: AGENT_SYSTEM, orgId });
  return { ...started, outcome };
}

// ---------------------------------------------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------------------------------------------

// The chart: positions with their holders, the agents, and the kill switches that are on. Positions without
// reports_to report to the owners, who are the root.
export const chartGet = defineQuery({
  name: 'kernel.chart.get',
  input: z.object({}),
  access: ALL,
  handler: async (ctx) => {
    const positions = await ctx.trx
      .selectFrom('crove_kernel.position as p')
      .leftJoin('crove_kernel.agent as a', (j) => j.onRef('a.org_id', '=', 'p.org_id').onRef('a.id', '=', 'p.holder_agent_id'))
      .select([
        'p.id',
        'p.title',
        'p.module',
        'p.role_key',
        'p.reports_to',
        'p.status',
        'p.job_description',
        'p.holder_user_id',
        'p.holder_agent_id',
        'a.display_name as agent_name',
        'a.status as agent_status',
      ])
      .where('p.org_id', '=', ctx.orgId)
      .orderBy('p.created_at')
      .execute();
    const agents = await ctx.trx
      .selectFrom('crove_kernel.agent')
      .select(['id', 'template_key', 'display_name', 'status', 'max_risk', 'daily_run_cap'])
      .where('org_id', '=', ctx.orgId)
      .orderBy('created_at')
      .execute();
    const owners = await ctx.trx
      .selectFrom('crove_kernel.tenant_member')
      .select('user_id')
      .where('org_id', '=', ctx.orgId)
      .where('role', '=', 'owner')
      .orderBy('created_at')
      .execute();
    // Names and emails of members come from the control plane through the definer (plan §3.6).
    const profiles = await memberProfiles(ctx.trx, [...owners.map((o) => o.user_id), ...positions.flatMap((p) => (p.holder_user_id ? [p.holder_user_id] : []))]);
    const killSwitches = await ctx.trx
      .selectFrom('crove_kernel.kill_switch')
      .select(['id', 'scope', 'target', 'reason', 'engaged_at'])
      .where('org_id', '=', ctx.orgId)
      .where('released_at', 'is', null)
      .execute();
    return {
      root: owners.map((o) => ({ userId: o.user_id, email: profiles.get(o.user_id)?.email ?? null, displayName: profiles.get(o.user_id)?.displayName ?? null })),
      positions: positions.map((p) => ({
        id: p.id,
        title: p.title,
        module: p.module,
        roleKey: p.role_key,
        reportsTo: p.reports_to,
        status: p.status,
        jobDescription: p.job_description,
        holder: p.holder_agent_id
          ? { type: 'agent' as const, agentId: p.holder_agent_id, name: p.agent_name, status: p.agent_status, ai: true }
          : p.holder_user_id
            ? { type: 'user' as const, userId: p.holder_user_id, email: profiles.get(p.holder_user_id)?.email ?? null, displayName: profiles.get(p.holder_user_id)?.displayName ?? null, ai: false }
            : null,
      })),
      agents: agents.map((a) => ({ id: a.id, templateKey: a.template_key, displayName: a.display_name, status: a.status, maxRisk: a.max_risk, dailyRunCap: a.daily_run_cap })),
      killSwitches: killSwitches.map((k) => ({ id: k.id, scope: k.scope, target: k.target, reason: k.reason, engagedAt: k.engaged_at.toISOString() })),
    };
  },
});

const zTaskStatus = z.enum(['todo', 'in_progress', 'waiting', 'in_review', 'done', 'cancelled']);

function taskView(t: {
  id: string;
  title: string;
  kind: string;
  status: string;
  assignee_position_id: string | null;
  parent_task_id: string | null;
  source: string;
  source_ref: unknown;
  request_depth: number;
  tainted: boolean;
  created_by_type: string;
  due: Date | null;
  created_at: Date;
}) {
  return {
    id: t.id,
    title: t.title,
    kind: t.kind,
    status: t.status,
    assigneePositionId: t.assignee_position_id,
    parentTaskId: t.parent_task_id,
    source: t.source,
    sourceRef: t.source_ref,
    requestDepth: t.request_depth,
    tainted: t.tainted,
    createdByType: t.created_by_type,
    due: t.due?.toISOString() ?? null,
    createdAt: t.created_at.toISOString(),
  };
}

// At most this many tasks per list: the oldest first for an agent (its work queue), the newest first for a person.
export const TASK_LIST_LIMIT = 200;

// Tasks of the org; an agent sees only its own position's tasks, and an untainted run only untainted ones (tainted
// content never reaches a run that would write it untainted; a tainted task wakes the agent with a tainted run). mine:
// the positions the user holds, plus the root tasks for an owner.
export const taskList = defineQuery({
  name: 'kernel.task.list',
  input: z.object({ positionId: zId.optional(), mine: z.boolean().optional(), status: z.array(zTaskStatus).max(6).optional() }),
  access: ALL,
  agent: { roles: 'any' },
  handler: async (ctx, input) => {
    const order = ctx.agent ? 'asc' : 'desc';
    let query = ctx.trx
      .selectFrom('crove_kernel.task')
      .selectAll()
      .where('org_id', '=', ctx.orgId)
      .orderBy('created_at', order)
      .orderBy('id', order)
      .limit(TASK_LIST_LIMIT);
    if (ctx.agent) {
      query = query.where('assignee_position_id', '=', ctx.agent.positionId);
      if (!ctx.agent.tainted) query = query.where('tainted', '=', false);
    } else if (input.positionId) {
      query = query.where('assignee_position_id', '=', input.positionId);
    } else if (input.mine && ctx.actor.type === 'user') {
      const userId = ctx.actor.userId;
      const isOwner = ctx.role === 'owner';
      query = query.where((eb) =>
        eb.or([
          eb(
            'assignee_position_id',
            'in',
            eb.selectFrom('crove_kernel.position').select('id').where('org_id', '=', ctx.orgId).where('holder_user_id', '=', userId),
          ),
          ...(isOwner ? [eb('assignee_position_id', 'is', null)] : []),
        ]),
      );
    }
    if (input.status && input.status.length > 0) query = query.where('status', 'in', input.status);
    return { tasks: (await query.execute()).map(taskView) };
  },
});

// One task with its comments and, for a proposal review, what the proposal's deterministic checks found. Agents read
// as in kernel.task.list: their own position's tasks, and untainted runs untainted tasks only.
export const taskGet = defineQuery({
  name: 'kernel.task.get',
  input: z.object({ id: zId }),
  access: ALL,
  agent: { roles: 'any' },
  handler: async (ctx, input) => {
    let query = ctx.trx.selectFrom('crove_kernel.task').selectAll().where('org_id', '=', ctx.orgId).where('id', '=', input.id);
    if (ctx.agent) {
      query = query.where('assignee_position_id', '=', ctx.agent.positionId);
      if (!ctx.agent.tainted) query = query.where('tainted', '=', false);
    }
    const task = await query.executeTakeFirst();
    if (!task) throw new DomainError('TASK_NOT_FOUND', 404, 'Không tìm thấy việc này');
    const comments = await ctx.trx
      .selectFrom('crove_kernel.task_comment')
      .select(['id', 'body', 'author_type', 'author_id', 'tainted', 'created_at'])
      .where('org_id', '=', ctx.orgId)
      .where('task_id', '=', task.id)
      .orderBy('created_at')
      .limit(200)
      .execute();
    // checks: null when the payload carries no readable checks (never an empty list, which would read as "all clear").
    let proposal: { id: string; title: string; status: string; checks: Array<{ id: string; status: string; message: string }> | null } | null = null;
    const ref = zProposalRef.safeParse(task.source_ref);
    if (ref.success) {
      const row = await ctx.trx
        .selectFrom('crove_kernel.proposal')
        .select(['id', 'title', 'status', 'payload'])
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', ref.data.id)
        .executeTakeFirst();
      if (row) {
        const payload = zChecksPayload.safeParse(row.payload);
        proposal = { id: row.id, title: row.title, status: row.status, checks: payload.success ? payload.data.checks : null };
      }
    }
    return {
      task: { ...taskView(task), description: task.description, fence: task.fence, checkedOut: task.checkout_run_id !== null },
      comments: comments.map((c) => ({ id: c.id, body: c.body, authorType: c.author_type, authorId: c.author_id, tainted: c.tainted, createdAt: c.created_at.toISOString() })),
      proposal,
    };
  },
});

// The agent templates modules declare, and whether this deployment enables each one's module (CROVE_MODULES,
// ADR-0031): installing a template of a module that is off is refused with MODULE_DISABLED.
export const templateList = defineQuery({
  name: 'kernel.agent.templates.list',
  input: z.object({}),
  access: ALL,
  handler: async (ctx) => {
    const rows = await ctx.trx
      .selectFrom('crove_kernel.agent_template')
      .select(['key', 'module', 'title', 'role_key', 'max_risk', 'daily_run_cap', 'job_description'])
      .orderBy('key')
      .execute();
    return {
      templates: rows.map((t) => ({
        key: t.key,
        module: t.module,
        title: t.title,
        roleKey: t.role_key,
        maxRisk: t.max_risk,
        dailyRunCap: t.daily_run_cap,
        jobDescription: t.job_description,
        moduleEnabled: ctx.installed(t.module),
      })),
    };
  },
});

// The monthly AI budgets with what this month's runs they cover cost so far (the month in Asia/Ho_Chi_Minh, as the
// run gate counts it). Amounts are decimal strings. Owners and admins: costs are management data.
export const budgetList = defineQuery({
  name: 'kernel.agent.budgets.list',
  input: z.object({}),
  access: ['owner', 'admin'],
  handler: async (ctx) => {
    const { rows } = await sql<{
      id: string;
      scope: AgentScope;
      target: string;
      monthly_limit: string;
      warn_percent: number;
      hard_stop: boolean;
      updated_at: Date;
      spent: string;
    }>`
      SELECT b.id, b.scope, b.target, b.monthly_limit::text AS monthly_limit, b.warn_percent, b.hard_stop, b.updated_at,
        (SELECT coalesce(sum(r.cost), 0)::text FROM crove_kernel.ai_run r
         WHERE r.org_id = b.org_id
           AND r.started_at >= pg_catalog.date_trunc('month', pg_catalog.now() AT TIME ZONE 'Asia/Ho_Chi_Minh') AT TIME ZONE 'Asia/Ho_Chi_Minh'
           AND (b.scope = 'org' OR (b.scope = 'module' AND r.module = b.target) OR (b.scope = 'agent' AND r.agent_id::text = b.target))) AS spent
      FROM crove_kernel.budget_policy b
      WHERE b.org_id = ${ctx.orgId}::uuid
      ORDER BY b.scope, b.target`.execute(ctx.trx);
    return {
      budgets: rows.map((b) => ({
        id: b.id,
        scope: b.scope,
        target: b.target,
        monthlyLimit: b.monthly_limit,
        warnPercent: b.warn_percent,
        hardStop: b.hard_stop,
        spent: b.spent,
        updatedAt: b.updated_at.toISOString(),
      })),
    };
  },
});

export const agentCommands = [
  createPosition,
  updatePosition,
  assignPosition,
  installAgentTemplate,
  updateAgent,
  setAgentBudget,
  engageKillSwitch,
  releaseKillSwitch,
  createTask,
  checkoutTask,
  commentTask,
  setTaskStatus,
  escalateTask,
  delegateTask,
  dispatchAgentEvent,
  startAgentRun,
  finishAgentRun,
];

export const agentQueries = [chartGet, taskList, taskGet, templateList, budgetList];
