// Worker: relays the outbox into pg-boss queues and runs jobs.
import { hostname } from 'node:os';
import { sql } from 'kysely';
import pg from 'pg';
import { PgBoss } from 'pg-boss';
import type { Db } from '@crove/db';
import { DomainError, inboundKey, type BlobStore, type Runtime } from '@crove/kernel-runtime';
import type { InvoiceExtractor } from '@crove/agent';
import type { ExtractClient } from '@crove/extract-contract';
import { extractAndPropose, recordExtractionFailure } from '@crove/mod-finance';
import { processInboundEmail, type InboundJob } from './inbound.ts';
import type { SessionRevoker, SignOutTarget } from './sessions.ts';

export const JOB_SCHEMA = 'crove_jobs';
export const QUEUES = { extract: 'finance-file-extract', inbound: 'kernel-inbound-email', signOut: 'kernel-session-signout' } as const;
const EXTRACT_RETRY_LIMIT = 3;
const INBOUND_RETRY_LIMIT = 3;
const SIGN_OUT_RETRY_LIMIT = 5;
// The prober alerts when the freshest heartbeat is older than PROBER_MAX_HEARTBEAT_AGE_SECONDS (default 120).
export const HEARTBEAT_INTERVAL_MS = 30_000;

interface InboundRow {
  seq: string;
  blob_id: string;
  raw_sha256: string;
  size_bytes: string;
  recipient: string;
}

interface ExtractJob {
  orgId: string;
  fileId: string;
  version?: number;
}

interface OutboxRow {
  seq: string;
  org_id: string;
  event_id: string;
  type: string;
  payload: Record<string, unknown>;
}

export interface WorkerDeps {
  connectionString: string;
  workerDb: Db;
  runtime: Runtime;
  store: BlobStore;
  extractor: InvoiceExtractor | null;
  // crove-extract (plan §7.6): every PDF, XML and MIME parse happens there, never in this process.
  extract: ExtractClient;
  inboundDomain: string | null;
  // Supabase Auth sign-out after a Crove-side revoke (ADR-0028 section 4); null keeps revocation Crove-side only.
  revoker?: SessionRevoker | null;
  // Names this worker in crove_kernel.worker_heartbeat (default: the host name, the container id under Docker).
  instance?: string;
}

/** Records that this worker is alive (crove_kernel.worker_beat, crove_worker only). */
export async function beat(workerDb: Db, instance: string): Promise<void> {
  await sql`SELECT crove_kernel.worker_beat(${instance.slice(0, 128)})`.execute(workerDb);
}

export async function startWorker(deps: WorkerDeps): Promise<() => Promise<void>> {
  const boss = new PgBoss({ connectionString: deps.connectionString, schema: JOB_SCHEMA, migrate: false, createSchema: false });
  boss.on('error', (error) => console.error('[pg-boss]', error));
  await boss.start();

  // version: a requested re-extraction (kernel.file.reextract_requested); absent for the first read of a new file.
  await boss.work<ExtractJob>(QUEUES.extract, { batchSize: 1 }, async ([job]) => {
    if (!job) return;
    const { orgId, fileId, version } = job.data;
    try {
      await extractAndPropose({ runtime: deps.runtime, store: deps.store, extractor: deps.extractor, extract: deps.extract }, orgId, fileId, version);
    } catch (error) {
      console.error(`[extract] file ${fileId}${version ? ` version ${version}` : ''} attempt ${job.retryCount + 1}`, error);
      if (job.retryCount < EXTRACT_RETRY_LIMIT) throw error;
      await recordExtractionFailure(
        deps.runtime,
        orgId,
        fileId,
        'Không đọc được chứng từ sau nhiều lần thử; hãy kiểm tra cấu hình AI hoặc gửi tệp XML',
        version,
      );
    }
  });

  // The raw message is deleted once it is filed or dropped; after the last failed attempt it is kept for
  // investigation (each delivery owns its blob, so no other job can still need it).
  await boss.work<InboundJob>(QUEUES.inbound, { batchSize: 1 }, async ([job]) => {
    if (!job) return;
    const label = job.data.sha256.slice(0, 12);
    try {
      const result = await processInboundEmail(
        { runtime: deps.runtime, store: deps.store, domain: deps.inboundDomain, extract: deps.extract },
        job.data,
        job.retryCount,
      );
      console.log(`[inbound] message ${label}: ${result.duplicate ? 'duplicate' : `${result.fileIds.length} file(s)`}`);
    } catch (error) {
      // A message no org can receive (unknown or closed recipient, invalid content) is dropped, not retried.
      if (!(error instanceof DomainError && error.status !== 409 && error.status < 500)) {
        console.error(`[inbound] message ${label} attempt ${job.retryCount + 1}`, error);
        throw error;
      }
      console.warn(`[inbound] message ${label} dropped: ${error.code}`);
    }
    await deps.store.delete(inboundKey(job.data.blobId));
  });

  // Best effort: the revoked record already blocks the session in Crove. Retried with backoff; the last failure
  // is logged as an error for the operator, because the session's refresh tokens then live on upstream.
  await boss.work<SignOutTarget>(QUEUES.signOut, { batchSize: 1 }, async ([job]) => {
    if (!job) return;
    const label = job.data.sessionId.slice(0, 8);
    if (!deps.revoker) {
      console.warn(`[signout] session ${label}: no Supabase Auth sign-out configured; revoked in Crove only`);
      return;
    }
    try {
      await deps.revoker.signOut(job.data);
      console.log(`[signout] session ${label} signed out in Supabase Auth`);
    } catch (error) {
      if (job.retryCount < SIGN_OUT_RETRY_LIMIT) throw error;
      console.error(`[signout] ALERT session ${label}: Supabase Auth sign-out failed after ${job.retryCount + 1} attempts; revoked in Crove only`, error);
    }
  });

  let running = false;
  let stopped = false;
  const relay = async () => {
    if (running || stopped) return;
    running = true;
    try {
      for (;;) {
        const sent = await deps.workerDb.transaction().execute(async (trx) => {
          const { rows } = await sql<OutboxRow>`SELECT * FROM crove_kernel.outbox_claim(100)`.execute(trx);
          // A failed send rolls back the claim; singletonKey makes the retry idempotent.
          await Promise.all(
            rows.map((row) => {
              if (row.type === 'kernel.file.ingested') {
                const fileId = String(row.payload.fileId);
                return boss.send(
                  QUEUES.extract,
                  { orgId: row.org_id, fileId },
                  { singletonKey: `${row.org_id}:${fileId}`, retryLimit: EXTRACT_RETRY_LIMIT, retryDelay: 20, retryBackoff: true },
                );
              }
              if (row.type === 'kernel.file.reextract_requested') {
                const fileId = String(row.payload.fileId);
                const version = Number(row.payload.version);
                if (!Number.isInteger(version) || version < 1) return null;
                return boss.send(
                  QUEUES.extract,
                  { orgId: row.org_id, fileId, version } satisfies ExtractJob,
                  { singletonKey: `${row.org_id}:${fileId}:${version}`, retryLimit: EXTRACT_RETRY_LIMIT, retryDelay: 20, retryBackoff: true },
                );
              }
              if (row.type === 'kernel.session.revoked') {
                const target: SignOutTarget = {
                  subject: String(row.payload.subject),
                  sessionId: String(row.payload.sessionId),
                  scope: row.payload.scope === 'global' ? 'global' : 'local',
                };
                return boss.send(QUEUES.signOut, target, {
                  singletonKey: `${target.sessionId}:${target.scope}`,
                  retryLimit: SIGN_OUT_RETRY_LIMIT,
                  retryDelay: 10,
                  retryBackoff: true,
                });
              }
              return null;
            }),
          );
          return rows.length;
        });
        if (sent < 100) break;
      }
      for (;;) {
        const sent = await deps.workerDb.transaction().execute(async (trx) => {
          const { rows } = await sql<InboundRow>`SELECT * FROM crove_kernel.inbound_claim(100)`.execute(trx);
          await Promise.all(
            rows.map((row) =>
              boss.send(
                QUEUES.inbound,
                {
                  blobId: row.blob_id,
                  sha256: row.raw_sha256,
                  sizeBytes: Number(row.size_bytes),
                  recipient: row.recipient || null,
                } satisfies InboundJob,
                { singletonKey: row.blob_id, retryLimit: INBOUND_RETRY_LIMIT, retryDelay: 20, retryBackoff: true },
              ),
            ),
          );
          return rows.length;
        });
        if (sent < 100) break;
      }
    } catch (error) {
      console.error('[relay]', error);
    } finally {
      running = false;
    }
  };

  const listener = new pg.Client({ connectionString: deps.connectionString, application_name: 'crove-relay-listen' });
  // Without a handler a dropped connection would crash the process; the 1 s timer keeps draining the outbox.
  listener.on('error', (error) => console.error('[relay] listen connection lost', error.message));
  await listener.connect();
  await listener.query('LISTEN crove_outbox');
  listener.on('notification', () => void relay());
  const timer = setInterval(() => void relay(), 1000);
  void relay();
  const instance = deps.instance ?? hostname();
  const heartbeat = () => beat(deps.workerDb, instance).catch((error) => console.error('[heartbeat]', error));
  const heartbeatTimer = setInterval(() => void heartbeat(), HEARTBEAT_INTERVAL_MS);
  await heartbeat();
  console.log('[worker] started');

  return async () => {
    stopped = true;
    clearInterval(timer);
    clearInterval(heartbeatTimer);
    await listener.end().catch(() => {});
    await boss.stop({ graceful: true, timeout: 10_000 }).catch(() => {});
  };
}

// Creates the pg-boss schema and queues with an admin connection, then grants the worker role.
export async function migrateJobs(adminUrl: string): Promise<void> {
  const boss = new PgBoss({ connectionString: adminUrl, schema: JOB_SCHEMA, migrate: true, supervise: false, schedule: false });
  boss.on('error', (error) => console.error('[pg-boss migrate]', error));
  await boss.start();
  for (const queue of Object.values(QUEUES)) await boss.createQueue(queue);
  await boss.stop({ graceful: false });
  const client = new pg.Client({ connectionString: adminUrl, application_name: 'crove-migrate' });
  await client.connect();
  try {
    await client.query(`
      GRANT USAGE ON SCHEMA ${JOB_SCHEMA} TO crove_worker;
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${JOB_SCHEMA} TO crove_worker;
      GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${JOB_SCHEMA} TO crove_worker;
      GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${JOB_SCHEMA} TO crove_worker;
      ALTER DEFAULT PRIVILEGES IN SCHEMA ${JOB_SCHEMA} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO crove_worker;
    `);
  } finally {
    await client.end();
  }
}
