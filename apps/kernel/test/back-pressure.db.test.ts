// Back-pressure (#894, plan §4.9) against a real PostgreSQL 17: the worker reads the outbox lag, and a lag over the
// threshold stops pg-boss fetching a paused queue until the outbox has caught up. The privilege checks are in the
// invariant suite (test/invariant/outbox-lag.db.test.ts). Set CROVE_TEST_ADMIN_URL to a superuser URL; the run creates
// and drops its own database.
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { PausableWork, checkBackPressure, outboxLagSeconds } from '../src/back-pressure.ts';
import { JOB_SCHEMA, QUEUES } from '../src/jobs-schema.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));

const suite = ADMIN ? describe : describe.skip;

suite('back-pressure on PostgreSQL (#894)', () => {
  const dbName = `crove_test_backpressure_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let workerPool: pg.Pool;
  let workerDb: Db;
  let appPool: pg.Pool;
  let orgId = '';

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  const login = (user: string, password: string) => {
    const url = new URL(adminUrl);
    url.username = user;
    url.password = password;
    return url.toString();
  };

  beforeAll(async () => {
    const base = new URL(ADMIN as string);
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    workerPool = createPool({ connectionString: login('crove_worker', 'test-worker-pw'), max: 2 });
    workerDb = createDb(workerPool);
    appPool = createPool({ connectionString: login('crove_app', 'test-app-pw'), max: 2 });
    const appDb = createDb(appPool);
    const runtime = new Runtime(appDb).register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) });
    const owner = await upsertIdentity(appDb, { issuer: 'backpressure-test', subject: 'owner', email: 'owner@backpressure.test', name: null });
    ({ orgId } = await createOrg(runtime, { type: 'user', userId: owner, aal: 'aal1' }, 'Back-pressure test'));
  });

  afterAll(async () => {
    await workerPool?.end();
    await appPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('reads 0 with nothing pending and the age of the oldest pending event otherwise', async () => {
    await admin((c) => c.query('DELETE FROM crove_kernel.outbox_pending'));
    expect(await outboxLagSeconds(workerDb)).toBe(0);
    await admin(async (c) => {
      for (const age of ['10 minutes', '2 minutes']) {
        await c.query(
          `WITH e AS (INSERT INTO crove_kernel.outbox_event (org_id, type, payload, created_at)
                      VALUES ($1, 'test.lag', '{}', now() - $2::interval) RETURNING org_id, id)
           INSERT INTO crove_kernel.outbox_pending (org_id, event_id) SELECT org_id, id FROM e`,
          [orgId, age],
        );
      }
    });
    const lag = await outboxLagSeconds(workerDb);
    expect(lag).toBeGreaterThanOrEqual(600);
    expect(lag).toBeLessThan(660);
  });

  it('stops a paused queue fetching while the outbox lags, and works it again once it has caught up', async () => {
    const boss = new PgBoss({ connectionString: adminUrl, schema: JOB_SCHEMA, migrate: false, supervise: false, schedule: false });
    await boss.start();
    try {
      const ran: string[] = [];
      const work = new PausableWork(boss);
      await work.add(QUEUES.agentSweep, () =>
        boss.work<{ tag: string }>(QUEUES.agentSweep, { batchSize: 1, pollingIntervalSeconds: 0.5 }, async ([job]) => {
          if (job) ran.push(job.data.tag);
        }),
      );
      const check = () => checkBackPressure({ work, readLagSeconds: () => outboxLagSeconds(workerDb), thresholdSeconds: 30, log: () => {} });
      const waitFor = async (tag: string) => {
        for (let i = 0; i < 40 && !ran.includes(tag); i++) await new Promise((resolve) => setTimeout(resolve, 250));
      };

      await boss.send(QUEUES.agentSweep, { tag: 'before' });
      await waitFor('before');
      expect(ran).toEqual(['before']);

      // The outbox from the test above is 10 minutes behind: paused.
      await check();
      expect(work.paused).toBe(true);
      await boss.send(QUEUES.agentSweep, { tag: 'during' });
      await new Promise((resolve) => setTimeout(resolve, 2000));
      expect(ran).toEqual(['before']);

      // The relay caught up: the queued job runs.
      await admin((c) => c.query('DELETE FROM crove_kernel.outbox_pending'));
      await check();
      expect(work.paused).toBe(false);
      await waitFor('during');
      expect(ran).toEqual(['before', 'during']);
    } finally {
      await boss.stop({ graceful: false });
    }
  });
});
