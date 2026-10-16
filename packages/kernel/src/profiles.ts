// Names and emails of org members for tenant code (issue #169, plan §3.6, Decision 14). user_account is a
// control-plane table: a tenant transaction never selects from it, it asks crove_kernel.member_profiles, which returns
// only members of the org in the sealed context. With a second cell that definer becomes a call to the control plane
// and these callers stay as they are.
import { sql, type Transaction } from 'kysely';
import type { Database } from '@crove/db';

export interface MemberProfile {
  userId: string;
  email: string;
  displayName: string | null;
}

// Profiles of the given users who are members of the org in context, keyed by user id. Anyone else (a former member,
// another org's user, an unknown id) is simply missing from the map.
export async function memberProfiles(trx: Transaction<Database>, userIds: readonly string[]): Promise<Map<string, MemberProfile>> {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return new Map();
  const { rows } = await sql<{ user_id: string; email: string; display_name: string | null }>`
    SELECT user_id, email, display_name FROM crove_kernel.member_profiles(${ids}::uuid[])`.execute(trx);
  return new Map(rows.map((r) => [r.user_id, { userId: r.user_id, email: r.email, displayName: r.display_name }]));
}
