// Prober and alert delivery (plan §4.13, issue #39), unit part: thresholds, exit codes and the webhook payload.
// The database part (health(), privileges, a real webhook) is in prober.db.test.ts and test/invariant/prober.db.test.ts.
import { describe, expect, it, vi } from 'vitest';
import { memoryAlertGate } from '../src/alert-gate.ts';
import { alertPayload, deliverAlert } from '../src/alert.ts';
import { EXIT, evaluateHealth, loadProberConfig, parseProberArgs, probeOnce, runProber, type HealthSnapshot, type ProberConfig } from '../src/prober.ts';

const SECRET_HOOK = 'https://hooks.example.test/services/T000/B000/secret-token-123';

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
      }),
    ).toMatchObject({ instance: 'office', thresholds: { outboxAgeSeconds: 60, jobAgeSeconds: 61, heartbeatAgeSeconds: 62, deadLetters: 5 }, deadLetterWindowSeconds: 600 });
  });

  it('counts dead letters over the --every interval plus 60 s unless the window is set', () => {
    expect(loadProberConfig({}, 300).deadLetterWindowSeconds).toBe(360);
    expect(loadProberConfig({ PROBER_DEAD_LETTER_WINDOW_SECONDS: '' }, 30).deadLetterWindowSeconds).toBe(90);
    expect(loadProberConfig({ PROBER_DEAD_LETTER_WINDOW_SECONDS: '600' }, 30).deadLetterWindowSeconds).toBe(600);
    expect(loadProberConfig({ PROBER_DEAD_LETTER_WINDOW_SECONDS: '' }).deadLetterWindowSeconds).toBe(3600);
  });

  it('refuses a webhook that is not http(s) and limits that are not whole seconds', () => {
    expect(() => loadProberConfig({ ALERT_WEBHOOK_URL: 'file:///etc/passwd' })).toThrow(/ALERT_WEBHOOK_URL/);
    expect(() => loadProberConfig({ PROBER_MAX_JOB_AGE_SECONDS: '1.5' })).toThrow(/PROBER_MAX_JOB_AGE_SECONDS/);
    expect(() => loadProberConfig({ PROBER_DEAD_LETTER_WINDOW_SECONDS: '10' })).toThrow(/PROBER_DEAD_LETTER_WINDOW_SECONDS/);
  });

  it('parses --test-alert and --every', () => {
    expect(parseProberArgs([])).toEqual({ testAlert: false, everySeconds: null });
    expect(parseProberArgs(['--test-alert'])).toEqual({ testAlert: true, everySeconds: null });
    expect(parseProberArgs(['--every', '300'])).toEqual({ testAlert: false, everySeconds: 300 });
    expect(() => parseProberArgs(['--every', '1'])).toThrow(/--every/);
    expect(() => parseProberArgs(['--loud'])).toThrow(/unknown prober argument --loud/);
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
