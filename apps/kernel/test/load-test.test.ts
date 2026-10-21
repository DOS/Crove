// The Phase 1 load test's arguments, percentiles and verdicts (issue #998). The run itself is
// load-test.db.test.ts.
import { describe, expect, it } from 'vitest';
import { DEFAULT_LOAD_ARGS, formatReport, judge, parseLoadArgs, percentile, type LoadResult } from '../load/load-test.ts';

const result = (over: Partial<LoadResult['outbox']> = {}, p95 = 20, failed = 0): LoadResult => ({
  parties: 100_000,
  commands: [{ name: 'kernel.party.update', count: 2000, failed, firstError: failed ? 'X: boom' : null, p50: 10, p95, p99: 30 }],
  queries: [{ name: 'finance.search', count: 30, p95: 80 }],
  outbox: { rate: 60, produced: 1800, relayed: 1800, lagP95: 15, lagMax: 70, backlog: 1800, drainSeconds: 0.1, eventsPerSecond: 18_000, ...over },
});

describe('load test', () => {
  it('reads the flags, with the plan sizes by default, and needs an admin URL', () => {
    expect(parseLoadArgs([], { CROVE_TEST_ADMIN_URL: 'postgres://x' })).toEqual({ adminUrl: 'postgres://x', ...DEFAULT_LOAD_ARGS });
    expect(DEFAULT_LOAD_ARGS.parties).toBe(100_000);
    expect(parseLoadArgs(['--admin-url', 'postgres://y', '--parties', '500', '--rate', '80', '--keep'])).toMatchObject({ adminUrl: 'postgres://y', parties: 500, rate: 80, keep: true });
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

  it('passes the plan targets, fails a slow or failing command, a lagging outbox or a slow relay, and leaves back-pressure open', () => {
    expect(judge(result()).map((v) => v.ok)).toEqual([true, true, true, null]);
    expect(judge(result({}, 150))[0]?.ok).toBe(false);
    expect(judge(result({}, 20, 1))[0]?.ok).toBe(false);
    expect(judge(result({ lagP95: 2000 }))[1]?.ok).toBe(false);
    expect(judge(result({ lagP95: null }))[1]?.ok).toBe(false);
    expect(judge(result({ eventsPerSecond: 49 }))[2]?.ok).toBe(false);
  });

  it('prints every measure, the first failure and a verdict per target', () => {
    const r = result({}, 20, 2);
    const text = formatReport(r, judge(r));
    expect(text).toContain('100000 parties');
    expect(text).toContain('first failure: X: boom');
    expect(text).toContain('finance.search');
    expect(text).toMatch(/FAIL {2}p95 kernel.party.update/);
    expect(text).toMatch(/N\/A {3}back-pressure/);
  });
});
