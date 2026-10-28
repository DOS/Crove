// The relay's batches on PostgreSQL 17 with the vendored pg-boss schema (#1705): the outbox claim and the jobs it sends
// commit or roll back together (relayBatch, what the worker's relay runs). When one send of a batch fails, the claim
// rolls back with the jobs already sent, and the batch relayed again queues each job once, on a standard queue too,
// whose singleton key dedupes nothing. A per-type relay kill switch still holds its rows. Set CROVE_TEST_ADMIN_URL to
// a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { PgBoss } from 'pg-boss';
import { sql, type Transaction } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Database, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { JOB_SCHEMA, QUEUES } from '../src/jobs-schema.ts';
import { jobKey } from '../src/job-keys.ts';
import { relayBatch, type JobSender, type OutboxRow } from '../src/worker.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

const TYPE = 'test.relay.batch';
const HELD = 'test.relay.batch_held';
// A standard queue (no policy in QUEUE_POLICIES): pg-boss queues a second job with the same singleton key.
const STANDARD = QUEUES.notify;

suite('relay batches send on the claim transaction (#1705)', () => {
  const dbName = `crove_test_relay_batch_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appPool: pg.Pool;
  let workerPool: pg.Pool;
  let workerDb: Db;
  let boss: PgBoss;
  let orgId = '';

  const login = (user: string, password: string) => {
    const url = new URL(adminUrl);
    url.username = user;
    url.password = password;
    return url.toString();
  };
  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  // A pending outbox event of the given type, as crove_kernel.emit leaves it; returns its id.
  const add = (type: string) =>
    admin(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `WITH e AS (INSERT INTO crove_kernel.outbox_event (org_id, type, payload) VALUES ($1, $2, '{}') RETURNING org_id, id)
         INSERT INTO crove_kernel.outbox_pending (org_id, event_id) SELECT org_id, id FROM e RETURNING event_id AS id`,
        [orgId, type],
      );
      return rows[0]?.id as string;
    });
  const pending = () => admin(async (c) => (await c.query<{ id: string }>('SELECT event_id AS id FROM crove_kernel.outbox_pending ORDER BY seq')).rows.map((r) => r.id));
  const keyOf = (eventId: string) => jobKey(orgId, STANDARD, eventId);
  // The jobs queued under each key, of any state.
  const jobsFor = (eventIds: readonly string[]) =>
    admin(async (c) => {
      const { rows } = await c.query<{ key: string; n: number }>(
        `SELECT singleton_key AS key, count(*)::int AS n FROM ${JOB_SCHEMA}.job WHERE name = $1 AND singleton_key = ANY($2::text[]) GROUP BY 1`,
        [STANDARD, eventIds.map(keyOf)],
      );
      return Object.fromEntries(eventIds.map((id) => [id, rows.find((r) => r.key === keyOf(id))?.n ?? 0]));
    });
  const claim = async (trx: Transaction<Database>) => (await sql<OutboxRow>`SELECT * FROM crove_kernel.outbox_claim(100)`.execute(trx)).rows;
  // The relay's job for an event: one on the standard queue, keyed by the event as the relay keys its jobs.
  const send = (jobs: JobSender, row: OutboxRow) =>
    jobs.send(STANDARD, { orgId: row.org_id, eventId: row.event_id, type: row.type }, { singletonKey: keyOf(row.event_id), retryLimit: 0 });
  // Relays until a batch comes back short, sending nothing: the org's own events, so the outbox holds only a test's rows.
  const drain = async () => {
    for (let i = 0; i < 100; i++) if ((await relayBatch(workerDb, boss, async (trx) => (await claim(trx)).map(() => async () => null))) < 100) return;
    throw new Error('the outbox never drained');
  };

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    appPool = createPool({ connectionString: login('crove_app', 'test-app-pw'), max: 2 });
    const appDb = createDb(appPool);
    const runtime = new Runtime(appDb).register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) });
    const owner = await upsertIdentity(appDb, { issuer: 'relay-batch-test', subject: 'owner', email: 'owner@relay-batch.test', name: null });
    ({ orgId } = await createOrg(runtime, { type: 'user', userId: owner, aal: 'aal1' }, 'Relay batch test'));
    // The worker login, for the claim and for pg-boss, as the worker connects.
    workerPool = createPool({ connectionString: login('crove_worker', 'test-worker-pw'), max: 2 });
    workerDb = createDb(workerPool);
    boss = new PgBoss({ connectionString: login('crove_worker', 'test-worker-pw'), schema: JOB_SCHEMA, migrate: false, createSchema: false, supervise: false, schedule: false });
    boss.on('error', () => {});
    await boss.start();
  });

  afterAll(async () => {
    await boss?.stop({ graceful: false }).catch(() => {});
    await appPool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('queues a second job under the same key on a standard queue when sent outside a transaction', async () => {
    // Why the relay needs the transaction: the singleton key alone does not dedupe on this queue.
    const eventId = randomUUID();
    for (let i = 0; i < 2; i++) await boss.send(STANDARD, { orgId, eventId, type: TYPE }, { singletonKey: keyOf(eventId), retryLimit: 0 });
    expect(await jobsFor([eventId])).toEqual({ [eventId]: 2 });
  });

  // Three ways a batch fails after some of its jobs went out: pg-boss refuses a send before it reaches the database, an
  // insert fails and aborts the transaction, or the commit fails on a deferred check.
  const FAILURES: Array<[string, (jobs: JobSender, row: OutboxRow) => Promise<unknown>]> = [
    ['pg-boss refuses a send to a queue that does not exist', (jobs) => jobs.send('test-relay-missing-queue', {}, { retryLimit: 0 })],
    ['an insert fails in the database', (jobs, row) => jobs.send(STANDARD, { orgId, eventId: row.event_id }, { singletonKey: `${keyOf(row.event_id)}:x`, priority: 2 ** 31 })],
    [
      'a step swallows a failed insert',
      (jobs, row) => jobs.send(STANDARD, { orgId, eventId: row.event_id }, { singletonKey: `${keyOf(row.event_id)}:x`, priority: 2 ** 31 }).catch(() => null),
    ],
    [
      'the commit fails on the deferred dead letter check',
      (jobs, row) => jobs.send(STANDARD, { orgId, eventId: row.event_id }, { singletonKey: `${keyOf(row.event_id)}:x`, deadLetter: 'test-relay-missing-dlq' }),
    ],
  ];

  it.each(FAILURES)('rolls a batch back when %s, and the batch relayed again queues each job once', async (_, failing) => {
    await drain();
    const ids = [await add(TYPE), await add(TYPE), await add(TYPE)];
    const last = ids[ids.length - 1];

    // The first pass: every row's job is sent, then one more send of the last row fails after the others went out.
    let sentOthers!: () => void;
    const othersSent = new Promise<void>((resolve) => (sentOthers = resolve));
    let sentCount = 0;
    await expect(
      relayBatch(workerDb, boss, async (trx) =>
        (await claim(trx)).map((row) => async (jobs: JobSender) => {
          await send(jobs, row);
          if (++sentCount === ids.length) sentOthers();
          if (row.event_id !== last) return;
          await othersSent;
          await failing(jobs, row);
        }),
      ),
    ).rejects.toThrow();
    expect(sentCount).toBe(ids.length);
    // The claim rolled back with the jobs already sent: every row is pending again and no job is queued.
    expect(await pending()).toEqual(ids);
    expect(await jobsFor(ids)).toEqual(Object.fromEntries(ids.map((id) => [id, 0])));

    // The next pass relays the batch again: one job per row.
    expect(await relayBatch(workerDb, boss, async (trx) => (await claim(trx)).map((row) => (jobs: JobSender) => send(jobs, row)))).toBe(ids.length);
    expect(await pending()).toEqual([]);
    expect(await jobsFor(ids)).toEqual(Object.fromEntries(ids.map((id) => [id, 1])));
    // And a pass after that finds nothing to send.
    expect(await relayBatch(workerDb, boss, async (trx) => (await claim(trx)).map((row) => (jobs: JobSender) => send(jobs, row)))).toBe(0);
    expect(await jobsFor(ids)).toEqual(Object.fromEntries(ids.map((id) => [id, 1])));
  });

  it('refuses a job sent after its batch ended, so it never runs outside the transaction', async () => {
    await drain();
    const id = await add(TYPE);
    let late: Promise<unknown> | null = null;
    let release!: () => void;
    const later = new Promise<void>((resolve) => (release = resolve));
    // A step that leaves a send behind (a bug the relay must not turn into a job outside the transaction).
    expect(
      await relayBatch(workerDb, boss, async (trx) =>
        (await claim(trx)).map((row) => async (jobs: JobSender) => {
          late = later.then(() => send(jobs, row));
          late.catch(() => {});
        }),
      ),
    ).toBe(1);
    release();
    await expect(late).rejects.toThrow('relay batch closed');
    expect(await jobsFor([id])).toEqual({ [id]: 0 });
    expect(await pending()).toEqual([]);
  });

  it('keeps a per-type relay kill switch: the held rows stay pending and get no job until released', async () => {
    await drain();
    const set = (engaged: boolean) => admin((c) => c.query('SELECT crove_kernel.global_kill_switch_set($1, $2, $3, $4)', [`relay:${HELD}`, engaged, 'diễn tập', 'ops']));
    await set(true);
    const held = await add(HELD);
    const other = await add(TYPE);
    const relayed = () => relayBatch(workerDb, boss, async (trx) => (await claim(trx)).map((row) => (jobs: JobSender) => send(jobs, row)));
    expect(await relayed()).toBe(1);
    expect(await pending()).toEqual([held]);
    expect(await jobsFor([held, other])).toEqual({ [held]: 0, [other]: 1 });
    await set(false);
    expect(await relayed()).toBe(1);
    expect(await pending()).toEqual([]);
    expect(await jobsFor([held, other])).toEqual({ [held]: 1, [other]: 1 });
  });
});
