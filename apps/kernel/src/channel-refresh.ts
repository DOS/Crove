// Renews channel tokens before they expire (Social plan §3.5, step S6.4, issue #374). Some providers hand out
// short-lived access tokens with single-use refresh tokens (Zalo OA: 25 hours and 3 months): a refresh rotates both,
// so two refreshes of one connection at once would leave one of them holding a dead token. One sweep runs at a time
// across worker processes (a session advisory lock), and each connection is refreshed once per sweep.
//
// What happens if a sweep dies:
// - before the provider call: nothing changed; the next sweep tries again;
// - after the call, before kernel.channel.refresh commits: the provider rotated the tokens and the new pair is lost;
//   the next refresh is refused and the connection is marked expired, so an owner or admin reconnects it. Nothing
//   is posted with a token nobody has.
import { sql } from 'kysely';
import type { Refresher } from '@crove/channel';
import type { Db } from '@crove/db';
import { DomainError, type CredentialBroker, type Runtime, type SystemActor } from '@crove/kernel-runtime';
import type { SealedChannelCredential } from '@crove/kernel';

const ACTOR: SystemActor = { type: 'system', component: 'kernel.channel.refresh' };
// Refresh tokens that expire within this window: Zalo's access tokens last 25 hours, so a sweep every 10 minutes
// renews each one about 6 hours ahead, with room for a worker that was down for a while.
export const REFRESH_HORIZON_SECONDS = 6 * 3600;
export const REFRESH_SWEEP_MS = 10 * 60_000;
const REFRESH_LIMIT = 200;
const LOCK_KEY = 'crove.channel-refresh';

export interface RefreshDeps {
  runtime: Runtime;
  broker: CredentialBroker;
  workerDb: Db;
  refreshers: Readonly<Record<string, Refresher>>;
}

export interface RefreshOutcome {
  refreshed: number;
  expired: number;
  failed: number;
  skipped: boolean;
}

interface Due {
  org_id: string;
  connection_id: string;
  provider: string;
  version: Date;
}

export async function refreshChannels(deps: RefreshDeps): Promise<RefreshOutcome> {
  const providers = Object.keys(deps.refreshers);
  const outcome: RefreshOutcome = { refreshed: 0, expired: 0, failed: 0, skipped: false };
  if (providers.length === 0) return outcome;
  return deps.workerDb.connection().execute(async (db) => {
    const { rows } = await sql<{ locked: boolean }>`SELECT pg_catalog.pg_try_advisory_lock(pg_catalog.hashtextextended(${LOCK_KEY}, 0)) AS locked`.execute(db);
    if (!rows[0]?.locked) return { ...outcome, skipped: true };
    try {
      const due = await sql<Due>`
        SELECT org_id, connection_id, provider, version
        FROM crove_kernel.channel_refresh_due(${REFRESH_LIMIT}::int, ${providers}::text[], ${REFRESH_HORIZON_SECONDS}::int)`.execute(db);
      for (const row of due.rows) {
        const refresher = deps.refreshers[row.provider];
        if (!refresher) continue;
        const result = await refreshOne(deps, refresher, row).catch((error: unknown) => {
          console.error(`[channel-refresh] connection ${row.connection_id.slice(0, 8)}`, error instanceof Error ? error.message : error);
          return 'failed' as const;
        });
        outcome[result] += 1;
      }
      return outcome;
    } finally {
      await sql`SELECT pg_catalog.pg_advisory_unlock(pg_catalog.hashtextextended(${LOCK_KEY}, 0))`.execute(db);
    }
  });
}

async function refreshOne(deps: RefreshDeps, refresher: Refresher, row: Due): Promise<'refreshed' | 'expired' | 'failed'> {
  const options = { actor: ACTOR, orgId: row.org_id };
  const ifVersion = row.version.toISOString();
  let sealed: SealedChannelCredential;
  try {
    sealed = await deps.runtime.query<SealedChannelCredential>('kernel.channel.credential', { connectionId: row.connection_id }, options);
  } catch (error) {
    // The member who connected it left, or it is no longer active: the publish path reports it; nothing to renew.
    if (error instanceof DomainError) return 'failed';
    throw error;
  }
  const binding = { orgId: row.org_id, provider: sealed.provider, externalAccountId: sealed.externalAccountId };
  const secret = deps.broker.open({ keyId: sealed.keyId, envelope: Buffer.from(sealed.envelope, 'base64') }, binding);
  const result = await refresher.refresh(secret);
  if ('refused' in result) {
    await deps.runtime.execute('kernel.channel.mark_expired', { connectionId: row.connection_id, reason: `refresh refused (${result.refused})`.slice(0, 200), ifVersion }, options);
    return 'expired';
  }
  if ('failed' in result) return 'failed';
  const next = deps.broker.seal(result.secret, binding);
  const command = { connectionId: row.connection_id, ifVersion, expiresAt: result.expiresAt?.toISOString() ?? null, credential: { keyId: next.keyId, envelope: next.envelope.toString('base64') } };
  // The provider has rotated the tokens: this write is the only copy of them, so a passing database error is retried.
  for (let attempt = 1; ; attempt++) {
    try {
      const stored = await deps.runtime.execute<{ refreshed: boolean }>('kernel.channel.refresh', command, options);
      return stored.refreshed ? 'refreshed' : 'failed';
    } catch (error) {
      if (attempt >= 3 || error instanceof DomainError) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }
}
