// Approval policy for proposals (plan §4.7 P10 and P12, §8.3). kernel.proposal.approve enforces it and
// kernel.inbox.get reports the same decision, so the Inbox shows Approve only to users the server accepts.
import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import type { Database, MemberRole } from '@crove/db';
import type { Actor, CommandInfo, QueryContext, Risk } from '@crove/kernel-runtime';

// Who produced (part of) a revision's content. Only user entries are humans; system and agent entries never count
// as approvers or for four-eyes (ADR-0029 §6).
export const zActorRef = z.discriminatedUnion('type', [
  z.object({ type: z.literal('user'), id: z.uuid() }),
  z.object({ type: z.literal('system'), component: z.string() }),
  z.object({ type: z.literal('agent'), id: z.uuid(), run: z.uuid() }),
]);
export type ActorRef = z.infer<typeof zActorRef>;

export function actorRef(actor: Actor): ActorRef {
  if (actor.type === 'user') return { type: 'user', id: actor.userId };
  if (actor.type === 'agent') return { type: 'agent', id: actor.agentId, run: actor.runId };
  return { type: 'system', component: actor.component };
}

export function parseAuthors(raw: unknown): ActorRef[] | null {
  const result = z.array(zActorRef).safeParse(raw);
  return result.success ? result.data : null;
}

const refKey = (a: ActorRef) => (a.type === 'system' ? `system:${a.component}` : `${a.type}:${a.id}`);

// Authors only accumulate: an edit adds the editor, and nobody who wrote part of the content is removed.
export function addAuthor(authors: readonly ActorRef[], author: ActorRef): ActorRef[] {
  return authors.some((a) => refKey(a) === refKey(author)) ? [...authors] : [...authors, author];
}

interface CommandPolicy {
  // Base roles whose holders may approve the command (P12).
  roles: readonly MemberRole[];
  // The permission whose holders may approve it too, through an org-wide role assignment (plan §4.6, #1279), or null.
  permission: string | null;
  // Four-eyes (P10) applies to R3 commands.
  fourEyes: boolean;
}

// The permission that approves a proposal that posts to the ledger (finance.chief_accountant holds it). Only an
// org-wide assignment grants it: no proposal names a legal entity yet, so an entity-scoped assignment could not be
// checked against the proposal's entity, and it grants nothing here (fail closed). When proposals carry
// legal_entity_id, eligibility becomes "holds the permission for the proposal's entity".
export const LEDGER_APPROVE_PERMISSION = 'finance.proposal.approve';

// Approval policy per proposal command. Every proposal command today is R3 and posts to the ledger, so the roles that
// may post approve (#71), and so does a member an owner made chief accountant (the permission above).
const LEDGER: CommandPolicy = { roles: ['owner', 'admin'], permission: LEDGER_APPROVE_PERMISSION, fourEyes: true };
const POLICIES: Record<string, CommandPolicy> = {
  'finance.purchase.record': LEDGER,
  // A reversal is itself a posting (#138): the same roles approve it, with four-eyes.
  'finance.journal.reverse': LEDGER,
  // A cash or bank voucher (phiếu thu, phiếu chi, báo Có, báo Nợ, #327) posts to the ledger: the same rule.
  'finance.voucher.record': LEDGER,
  // A general journal voucher (NVK, #888) posts to the ledger: the same rule.
  'finance.journal_voucher.record': LEDGER,
  // A year-end closing (#889) is a general journal voucher built from the ledger: the same rule.
  'finance.closing.record': LEDGER,
  // A month's depreciation and allocation (#919) is a general journal voucher built from the register: the same rule.
  'finance.depreciation.record': LEDGER,
};

const NOBODY: CommandPolicy = { roles: [], permission: null, fourEyes: true };

function policyFor(command: string): CommandPolicy {
  return POLICIES[command] ?? NOBODY;
}

// The members of the org, among `userIds` when given, who hold `permission` through an org-wide role assignment. No row
// lock of its own (tenant roles may not lock the table): a grant or revoke locks the member's tenant_member row FOR UPDATE
// first (role_assignment_grant, role_assignment_revoke), so an approval that holds the snapshot members' rows FOR SHARE
// and reads this afterwards sees a revoke that committed first and holds back one that starts later.
async function permissionHolders(
  trx: Transaction<Database>,
  orgId: string,
  permission: string,
  options: { userIds?: readonly string[] } = {},
): Promise<Set<string>> {
  if (options.userIds && options.userIds.length === 0) return new Set();
  let query = trx
    .selectFrom('crove_kernel.role_assignment as a')
    .innerJoin('crove_kernel.role_permission as p', 'p.role_key', 'a.role_key')
    // A viewer (the read-only base role) holds no permission, whatever they were given before a demotion (#1279).
    .innerJoin('crove_kernel.tenant_member as m', (join) => join.onRef('m.org_id', '=', 'a.org_id').onRef('m.user_id', '=', 'a.user_id'))
    .select('a.user_id')
    .where('a.org_id', '=', orgId)
    .where('a.legal_entity_id', 'is', null)
    .where('p.permission', '=', permission)
    .where('m.role', '<>', 'viewer')
    .orderBy('a.user_id')
    .orderBy('a.id');
  if (options.userIds) query = query.where('a.user_id', 'in', options.userIds);
  const rows = await query.execute();
  return new Set(rows.map((r) => r.user_id));
}

// The humans who may approve `command` in the org in context right now (the P12 snapshot taken at creation): members
// with an approving base role, and members holding the command's approval permission org-wide. tenant_member rows are
// humans; agents will never be in this list.
export async function eligibleApprovers(trx: Transaction<Database>, orgId: string, command: string): Promise<string[]> {
  const { roles, permission } = policyFor(command);
  if (roles.length === 0 && permission === null) return [];
  const rows = await trx
    .selectFrom('crove_kernel.tenant_member')
    .select(['user_id', 'role'])
    .where('org_id', '=', orgId)
    .orderBy('user_id')
    .execute();
  const holders = permission === null ? new Set<string>() : await permissionHolders(trx, orgId, permission);
  return rows.filter((r) => roles.includes(r.role) || holders.has(r.user_id)).map((r) => r.user_id);
}

export type ApproveReason = 'ok' | 'not_pending' | 'not_eligible' | 'four_eyes';

// The P10 outcome recorded in the approval audit row:
// pass            the approver is not an author;
// self_approved   the approver is an author and the only eligible approver;
// owner_override  every eligible approver is an author, so four-eyes can never be met, and an owner approves.
export type FourEyesOutcome = 'pass' | 'self_approved' | 'owner_override';

export interface ApprovalDecision {
  reason: ApproveReason;
  // Snapshot members who still hold an approving role now.
  eligibleCount: number;
  // The approver is an author (P10 outcome self_approved or owner_override).
  selfApproved: boolean;
  fourEyes: FourEyesOutcome;
}

export interface ProposalPolicyInput {
  command: string;
  status: string;
  eligible_approvers: string[] | null;
  authors: unknown;
}

// Decides whether `actor` may approve the proposal's current revision.
// lock: true inside the approve command, where it takes FOR SHARE locks on the snapshot members' rows, so a
// role change that commits first is seen and one that starts later waits for the approval to commit.
export async function decideApproval(
  trx: Transaction<Database>,
  orgId: string,
  actor: Actor,
  proposal: ProposalPolicyInput,
  options: { lock: boolean },
): Promise<ApprovalDecision> {
  const deny = (reason: ApproveReason, eligibleCount = 0): ApprovalDecision => ({ reason, eligibleCount, selfApproved: false, fourEyes: 'pass' });
  if (proposal.status !== 'pending') return deny('not_pending');
  // R3 and anything a proposal executes needs a human approver (P12); system actors never approve.
  if (actor.type !== 'user') return deny('not_eligible');
  const snapshot = proposal.eligible_approvers ?? [];
  const authors = parseAuthors(proposal.authors);
  // A pending proposal without a recorded snapshot or authors cannot be judged: fail closed.
  if (snapshot.length === 0 || authors === null) return deny('not_eligible');

  const policy = policyFor(proposal.command);
  if (policy.roles.length === 0 && policy.permission === null) return deny('not_eligible');
  let query = trx
    .selectFrom('crove_kernel.tenant_member')
    .select(['user_id', 'role'])
    .where('org_id', '=', orgId)
    .where('user_id', 'in', snapshot)
    // user_id order, as membership changes lock, so the two never take the same rows in opposite orders.
    .orderBy('user_id');
  if (options.lock) query = query.forShare();
  const live = await query.execute();
  // The snapshot members who still hold the approval permission org-wide, read after their membership rows are locked:
  // a grant or revoke locks the member's row first, so the two meet on that row.
  const holders =
    policy.permission === null
      ? new Set<string>()
      : await permissionHolders(trx, orgId, policy.permission, { userIds: live.map((m) => m.user_id) });
  // Eligible now: in the snapshot taken at creation AND still holding an approving role or the approval permission
  // (re-checked live). The snapshot is never rewritten; this filter is what keeps it current. A removed approver has no
  // row, and a demoted one or one whose assignment was revoked no longer approves, so neither is eligible nor counts
  // toward the two that four-eyes (P10) needs.
  const eligible = new Set(live.filter((m) => policy.roles.includes(m.role) || holders.has(m.user_id)).map((m) => m.user_id));
  if (!eligible.has(actor.userId)) return deny('not_eligible', eligible.size);

  const userAuthors = new Set(authors.flatMap((a) => (a.type === 'user' ? [a.id] : [])));
  if (!userAuthors.has(actor.userId)) return { reason: 'ok', eligibleCount: eligible.size, selfApproved: false, fourEyes: 'pass' };
  if (!policy.fourEyes || eligible.size < 2) {
    // P10: a sole eligible approver may approve their own work, flagged.
    return { reason: 'ok', eligibleCount: eligible.size, selfApproved: true, fourEyes: 'self_approved' };
  }
  // Liveness (#88): when every eligible approver wrote part of this revision, four-eyes can never be met and the
  // proposal could only be rejected. An owner among them may approve, flagged. The owner is the trust root and could
  // reach the same result by demoting the others (audited), so this grants no new power; an admin may not.
  const allAuthors = [...eligible].every((id) => userAuthors.has(id));
  const actorRole = live.find((m) => m.user_id === actor.userId)?.role;
  if (allAuthors && actorRole === 'owner') {
    return { reason: 'ok', eligibleCount: eligible.size, selfApproved: true, fourEyes: 'owner_override' };
  }
  return deny('four_eyes', eligible.size);
}

// Users of the org in context who may edit a pending proposal (an edit is R1; the approval stays R3).
export const EDITOR_ROLES: readonly MemberRole[] = ['owner', 'admin', 'member'];

// Whether kernel.proposal.edit can edit this proposal's content at all: its command has a registered reviser (the
// module command, access 'proposal_revision', whose `revises` names it) and its authors are recorded (an edit adds
// the editor to them). kernel.inbox.get reports the same through canEdit.
export function proposalEditable(ctx: Pick<QueryContext, 'reviserOf'>, proposal: { command: string; authors: unknown }): boolean {
  return ctx.reviserOf(proposal.command) !== null && parseAuthors(proposal.authors) !== null;
}

// ---------------------------------------------------------------------------------------------------------------
// Agent approvals (ADR-0029 section 6, issue #260)
// ---------------------------------------------------------------------------------------------------------------

// Rules that send a proposal to a human whatever its risk: an agent never approves one of them in its outcome.
export const HUMAN_REVIEW_RULES = ['P03', 'P04', 'P05', 'P06', 'P07'] as const;

const RISK_RANK: Record<Risk, number> = { R0: 0, R1: 1, R2: 2, R3: 3 };

export type AgentApproveReason =
  | 'ok'
  | 'not_pending'
  | 'stale_revision'
  | 'human_required'
  | 'not_eligible'
  | 'above_max_risk'
  | 'tainted_run'
  | 'run_not_live'
  | 'stopped'
  | 'author'
  | 'causal_chain'
  | 'reporting_line';

export interface AgentApprovalDecision {
  reason: AgentApproveReason;
  // The policy rule behind a refusal (P01 to P12, or causal_chain).
  rule?: string;
}

export interface AgentProposalInput {
  command: string;
  status: string;
  revision: number;
  authors: unknown;
  tainted: boolean;
  policy_flags: string[] | null;
  requested_by_agent: string | null;
  source_task_id: string | null;
}

// Decides whether an agent, in one of its runs, may approve the proposal's current revision. Every fact is read from
// the database here; the caller supplies only who asks and the registered command's facts (ctx.command):
// - the command is a proposal command declaring agent approvers, below R3 (R3 is always human: P05, P12);
// - the outcome names none of P03 to P07, and the content is not tainted; a proposal whose flags no writer assessed
//   (NULL: every proposal not created from an agent's request) is never approved by an agent;
// - the agent is active, holds an active position whose role key is its template's and one of the command's agent
//   approvers, and the command's risk is within its max_risk (the lower of the agent's and the template's, P02);
// - the run is the agent's, untainted (P03), and live: running, or succeeded after recording the approval; a run
//   cancelled by a kill switch or a stop, failed or expired decides nothing (P01). No kill switch covers the org, the
//   module or the agent (P01), and with options.stoppedSince (when the approval was recorded) none covering them was
//   engaged after it, even one released since (#435);
// - the agent is not an author, and not in the proposal's causal chain: it did not ask for it, and no task in the
//   chain was its own or its position's;
// - four-eyes along the reporting line: the approver and the asking agent are not on one line in either direction
//   (neither position is in the other's subtree), for the asking agent's position when it asked (the source task's
//   assignee) and the one it holds now. With neither known, the line cannot be checked, and the approval is refused
//   (#435).
export async function decideAgentApproval(
  trx: Transaction<Database>,
  orgId: string,
  approver: { agentId: string; runId: string },
  proposal: AgentProposalInput,
  info: CommandInfo | null,
  revision?: number,
  options: { stoppedSince?: Date } = {},
): Promise<AgentApprovalDecision> {
  if (proposal.status !== 'pending') return { reason: 'not_pending' };
  if (revision !== undefined && proposal.revision !== revision) return { reason: 'stale_revision' };
  if (!info || info.access !== 'proposal' || info.name !== proposal.command) return { reason: 'not_eligible', rule: 'P12' };
  if (info.risk === 'R3') return { reason: 'human_required', rule: 'P05' };
  const flags = proposal.policy_flags;
  if (flags === null) return { reason: 'human_required', rule: 'P12' };
  const flagged = HUMAN_REVIEW_RULES.find((rule) => flags.includes(rule));
  if (flagged) return { reason: 'human_required', rule: flagged };
  if (proposal.tainted) return { reason: 'human_required', rule: 'P03' };

  const { rows: seats } = await sql<{ position_id: string; role_key: string; module: string; agent_risk: Risk; template_risk: Risk }>`
    SELECT p.id AS position_id, p.role_key, p.module, a.max_risk AS agent_risk, t.max_risk AS template_risk
    FROM crove_kernel.agent a
    JOIN crove_kernel.agent_template t ON t.key = a.template_key
    JOIN crove_kernel.position p ON p.org_id = a.org_id AND p.holder_agent_id = a.id AND p.status = 'active' AND p.role_key = t.role_key
    WHERE a.org_id = ${orgId}::uuid AND a.id = ${approver.agentId}::uuid AND a.status = 'active'`.execute(trx);
  const seat = seats[0];
  if (!seat || !info.agentApprovers.includes(seat.role_key)) return { reason: 'not_eligible', rule: 'P12' };
  const maxRisk = RISK_RANK[seat.agent_risk] < RISK_RANK[seat.template_risk] ? seat.agent_risk : seat.template_risk;
  if (RISK_RANK[info.risk] > RISK_RANK[maxRisk]) return { reason: 'above_max_risk', rule: 'P02' };

  const { rows: runs } = await sql<{ tainted: boolean; status: string; stopped: boolean }>`
    SELECT r.tainted, r.status,
           EXISTS (SELECT 1 FROM crove_kernel.kill_switch k
                   WHERE k.org_id = r.org_id AND (k.released_at IS NULL OR k.engaged_at > ${options.stoppedSince ?? null}::timestamptz)
                     AND (k.scope = 'org' OR (k.scope = 'module' AND k.target = ${seat.module}) OR (k.scope = 'agent' AND k.target = r.agent_id::text)))
             OR crove_kernel.global_kill_switch_on('ai') AS stopped
    FROM crove_kernel.ai_run r
    WHERE r.org_id = ${orgId}::uuid AND r.id = ${approver.runId}::uuid AND r.agent_id = ${approver.agentId}::uuid`.execute(trx);
  const run = runs[0];
  if (!run) return { reason: 'not_eligible', rule: 'P12' };
  if (run.tainted) return { reason: 'tainted_run', rule: 'P03' };
  if (run.status !== 'running' && run.status !== 'succeeded') return { reason: 'run_not_live', rule: 'P01' };
  if (run.stopped) return { reason: 'stopped', rule: 'P01' };

  const authors = parseAuthors(proposal.authors);
  if (authors === null) return { reason: 'not_eligible', rule: 'P12' };
  if (authors.some((a) => a.type === 'agent' && a.id === approver.agentId)) return { reason: 'author', rule: 'P10' };

  if (proposal.requested_by_agent === approver.agentId) return { reason: 'causal_chain', rule: 'causal_chain' };
  if (proposal.source_task_id) {
    const { rows } = await sql<{ in_chain: boolean }>`
      WITH RECURSIVE chain (id, assignee_position_id, created_by_type, created_by_id, parent_task_id, depth) AS (
        SELECT t.id, t.assignee_position_id, t.created_by_type, t.created_by_id, t.parent_task_id, 0
        FROM crove_kernel.task t WHERE t.org_id = ${orgId}::uuid AND t.id = ${proposal.source_task_id}::uuid
        UNION ALL
        SELECT t.id, t.assignee_position_id, t.created_by_type, t.created_by_id, t.parent_task_id, c.depth + 1
        FROM chain c JOIN crove_kernel.task t ON t.org_id = ${orgId}::uuid AND t.id = c.parent_task_id
        WHERE c.depth < 20
      )
      SELECT EXISTS (SELECT 1 FROM chain c
                     WHERE c.assignee_position_id = ${seat.position_id}::uuid
                        OR (c.created_by_type = 'agent' AND c.created_by_id = ${approver.agentId}::uuid)) AS in_chain`.execute(trx);
    if (rows[0]?.in_chain !== false) return { reason: 'causal_chain', rule: 'causal_chain' };
  }
  if (proposal.source_task_id || proposal.requested_by_agent) {
    // The asking agent's positions: the source task's assignee (where it asked from) and any it holds now, whatever
    // their status. One line in either direction refuses: a superior approving work of its report, or a report
    // approving work of its superior (who could route the review to it).
    const { rows } = await sql<{ same_line: boolean }>`
      WITH asker (pos) AS (
        SELECT t.assignee_position_id FROM crove_kernel.task t
        WHERE t.org_id = ${orgId}::uuid AND t.id = ${proposal.source_task_id}::uuid AND t.assignee_position_id IS NOT NULL
        UNION
        SELECT p.id FROM crove_kernel.position p WHERE p.org_id = ${orgId}::uuid AND p.holder_agent_id = ${proposal.requested_by_agent}::uuid
      )
      SELECT NOT EXISTS (SELECT 1 FROM asker)
             OR EXISTS (SELECT 1 FROM asker a
                        WHERE a.pos = ${seat.position_id}::uuid
                           OR crove_kernel.position_in_subtree(${orgId}::uuid, ${seat.position_id}::uuid, a.pos)
                           OR crove_kernel.position_in_subtree(${orgId}::uuid, a.pos, ${seat.position_id}::uuid)) AS same_line`.execute(trx);
    if (rows[0]?.same_line !== false) return { reason: 'reporting_line', rule: 'reporting_line' };
  }
  return { reason: 'ok' };
}
