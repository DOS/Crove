// Approval policy for proposals (plan §4.7 P10 and P12, §8.3). kernel.proposal.approve enforces it and
// kernel.inbox.get reports the same decision, so the Inbox shows Approve only to users the server accepts.
import type { Transaction } from 'kysely';
import { z } from 'zod';
import type { Database, MemberRole } from '@crove/db';
import type { Actor } from '@crove/kernel-runtime';

// Who produced (part of) a revision's content. Only user entries are humans; system entries (and, later,
// agents) never count as approvers or for four-eyes (ADR-0029 §6).
export const zActorRef = z.discriminatedUnion('type', [
  z.object({ type: z.literal('user'), id: z.uuid() }),
  z.object({ type: z.literal('system'), component: z.string() }),
]);
export type ActorRef = z.infer<typeof zActorRef>;

export function actorRef(actor: Actor): ActorRef {
  return actor.type === 'user' ? { type: 'user', id: actor.userId } : { type: 'system', component: actor.component };
}

export function parseAuthors(raw: unknown): ActorRef[] | null {
  const result = z.array(zActorRef).safeParse(raw);
  return result.success ? result.data : null;
}

const refKey = (a: ActorRef) => (a.type === 'user' ? `user:${a.id}` : `system:${a.component}`);

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

export interface ApprovalDecision {
  reason: ApproveReason;
  // Snapshot members who still hold an approving role now.
  eligibleCount: number;
  // The approver is an author and is allowed only because fewer than 2 eligible humans exist (P10).
  selfApproved: boolean;
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
  const deny = (reason: ApproveReason, eligibleCount = 0): ApprovalDecision => ({ reason, eligibleCount, selfApproved: false });
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
    .where('user_id', 'in', snapshot);
  if (options.lock) query = query.forShare();
  const live = await query.execute();
  // Eligible now: in the snapshot taken at creation AND still holding an approving role (re-checked live).
  const eligible = new Set(live.filter((m) => policy.roles.includes(m.role)).map((m) => m.user_id));
  if (!eligible.has(actor.userId)) return deny('not_eligible', eligible.size);

  const isAuthor = authors.some((a) => a.type === 'user' && a.id === actor.userId);
  if (isAuthor && policy.fourEyes && eligible.size >= 2) return deny('four_eyes', eligible.size);
  return { reason: 'ok', eligibleCount: eligible.size, selfApproved: isAuthor };
}

// Users of the org in context who may edit a pending proposal (an edit is R1; the approval stays R3).
export const EDITOR_ROLES: readonly MemberRole[] = ['owner', 'admin', 'member'];
