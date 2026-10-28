// The Phase 1 load test's arguments, percentiles and verdicts (issue #998). The run itself is
// load-test.db.test.ts.
import { describe, expect, it } from 'vitest';
import {
  BACK_PRESSURE_QUEUES,
  DEFAULT_LOAD_ARGS,
  formatReport,
  guardCostUs,
  judge,
  judgeBackPressure,
  parseLoadArgs,
  percentile,
  sampleLocks,
  type BackPressureResult,
  type LoadResult,
} from '../load/load-test.ts';

// Back-pressure that engaged: the lag passed 30 s at 30.2 s, the queues paused at the next 10 s check (40 s) and
// resumed at the check after the relay caught up.
const engaged = (over: Partial<BackPressureResult> = {}): BackPressureResult => ({
  thresholdSeconds: 30,
  checkSeconds: 10,
  queues: [...BACK_PRESSURE_QUEUES],
  lagOverAt: 30_200,
  pausedAt: 40_100,
  lagUnderHalfAt: 44_300,
  resumedAt: 50_060,
  maxLagSeconds: 44.1,
  sent: 4,
  held: 4,
  ranAfterResume: 4,
  interactiveRan: true,
  commands: { count: 3000, failed: 0, firstError: null, p95: 19 },
  ...over,
});

const result = (over: Partial<LoadResult['outbox']> = {}, p95 = 20, failed = 0): LoadResult => ({
  parties: 100_000,
  commands: [{ name: 'kernel.party.update', count: 2000, failed, firstError: failed ? 'X: boom' : null, p50: 10, p95, p99: 30 }],
  queries: [{ name: 'finance.search', count: 30, p95: 80 }],
  outbox: { rate: 60, produced: 1800, relayed: 1800, lagP95: 15, lagMax: 70, backlog: 1800, drainSeconds: 0.1, eventsPerSecond: 18_000, ...over },
  locks: { samples: 40, p50: 60, p95: 100, max: 200 },
  backPressure: engaged(),
});

describe('load test', () => {
  it('reads the flags, with the plan sizes by default, and needs an admin URL', () => {
    expect(parseLoadArgs([], { CROVE_TEST_ADMIN_URL: 'postgres://x' })).toEqual({ adminUrl: 'postgres://x', ...DEFAULT_LOAD_ARGS });
    expect(DEFAULT_LOAD_ARGS.parties).toBe(100_000);
    expect(parseLoadArgs(['--admin-url', 'postgres://y', '--parties', '500', '--rate', '80', '--keep'])).toMatchObject({ adminUrl: 'postgres://y', parties: 500, rate: 80, keep: true });
    // The worker's back-pressure threshold and check interval by default (OUTBOX_LAG_PAUSE_SECONDS, BACK_PRESSURE_CHECK_MS).
    expect(DEFAULT_LOAD_ARGS).toMatchObject({ pauseSeconds: 30, checkSeconds: 10 });
    expect(parseLoadArgs(['--admin-url', 'x', '--pause-seconds', '2', '--check-seconds', '1'])).toMatchObject({ pauseSeconds: 2, checkSeconds: 1 });
    expect(() => parseLoadArgs([])).toThrow(/admin-url/);
    expect(() => parseLoadArgs(['--admin-url', 'x', '--parties', '0'])).toThrow(/whole number/);
    expect(() => parseLoadArgs(['--admin-url', 'x', '--bogus', '1'])).toThrow(/unknown flag/);
    expect(() => parseLoadArgs(['--admin-url'])).toThrow(/needs a value/);
  });

  it('takes nearest-rank percentiles', () => {
    const samples = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(samples, 50)).toBe(50);
    expect(percentile(samples, 95)).toBe(95);
    expect(percentile([3, 1, 2], 99)).toBe(3);
    expect(percentile([], 95)).toBeNull();
  });

  it('passes the plan targets, and fails a slow or failing command, a lagging outbox or a slow relay', () => {
    expect(judge(result()).map((v) => v.ok)).toEqual([true, true, true, true, true, true]);
    expect(judge(result({}, 150))[0]?.ok).toBe(false);
    expect(judge(result({}, 20, 1))[0]?.ok).toBe(false);
    expect(judge(result({ lagP95: 2000 }))[1]?.ok).toBe(false);
    expect(judge(result({ lagP95: null }))[1]?.ok).toBe(false);
    expect(judge(result({ eventsPerSecond: 49 }))[2]?.ok).toBe(false);
  });

  it('fails back-pressure that never engages, holds no job, is slow to pause or resume, or stops interactive work', () => {
    const ok = (over: Partial<BackPressureResult>) => judgeBackPressure(engaged(over)).map((v) => v.ok);
    expect(ok({})).toEqual([true, true, true]);
    // A no-op check: the lag passes the threshold and nothing pauses, so nothing resumes and the jobs run at once.
    expect(ok({ pausedAt: null, resumedAt: null, held: 0, ranAfterResume: 0, interactiveRan: false })).toEqual([false, false, false]);
    // Paused but a queue kept fetching: its job ran during the pause.
    expect(ok({ held: 3, ranAfterResume: 3 })).toEqual([false, false, true]);
    // Within one check plus 1 s, and no more.
    expect(ok({ pausedAt: 30_200 + 11_000 })[0]).toBe(true);
    expect(ok({ pausedAt: 30_200 + 11_001 })[0]).toBe(false);
    expect(ok({ resumedAt: 44_300 + 11_001 })[1]).toBe(false);
    expect(ok({ resumedAt: null, ranAfterResume: 0 })).toEqual([true, false, true]);
    // Interactive work: the interactive queue's job, and the commands meanwhile.
    expect(ok({ interactiveRan: false })[2]).toBe(false);
    expect(ok({ commands: { count: 10, failed: 1, firstError: 'X: boom', p95: 19 } })[2]).toBe(false);
    expect(ok({ commands: { count: 10, failed: 0, firstError: null, p95: 150 } })[2]).toBe(false);
    expect(ok({ commands: { count: 0, failed: 0, firstError: null, p95: null } })[2]).toBe(false);
  });

  it('prints every measure, the first failure and a verdict per target', () => {
    const r = result({}, 20, 2);
    const text = formatReport(r, judge(r));
    expect(text).toContain('100000 parties');
    expect(text).toContain('first failure: X: boom');
    expect(text).toContain('finance.search');
    expect(text).toMatch(/FAIL {2}p95 kernel.party.update/);
    expect(text).toMatch(/PASS {2}back-pressure pause: 9\.9 s after the lag passed 30 s; 4\/4 held \(target within 10 s \+ 1 s/);
    expect(text).toMatch(/PASS {2}back-pressure resume: 5\.8 s after the lag fell to 15 s; 4\/4 ran/);
    expect(text).toContain('lag passed 30 s at 30.2 s, queues paused at 40.1 s (9.9 s later), max lag 44.1 s');
    expect(text).toContain('lag back to 15 s at 44.3 s, queues resumed at 50.1 s (5.8 s later)');
    const never = { ...r, backPressure: engaged({ pausedAt: null, resumedAt: null, held: 0, ranAfterResume: 0 }) };
    const neverText = formatReport(never, judge(never));
    expect(neverText).toMatch(/FAIL {2}back-pressure pause: never paused; 0\/4 held/);
    expect(neverText).toContain('queues paused: never, max lag');
    expect(neverText).toContain('4 sent after the wait for a pause, 0 held');
  });

  it('reports the locks held while the commands ran and the context guard cost they imply (T10)', () => {
    expect(guardCostUs(0)).toBe(13);
    expect(guardCostUs(100)).toBeCloseTo(40, 6);
    const text = formatReport(result(), []);
    expect(text).toContain('Locks held server-wide during the commands: n=40 p50=60 p95=100 max=200');
    expect(text).toContain('40.0 us at p95, 67.0 us at max');
    expect(formatReport({ ...result(), locks: { samples: 0, p50: null, p95: null, max: null } }, [])).toContain('during the commands: no sample');
  });

  it('keeps the lock counts taken so far when the sampler fails, and never fails the run', async () => {
    let calls = 0;
    const failing = sampleLocks('postgres://unused', 1, () => ({
      connect: async () => {},
      end: async () => {},
      query: async () => {
        calls += 1;
        if (calls > 2) throw new Error('connection terminated');
        return { rows: [{ n: 5 }] };
      },
    }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(await failing.stop()).toEqual({ counts: [5, 5], error: 'connection terminated' });

    const unreachable = sampleLocks('postgres://unused', 1, () => ({
      connect: async () => {
        throw new Error('ECONNREFUSED');
      },
      end: async () => {
        throw new Error('not connected');
      },
      query: async () => ({ rows: [] }),
    }));
    expect(await unreachable.stop()).toEqual({ counts: [], error: 'ECONNREFUSED' });
  });
});
