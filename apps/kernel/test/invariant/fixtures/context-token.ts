// A context token for a user in an org (#1822, ADR-0028 section 9), signed with the test suites' key
// (CROVE_CONTEXT_TOKEN_KEY, vitest.invariant.config.ts), which the migration runner installs in every test database:
// what crove_kernel.enter_user_context takes to enter that user's context.
import type pg from 'pg';
import { mintContextToken } from '@crove/kernel-runtime';

export function contextToken(userId: string, orgId: string, claims: { sessionId?: string | null; aal?: 'aal1' | 'aal2'; mfaAt?: number | null } = {}): string {
  return mintContextToken(process.env.CROVE_CONTEXT_TOKEN_KEY ?? '', {
    userId,
    orgId,
    sessionId: claims.sessionId ?? null,
    aal: claims.aal ?? 'aal1',
    mfaAt: claims.mfaAt ?? null,
  });
}

// Enters a user's context on c: with a context token once the database has enter_user_context, through
// enter_context on a database migrated only up to a version before it (the upgrade tests).
export async function enterUser(c: pg.ClientBase, userId: string, orgId: string): Promise<void> {
  const { rows } = await c.query<{ tokens: boolean }>("SELECT to_regprocedure('crove_kernel.enter_user_context(uuid,text)') IS NOT NULL AS tokens");
  if (rows[0]?.tokens) await c.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [orgId, contextToken(userId, orgId)]);
  else await c.query('SELECT crove_kernel.enter_context($1::uuid, $2::uuid)', [userId, orgId]);
}
