// The multi-client home screen's fan-out (issue #318) with a fake runtime: each org's figures are read by
// kernel.org.overview in that org (runtime.query with its orgId), never in another; an org the user can no longer read
// is left out; any other failure of one org is an error row (#495), and a refusal of the user fails the answer. The
// database side is in clients.db.test.ts and clients-social.db.test.ts.
import { describe, expect, it } from 'vitest';
import { MAX_CLIENT_ORGS, clientOverviews, type OrgOverview } from '@crove/kernel';
import { DomainError, type Runtime, type UserActor } from '@crove/kernel-runtime';

const USER = '0198a3a0-0000-7000-8000-000000000001';
const actor: UserActor = { type: 'user', userId: USER, aal: 'aal1', sessionId: '0198a3a0-0000-7000-8000-0000000000aa', mfaAt: null };
const org = (n: number) => ({ orgId: `0198a3a0-0000-7000-8000-${String(n).padStart(12, '0')}`, slug: `org-${n}`, name: `Org ${n}`, role: 'member' as const });
const figures = (n: number): OrgOverview => ({ pendingProposals: n, failedFiles: 0, lastActivityAt: null, vatFilingPeriod: null, vatDeadline: null, taxDues: [], modules: {} });

function fakeRuntime(orgs: ReturnType<typeof org>[], query: (orgId: string) => OrgOverview) {
  const calls: Array<{ name: string; orgId: string; userId: string }> = [];
  let inFlight = 0;
  let peak = 0;
  const runtime = {
    forUser: async () => orgs,
    query: async (name: string, _input: unknown, options: { actor: UserActor; orgId: string }) => {
      calls.push({ name, orgId: options.orgId, userId: options.actor.userId });
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return query(options.orgId);
    },
  } as unknown as Runtime;
  return { runtime, calls, peak: () => peak };
}

describe('clientOverviews', () => {
  it("reads each org's figures in that org, as the caller, keeping the list's order", async () => {
    const orgs = [org(1), org(2), org(3)];
    const { runtime, calls } = fakeRuntime(orgs, (orgId) => figures(Number(orgId.slice(-1))));
    const { clients: rows, total } = await clientOverviews(runtime, actor);
    expect(total).toBe(3);
    expect(rows.map((r) => [r.slug, r.overview?.pendingProposals, r.error])).toEqual([
      ['org-1', 1, null],
      ['org-2', 2, null],
      ['org-3', 3, null],
    ]);
    expect(calls).toHaveLength(3);
    for (const call of calls) expect(call).toMatchObject({ name: 'kernel.org.overview', userId: USER });
    expect(calls.map((c) => c.orgId).sort()).toEqual(orgs.map((o) => o.orgId).sort());
  });

  it('leaves out an org the user left, or whose owner revoked this session there, since the list was read', async () => {
    const { runtime } = fakeRuntime([org(1), org(2), org(3)], (orgId) => {
      if (orgId.endsWith('1')) throw new DomainError('NOT_A_MEMBER', 403, 'left');
      if (orgId.endsWith('2')) throw new DomainError('SESSION_REVOKED_IN_ORG', 401, 'revoked');
      return figures(3);
    });
    expect((await clientOverviews(runtime, actor)).clients.map((r) => r.slug)).toEqual(['org-3']);
  });

  it('shows an org that fails as an error row with its code, and the other orgs as usual (#495)', async () => {
    const { runtime } = fakeRuntime([org(1), org(2), org(3)], (orgId) => {
      if (orgId.endsWith('2')) throw new DomainError('STATEMENT_TIMEOUT', 503, 'slow');
      if (orgId.endsWith('3')) throw new Error('connection reset');
      return figures(1);
    });
    const error = console.error;
    console.error = () => undefined;
    try {
      const { clients: rows, total } = await clientOverviews(runtime, actor);
      expect(total).toBe(3);
      expect(rows.map((r) => [r.slug, r.overview?.pendingProposals ?? null, r.error])).toEqual([
        ['org-1', 1, null],
        ['org-2', null, 'STATEMENT_TIMEOUT'],
        ['org-3', null, 'INTERNAL'],
      ]);
    } finally {
      console.error = error;
    }
  });

  it('fails the answer when the user themselves is refused, since every org would refuse them', async () => {
    const { runtime } = fakeRuntime([org(1), org(2)], (orgId) => {
      if (orgId.endsWith('2')) throw new DomainError('SESSION_REVOKED', 401, 'signed out');
      return figures(1);
    });
    await expect(clientOverviews(runtime, actor)).rejects.toMatchObject({ code: 'SESSION_REVOKED' });
  });

  it('reads a few orgs at a time and at most MAX_CLIENT_ORGS, and says how many the user has (#495)', async () => {
    const orgs = Array.from({ length: MAX_CLIENT_ORGS + 5 }, (_, i) => org(i + 1));
    const { runtime, calls, peak } = fakeRuntime(orgs, () => figures(0));
    const { clients: rows, total } = await clientOverviews(runtime, actor);
    expect(rows).toHaveLength(MAX_CLIENT_ORGS);
    expect(total).toBe(MAX_CLIENT_ORGS + 5);
    expect(calls).toHaveLength(MAX_CLIENT_ORGS);
    expect(peak()).toBeLessThanOrEqual(4);
    expect(peak()).toBeGreaterThan(1);
  });

  it('starts no other org once the answer fails (#495)', async () => {
    const orgs = Array.from({ length: 40 }, (_, i) => org(i + 1));
    const { runtime, calls } = fakeRuntime(orgs, (orgId) => {
      if (orgId.endsWith('000000000001')) throw new DomainError('UNAUTHENTICATED', 401, 'signed out');
      return figures(0);
    });
    // The answer fails only once the calls already running have finished, so this count is final: the first four
    // started together, and nothing new starts after the failure.
    await expect(clientOverviews(runtime, actor)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    const settled = calls.length;
    expect(settled).toBeLessThanOrEqual(4);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls.length).toBe(settled);
  });

  it('starts no other org once the client went away (#495)', async () => {
    const orgs = Array.from({ length: 40 }, (_, i) => org(i + 1));
    const controller = new AbortController();
    const { runtime, calls } = fakeRuntime(orgs, () => {
      controller.abort();
      return figures(0);
    });
    await expect(clientOverviews(runtime, actor, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls.length).toBeLessThanOrEqual(4);
  });
});
