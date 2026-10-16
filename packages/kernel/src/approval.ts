// Approval policy for proposals (plan §4.7 P10 and P12, §8.3). kernel.proposal.approve enforces it and
// kernel.inbox.get reports the same decision, so the Inbox shows Approve only to users the server accepts.
import type { Transaction } from 'kysely';
import { z } from 'zod';
import type { Database, MemberRole } from '@crove/db';
import type { Actor, QueryContext } from '@crove/kernel-runtime';

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
  // Roles whose holders may approve the command (P12).
  roles: readonly MemberRole[];
  // Four-eyes (P10) applies to R3 commands.
  fourEyes: boolean;
}

// Approval policy per proposal command. Every proposal command today is R3 and posts to the ledger, so only
// the roles that may post approve (#71). Seam: once role_assignment exists (§4.6), eligibility becomes "holds
// the command's approval permission and the proposal's legal-entity scope", read here instead of the role.
const POLICIES: Record<string, CommandPolicy> = {
  'finance.purchase.record': { roles: ['owner', 'admin'], fourEyes: true },
  // A reversal is itself a posting (#138): the same roles approve it, with four-eyes.
  'finance.journal.reverse': { roles: ['owner', 'admin'], fourEyes: true },
};

const NOBODY: CommandPolicy = { roles: [], fourEyes: true };

function policyFor(command: string): CommandPolicy {
  return POLICIES[command] ?? NOBODY;
}

// The humans who may approve `command` in the org in context right now (the P12 snapshot taken at creation).
// tenant_member rows are humans; agents will never be in this list.
export async function eligibleApprovers(trx: Transaction<Database>, orgId: string, command: string): Promise<string[]> {
  const { roles } = policyFor(command);
  if (roles.length === 0) return [];
  const rows = await trx
    .selectFrom('crove_kernel.tenant_member')
    .select('user_id')
    .where('org_id', '=', orgId)
    .where('role', 'in', roles)
    .orderBy('user_id')
    .execute();
  return rows.map((r) => r.user_id);
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
  if (policy.roles.length === 0) return deny('not_eligible');
  let query = trx
    .selectFrom('crove_kernel.tenant_member')
    .select(['user_id', 'role'])
    .where('org_id', '=', orgId)
    .where('user_id', 'in', snapshot)
    // user_id order, as membership changes lock, so the two never take the same rows in opposite orders.
    .orderBy('user_id');
  if (options.lock) query = query.forShare();
  const live = await query.execute();
  // Eligible now: in the snapshot taken at creation AND still holding an approving role (re-checked live). The
  // snapshot is never rewritten; this filter is what keeps it current. A removed approver has no row and a demoted
  // one no approving role, so neither is eligible nor counts toward the two that four-eyes (P10) needs.
  const eligible = new Set(live.filter((m) => policy.roles.includes(m.role)).map((m) => m.user_id));
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
