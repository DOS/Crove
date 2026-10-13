// Worker: relays the outbox into pg-boss queues and runs jobs.
import { sql } from 'kysely';
import pg from 'pg';
import { PgBoss } from 'pg-boss';
import type { Db } from '@crove/db';
import type { BlobStore, Runtime } from '@crove/kernel-runtime';
import type { InvoiceExtractor } from '@crove/agent';
import { extractAndPropose } from '@crove/mod-finance';

export const JOB_SCHEMA = 'crove_jobs';
export const QUEUES = { extract: 'finance-file-extract' } as const;

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
}

export async function startWorker(deps: WorkerDeps): Promise<() => Promise<void>> {
  const boss = new PgBoss({ connectionString: deps.connectionString, schema: JOB_SCHEMA, migrate: false, createSchema: false });
  boss.on('error', (error) => console.error('[pg-boss]', error));
  await boss.start();

  await boss.work<{ orgId: string; fileId: string }>(QUEUES.extract, { batchSize: 1 }, async ([job]) => {
    if (!job) return;
    await extractAndPropose({ runtime: deps.runtime, store: deps.store, extractor: deps.extractor }, job.data.orgId, job.data.fileId);
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
            rows
              .filter((row) => row.type === 'kernel.file.ingested')
              .map((row) => {
                const fileId = String(row.payload.fileId);
                return boss.send(
                  QUEUES.extract,
                  { orgId: row.org_id, fileId },
                  { singletonKey: `${row.org_id}:${fileId}`, retryLimit: 3, retryDelay: 20, retryBackoff: true },
                );
              }),
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
  console.log('[worker] started');

  return async () => {
    stopped = true;
    clearInterval(timer);
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
