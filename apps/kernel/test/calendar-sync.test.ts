// SPDX-License-Identifier: AGPL-3.0-only
// The calendar sync (#2123) against a fake runtime and a fake adapter: when it renews a token, what it hands to the
// kernel, and how it ends a connection the provider refused. No database, no network.
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { CalendarAdapter } from '@crove/channel';
import { busyPieces } from '@crove/kernel';
import { calendarBinding } from '@crove/kernel-contract';
import { CredentialVault, DomainError, parseVaultKey, type Runtime } from '@crove/kernel-runtime';
import { runCalendarSync } from '../src/calendar-sync.ts';

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
      if (name === 'kernel.calendar.refresh') return { refreshed: true };
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
      return { busy: [{ start: '2026-11-04T02:00:00.000Z', end: '2026-11-04T03:00:00.000Z' }] };
    },
    busyCalls,
    ...over,
  };
}

const fresh = { status: 'active', provider: 'google', expiresAt: new Date(NOW.getTime() + 3_600_000).toISOString(), updatedAt: '2026-11-03T05:00:00.123Z' };
const run = (rt: Runtime, a: CalendarAdapter) => runCalendarSync({ runtime: rt, broker: vault, adapters: { google_calendar: a }, now: () => NOW }, { orgId: ORG, connectionId: CONNECTION });

describe('runCalendarSync', () => {
  it('asks for the next 60 days from the start of the hour and replaces the blocks with the answer', async () => {
    const { runtime, calls } = fakeRuntime(fresh, seal(SECRET));
    const a = adapter();
    expect(await run(runtime, a)).toEqual({ outcome: 'synced', added: 2, removed: 1 });
    expect(a.busyCalls).toHaveLength(1);
    expect(a.busyCalls[0]?.secret).toBe(SECRET);
    expect(a.busyCalls[0]?.from.toISOString()).toBe('2026-11-03T05:00:00.000Z');
    expect(a.busyCalls[0]?.to.toISOString()).toBe('2027-01-02T05:00:00.000Z');
    const replace = calls.find((c) => c.name === 'kernel.calendar.busy_replace');
    expect(replace?.input).toEqual({ connectionId: CONNECTION, from: '2026-11-03T05:00:00.000Z', to: '2027-01-02T05:00:00.000Z', busy: [{ start: '2026-11-04T02:00:00.000Z', end: '2026-11-04T03:00:00.000Z' }] });
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
