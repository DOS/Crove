// Routing of a user's own revoke sent without an org (issues #184 and #196), with a fake runtime: which org runs the
// audited command, when an org is skipped, and when the org-less definer runs. The database side is covered by
// test/invariant/sessions-orgless.db.test.ts.
import { describe, expect, it } from 'vitest';
import { revokeOwnSessionsWithoutOrg } from '@crove/kernel';
import { DomainError, type Runtime, type UserActor } from '@crove/kernel-runtime';

const USER = '0198a3a0-0000-7000-8000-000000000001';
const SESSION = '0198a3a0-0000-7000-8000-0000000000aa';
const ORG_A = '0198a3a0-0000-7000-8000-00000000000a';
const ORG_B = '0198a3a0-0000-7000-8000-00000000000b';
const actor: UserActor = { type: 'user', userId: USER, aal: 'aal1', sessionId: SESSION, mfaAt: null };
const input = { userId: USER, sessionId: SESSION };

// forUser answers from a script: an org list for the my_orgs lookup, then a result or an error for the definer call.
function fakeRuntime(script: Array<unknown>, execute: (orgId: string) => unknown) {
  const calls: string[] = [];
  const runtime = {
    forUser: async () => {
      const next = script.shift();
      if (next instanceof Error) {
        calls.push('orgless:refused');
        throw next;
      }
      calls.push(Array.isArray(next) ? 'orgs' : 'orgless');
      return next;
    },
    execute: async (_name: string, _input: unknown, options: { orgId: string }) => {
      calls.push(`execute:${options.orgId}`);
      return execute(options.orgId);
    },
  } as unknown as Runtime;
  return { runtime, calls };
}

const orgs = (...ids: string[]) => ids.map((orgId) => ({ orgId, slug: orgId.slice(-1), name: orgId, role: 'member' }));

describe('revokeOwnSessionsWithoutOrg', () => {
  it('runs the audited command in the oldest org that can run it', async () => {
    const { runtime, calls } = fakeRuntime([orgs(ORG_A, ORG_B)], (orgId) => {
      if (orgId === ORG_A) throw new DomainError('UNAUTHENTICATED', 401, 'revoked in this org');
      return { revoked: [SESSION] };
    });
    await expect(revokeOwnSessionsWithoutOrg(runtime, actor, input)).resolves.toEqual({ revoked: [SESSION] });
    expect(calls).toEqual(['orgs', `execute:${ORG_A}`, `execute:${ORG_B}`]);
  });

  it('falls back to the org-less definer when the user left every listed org mid-request', async () => {
    const { runtime, calls } = fakeRuntime([orgs(ORG_A), { revoked: [SESSION] }], () => {
      throw new DomainError('NOT_A_MEMBER', 403, 'left');
    });
    await expect(revokeOwnSessionsWithoutOrg(runtime, actor, input)).resolves.toEqual({ revoked: [SESSION] });
    expect(calls).toEqual(['orgs', `execute:${ORG_A}`, 'orgless']);
  });

  it('retries in the org the user joined mid-request', async () => {
    const joined = new DomainError('ORG_REQUIRED', 409, 'joined');
    const { runtime, calls } = fakeRuntime([orgs(), joined, orgs(ORG_A)], () => ({ revoked: [SESSION] }));
    await expect(revokeOwnSessionsWithoutOrg(runtime, actor, input)).resolves.toEqual({ revoked: [SESSION] });
    expect(calls).toEqual(['orgs', 'orgless:refused', 'orgs', `execute:${ORG_A}`]);
  });

  it('answers RETRY after two passes that both find a new org', async () => {
    const joined = () => new DomainError('ORG_REQUIRED', 409, 'joined');
    const { runtime } = fakeRuntime([orgs(), joined(), orgs(), joined()], () => ({ revoked: [] }));
    await expect(revokeOwnSessionsWithoutOrg(runtime, actor, input)).rejects.toMatchObject({ code: 'RETRY', status: 409 });
  });

  it('passes any other refusal through, and refuses another user without an org', async () => {
    const { runtime, calls } = fakeRuntime([orgs(ORG_A, ORG_B)], () => {
      throw new DomainError('FORBIDDEN', 403, 'no');
    });
    await expect(revokeOwnSessionsWithoutOrg(runtime, actor, input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(calls).toEqual(['orgs', `execute:${ORG_A}`]);

    const other = fakeRuntime([], () => ({ revoked: [] }));
    await expect(
      revokeOwnSessionsWithoutOrg(other.runtime, actor, { userId: '0198a3a0-0000-7000-8000-000000000002', all: true }),
    ).rejects.toMatchObject({ code: 'ORG_REQUIRED', status: 400 });
    expect(other.calls).toEqual([]);
  });
});
