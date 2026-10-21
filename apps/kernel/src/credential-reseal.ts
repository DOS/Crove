// Reseals channel credentials after a credential key rotation (#776, ADR-0025). With CREDENTIAL_KEY set to the new key
// and CREDENTIAL_KEY_PREVIOUS to the old one, the worker opens each envelope still sealed with the old key and seals it
// again with the new one, a batch every few minutes, and logs how many are left. Once none is left under the old key,
// CREDENTIAL_KEY_PREVIOUS can go (docs/runbooks/credential-key.md).
//
// Only credentials of active connections whose connecting member may still use them are resealed (the rule of
// credential_get); the others reseal when they are reconnected, and the counts say how many there are. No token is ever logged.
//
// The sealed targets of team chat alerts (#863, crove_social.chat_alert_target) go through the same pass, under the
// same lock, when the Social module is on: those whose saver is still an owner or admin are resealed, the others when
// the chat is saved again, and both are in the counts.
import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import type { Db } from '@crove/db';
import { DomainError, type CredentialBroker, type Runtime, type SystemActor } from '@crove/kernel-runtime';
import type { SealedChannelCredential } from '@crove/kernel';
import { CHAT_ALERT_PROVIDER, type SealedChatAlert } from '@crove/mod-social';

const ACTOR: SystemActor = { type: 'system', component: 'kernel.channel.reseal' };
const CHAT_ACTOR: SystemActor = { type: 'system', component: 'social.chat_alert.reseal' };
export const RESEAL_SWEEP_MS = 10 * 60_000;
const RESEAL_LIMIT = 200;
// At most this many pages a pass; the rest waits for the next pass.
const RESEAL_PAGES = 5;
const LOCK_KEY = 'crove.credential-reseal';

export interface ResealDeps {
  runtime: Runtime;
  broker: CredentialBroker;
  workerDb: Db;
}

export interface ResealOutcome {
  resealed: number;
  failed: number;
  // Envelopes still under a key other than the current one: of active connections, and of the others.
  leftActive: number;
  leftInactive: number;
  skipped: boolean;
}

// The key a broker seals with now; a broker that does not say (another implementation) is not resealed here.
const currentKeyOf = (broker: CredentialBroker): string | null => {
  const id = (broker as { keyId?: unknown }).keyId;
  return typeof id === 'string' && id ? id : null;
};

export async function resealCredentials(deps: ResealDeps): Promise<ResealOutcome> {
  const outcome: ResealOutcome = { resealed: 0, failed: 0, leftActive: 0, leftInactive: 0, skipped: false };
  const current = currentKeyOf(deps.broker);
  if (!current) return { ...outcome, skipped: true };
  return deps.workerDb.connection().execute(async (db) => {
    const { rows: lock } = await sql<{ locked: boolean }>`SELECT pg_catalog.pg_try_advisory_lock(pg_catalog.hashtextextended(${LOCK_KEY}, 0)) AS locked`.execute(db);
    if (!lock[0]?.locked) return { ...outcome, skipped: true };
    try {
      // Page after page, so a credential that cannot be resealed never holds back the ones after it.
      let after = null as { sealed: Date; id: string } | null;
      for (let page = 0; page < RESEAL_PAGES; page += 1) {
        const { rows } = await sql<{ org_id: string; connection_id: string; key_id: string; sealed_at: Date }>`
          SELECT org_id, connection_id, key_id, sealed_at FROM crove_kernel.credential_reseal_due(${current}, ${RESEAL_LIMIT}::int, ${after?.sealed ?? null}::timestamptz, ${after?.id ?? null}::uuid)`.execute(db);
        for (const row of rows) {
          const done = await resealOne(deps, row).catch((error: unknown) => {
            // The connection id only: never the envelope or what it holds.
            console.error(`[credential-reseal] connection ${row.connection_id.slice(0, 8)}`, error instanceof Error ? error.name : typeof error);
            return false;
          });
          if (done) outcome.resealed += 1;
          else outcome.failed += 1;
        }
        const last = rows.at(-1);
        if (!last || rows.length < RESEAL_LIMIT) break;
        after = { sealed: last.sealed_at, id: last.connection_id };
      }
      const social = deps.runtime.installed('social');
      // A failing chat alert pass (its scan, say) leaves the channel pass's outcome and the counts standing.
      if (social) {
        await resealChatAlerts(deps, db, current, outcome).catch((error: unknown) => {
          console.error('[credential-reseal] chat alert pass', error instanceof Error ? error.name : typeof error);
        });
      }
      const { rows: counts } = await sql<{ key_id: string; active: string; inactive: string }>`SELECT key_id, active, inactive FROM crove_kernel.credential_key_counts()`.execute(db);
      const { rows: chatCounts } = social
        ? await sql<{ key_id: string; active: string; inactive: string }>`SELECT key_id, active, inactive FROM crove_social.chat_alert_target_key_counts()`.execute(db)
        : { rows: [] };
      for (const c of [...counts, ...chatCounts]) {
        if (c.key_id === current) continue;
        outcome.leftActive += Number(c.active);
        outcome.leftInactive += Number(c.inactive);
      }
      return outcome;
    } finally {
      await sql`SELECT pg_catalog.pg_advisory_unlock(pg_catalog.hashtextextended(${LOCK_KEY}, 0))`.execute(db);
    }
  });
}

async function resealOne(deps: ResealDeps, row: { org_id: string; connection_id: string; key_id: string }): Promise<boolean> {
  const options = { actor: ACTOR, orgId: row.org_id };
  let sealed: SealedChannelCredential;
  try {
    sealed = await deps.runtime.query<SealedChannelCredential>('kernel.channel.credential', { connectionId: row.connection_id }, options);
  } catch (error) {
    // The member who connected it left, or it stopped being active since the scan: it reseals when reconnected.
    if (error instanceof DomainError) return false;
    throw error;
  }
  const binding = { orgId: row.org_id, provider: sealed.provider, externalAccountId: sealed.externalAccountId };
  let secret: string | null = deps.broker.open({ keyId: sealed.keyId, envelope: Buffer.from(sealed.envelope, 'base64') }, binding);
  const next = deps.broker.seal(secret, binding);
  secret = null;
  const stored = await deps.runtime.execute<{ resealed: boolean }>(
    'kernel.channel.reseal',
    { connectionId: row.connection_id, fromKeyId: sealed.keyId, fromEnvelopeSha256: createHash('sha256').update(Buffer.from(sealed.envelope, 'base64')).digest('hex'), credential: { keyId: next.keyId, envelope: next.envelope.toString('base64') } },
    options,
  );
  return stored.resealed;
}

// The team chat alert targets still under an older key, page after page as the credentials.
async function resealChatAlerts(deps: ResealDeps, db: Db, current: string, outcome: ResealOutcome): Promise<void> {
  let after = null as { sealed: Date; id: string } | null;
  for (let page = 0; page < RESEAL_PAGES; page += 1) {
    const { rows } = await sql<{ org_id: string; alert_id: string; key_id: string; sealed_at: Date }>`
      SELECT org_id, alert_id, key_id, sealed_at FROM crove_social.chat_alert_target_reseal_due(${current}, ${RESEAL_LIMIT}::int, ${after?.sealed ?? null}::timestamptz, ${after?.id ?? null}::uuid)`.execute(db);
    for (const row of rows) {
      const done = await resealChatAlert(deps, row).catch((error: unknown) => {
        // The alert id only: never the envelope or what it holds.
        console.error(`[credential-reseal] chat alert ${row.alert_id.slice(0, 8)}`, error instanceof Error ? error.name : typeof error);
        return false;
      });
      if (done) outcome.resealed += 1;
      else outcome.failed += 1;
    }
    const last = rows.at(-1);
    if (!last || rows.length < RESEAL_LIMIT) break;
    after = { sealed: last.sealed_at, id: last.alert_id };
  }
}

async function resealChatAlert(deps: ResealDeps, row: { org_id: string; alert_id: string }): Promise<boolean> {
  const options = { actor: CHAT_ACTOR, orgId: row.org_id };
  let sealed: SealedChatAlert;
  try {
    sealed = await deps.runtime.query<SealedChatAlert>('social.chat_alert.target', { alertId: row.alert_id }, options);
  } catch (error) {
    // The member who saved it is no longer an owner or admin, or it was removed since the scan: it reseals when saved again.
    if (error instanceof DomainError) return false;
    throw error;
  }
  const binding = { orgId: row.org_id, provider: CHAT_ALERT_PROVIDER, externalAccountId: sealed.id };
  const envelope = Buffer.from(sealed.envelope, 'base64');
  let secret: string | null = deps.broker.open({ keyId: sealed.keyId, envelope }, binding);
  const next = deps.broker.seal(secret, binding);
  secret = null;
  const stored = await deps.runtime.execute<{ resealed: boolean }>(
    'social.chat_alert.reseal',
    { alertId: sealed.id, fromKeyId: sealed.keyId, fromEnvelopeSha256: createHash('sha256').update(envelope).digest('hex'), keyId: next.keyId, envelope: next.envelope.toString('base64') },
    options,
  );
  return stored.resealed;
}
