// Prober and alerting (plan §4.13, issue #39) against a real PostgreSQL 17: health() as crove_prober, the worker
// heartbeat, and a probe that delivers its alert to a real HTTP webhook. The privilege checks are in the invariant
// suite (test/invariant/prober.db.test.ts). Set CROVE_TEST_ADMIN_URL to a superuser URL; the run creates and drops
// its own database.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { EXIT, evaluateHealth, probeOnce, readHealth, runProber, type ProberConfig } from '../src/prober.ts';
import { JOB_SCHEMA, QUEUES, beat, migrateJobs } from '../src/worker.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const limits = { outboxAgeSeconds: 300, jobAgeSeconds: 900, heartbeatAgeSeconds: 120, deadLetters: 0, notifyQueuePercent: 50 };

const suite = ADMIN ? describe : describe.skip;

suite('prober on PostgreSQL', () => {
  const dbName = `crove_test_prober_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let proberUrl = '';
  let workerPool: pg.Pool;
  let workerDb: Db;
  let appPool: pg.Pool;
  let orgId = '';
  let hook: Server;
  let hookUrl = '';
  const received: Array<{ path: string; body: Record<string, unknown> }> = [];
  const quiet = { log: () => {}, error: () => {} };

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

  const proberConfig = (overrides: Partial<ProberConfig> = {}): ProberConfig => ({
    databaseUrl: proberUrl,
    webhookUrl: hookUrl,
    webhookFormat: 'generic',
    telegramChatId: undefined,
    repeatSeconds: 3600,
    instance: 'prober-test',
    thresholds: limits,
    deadLetterWindowSeconds: 3600,
    ...overrides,
  });

  beforeAll(async () => {
    const base = new URL(ADMIN as string);
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw', crove_prober: 'test-prober-pw' });
    proberUrl = login('crove_prober', 'test-prober-pw');
    workerPool = createPool({ connectionString: login('crove_worker', 'test-worker-pw'), max: 2 });
    workerDb = createDb(workerPool);
    appPool = createPool({ connectionString: login('crove_app', 'test-app-pw'), max: 2 });
    const appDb = createDb(appPool);
    const runtime = new Runtime(appDb).register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) });
    const owner = await upsertIdentity(appDb, { issuer: 'prober-test', subject: 'owner', email: 'owner@prober.test', name: null });
    ({ orgId } = await createOrg(runtime, { type: 'user', userId: owner, aal: 'aal1' }, 'Prober test'));

    hook = createServer((req, res) => {
      let data = '';
      req.on('data', (chunk) => (data += chunk));
      req.on('end', () => {
        received.push({ path: req.url ?? '', body: JSON.parse(data) as Record<string, unknown> });
        res.writeHead(200).end('ok');
      });
    });
    await new Promise<void>((resolve) => hook.listen(0, '127.0.0.1', resolve));
    hookUrl = `http://127.0.0.1:${(hook.address() as AddressInfo).port}/hook/secret`;
  });

  afterAll(async () => {
    await workerPool?.end();
    await appPool?.end();
    await new Promise<void>((resolve) => (hook ? hook.close(() => resolve()) : resolve()));
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('reports a missing job schema and a missing heartbeat before the worker ever ran', async () => {
    const health = await readHealth(proberUrl, 3600);
    expect(health).toMatchObject({
      outbox_pending: 0,
      outbox_oldest_age_seconds: null,
      inbound_pending: 0,
      inbound_oldest_age_seconds: null,
      jobs_schema_present: false,
      jobs_queued: null,
      job_oldest_queued_age_seconds: null,
      dead_letter_count: null,
      worker_heartbeat_age_seconds: null,
      // pg_notification_queue_usage(), which crove_prober may call like any core function (issue #281).
      notify_queue_usage: 0,
    });
    expect(evaluateHealth(health, limits, 3600).map((f) => f.check)).toEqual(['jobs_schema', 'heartbeat']);
  });

  it('is healthy once the job schema exists, the relay is current and the worker beats', async () => {
    await migrateJobs(adminUrl);
    await beat(workerDb, 'worker-a');
    const health = await readHealth(proberUrl, 3600);
    expect(health).toMatchObject({ outbox_pending: 0, outbox_oldest_age_seconds: null, jobs_schema_present: true, jobs_queued: 0, dead_letter_count: 0 });
    expect(health.worker_heartbeat_age_seconds).toBeGreaterThanOrEqual(0);
    expect(health.worker_heartbeat_age_seconds).toBeLessThan(5);
    expect(await probeOnce(proberConfig(), quiet)).toBe(EXIT.ok);
    expect(received).toEqual([]);
  });

  it('measures the relay backlog, queued jobs, dead letters and heartbeats', async () => {
    await admin(async (c) => {
      await c.query(
        `WITH e AS (INSERT INTO crove_kernel.outbox_event (org_id, type, payload, created_at)
                    VALUES ($1, 'test.health', '{}', now() - interval '10 minutes') RETURNING org_id, id)
         INSERT INTO crove_kernel.outbox_pending (org_id, event_id) SELECT org_id, id FROM e`,
        [orgId],
      );
      await c.query(
        `INSERT INTO crove_kernel.inbound_pending (blob_id, raw_sha256, size_bytes, received_at)
         VALUES (repeat('a', 64), repeat('b', 64), 10, now() - interval '20 minutes')`,
      );
    });
    const boss = new PgBoss({ connectionString: adminUrl, schema: JOB_SCHEMA, migrate: false, supervise: false, schedule: false });
    boss.on('error', () => {});
    await boss.start();
    const late = await boss.send(QUEUES.extract, { orgId, fileId: 'late' });
    const fresh = await boss.send(QUEUES.extract, { orgId, fileId: 'fresh' });
    const deadNow = await boss.send(QUEUES.inbound, { blobId: 'dead-now' });
    const deadOld = await boss.send(QUEUES.inbound, { blobId: 'dead-old' });
    const notDue = await boss.send(QUEUES.signOut, { sessionId: 'later' }, { startAfter: 3600 });
    await boss.stop({ graceful: false });
    await admin(async (c) => {
      await c.query(`UPDATE ${JOB_SCHEMA}.job SET start_after = now() - interval '20 minutes' WHERE id = $1`, [late]);
      await c.query(`UPDATE ${JOB_SCHEMA}.job SET state = 'failed', completed_on = now() - interval '30 seconds' WHERE id = $1`, [deadNow]);
      await c.query(`UPDATE ${JOB_SCHEMA}.job SET state = 'failed', completed_on = now() - interval '2 hours' WHERE id = $1`, [deadOld]);
      // A beat from another instance, long ago: the freshest heartbeat counts.
      await c.query(`INSERT INTO crove_kernel.worker_heartbeat (instance, beat_at) VALUES ('worker-old', now() - interval '1 day')`);
    });
    expect([late, fresh, notDue].every(Boolean)).toBe(true);

    const health = await readHealth(proberUrl, 3600);
    expect(health).toMatchObject({ outbox_pending: 1, inbound_pending: 1, jobs_queued: 2, dead_letter_count: 1 });
    expect(health.outbox_oldest_age_seconds).toBeGreaterThanOrEqual(600);
    expect(health.inbound_oldest_age_seconds).toBeGreaterThanOrEqual(1200);
    expect(health.job_oldest_queued_age_seconds).toBeGreaterThanOrEqual(1200);
    expect(health.worker_heartbeat_age_seconds).toBeLessThan(60);
    // A wider window counts the older dead letter too; the window is clamped to at least 60 s.
    expect((await readHealth(proberUrl, 3 * 3600)).dead_letter_count).toBe(2);
    expect((await readHealth(proberUrl, 1)).dead_letter_count).toBe(1);

    // The worker stops beating.
    await admin((c) => c.query(`UPDATE crove_kernel.worker_heartbeat SET beat_at = now() - interval '10 minutes' WHERE instance = 'worker-a'`));
    const stale = await readHealth(proberUrl, 3600);
    expect(stale.worker_heartbeat_age_seconds).toBeGreaterThanOrEqual(600);
    expect(evaluateHealth(stale, limits, 3600).map((f) => f.check)).toEqual(['outbox', 'inbound', 'job_age', 'dead_letters', 'heartbeat']);
  });

  it('delivers the alert to the webhook and exits 1', async () => {
    received.length = 0;
    expect(await probeOnce(proberConfig(), quiet)).toBe(EXIT.unhealthy);
    expect(received).toHaveLength(1);
    expect(received[0]?.path).toBe('/hook/secret');
    const body = received[0]?.body as { text: string; crove: { kind: string; findings: Array<{ check: string }>; health: Record<string, unknown> } };
    expect(body.text).toMatch(/^\[Crove\] ALERT on prober-test: 5 health check\(s\) failed\./);
    expect(body.crove.kind).toBe('alert');
    expect(body.crove.findings.map((f) => f.check)).toEqual(['outbox', 'inbound', 'job_age', 'dead_letters', 'heartbeat']);
    // Aggregates only: no org id or payload leaves the database.
    expect(JSON.stringify(body)).not.toContain(orgId);
    expect(Object.keys(body.crove.health).sort()).toEqual([
      'checked_at',
      'dead_letter_count',
      'inbound_oldest_age_seconds',
      'inbound_pending',
      'job_oldest_queued_age_seconds',
      'jobs_queued',
      'jobs_schema_present',
      'notify_queue_usage',
      'outbox_oldest_age_seconds',
      'outbox_pending',
      'worker_heartbeat_age_seconds',
    ]);
  });

  it('sends a test alert that reaches the webhook', async () => {
    received.length = 0;
    expect(await runProber(['--test-alert'], { ALERT_WEBHOOK_URL: hookUrl, ALERT_INSTANCE: 'office' }, quiet)).toBe(EXIT.ok);
    expect(received).toEqual([
      {
        path: '/hook/secret',
        body: { text: '[Crove] Test alert from office: alert delivery works.', content: '[Crove] Test alert from office: alert delivery works.', crove: expect.objectContaining({ kind: 'test', severity: 'info' }) },
      },
    ]);
  });

  it('exits 2 and alerts when the database refuses the login, and refuses to probe as a superuser', async () => {
    received.length = 0;
    expect(await probeOnce(proberConfig({ databaseUrl: login('crove_prober', 'wrong-password') }), quiet)).toBe(EXIT.probeFailed);
    expect(received[0]?.body).toMatchObject({ crove: { kind: 'alert', findings: [{ check: 'probe' }] } });
    await expect(readHealth(adminUrl, 3600)).rejects.toThrow(/refusing to probe as .*connect PROBER_DATABASE_URL as crove_prober/);
  });
});
