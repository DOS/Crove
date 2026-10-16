// Prober alert de-duplication (issue #151), unit part: the decision rules, and probes that notify only on news. The
// shared database state (restarts, two probers) is in alert-dedup.db.test.ts.
import { describe, expect, it, vi } from 'vitest';
import { decideAlert, memoryAlertGate, problemKey, type AlertGate, type GateResult, type GateState } from '../src/alert-gate.ts';
import { formatDuration } from '../src/alert.ts';
import { EXIT, probeOnce, runProber, type HealthSnapshot, type ProberConfig } from '../src/prober.ts';

const HOOK = 'https://hooks.example.test/services/T000/B000/secret-token-123';
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
};
const workerDown = { ...healthy, worker_heartbeat_age_seconds: 900 };
const workerAndRelayDown = { ...workerDown, outbox_pending: 3, outbox_oldest_age_seconds: 1200 };

const config = (overrides: Partial<ProberConfig> = {}): ProberConfig => ({
  databaseUrl: 'postgres://crove_prober:pw@db:5432/postgres',
  webhookUrl: HOOK,
  webhookFormat: 'generic',
  telegramChatId: undefined,
  repeatSeconds: 3600,
  instance: 'office',
  thresholds: { outboxAgeSeconds: 300, jobAgeSeconds: 900, heartbeatAgeSeconds: 120, deadLetters: 0, notifyQueuePercent: 50 },
  deadLetterWindowSeconds: 360,
  ...overrides,
});

const T0 = Date.parse('2026-10-16T12:00:00Z');
const minutes = (n: number) => new Date(T0 + n * 60_000);
const EMPTY: GateState = { problem: null, startedAt: null, notifiedAt: null };

// A probe harness: one gate (the shared state) and one outage gate across probes, a webhook that records texts.
function harness(options: { repeatSeconds?: number; status?: () => number } = {}) {
  const texts: string[] = [];
  const bodies: Array<{ text: string; crove: Record<string, unknown> }> = [];
  const out: string[] = [];
  const err: string[] = [];
  const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { text: string; crove: Record<string, unknown> };
    const status = options.status?.() ?? 200;
    if (status === 200) {
      texts.push(body.text);
      bodies.push(body);
    }
    return new Response('ok', { status });
  }) as unknown as typeof globalThis.fetch;
  const repeatSeconds = options.repeatSeconds ?? 3600;
  const gate = memoryAlertGate(repeatSeconds);
  const outageGate = memoryAlertGate(repeatSeconds);
  const probe = (at: Date, health: HealthSnapshot | Error) =>
    probeOnce(config({ repeatSeconds }), {
      fetch,
      gate,
      outageGate,
      now: () => at,
      log: (l) => out.push(l),
      error: (l) => err.push(l),
      readHealth: async () => {
        if (health instanceof Error) throw health;
        return health;
      },
    });
  return { probe, texts, bodies, out, err, fetch };
}

describe('the decision rules', () => {
  it('keys a problem by its sorted failing checks, not by their values', () => {
    expect(problemKey([])).toBeNull();
    expect(problemKey(['outbox', 'heartbeat', 'outbox'])).toBe('heartbeat,outbox');
  });

  it('walks healthy, new, suppressed, repeat, changed, resolved', () => {
    const repeat = 3600;
    let state = EMPTY;
    const step = (problem: string | null, at: Date) => {
      const { result, next } = decideAlert(state, problem, at, repeat);
      state = next;
      return result;
    };
    expect(step(null, minutes(0))).toEqual({ decision: 'healthy', previousProblem: null, problemSince: null, lastNotifiedAt: null });
    expect(step('heartbeat', minutes(5)).decision).toBe('new');
    expect(step('heartbeat', minutes(10))).toEqual({ decision: 'suppressed', previousProblem: 'heartbeat', problemSince: minutes(5), lastNotifiedAt: minutes(5) });
    expect(step('heartbeat', minutes(64)).decision).toBe('suppressed');
    expect(step('heartbeat', minutes(65)).decision).toBe('repeat');
    expect(step('heartbeat', minutes(70)).decision).toBe('suppressed');
    // Another set of failing checks is news at once, and restarts the repeat interval but not the problem's age.
    expect(step('heartbeat,outbox', minutes(75))).toEqual({ decision: 'changed', previousProblem: 'heartbeat', problemSince: minutes(5), lastNotifiedAt: minutes(65) });
    expect(step('heartbeat,outbox', minutes(130)).decision).toBe('suppressed');
    expect(step(null, minutes(140))).toEqual({ decision: 'resolved', previousProblem: 'heartbeat,outbox', problemSince: minutes(5), lastNotifiedAt: minutes(75) });
    expect(step(null, minutes(150)).decision).toBe('healthy');
    expect(step('heartbeat', minutes(151)).decision).toBe('new');
  });

  it('never repeats with 0 and clamps short intervals to a minute', () => {
    const quiet = decideAlert({ problem: 'heartbeat', startedAt: minutes(0), notifiedAt: minutes(0) }, 'heartbeat', minutes(60 * 24 * 30), 0);
    expect(quiet.result.decision).toBe('suppressed');
    const state = { problem: 'heartbeat', startedAt: minutes(0), notifiedAt: minutes(0) };
    expect(decideAlert(state, 'heartbeat', new Date(T0 + 59_000), 1).result.decision).toBe('suppressed');
    expect(decideAlert(state, 'heartbeat', new Date(T0 + 60_000), 1).result.decision).toBe('repeat');
  });

  it('records a decision only when the caller settles it as delivered', async () => {
    const gate = memoryAlertGate(3600);
    expect((await gate.decide('heartbeat', minutes(0))).decision).toBe('new');
    await gate.settle(false);
    expect((await gate.decide('heartbeat', minutes(1))).decision).toBe('new');
    await gate.settle(true);
    expect((await gate.decide('heartbeat', minutes(2))).decision).toBe('suppressed');
    await gate.settle(true);
  });

  it('formats durations for people', () => {
    expect([45, 60, 754, 3600, 11_100, 86_400, 187_200].map(formatDuration)).toEqual(['45 s', '1 min', '12 min', '1 h', '3 h 5 min', '1 d', '2 d 4 h']);
  });
});

describe('probes notify on news only', () => {
  it('alerts once for a lasting problem, repeats it after the interval, and says when it is resolved', async () => {
    const h = harness();
    expect(await h.probe(minutes(0), healthy)).toBe(EXIT.ok);
    expect(await h.probe(minutes(5), workerDown)).toBe(EXIT.unhealthy);
    expect(await h.probe(minutes(10), workerDown)).toBe(EXIT.unhealthy);
    expect(await h.probe(minutes(15), workerDown)).toBe(EXIT.unhealthy);
    expect(h.texts).toEqual(['[Crove] ALERT on office: 1 health check(s) failed.\n- last worker heartbeat was 900 s ago (limit 120 s): the worker is down']);
    // Every probe still logs what fails, and says why it sent nothing.
    expect(h.err.filter((l) => l.startsWith('[prober] FAIL heartbeat'))).toHaveLength(3);
    expect(h.out).toContain('[prober] notification skipped: already notified at 2026-10-16T12:05:00.000Z, repeats from 2026-10-16T13:05:00.000Z');

    expect(await h.probe(minutes(65), workerDown)).toBe(EXIT.unhealthy);
    expect(h.texts[1]).toBe('[Crove] STILL FAILING on office for 1 h: 1 health check(s) failed.\n- last worker heartbeat was 900 s ago (limit 120 s): the worker is down');
    expect(h.bodies[1]?.crove).toMatchObject({ kind: 'alert', state: 'repeat', severity: 'critical', since: '2026-10-16T12:05:00.000Z' });

    expect(await h.probe(minutes(70), workerAndRelayDown)).toBe(EXIT.unhealthy);
    expect(h.texts[2]).toMatch(/^\[Crove\] ALERT on office: 2 health check\(s\) failed \(was: heartbeat\)\.\n- oldest unpublished outbox event/);
    expect(h.bodies[2]?.crove).toMatchObject({ state: 'changed', previous: ['heartbeat'] });

    expect(await h.probe(minutes(80), healthy)).toBe(EXIT.ok);
    expect(h.texts[3]).toBe('[Crove] RESOLVED on office: the failing health checks pass again after 1 h 15 min (heartbeat, outbox).');
    expect(h.bodies[3]?.crove).toMatchObject({ kind: 'resolved', severity: 'info', findings: [], previous: ['heartbeat', 'outbox'] });
    expect(h.out).toContain('[prober] resolved notice sent to webhook at hooks.example.test');

    expect(await h.probe(minutes(85), healthy)).toBe(EXIT.ok);
    expect(h.texts).toHaveLength(4);
  });

  it('notifies only on start, change and end with ALERT_REPEAT_MINUTES=0', async () => {
    const h = harness({ repeatSeconds: 0 });
    for (let m = 0; m <= 600; m += 5) await h.probe(minutes(m), workerDown);
    await h.probe(minutes(605), healthy);
    expect(h.texts.map((t) => t.split(':')[0])).toEqual(['[Crove] ALERT on office', '[Crove] RESOLVED on office']);
  });

  it('keeps an undelivered alert due: the next probe sends it, and exit 3 says it failed', async () => {
    let status = 500;
    const h = harness({ status: () => status });
    expect(await h.probe(minutes(0), workerDown)).toBe(EXIT.deliveryFailed);
    expect(h.err).toContain('[prober] alert delivery: webhook at hooks.example.test failed: HTTP 500');
    status = 200;
    expect(await h.probe(minutes(5), workerDown)).toBe(EXIT.unhealthy);
    expect(h.texts).toHaveLength(1);
    expect(h.texts[0]).toMatch(/^\[Crove\] ALERT on office: 1 health check/);
  });

  it('de-duplicates an unreachable database in process and says when it answers again', async () => {
    const h = harness();
    const down = new Error('connect ECONNREFUSED 10.0.0.5:5432');
    expect(await h.probe(minutes(0), down)).toBe(EXIT.probeFailed);
    expect(await h.probe(minutes(5), down)).toBe(EXIT.probeFailed);
    expect(await h.probe(minutes(30), down)).toBe(EXIT.probeFailed);
    expect(h.texts).toEqual(['[Crove] ALERT on office: 1 health check(s) failed.\n- the prober could not read crove_kernel.health(): connect ECONNREFUSED 10.0.0.5:5432']);
    expect(await h.probe(minutes(40), healthy)).toBe(EXIT.ok);
    expect(h.texts[1]).toBe('[Crove] RESOLVED on office: the prober reads crove_kernel.health() again after 40 min.');
    expect(h.texts).toHaveLength(2);
  });

  it('a cron run (one probe per process) alerts on every run while the database is unreachable', async () => {
    const fetch = vi.fn(async () => new Response('ok')) as unknown as typeof globalThis.fetch;
    const deps = { fetch, log: () => {}, error: () => {}, readHealth: async () => Promise.reject(new Error('down')) };
    await probeOnce(config(), deps);
    await probeOnce(config(), deps);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('alerts without de-duplication when the shared state cannot be read', async () => {
    const broken: AlertGate = {
      decide: async () => {
        throw new Error('function crove_kernel.prober_alert_gate(text, integer) does not exist');
      },
      settle: async () => {},
    };
    const fetch = vi.fn(async () => new Response('ok')) as unknown as typeof globalThis.fetch;
    const err: string[] = [];
    const deps = { fetch, gate: broken, log: () => {}, error: (l: string) => err.push(l) };
    expect(await probeOnce(config(), { ...deps, readHealth: async () => workerDown })).toBe(EXIT.unhealthy);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(err).toContain('[prober] alert state unavailable, notifying without de-duplication: function crove_kernel.prober_alert_gate(text, integer) does not exist');
    // Healthy: nothing to say, even without the state.
    expect(await probeOnce(config(), { ...deps, readHealth: async () => healthy })).toBe(EXIT.ok);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('sends nothing while another prober holds the state, and still exits on health', async () => {
    const settled: boolean[] = [];
    const busy: AlertGate = {
      decide: async (): Promise<GateResult> => ({ decision: 'busy', previousProblem: null, problemSince: null, lastNotifiedAt: null }),
      settle: async (delivered) => void settled.push(delivered),
    };
    const fetch = vi.fn(async () => new Response('ok')) as unknown as typeof globalThis.fetch;
    const out: string[] = [];
    expect(await probeOnce(config(), { fetch, gate: busy, log: (l) => out.push(l), error: () => {}, readHealth: async () => workerDown })).toBe(EXIT.unhealthy);
    expect(fetch).not.toHaveBeenCalled();
    expect(settled).toEqual([true]);
    expect(out).toContain('[prober] notification skipped: another prober is sending the notification for this probe');
  });

  it('treats a sink that throws as a failed delivery: the state is rolled back and the probe returns 3', async () => {
    const settled: boolean[] = [];
    const inner = memoryAlertGate(3600);
    const gate: AlertGate = { decide: (p, n) => inner.decide(p, n), settle: async (d) => (settled.push(d), inner.settle(d)) };
    const sink = {
      describe: () => 'pager',
      deliver: async () => {
        throw new Error('pager offline');
      },
    };
    const err: string[] = [];
    expect(await probeOnce(config(), { sink, gate, log: () => {}, error: (l) => err.push(l), readHealth: async () => workerDown })).toBe(EXIT.deliveryFailed);
    expect(settled).toEqual([false]);
    expect(err).toContain('[prober] alert delivery: pager failed: pager offline');
    expect((await gate.decide('heartbeat', minutes(1))).decision).toBe('new');
    expect(await runProber(['--test-alert'], {}, { sink, log: () => {}, error: () => {} })).toBe(EXIT.deliveryFailed);
  });

  it('keeps an outage reason on one line', async () => {
    const texts: string[] = [];
    const fetch = vi.fn(async (_u: string | URL | Request, init?: RequestInit) => {
      texts.push((JSON.parse(String(init?.body)) as { text: string }).text);
      return new Response('ok');
    }) as unknown as typeof globalThis.fetch;
    await probeOnce(config(), { fetch, log: () => {}, error: () => {}, readHealth: async () => Promise.reject(new Error('FATAL: no\n# heading\n> quote')) });
    expect(texts[0]?.split('\n')).toEqual(['[Crove] ALERT on office: 1 health check(s) failed.', '- the prober could not read crove_kernel.health(): FATAL: no # heading > quote']);
  });

  it('reads ALERT_REPEAT_MINUTES (default 60, 0 for never) and refuses other values', async () => {
    const { loadProberConfig } = await import('../src/prober.ts');
    expect(loadProberConfig({}).repeatSeconds).toBe(3600);
    expect(loadProberConfig({ ALERT_REPEAT_MINUTES: '0' }).repeatSeconds).toBe(0);
    expect(loadProberConfig({ ALERT_REPEAT_MINUTES: '15' }).repeatSeconds).toBe(900);
    expect(() => loadProberConfig({ ALERT_REPEAT_MINUTES: '-1' })).toThrow(/ALERT_REPEAT_MINUTES/);
    expect(() => loadProberConfig({ ALERT_REPEAT_MINUTES: '1.5' })).toThrow(/ALERT_REPEAT_MINUTES/);
    expect(() => loadProberConfig({ ALERT_REPEAT_MINUTES: '20000' })).toThrow(/ALERT_REPEAT_MINUTES/);
    expect(await runProber([], { ALERT_REPEAT_MINUTES: 'often' }, { log: () => {}, error: () => {} })).toBe(EXIT.probeFailed);
  });
});
