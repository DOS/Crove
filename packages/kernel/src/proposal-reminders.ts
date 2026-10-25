// Reminders and escalation for proposals waiting for approval (#676, plan §8.3 "After approval"). An org may set, in
// crove_kernel.proposal_policy, how many days a proposal can wait before the people who may approve it get a
// reminder mail, and how many days before its owners are told. The worker finds the proposals due
// (proposal_nudges_due) and runs kernel.proposal.remind for each, which checks again under the proposal's lock, mails
// once per stage, stamps the proposal and leaves its audit row. A reminder never approves, rejects or changes a
// proposal's content; a decision ends both stages.
//
// Expiry (#876): an org may also set how many days a proposal may stay pending at all. It needs the owners' escalation
// and comes after it, and a proposal expires only once its owners were told and have had the days between the two
// since (so a backlog already old when an org turns expiry on is escalated first). The worker finds the proposals past
// it (proposal_expiries_due) and runs kernel.proposal.expire
// for each, which checks again under the proposal's lock and moves it to 'expired', a terminal state: audited, an
// activity entry, and nothing else (no mail; the reminder stages and the notifications only ever act on pending
// proposals, so its approvers are not mailed again). Its author may ask for it again (kernel.proposal.resubmit).
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
  expireAfterDays: number | null;
}

export const zProposalPolicy = z.strictObject({
  remindAfterDays: z.number().int().min(1).max(30).nullable(),
  escalateAfterDays: z.number().int().min(1).max(60).nullable(),
  expireAfterDays: z.number().int().min(2).max(90).nullable(),
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

// Whether a proposal is past its org's expiry now; the same rule as proposal_expiries_due. It waited the days the org
// set, its owners were told (escalated_at), and since then they have had the days between escalation and expiry.
export function expiryDue(p: { status: string; createdAt: Date; escalatedAt: Date | null }, policy: ProposalPolicy, now: Date): boolean {
  if (p.status !== 'pending' || policy.expireAfterDays === null || policy.escalateAfterDays === null || p.escalatedAt === null) return false;
  const window = (policy.expireAfterDays - policy.escalateAfterDays) * DAY_MS;
  return now.getTime() - p.createdAt.getTime() >= policy.expireAfterDays * DAY_MS && now.getTime() - p.escalatedAt.getTime() >= window;
}

export async function readPolicy(ctx: Pick<CommandContext, 'trx' | 'orgId'>): Promise<ProposalPolicy> {
  const row = await ctx.trx
    .selectFrom('crove_kernel.proposal_policy')
    .select(['remind_after_days', 'escalate_after_days', 'expire_after_days'])
    .where('org_id', '=', ctx.orgId)
    .orderBy('created_at')
    .orderBy('id')
    .limit(1)
    .executeTakeFirst();
  return {
    remindAfterDays: row?.remind_after_days ?? null,
    escalateAfterDays: row?.escalate_after_days ?? null,
    expireAfterDays: row?.expire_after_days ?? null,
  };
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
  sideEffect: 'internal',
  access: ADMINS,
  handler: async (ctx, input): Promise<ProposalPolicy> => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
    if (input.remindAfterDays !== null && input.escalateAfterDays !== null && input.escalateAfterDays <= input.remindAfterDays) {
      throw new DomainError('PROPOSAL_POLICY_ORDER', 422, 'Số ngày báo chủ sở hữu phải lớn hơn số ngày nhắc người duyệt');
    }
    // The owners hear about a proposal before it expires: expiry needs the escalation and comes after it.
    if (input.expireAfterDays !== null && (input.escalateAfterDays === null || input.expireAfterDays <= input.escalateAfterDays)) {
      throw new DomainError('PROPOSAL_EXPIRY_ORDER', 422, 'Chỉ đặt được hạn chờ duyệt khi đã bật báo chủ sở hữu, và hạn này phải dài hơn số ngày báo chủ sở hữu');
    }
    await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(${`crove_kernel.proposal_policy:${ctx.orgId}`}))`.execute(ctx.trx);
    const before = await readPolicy(ctx);
    const values = {
      remind_after_days: input.remindAfterDays,
      escalate_after_days: input.escalateAfterDays,
      expire_after_days: input.expireAfterDays,
      updated_by: ctx.actor.userId,
      updated_at: ctx.now,
    };
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
  sideEffect: 'internal',
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

export interface ExpireResult {
  expired: boolean;
}

// Moves a pending proposal past its org's expiry to 'expired' (#876). System only, like the reminders: no person
// expires a proposal, and RPC never reaches it. Under the proposal's lock, so a decision in flight is either seen (the
// proposal is no longer pending) or comes after and finds it expired (PROPOSAL_EXPIRED). It writes the proposal's state
// and decision time, its audit row and an activity entry, and nothing else: no mail, no event.
export const proposalExpire = defineCommand({
  name: 'kernel.proposal.expire',
  input: z.strictObject({ proposalId: zId }),
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  target: (input) => ({ type: 'kernel.proposal', id: input.proposalId }),
  handler: async (ctx, input): Promise<ExpireResult> => {
    const proposal = await ctx.trx
      .selectFrom('crove_kernel.proposal')
      .select(['id', 'status', 'title', 'revision', 'created_at', 'escalated_at'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.proposalId)
      .forUpdate()
      .executeTakeFirst();
    if (!proposal) return { expired: false };
    const policy = await readPolicy(ctx);
    if (!expiryDue({ status: proposal.status, createdAt: proposal.created_at, escalatedAt: proposal.escalated_at }, policy, ctx.now)) return { expired: false };
    const days = Math.floor((ctx.now.getTime() - proposal.created_at.getTime()) / DAY_MS);
    await ctx.trx
      .updateTable('crove_kernel.proposal')
      .set({ status: 'expired', decided_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', proposal.id)
      .execute();
    ctx.audit({ revision: proposal.revision, days, expire_after_days: policy.expireAfterDays });
    await ctx.activity('kernel.proposal', proposal.id, 'proposal.expired', `Hết hạn sau ${days} ngày chờ duyệt: ${proposal.title}`);
    return { expired: true };
  },
});

// One pass: each proposal past its org's expiry expires first, then each pending proposal with a stage due gets it (an
// expired proposal is no longer pending, so it gets no reminder). A proposal expires only after its escalation, so the
// order never skips the owners' mail.
export async function sweepProposalNudges(deps: { runtime: Runtime; workerDb: Db }): Promise<number> {
  let done = 0;
  const { rows: expiring } = await sql<{ org_id: string; proposal_id: string }>`SELECT org_id, proposal_id FROM crove_kernel.proposal_expiries_due(${PROPOSAL_NUDGE_LIMIT}::int)`.execute(deps.workerDb);
  for (const row of expiring) {
    try {
      const result = await deps.runtime.execute<ExpireResult>('kernel.proposal.expire', { proposalId: row.proposal_id }, { actor: ACTOR, orgId: row.org_id });
      if (result.expired) done += 1;
    } catch (error) {
      console.warn(`[proposal-expiry] proposal ${row.proposal_id.slice(0, 8)}`, error instanceof DomainError ? error.code : error instanceof Error ? error.message : error);
    }
  }
  const { rows } = await sql<{ org_id: string; proposal_id: string }>`SELECT org_id, proposal_id FROM crove_kernel.proposal_nudges_due(${PROPOSAL_NUDGE_LIMIT}::int)`.execute(deps.workerDb);
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

export const proposalReminderCommands = [proposalPolicySave, proposalRemind, proposalExpire];
export const proposalReminderQueries = [proposalPolicyGet];
