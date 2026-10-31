// SPDX-License-Identifier: AGPL-3.0-only
// A connected outside calendar's sync (issue #2123, part of #1374), run by the worker as the system. The credential is
// opened here and nowhere else: the API only seals it (ADR-0025). A sync renews the access token when it is about to
// run out, asks the provider for the busy times of the next year and replaces the connection's busy blocks with them
// (kernel.calendar.busy_replace). Only start and end instants cross: no title, no attendee.
// A provider that refuses the grant (the member revoked the app) expires the connection, which drops the dead token;
// the member reconnects. A refusal of the access token alone is first answered by renewing it once. Any other failure
// leaves the connection active with the reason noted, and the next sweep, 15 minutes later, tries again. The blocks of
// a failing connection stay: a stale block withholds a slot, it never frees one that may be busy.
import { CALENDAR_SYNC_DAYS, calendarBinding, type CalendarProvider } from '@crove/kernel-contract';
import type { CalendarAdapter } from '@crove/channel';
import { sql } from 'kysely';
import type { Db } from '@crove/db';
import { CredentialError, DomainError, type CredentialBroker, type Runtime, type SystemActor } from '@crove/kernel-runtime';
import { busyPieces, type SealedCalendarCredential, type WriteBackAction } from '@crove/kernel';

const ACTOR: SystemActor = { type: 'system', component: 'kernel.calendar.sync' };
export const CALENDAR_SYNC_SWEEP_MS = 15 * 60_000;
// Renew an access token that runs out within this long: a sync runs every 15 minutes, so one that is about to expire
// is renewed before the call and never goes out with a dead token.
const REFRESH_AHEAD_MS = 5 * 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
// One free/busy request spans at most this many days.
const CHUNK_DAYS = 100;
// More merged busy intervals than the kernel command takes in one answer: the sync notes it and keeps the old blocks.
const MAX_BUSY = 20_000;

export interface CalendarSyncJob {
  orgId: string;
  connectionId: string;
}

// Runs a function while no other worker process or job holds the connection's write-back (a session advisory lock on the worker's
// database, taken in worker.ts); { ran: false } when another one does.
export type ConnectionLock = <T>(connectionId: string, run: () => Promise<T>) => Promise<{ ran: true; value: T } | { ran: false }>;

export interface CalendarSyncDeps {
  runtime: Runtime;
  broker: CredentialBroker;
  // Serializes the write-back of one connection between the sweep and the booking-event job (and two jobs); none in tests.
  lockConnection?: ConnectionLock;
  // The adapters this deployment offers, by OAuth provider id.
  adapters: Readonly<Partial<Record<string, CalendarAdapter>>>;
  now?: () => Date;
}

// A booking's event handed over by the outbox relay: the write-back of the org's connections (runCalendarWriteBack).
export interface CalendarWriteBackJob {
  orgId: string;
}

export type CalendarSyncOutcome = { outcome: 'synced'; added: number; removed: number } | { outcome: 'skipped' | 'expired' | 'retry'; reason: string };

// A page of the active calendar connections of active orgs after a key (crove_kernel.calendar_sync_due, the worker
// login's alone), for the 15 minute sweep.
export const CALENDAR_SYNC_PAGE = 1000;
export async function calendarSyncDue(
  workerDb: Db,
  after: { orgId: string; connectionId: string } | null,
): Promise<Array<{ orgId: string; connectionId: string; provider: string }>> {
  const { rows } = await sql<{ org_id: string; connection_id: string; provider: string }>`
    SELECT org_id, connection_id, provider FROM crove_kernel.calendar_sync_due(${after?.orgId ?? null}::uuid, ${after?.connectionId ?? null}::uuid, ${CALENDAR_SYNC_PAGE}::int)`.execute(workerDb);
  return rows.map((r) => ({ orgId: r.org_id, connectionId: r.connection_id, provider: r.provider }));
}

const withConnectionLock = <T>(deps: CalendarSyncDeps, connectionId: string, run: () => Promise<T>) => (deps.lockConnection ? deps.lockConnection(connectionId, run) : run().then((value) => ({ ran: true as const, value })));

const adapterFor = (adapters: CalendarSyncDeps['adapters'], provider: string): CalendarAdapter | undefined => Object.values(adapters).find((a) => a?.provider === provider);

// A disconnecting connection the provider kept refusing to revoke for this long is removed anyway: the token is useless to
// us from then on, and the member can take the grant away in their account (the audit row says it was not revoked).
const REVOKE_GIVE_UP_MS = 3 * DAY_MS;

export type CalendarDisconnectOutcome = { outcome: 'disconnected'; revoked: boolean; reason?: string } | { outcome: 'skipped' | 'retry'; reason: string };

// The errors a credential read answers with when there is nothing to revoke with: the member's connection is gone or has no
// token. Any other error (a statement timeout, a lock, a reset connection) is a passing failure: the next sweep tries again.
const NO_TOKEN_CODES = new Set(['CALENDAR_NOT_FOUND']);
// A credential sealed with a key this server no longer has (a rotation that dropped it too early) may come back with the
// key; every other CredentialError is a damaged envelope or another binding, which no retry opens.
const UNKNOWN_KEY = 'credential sealed with an unknown key';

// Finishes a disconnect the member asked for: revokes the grant at the provider with the token only the worker can open,
// then removes the connection and its sealed token (kernel.calendar.finish_disconnect). A provider that cannot be reached
// is tried again at the next sweep, for three days. The credential is handed out for a disconnecting connection whatever
// became of its member (left, demoted, disabled): the revoke is the one use it has there.
export async function runCalendarDisconnect(deps: CalendarSyncDeps, job: CalendarSyncJob): Promise<CalendarDisconnectOutcome> {
  const options = { actor: ACTOR, orgId: job.orgId };
  const now = deps.now ?? (() => new Date());
  const state = await deps.runtime.query<{ status: string; provider: string; updatedAt: string } | null>('kernel.calendar.connection_state', { connectionId: job.connectionId }, options);
  if (!state || state.status !== 'disconnecting') return { outcome: 'skipped', reason: 'not_disconnecting' };
  return disconnectSeen(deps, job, state, now);
}

async function disconnectSeen(deps: CalendarSyncDeps, job: CalendarSyncJob, state: { provider: string; updatedAt: string }, now: () => Date): Promise<CalendarDisconnectOutcome> {
  const options = { actor: ACTOR, orgId: job.orgId };
  const expired = now().getTime() - Date.parse(state.updatedAt) > REVOKE_GIVE_UP_MS;
  // ifVersion: the version this disconnect saw. A member who connected the same account again since has a newer one, and
  // a revoke of the old grant also ends the new one: the kernel then expires that connection for them to connect again.
  const finish = async (revoked: boolean, reason?: string): Promise<CalendarDisconnectOutcome> => {
    const done = await deps.runtime.execute<{ finished: boolean }>('kernel.calendar.finish_disconnect', { connectionId: job.connectionId, revoked, ifVersion: state.updatedAt, ...(reason ? { reason } : {}) }, options);
    if (!done.finished) return { outcome: 'skipped', reason: 'changed' };
    return { outcome: 'disconnected', revoked, ...(reason ? { reason } : {}) };
  };
  const adapter = adapterFor(deps.adapters, state.provider);
  let sealed: SealedCalendarCredential;
  try {
    sealed = await deps.runtime.query<SealedCalendarCredential>('kernel.calendar.credential', { connectionId: job.connectionId }, options);
  } catch (error) {
    if (error instanceof DomainError && NO_TOKEN_CODES.has(error.code)) return finish(false, 'no_credential');
    throw error;
  }
  if (!adapter) {
    // The app credentials were removed from this server: the revoke cannot be made; keep trying until the give-up time.
    return expired ? finish(false, 'no_adapter') : { outcome: 'retry', reason: 'no_adapter' };
  }
  let secret: string;
  try {
    secret = deps.broker.open({ keyId: sealed.keyId, envelope: Buffer.from(sealed.envelope, 'base64') }, calendarBinding(job.orgId, sealed.provider as CalendarProvider, sealed.externalAccount));
  } catch (error) {
    // No credential key on the server at all (the key and its file removed, the Google app still configured): the broker
    // answers BROKER_NOT_CONFIGURED. The key may come back, so retry until the give-up time, then remove the connection.
    if (error instanceof DomainError && error.code === 'BROKER_NOT_CONFIGURED') return expired ? finish(false, 'no_credential_key') : { outcome: 'retry', reason: 'no_credential_key' };
    if (!(error instanceof CredentialError)) throw error;
    if (error.message.startsWith(UNKNOWN_KEY) && !expired) return { outcome: 'retry', reason: 'unknown_key' };
    return finish(false, 'credential_unreadable');
  }
  const answer = await adapter.revoke(secret);
  if ('revoked' in answer) return answer.revoked ? finish(true) : finish(false, answer.reason);
  if (expired) return finish(false, 'revoke_failed');
  return { outcome: 'retry', reason: answer.failed };
}

export async function runCalendarSync(deps: CalendarSyncDeps, job: CalendarSyncJob): Promise<CalendarSyncOutcome> {
  const options = { actor: ACTOR, orgId: job.orgId };
  const now = deps.now ?? (() => new Date());
  const state = await deps.runtime.query<{ status: string; provider: string; expiresAt: string | null; updatedAt: string; writeBack?: boolean } | null>('kernel.calendar.connection_state', { connectionId: job.connectionId }, options);
  if (!state || state.status !== 'active') return { outcome: 'skipped', reason: 'not_active' };
  // An adapter switched off (the app credentials removed) syncs nothing; the connection and its blocks stay.
  const adapter = adapterFor(deps.adapters, state.provider);
  if (!adapter) return { outcome: 'skipped', reason: 'no_adapter' };
  let sealed: SealedCalendarCredential;
  try {
    sealed = await deps.runtime.query<SealedCalendarCredential>('kernel.calendar.credential', { connectionId: job.connectionId }, options);
  } catch (error) {
    // The member left the org, or the connection is no longer active: nothing to sync.
    if (error instanceof DomainError) return { outcome: 'skipped', reason: error.code };
    throw error;
  }
  // The credential is handed out for a disconnecting connection too (its revoke needs it), so the state is read again now: a
  // disconnect, or a reconnect, between the first read and this one would have this sync work with, and perhaps rotate,
  // the token of a connection on its way out, and the revoke would then send a token the provider no longer knows.
  const again = await deps.runtime.query<{ status: string; updatedAt: string } | null>('kernel.calendar.connection_state', { connectionId: job.connectionId }, options);
  if (!again || again.status !== 'active' || again.updatedAt !== state.updatedAt) return { outcome: 'skipped', reason: 'changed' };
  const binding = calendarBinding(job.orgId, sealed.provider as CalendarProvider, sealed.externalAccount);
  let secret: string;
  try {
    secret = deps.broker.open({ keyId: sealed.keyId, envelope: Buffer.from(sealed.envelope, 'base64') }, binding);
  } catch (error) {
    // A key that is gone or a damaged envelope: the token cannot be read, so the member connects again.
    if (!(error instanceof CredentialError)) throw error;
    await deps.runtime.execute('kernel.calendar.mark_failed', { connectionId: job.connectionId, status: 'expired', reason: 'credential_unreadable', ifVersion: state.updatedAt }, options);
    return { outcome: 'expired', reason: 'credential_unreadable' };
  }
  // The connection's version this sync's token belongs to: a member who connects again while a call is out has a
  // newer one, and a refusal of the old token must not expire the new connection.
  let version = state.updatedAt;
  const expire = async (reason: string): Promise<CalendarSyncOutcome> => {
    await deps.runtime.execute('kernel.calendar.mark_failed', { connectionId: job.connectionId, status: 'expired', reason: `refused (${reason})`.slice(0, 200), ifVersion: version }, options);
    return { outcome: 'expired', reason };
  };
  const retry = async (reason: string): Promise<CalendarSyncOutcome> => {
    await deps.runtime.execute('kernel.calendar.mark_failed', { connectionId: job.connectionId, status: 'retry', reason: `sync failed (${reason})`.slice(0, 200) }, options);
    return { outcome: 'retry', reason };
  };
  let renewed = false;
  // Renews the access token and seals the new pair; an outcome when the sync must stop there.
  const renew = async (): Promise<CalendarSyncOutcome | null> => {
    const result = await adapter.refresh(secret);
    if ('refused' in result) return expire(result.refused);
    if ('failed' in result) return retry(result.failed);
    const next = deps.broker.seal(result.secret, binding);
    const command = { connectionId: job.connectionId, ifVersion: version, expiresAt: result.expiresAt?.toISOString() ?? null, credential: { keyId: next.keyId, envelope: next.envelope.toString('base64') } };
    // The provider may have rotated the refresh token: this write is the only copy of the new pair, so a passing
    // database error is retried.
    let stored: { refreshed: boolean; updatedAt?: string } | null = null;
    for (let attempt = 1; ; attempt++) {
      try {
        stored = await deps.runtime.execute<{ refreshed: boolean; updatedAt?: string }>('kernel.calendar.refresh', command, options);
        break;
      } catch (error) {
        if (attempt >= 3 || error instanceof DomainError) throw error;
        await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
      }
    }
    // Reconnected or disconnected meanwhile: that connection's own sync takes it from here.
    if (!stored?.refreshed || !stored.updatedAt) {
      // A provider that rotates refresh tokens has just made a new pair this connection never stored. If the member
      // disconnected meanwhile, that grant would outlive the revoke, which will send the old token: revoke the new pair now.
      // A reconnected connection keeps its own, newer grant; a connection that is gone was finished or purged already.
      const current = await deps.runtime.query<{ status: string; updatedAt: string } | null>('kernel.calendar.connection_state', { connectionId: job.connectionId }, options);
      if (current?.status === 'disconnecting') {
        const gone = await adapter.revoke(result.secret).catch(() => ({ failed: 'NETWORK' }) as const);
        if ('failed' in gone) console.error(`[calendar-sync] connection ${job.connectionId.slice(0, 8)} could not revoke the pair a refresh made: ${gone.failed}`);
        // A member who connected the same account again while that call was out has a grant it just ended too: that
        // connection is expired now, so they connect again at once instead of finding out at the next sync.
        if ('revoked' in gone && gone.revoked) {
          const after = await deps.runtime.query<{ status: string; updatedAt: string } | null>('kernel.calendar.connection_state', { connectionId: job.connectionId }, options);
          if (after && after.status === 'active' && after.updatedAt !== current.updatedAt) {
            await deps.runtime.execute('kernel.calendar.mark_failed', { connectionId: job.connectionId, status: 'expired', reason: 'grant revoked while reconnecting: connect again', ifVersion: after.updatedAt }, options);
          }
        }
      }
      return { outcome: 'skipped', reason: 'changed' };
    }
    version = stored.updatedAt;
    secret = result.secret;
    renewed = true;
    return null;
  };
  // Write-back's batch (below), with a refused token renewed once here: refused again, the grant is gone.
  const writeBackStep = (): Promise<CalendarSyncOutcome | null> =>
    writeBackBatch({
      runtime: deps.runtime,
      options,
      connectionId: job.connectionId,
      adapter,
      secret: () => secret,
      onRefused: async (reason) => {
        if (renewed) return expire(reason);
        return (await renew()) ?? secret;
      },
    });
  if (state.expiresAt === null || Date.parse(state.expiresAt) - now().getTime() < REFRESH_AHEAD_MS) {
    const stopped = await renew();
    if (stopped) return stopped;
  }
  // Write-back (#2124): make the member's calendar match their bookings before the busy times are read, so a sweep never
  // reads busy times that still hold an event it is about to delete. A write that fails never stops the busy read.
  if (state.writeBack) {
    let stopped: CalendarSyncOutcome | null = null;
    try {
      // Held by a booking-event job: it does the reconcile, and the sweep's next pass is the backstop.
      const held = await withConnectionLock(deps, job.connectionId, writeBackStep);
      stopped = held.ran ? held.value : null;
    } catch (error) {
      // A plan or a record that fails (a disconnect finishing meanwhile, a database blip) must not cost the member their busy times.
      console.error(`[calendar-sync] connection ${job.connectionId.slice(0, 8)} write-back failed: ${error instanceof Error ? error.name : 'error'}`);
    }
    if (stopped) return stopped;
  }
  // From the start of the hour, so a busy interval that began earlier keeps one stable key from sync to sync.
  const from = new Date(Math.floor(now().getTime() / HOUR_MS) * HOUR_MS);
  const to = new Date(from.getTime() + CALENDAR_SYNC_DAYS * DAY_MS);
  // The farthest an event type may book ahead is a year: the whole of it is read, in pieces a request can bear.
  const readAll = async (): Promise<{ busy: Array<{ start: number; end: number }> } | { refused: string } | { failed: string }> => {
    const busy: Array<{ start: number; end: number }> = [];
    for (let start = from.getTime(); start < to.getTime(); start += CHUNK_DAYS * DAY_MS) {
      const answer = await adapter.busy(secret, new Date(start), new Date(Math.min(to.getTime(), start + CHUNK_DAYS * DAY_MS)));
      if ('refused' in answer || 'failed' in answer) return answer;
      for (const b of answer.busy) busy.push({ start: Date.parse(b.start), end: Date.parse(b.end) });
    }
    return { busy };
  };
  let answer = await readAll();
  // One refusal of the access token (a revoked early, clock skew) is not the end of the grant: renew it and ask again.
  // Only a refusal of the renewed token, or of the renewal itself, expires the connection.
  if ('refused' in answer && !renewed) {
    const stopped = await renew();
    if (stopped) return stopped;
    answer = await readAll();
  }
  if ('refused' in answer) return expire(answer.refused);
  if ('failed' in answer) return retry(answer.failed);
  // Overlapping and touching intervals are one block, which keeps the answer small.
  const merged = busyPieces(answer.busy, from.getTime(), to.getTime());
  if (merged.length > MAX_BUSY) return retry('too_many_busy_intervals');
  const done = await deps.runtime.execute<{ replaced: boolean; added: number; removed: number }>(
    'kernel.calendar.busy_replace',
    { connectionId: job.connectionId, from: from.toISOString(), to: to.toISOString(), busy: merged.map((b) => ({ start: new Date(b.start).toISOString(), end: new Date(b.end).toISOString() })) },
    options,
  );
  return done.replaced ? { outcome: 'synced', added: done.added, removed: done.removed } : { outcome: 'skipped', reason: 'not_active' };
}

interface WriteBackBatch {
  runtime: Runtime;
  options: { actor: SystemActor; orgId: string };
  connectionId: string;
  adapter: CalendarAdapter;
  // The access token as it is now (a renewal replaces it).
  secret: () => string;
  // A call the provider refused for its token: the new token to repeat the call with, or the outcome to stop with.
  onRefused: (reason: string) => Promise<string | CalendarSyncOutcome>;
}

// Makes the provider's events match the bookings: what is new or changed is written, what was cancelled is deleted. The
// kernel plans it from the connection's links (kernel.calendar.writeback_plan), each call is idempotent by the event's id,
// and each outcome is recorded as it happens, so a crash between a call and its record only repeats a call. Null when the
// batch ended (done, or left for the next sweep), an outcome when the connection must stop there.
async function writeBackBatch(b: WriteBackBatch): Promise<CalendarSyncOutcome | null> {
  const plan = await b.runtime.query<{ actions: WriteBackAction[] }>('kernel.calendar.writeback_plan', { connectionId: b.connectionId }, b.options);
  const call = (a: WriteBackAction, secret: string) =>
    a.kind === 'delete' || a.summary === null || a.startsAt === null || a.endsAt === null
      ? b.adapter.removeEvent(secret, a.externalId)
      : b.adapter.writeEvent(secret, { externalId: a.externalId, summary: a.summary, startsAt: a.startsAt, endsAt: a.endsAt });
  let first = true;
  for (const a of plan.actions) {
    // The plan is a few moments old after the first call: a member who switched write-back off, or disconnected, in the
    // meantime has no more of their bookings sent.
    if (!first) {
      const current = await b.runtime.query<{ status: string; writeBack: boolean } | null>('kernel.calendar.connection_state', { connectionId: b.connectionId }, b.options);
      if (!current || current.status !== 'active' || !current.writeBack) return null;
    }
    first = false;
    let result = await call(a, b.secret());
    if ('refused' in result) {
      const next = await b.onRefused(result.refused);
      if (typeof next !== 'string') return next;
      result = await call(a, next);
      if ('refused' in result) {
        const stopped = await b.onRefused(result.refused);
        return typeof stopped === 'string' ? { outcome: 'retry', reason: result.refused } : stopped;
      }
    }
    // The grant lacks the events permission (the member unticked it): nothing more can be written until they connect again.
    // (The busy read that follows clears a connection's failure note, so none is written; the next sweep tries again.)
    if ('scope' in result) return null;
    // An outage or a limit says nothing about this event and would hit every one behind it: no record, no attempt counted,
    // and the rest of the batch (each call may wait 30 seconds, and the sweep holds one lock) is left for the next sweep.
    if ('failed' in result && result.transient) return null;
    const written = 'ok' in result || 'gone' in result;
    // gone: the member deleted the event by hand (an upsert) or it was not there (a delete): either way it stays gone
    // until its booking changes.
    const recorded = written ? (a.kind === 'delete' || 'gone' in result ? 'removed' : 'written') : 'error';
    await b.runtime.execute(
      'kernel.calendar.link.record',
      { connectionId: b.connectionId, eventId: a.eventId, externalId: a.externalId, state: recorded, syncedHash: a.hash, ...(recorded === 'error' ? { error: String('failed' in result ? result.failed : 'failed').slice(0, 100) || 'failed' } : {}) },
      b.options,
    );
  }
  return null;
}

// A booking confirmed, moved or cancelled (#2124): the events of every write-back connection of its org are made to match
// at once, from a job the outbox relay queues, instead of waiting for the next sweep. It never renews a token or expires a
// connection: a token that is about to run out, or that the provider refuses, is left to the sweep, which does both.
export async function runCalendarWriteBack(deps: CalendarSyncDeps, job: CalendarWriteBackJob): Promise<{ connections: number; ran: number; busy: number }> {
  const options = { actor: ACTOR, orgId: job.orgId };
  const now = deps.now ?? (() => new Date());
  const ids = await deps.runtime.query<string[]>('kernel.calendar.writeback_connections', {}, options);
  let ran = 0;
  let busy = 0;
  for (const connectionId of ids) {
    try {
      const state = await deps.runtime.query<{ status: string; provider: string; expiresAt: string | null; updatedAt: string; writeBack?: boolean } | null>('kernel.calendar.connection_state', { connectionId }, options);
      if (!state || state.status !== 'active' || !state.writeBack) continue;
      const adapter = adapterFor(deps.adapters, state.provider);
      // A token that would run out during the batch is renewed by the sweep, which comes within 15 minutes.
      if (!adapter || state.expiresAt === null || Date.parse(state.expiresAt) - now().getTime() < REFRESH_AHEAD_MS) continue;
      const sealed = await deps.runtime.query<SealedCalendarCredential>('kernel.calendar.credential', { connectionId }, options);
      const again = await deps.runtime.query<{ status: string; updatedAt: string } | null>('kernel.calendar.connection_state', { connectionId }, options);
      if (!again || again.status !== 'active' || again.updatedAt !== state.updatedAt) continue;
      const secret = deps.broker.open({ keyId: sealed.keyId, envelope: Buffer.from(sealed.envelope, 'base64') }, calendarBinding(job.orgId, sealed.provider as CalendarProvider, sealed.externalAccount));
      const held = await withConnectionLock(deps, connectionId, () => writeBackBatch({ runtime: deps.runtime, options, connectionId, adapter, secret: () => secret, onRefused: async (reason) => ({ outcome: 'skipped', reason }) }));
      if (held.ran) ran += 1;
      else busy += 1;
    } catch (error) {
      // One connection's trouble (a key that is gone, a database blip) leaves the others and the next sweep alone. A member who
      // left or a connection that went (a refusal by the kernel) is not worth a line on every booking event.
      if (error instanceof DomainError) continue;
      console.error(`[calendar-writeback] connection ${connectionId.slice(0, 8)}: ${error instanceof Error ? error.name : 'error'}`);
    }
  }
  // busy: connections the sweep or another job was working on; the caller retries the job, so a booking that committed after
  // their plan was read is still written.
  return { connections: ids.length, ran, busy };
}
export interface CalendarSweepDeps {
  runtime: Runtime;
  broker: CredentialBroker;
  workerDb: Db;
  adapters: CalendarSyncDeps['adapters'];
  lockConnection?: ConnectionLock;
  // Runs the sweep while no other worker process does (the worker holds the connection the lock lives on); { ran: false }
  // when another one has it.
  exclusive: <T>(run: () => Promise<T>) => Promise<{ ran: true; value: T } | { ran: false }>;
  // The page of connections to take care of after a key; calendarSyncDue on the worker's database unless a test gives one.
  listDue?: (after: { orgId: string; connectionId: string } | null) => Promise<Array<{ orgId: string; connectionId: string; provider: string }>>;
  now?: () => Date;
}

export interface CalendarSweepOutcome {
  // Disconnects finished: the grant revoked at the provider and the connection removed.
  disconnected: number;
  synced: number;
  expired: number;
  retry: number;
  skipped: number;
  // Another worker process holds the sweep.
  busy: boolean;
}

// A sweep over every active connection, one at a time across worker processes: a connection that fails ends only its
// own sync, and the rest go on.
export async function syncCalendars(deps: CalendarSweepDeps): Promise<CalendarSweepOutcome> {
  const outcome: CalendarSweepOutcome = { disconnected: 0, synced: 0, expired: 0, retry: 0, skipped: 0, busy: false };
  const providers = new Set(Object.values(deps.adapters).map((a) => a?.provider));
  const listDue = deps.listDue ?? ((after) => calendarSyncDue(deps.workerDb, after));
  const ran = await deps.exclusive(async () => {
    let after: { orgId: string; connectionId: string } | null = null;
    for (;;) {
      const page = await listDue(after);
      for (const row of page) {
        const job = { orgId: row.orgId, connectionId: row.connectionId };
        const failed = (error: unknown) => {
          // The connection's id and the error's name only: never a token or an interval.
          console.error(`[calendar-sync] connection ${row.connectionId.slice(0, 8)}`, error instanceof Error ? error.name : typeof error);
          return null;
        };
        // Which of the two it is, from its state: the list holds the connections to sync and the ones to remove. A
        // disconnecting one is taken care of whatever the server has configured (its grant is revoked, or given up on, and the
        // sealed token and the member's address go); an active one only when the server has an adapter for its provider.
        const seen = await deps.runtime.query<{ status: string; provider: string; updatedAt: string } | null>('kernel.calendar.connection_state', { connectionId: row.connectionId }, { actor: ACTOR, orgId: row.orgId }).catch(failed);
        if (seen === null) {
          outcome.retry += 1;
          continue;
        }
        if (seen.status === 'disconnecting') {
          const gone = await disconnectSeen(deps, job, seen, deps.now ?? (() => new Date())).catch(failed);
          if (gone === null || gone.outcome === 'retry') outcome.retry += 1;
          else if (gone.outcome === 'disconnected') outcome.disconnected += 1;
          else outcome.skipped += 1;
          continue;
        }
        if (!providers.has(row.provider as CalendarAdapter['provider'])) {
          outcome.skipped += 1;
          continue;
        }
        const done = await runCalendarSync(deps, job).catch(failed);
        if (done === null) outcome.retry += 1;
        else if (done.outcome === 'synced') outcome.synced += 1;
        else outcome[done.outcome] += 1;
      }
      const last = page.at(-1);
      if (!last || page.length < CALENDAR_SYNC_PAGE) break;
      after = { orgId: last.orgId, connectionId: last.connectionId };
    }
  });
  return ran.ran ? outcome : { ...outcome, busy: true };
}
