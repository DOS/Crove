// Row locks shared by the membership commands (commands.ts and invites.ts).
import type { MemberRole } from '@crove/db';
import type { CommandContext } from '@crove/kernel-runtime';

export interface LockedMembers {
  actorRole: MemberRole | null;
  target: { role: MemberRole; email: string } | null;
  owners: number;
}

// Locks the rows a membership change decides on, in user_id order: every owner of the org, the actor and the
// target. Two owners changing each other at once serialize here; the one that waits re-reads the rows the other
// changed (READ COMMITTED re-checks a locked row's newest version), so it sees its own demotion or the smaller
// owner count and refuses. A row that became owner concurrently can only be missed, never counted twice, so the
// count errs on the side of refusing. RLS and the org_id filter keep other orgs' members out of reach.
export async function lockMembers(ctx: CommandContext, actorId: string, targetId: string): Promise<LockedMembers> {
  const rows = await ctx.trx
    .selectFrom('crove_kernel.tenant_member')
    .select(['user_id', 'role'])
    .where('org_id', '=', ctx.orgId)
    .where((eb) => eb.or([eb('role', '=', 'owner'), eb('user_id', 'in', [actorId, targetId])]))
    .orderBy('user_id')
    .forUpdate()
    .execute();
  const target = rows.find((r) => r.user_id === targetId);
  let email = '';
  if (target) {
    const account = await ctx.trx.selectFrom('crove_kernel.user_account').select('email').where('id', '=', targetId).executeTakeFirst();
    email = account?.email ?? '';
  }
  return {
    actorRole: rows.find((r) => r.user_id === actorId)?.role ?? null,
    target: target ? { role: target.role, email } : null,
    owners: rows.filter((r) => r.role === 'owner').length,
  };
}
