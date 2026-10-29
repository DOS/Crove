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
import { AVAILABLE_MODULES } from '../src/config.ts';
import { EXIT, evaluateHealth, probeOnce, readHealth, runProber, type ProberConfig } from '../src/prober.ts';
import { JOB_SCHEMA, QUEUES } from '../src/jobs-schema.ts';
import { beat } from '../src/worker.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const limits = { outboxAgeSeconds: 300, jobAgeSeconds: 900, heartbeatAgeSeconds: 120, deadLetters: 0, notifyQueuePercent: 50 };
const ALL_MODULES = [...AVAILABLE_MODULES];

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
    const runtime = new Runtime(appDb, { manifests: TEST_MANIFESTS }).register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) });
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

  it('reports a missing heartbeat before the worker ever ran; the job schema comes with the migrations', async () => {
    const health = await readHealth(proberUrl, 3600);
    expect(health).toMatchObject({
      outbox_pending: 0,
      outbox_oldest_age_seconds: null,
      inbound_pending: 0,
      inbound_oldest_age_seconds: null,
      jobs_schema_present: true,
      jobs_queued: 0,
      job_oldest_queued_age_seconds: null,
      dead_letter_count: 0,
      worker_heartbeat_age_seconds: null,
      // pg_notification_queue_usage(), which crove_prober may call like any core function (issue #281).
      notify_queue_usage: 0,
    });
    expect(evaluateHealth(health, limits, 3600).map((f) => f.check)).toEqual(['heartbeat']);
  });

  it('reports a missing job schema', async () => {
    // The vendored migration creates crove_jobs (#25); hide it to see what an incomplete migrate looks like.
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      await admin.query(`ALTER SCHEMA ${JOB_SCHEMA} RENAME TO ${JOB_SCHEMA}_hidden`);
      const health = await readHealth(proberUrl, 3600);
      expect(health).toMatchObject({ jobs_schema_present: false, jobs_queued: null, job_oldest_queued_age_seconds: null, dead_letter_count: null });
      expect(evaluateHealth(health, limits, 3600).map((f) => f.check)).toEqual(['jobs_schema', 'heartbeat']);
    } finally {
      await admin.query(`ALTER SCHEMA ${JOB_SCHEMA}_hidden RENAME TO ${JOB_SCHEMA}`);
      await admin.end();
    }
  });

  it('is healthy once the relay is current and the worker beats', async () => {
    await beat(workerDb, 'worker-a', ALL_MODULES);
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

  // #1877: a module left out (CROVE_MODULES) has its queues worked by nobody; its queued jobs stay for when it is
  // installed again, and the prober does not read them as stuck workers. #1887: a worker that died without a clean
  // stop keeps its modules counted for 7 days, whatever the other workers work.
  it('ages only the queues of the modules a worker of the last 7 days works, until it stops cleanly', async () => {
    const queued = async () => {
      const h = await readHealth(proberUrl, 3600);
      return { jobs: h.jobs_queued, aged: h.job_oldest_queued_age_seconds !== null && h.job_oldest_queued_age_seconds >= 1200 };
    };
    // The finance extraction jobs of the test above wait; worker-a now works the kernel alone.
    await beat(workerDb, 'worker-a', ['kernel']);
    expect(await queued()).toEqual({ jobs: 0, aged: false });
    // A second worker that works finance counts them again.
    await beat(workerDb, 'worker-b', ['kernel', 'finance']);
    expect(await queued()).toEqual({ jobs: 2, aged: true });
    // It dies (no clean stop) while worker-a keeps beating: its finance queues still count, for 7 days (#1887).
    await admin((c) => c.query(`UPDATE crove_kernel.worker_heartbeat SET beat_at = now() - interval '6 days' WHERE instance = 'worker-b'`));
    expect(await queued()).toEqual({ jobs: 2, aged: true });
    expect((await readHealth(proberUrl, 3600)).worker_heartbeat_age_seconds).toBeLessThan(60);
    await admin((c) => c.query(`UPDATE crove_kernel.worker_heartbeat SET beat_at = now() - interval '8 days' WHERE instance = 'worker-b'`));
    expect(await queued()).toEqual({ jobs: 0, aged: false });
    // A clean stop (the worker's last beat records no modules) drops them out at once.
    await beat(workerDb, 'worker-b', ['kernel', 'finance']);
    expect(await queued()).toEqual({ jobs: 2, aged: true });
    await beat(workerDb, 'worker-b', []);
    expect(await queued()).toEqual({ jobs: 0, aged: false });
    // #1894: worker-b was the only finance replica and its replacement never beats, while worker-a (kernel only) keeps
    // the heartbeat fresh. The prober names the modules the deployment runs, so finance counts whatever the workers
    // record; a name the setting adds that no queue has, or a deployment without finance, changes nothing.
    const expecting = async (modules: string[]) => {
      const h = await readHealth(proberUrl, 3600, modules);
      return { jobs: h.jobs_queued, aged: h.job_oldest_queued_age_seconds !== null && h.job_oldest_queued_age_seconds >= 1200 };
    };
    expect(await expecting(['kernel', 'finance'])).toEqual({ jobs: 2, aged: true });
    expect(await expecting(['kernel', 'social', 'bogus', ''])).toEqual({ jobs: 0, aged: false });
    expect(await expecting([])).toEqual({ jobs: 0, aged: false });
    // Every worker stopped cleanly: no module is recorded, so every queue counts (the heartbeat alert fires too).
    await beat(workerDb, 'worker-a', []);
    expect(await queued()).toEqual({ jobs: 2, aged: true });
    await beat(workerDb, 'worker-a', ['kernel']);
    await admin((c) => c.query(`DELETE FROM crove_kernel.worker_heartbeat WHERE instance = 'worker-b'`));
    expect(await queued()).toEqual({ jobs: 0, aged: false });
    // A live worker of an older release, which records no modules: every queue counts, as before.
    await admin((c) => c.query(`INSERT INTO crove_kernel.worker_heartbeat (instance, beat_at) VALUES ('worker-legacy', now())`));
    expect(await queued()).toEqual({ jobs: 2, aged: true });
    // An older release on the same host (a rollback) beats through worker_beat(text): its row loses the modules this
    // release recorded, so every queue counts (Codex review).
    await admin((c) => c.query(`DELETE FROM crove_kernel.worker_heartbeat WHERE instance = 'worker-legacy'`));
    expect(await queued()).toEqual({ jobs: 0, aged: false });
    const worker = new pg.Client({ connectionString: login('crove_worker', 'test-worker-pw') });
    await worker.connect();
    try {
      await worker.query(`SELECT crove_kernel.worker_beat('worker-a')`);
    } finally {
      await worker.end();
    }
    expect(await queued()).toEqual({ jobs: 2, aged: true });
    await beat(workerDb, 'worker-a', ['kernel']);
    await admin((c) => c.query(`INSERT INTO crove_kernel.worker_heartbeat (instance, beat_at) VALUES ('worker-legacy', now())`));
    // Silent for over an hour, it no longer counts; nor does the day-old 'worker-old' (also without modules).
    await admin((c) => c.query(`UPDATE crove_kernel.worker_heartbeat SET beat_at = now() - interval '2 hours' WHERE instance = 'worker-legacy'`));
    expect(await queued()).toEqual({ jobs: 0, aged: false });
    // Nothing was deleted: the jobs are still there.
    const [left] = await admin(async (c) => (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${JOB_SCHEMA}.job WHERE name = $1 AND state = 'created'`, [QUEUES.extract])).rows);
    expect(left?.n).toBe(2);
    // Module names are checked, and only the worker login records them.
    await expect(beat(workerDb, 'worker-a', ['Finance'])).rejects.toMatchObject({ code: '22023' });
    const prober = new pg.Client({ connectionString: proberUrl });
    await prober.connect();
    try {
      await expect(prober.query(`SELECT crove_kernel.worker_beat('x', ARRAY['kernel'])`)).rejects.toMatchObject({ code: '42501' });
    } finally {
      await prober.end();
    }
    // As the test above left it: worker-a works every module and stopped beating ten minutes ago.
    await beat(workerDb, 'worker-a', ALL_MODULES);
    await admin(async (c) => {
      await c.query(`DELETE FROM crove_kernel.worker_heartbeat WHERE instance = 'worker-legacy'`);
      await c.query(`UPDATE crove_kernel.worker_heartbeat SET beat_at = now() - interval '10 minutes' WHERE instance = 'worker-a'`);
    });
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
