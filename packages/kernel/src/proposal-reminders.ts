// Reminders and escalation for proposals waiting for approval (#676, plan §8.3 "After approval"). An org may set, in
// crove_kernel.proposal_policy, how many days a proposal can wait before the people who may approve it get a
// reminder mail, and how many days before its owners are told. The worker finds the proposals due
// (proposal_nudges_due) and runs kernel.proposal.remind for each, which checks again under the proposal's lock, mails
// once per stage, stamps the proposal and leaves its audit row. A reminder never approves, rejects or changes a
// proposal's content; a decision ends both stages.
import { sql } from 'kysely';
import { z } from 'zod';
import { zId } from '@crove/kernel-contract';
import type { Db, MemberRole } from '@crove/db';
import { DomainError, defineCommand, defineQuery, type CommandContext, type Runtime, type SystemActor } from '@crove/kernel-runtime';
import { decideApproval } from './approval.ts';
import { createMailMessage } from './mail.ts';

const ACTOR: SystemActor = { type: 'system', component: 'kernel.proposal_reminders' };
// How often the worker looks for reminders due, and how many proposals it takes per pass.
export const PROPOSAL_NUDGE_SWEEP_MS = 30 * 60_000;
export const PROPOSAL_NUDGE_LIMIT = 200;
export const PROPOSAL_REMINDER_TEMPLATE = 'kernel.proposal.reminder';
const DAY_MS = 86_400_000;
const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const ADMINS: readonly MemberRole[] = ['owner', 'admin'];

export interface ProposalPolicy {
  remindAfterDays: number | null;
  escalateAfterDays: number | null;
}

export const zProposalPolicy = z.strictObject({
  remindAfterDays: z.number().int().min(1).max(30).nullable(),
  escalateAfterDays: z.number().int().min(1).max(60).nullable(),
});

export type NudgeStage = 'remind' | 'escalate';

// Which stages a pending proposal has due now; the same rule as proposal_nudges_due.
export function nudgesDue(
  p: { status: string; createdAt: Date; remindedAt: Date | null; escalatedAt: Date | null },
  policy: ProposalPolicy,
  now: Date,
): NudgeStage[] {
  if (p.status !== 'pending') return [];
  const waited = now.getTime() - p.createdAt.getTime();
  const due: NudgeStage[] = [];
  if (policy.remindAfterDays !== null && p.remindedAt === null && waited >= policy.remindAfterDays * DAY_MS) due.push('remind');
  if (policy.escalateAfterDays !== null && p.escalatedAt === null && waited >= policy.escalateAfterDays * DAY_MS) due.push('escalate');
  return due;
}

async function readPolicy(ctx: Pick<CommandContext, 'trx' | 'orgId'>): Promise<ProposalPolicy> {
  const row = await ctx.trx
    .selectFrom('crove_kernel.proposal_policy')
    .select(['remind_after_days', 'escalate_after_days'])
    .where('org_id', '=', ctx.orgId)
    .orderBy('created_at')
    .orderBy('id')
    .limit(1)
    .executeTakeFirst();
  return { remindAfterDays: row?.remind_after_days ?? null, escalateAfterDays: row?.escalate_after_days ?? null };
}

export const proposalPolicyGet = defineQuery({
  name: 'kernel.proposal_policy.get',
  input: z.strictObject({}),
  access: ALL,
  handler: async (ctx): Promise<ProposalPolicy> => readPolicy(ctx),
});

export const proposalPolicySave = defineCommand({
  name: 'kernel.proposal_policy.save',
  input: zProposalPolicy,
  risk: 'R1',
  access: ADMINS,
  handler: async (ctx, input): Promise<ProposalPolicy> => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
    if (input.remindAfterDays !== null && input.escalateAfterDays !== null && input.escalateAfterDays <= input.remindAfterDays) {
      throw new DomainError('PROPOSAL_POLICY_ORDER', 422, 'Số ngày báo chủ sở hữu phải lớn hơn số ngày nhắc người duyệt');
    }
    await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(${`crove_kernel.proposal_policy:${ctx.orgId}`}))`.execute(ctx.trx);
    const before = await readPolicy(ctx);
    const values = { remind_after_days: input.remindAfterDays, escalate_after_days: input.escalateAfterDays, updated_by: ctx.actor.userId, updated_at: ctx.now };
    const updated = await ctx.trx.updateTable('crove_kernel.proposal_policy').set(values).where('org_id', '=', ctx.orgId).executeTakeFirst();
    if (Number(updated.numUpdatedRows) === 0) {
      await ctx.trx
        .insertInto('crove_kernel.proposal_policy')
        .values({ org_id: ctx.orgId, ...values, created_at: ctx.now })
        .execute();
    }
    ctx.audit({ previous: before, policy: input });
    return input;
  },
});

// The people who could approve the proposal's current revision now, by the same rules as the approve command: in the
// snapshot taken at creation, still holding an approving role, and not stopped by four-eyes.
async function approversNow(ctx: CommandContext, proposal: { command: string; status: string; eligible_approvers: string[] | null; authors: unknown }): Promise<string[]> {
  const out: string[] = [];
  for (const userId of proposal.eligible_approvers ?? []) {
    const decision = await decideApproval(ctx.trx, ctx.orgId, { type: 'user', userId, aal: 'aal2' }, proposal, { lock: false });
    if (decision.reason === 'ok') out.push(userId);
  }
  return out;
}

async function owners(ctx: CommandContext): Promise<string[]> {
  const rows = await ctx.trx.selectFrom('crove_kernel.tenant_member').select('user_id').where('org_id', '=', ctx.orgId).where('role', '=', 'owner').orderBy('user_id').execute();
  return rows.map((r) => r.user_id);
}

export interface RemindResult {
  stages: NudgeStage[];
  queued: number;
}

export const proposalRemind = defineCommand({
  name: 'kernel.proposal.remind',
  input: z.strictObject({ proposalId: zId }),
  risk: 'R1',
  access: 'system',
  target: (input) => ({ type: 'kernel.proposal', id: input.proposalId }),
  handler: async (ctx, input): Promise<RemindResult> => {
    // Under the proposal's lock, so a decision in flight is either seen or comes after.
    const proposal = await ctx.trx
      .selectFrom('crove_kernel.proposal')
      .select(['id', 'command', 'status', 'title', 'created_at', 'reminded_at', 'escalated_at', 'eligible_approvers', 'authors'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.proposalId)
      .forUpdate()
      .executeTakeFirst();
    if (!proposal) return { stages: [], queued: 0 };
    const policy = await readPolicy(ctx);
    const stages = nudgesDue({ status: proposal.status, createdAt: proposal.created_at, remindedAt: proposal.reminded_at, escalatedAt: proposal.escalated_at }, policy, ctx.now);
    if (stages.length === 0) return { stages: [], queued: 0 };

    const org = await ctx.trx.selectFrom('crove_kernel.tenant').select(['slug', 'name']).where('org_id', '=', ctx.orgId).executeTakeFirstOrThrow();
    const days = Math.floor((ctx.now.getTime() - proposal.created_at.getTime()) / DAY_MS);
    const recipients = new Map<NudgeStage, string[]>();
    if (stages.includes('remind')) recipients.set('remind', await approversNow(ctx, proposal));
    if (stages.includes('escalate')) recipients.set('escalate', await owners(ctx));
    const everyone = [...new Set([...recipients.values()].flat())];
    const { rows: people } = everyone.length
      ? await sql<{ user_id: string; email: string | null }>`SELECT user_id, email FROM crove_kernel.member_emails(${everyone}::uuid[])`.execute(ctx.trx)
      : { rows: [] };
    const emails = new Map(people.filter((p) => p.email).map((p) => [p.user_id, p.email as string]));

    let queued = 0;
    const sent: Record<string, number> = {};
    for (const stage of stages) {
      let n = 0;
      for (const userId of recipients.get(stage) ?? []) {
        const email = emails.get(userId);
        if (!email) continue;
        const mail = await createMailMessage(ctx, {
          stream: 'transactional',
          source: 'kernel.proposal.remind',
          sourceId: proposal.id,
          templateKey: PROPOSAL_REMINDER_TEMPLATE,
          to: email,
          subject: stage === 'remind' ? `Đề xuất chờ bạn duyệt đã ${days} ngày` : `Đề xuất chưa được duyệt sau ${days} ngày`,
          payload: { stage, org: org.name, title: proposal.title, days, path: `/o/${org.slug}/inbox/${proposal.id}` },
          status: 'queued',
        });
        if (mail.status === 'queued') n++;
      }
      sent[stage] = n;
      queued += n;
    }
    // Stamped even when nobody had an address: the stage happened once, and the audit row says who was mailed.
    await ctx.trx
      .updateTable('crove_kernel.proposal')
      .set({ ...(stages.includes('remind') ? { reminded_at: ctx.now } : {}), ...(stages.includes('escalate') ? { escalated_at: ctx.now } : {}) })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', proposal.id)
      .execute();
    ctx.audit({ stages, days, recipients: Object.fromEntries([...recipients].map(([s, ids]) => [s, ids.length])), queued: sent });
    return { stages, queued };
  },
});

// One pass: each proposal with a stage due gets it.
export async function sweepProposalNudges(deps: { runtime: Runtime; workerDb: Db }): Promise<number> {
  const { rows } = await sql<{ org_id: string; proposal_id: string }>`SELECT org_id, proposal_id FROM crove_kernel.proposal_nudges_due(${PROPOSAL_NUDGE_LIMIT}::int)`.execute(deps.workerDb);
  let done = 0;
  for (const row of rows) {
    try {
      const result = await deps.runtime.execute<RemindResult>('kernel.proposal.remind', { proposalId: row.proposal_id }, { actor: ACTOR, orgId: row.org_id });
      if (result.stages.length > 0) done += 1;
    } catch (error) {
      console.warn(`[proposal-reminders] proposal ${row.proposal_id.slice(0, 8)}`, error instanceof DomainError ? error.code : error instanceof Error ? error.message : error);
    }
  }
  return done;
}

export const proposalReminderCommands = [proposalPolicySave, proposalRemind];
export const proposalReminderQueries = [proposalPolicyGet];
