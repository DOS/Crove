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
import { tableWrite, zCheck, zId, type Check } from '@crove/kernel-contract';
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
import { decideAgentApproval, eligibleApprovers, type ActorRef } from './approval.ts';
import { refuseWhileReextracting } from './extraction.ts';
import { kernelManifest } from './manifest.ts';
import { preparedEntity } from './proposal-resubmit.ts';
import { memberProfiles } from './profiles.ts';
import { lockChartChanges, rerouteStrandedTasks } from './task-reroute.ts';

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

// What the task commands agents run write (CommandDef.writes, #1697): kernel collaboration data, never a contact or
// payment column, so the runtime lets agents run them (P04).
const TASK_TABLES = kernelManifest.tables;
const LEASE_COLUMNS = ['status', 'checkout_run_id', 'lock_expires_at'] as const;
const CHILD_TASK_COLUMNS = ['org_id', 'title', 'description', 'kind', 'assignee_position_id', 'parent_task_id', 'source', 'source_ref', 'created_by_type'] as const;
// requestWakeup's upsert.
const WAKEUP_WRITE = tableWrite(TASK_TABLES, 'crove_kernel', 'agent_wakeup', ['org_id', 'agent_id', 'reasons', 'request_count', 'tainted', 'request_depth', 'updated_at']);
// What the taint triggers write (task_before_update, task_comment_before_insert): a write to a task marks the run that
// claims it tainted, and a comment marks its task tainted (T18, taint both ways). The runtime checks a command's
// writes per table against its declaration (#1710), so a command that writes a task or a comment declares these too.
const RUN_TAINT_WRITE = tableWrite(TASK_TABLES, 'crove_kernel', 'ai_run', ['tainted']);
const TASK_TAINT_WRITE = tableWrite(TASK_TABLES, 'crove_kernel', 'task', ['tainted']);

const zModule = z.string().regex(/^[a-z][a-z0-9_]*$/).max(50);
const zRoleKey = z.string().regex(/^[a-z][a-z0-9_.]*$/).max(100);
const zJobDescription = z.record(z.string(), z.unknown());
const zAgentRisk = z.enum(['R0', 'R1', 'R2']);
const zScope = z.enum(['org', 'module', 'agent']);
// A non-negative amount with up to 6 decimals, as a decimal string (never a JS number for money).
const zAmount = z.string().regex(/^\d{1,12}(\.\d{1,6})?$/);
const zFence = z.union([z.string().regex(/^\d{1,18}$/), z.number().int().nonnegative()]).transform((v) => String(v));
// The legal entities a position's agent works in (#1538): every entity ('*' alone) or some of the org's, by id. A new
// position whose owner names none gets the org's default entity (the database trigger position_le_scope).
const zLeScope = z.union([z.tuple([z.literal('*')]), z.array(zId).min(1).max(50)]);

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

// A scope the owner names: '*' alone, or entities of the org, each once (the database checks it again,
// POSITION_SCOPE_INVALID). Ids in the text form le_scope compares.
async function checkLeScope(trx: Trx, orgId: string, scope: readonly string[]): Promise<string[]> {
  if (scope.length === 1 && scope[0] === '*') return ['*'];
  const ids = [...new Set(scope.map((id) => id.toLowerCase()))];
  const found = await trx.selectFrom('crove_kernel.legal_entity').select('id').where('org_id', '=', orgId).where('id', 'in', ids).execute();
  if (ids.length !== scope.length || found.length !== ids.length) {
    throw new DomainError('POSITION_SCOPE_INVALID', 422, 'Phạm vi pháp nhân của vị trí phải là mọi pháp nhân hoặc các pháp nhân của tổ chức này');
  }
  return ids;
}

// Whether a position's scope covers a legal entity.
export function scopeCovers(scope: readonly string[], entityId: string): boolean {
  return scope.includes('*') || scope.includes(entityId.toLowerCase());
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
    leScope: zLeScope.optional(),
  }),
  risk: 'R3',
  sideEffect: 'internal',
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
        ...(input.leScope ? { le_scope: await checkLeScope(ctx.trx, ctx.orgId, input.leScope) } : {}),
      })
      .returning(['id', 'le_scope'])
      .executeTakeFirstOrThrow();
    ctx.audit({ position: position.id, role_key: input.roleKey, reports_to: input.reportsTo ?? null, le_scope: position.le_scope });
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
    leScope: zLeScope.optional(),
  }),
  risk: 'R3',
  sideEffect: 'internal',
  access: OWNER,
  target: (input) => ({ type: 'kernel.position', id: input.id }),
  handler: async (ctx, input) => {
    requireUser(ctx);
    // Before the seat's lock: a change of le_scope re-routes (#1858).
    await lockChartChanges(ctx);
    const before = await lockPosition(ctx.trx, ctx.orgId, input.id);
    const set: Record<string, unknown> = {};
    if (input.title !== undefined) set.title = input.title;
    if (input.roleKey !== undefined) set.role_key = input.roleKey;
    if (input.reportsTo !== undefined) set.reports_to = input.reportsTo;
    if (input.jobDescription !== undefined) set.job_description = JSON.stringify(input.jobDescription);
    if (input.status !== undefined) set.status = input.status;
    // enter_agent_context reads the scope on every entry, so the agent's next command already works in the new one.
    if (input.leScope !== undefined) set.le_scope = await checkLeScope(ctx.trx, ctx.orgId, input.leScope);
    ctx.audit({
      position: input.id,
      previous: { title: before.title, role_key: before.role_key, reports_to: before.reports_to, status: before.status, le_scope: before.le_scope },
      changed: Object.keys(set),
    });
    if (Object.keys(set).length === 0) return { positionId: input.id };
    await ctx.trx.updateTable('crove_kernel.position').set(set).where('org_id', '=', ctx.orgId).where('id', '=', input.id).execute();
    // A narrower seat scope leaves the agent unable to read some of its open tasks: they go up the chart (#1799).
    if (input.leScope !== undefined) await rerouteStrandedTasks(ctx, [input.id]);
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
  sideEffect: 'internal',
  access: OWNER,
  target: (input) => ({ type: 'kernel.position', id: input.id }),
  handler: async (ctx, input) => {
    requireUser(ctx);
    // Before the seat's lock: the new holder's tasks re-route (#1858).
    await lockChartChanges(ctx);
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
    // The open tasks the new holder (or the vacant seat's scope) cannot read go up the chart first (#1799).
    await rerouteStrandedTasks(ctx, [position.id]);
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
  input: z.object({
    templateKey: z.string().min(1).max(100),
    reportsTo: zId.nullable().optional(),
    displayName: z.string().trim().min(1).max(200).optional(),
    leScope: zLeScope.optional(),
  }),
  risk: 'R3',
  sideEffect: 'internal',
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
        ...(input.leScope ? { le_scope: await checkLeScope(ctx.trx, ctx.orgId, input.leScope) } : {}),
      })
      .returning(['id', 'le_scope'])
      .executeTakeFirstOrThrow();
    ctx.audit({ template: template.key, agent: agent.id, position: position.id, max_risk: template.max_risk, le_scope: position.le_scope });
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
  sideEffect: 'internal',
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
  sideEffect: 'internal',
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
  sideEffect: 'internal',
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
  sideEffect: 'internal',
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
  sideEffect: 'internal',
  access: MEMBERS,
  handler: async (ctx, input) => {
    requireUser(ctx);
    return insertHumanTask(ctx, { ...input, description: input.description ?? null, due: input.due ?? null, sourceRef: null, tainted: false });
  },
});

// A task a person gives, from kernel.task.create or from a module's helper below. source_ref is never the caller's
// input: kernel.task.get attaches the proposal a `kernel.proposal` reference names, so only kernel code chooses it.
async function insertHumanTask(
  ctx: CommandContext,
  input: { title: string; description: string | null; assigneePositionId: string | null; due: string | null; sourceRef: { type: string; id: string } | null; tainted: boolean },
): Promise<{ taskId: string }> {
  if (input.assigneePositionId) {
    const position = await lockPosition(ctx.trx, ctx.orgId, input.assigneePositionId);
    if (position.status === 'archived') throw new DomainError('POSITION_ARCHIVED', 409, 'Vị trí này đã ngừng sử dụng');
  }
  const task = await ctx.trx
    .insertInto('crove_kernel.task')
    .values({
      org_id: ctx.orgId,
      title: input.title,
      description: input.description,
      assignee_position_id: input.assigneePositionId,
      source: 'human',
      source_ref: input.sourceRef === null ? null : JSON.stringify(input.sourceRef),
      created_by_type: 'user',
      due: input.due,
      tainted: input.tainted,
    })
    .returning(['id', 'tainted', 'request_depth'])
    .executeTakeFirstOrThrow();
  await requestWakeup(ctx, input.assigneePositionId, { taskId: task.id, why: 'assigned' }, task.tainted, task.request_depth);
  await ctx.emit('kernel.task.created', { taskId: task.id });
  return { taskId: task.id };
}

// A member's own to-do handed over to a position (notes plan docs/plan/notes.md §3.1 and step N5, #1674): the notes
// module runs this inside its notes.todo.hand_over command (ctx.run), so the task and the to-do's change commit
// together, and the task's events and wake-up are the kernel's own. The task takes the text the member confirmed, the
// rules of kernel.task.create (an archived position is refused with POSITION_ARCHIVED) and a `notes.todo` source_ref
// this command sets itself from the to-do's id; the to-do's taint carries over. No RPC route reaches it: the notes
// command reads and locks the to-do under its owner-only row policies first. Called directly it could only name a
// `notes.todo` the kernel attaches nothing to, never a `kernel.proposal`.
export const createTaskFromTodo = defineCommand({
  name: 'kernel.task.create_from_todo',
  input: z.strictObject({
    todoId: zId,
    title: zTaskTitle,
    description: z.string().max(10000).nullable(),
    positionId: zId,
    due: z.iso.datetime().nullable(),
    tainted: z.boolean(),
  }),
  risk: 'R1',
  sideEffect: 'internal',
  access: MEMBERS,
  handler: async (ctx, input) => {
    requireUser(ctx);
    const created = await insertHumanTask(ctx, {
      title: input.title,
      description: input.description,
      assigneePositionId: input.positionId,
      due: input.due,
      sourceRef: { type: 'notes.todo', id: input.todoId },
      tainted: input.tainted,
    });
    ctx.audit({ taskId: created.taskId, todoId: input.todoId, positionId: input.positionId });
    return created;
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
  sideEffect: 'internal',
  access: [],
  agent: { roles: 'any', taint: 'propagate' },
  writes: [tableWrite(TASK_TABLES, 'crove_kernel', 'task', [...LEASE_COLUMNS, 'fence']), RUN_TAINT_WRITE],
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
  sideEffect: 'internal',
  access: MEMBERS,
  agent: { roles: 'any', taint: 'propagate' },
  writes: [tableWrite(TASK_TABLES, 'crove_kernel', 'task_comment', ['org_id', 'task_id', 'body', 'author_type']), TASK_TAINT_WRITE, RUN_TAINT_WRITE],
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
  sideEffect: 'internal',
  access: MEMBERS,
  agent: { roles: 'any', taint: 'propagate' },
  writes: [tableWrite(TASK_TABLES, 'crove_kernel', 'task', LEASE_COLUMNS), WAKEUP_WRITE, RUN_TAINT_WRITE],
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

// Whether whoever holds a position reads a legal entity (#1788), so a task of that entity handed to the position can be
// listed and checked out (the RESTRICTIVE le_scope policy on task, #1762). An org-level task (null) is read by everyone.
// The rule is the database's (crove_kernel.position_reads_legal_entity, which the task trigger applies too): a person
// reads what enter_context seals for them, which an agent limited to some entities cannot work out from the role
// assignments it sees; an agent, and a vacant position, read the position's le_scope.
async function holderCovers(trx: Trx, orgId: string, positionId: string, entityId: string | null): Promise<boolean> {
  if (entityId === null) return true;
  const { rows } = await sql<{ covers: boolean }>`
    SELECT crove_kernel.position_reads_legal_entity(${orgId}::uuid, ${positionId}::uuid, ${entityId}::uuid) AS covers`.execute(trx);
  return rows[0]?.covers === true;
}

// Where an escalation goes: the nearest active position up the chart held by a human who reads the task's legal entity
// (#1788), otherwise the owner (null), who reads every entity. The database's own target, which the task trigger
// requires. Phase 1 escalates to humans only: an agent-held supervisor would get work no template program handles
// (ADR-0029, Phase 1 as built).
async function escalationTarget(trx: Trx, orgId: string, positionId: string, entityId: string | null): Promise<string | null> {
  const { rows } = await sql<{ id: string | null }>`
    SELECT crove_kernel.task_escalation_target(${orgId}::uuid, ${positionId}::uuid, ${entityId}::uuid) AS id`.execute(trx);
  return rows[0]?.id ?? null;
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
  sideEffect: 'internal',
  access: [],
  agent: { roles: 'any', taint: 'propagate' },
  // The child task and the parent's release.
  writes: [tableWrite(TASK_TABLES, 'crove_kernel', 'task', [...CHILD_TASK_COLUMNS, ...LEASE_COLUMNS]), WAKEUP_WRITE, RUN_TAINT_WRITE],
  target: (input) => ({ type: 'kernel.task', id: input.id }),
  handler: async (ctx, input) => {
    const agent = requireAgent(ctx);
    const parent = await requireLease(ctx, input.id, input.fence);
    if (parent.request_depth >= MAX_REQUEST_DEPTH) throw depthLimit();
    const target = await escalationTarget(ctx.trx, ctx.orgId, agent.positionId, parent.legal_entity_id);
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
  sideEffect: 'internal',
  access: [],
  agent: { roles: 'any', taint: 'propagate' },
  writes: [tableWrite(TASK_TABLES, 'crove_kernel', 'task', CHILD_TASK_COLUMNS), WAKEUP_WRITE, RUN_TAINT_WRITE],
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
    // The child takes the parent's legal entity (#1762): a holder who cannot read it would never see the task (#1788).
    // The task trigger refuses it too (AGENT_DELEGATION_SUBTREE); this says why.
    if (!(await holderCovers(ctx.trx, ctx.orgId, input.assigneePositionId, parent.legal_entity_id))) {
      throw new DomainError('OUTSIDE_LEGAL_ENTITY', 422, 'Vị trí nhận việc không được xem pháp nhân của việc này', { rule: 'delegation_legal_entity' });
    }
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
// of a module this deployment does not enable get no task. kernel.proposal.created makes a proposal_review task; any
// other subscribed event (a module's, such as social.post.submitted, #799) makes a general task from the agent_task
// its emitting command wrote into the payload: a title, what it is about and whether it is tainted (taint is the
// default when the event does not say).
const zAgentTask = z.object({
  agent_task: z.object({ title: z.string().trim().min(1).max(300), ref: z.object({ type: z.string().regex(/^[a-z][a-z0-9_.]{1,99}$/), id: zId }), tainted: z.boolean().optional() }),
});
export const dispatchAgentEvent = defineCommand({
  name: 'kernel.agent.dispatch_event',
  input: z.object({ eventId: zId }),
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  handler: async (ctx, input) => {
    const event = await ctx.trx
      .selectFrom('crove_kernel.outbox_event')
      .select(['id', 'type', 'payload'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.eventId)
      .executeTakeFirst();
    if (!event) return { tasks: 0 };
    if (event.type !== 'kernel.proposal.created') return dispatchModuleEvent(ctx, event);
    const proposalId = z.object({ proposalId: zId }).safeParse(event.payload);
    if (!proposalId.success) return { tasks: 0 };
    const proposal = await ctx.trx
      .selectFrom('crove_kernel.proposal as p')
      .leftJoin('crove_kernel.extraction as e', (j) => j.onRef('e.org_id', '=', 'p.org_id').onRef('e.id', '=', 'p.extraction_id'))
      .select(['p.id', 'p.title', 'p.status', 'p.extraction_id', 'p.requested_by_agent', 'p.tainted as proposal_tainted', 'p.legal_entity_id', 'e.tainted'])
      .where('p.org_id', '=', ctx.orgId)
      .where('p.id', '=', proposalId.data.proposalId)
      .executeTakeFirst();
    if (!proposal || proposal.status !== 'pending') return { tasks: 0 };
    // Content read from a file is tainted; a missing extraction row is treated as tainted too.
    const tainted = proposal.proposal_tainted || (proposal.extraction_id !== null ? proposal.tainted !== false : false);
    const seats = await ctx.trx
      .selectFrom('crove_kernel.agent as a')
      .innerJoin('crove_kernel.agent_template as t', 't.key', 'a.template_key')
      .innerJoin('crove_kernel.position as p', (j) => j.onRef('p.org_id', '=', 'a.org_id').onRef('p.holder_agent_id', '=', 'a.id'))
      .select(['p.id as position_id', 't.module', 'a.id as agent_id', 'p.le_scope'])
      .where('a.org_id', '=', ctx.orgId)
      .where('a.status', '=', 'active')
      .where('p.status', '=', 'active')
      .where(sql<boolean>`t.subscribes @> ARRAY[${event.type}]::text[]`)
      .execute();
    let created = 0;
    // The agent that asked for the proposal never reviews it (its own causal chain, ADR-0029 section 6), and an agent
    // whose position's scope leaves out the proposal's legal entity gets no task (#1538): it could not read the
    // proposal, and the task's title would name it.
    for (const seat of seats.filter(
      (s) => ctx.installed(s.module) && s.agent_id !== proposal.requested_by_agent && scopeCovers(s.le_scope, proposal.legal_entity_id),
    )) {
      const task = await ctx.trx
        .insertInto('crove_kernel.task')
        .values({
          org_id: ctx.orgId,
          // Not the proposal's title, which names its content (#1538): the task opens the proposal, which le_scope
          // guards. The task takes the proposal's legal entity from its source_ref (trigger task_legal_entity, #1762).
          title: 'Rà soát đề xuất chờ duyệt',
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

async function dispatchModuleEvent(ctx: CommandContext, event: { id: string; type: string; payload: unknown }): Promise<{ tasks: number }> {
  const parsed = zAgentTask.safeParse(event.payload);
  if (!parsed.success) return { tasks: 0 };
  const { title, ref } = parsed.data.agent_task;
  const tainted = parsed.data.agent_task.tainted ?? true;
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
  // Only the agents of the module the event is about: a template cannot be fed another module's records.
  // The event, too, must be the template's own module's: a template subscribed to another module's event gets nothing.
  for (const seat of seats.filter((s) => ctx.installed(s.module) && ref.type.startsWith(`${s.module}.`) && event.type.startsWith(`${s.module}.`))) {
    const task = await ctx.trx
      .insertInto('crove_kernel.task')
      .values({
        org_id: ctx.orgId,
        title,
        kind: 'general',
        assignee_position_id: seat.position_id,
        source: 'event',
        source_ref: JSON.stringify(ref),
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
}

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
  sideEffect: 'internal',
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
                AND (k.scope = 'org' OR (k.scope = 'module' AND k.target = ${position.module}) OR (k.scope = 'agent' AND k.target = ${agent.id})))
          OR crove_kernel.global_kill_switch_on('ai') AS killed,
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
  sideEffect: 'internal',
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
        'p.le_scope',
        'a.display_name as agent_name',
        'a.status as agent_status',
      ])
      .where('p.org_id', '=', ctx.orgId)
      .orderBy('p.created_at')
      .execute();
    // A position's legal entities name only those the reader may see (the legal entities' scope policy keeps the
    // others out of this read), so a member limited to some entities learns no other entity's id (#1763).
    const visible = new Set(
      (await ctx.trx.selectFrom('crove_kernel.legal_entity').select('id').where('org_id', '=', ctx.orgId).execute()).map((e) => e.id),
    );
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
        leScope: p.le_scope.includes('*') ? ['*'] : p.le_scope.filter((id) => visible.has(id)),
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
    let proposal: { id: string; title: string; status: string; checks: Check[] | null } | null = null;
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

// ---------------------------------------------------------------------------------------------------------------
// Agent proposals and approvals (ADR-0029 section 6, issue #260)
// ---------------------------------------------------------------------------------------------------------------
// An agent never writes a proposal: its command, under the lease of the task it works on, records the request (or its
// approval) as an outbox event, and a system command in the worker acts on it after checking everything again from
// the database. The event carries ids and what the agent's run prepared, never a decision.

// What a preparer builds. Only the command and the payload travel: the proposal's kind comes from the command and its
// title from the kernel (#435), so nothing the agent's run supplies is rendered as the proposal's label. A preparer
// may still return a kind and a title (the human path uses them); they are dropped here.
// legalEntityId: the entity the preparer named (preparedEntity), carried to the worker that creates the proposal.
const zPrepared = z.object({ command: z.string().min(1).max(200), payload: z.record(z.string(), z.unknown()), legalEntityId: zId.optional() });
const zProposalRequested = z.object({ agentId: zId, runId: zId, taskId: zId, preparer: z.string().min(1).max(200), draft: zPrepared });
const zProposalApproved = z.object({ agentId: zId, runId: zId, taskId: zId, proposalId: zId, revision: z.number().int().positive() });

// The largest draft payload an agent's request carries (UTF-8 bytes of its JSON), checked when it is recorded and
// again when the proposal is created.
export const MAX_DRAFT_PAYLOAD_BYTES = 64 * 1024;

function payloadTooLarge(payload: Record<string, unknown>): boolean {
  return Buffer.byteLength(JSON.stringify(payload), 'utf8') > MAX_DRAFT_PAYLOAD_BYTES;
}

// Asks for a proposal instead of running R2 or R3 work (P05, P06): the preparer (an R0 module command the agent's role
// key may run, so it writes nothing) builds it in the agent's run, and the task waits for the review. The event carries
// what it built: the worker never runs the preparer again, so nothing the agent names runs as the system. The proposal
// carries the run's and the task's taint.
export const proposeFromTask = defineCommand({
  name: 'kernel.task.propose',
  input: z.object({ id: zId, fence: zFence, preparer: z.string().min(1).max(200), input: z.record(z.string(), z.unknown()) }),
  risk: 'R1',
  sideEffect: 'internal',
  access: [],
  agent: { roles: 'any', taint: 'propagate' },
  // The preparer it runs declares its own.
  writes: [tableWrite(TASK_TABLES, 'crove_kernel', 'task', LEASE_COLUMNS), RUN_TAINT_WRITE],
  target: (input) => ({ type: 'kernel.task', id: input.id }),
  handler: async (ctx, input) => {
    const agent = requireAgent(ctx);
    const task = await requireLease(ctx, input.id, input.fence);
    // Read-only preparers only. It runs as the agent: it must declare agent access for its role key (the runtime
    // checks it).
    if (ctx.command(input.preparer)?.risk !== 'R0') throw new DomainError('NOT_PROPOSABLE', 422, 'Việc này không tạo được đề xuất', { preparer: input.preparer });
    const draft = zPrepared.safeParse(await ctx.run(input.preparer, input.input));
    const info = draft.success ? ctx.command(draft.data.command) : null;
    if (!draft.success || !info || info.access !== 'proposal') {
      throw new DomainError('NOT_PROPOSABLE', 422, 'Việc này không tạo được đề xuất', { preparer: input.preparer });
    }
    if (payloadTooLarge(draft.data.payload)) {
      throw new DomainError('NOT_PROPOSABLE', 422, 'Đề xuất quá lớn', { preparer: input.preparer, reason: 'payload_too_large' });
    }
    await ctx.emit('kernel.agent.proposal_requested', {
      agentId: agent.agentId,
      runId: agent.runId,
      taskId: task.id,
      preparer: input.preparer,
      draft: { command: draft.data.command, payload: draft.data.payload, ...(preparedEntity(draft.data) ? { legalEntityId: preparedEntity(draft.data) } : {}) },
    } satisfies z.infer<typeof zProposalRequested>);
    await ctx.trx
      .updateTable('crove_kernel.task')
      .set({ status: 'waiting', checkout_run_id: null, lock_expires_at: null })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', task.id)
      .execute();
    ctx.audit({ task: task.id, preparer: input.preparer, proposal_command: info.name, risk: info.risk });
    return { requested: true as const, command: info.name };
  },
});

// Records an agent's approval of the proposal its review task is about. R1 without taint propagation, so the runtime
// refuses a tainted run (P03). Only from the review task the dispatch created for its position (system, kind
// 'proposal_review'), never a delegated or escalated copy. The decision is checked here and again by the worker
// before anything executes.
export const approveFromTask = defineCommand({
  name: 'kernel.task.approve_proposal',
  input: z.object({ id: zId, fence: zFence, proposalId: zId, revision: z.number().int().positive() }),
  risk: 'R1',
  sideEffect: 'internal',
  access: [],
  agent: { roles: 'any' },
  writes: [tableWrite(TASK_TABLES, 'crove_kernel', 'task', LEASE_COLUMNS), RUN_TAINT_WRITE],
  target: (input) => ({ type: 'kernel.proposal', id: input.proposalId }),
  handler: async (ctx, input) => {
    const agent = requireAgent(ctx);
    const task = await requireLease(ctx, input.id, input.fence);
    const ref = zProposalRef.safeParse(task.source_ref);
    if (!ref.success || ref.data.id !== input.proposalId || task.kind !== 'proposal_review' || task.created_by_type !== 'system') {
      throw new DomainError('PROPOSAL_NOT_TASK', 422, 'Việc này không phải để duyệt đề xuất đó');
    }
    const proposal = await ctx.trx.selectFrom('crove_kernel.proposal').selectAll().where('org_id', '=', ctx.orgId).where('id', '=', input.proposalId).executeTakeFirst();
    if (!proposal) throw new DomainError('NOT_FOUND', 404, 'Không tìm thấy đề xuất');
    const decision = await decideAgentApproval(ctx.trx, ctx.orgId, agent, proposal, ctx.command(proposal.command), input.revision);
    if (decision.reason !== 'ok') {
      throw new DomainError('AGENT_NOT_ELIGIBLE', 403, 'Tác tử AI không được duyệt đề xuất này; cần người duyệt', { rule: decision.rule, reason: decision.reason });
    }
    await ctx.emit('kernel.agent.proposal_approved', {
      agentId: agent.agentId,
      runId: agent.runId,
      taskId: task.id,
      proposalId: proposal.id,
      revision: input.revision,
    } satisfies z.infer<typeof zProposalApproved>);
    await ctx.trx
      .updateTable('crove_kernel.task')
      .set({ status: 'done', checkout_run_id: null, lock_expires_at: null })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', task.id)
      .execute();
    ctx.audit({ task: task.id, proposal: proposal.id, revision: input.revision });
    return { recorded: true as const };
  },
});

interface AgentEvent<T> {
  id: string;
  data: T;
  commandId: string | null;
  createdAt: Date;
}

async function outboxEvent<T>(ctx: CommandContext, eventId: string, type: string, schema: z.ZodType<T>): Promise<AgentEvent<T> | null> {
  const event = await ctx.trx
    .selectFrom('crove_kernel.outbox_event')
    .select(['id', 'type', 'payload', 'command_id', 'created_at'])
    .where('org_id', '=', ctx.orgId)
    .where('id', '=', eventId)
    .executeTakeFirst();
  if (!event || event.type !== type) return null;
  const parsed = schema.safeParse(event.payload);
  return parsed.success ? { id: event.id, data: parsed.data, commandId: event.command_id, createdAt: event.created_at } : null;
}

// Whether the event was emitted by a successful run of `command` by the agent it names, in the run it names, about
// `target` and the task it names, with `detail` in the audit row (#435): the event's command_id is that command's
// audit row. The database stamps an agent's audit rows with the agent and the run of the sealed context
// (agent_write_guard), so the payload cannot name another agent, run or task, and an event that any other command
// emitted, or that was written outside emit(), binds to nothing.
async function emittedBy(
  trx: Trx,
  orgId: string,
  event: AgentEvent<{ agentId: string; runId: string; taskId: string }>,
  command: string,
  target: { type: string; id: string },
  detail: Record<string, unknown>,
): Promise<boolean> {
  if (!event.commandId) return false;
  // The audit row and the event come from one transaction, so they carry the same now(): the time index finds it.
  const { rows } = await sql<{ bound: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM crove_kernel.outbox_event e
      JOIN crove_kernel.audit_event a ON a.org_id = e.org_id AND a.occurred_at = e.created_at AND a.command_id = e.command_id
      WHERE e.org_id = ${orgId}::uuid AND e.id = ${event.id}::uuid AND a.command = ${command} AND a.outcome = 'ok'
        AND a.actor_type = 'agent' AND a.actor_id = ${event.data.agentId}::uuid AND a.detail ->> 'agentRun' = ${event.data.runId}
        AND a.target_type = ${target.type} AND a.target_id = ${target.id}::uuid
        AND a.detail ->> 'task' = ${event.data.taskId}
        AND a.detail @> ${JSON.stringify(detail)}::jsonb
    ) AS bound`.execute(trx);
  return rows[0]?.bound === true;
}

// The users who created tasks in the chain up from a task: authors of what the agent proposes (P10: the creator chain
// of a task counts as authors), and whether the chain started from a human (otherwise P07, an untrusted trigger).
async function taskChain(trx: Trx, orgId: string, taskId: string): Promise<{ users: string[]; humanRoot: boolean }> {
  const { rows } = await sql<{ created_by_type: string; created_by_id: string | null; source: string; parent_task_id: string | null }>`
    WITH RECURSIVE chain (id, created_by_type, created_by_id, source, parent_task_id, depth) AS (
      SELECT t.id, t.created_by_type, t.created_by_id, t.source, t.parent_task_id, 0
      FROM crove_kernel.task t WHERE t.org_id = ${orgId}::uuid AND t.id = ${taskId}::uuid
      UNION ALL
      SELECT t.id, t.created_by_type, t.created_by_id, t.source, t.parent_task_id, c.depth + 1
      FROM chain c JOIN crove_kernel.task t ON t.org_id = ${orgId}::uuid AND t.id = c.parent_task_id
      WHERE c.depth < 20
    )
    SELECT created_by_type, created_by_id, source, parent_task_id FROM chain ORDER BY depth`.execute(trx);
  const users = [...new Set(rows.flatMap((r) => (r.created_by_type === 'user' && r.created_by_id ? [r.created_by_id] : [])))];
  const root = rows.at(-1);
  return { users, humanRoot: root !== undefined && root.parent_task_id === null && root.source === 'human' && root.created_by_type === 'user' };
}

// Creates the proposal an agent asked for (worker, system), from what the agent's run prepared: the event was emitted
// by the agent's kernel.task.propose in that run on that task (#435), the run is the agent's and live, the task is its
// position's, no kill switch covering the agent is engaged or was engaged since the request (#435), the preparer is
// still R0 and the payload within MAX_DRAFT_PAYLOAD_BYTES. The kind comes from the command and the title from the
// kernel. Flags: P03 when the run or the task is tainted; P04 when the command declares a write of a column its
// manifest classifies `contact` or `payment`, or declares no writes (CommandInfo.contactOrPayment, #1697); P05 for R3
// and P06 for R2 (work asked for by a non-user actor); P07 when the chain did not start from a human. Authors: the
// agent and the run, and every user who created a task in the chain. One proposal per event.
export const createAgentProposal = defineCommand({
  name: 'kernel.agent.proposal.create',
  input: z.object({ eventId: zId }),
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  handler: async (ctx, input) => {
    const event = await outboxEvent(ctx, input.eventId, 'kernel.agent.proposal_requested', zProposalRequested);
    if (!event) return { proposalId: null, reason: 'no_event' as const };
    const { agentId, runId, taskId, preparer, draft } = event.data;
    const bound = await emittedBy(ctx.trx, ctx.orgId, event, 'kernel.task.propose', { type: 'kernel.task', id: taskId }, { preparer, proposal_command: draft.command });
    const { rows } = bound
      ? await sql<{ run_tainted: boolean; run_status: string; task_tainted: boolean; agent_name: string; stopped: boolean; le_scope: string[] }>`
          SELECT r.tainted AS run_tainted, r.status AS run_status, t.tainted AS task_tainted, a.display_name AS agent_name, p.le_scope,
                 EXISTS (SELECT 1 FROM crove_kernel.kill_switch k
                         WHERE k.org_id = r.org_id AND (k.released_at IS NULL OR k.engaged_at > ${event.createdAt}::timestamptz)
                           AND (k.scope = 'org' OR (k.scope = 'module' AND k.target IN (r.module, p.module))
                                OR (k.scope = 'agent' AND k.target = r.agent_id::text))) AS stopped
          FROM crove_kernel.ai_run r
          JOIN crove_kernel.agent a ON a.org_id = r.org_id AND a.id = r.agent_id
          JOIN crove_kernel.task t ON t.org_id = r.org_id AND t.id = ${taskId}::uuid
          JOIN crove_kernel.position p ON p.org_id = t.org_id AND p.id = t.assignee_position_id AND p.holder_agent_id = r.agent_id
          WHERE r.org_id = ${ctx.orgId}::uuid AND r.id = ${runId}::uuid AND r.agent_id = ${agentId}::uuid`.execute(ctx.trx)
      : { rows: [] };
    const facts = rows[0];
    if (!facts) {
      ctx.audit({ event: event.id, created: false, reason: 'chain_mismatch' });
      return { proposalId: null, reason: 'chain_mismatch' as const };
    }
    // A run cancelled by a kill switch or a stop (or failed, or expired) asks for nothing.
    if (facts.run_status !== 'running' && facts.run_status !== 'succeeded') {
      ctx.audit({ event: event.id, created: false, reason: 'run_not_live', run_status: facts.run_status });
      return { proposalId: null, reason: 'run_not_live' as const };
    }
    // Nor does a run a kill switch covers, including one engaged and released since the request (P01).
    if (facts.stopped) {
      ctx.audit({ event: event.id, created: false, reason: 'stopped' });
      return { proposalId: null, reason: 'stopped' as const };
    }
    const info = ctx.command(draft.command);
    if (ctx.command(preparer)?.risk !== 'R0' || !info || info.access !== 'proposal' || payloadTooLarge(draft.payload)) {
      ctx.audit({ event: event.id, created: false, reason: 'not_proposable' });
      return { proposalId: null, reason: 'not_proposable' as const };
    }
    // The Inbox renders a proposal by its kind and title: the command's kind, and a title from the agent's name (set
    // by an owner) and that kind, never text the agent's run supplied.
    // The legal entity it belongs to (#1538): the one the agent's preparer named in the payload, else the org's
    // default. Within its position's scope, as its run saw (the preparer ran under le_scope): checked again here, as
    // the system writes it.
    const entity =
      preparedEntity(draft) ??
      (await ctx.trx.selectFrom('crove_kernel.legal_entity').select('id').where('org_id', '=', ctx.orgId).where('is_default', '=', true).executeTakeFirst())?.id;
    if (!entity || !scopeCovers(facts.le_scope, entity)) {
      ctx.audit({ event: event.id, created: false, reason: 'out_of_scope' });
      return { proposalId: null, reason: 'out_of_scope' as const };
    }
    const kind = info.proposalKind;
    const title = `Tác tử AI ${facts.agent_name} đề xuất: ${kind}`.slice(0, 300);
    const tainted = facts.run_tainted || facts.task_tainted;
    const chain = await taskChain(ctx.trx, ctx.orgId, taskId);
    const flags = [
      ...(tainted ? ['P03'] : []),
      ...(info.contactOrPayment ? ['P04'] : []),
      ...(info.risk === 'R3' ? ['P05'] : info.risk === 'R2' ? ['P06'] : []),
      ...(chain.humanRoot ? [] : ['P07']),
    ];
    const authors: ActorRef[] = [{ type: 'agent', id: agentId, run: runId }, ...chain.users.map((id) => ({ type: 'user' as const, id }))];
    const proposal = await ctx.trx
      .insertInto('crove_kernel.proposal')
      .values({
        org_id: ctx.orgId,
        kind,
        command: draft.command,
        title,
        payload: JSON.stringify(draft.payload),
        // P12: the humans who may approve it; agents are judged at approval (decideAgentApproval).
        eligible_approvers: await eligibleApprovers(ctx.trx, ctx.orgId, draft.command),
        authors: JSON.stringify(authors),
        requested_by_agent: agentId,
        requested_by_run: runId,
        source_task_id: taskId,
        request_event_id: event.id,
        tainted,
        policy_flags: flags,
        legal_entity_id: entity,
      })
      .onConflict((oc) => oc.columns(['org_id', 'request_event_id']).where('request_event_id', 'is not', null).doNothing())
      .returning('id')
      .executeTakeFirst();
    if (!proposal) return { proposalId: null, reason: 'duplicate' as const };
    ctx.audit({ event: event.id, proposal_id: proposal.id, proposal_command: draft.command, policy_flags: flags, tainted });
    await ctx.trx
      .insertInto('crove_kernel.task_comment')
      // The proposal's kind and id, not its title, so a later change to how titles are built cannot carry a party's name
      // here (#1825); the proposal's page shows the title.
      .values({ org_id: ctx.orgId, task_id: taskId, body: `Đã gửi đề xuất chờ duyệt: ${kind} (mã ${proposal.id})`, author_type: 'system' })
      .execute();
    await ctx.activity('kernel.proposal', proposal.id, 'proposal.created', 'Tác tử AI tạo đề xuất');
    await ctx.emit('kernel.proposal.created', { proposalId: proposal.id, kind });
    return { proposalId: proposal.id, reason: null };
  },
});

// Executes an agent's approval (worker, system), after deciding it again on the locked proposal: the event was emitted
// by the agent's kernel.task.approve_proposal in that run, from that task, for that proposal and revision (#435); the
// agent, its run, the command's agent approvers, the flags and the causal chain as they are now; and no kill switch
// covering the approver was engaged after the approval was recorded, even one released since (#435). A refusal is
// recorded and ends the
// job; nothing executes. The approved command runs through the proposal gate as the system, and the proposal names the
// agent that decided it.
export const executeAgentApproval = defineCommand({
  name: 'kernel.agent.proposal.approve',
  input: z.object({ eventId: zId }),
  // It runs the approved proposal, an R1 or R2 command, in its transaction (plan §4.7; #1563). A system command, so
  // the worker runs it as before.
  risk: 'R2',
  sideEffect: 'external',
  access: 'system',
  handler: async (ctx, input) => {
    const event = await outboxEvent(ctx, input.eventId, 'kernel.agent.proposal_approved', zProposalApproved);
    if (!event) return { approved: false, reason: 'no_event' };
    const { agentId, runId, taskId, proposalId, revision } = event.data;
    if (!(await emittedBy(ctx.trx, ctx.orgId, event, 'kernel.task.approve_proposal', { type: 'kernel.proposal', id: proposalId }, { proposal: proposalId, revision }))) {
      ctx.audit({ event: event.id, proposal: proposalId, agent: agentId, run: runId, decision: 'chain_mismatch' });
      return { approved: false, reason: 'chain_mismatch' };
    }
    // The review task it was recorded from is the dispatch-created review of this proposal (system, kind
    // 'proposal_review', not a delegated or escalated copy) and belongs to a position the agent holds.
    const { rows: reviews } = await sql<{ source_ref: unknown }>`
      SELECT t.source_ref
      FROM crove_kernel.task t
      JOIN crove_kernel.position p ON p.org_id = t.org_id AND p.id = t.assignee_position_id AND p.holder_agent_id = ${agentId}::uuid
      WHERE t.org_id = ${ctx.orgId}::uuid AND t.id = ${taskId}::uuid AND t.kind = 'proposal_review' AND t.created_by_type = 'system'`.execute(ctx.trx);
    const ref = zProposalRef.safeParse(reviews[0]?.source_ref);
    if (!ref.success || ref.data.id !== proposalId) {
      ctx.audit({ event: event.id, proposal: proposalId, agent: agentId, run: runId, decision: 'chain_mismatch' });
      return { approved: false, reason: 'chain_mismatch' };
    }
    const proposal = await ctx.trx.selectFrom('crove_kernel.proposal').selectAll().where('org_id', '=', ctx.orgId).where('id', '=', proposalId).forUpdate().executeTakeFirst();
    if (!proposal) return { approved: false, reason: 'not_found' };
    // A re-extraction in flight would replace the content the agent judged (issue #40); the job retries.
    await refuseWhileReextracting(ctx, proposal.source_file_id);
    const decision = await decideAgentApproval(ctx.trx, ctx.orgId, { agentId, runId }, proposal, ctx.command(proposal.command), revision, {
      stoppedSince: event.createdAt,
    });
    ctx.audit({ event: event.id, proposal: proposal.id, agent: agentId, run: runId, decision: decision.reason, rule: decision.rule ?? null });
    if (decision.reason !== 'ok') return { approved: false, reason: decision.reason };
    await ctx.trx
      .updateTable('crove_kernel.proposal')
      .set({ status: 'approved', decided_by_agent: agentId, decided_at: ctx.now, executed_command_id: ctx.commandId })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', proposal.id)
      .execute();
    const result = await ctx.run<Record<string, unknown>>(proposal.command, { payload: proposal.payload, acceptFailedChecks: false }, { proposalId: proposal.id });
    await ctx.trx
      .updateTable('crove_kernel.proposal')
      .set({ status: 'executed', result: JSON.stringify(result ?? null) })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', proposal.id)
      .execute();
    await ctx.activity('kernel.proposal', proposal.id, 'proposal.approved', 'Tác tử AI đã duyệt');
    return { approved: true, reason: null };
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
  createTaskFromTodo,
  checkoutTask,
  commentTask,
  setTaskStatus,
  escalateTask,
  delegateTask,
  dispatchAgentEvent,
  startAgentRun,
  finishAgentRun,
  proposeFromTask,
  approveFromTask,
  createAgentProposal,
  executeAgentApproval,
];

export const agentQueries = [chartGet, taskList, taskGet, templateList, budgetList];
