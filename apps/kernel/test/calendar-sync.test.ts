// SPDX-License-Identifier: AGPL-3.0-only
// The calendar sync (#2123) against a fake runtime and a fake adapter: when it renews a token, what it hands to the
// kernel, and how it ends a connection the provider refused. No database, no network.
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { CalendarAdapter } from '@crove/channel';
import { busyPieces } from '@crove/kernel';
import { calendarBinding } from '@crove/kernel-contract';
import { CredentialVault, DomainError, parseVaultKey, type Runtime } from '@crove/kernel-runtime';
import { runCalendarDisconnect, runCalendarSync, syncCalendars } from '../src/calendar-sync.ts';

const ORG = '11111111-1111-4111-8111-111111111111';
const CONNECTION = '22222222-2222-4222-8222-222222222222';
const ACCOUNT = 'lan@gmail.test';
const NOW = new Date('2026-11-03T05:30:00Z');
const vault = new CredentialVault([parseVaultKey(randomBytes(32).toString('base64'))]);
const seal = (secret: string) => {
  const s = vault.seal(secret, calendarBinding(ORG, 'google', ACCOUNT));
  return { provider: 'google', externalAccount: ACCOUNT, keyId: s.keyId, envelope: s.envelope.toString('base64') };
};
const SECRET = JSON.stringify({ accessToken: 'a-1', refreshToken: 'r-1' });

interface Call {
  kind: 'query' | 'execute';
  name: string;
  input: Record<string, unknown>;
}

function fakeRuntime(state: { status: string; provider: string; expiresAt: string | null; updatedAt: string } | null, credential: unknown) {
  const calls: Call[] = [];
  const runtime = {
    query: async (name: string, input: Record<string, unknown>) => {
      calls.push({ kind: 'query', name, input });
      if (name === 'kernel.calendar.connection_state') return state;
      if (name === 'kernel.calendar.credential') {
        if (credential instanceof Error) throw credential;
        return credential;
      }
      throw new Error(`unexpected query ${name}`);
    },
    execute: async (name: string, input: Record<string, unknown>) => {
      calls.push({ kind: 'execute', name, input });
      if (name === 'kernel.calendar.busy_replace') return { replaced: true, added: 2, removed: 1 };
      if (name === 'kernel.calendar.refresh') return { refreshed: true, updatedAt: '2026-11-03T05:30:00.000Z' };
      if (name === 'kernel.calendar.finish_disconnect') return { finished: true };
      return { marked: true };
    },
  } as unknown as Runtime;
  return { runtime, calls };
}

function adapter(over: Partial<CalendarAdapter> = {}): CalendarAdapter & { busyCalls: Array<{ secret: string; from: Date; to: Date }> } {
  const busyCalls: Array<{ secret: string; from: Date; to: Date }> = [];
  return {
    provider: 'google',
    oauthProvider: 'google_calendar',
    pkce: true,
    authorizeUrl: () => 'https://example.test/',
    exchange: async () => {
      throw new Error('not used');
    },
    refresh: async () => ({ secret: JSON.stringify({ accessToken: 'a-2', refreshToken: 'r-1' }), expiresAt: new Date(NOW.getTime() + 3_600_000) }),
    busy: async (secret, from, to) => {
      busyCalls.push({ secret, from, to });
      // One interval, in the first piece of the year only.
      return { busy: busyCalls.length === 1 ? [{ start: '2026-11-04T02:00:00.000Z', end: '2026-11-04T03:00:00.000Z' }] : [] };
    },
    busyCalls,
    revoke: async (): Promise<{ revoked: true } | { revoked: false; reason: string } | { failed: string }> => ({ revoked: true }),
    ...over,
  };
}

const fresh = { status: 'active', provider: 'google', expiresAt: new Date(NOW.getTime() + 3_600_000).toISOString(), updatedAt: '2026-11-03T05:00:00.123Z' };
const run = (rt: Runtime, a: CalendarAdapter) => runCalendarSync({ runtime: rt, broker: vault, adapters: { google_calendar: a }, now: () => NOW }, { orgId: ORG, connectionId: CONNECTION });

describe('runCalendarSync', () => {
  it('asks for the next year from the start of the hour, in pieces, and replaces the blocks with the answer', async () => {
    const { runtime, calls } = fakeRuntime(fresh, seal(SECRET));
    const a = adapter();
    expect(await run(runtime, a)).toEqual({ outcome: 'synced', added: 2, removed: 1 });
    expect(a.busyCalls).toHaveLength(4);
    expect(a.busyCalls.map((c) => c.to.getTime() - c.from.getTime())).toEqual([100, 100, 100, 66].map((d) => d * 86_400_000));
    expect(a.busyCalls[0]?.secret).toBe(SECRET);
    expect(a.busyCalls[0]?.from.toISOString()).toBe('2026-11-03T05:00:00.000Z');
    expect(a.busyCalls.at(-1)?.to.toISOString()).toBe('2027-11-04T05:00:00.000Z');
    const replace = calls.find((c) => c.name === 'kernel.calendar.busy_replace');
    expect(replace?.input).toEqual({ connectionId: CONNECTION, from: '2026-11-03T05:00:00.000Z', to: '2027-11-04T05:00:00.000Z', busy: [{ start: '2026-11-04T02:00:00.000Z', end: '2026-11-04T03:00:00.000Z' }] });
    // A token with an hour left is not renewed.
    expect(calls.some((c) => c.name === 'kernel.calendar.refresh')).toBe(false);
  });

  it('renews a token that runs out within five minutes, seals the new pair, then syncs with it', async () => {
    const soon = { ...fresh, expiresAt: new Date(NOW.getTime() + 60_000).toISOString() };
    const { runtime, calls } = fakeRuntime(soon, seal(SECRET));
    const a = adapter();
    expect(await run(runtime, a)).toMatchObject({ outcome: 'synced' });
    const refresh = calls.find((c) => c.name === 'kernel.calendar.refresh');
    expect(refresh?.input).toMatchObject({ connectionId: CONNECTION, ifVersion: soon.updatedAt });
    const stored = refresh?.input.credential as { keyId: string; envelope: string };
    expect(JSON.parse(vault.open({ keyId: stored.keyId, envelope: Buffer.from(stored.envelope, 'base64') }, calendarBinding(ORG, 'google', ACCOUNT)))).toEqual({ accessToken: 'a-2', refreshToken: 'r-1' });
    expect(a.busyCalls[0]?.secret).toBe(JSON.stringify({ accessToken: 'a-2', refreshToken: 'r-1' }));
    // The sealed pair is stored before the busy call.
    expect(calls.findIndex((c) => c.name === 'kernel.calendar.refresh')).toBeLessThan(calls.findIndex((c) => c.name === 'kernel.calendar.busy_replace'));
  });

  it('expires a connection whose grant Google refused, on the refresh or on the busy call, and drops nothing else', async () => {
    const soon = { ...fresh, expiresAt: null };
    const onRefresh = fakeRuntime(soon, seal(SECRET));
    expect(await run(onRefresh.runtime, adapter({ refresh: async () => ({ refused: 'invalid_grant' }) }))).toEqual({ outcome: 'expired', reason: 'invalid_grant' });
    expect(onRefresh.calls.at(-1)).toMatchObject({ name: 'kernel.calendar.mark_failed', input: { status: 'expired', ifVersion: soon.updatedAt } });
    expect(onRefresh.calls.some((c) => c.name === 'kernel.calendar.busy_replace')).toBe(false);

    const onBusy = fakeRuntime(fresh, seal(SECRET));
    expect(await run(onBusy.runtime, adapter({ busy: async () => ({ refused: 'invalid_token' }) }))).toEqual({ outcome: 'expired', reason: 'invalid_token' });
    expect(onBusy.calls.at(-1)).toMatchObject({ name: 'kernel.calendar.mark_failed', input: { status: 'expired' } });
    expect(onBusy.calls.some((c) => c.name === 'kernel.calendar.busy_replace')).toBe(false);
  });

  it('expires only the version its own token belongs to: the renewed one after a renewal', async () => {
    const soon = { ...fresh, expiresAt: null };
    const { runtime, calls } = fakeRuntime(soon, seal(SECRET));
    expect(await run(runtime, adapter({ busy: async () => ({ refused: 'invalid_token' }) }))).toEqual({ outcome: 'expired', reason: 'invalid_token' });
    // The refresh stored a new version; the refusal names that one, so a reconnect since leaves the new connection alone.
    expect(calls.at(-1)).toMatchObject({ name: 'kernel.calendar.mark_failed', input: { status: 'expired', ifVersion: '2026-11-03T05:30:00.000Z' } });
    // Only one renewal: a token renewed at the start of the sync is not renewed again after a refusal.
    expect(calls.filter((c) => c.name === 'kernel.calendar.refresh')).toHaveLength(1);
  });

  it('renews a token once when Google refuses it mid-way, and syncs with the renewed one', async () => {
    const { runtime, calls } = fakeRuntime(fresh, seal(SECRET));
    let first = true;
    const a = adapter({
      busy: async (secret) => {
        if (first) {
          first = false;
          return { refused: 'invalid_token' };
        }
        return JSON.parse(secret).accessToken === 'a-2' ? { busy: [] } : { refused: 'still the old token' };
      },
    });
    expect(await run(runtime, a)).toEqual({ outcome: 'synced', added: 2, removed: 1 });
    expect(calls.filter((c) => c.name === 'kernel.calendar.refresh')).toHaveLength(1);
    expect(calls.some((c) => c.name === 'kernel.calendar.mark_failed')).toBe(false);
  });

  it('expires the connection when the renewal itself is refused after a refusal', async () => {
    const { runtime, calls } = fakeRuntime(fresh, seal(SECRET));
    const a = adapter({ busy: async () => ({ refused: 'invalid_token' }), refresh: async () => ({ refused: 'invalid_grant' }) });
    expect(await run(runtime, a)).toEqual({ outcome: 'expired', reason: 'invalid_grant' });
    expect(calls.at(-1)).toMatchObject({ name: 'kernel.calendar.mark_failed', input: { status: 'expired', ifVersion: fresh.updatedAt } });
  });

  it('merges the answer before storing it and notes an answer too large to store', async () => {
    const day = (n: number, h: number) => new Date(Date.parse('2026-11-04T00:00:00Z') + n * 86_400_000 + h * 3_600_000).toISOString();
    const { runtime, calls } = fakeRuntime(fresh, seal(SECRET));
    await run(
      runtime,
      adapter({
        busy: async () => ({
          busy: [
            { start: day(0, 2), end: day(0, 4) },
            { start: day(0, 3), end: day(0, 5) },
          ],
        }),
      }),
    );
    const replace = calls.find((c) => c.name === 'kernel.calendar.busy_replace');
    expect(replace?.input.busy).toHaveLength(1);
    // Thousands of separate intervals: more than a command takes, so the old blocks stay and the reason is noted.
    const many = fakeRuntime(fresh, seal(SECRET));
    const huge = Array.from({ length: 20_001 }, (_, i) => ({ start: new Date(Date.parse('2026-11-04T00:00:00Z') + i * 1_200_000).toISOString(), end: new Date(Date.parse('2026-11-04T00:00:00Z') + i * 1_200_000 + 600_000).toISOString() }));
    expect(await run(many.runtime, adapter({ busy: async (_s, f) => ({ busy: f.getTime() === Date.parse('2026-11-03T05:00:00Z') ? huge : [] }) }))).toEqual({ outcome: 'retry', reason: 'too_many_busy_intervals' });
    expect(many.calls.some((c) => c.name === 'kernel.calendar.busy_replace')).toBe(false);
  });

  it('notes a passing failure and leaves the connection active', async () => {
    const { runtime, calls } = fakeRuntime(fresh, seal(SECRET));
    expect(await run(runtime, adapter({ busy: async () => ({ failed: 'rateLimitExceeded' }) }))).toEqual({ outcome: 'retry', reason: 'rateLimitExceeded' });
    expect(calls.at(-1)).toMatchObject({ name: 'kernel.calendar.mark_failed', input: { status: 'retry', reason: 'sync failed (rateLimitExceeded)' } });
    expect(calls.some((c) => c.name === 'kernel.calendar.busy_replace')).toBe(false);
  });

  it('skips a connection that is gone, expired, without an adapter, or whose member left', async () => {
    const a = adapter();
    expect(await run(fakeRuntime(null, seal(SECRET)).runtime, a)).toEqual({ outcome: 'skipped', reason: 'not_active' });
    expect(await run(fakeRuntime({ ...fresh, status: 'expired' }, seal(SECRET)).runtime, a)).toEqual({ outcome: 'skipped', reason: 'not_active' });
    const none = await runCalendarSync({ runtime: fakeRuntime(fresh, seal(SECRET)).runtime, broker: vault, adapters: {}, now: () => NOW }, { orgId: ORG, connectionId: CONNECTION });
    expect(none).toEqual({ outcome: 'skipped', reason: 'no_adapter' });
    const left = new DomainError('CALENDAR_OWNER_LEFT', 409, 'x');
    expect(await run(fakeRuntime(fresh, left).runtime, a)).toEqual({ outcome: 'skipped', reason: 'CALENDAR_OWNER_LEFT' });
    expect(a.busyCalls).toEqual([]);
  });

  it('expires a connection whose token cannot be opened (another binding, or a key that is gone)', async () => {
    const other = vault.seal(SECRET, calendarBinding(ORG, 'google', 'someone-else@gmail.test'));
    const wrong = { provider: 'google', externalAccount: ACCOUNT, keyId: other.keyId, envelope: other.envelope.toString('base64') };
    const { runtime, calls } = fakeRuntime(fresh, wrong);
    expect(await run(runtime, adapter())).toEqual({ outcome: 'expired', reason: 'credential_unreadable' });
    expect(calls.at(-1)).toMatchObject({ name: 'kernel.calendar.mark_failed', input: { status: 'expired', reason: 'credential_unreadable' } });
  });
});

describe('runCalendarDisconnect', () => {
  const going = { status: 'disconnecting', provider: 'google', expiresAt: null, updatedAt: '2026-11-03T05:00:00.000Z' };
  const disconnect = (rt: Runtime, a: CalendarAdapter | null, now = NOW) =>
    runCalendarDisconnect({ runtime: rt, broker: vault, adapters: a ? { google_calendar: a } : {}, now: () => now }, { orgId: ORG, connectionId: CONNECTION });

  it('revokes the grant with the refresh token, then finishes the removal', async () => {
    const { runtime, calls } = fakeRuntime(going, seal(SECRET));
    let revokedWith = '';
    expect(await disconnect(runtime, adapter({ revoke: async (secret) => ((revokedWith = secret), { revoked: true }) }))).toEqual({ outcome: 'disconnected', revoked: true });
    expect(revokedWith).toBe(SECRET);
    // The version it saw goes along, so a reconnect since is noticed.
    expect(calls.at(-1)).toMatchObject({ name: 'kernel.calendar.finish_disconnect', input: { connectionId: CONNECTION, revoked: true, ifVersion: going.updatedAt } });
  });

  it('leaves a connection whose revoke failed for the next sweep, and gives up after three days', async () => {
    const { runtime, calls } = fakeRuntime(going, seal(SECRET));
    const failing = adapter({ revoke: async () => ({ failed: 'backendError' }) });
    expect(await disconnect(runtime, failing)).toEqual({ outcome: 'retry', reason: 'backendError' });
    expect(calls.some((c) => c.name === 'kernel.calendar.finish_disconnect')).toBe(false);
    const later = fakeRuntime(going, seal(SECRET));
    expect(await disconnect(later.runtime, failing, new Date(NOW.getTime() + 4 * 86_400_000))).toEqual({ outcome: 'disconnected', revoked: false, reason: 'revoke_failed' });
    expect(later.calls.at(-1)).toMatchObject({ name: 'kernel.calendar.finish_disconnect', input: { revoked: false, reason: 'revoke_failed' } });
  });

  it('finishes without a revoke only when there is no token, or one nothing can open, and says why', async () => {
    const gone = fakeRuntime(going, new DomainError('CALENDAR_NOT_FOUND', 404, 'x'));
    expect(await disconnect(gone.runtime, adapter())).toEqual({ outcome: 'disconnected', revoked: false, reason: 'no_credential' });
    const other = vault.seal(SECRET, calendarBinding(ORG, 'google', 'someone-else@gmail.test'));
    const wrong = fakeRuntime(going, { provider: 'google', externalAccount: ACCOUNT, keyId: other.keyId, envelope: other.envelope.toString('base64') });
    expect(await disconnect(wrong.runtime, adapter())).toEqual({ outcome: 'disconnected', revoked: false, reason: 'credential_unreadable' });
    const noToken = fakeRuntime(going, seal('not json'));
    expect(await disconnect(noToken.runtime, adapter({ revoke: async () => ({ revoked: false, reason: 'no_token' }) }))).toEqual({ outcome: 'disconnected', revoked: false, reason: 'no_token' });
  });

  it('does not finish on a passing database error: the grant is revoked at a later sweep', async () => {
    // Every error a query raises is a DomainError; only "not found" means there is no token.
    for (const error of [new DomainError('INTERNAL', 500, 'x'), new DomainError('OVERLOADED', 503, 'x'), new DomainError('CALENDAR_OWNER_LEFT', 409, 'x')]) {
      const { runtime, calls } = fakeRuntime(going, error);
      await expect(disconnect(runtime, adapter())).rejects.toBe(error);
      expect(calls.some((c) => c.name === 'kernel.calendar.finish_disconnect')).toBe(false);
    }
  });

  it('keeps a credential sealed with a key the server lacks until the give-up time', async () => {
    const stranger = new CredentialVault([parseVaultKey(randomBytes(32).toString('base64'))]);
    const s2 = stranger.seal(SECRET, calendarBinding(ORG, 'google', ACCOUNT));
    const unknown = { provider: 'google', externalAccount: ACCOUNT, keyId: s2.keyId, envelope: s2.envelope.toString('base64') };
    expect(await disconnect(fakeRuntime(going, unknown).runtime, adapter())).toEqual({ outcome: 'retry', reason: 'unknown_key' });
    expect(await disconnect(fakeRuntime(going, unknown).runtime, adapter(), new Date(NOW.getTime() + 4 * 86_400_000))).toEqual({ outcome: 'disconnected', revoked: false, reason: 'credential_unreadable' });
  });

  it('counts a finish the kernel did not make as skipped, not as a disconnect', async () => {
    const { runtime } = fakeRuntime(going, seal(SECRET));
    (runtime as unknown as { execute: () => Promise<unknown> }).execute = async () => ({ finished: false });
    expect(await disconnect(runtime, adapter())).toEqual({ outcome: 'skipped', reason: 'changed' });
  });

  it('keeps trying while the app credentials are off the server, and touches only a disconnecting connection', async () => {
    expect(await disconnect(fakeRuntime(going, seal(SECRET)).runtime, null)).toEqual({ outcome: 'retry', reason: 'no_adapter' });
    expect(await disconnect(fakeRuntime(going, seal(SECRET)).runtime, null, new Date(NOW.getTime() + 4 * 86_400_000))).toEqual({ outcome: 'disconnected', revoked: false, reason: 'no_adapter' });
    const active = fakeRuntime(fresh, seal(SECRET));
    expect(await disconnect(active.runtime, adapter())).toEqual({ outcome: 'skipped', reason: 'not_disconnecting' });
    expect(active.calls.some((c) => c.kind === 'execute')).toBe(false);
    expect(await disconnect(fakeRuntime(null, seal(SECRET)).runtime, adapter())).toEqual({ outcome: 'skipped', reason: 'not_disconnecting' });
  });
});

describe('busyPieces', () => {
  const H = 3_600_000;
  const D = 24 * H;
  it('clips to the window, drops empty intervals, merges overlapping and touching ones', () => {
    expect(
      busyPieces(
        [
          { start: -5 * H, end: 2 * H },
          { start: 1 * H, end: 3 * H },
          { start: 3 * H, end: 4 * H },
          { start: 6 * H, end: 6 * H },
          { start: 9 * H, end: 20 * H },
          { start: 30 * H, end: 40 * H },
        ],
        0,
        10 * H,
      ),
    ).toEqual([
      { start: 0, end: 4 * H },
      { start: 9 * H, end: 10 * H },
    ]);
  });

  it('cuts an interval longer than 30 days into pieces of at most 30 days', () => {
    expect(busyPieces([{ start: 0, end: 70 * D }], 0, 90 * D)).toEqual([
      { start: 0, end: 30 * D },
      { start: 30 * D, end: 60 * D },
      { start: 60 * D, end: 70 * D },
    ]);
  });
});

describe('syncCalendars', () => {
  const exclusive = async <T>(run: () => Promise<T>) => ({ ran: true as const, value: await run() });
  const row = (provider = 'google') => ({ orgId: ORG, connectionId: CONNECTION, provider });
  const sweep = (rt: Runtime, adapters: Record<string, CalendarAdapter>, rows = [row()]) =>
    syncCalendars({ runtime: rt, broker: vault, workerDb: null as never, adapters, exclusive, listDue: async (after) => (after ? [] : rows), now: () => NOW });

  it('finishes a disconnect with no adapter on the server, and leaves an active connection alone', async () => {
    const going = { status: 'disconnecting', provider: 'google', expiresAt: null, updatedAt: new Date(NOW.getTime() - 4 * 86_400_000).toISOString() };
    const old = fakeRuntime(going, seal(SECRET));
    expect(await sweep(old.runtime, {})).toMatchObject({ disconnected: 1, synced: 0 });
    expect(old.calls.at(-1)).toMatchObject({ name: 'kernel.calendar.finish_disconnect', input: { revoked: false, reason: 'no_adapter' } });
    const active = fakeRuntime(fresh, seal(SECRET));
    expect(await sweep(active.runtime, {})).toMatchObject({ skipped: 1, disconnected: 0, synced: 0 });
    expect(active.calls.some((c) => c.kind === 'execute')).toBe(false);
  });

  it('syncs the active ones and revokes the disconnecting ones, whichever the list holds', async () => {
    const a = adapter();
    const sync = fakeRuntime(fresh, seal(SECRET));
    expect(await sweep(sync.runtime, { google_calendar: a })).toMatchObject({ synced: 1, disconnected: 0 });
    const going = fakeRuntime({ status: 'disconnecting', provider: 'google', expiresAt: null, updatedAt: NOW.toISOString() }, seal(SECRET));
    expect(await sweep(going.runtime, { google_calendar: a })).toMatchObject({ synced: 0, disconnected: 1 });
    expect(a.busyCalls.length).toBeGreaterThan(0);
  });

  it('counts a failing connection as a retry and goes on', async () => {
    const boom = new DomainError('INTERNAL', 500, 'x');
    const failing = fakeRuntime({ status: 'disconnecting', provider: 'google', expiresAt: null, updatedAt: NOW.toISOString() }, boom);
    expect(await sweep(failing.runtime, { google_calendar: adapter() })).toMatchObject({ retry: 1, disconnected: 0 });
  });
});
