// Prober alert de-duplication (issue #151) against a real PostgreSQL 17: crove_kernel.prober_alert_gate() as the
// crove_prober login, state that survives a restart, and two probers that never both send. The privilege checks are
// in the invariant suite (test/invariant/prober.db.test.ts). Set CROVE_TEST_ADMIN_URL to a superuser URL; the run
// creates and drops its own database.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { pgAlertGate } from '../src/alert-gate.ts';
import { EXIT, probeOnce, type HealthSnapshot, type ProberConfig } from '../src/prober.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));

const suite = ADMIN ? describe : describe.skip;

const healthy: HealthSnapshot = {
  checked_at: '2026-10-16 12:00:00+00',
  outbox_pending: 0,
  outbox_oldest_age_seconds: null,
  inbound_pending: 0,
  inbound_oldest_age_seconds: null,
  jobs_schema_present: true,
  jobs_queued: 0,
  job_oldest_queued_age_seconds: null,
  dead_letter_count: 0,
  worker_heartbeat_age_seconds: 12,
  notify_queue_usage: 0,
  archive_verify_age_seconds: null,
  archive_lag_seconds: null,
};
const workerDown = { ...healthy, worker_heartbeat_age_seconds: 900 };

suite('prober alert state on PostgreSQL', () => {
  const dbName = `crove_test_alert_dedup_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let proberUrl = '';
  let hook: Server;
  let hookUrl = '';
  let hookDelayMs = 0;
  const received: string[] = [];

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }
  const state = () =>
    admin(async (c) => (await c.query('SELECT problem, started_at, notified_at FROM crove_kernel.prober_alert_state')).rows as Array<{ problem: string | null; started_at: Date | null; notified_at: Date | null }>);
  const rewind = (minutes: number) =>
    admin((c) => c.query(`UPDATE crove_kernel.prober_alert_state SET notified_at = notified_at - make_interval(mins => $1), started_at = started_at - make_interval(mins => $1)`, [minutes]));
  const reset = () => admin((c) => c.query('UPDATE crove_kernel.prober_alert_state SET problem = NULL, started_at = NULL, notified_at = NULL'));

  const config = (): ProberConfig => ({
    databaseUrl: proberUrl,
    webhookUrl: hookUrl,
    webhookFormat: 'generic',
    telegramChatId: undefined,
    repeatSeconds: 3600,
    instance: 'dedup-test',
    thresholds: { outboxAgeSeconds: 300, jobAgeSeconds: 900, heartbeatAgeSeconds: 120, deadLetters: 0, notifyQueuePercent: 50 },
    deadLetterWindowSeconds: 360,
  });

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw', crove_prober: 'test-prober-pw' });
    const url = new URL(adminUrl);
    url.username = 'crove_prober';
    url.password = 'test-prober-pw';
    proberUrl = url.toString();

    hook = createServer((req, res) => {
      let data = '';
      req.on('data', (chunk) => (data += chunk));
      req.on('end', () => {
        setTimeout(() => {
          received.push((JSON.parse(data) as { text: string }).text);
          res.writeHead(200).end('ok');
        }, hookDelayMs);
      });
    });
    await new Promise<void>((resolve) => hook.listen(0, '127.0.0.1', resolve));
    hookUrl = `http://127.0.0.1:${(hook.address() as AddressInfo).port}/hook/secret`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => (hook ? hook.close(() => resolve()) : resolve()));
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('starts healthy with one seeded row', async () => {
    expect(await state()).toEqual([{ problem: null, started_at: null, notified_at: null }]);
  });

  it('walks new, suppressed, repeat, changed and resolved as crove_prober, and keeps the state across gates (restarts)', async () => {
    const decide = async (problem: string | null, repeatSeconds = 3600) => {
      // A fresh gate each time, like a fresh process.
      const gate = pgAlertGate(proberUrl, repeatSeconds);
      const result = await gate.decide(problem, new Date());
      await gate.settle(true);
      return result;
    };
    expect((await decide(null)).decision).toBe('healthy');
    const created = await decide('heartbeat');
    expect(created).toMatchObject({ decision: 'new', previousProblem: null, problemSince: null });
    const [afterNew] = await state();
    expect(afterNew?.problem).toBe('heartbeat');
    expect(afterNew?.started_at).toBeInstanceOf(Date);

    const again = await decide('heartbeat');
    expect(again).toMatchObject({ decision: 'suppressed', previousProblem: 'heartbeat', problemSince: afterNew?.started_at, lastNotifiedAt: afterNew?.notified_at });
    await rewind(59);
    expect((await decide('heartbeat')).decision).toBe('suppressed');
    await rewind(1);
    expect((await decide('heartbeat')).decision).toBe('repeat');
    expect((await decide('heartbeat')).decision).toBe('suppressed');
    // 0 never repeats; a short interval is clamped to a minute.
    await rewind(60 * 24);
    expect((await decide('heartbeat', 0)).decision).toBe('suppressed');
    expect((await decide('heartbeat', 1)).decision).toBe('repeat');
    expect((await decide('heartbeat', 1)).decision).toBe('suppressed');

    const changed = await decide('heartbeat,outbox');
    expect(changed).toMatchObject({ decision: 'changed', previousProblem: 'heartbeat' });
    const resolved = await decide(null);
    expect(resolved).toMatchObject({ decision: 'resolved', previousProblem: 'heartbeat,outbox' });
    expect(resolved.problemSince?.getTime()).toBeLessThan(Date.now() - 24 * 3600_000);
    expect((await state())[0]).toMatchObject({ problem: null, started_at: null });
    expect((await decide(null)).decision).toBe('healthy');
  });

  it('forgets a decision whose delivery failed, so the next probe sends it again', async () => {
    await reset();
    const first = pgAlertGate(proberUrl, 3600);
    expect((await first.decide('dead_letters', new Date())).decision).toBe('new');
    await first.settle(false);
    expect(await state()).toEqual([{ problem: null, started_at: null, notified_at: null }]);
    const second = pgAlertGate(proberUrl, 3600);
    expect((await second.decide('dead_letters', new Date())).decision).toBe('new');
    await second.settle(true);
  });

  it('tells a second prober "busy" while the first one is delivering, and it sees the result afterwards', async () => {
    await reset();
    const a = pgAlertGate(proberUrl, 3600);
    const b = pgAlertGate(proberUrl, 3600);
    expect((await a.decide('heartbeat', new Date())).decision).toBe('new');
    const started = Date.now();
    expect(await b.decide('heartbeat', new Date())).toEqual({ decision: 'busy', previousProblem: null, problemSince: null, lastNotifiedAt: null });
    // SKIP LOCKED: the second prober does not wait for the first.
    expect(Date.now() - started).toBeLessThan(2000);
    await b.settle(true);
    await a.settle(true);
    const c = pgAlertGate(proberUrl, 3600);
    expect((await c.decide('heartbeat', new Date())).decision).toBe('suppressed');
    await c.settle(true);
  });

  it('two probers probing at once send one alert, and one resolved notice', async () => {
    await reset();
    received.length = 0;
    hookDelayMs = 500;
    const quiet = { log: () => {}, error: () => {} };
    const probe = (health: HealthSnapshot) => probeOnce(config(), { ...quiet, readHealth: async () => health });
    try {
      expect(await Promise.all([probe(workerDown), probe(workerDown)])).toEqual([EXIT.unhealthy, EXIT.unhealthy]);
      expect(received).toHaveLength(1);
      expect(received[0]).toMatch(/^\[Crove\] ALERT on dedup-test: 1 health check\(s\) failed\./);
      // Later probes of the same problem stay quiet, then it resolves once.
      expect(await Promise.all([probe(workerDown), probe(workerDown)])).toEqual([EXIT.unhealthy, EXIT.unhealthy]);
      expect(received).toHaveLength(1);
      expect(await Promise.all([probe(healthy), probe(healthy)])).toEqual([EXIT.ok, EXIT.ok]);
      expect(received).toHaveLength(2);
      expect(received[1]).toMatch(/^\[Crove\] RESOLVED on dedup-test: the failing health checks pass again after \d+ s \(heartbeat\)\.$/);
    } finally {
      hookDelayMs = 0;
    }
  });

  it('restores the state row when it was deleted', async () => {
    await admin((c) => c.query('DELETE FROM crove_kernel.prober_alert_state'));
    const gate = pgAlertGate(proberUrl, 3600);
    expect((await gate.decide('heartbeat', new Date())).decision).toBe('new');
    await gate.settle(true);
    expect((await state()).map((r) => r.problem)).toEqual(['heartbeat']);
  });

  it('refuses a malformed problem key', async () => {
    const client = new pg.Client({ connectionString: proberUrl });
    await client.connect();
    try {
      await expect(client.query(`SELECT * FROM crove_kernel.prober_alert_gate('Heartbeat; drop', 60)`)).rejects.toMatchObject({ code: '22023', message: 'INVALID_PROBLEM' });
      await expect(client.query(`SELECT * FROM crove_kernel.prober_alert_gate(repeat('a', 300), 60)`)).rejects.toMatchObject({ code: '22023' });
      expect((await client.query(`SELECT decision FROM crove_kernel.prober_alert_gate('', 60)`)).rows[0]).toMatchObject({ decision: expect.any(String) });
    } finally {
      await client.end();
    }
  });
});
