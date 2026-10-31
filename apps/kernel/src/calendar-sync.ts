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
import { busyPieces, type SealedCalendarCredential } from '@crove/kernel';

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

export interface CalendarSyncDeps {
  runtime: Runtime;
  broker: CredentialBroker;
  // The adapters this deployment offers, by OAuth provider id.
  adapters: Readonly<Partial<Record<string, CalendarAdapter>>>;
  now?: () => Date;
}

export type CalendarSyncOutcome = { outcome: 'synced'; added: number; removed: number } | { outcome: 'skipped' | 'expired' | 'retry'; reason: string };

// A page of the active calendar connections of active orgs after a key (crove_kernel.calendar_sync_due, the worker
// login's alone), for the 15 minute sweep.
export const CALENDAR_SYNC_PAGE = 1000;
export async function calendarSyncDue(
  workerDb: Db,
  after: { orgId: string; connectionId: string } | null,
): Promise<Array<{ orgId: string; connectionId: string; provider: string; disconnecting: boolean }>> {
  const { rows } = await sql<{ org_id: string; connection_id: string; provider: string; disconnecting: boolean }>`
    SELECT org_id, connection_id, provider, disconnecting FROM crove_kernel.calendar_sync_due(${after?.orgId ?? null}::uuid, ${after?.connectionId ?? null}::uuid, ${CALENDAR_SYNC_PAGE}::int)`.execute(workerDb);
  return rows.map((r) => ({ orgId: r.org_id, connectionId: r.connection_id, provider: r.provider, disconnecting: r.disconnecting }));
}

const adapterFor = (adapters: CalendarSyncDeps['adapters'], provider: string): CalendarAdapter | undefined => Object.values(adapters).find((a) => a?.provider === provider);

// A disconnecting connection the provider kept refusing to revoke for this long is removed anyway: the token is useless to
// us from then on, and the member can take the grant away in their account (the audit row says it was not revoked).
const REVOKE_GIVE_UP_MS = 3 * DAY_MS;

export type CalendarDisconnectOutcome = { outcome: 'disconnected'; revoked: boolean; reason?: string } | { outcome: 'skipped' | 'retry'; reason: string };

// Finishes a disconnect the member asked for: revokes the grant at the provider with the token only the worker can open,
// then removes the connection and its sealed token (kernel.calendar.finish_disconnect). A provider that cannot be reached
// is tried again at the next sweep.
export async function runCalendarDisconnect(deps: CalendarSyncDeps, job: CalendarSyncJob): Promise<CalendarDisconnectOutcome> {
  const options = { actor: ACTOR, orgId: job.orgId };
  const now = deps.now ?? (() => new Date());
  const state = await deps.runtime.query<{ status: string; provider: string; updatedAt: string } | null>('kernel.calendar.connection_state', { connectionId: job.connectionId }, options);
  if (!state || state.status !== 'disconnecting') return { outcome: 'skipped', reason: 'not_disconnecting' };
  const finish = async (revoked: boolean, reason?: string): Promise<CalendarDisconnectOutcome> => {
    await deps.runtime.execute('kernel.calendar.finish_disconnect', { connectionId: job.connectionId, revoked, ...(reason ? { reason } : {}) }, options);
    return { outcome: 'disconnected', revoked, ...(reason ? { reason } : {}) };
  };
  const adapter = adapterFor(deps.adapters, state.provider);
  let sealed: SealedCalendarCredential;
  try {
    sealed = await deps.runtime.query<SealedCalendarCredential>('kernel.calendar.credential', { connectionId: job.connectionId }, options);
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    // The member left the org (the token cannot be handed out any more) or the token is gone: nothing to revoke with.
    return finish(false, error.code === 'CALENDAR_OWNER_LEFT' ? 'owner_left' : 'no_credential');
  }
  if (!adapter) {
    // The app credentials were removed from this server: the revoke cannot be made; keep trying until the give-up time.
    return Date.now() - Date.parse(state.updatedAt) > REVOKE_GIVE_UP_MS ? finish(false, 'no_adapter') : { outcome: 'retry', reason: 'no_adapter' };
  }
  let secret: string;
  try {
    secret = deps.broker.open({ keyId: sealed.keyId, envelope: Buffer.from(sealed.envelope, 'base64') }, calendarBinding(job.orgId, sealed.provider as CalendarProvider, sealed.externalAccount));
  } catch (error) {
    if (!(error instanceof CredentialError)) throw error;
    return finish(false, 'credential_unreadable');
  }
  const answer = await adapter.revoke(secret);
  if ('revoked' in answer) return finish(true);
  if (now().getTime() - Date.parse(state.updatedAt) > REVOKE_GIVE_UP_MS) return finish(false, 'revoke_failed');
  return { outcome: 'retry', reason: answer.failed };
}

export async function runCalendarSync(deps: CalendarSyncDeps, job: CalendarSyncJob): Promise<CalendarSyncOutcome> {
  const options = { actor: ACTOR, orgId: job.orgId };
  const now = deps.now ?? (() => new Date());
  const state = await deps.runtime.query<{ status: string; provider: string; expiresAt: string | null; updatedAt: string } | null>('kernel.calendar.connection_state', { connectionId: job.connectionId }, options);
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
    for (let attempt = 1; ; attempt++) {
      try {
        const stored = await deps.runtime.execute<{ refreshed: boolean; updatedAt?: string }>('kernel.calendar.refresh', command, options);
        // Reconnected or disconnected meanwhile: that connection's own sync takes it from here.
        if (!stored.refreshed || !stored.updatedAt) return { outcome: 'skipped', reason: 'changed' };
        version = stored.updatedAt;
        break;
      } catch (error) {
        if (attempt >= 3 || error instanceof DomainError) throw error;
        await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
      }
    }
    secret = result.secret;
    renewed = true;
    return null;
  };
  if (state.expiresAt === null || Date.parse(state.expiresAt) - now().getTime() < REFRESH_AHEAD_MS) {
    const stopped = await renew();
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

export interface CalendarSweepDeps {
  runtime: Runtime;
  broker: CredentialBroker;
  workerDb: Db;
  adapters: CalendarSyncDeps['adapters'];
  // Runs the sweep while no other worker process does (the worker holds the connection the lock lives on); { ran: false }
  // when another one has it.
  exclusive: <T>(run: () => Promise<T>) => Promise<{ ran: true; value: T } | { ran: false }>;
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
  if (providers.size === 0) return outcome;
  const ran = await deps.exclusive(async () => {
    let after: { orgId: string; connectionId: string } | null = null;
    for (;;) {
      const page = await calendarSyncDue(deps.workerDb, after);
      for (const row of page.filter((r) => providers.has(r.provider as CalendarAdapter['provider']))) {
        const job = { orgId: row.orgId, connectionId: row.connectionId };
        const failed = (error: unknown) => {
          // The connection's id and the error's name only: never a token or an interval.
          console.error(`[calendar-sync] connection ${row.connectionId.slice(0, 8)}`, error instanceof Error ? error.name : typeof error);
          return null;
        };
        if (row.disconnecting) {
          const gone = await runCalendarDisconnect(deps, job).catch(failed);
          if (gone === null || gone.outcome === 'retry') outcome.retry += 1;
          else if (gone.outcome === 'disconnected') outcome.disconnected += 1;
          else outcome.skipped += 1;
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
