// A context token for a user in an org (#1822, ADR-0028 section 9), signed with the test suites' key
// (CROVE_CONTEXT_TOKEN_KEY, vitest.config.ts), which the migration runner installs in every test database: what
// crove_kernel.enter_user_context takes to enter that user's context.
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
