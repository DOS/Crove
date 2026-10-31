// SPDX-License-Identifier: AGPL-3.0-only
// The calendar sync (#2123) against a fake runtime and a fake adapter: when it renews a token, what it hands to the
// kernel, and how it ends a connection the provider refused. No database, no network.
import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { CalendarAdapter, CalendarWriteResult } from '@crove/channel';
import { busyPieces, cutOut } from '@crove/kernel';
import { calendarBinding } from '@crove/kernel-contract';
import { CredentialVault, DomainError, parseVaultKey, type Runtime } from '@crove/kernel-runtime';
import { runCalendarDisconnect, runCalendarSync, runCalendarWriteBack, syncCalendars } from '../src/calendar-sync.ts';

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

function fakeRuntime(state: { status: string; provider: string; expiresAt: string | null; updatedAt: string; writeBack?: boolean } | null, credential: unknown, plan: { actions: unknown[] } = { actions: [] }) {
  const calls: Call[] = [];
  const runtime = {
    query: async (name: string, input: Record<string, unknown>) => {
      calls.push({ kind: 'query', name, input });
      if (name === 'kernel.calendar.connection_state') return state;
      if (name === 'kernel.calendar.writeback_plan') return plan;
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

function adapter(over: Partial<CalendarAdapter> = {}): CalendarAdapter & { busyCalls: Array<{ secret: string; from: Date; to: Date }>; writes: string[] } {
  const busyCalls: Array<{ secret: string; from: Date; to: Date }> = [];
  const writes: string[] = [];
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
    writes,
    writeEvent: async (_secret, event): Promise<CalendarWriteResult> => (writes.push(`write ${event.externalId} ${event.summary} ${event.startsAt}`), { ok: true }),
    removeEvent: async (_secret, externalId): Promise<CalendarWriteResult> => (writes.push(`remove ${externalId}`), { ok: true }),
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

  // A runtime whose connection state answers in turn: the sync reads it once before the credential and once after.
  const turns = (states: Array<{ status: string; provider: string; expiresAt: string | null; updatedAt: string } | null>, credential: unknown, refreshed = true) => {
    const base = fakeRuntime(states[0] ?? null, credential);
    const inner = base.runtime as unknown as { query: (name: string, input: Record<string, unknown>) => Promise<unknown>; execute: (name: string, input: Record<string, unknown>) => Promise<unknown> };
    const baseQuery = inner.query.bind(inner);
    const baseExecute = inner.execute.bind(inner);
    let n = 0;
    inner.query = async (name, input) => {
      if (name !== 'kernel.calendar.connection_state') return baseQuery(name, input);
      base.calls.push({ kind: 'query', name, input });
      return states[Math.min(n++, states.length - 1)] ?? null;
    };
    inner.execute = async (name, input) => (name === 'kernel.calendar.refresh' ? (base.calls.push({ kind: 'execute', name, input }), { refreshed, ...(refreshed ? { updatedAt: '2026-11-03T05:30:00.000Z' } : {}) }) : baseExecute(name, input));
    return base;
  };

  it('does not sync with a token read for a connection that was disconnected or connected again in between', async () => {
    for (const second of [{ ...fresh, status: 'disconnecting' }, { ...fresh, updatedAt: '2026-11-03T05:10:00.000Z' }, null]) {
      const { runtime, calls } = turns([fresh, second], seal(SECRET));
      const a = adapter();
      expect(await run(runtime, a)).toEqual({ outcome: 'skipped', reason: 'changed' });
      expect(a.busyCalls).toEqual([]);
      expect(calls.some((c) => c.kind === 'execute')).toBe(false);
    }
  });

  it('revokes the pair a refresh made for a connection that was disconnected meanwhile, and leaves a reconnected one alone', async () => {
    const soon = { ...fresh, expiresAt: new Date(NOW.getTime() + 60_000).toISOString() };
    const revoked: string[] = [];
    const a = adapter({ revoke: async (secret) => (revoked.push(secret), { revoked: true }) });
    // The state reads: before the credential, after it, then after the refresh was refused (now disconnecting).
    const going = { ...soon, status: 'disconnecting' };
    const gone = turns([soon, soon, going], seal(SECRET), false);
    expect(await run(gone.runtime, a)).toEqual({ outcome: 'skipped', reason: 'changed' });
    expect(revoked).toEqual([JSON.stringify({ accessToken: 'a-2', refreshToken: 'r-1' })]);
    // The revoke follows the refused refresh, not the other way round.
    const order = gone.calls.map((c) => c.name);
    expect(order.indexOf('kernel.calendar.refresh')).toBeGreaterThan(-1);
    // A connection that is gone, or expired, has nothing to revoke: the purge or the finish already ran, or the grant is dead.
    for (const other of [null, { ...soon, status: 'expired' }]) {
      revoked.length = 0;
      const none = turns([soon, soon, other], seal(SECRET), false);
      expect(await run(none.runtime, a)).toEqual({ outcome: 'skipped', reason: 'changed' });
      expect(revoked).toEqual([]);
    }
    // Connected again instead: that connection's own grant is not touched.
    revoked.length = 0;
    const again = turns([soon, soon, { ...soon, updatedAt: '2026-11-03T05:20:00.000Z' }], seal(SECRET), false);
    expect(await run(again.runtime, a)).toEqual({ outcome: 'skipped', reason: 'changed' });
    expect(revoked).toEqual([]);
    // Disconnecting when read, then connected again while the revoke was out: that grant is gone too, so the connection is
    // expired at once, for the version it is at now.
    const reconnected = { ...soon, updatedAt: '2026-11-03T05:25:00.000Z' };
    const during = turns([soon, soon, going, reconnected], seal(SECRET), false);
    expect(await run(during.runtime, a)).toEqual({ outcome: 'skipped', reason: 'changed' });
    expect(during.calls.at(-1)).toMatchObject({ name: 'kernel.calendar.mark_failed', input: { status: 'expired', ifVersion: reconnected.updatedAt } });
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

describe('write-back in the sweep', () => {
  const on = { ...fresh, writeBack: true };
  const upsert = { eventId: 'e1', externalId: 'ext1ext1ext1', kind: 'upsert', summary: 'Tư vấn: Lan', startsAt: '2026-11-04T02:00:00.000Z', endsAt: '2026-11-04T03:00:00.000Z', hash: 'sha256:aaa' };
  const remove = { eventId: 'e2', externalId: 'ext2ext2ext2', kind: 'delete', summary: null, startsAt: null, endsAt: null, hash: 'deleted' };
  const records = (calls: Call[]) => calls.filter((c) => c.name === 'kernel.calendar.link.record').map((c) => ({ eventId: c.input.eventId, state: c.input.state, hash: c.input.syncedHash, error: c.input.error }));

  it('writes what is new or changed and deletes what was cancelled, records each, then reads the busy times', async () => {
    const { runtime, calls } = fakeRuntime(on, seal(SECRET), { actions: [upsert, remove] });
    const a = adapter();
    expect(await run(runtime, a)).toMatchObject({ outcome: 'synced' });
    expect(a.writes).toEqual(['write ext1ext1ext1 Tư vấn: Lan 2026-11-04T02:00:00.000Z', 'remove ext2ext2ext2']);
    expect(records(calls)).toEqual([
      { eventId: 'e1', state: 'written', hash: 'sha256:aaa', error: undefined },
      { eventId: 'e2', state: 'removed', hash: 'deleted', error: undefined },
    ]);
    // The writes and their records come before the busy read: a sweep never reads busy times holding an event it deletes.
    const names = calls.map((c) => c.name);
    expect(names.lastIndexOf('kernel.calendar.link.record')).toBeLessThan(names.indexOf('kernel.calendar.busy_replace'));
  });

  it('asks nothing when write-back is off', async () => {
    const { runtime, calls } = fakeRuntime(fresh, seal(SECRET), { actions: [upsert] });
    const a = adapter();
    expect(await run(runtime, a)).toMatchObject({ outcome: 'synced' });
    expect(a.writes).toEqual([]);
    expect(calls.some((c) => c.name === 'kernel.calendar.writeback_plan')).toBe(false);
  });

  it('records an event the member deleted by hand as removed, and a failure as an error, and still reads the busy times', async () => {
    const { runtime, calls } = fakeRuntime(on, seal(SECRET), { actions: [upsert, { ...upsert, eventId: 'e3', externalId: 'ext3ext3ext3' }] });
    let n = 0;
    const a = adapter({ writeEvent: async () => (++n === 1 ? { gone: true } : { failed: 'rateLimitExceeded' }) });
    expect(await run(runtime, a)).toMatchObject({ outcome: 'synced' });
    expect(records(calls)).toEqual([
      { eventId: 'e1', state: 'removed', hash: 'sha256:aaa', error: undefined },
      { eventId: 'e3', state: 'error', hash: 'sha256:aaa', error: 'rateLimitExceeded' },
    ]);
    expect(calls.some((c) => c.name === 'kernel.calendar.busy_replace')).toBe(true);
  });

  it('renews a refused token once and repeats the write; refused again, the connection expires', async () => {
    const first = fakeRuntime(on, seal(SECRET), { actions: [upsert] });
    let refusals = 1;
    const a = adapter({ writeEvent: async () => (refusals-- > 0 ? { refused: 'invalid_token' } : { ok: true }) });
    expect(await run(first.runtime, a)).toMatchObject({ outcome: 'synced' });
    expect(first.calls.filter((c) => c.name === 'kernel.calendar.refresh')).toHaveLength(1);
    expect(records(first.calls)).toEqual([{ eventId: 'e1', state: 'written', hash: 'sha256:aaa', error: undefined }]);
    const second = fakeRuntime(on, seal(SECRET), { actions: [upsert] });
    expect(await run(second.runtime, adapter({ writeEvent: async () => ({ refused: 'invalid_token' }) }))).toEqual({ outcome: 'expired', reason: 'invalid_token' });
    expect(second.calls.some((c) => c.name === 'kernel.calendar.busy_replace')).toBe(false);
  });

  it('stops sending the rest of the plan when the member switches write-back off, or disconnects, while it runs', async () => {
    for (const change of [{ writeBack: false }, { status: 'disconnecting' }]) {
      const live = { ...on };
      const { runtime, calls } = fakeRuntime(live, seal(SECRET), { actions: [upsert, { ...upsert, eventId: 'e3', externalId: 'ext3ext3ext3' }, remove] });
      const a = adapter({
        writeEvent: async (_secret, event) => {
          Object.assign(live, change);
          a.writes.push(`write ${event.externalId}`);
          return { ok: true };
        },
      });
      await run(runtime, a);
      // The first call was already out; the second and third never leave.
      expect(a.writes).toEqual(['write ext1ext1ext1']);
      expect(records(calls)).toEqual([{ eventId: 'e1', state: 'written', hash: 'sha256:aaa', error: undefined }]);
    }
  });

  it('leaves the rest of the batch for the next sweep on an outage or a limit, counting nothing, and still reads the busy times', async () => {
    const { runtime, calls } = fakeRuntime(on, seal(SECRET), { actions: [upsert, { ...upsert, eventId: 'e3', externalId: 'ext3ext3ext3' }, remove] });
    const a = adapter({
      writeEvent: async (_secret, event) => {
        a.writes.push(`write ${event.externalId}`);
        return { failed: 'UNAVAILABLE', transient: true };
      },
    });
    expect(await run(runtime, a)).toMatchObject({ outcome: 'synced' });
    expect(a.writes).toEqual(['write ext1ext1ext1']);
    expect(records(calls)).toEqual([]);
    expect(calls.some((c) => c.name === 'kernel.calendar.busy_replace')).toBe(true);
  });

  it('reads the busy times even when the write-back step itself throws', async () => {
    const { runtime, calls } = fakeRuntime(on, seal(SECRET), { actions: [upsert] });
    const failing = {
      ...runtime,
      query: async (name: string, input: Record<string, unknown>) => {
        if (name === 'kernel.calendar.writeback_plan') throw new Error('database blip');
        return (runtime as unknown as { query: (n: string, i: Record<string, unknown>) => Promise<unknown> }).query(name, input);
      },
    } as unknown as Runtime;
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await run(failing, adapter())).toMatchObject({ outcome: 'synced' });
    expect(calls.some((c) => c.name === 'kernel.calendar.busy_replace')).toBe(true);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('write-back failed'));
    spy.mockRestore();
  });

  it('leaves the write-back to the job that holds the connection\'s lock, and still reads the busy times', async () => {
    const { runtime, calls } = fakeRuntime(on, seal(SECRET), { actions: [upsert] });
    const a = adapter();
    const busy = async () => ({ ran: false as const });
    expect(await runCalendarSync({ runtime, broker: vault, adapters: { google_calendar: a }, now: () => NOW, lockConnection: busy }, { orgId: ORG, connectionId: CONNECTION })).toMatchObject({ outcome: 'synced' });
    expect(a.writes).toEqual([]);
    expect(calls.some((c) => c.name === 'kernel.calendar.writeback_plan')).toBe(false);
    expect(calls.some((c) => c.name === 'kernel.calendar.busy_replace')).toBe(true);
  });

  it('stops writing when the grant lacks the events permission, and the busy read goes on', async () => {
    const { runtime, calls } = fakeRuntime(on, seal(SECRET), { actions: [upsert, remove] });
    const a = adapter({ writeEvent: async () => ({ scope: true }) });
    expect(await run(runtime, a)).toMatchObject({ outcome: 'synced' });
    expect(a.writes).toEqual([]);
    expect(records(calls)).toEqual([]);
  });
});

describe('runCalendarWriteBack (the job a booking event queues)', () => {
  const on = { ...fresh, writeBack: true };
  const upsert = { eventId: 'e1', externalId: 'ext1ext1ext1', kind: 'upsert', summary: 'Tư vấn: Lan', startsAt: '2026-11-04T02:00:00.000Z', endsAt: '2026-11-04T03:00:00.000Z', hash: 'sha256:aaa' };
  const records = (calls: Call[]) => calls.filter((c) => c.name === 'kernel.calendar.link.record').map((c) => ({ connectionId: c.input.connectionId, eventId: c.input.eventId, state: c.input.state }));
  const CONN_B = '99999999-9999-4999-8999-999999999999';
  // The runtime the job sees: the org's write-back connections and a state for each; plan and credential as in the sweep tests.
  function jobRuntime(ids: string[], states: Record<string, unknown>, credential: unknown = seal(SECRET)) {
    const base = fakeRuntime(on, credential, { actions: [upsert] });
    const query = (base.runtime as unknown as { query: (n: string, i: Record<string, unknown>) => Promise<unknown> }).query;
    const runtime = {
      ...base.runtime,
      query: async (name: string, input: Record<string, unknown>) => {
        if (name === 'kernel.calendar.writeback_connections') return ids;
        if (name === 'kernel.calendar.connection_state') {
          base.calls.push({ kind: 'query', name, input });
          return states[String(input.connectionId)] ?? null;
        }
        return query(name, input);
      },
    } as unknown as Runtime;
    return { runtime, calls: base.calls };
  }
  const job = (rt: Runtime, a: CalendarAdapter) => runCalendarWriteBack({ runtime: rt, broker: vault, adapters: { google_calendar: a }, now: () => NOW }, { orgId: ORG });

  it('makes each write-back connection of the org match its bookings, with the token it has, and renews nothing', async () => {
    const { runtime, calls } = jobRuntime([CONNECTION, CONN_B], { [CONNECTION]: on, [CONN_B]: on });
    const a = adapter({ refresh: async () => Promise.reject(new Error('the job never renews')) });
    expect(await job(runtime, a)).toEqual({ connections: 2, ran: 2, busy: 0 });
    expect(a.writes).toEqual(['write ext1ext1ext1 Tư vấn: Lan 2026-11-04T02:00:00.000Z', 'write ext1ext1ext1 Tư vấn: Lan 2026-11-04T02:00:00.000Z']);
    expect(records(calls)).toEqual([
      { connectionId: CONNECTION, eventId: 'e1', state: 'written' },
      { connectionId: CONN_B, eventId: 'e1', state: 'written' },
    ]);
    // It reads no busy times: that is the sweep's.
    expect(calls.some((c) => c.name === 'kernel.calendar.busy_replace' || c.name === 'kernel.calendar.refresh')).toBe(false);
  });

  it('leaves a connection that is off, gone, without an adapter or with a token about to run out to the sweep', async () => {
    const soon = { ...on, expiresAt: new Date(NOW.getTime() + 60_000).toISOString() };
    const { runtime } = jobRuntime(['c-off', 'c-gone', 'c-soon', CONNECTION], { 'c-off': { ...on, writeBack: false }, 'c-soon': soon, [CONNECTION]: on });
    const a = adapter();
    expect(await job(runtime, a)).toEqual({ connections: 4, ran: 1, busy: 0 });
    expect(a.writes).toHaveLength(1);
    const { runtime: other } = jobRuntime([CONNECTION], { [CONNECTION]: { ...on, provider: 'microsoft' } });
    expect(await job(other, adapter())).toEqual({ connections: 1, ran: 0, busy: 0 });
  });

  it('does not renew or expire a connection whose token the provider refuses: the sweep does that', async () => {
    const { runtime, calls } = jobRuntime([CONNECTION], { [CONNECTION]: on });
    const a = adapter({ writeEvent: async () => ({ refused: 'invalid_token' }), refresh: async () => Promise.reject(new Error('the job never renews')) });
    expect(await job(runtime, a)).toEqual({ connections: 1, ran: 1, busy: 0 });
    expect(calls.some((c) => c.name === 'kernel.calendar.mark_failed' || c.name === 'kernel.calendar.refresh' || c.name === 'kernel.calendar.link.record')).toBe(false);
  });

  it('runs a connection\'s batch under that connection\'s lock, and counts one the sweep or another job holds as busy', async () => {
    const { runtime, calls } = jobRuntime([CONNECTION, CONN_B], { [CONNECTION]: on, [CONN_B]: on });
    const held: string[] = [];
    const a = adapter();
    const lockConnection = async <T,>(id: string, run: () => Promise<T>) => {
      if (id === CONN_B) return { ran: false as const };
      held.push(`lock ${id}`);
      const value = await run();
      held.push(`unlock ${id}`);
      return { ran: true as const, value };
    };
    expect(await runCalendarWriteBack({ runtime, broker: vault, adapters: { google_calendar: a }, now: () => NOW, lockConnection }, { orgId: ORG })).toEqual({ connections: 2, ran: 1, busy: 1 });
    // The write happened between the lock and its release; the busy connection was left alone.
    expect(held).toEqual([`lock ${CONNECTION}`, `unlock ${CONNECTION}`]);
    expect(records(calls)).toEqual([{ connectionId: CONNECTION, eventId: 'e1', state: 'written' }]);
  });

  it('goes on with the other connections when one fails', async () => {
    const { runtime, calls } = jobRuntime([CONNECTION, CONN_B], { [CONNECTION]: on, [CONN_B]: on });
    let n = 0;
    const a = adapter({ writeEvent: async () => (++n === 1 ? Promise.reject(new Error('socket hang up')) : { ok: true }) });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await job(runtime, a)).toEqual({ connections: 2, ran: 1, busy: 0 });
    expect(records(calls)).toEqual([{ connectionId: CONN_B, eventId: 'e1', state: 'written' }]);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('[calendar-writeback]'));
    spy.mockRestore();
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

  it('retries a disconnect while the server has no credential key, and removes it after the give-up time', async () => {
    const noKey = { ...vault, seal: vault.seal.bind(vault), open: () => { throw new DomainError('BROKER_NOT_CONFIGURED', 503, 'x'); }, id: 'none' } as unknown as typeof vault;
    const run = (rt: Runtime, at: Date) => runCalendarDisconnect({ runtime: rt, broker: noKey, adapters: { google_calendar: adapter() }, now: () => at }, { orgId: ORG, connectionId: CONNECTION });
    expect(await run(fakeRuntime(going, seal(SECRET)).runtime, NOW)).toEqual({ outcome: 'retry', reason: 'no_credential_key' });
    expect(await run(fakeRuntime(going, seal(SECRET)).runtime, new Date(NOW.getTime() + 4 * 86_400_000))).toEqual({ outcome: 'disconnected', revoked: false, reason: 'no_credential_key' });
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

describe('cutOut', () => {
  it('takes the time of written bookings out of the busy answer, also for bookings back to back, and keeps what lies outside them', () => {
    // Two bookings back to back come back from the provider as one block: both cuts remove it.
    expect(cutOut([{ start: 900, end: 1000 }], [{ start: 900, end: 930 }, { start: 930, end: 1000 }])).toEqual([]);
    // A genuine event under part of a booking keeps the part outside it, on either side.
    expect(cutOut([{ start: 885, end: 915 }, { start: 920, end: 960 }], [{ start: 900, end: 930 }])).toEqual([{ start: 885, end: 900 }, { start: 930, end: 960 }]);
    // A cut away from the answer changes nothing; touching is not overlapping.
    expect(cutOut([{ start: 100, end: 200 }], [{ start: 200, end: 300 }, { start: 0, end: 100 }])).toEqual([{ start: 100, end: 200 }]);
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
