// Prober and alert delivery (plan §4.13, issue #39), unit part: thresholds, exit codes and the webhook payload.
// The database part (health(), privileges, a real webhook) is in prober.db.test.ts and test/invariant/prober.db.test.ts.
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryAlertGate } from '../src/alert-gate.ts';
import { alertPayload, deliverAlert } from '../src/alert.ts';
import { createS3Client } from '@crove/kernel-runtime';
import {
  EXIT,
  checkAuth,
  checkVerifyMarker,
  describeMarkerCheck,
  evaluateHealth,
  initialAuthState,
  loadProberConfig,
  parseProberArgs,
  probeOnce,
  proberArchiveStore,
  runProber,
  type HealthSnapshot,
  type ProberConfig,
} from '../src/prober.ts';
import type { AlertGate } from '../src/alert-gate.ts';
import { archiveKey, type ArchiveS3Sender, type ArchiveStore } from '../src/worm.ts';

// The real client, with its calls recorded: the prober's wiring of timeouts is checked on what it hands the factory.
vi.mock('@crove/kernel-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@crove/kernel-runtime')>();
  return { ...actual, createS3Client: vi.fn(actual.createS3Client) };
});

const SECRET_HOOK = 'https://hooks.example.test/services/T000/B000/secret-token-123';
const SECRET_PING = 'https://hc.example.test/ping/secret-check-456';

const healthy: HealthSnapshot = {
  checked_at: '2026-10-15 12:00:00+00',
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
  extraction_service_failures: 0,
  extraction_document_failures: 0,
};
const limits = { outboxAgeSeconds: 300, jobAgeSeconds: 900, heartbeatAgeSeconds: 120, deadLetters: 0, notifyQueuePercent: 50 };

function config(overrides: Partial<ProberConfig> = {}): ProberConfig {
  return {
    databaseUrl: 'postgres://crove_prober:pw@db:5432/postgres',
    webhookUrl: SECRET_HOOK,
    webhookFormat: 'generic',
    telegramChatId: undefined,
    repeatSeconds: 3600,
    instance: 'crove.example.test',
    thresholds: limits,
    deadLetterWindowSeconds: 300,
    ...overrides,
  };
}

// Each capture carries a fresh in-memory de-duplication gate, so a probe never reaches for a real database.
function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, log: (l: string) => out.push(l), error: (l: string) => err.push(l), gate: memoryAlertGate(3600) };
}

function webhook(status = 200) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response('ok', { status });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls, body: (i = 0) => JSON.parse(String(calls[i]?.init.body)) };
}

describe('health thresholds', () => {
  it('finds nothing in a healthy snapshot, and a value equal to its limit is not over it', () => {
    expect(evaluateHealth(healthy, limits, 300)).toEqual([]);
    const atLimit = { ...healthy, outbox_pending: 1, outbox_oldest_age_seconds: 300, job_oldest_queued_age_seconds: 900, jobs_queued: 1, worker_heartbeat_age_seconds: 120 };
    expect(evaluateHealth(atLimit, limits, 300)).toEqual([]);
  });

  it('reports each exceeded threshold with its value and limit', () => {
    const findings = evaluateHealth(
      {
        ...healthy,
        outbox_pending: 4,
        outbox_oldest_age_seconds: 301.4,
        inbound_pending: 2,
        inbound_oldest_age_seconds: 900,
        jobs_queued: 7,
        job_oldest_queued_age_seconds: 1000,
        dead_letter_count: 3,
        worker_heartbeat_age_seconds: 600,
      },
      limits,
      300,
    );
    expect(findings.map((f) => [f.check, f.value, f.threshold])).toEqual([
      ['outbox', 301.4, 300],
      ['inbound', 900, 300],
      ['job_age', 1000, 900],
      ['dead_letters', 3, 0],
      ['heartbeat', 600, 120],
    ]);
    expect(findings[0]?.message).toBe('oldest unpublished outbox event is 301 s old (limit 300 s, 4 pending): the relay is behind or stopped');
    expect(findings[3]?.message).toBe('3 job(s) failed after their last retry in the last 300 s (limit 0): see the worker log');
    expect(findings[4]?.message).toBe('last worker heartbeat was 600 s ago (limit 120 s): the worker is down');
  });

  it('alerts on absence: no heartbeat at all, or no job schema', () => {
    const findings = evaluateHealth(
      { ...healthy, worker_heartbeat_age_seconds: null, jobs_schema_present: false, jobs_queued: null, dead_letter_count: null },
      limits,
      300,
    );
    expect(findings.map((f) => f.check)).toEqual(['jobs_schema', 'heartbeat']);
    expect(findings[1]?.message).toMatch(/no worker heartbeat recorded/);
  });

  it('reports a NOTIFY queue fuller than its limit (issue #281)', () => {
    expect(evaluateHealth({ ...healthy, notify_queue_usage: 0.5 }, limits, 300)).toEqual([]);
    const findings = evaluateHealth({ ...healthy, notify_queue_usage: 0.634 }, limits, 300);
    expect(findings.map((f) => [f.check, f.value, f.threshold])).toEqual([['notify_queue', 0.634, 0.5]]);
    expect(findings[0]?.message).toMatch(/^the NOTIFY queue is 63\.4% full \(limit 50%\): a listening session has stopped reading/);
    expect(loadProberConfig({ PROBER_MAX_NOTIFY_QUEUE_PERCENT: '80' }).thresholds.notifyQueuePercent).toBe(80);
  });

  it('reports a WORM verification older than its limit and an archive behind its limit, and neither when off or unknown (#1997)', () => {
    const archive = { ...limits, archiveVerifyAgeSeconds: 93_600, archiveLagSeconds: 3600 };
    expect(evaluateHealth({ ...healthy, archive_verify_age_seconds: 93_600, archive_lag_seconds: 3600 }, archive, 300)).toEqual([]);
    expect(evaluateHealth({ ...healthy, archive_verify_age_seconds: 180_000, archive_lag_seconds: 7200 }, archive, 300)).toEqual([
      {
        check: 'archive_verify',
        value: 180_000,
        threshold: 93_600,
        message: 'the WORM archive last passed verification 50 h ago (limit 26 h): the nightly verification is not running or keeps failing (docs/runbooks/worm-archive.md)',
      },
      {
        check: 'archive_lag',
        value: 7200,
        threshold: 3600,
        message: 'the oldest audit event not yet in the WORM archive is 7200 s old (limit 3600 s): the archiver is behind or stopped (docs/runbooks/worm-archive.md)',
      },
    ]);
    // 0 turns a check off; null (no batch yet, every row archived) is not a finding.
    expect(evaluateHealth({ ...healthy, archive_verify_age_seconds: 180_000, archive_lag_seconds: 7200 }, { ...limits, archiveVerifyAgeSeconds: 0, archiveLagSeconds: 0 }, 300)).toEqual([]);
    expect(evaluateHealth(healthy, archive, 300)).toEqual([]);
  });

  it('reports document readings that failed at the reading service, never documents that could not be read (#1998)', () => {
    const extraction = { ...limits, extractionFailures: 2, extractionWindowSeconds: 3600 };
    expect(evaluateHealth({ ...healthy, extraction_service_failures: 2, extraction_document_failures: 50 }, extraction, 300)).toEqual([]);
    expect(evaluateHealth({ ...healthy, extraction_service_failures: 3, extraction_document_failures: 0 }, extraction, 300)).toEqual([
      {
        check: 'extraction',
        value: 3,
        threshold: 2,
        message:
          '3 document reading(s) failed every attempt in the last 3600 s (limit 2): the AI provider refuses or does not answer, or the parser sandbox is down (docs/runbooks/incidents.md)',
      },
    ]);
    // 0 turns it off.
    expect(evaluateHealth({ ...healthy, extraction_service_failures: 30 }, { ...extraction, extractionFailures: 0 }, 300)).toEqual([]);
    expect(loadProberConfig({}).thresholds).toMatchObject({ extractionFailures: 2, extractionWindowSeconds: 3600 });
  });

  it('alerts once while readings keep failing at the service, and sends a recovery when they stop (#1998)', async () => {
    const io = capture();
    const hook = webhook();
    const cfg = config({ thresholds: { ...limits, extractionFailures: 2, extractionWindowSeconds: 3600 } });
    const failing = { ...healthy, extraction_service_failures: 4 };
    let window: number | undefined;
    const read = (h: typeof healthy) => async (_url: string, _dl: number, _m?: readonly string[], w?: number) => {
      window = w;
      return h;
    };
    expect(await probeOnce(cfg, { ...io, fetch: hook.fetch, readHealth: read(failing) })).toBe(EXIT.unhealthy);
    expect(await probeOnce(cfg, { ...io, fetch: hook.fetch, readHealth: read(failing) })).toBe(EXIT.unhealthy);
    expect(hook.calls).toHaveLength(1);
    expect(window).toBe(3600);
    expect(hook.body(0).crove.findings).toEqual([expect.objectContaining({ check: 'extraction', value: 4, threshold: 2 })]);
    expect(await probeOnce(cfg, { ...io, fetch: hook.fetch, readHealth: read({ ...healthy, extraction_document_failures: 9 }) })).toBe(EXIT.ok);
    expect(hook.calls).toHaveLength(2);
    expect(hook.body(1).crove).toMatchObject({ kind: 'resolved', previous: ['extraction'] });
  });

  it('alerts once when the archive falls behind, and sends a recovery when it catches up (#1997)', async () => {
    const io = capture();
    const hook = webhook();
    const cfg = config({ thresholds: { ...limits, archiveVerifyAgeSeconds: 93_600, archiveLagSeconds: 3600 } });
    const behind = { ...healthy, archive_lag_seconds: 5000 };
    expect(await probeOnce(cfg, { ...io, fetch: hook.fetch, readHealth: async () => behind })).toBe(EXIT.unhealthy);
    expect(await probeOnce(cfg, { ...io, fetch: hook.fetch, readHealth: async () => behind })).toBe(EXIT.unhealthy);
    expect(hook.calls).toHaveLength(1);
    expect(hook.body(0).crove.findings).toEqual([expect.objectContaining({ check: 'archive_lag', value: 5000, threshold: 3600 })]);
    expect(await probeOnce(cfg, { ...io, fetch: hook.fetch, readHealth: async () => ({ ...healthy, archive_lag_seconds: 620 }) })).toBe(EXIT.ok);
    expect(hook.calls).toHaveLength(2);
    expect(hook.body(1).crove).toMatchObject({ kind: 'resolved', previous: ['archive_lag'] });
  });

  it('honors the dead letter limit', () => {
    expect(evaluateHealth({ ...healthy, dead_letter_count: 2 }, { ...limits, deadLetters: 2 }, 300)).toEqual([]);
    expect(evaluateHealth({ ...healthy, dead_letter_count: 3 }, { ...limits, deadLetters: 2 }, 300).map((f) => f.check)).toEqual(['dead_letters']);
  });
});

describe('prober configuration', () => {
  it('has defaults, reads every limit and names the instance after PUBLIC_URL', () => {
    expect(loadProberConfig({ PUBLIC_URL: 'https://books.example.test' })).toMatchObject({
      databaseUrl: undefined,
      webhookUrl: undefined,
      instance: 'books.example.test',
      thresholds: limits,
      deadLetterWindowSeconds: 3600,
    });
    expect(
      loadProberConfig({
        ALERT_INSTANCE: 'office',
        PROBER_MAX_OUTBOX_AGE_SECONDS: '60',
        PROBER_MAX_JOB_AGE_SECONDS: '61',
        PROBER_MAX_HEARTBEAT_AGE_SECONDS: '62',
        PROBER_MAX_DEAD_LETTERS: '5',
        PROBER_DEAD_LETTER_WINDOW_SECONDS: '600',
        PROBER_MAX_ARCHIVE_VERIFY_AGE_SECONDS: '7200',
        PROBER_MAX_ARCHIVE_LAG_SECONDS: '0',
      }),
    ).toMatchObject({
      instance: 'office',
      thresholds: { outboxAgeSeconds: 60, jobAgeSeconds: 61, heartbeatAgeSeconds: 62, deadLetters: 5, archiveVerifyAgeSeconds: 7200, archiveLagSeconds: 0 },
      deadLetterWindowSeconds: 600,
    });
    expect(loadProberConfig({}).thresholds).toMatchObject({ archiveVerifyAgeSeconds: 93_600, archiveLagSeconds: 3600 });
    // The archiver's own wait raises the default lag limit, so a long ARCHIVE_LAG_SECONDS never pages forever.
    expect(loadProberConfig({ ARCHIVE_LAG_SECONDS: '7200' }).thresholds.archiveLagSeconds).toBe(8100);
    expect(loadProberConfig({ ARCHIVE_LAG_SECONDS: '7200', PROBER_MAX_ARCHIVE_LAG_SECONDS: '600' }).thresholds.archiveLagSeconds).toBe(600);
  });

  // #1894: the modules the deployment runs, which health() counts in the job age whatever the workers record.
  it('reads the modules the deployment runs from CROVE_MODULES, as the API does, and hands them to readHealth', async () => {
    expect(loadProberConfig({}).modules).toEqual(['kernel', 'finance', 'social', 'crm', 'notes']);
    expect(loadProberConfig({ CROVE_MODULES: '' }).modules).toEqual(['kernel', 'finance', 'social', 'crm', 'notes']);
    expect(loadProberConfig({ CROVE_MODULES: ' Finance , notes' }).modules).toEqual(['kernel', 'finance', 'notes']);
    expect(() => loadProberConfig({ CROVE_MODULES: 'finanse' })).toThrow(/CROVE_MODULES/);
    const readHealth = vi.fn(async () => healthy);
    const config = { ...loadProberConfig({ CROVE_MODULES: 'finance' }), databaseUrl: 'postgres://prober@db.test/crove' };
    await probeOnce(config, { log: () => {}, error: () => {}, readHealth });
    expect(readHealth).toHaveBeenCalledWith('postgres://prober@db.test/crove', 3600, ['kernel', 'finance'], 3600);
  });

  it('counts dead letters over the --every interval plus 60 s unless the window is set', () => {
    expect(loadProberConfig({}, 300).deadLetterWindowSeconds).toBe(360);
    expect(loadProberConfig({ PROBER_DEAD_LETTER_WINDOW_SECONDS: '' }, 30).deadLetterWindowSeconds).toBe(90);
    expect(loadProberConfig({ PROBER_DEAD_LETTER_WINDOW_SECONDS: '600' }, 30).deadLetterWindowSeconds).toBe(600);
    expect(loadProberConfig({ PROBER_DEAD_LETTER_WINDOW_SECONDS: '' }).deadLetterWindowSeconds).toBe(3600);
  });

  it('refuses a webhook that is not http(s) and limits that are not whole seconds', () => {
    expect(() => loadProberConfig({ ALERT_WEBHOOK_URL: 'file:///etc/passwd' })).toThrow(/ALERT_WEBHOOK_URL/);
    expect(() => loadProberConfig({ PROBER_HEARTBEAT_URL: 'ftp://hc.example.test/ping' })).toThrow(/PROBER_HEARTBEAT_URL/);
    expect(loadProberConfig({ PROBER_HEARTBEAT_URL: SECRET_PING }).heartbeatUrl).toBe(SECRET_PING);
    expect(loadProberConfig({ PROBER_HEARTBEAT_URL: '' }).heartbeatUrl).toBeUndefined();
    expect(() => loadProberConfig({ PROBER_MAX_JOB_AGE_SECONDS: '1.5' })).toThrow(/PROBER_MAX_JOB_AGE_SECONDS/);
    expect(() => loadProberConfig({ PROBER_DEAD_LETTER_WINDOW_SECONDS: '10' })).toThrow(/PROBER_DEAD_LETTER_WINDOW_SECONDS/);
  });

  it('parses --test-alert, --backup-failed, --backup-ok and --every', () => {
    expect(parseProberArgs(['--backup-ok'])).toEqual({ testAlert: false, everySeconds: null, backupFailed: null, backupOk: true });
    expect(parseProberArgs([])).toEqual({ testAlert: false, everySeconds: null, backupFailed: null, backupOk: false });
    expect(parseProberArgs(['--test-alert'])).toEqual({ testAlert: true, everySeconds: null, backupFailed: null, backupOk: false });
    expect(parseProberArgs(['--every', '300'])).toEqual({ testAlert: false, everySeconds: 300, backupFailed: null, backupOk: false });
    expect(parseProberArgs(['--backup-failed', 'disk full'])).toEqual({ testAlert: false, everySeconds: null, backupFailed: 'disk full', backupOk: false });
    expect(() => parseProberArgs(['--backup-failed'])).toThrow(/--backup-failed needs the reason/);
    expect(() => parseProberArgs(['--every', '1'])).toThrow(/--every/);
    expect(() => parseProberArgs(['--loud'])).toThrow(/unknown prober argument --loud/);
  });
});

describe('backup failure alert', () => {
  it('sends one alert with the reason on one line, needs no database and exits 0 once delivered', async () => {
    const io = capture();
    const hook = webhook();
    const env = { ALERT_WEBHOOK_URL: SECRET_HOOK, ALERT_INSTANCE: 'books.example.test' };
    const code = await runProber(['--backup-failed', 'pg_dump failed:\nconnection refused'], env, { fetch: hook.fetch, log: io.log, error: io.error });
    expect(code).toBe(EXIT.ok);
    expect(hook.calls).toHaveLength(1);
    const body = hook.body();
    expect(body.text).toBe('[Crove] ALERT on books.example.test: the backup failed.\n- backup failed: pg_dump failed: connection refused');
    expect(body.crove).toMatchObject({ kind: 'alert', state: 'new', severity: 'critical', findings: [{ check: 'backup', value: null, threshold: null }] });
    expect(io.err).toContain('[prober] FAIL backup: backup failed: pg_dump failed: connection refused');
    expect(io.out.join('\n')).not.toContain('secret-token-123');
  });

  it('exits 3 when the alert cannot be delivered, and cuts a long reason', async () => {
    const io = capture();
    const hook = webhook(500);
    const code = await runProber(['--backup-failed', 'x'.repeat(2000)], { ALERT_WEBHOOK_URL: SECRET_HOOK }, { fetch: hook.fetch, log: io.log, error: io.error });
    expect(code).toBe(EXIT.deliveryFailed);
    const finding = (hook.body().crove as { findings: Array<{ message: string }> }).findings[0];
    expect(finding?.message).toHaveLength('backup failed: '.length + 500);
    expect(finding?.message.endsWith('...')).toBe(true);
  });
});

describe('backup heartbeat (--backup-ok)', () => {
  const SECRET_BACKUP_PING = 'https://hc.example.test/ping/secret-backup-789';

  it('pings BACKUP_HEARTBEAT_URL once with a GET, needs no database and logs the host only', async () => {
    const io = capture();
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response('ok');
    }) as unknown as typeof globalThis.fetch;
    const readHealth = vi.fn();
    const env = { BACKUP_HEARTBEAT_URL: SECRET_BACKUP_PING, PROBER_HEARTBEAT_URL: SECRET_PING, ALERT_WEBHOOK_URL: SECRET_HOOK };
    expect(await runProber(['--backup-ok'], env, { ...io, fetch, readHealth })).toBe(EXIT.ok);
    expect(readHealth).not.toHaveBeenCalled();
    expect(calls.map((c) => c.url)).toEqual([SECRET_BACKUP_PING]);
    expect(calls[0]?.init).toMatchObject({ method: 'GET', redirect: 'error' });
    expect(io.out).toEqual(['[prober] backup heartbeat sent to heartbeat monitor at hc.example.test']);
    expect([...io.out, ...io.err].join('\n')).not.toContain('secret-backup-789');
  });

  it('exits 3 when the ping fails, and 0 with nothing to ping', async () => {
    const io = capture();
    const failing = vi.fn(async () => new Response('down', { status: 503 })) as unknown as typeof globalThis.fetch;
    expect(await runProber(['--backup-ok'], { BACKUP_HEARTBEAT_URL: SECRET_BACKUP_PING }, { ...io, fetch: failing })).toBe(EXIT.deliveryFailed);
    expect(io.err).toEqual(['[prober] backup heartbeat: heartbeat monitor at hc.example.test failed: HTTP 503']);
    const none = capture();
    const unused = vi.fn() as unknown as typeof globalThis.fetch;
    expect(await runProber(['--backup-ok'], {}, { ...none, fetch: unused })).toBe(EXIT.ok);
    expect(unused).not.toHaveBeenCalled();
    expect(none.out).toEqual(['[prober] backup ok; BACKUP_HEARTBEAT_URL is not set, so no monitor sees it']);
  });

  it('refuses a BACKUP_HEARTBEAT_URL that is not http(s)', async () => {
    const io = capture();
    expect(await runProber(['--backup-ok'], { BACKUP_HEARTBEAT_URL: 'ftp://hc.example.test/x' }, io)).toBe(EXIT.probeFailed);
    expect(io.err.join('\n')).toMatch(/BACKUP_HEARTBEAT_URL/);
  });
});

describe('prober exit codes', () => {
  it('exits 0 when healthy and sends nothing', async () => {
    const io = capture();
    const hook = webhook();
    expect(await probeOnce(config(), { ...io, fetch: hook.fetch, readHealth: async () => healthy })).toBe(EXIT.ok);
    expect(hook.calls).toEqual([]);
    expect(io.out).toEqual(['[prober] ok: outbox 0 pending, inbound 0 pending, jobs 0 queued, dead letters 0, heartbeat 12 s ago, notify queue 0%']);
  });

  it('exits 1 with a clear message and one alert when a threshold is exceeded', async () => {
    const io = capture();
    const hook = webhook();
    const sick = { ...healthy, worker_heartbeat_age_seconds: 900 };
    const code = await probeOnce(config(), { ...io, fetch: hook.fetch, readHealth: async () => sick, now: () => new Date('2026-10-15T12:00:00Z') });
    expect(code).toBe(EXIT.unhealthy);
    expect(io.err).toEqual(['[prober] FAIL heartbeat: last worker heartbeat was 900 s ago (limit 120 s): the worker is down']);
    expect(hook.calls).toHaveLength(1);
    expect(hook.calls[0]?.url).toBe(SECRET_HOOK);
    expect(hook.calls[0]?.init).toMatchObject({ method: 'POST', headers: { 'content-type': 'application/json' }, redirect: 'error' });
    const body = hook.body();
    expect(body.text).toBe('[Crove] ALERT on crove.example.test: 1 health check(s) failed.\n- last worker heartbeat was 900 s ago (limit 120 s): the worker is down');
    expect(body.content).toBe(body.text);
    expect(body.crove).toMatchObject({ kind: 'alert', severity: 'critical', instance: 'crove.example.test', at: '2026-10-15T12:00:00.000Z' });
    expect(body.crove.findings).toEqual([{ check: 'heartbeat', value: 900, threshold: 120, message: expect.any(String) }]);
    expect(body.crove.health).toEqual(sick);
    expect(io.out).toEqual(['[prober] alert sent to webhook at hooks.example.test']);
  });

  it('exits 2 and alerts when the health check cannot run', async () => {
    const io = capture();
    const hook = webhook();
    const code = await probeOnce(config(), {
      ...io,
      fetch: hook.fetch,
      readHealth: async () => {
        throw new Error('connect ECONNREFUSED 10.0.0.5:5432');
      },
    });
    expect(code).toBe(EXIT.probeFailed);
    expect(hook.body().crove.findings).toEqual([
      { check: 'probe', value: null, threshold: null, message: 'the prober could not read crove_kernel.health(): connect ECONNREFUSED 10.0.0.5:5432' },
    ]);
  });

  it('exits 2 without a database URL or with bad arguments', async () => {
    const io = capture();
    expect(await probeOnce(config({ databaseUrl: undefined }), io)).toBe(EXIT.probeFailed);
    expect(io.err).toEqual(['[prober] PROBER_DATABASE_URL is not set; connect it as crove_prober']);
    expect(await runProber(['--bogus'], {}, io)).toBe(EXIT.probeFailed);
    expect(await runProber([], { ALERT_WEBHOOK_URL: 'ftp://x' }, io)).toBe(EXIT.probeFailed);
  });

  it('exits 3 when the webhook refuses the alert, prints the alert instead and never logs the webhook secret', async () => {
    const io = capture();
    const hook = webhook(500);
    const code = await probeOnce(config(), { ...io, fetch: hook.fetch, readHealth: async () => ({ ...healthy, dead_letter_count: 1 }) });
    expect(code).toBe(EXIT.deliveryFailed);
    expect(io.out[0]).toMatch(/^\[Crove\] ALERT on crove\.example\.test/);
    expect(io.err).toContain('[prober] alert delivery: webhook at hooks.example.test failed: HTTP 500');
    expect([...io.out, ...io.err].join('\n')).not.toContain('secret-token-123');
  });

  it('prints alerts to stdout when no webhook is configured', async () => {
    const io = capture();
    const code = await probeOnce(config({ webhookUrl: undefined }), { ...io, readHealth: async () => ({ ...healthy, worker_heartbeat_age_seconds: null }) });
    expect(code).toBe(EXIT.unhealthy);
    expect(io.out).toEqual([
      '[Crove] ALERT on crove.example.test: 1 health check(s) failed.\n- no worker heartbeat recorded: the worker has never started',
      '[prober] alert sent to stdout (ALERT_WEBHOOK_URL is not set)',
    ]);
  });
});

// The outside dead man's switch (issue #309): a ping after each probe that read the database and delivered every
// notification it owed, so the monitor pages when the pings stop.
describe('prober heartbeat', () => {
  // The webhook and the heartbeat monitor behind one fake fetch, answering each with its own status.
  function endpoints(hookStatus = 200, pingStatus = 200) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response('ok', { status: String(url) === SECRET_PING ? pingStatus : hookStatus });
    }) as unknown as typeof globalThis.fetch;
    return { fetch, pings: () => calls.filter((c) => c.url === SECRET_PING), hooks: () => calls.filter((c) => c.url === SECRET_HOOK) };
  }

  it('pings after a healthy probe and after an unhealthy one whose alert went out', async () => {
    const io = capture();
    const net = endpoints();
    expect(await probeOnce(config({ heartbeatUrl: SECRET_PING }), { ...io, fetch: net.fetch, readHealth: async () => healthy })).toBe(EXIT.ok);
    expect(net.pings()).toHaveLength(1);
    expect(net.pings()[0]?.init).toMatchObject({ method: 'GET', redirect: 'error' });
    expect(io.out).toContain('[prober] heartbeat sent to heartbeat monitor at hc.example.test');

    const sick = { ...healthy, dead_letter_count: 2 };
    expect(await probeOnce(config({ heartbeatUrl: SECRET_PING }), { ...io, fetch: net.fetch, readHealth: async () => sick })).toBe(EXIT.unhealthy);
    expect(net.hooks()).toHaveLength(1);
    expect(net.pings()).toHaveLength(2);
  });

  it('stays silent when the database cannot be read, the configuration is incomplete or an alert could not be delivered', async () => {
    const io = capture();
    const net = endpoints();
    const down = async (): Promise<HealthSnapshot> => {
      throw new Error('connect ECONNREFUSED 10.0.0.5:5432');
    };
    expect(await probeOnce(config({ heartbeatUrl: SECRET_PING }), { ...io, fetch: net.fetch, readHealth: down })).toBe(EXIT.probeFailed);
    expect(await probeOnce(config({ heartbeatUrl: SECRET_PING, databaseUrl: undefined }), { ...io, fetch: net.fetch })).toBe(EXIT.probeFailed);
    const refused = endpoints(500);
    const sick = { ...healthy, worker_heartbeat_age_seconds: 900 };
    expect(await probeOnce(config({ heartbeatUrl: SECRET_PING }), { ...capture(), fetch: refused.fetch, readHealth: async () => sick })).toBe(EXIT.deliveryFailed);
    expect(net.pings()).toEqual([]);
    expect(refused.pings()).toEqual([]);
  });

  it('logs a failed ping by host only and keeps the exit code of the probe', async () => {
    const io = capture();
    const net = endpoints(200, 503);
    expect(await probeOnce(config({ heartbeatUrl: SECRET_PING }), { ...io, fetch: net.fetch, readHealth: async () => healthy })).toBe(EXIT.ok);
    expect(io.err).toEqual(['[prober] heartbeat: heartbeat monitor at hc.example.test failed: HTTP 503']);
    const unreachable = vi.fn(async (url: string | URL | Request) => {
      if (String(url) === SECRET_PING) throw new TypeError('fetch failed');
      return new Response('ok');
    }) as unknown as typeof globalThis.fetch;
    const quiet = capture();
    expect(await probeOnce(config({ heartbeatUrl: SECRET_PING }), { ...quiet, fetch: unreachable, readHealth: async () => healthy })).toBe(EXIT.ok);
    expect(quiet.err).toEqual(['[prober] heartbeat: heartbeat monitor at hc.example.test failed: fetch failed']);
    expect([...io.out, ...io.err, ...quiet.out, ...quiet.err].join('\n')).not.toContain('secret-check-456');
  });

  it('pings nothing without PROBER_HEARTBEAT_URL, and nothing for a test or backup alert', async () => {
    const net = endpoints();
    expect(await probeOnce(config(), { ...capture(), fetch: net.fetch, readHealth: async () => healthy })).toBe(EXIT.ok);
    const env = { ALERT_WEBHOOK_URL: SECRET_HOOK, PROBER_HEARTBEAT_URL: SECRET_PING };
    expect(await runProber(['--test-alert'], env, { ...capture(), fetch: net.fetch })).toBe(EXIT.ok);
    expect(await runProber(['--backup-failed', 'disk full'], env, { ...capture(), fetch: net.fetch })).toBe(EXIT.ok);
    expect(net.pings()).toEqual([]);
    expect(net.hooks()).toHaveLength(2);
  });
});

describe('Supabase Auth check (#1994)', () => {
  // A fake Supabase Auth on a local port: /auth/v1/health answers 200 while up, 503 while down, and records the apikey.
  let server: Server;
  let base = '';
  let up = true;
  const keys: Array<string | undefined> = [];
  beforeAll(async () => {
    server = createServer((req, res) => {
      keys.push(req.headers.apikey as string | undefined);
      res.statusCode = req.url === '/auth/v1/health' && up ? 200 : 503;
      res.end(up ? '{"version":"test"}' : 'down');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/auth/v1`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
  beforeEach(() => {
    up = true;
    keys.length = 0;
  });

  // The fake Auth answers for real; the webhook is recorded.
  function endpoints() {
    const hooks: Array<{ url: string; init: RequestInit }> = [];
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).startsWith(base)) return globalThis.fetch(url, init);
      hooks.push({ url: String(url), init: init ?? {} });
      return new Response('ok', { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    return { fetch, hooks, body: (i: number) => JSON.parse(String(hooks[i]?.init.body)) };
  }

  it('finds the health URL: PROBER_AUTH_URL, else PUBLIC_AUTH_URL, else PUBLIC_URL/auth/v1; off without them or at 0 misses', () => {
    expect(loadProberConfig({ PUBLIC_URL: 'https://books.example.test/' })).toMatchObject({ authHealthUrl: 'https://books.example.test/auth/v1/health', authMisses: 2, authTimeoutSeconds: 10 });
    expect(loadProberConfig({ PUBLIC_URL: 'https://books.example.test', PUBLIC_AUTH_URL: 'https://auth.example.test/auth/v1', PUBLIC_AUTH_ANON_KEY: 'pk_test' })).toMatchObject({
      authHealthUrl: 'https://auth.example.test/auth/v1/health',
      authAnonKey: 'pk_test',
    });
    expect(loadProberConfig({ PUBLIC_URL: 'https://books.example.test', PROBER_AUTH_URL: 'http://crove:8080/auth/v1/', PROBER_AUTH_MISSES: '3' })).toMatchObject({
      authHealthUrl: 'http://crove:8080/auth/v1/health',
      authMisses: 3,
    });
    expect(loadProberConfig({}).authHealthUrl).toBeUndefined();
    expect(loadProberConfig({ PUBLIC_URL: 'not a url' }).authHealthUrl).toBeUndefined();
    expect(loadProberConfig({ PUBLIC_URL: 'https://books.example.test', PROBER_AUTH_MISSES: '0' }).authHealthUrl).toBeUndefined();
    expect(() => loadProberConfig({ PROBER_AUTH_URL: 'ftp://auth.example.test' })).toThrow(/PROBER_AUTH_URL/);
    // Credentials in the URL would travel in every request and could reach a log.
    expect(() => loadProberConfig({ PROBER_AUTH_URL: 'https://user:secret@auth.example.test/auth/v1' })).toThrow(/holds credentials/);
    // Hosted Supabase answers 401 without the publishable key, which would page forever.
    expect(() => loadProberConfig({ PUBLIC_AUTH_URL: 'https://project.supabase.co/auth/v1' })).toThrow(/PUBLIC_AUTH_ANON_KEY/);
    expect(() => loadProberConfig({ PUBLIC_AUTH_URL: 'https://project.supabase.co./auth/v1' })).toThrow(/PUBLIC_AUTH_ANON_KEY/);
    expect(loadProberConfig({ PUBLIC_AUTH_URL: 'https://project.supabase.co/auth/v1', PUBLIC_AUTH_ANON_KEY: 'sb_publishable_x' }).authHealthUrl).toBe('https://project.supabase.co/auth/v1/health');
  });

  it('alerts once after the misses in a row, stays quiet while it lasts, and sends a recovery when Auth answers again', async () => {
    const io = capture();
    const net = endpoints();
    const authState = { misses: 0 };
    const cfg = config({ authHealthUrl: `${base}/health`, authAnonKey: 'pk_test', authMisses: 2 });
    const run = () => probeOnce(cfg, { ...io, fetch: net.fetch, readHealth: async () => healthy, authState });
    up = true;
    expect(await run()).toBe(EXIT.ok);
    expect(io.out.at(-1)).toMatch(/, auth ok$/);
    up = false;
    // The first miss only counts.
    expect(await run()).toBe(EXIT.ok);
    expect(net.hooks).toEqual([]);
    expect(io.err.at(-1)).toBe('[prober] Supabase Auth did not answer (HTTP 503); 1 of 2 misses before it alerts');
    // The second alerts, once.
    expect(await run()).toBe(EXIT.unhealthy);
    expect(net.hooks).toHaveLength(1);
    expect(net.body(0).crove.findings).toEqual([
      { check: 'auth', value: 2, threshold: 2, message: 'Supabase Auth did not answer its health check 2 time(s) in a row (HTTP 503): nobody can sign in' },
    ]);
    // Neither the health URL nor the key reaches the alert.
    expect(JSON.stringify(net.body(0))).not.toContain('127.0.0.1');
    expect(JSON.stringify(net.body(0))).not.toContain('pk_test');
    expect(await run()).toBe(EXIT.unhealthy);
    expect(net.hooks).toHaveLength(1);
    up = true;
    expect(await run()).toBe(EXIT.ok);
    expect(net.hooks).toHaveLength(2);
    expect(net.body(1).crove).toMatchObject({ kind: 'resolved', previous: ['auth'] });
    expect(authState.misses).toBe(0);
    // The publishable key went with every request.
    expect(new Set(keys)).toEqual(new Set(['pk_test']));
  });

  it('keeps an open Auth alert across a restart: a new probe loop alerts on its first miss, and counts afresh after an answer', async () => {
    const io = capture();
    const net = endpoints();
    up = false;
    const cfg = config({ authHealthUrl: `${base}/health`, authMisses: 2 });
    // The state runProber starts its loop with.
    const authState = initialAuthState(cfg);
    expect(await probeOnce(cfg, { ...io, fetch: net.fetch, readHealth: async () => healthy, authState })).toBe(EXIT.unhealthy);
    expect(net.body(0).crove.findings).toEqual([expect.objectContaining({ check: 'auth', value: 2, threshold: 2 })]);
    up = true;
    expect(await probeOnce(cfg, { ...io, fetch: net.fetch, readHealth: async () => healthy, authState })).toBe(EXIT.ok);
    up = false;
    // After an answer, one miss only counts again.
    expect(await probeOnce(cfg, { ...io, fetch: net.fetch, readHealth: async () => healthy, authState })).toBe(EXIT.ok);
    expect(net.hooks).toHaveLength(2);
  });

  it('alerts on the first miss when nothing counts the runs before (one probe a run, from cron)', async () => {
    const io = capture();
    const net = endpoints();
    up = false;
    expect(await probeOnce(config({ authHealthUrl: `${base}/health`, authMisses: 2 }), { ...io, fetch: net.fetch, readHealth: async () => healthy })).toBe(EXIT.unhealthy);
    expect(net.body(0).crove.findings).toEqual([expect.objectContaining({ check: 'auth', value: 1, threshold: 1 })]);
    up = true;
  });

  it('reads a refused connection or a timeout as a miss, on one line and without the URL', async () => {
    const refused = await checkAuth(config({ authHealthUrl: 'http://127.0.0.1:9/auth/v1/health', authTimeoutSeconds: 2 }), {});
    expect(refused).toMatchObject({ ok: false, reason: expect.stringMatching(/^connection failed(: [A-Z_]+)?$/) });
    // A fetch error that quotes the URL: only a system code goes on.
    const quoting = vi.fn(async () => {
      throw new TypeError('fetch failed for https://user:secret@auth.example.test/auth/v1/health', { cause: { code: 'ECONNRESET' } });
    }) as unknown as typeof globalThis.fetch;
    expect(await checkAuth(config({ authHealthUrl: `${base}/health` }), { fetch: quoting })).toEqual({ ok: false, reason: 'connection failed: ECONNRESET' });
    const slow = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      await new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)));
      return new Response('late');
    }) as unknown as typeof globalThis.fetch;
    expect(await checkAuth(config({ authHealthUrl: `${base}/health`, authTimeoutSeconds: 1 }), { fetch: slow })).toEqual({ ok: false, reason: 'no answer within 1 s' });
  });

  it('checks nothing without a health URL, as before', async () => {
    const io = capture();
    const net = endpoints();
    expect(await probeOnce(config(), { ...io, fetch: net.fetch, readHealth: async () => healthy })).toBe(EXIT.ok);
    expect(io.out.at(-1)).not.toContain('auth');
  });
});

describe('test alert', () => {
  it('posts a test alert without touching the database and exits 0', async () => {
    const io = capture();
    const hook = webhook();
    const readHealth = vi.fn();
    const code = await runProber(['--test-alert'], { ALERT_WEBHOOK_URL: SECRET_HOOK, ALERT_INSTANCE: 'office' }, { ...io, fetch: hook.fetch, readHealth, now: () => new Date('2026-10-15T12:00:00Z') });
    expect(code).toBe(EXIT.ok);
    expect(readHealth).not.toHaveBeenCalled();
    expect(hook.body()).toEqual({
      text: '[Crove] Test alert from office: alert delivery works.',
      content: '[Crove] Test alert from office: alert delivery works.',
      crove: { kind: 'test', severity: 'info', instance: 'office', at: '2026-10-15T12:00:00.000Z', findings: [] },
    });
    expect(io.out).toEqual(['[prober] test alert sent to webhook at hooks.example.test']);
  });

  it('exits 3 when the test alert cannot be delivered, and prints to stdout without a webhook', async () => {
    const failing = capture();
    const unreachable = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    expect(await runProber(['--test-alert'], { ALERT_WEBHOOK_URL: SECRET_HOOK }, { ...failing, fetch: unreachable })).toBe(EXIT.deliveryFailed);
    expect(failing.err).toEqual(['[prober] test alert: webhook at hooks.example.test failed: fetch failed']);

    const local = capture();
    expect(await runProber(['--test-alert'], { ALERT_INSTANCE: 'office' }, local)).toBe(EXIT.ok);
    expect(local.out).toEqual(['[Crove] Test alert from office: alert delivery works.', '[prober] test alert sent to stdout (ALERT_WEBHOOK_URL is not set)']);
  });

  it('keeps the text within the Discord limit', async () => {
    const findings = Array.from({ length: 100 }, (_, i) => ({ check: 'outbox' as const, value: i, threshold: 0, message: `finding number ${i} `.repeat(5) }));
    const payload = alertPayload({ kind: 'alert', instance: 'x', at: 'now', findings });
    expect(payload.text.length).toBeLessThanOrEqual(1900);
    expect(payload.text.endsWith('...')).toBe(true);
    expect(payload.crove.findings).toHaveLength(100);
    const timedOut = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    }) as unknown as typeof fetch;
    const lines: string[] = [];
    expect(await deliverAlert({ kind: 'test', instance: 'x', at: 'now', findings: [] }, { webhookUrl: SECRET_HOOK, fetch: timedOut, log: (l) => lines.push(l) })).toEqual({
      channel: 'webhook',
      ok: false,
      error: 'webhook at hooks.example.test failed: The operation was aborted due to timeout',
    });
  });
});

describe('WORM verification marker (#2082)', () => {
  const DAY = 86_400_000;
  const now = new Date('2026-10-30T12:00:00Z');
  const marker = (verifiedAt: Date) => ({ format: 'crove-verify-marker', version: 1, verifiedAt: verifiedAt.toISOString(), batches: 0, chainSha256: null });
  // A store holding objects the store wrote at the given times; `failing` makes every read throw, as a refused key does.
  function storeOf(objects: Record<string, { body: unknown; at: Date }>, failing = false): ArchiveStore {
    const fail = () => {
      if (failing) throw new Error('AccessDenied: s3:ListBucketVersions\nnot allowed');
    };
    return {
      put: async () => {
        throw new Error('the prober never writes');
      },
      get: async (key) => {
        fail();
        const o = objects[key];
        return o ? new TextEncoder().encode(typeof o.body === 'string' ? o.body : JSON.stringify(o.body)) : null;
      },
      list: async (prefix) => {
        fail();
        return Object.keys(objects)
          .filter((k) => k.startsWith(prefix))
          .sort();
      },
      writtenAt: async (key) => objects[key]?.at ?? null,
      describe: () => 'memory',
    };
  }
  const settings = { maxAgeSeconds: 93_600, store: { kind: 'local' as const, dir: '/data/archive' } };
  const fresh = storeOf({ 'verify/v1/20261030T020000Z.json': { body: marker(new Date(now.getTime() - DAY / 2)), at: new Date(now.getTime() - DAY / 2) } });
  // The marker says it is new; the store wrote it two days ago, and the store's time is the one that counts.
  const stale = storeOf({ 'verify/v1/20261028T020000Z.json': { body: marker(now), at: new Date(now.getTime() - 2 * DAY) } });
  // A gate the database's owner forged: it reports every problem as already notified.
  const forged: AlertGate = { decide: async () => ({ decision: 'suppressed', previousProblem: null, problemSince: null, lastNotifiedAt: null }), settle: async () => {} };

  it('reads the store settings: off by default and at 0, the archive directory, or the bucket with a read-only key of its own', () => {
    expect(loadProberConfig({}).archiveMarker).toBeUndefined();
    expect(loadProberConfig({ ARCHIVE_DIR: '/data/archive' }).archiveMarker).toEqual(settings);
    expect(loadProberConfig({ ARCHIVE_DIR: '/data/archive', PROBER_MAX_ARCHIVE_MARKER_AGE_SECONDS: '0' }).archiveMarker).toBeUndefined();
    const s3 = { ARCHIVE_STORE: 's3', ARCHIVE_S3_BUCKET: 'archive', S3_ENDPOINT: 'https://s3.example.test', S3_FORCE_PATH_STYLE: 'true' };
    const reader = { PROBER_ARCHIVE_S3_ACCESS_KEY_ID: 'reader', PROBER_ARCHIVE_S3_SECRET_ACCESS_KEY: 'r' };
    expect(loadProberConfig({ ...s3, ...reader }).archiveMarker).toEqual({
      maxAgeSeconds: 93_600,
      store: { kind: 's3', bucket: 'archive', region: 'us-east-1', endpoint: 'https://s3.example.test', forcePathStyle: true, accessKeyId: 'reader', secretAccessKey: 'r' },
    });
    // Neither of the prober's pair set, and no worker key in its environment: the default credential chain.
    expect(loadProberConfig(s3).archiveMarker).toEqual({
      maxAgeSeconds: 93_600,
      store: { kind: 's3', bucket: 'archive', region: 'us-east-1', endpoint: 'https://s3.example.test', forcePathStyle: true, accessKeyId: undefined, secretAccessKey: undefined },
    });
    // The worker's key in the environment (a prober run from the shared .env) is never used (#2094): with the prober's own
    // pair it is ignored; without one the check refuses, naming the pair, and never echoes a key.
    const worker = { S3_ACCESS_KEY_ID: 'AKIAWORKERKEY', S3_SECRET_ACCESS_KEY: 'worker-secret-123' };
    expect(loadProberConfig({ ...s3, ...worker, ...reader }).archiveMarker).toMatchObject({ store: { accessKeyId: 'reader', secretAccessKey: 'r' } });
    const refused = loadProberConfig({ ...s3, ...worker }).archiveMarker;
    expect(refused).toMatchObject({
      maxAgeSeconds: 93_600,
      error: expect.stringContaining('S3_ACCESS_KEY_ID (the worker\'s key) is set, but the prober\'s own PROBER_ARCHIVE_S3_ACCESS_KEY_ID and PROBER_ARCHIVE_S3_SECRET_ACCESS_KEY are not'),
    });
    expect(JSON.stringify(refused)).not.toContain('AKIAWORKERKEY');
    expect(JSON.stringify(refused)).not.toContain('worker-secret-123');
    // The prober's own pair that holds the worker's key id is the worker's key all the same.
    expect(loadProberConfig({ ...s3, ...worker, PROBER_ARCHIVE_S3_ACCESS_KEY_ID: 'AKIAWORKERKEY', PROBER_ARCHIVE_S3_SECRET_ACCESS_KEY: 'r' }).archiveMarker).toMatchObject({
      error: "PROBER_ARCHIVE_S3_ACCESS_KEY_ID is the worker's S3_ACCESS_KEY_ID: give the prober a key of its own that only reads",
    });
    // On a local store the worker's key is no matter.
    expect(loadProberConfig({ ARCHIVE_DIR: '/data/archive', ...worker }).archiveMarker).toEqual(settings);
    // A setting the check cannot use is reported as one: the check is disabled and says why (below).
    expect(loadProberConfig({ ARCHIVE_STORE: 's3' }).archiveMarker).toEqual({ maxAgeSeconds: 93_600, error: 'ARCHIVE_STORE=s3 needs ARCHIVE_S3_BUCKET' });
    expect(loadProberConfig({ ...s3, PROBER_ARCHIVE_S3_ACCESS_KEY_ID: 'reader' }).archiveMarker).toMatchObject({ error: expect.stringMatching(/PROBER_ARCHIVE_S3_SECRET_ACCESS_KEY/) });
    expect(loadProberConfig({ ...s3, PROBER_ARCHIVE_S3_SECRET_ACCESS_KEY: 'r' }).archiveMarker).toMatchObject({ error: expect.stringMatching(/PROBER_ARCHIVE_S3_ACCESS_KEY_ID/) });
  });

  it('parses the archive settings apart: a bad one disables only the marker check, never the backup and test alerts (#2094)', async () => {
    const cases: Array<[Record<string, string>, string]> = [
      [{ S3_ENDPOINT: 'ftp://s3.example.test' }, 'S3_ENDPOINT'],
      [{ S3_FORCE_PATH_STYLE: 'maybe' }, 'S3_FORCE_PATH_STYLE'],
      [{ ARCHIVE_STORE: 'gcs' }, 'ARCHIVE_STORE'],
      [{ PROBER_MAX_ARCHIVE_MARKER_AGE_SECONDS: 'a day' }, 'PROBER_MAX_ARCHIVE_MARKER_AGE_SECONDS'],
    ];
    for (const [bad, field] of cases) {
      const env = { ALERT_WEBHOOK_URL: SECRET_HOOK, ARCHIVE_STORE: 's3', ARCHIVE_S3_BUCKET: 'archive', ...bad };
      expect(loadProberConfig(env).archiveMarker).toEqual({ maxAgeSeconds: 93_600, error: `invalid archive settings: ${field}` });
      const io = capture();
      const hook = webhook();
      expect(await runProber(['--backup-failed', 'disk full'], env, { ...io, fetch: hook.fetch })).toBe(EXIT.ok);
      expect(await runProber(['--test-alert'], env, { ...io, fetch: hook.fetch })).toBe(EXIT.ok);
      expect(hook.calls).toHaveLength(2);
    }
    // The S3 settings are read only for ARCHIVE_STORE=s3: with a local store, or none, a malformed one is no business of the check.
    expect(loadProberConfig({ ARCHIVE_DIR: '/data/archive', S3_ENDPOINT: 'ftp://x', S3_FORCE_PATH_STYLE: 'maybe' }).archiveMarker).toEqual(settings);
    expect(loadProberConfig({ S3_ENDPOINT: 'ftp://x' }).archiveMarker).toBeUndefined();
    // A limit of 0 turns the check off, whatever else is wrong with the archive settings.
    expect(loadProberConfig({ ARCHIVE_STORE: 'gcs', S3_ENDPOINT: 'ftp://x', PROBER_MAX_ARCHIVE_MARKER_AGE_SECONDS: '0' }).archiveMarker).toBeUndefined();
    // A bad setting of the rest is refused as before.
    expect(() => loadProberConfig({ ALERT_REPEAT_MINUTES: 'often' })).toThrow(/ALERT_REPEAT_MINUTES/);
  });

  it('runs the other probes with the check disabled, and the finding names the settings, never their values (#2094)', async () => {
    const io = capture();
    const hook = webhook();
    const env = { PROBER_DATABASE_URL: 'postgres://crove_prober:pw@db:5432/postgres', ALERT_WEBHOOK_URL: SECRET_HOOK, ARCHIVE_STORE: 's3', ARCHIVE_S3_BUCKET: 'archive', S3_ENDPOINT: 'ftp://internal.example.test' };
    const sick = { ...healthy, worker_heartbeat_age_seconds: 900 };
    expect(await runProber([], env, { ...io, fetch: hook.fetch, readHealth: async () => sick, now: () => now })).toBe(EXIT.unhealthy);
    expect(hook.calls).toHaveLength(2);
    expect(hook.body(0).crove.findings).toEqual([
      {
        check: 'archive_marker',
        value: null,
        threshold: 93_600,
        message: 'the prober cannot check the WORM verification marker: invalid archive settings: S3_ENDPOINT (docs/runbooks/worm-archive.md)',
      },
    ]);
    expect(hook.body(1).crove.findings.map((f: { check: string }) => f.check)).toEqual(['heartbeat']);
    expect(JSON.stringify([io.out, io.err, hook.calls.map((c) => c.init.body)])).not.toContain('internal.example.test');
  });

  it('says at the start of the loop which store the check reads, and loudly what is wrong when it is disabled (#2094)', async () => {
    const reader = { PROBER_ARCHIVE_S3_ACCESS_KEY_ID: 'reader', PROBER_ARCHIVE_S3_SECRET_ACCESS_KEY: 'r' };
    const start = async (env: Record<string, string>) => {
      const io = capture();
      const stop = new Error('stop');
      // The start line is the first the loop logs: throwing from it ends the loop for the test.
      const log = (line: string) => {
        io.out.push(line);
        throw stop;
      };
      await expect(runProber(['--every', '10'], { PROBER_DATABASE_URL: 'postgres://crove_prober:pw@db:5432/postgres', ...env }, { ...io, log })).rejects.toBe(stop);
      return { line: io.out[0] ?? '', err: io.err };
    };
    expect(await start({})).toMatchObject({ line: expect.stringMatching(/, verification marker check off$/), err: [] });
    expect((await start({ ARCHIVE_DIR: '/data/archive' })).line).toMatch(/, verification markers from local files in \/data\/archive$/);
    expect((await start({ ARCHIVE_STORE: 's3', ARCHIVE_S3_BUCKET: 'archive', S3_ENDPOINT: 'https://s3.example.test', ...reader })).line).toMatch(
      /, verification markers from s3 bucket archive at s3\.example\.test, with the prober's own key$/,
    );
    expect((await start({ ARCHIVE_STORE: 's3', ARCHIVE_S3_BUCKET: 'archive', S3_REGION: 'ap-southeast-1' })).line).toMatch(
      /, verification markers from s3 bucket archive at AWS ap-southeast-1, with the default credential chain$/,
    );
    // Disabled: the line says so, and a loud error names what is wrong and that the other checks run.
    const disabled = await start({ ARCHIVE_STORE: 's3', ARCHIVE_S3_BUCKET: 'archive', S3_ACCESS_KEY_ID: 'AKIAWORKERKEY' });
    expect(disabled.line).toMatch(/, verification marker check disabled \(ARCHIVE_STORE=s3 and S3_ACCESS_KEY_ID \(the worker's key\) is set/);
    expect(disabled.err).toEqual([
      expect.stringMatching(
        /^\[prober\] ERROR verification marker check disabled \(.*PROBER_ARCHIVE_S3_ACCESS_KEY_ID and PROBER_ARCHIVE_S3_SECRET_ACCESS_KEY are not.*\): the other checks run, and archive_marker is reported on every probe until the settings are fixed$/,
      ),
    ]);
    expect(JSON.stringify(disabled)).not.toContain('AKIAWORKERKEY');
    // The label of the helper itself.
    expect(describeMarkerCheck(undefined)).toBe('verification marker check off');
  });

  it('aborts the calls still waiting when the read runs past its deadline (#2094)', async () => {
    const s3 = { maxAgeSeconds: 93_600, store: { kind: 's3' as const, bucket: 'archive', region: 'us-east-1', endpoint: undefined, forcePathStyle: false, accessKeyId: undefined, secretAccessKey: undefined } };
    const calls: Array<{ command: string; signal: AbortSignal | undefined }> = [];
    // A store that takes each call and answers only when it is aborted.
    const hung: ArchiveS3Sender = {
      send: ((command: object, options?: { abortSignal?: AbortSignal }) => {
        calls.push({ command: command.constructor.name, signal: options?.abortSignal });
        return new Promise((_, reject) => {
          options?.abortSignal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        });
      }) as ArchiveS3Sender['send'],
    };
    const finding = await checkVerifyMarker(s3, { archiveClient: hung, markerTimeoutMs: 20 }, now);
    expect(finding?.message).toBe('the prober could not read the verification marker from the WORM archive store: no answer within 0 s (docs/runbooks/worm-archive.md)');
    expect(calls.map((c) => c.command)).toEqual(['ListObjectsV2Command']);
    expect(calls[0]?.signal?.aborted).toBe(true);
  });

  it("builds its S3 client with timeouts and attempts, once per settings, and never takes the worker's key (#2094)", () => {
    const settings = { kind: 's3' as const, bucket: 'archive', region: 'us-east-1', endpoint: 'http://127.0.0.1:9', forcePathStyle: true, accessKeyId: 'reader', secretAccessKey: 'r' };
    vi.mocked(createS3Client).mockClear();
    proberArchiveStore(settings);
    proberArchiveStore(settings);
    expect(createS3Client).toHaveBeenCalledTimes(1);
    expect(createS3Client).toHaveBeenCalledWith(expect.objectContaining({ bucket: 'archive', accessKeyId: 'reader', secretAccessKey: 'r' }), undefined, {
      connectionTimeoutMs: 5000,
      requestTimeoutMs: 10_000,
      maxAttempts: 2,
    });
  });

  it('is quiet while the newest marker is recent by the store, and alerts once when it grows old, through a gate outside the database', async () => {
    const io = capture();
    const hook = webhook();
    const cfg = config({ archiveMarker: settings });
    const deps = { ...io, fetch: hook.fetch, readHealth: async () => healthy, now: () => now, markerGate: memoryAlertGate(3600) };
    expect(await probeOnce(cfg, { ...deps, archiveStore: fresh })).toBe(EXIT.ok);
    expect(hook.calls).toEqual([]);

    const statuses: unknown[] = [];
    const writeStatus = async (_path: string, status: unknown) => {
      statuses.push(status);
    };
    // The database's own gate says it was notified already: the marker alert goes out all the same.
    expect(await probeOnce({ ...cfg, statusFile: '/data/status/probe.json' }, { ...deps, gate: forged, archiveStore: stale, writeStatus })).toBe(EXIT.unhealthy);
    expect(hook.calls).toHaveLength(1);
    expect(hook.body(0).crove.findings).toEqual([
      {
        check: 'archive_marker',
        value: 172_800,
        threshold: 93_600,
        message: 'the WORM archive store wrote the newest verification marker 48 h ago (limit 26 h): the nightly verification has not passed since, or never finished (docs/runbooks/worm-archive.md)',
      },
    ]);
    expect(statuses).toEqual([expect.objectContaining({ databaseOk: true, failing: ['archive_marker'] })]);
    // Once per repeat window, like every alert.
    expect(await probeOnce(cfg, { ...deps, archiveStore: stale })).toBe(EXIT.unhealthy);
    expect(hook.calls).toHaveLength(1);
    // A new marker resolves it.
    expect(await probeOnce(cfg, { ...deps, archiveStore: fresh })).toBe(EXIT.ok);
    expect(hook.body(1).crove).toMatchObject({ kind: 'resolved', previous: ['archive_marker'] });
  });

  it('alerts when the database cannot be read too, and when the store cannot be read, on one line', async () => {
    const io = capture();
    const hook = webhook();
    const down = async (): Promise<HealthSnapshot> => {
      throw new Error('connect ECONNREFUSED');
    };
    expect(await probeOnce(config({ archiveMarker: settings }), { ...io, fetch: hook.fetch, readHealth: down, now: () => now, archiveStore: stale })).toBe(EXIT.probeFailed);
    expect(hook.calls.map((_, i) => hook.body(i).crove.findings[0].check)).toEqual(['archive_marker', 'probe']);

    const refused = await probeOnce(config({ archiveMarker: settings }), { ...io, fetch: hook.fetch, readHealth: async () => healthy, now: () => now, archiveStore: storeOf({}, true) });
    expect(refused).toBe(EXIT.unhealthy);
    expect(hook.body(2).crove.findings[0]).toMatchObject({
      check: 'archive_marker',
      value: null,
      message: 'the prober could not read the verification marker from the WORM archive store: AccessDenied: s3:ListBucketVersions not allowed (docs/runbooks/worm-archive.md)',
    });

    // A store that never answers holds up neither the database checks nor the status file.
    const hung: ArchiveStore = { ...storeOf({}), list: () => new Promise<string[]>(() => {}) };
    const statuses: unknown[] = [];
    const writeStatus = async (_path: string, status: unknown) => {
      statuses.push(status);
    };
    const sick = { ...healthy, worker_heartbeat_age_seconds: 900 };
    const code = await probeOnce(config({ archiveMarker: settings, statusFile: '/data/status/probe.json' }), {
      ...io,
      fetch: hook.fetch,
      readHealth: async () => sick,
      now: () => now,
      archiveStore: hung,
      markerTimeoutMs: 20,
      writeStatus,
    });
    expect(code).toBe(EXIT.unhealthy);
    expect(hook.body(3).crove.findings[0].message).toBe('the prober could not read the verification marker from the WORM archive store: no answer within 0 s (docs/runbooks/worm-archive.md)');
    expect(hook.body(4).crove.findings.map((f: { check: string }) => f.check)).toEqual(['heartbeat']);
    expect(statuses).toEqual([expect.objectContaining({ failing: ['heartbeat', 'archive_marker'] })]);
  });

  it('reports a marker key the store keeps more than one version of, but not one a lifecycle rule expired (#2082)', async () => {
    const io = capture();
    const hook = webhook();
    const versioned = (counts: Record<string, number>): ArchiveStore => ({ ...fresh, versionCounts: async () => new Map(Object.entries(counts)) });
    const run = (store: ArchiveStore) =>
      probeOnce(config({ archiveMarker: settings }), { ...io, fetch: hook.fetch, readHealth: async () => healthy, now: () => now, archiveStore: store, markerGate: memoryAlertGate(3600) });
    const newest = 'verify/v1/20261030T020000Z.json';
    expect(await run(versioned({ [newest]: 1 }))).toBe(EXIT.ok);
    expect(await run(versioned({ [newest]: 2, 'verify/v1/20261029T020000Z.json': 2 }))).toBe(EXIT.unhealthy);
    expect(hook.body(0).crove.findings).toEqual([
      {
        check: 'archive_marker',
        value: null,
        threshold: 93_600,
        message:
          'the WORM archive store keeps more than one version of verification marker verify/v1/20261029T020000Z.json, verify/v1/20261030T020000Z.json: a marker was written over, or deleted and written again (docs/runbooks/worm-archive.md)',
      },
    ]);
    // A marker past its 400 days leaves a delete marker when a lifecycle rule expires it: not a finding.
    expect(await run(versioned({ [newest]: 1, 'verify/v1/20250901T020000Z.json': 2 }))).toBe(EXIT.ok);
    expect(hook.calls).toHaveLength(1);
  });

  it("reports settings it cannot use, and picks the newest marker by the store's time, not by its key", async () => {
    const io = capture();
    const hook = webhook();
    const misconfigured = { maxAgeSeconds: 93_600, error: 'ARCHIVE_STORE=s3 needs ARCHIVE_S3_BUCKET' };
    expect(await probeOnce(config({ archiveMarker: misconfigured }), { ...io, fetch: hook.fetch, readHealth: async () => healthy, now: () => now })).toBe(EXIT.unhealthy);
    expect(hook.body(0).crove.findings[0].message).toBe(
      'the prober cannot check the WORM verification marker: ARCHIVE_STORE=s3 needs ARCHIVE_S3_BUCKET (docs/runbooks/worm-archive.md)',
    );
    // A marker named from a clock that ran a year ahead, written two days ago, and today's, named from the right clock:
    // today's counts.
    const skewed = storeOf({
      'verify/v1/20271030T020000Z.json': { body: marker(now), at: new Date(now.getTime() - 2 * DAY) },
      'verify/v1/20261030T020000Z.json': { body: marker(now), at: new Date(now.getTime() - DAY / 2) },
    });
    expect(await probeOnce(config({ archiveMarker: settings }), { ...io, fetch: hook.fetch, readHealth: async () => healthy, now: () => now, archiveStore: skewed })).toBe(EXIT.ok);
  });

  it('reports a marker it cannot trust, and with no marker yet waits the limit after the first batch and after the probe loop started', async () => {
    const io = capture();
    const run = async (store: ArchiveStore, startedAt?: Date) => {
      const hook = webhook();
      const code = await probeOnce(config({ archiveMarker: settings }), { ...io, fetch: hook.fetch, readHealth: async () => healthy, now: () => now, archiveStore: store, ...(startedAt ? { startedAt } : {}) });
      return { code, finding: hook.calls.length ? hook.body(0).crove.findings[0] : null };
    };
    const twoDays = new Date(now.getTime() - 2 * DAY);
    const batch = { [archiveKey(1)]: { body: 'a batch', at: twoDays } };
    // A marker naming a batch the store does not hold.
    const beyond = await run(storeOf({ ...batch, 'verify/v1/20261030T020000Z.json': { body: { ...marker(now), batches: 2, chainSha256: 'a'.repeat(64) }, at: now } }));
    expect(beyond.finding?.message).toMatch(/^the newest WORM verification marker verify\/v1\/20261030T020000Z\.json cannot be trusted: it names a chain hash that batch 2/);
    // No marker, a batch two days old: no verification ever passed.
    expect((await run(storeOf(batch))).finding?.message).toMatch(/^the WORM archive store holds no verification marker, and wrote its first batch 48 h ago/);
    // ... unless the probe loop started less than the limit ago (the first nightly run after an upgrade writes one).
    expect(await run(storeOf(batch), new Date(now.getTime() - DAY))).toEqual({ code: EXIT.ok, finding: null });
    expect((await run(storeOf(batch), twoDays)).code).toBe(EXIT.unhealthy);
    // Nothing archived yet: nothing to verify.
    expect(await run(storeOf({}))).toEqual({ code: EXIT.ok, finding: null });
  });
});
