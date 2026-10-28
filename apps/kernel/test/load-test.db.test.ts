// The Phase 1 load test (issue #998) runs end to end on a small scale: its own database, the seeded parties, the
// commands, queries, outbox and back-pressure phases (#1717), then the database dropped. The full size runs by hand (docs/runbooks/load-test.md).
// Set CROVE_TEST_ADMIN_URL to a superuser URL.
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { DEFAULT_LOAD_ARGS, formatReport, judge, runLoad } from '../load/load-test.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const suite = ADMIN ? describe : describe.skip;

suite('load test on PostgreSQL (#998)', () => {
  it('measures every phase on a small scale and drops its database', async () => {
    const lines: string[] = [];
    const result = await runLoad(
      // Back-pressure at a 2 s threshold checked every second, so the stall takes seconds instead of the worker's 30 s.
      { adminUrl: ADMIN as string, parties: 300, commands: 20, concurrency: 4, queries: 2, rate: 20, seconds: 1, pauseSeconds: 2, checkSeconds: 1, keep: false },
      (line) => lines.push(line),
    );
    expect(result.parties).toBe(300);
    for (const c of result.commands) expect(c).toMatchObject({ count: 20, failed: 0, firstError: null });
    expect(result.queries.map((q) => q.count)).toEqual([2, 2, 2, 2]);
    expect(result.outbox).toMatchObject({ produced: 20, relayed: 20, backlog: 1000 });
    expect(result.outbox.lagP95).not.toBeNull();
    // pg_locks was sampled while the commands ran (T10); the sampler's own query holds at least one lock.
    expect(result.locks.samples).toBeGreaterThan(0);
    expect(result.locks.max).toBeGreaterThanOrEqual(1);
    // Every target gets a verdict from a measurement. Whether the speed targets pass depends on the machine (a shared
    // CI runner is not the pilot server), so they are checked by the full run in the runbook.
    const verdicts = judge(result);
    expect(verdicts.map((v) => v.ok === null)).toEqual([false, false, false, false, false, false, false]);

    // Back-pressure must engage (#1717): the worker's check (apps/kernel/src/back-pressure.ts) paused the agent, bulk
    // mail, archive and retention queues after the lag passed the threshold, every job sent to them meanwhile waited,
    // the interactive queue and the commands kept running, and the queues resumed and worked those jobs once the relay
    // caught up. A check that does nothing fails here.
    const bp = result.backPressure;
    expect(bp.lagOverAt).not.toBeNull();
    expect(bp.pausedAt).not.toBeNull();
    expect(bp.pausedAt as number).toBeGreaterThanOrEqual(bp.lagOverAt as number);
    expect(bp.lagUnderHalfAt).not.toBeNull();
    expect(bp.resumedAt).not.toBeNull();
    expect(bp.resumedAt as number).toBeGreaterThanOrEqual(bp.lagUnderHalfAt as number);
    expect(bp).toMatchObject({ sent: 4, held: 4, ranAfterResume: 4, interactiveRan: true });
    expect(bp.commands).toMatchObject({ failed: 0, firstError: null });
    expect(bp.commands.count).toBeGreaterThan(0);
    // Pause and resume each within one check (1 s) plus the slack: the timing is the worker's loop, not the machine.
    // The check's own lag reads are recorded too, so a pause or resume never comes before the crossing it answers.
    expect(verdicts.filter((v) => v.check.startsWith('back-pressure ')).map((v) => [v.check, v.ok])).toEqual([
      ['back-pressure pause', true],
      ['back-pressure resume', true],
    ]);

    console.log(`TEMP-1717 small report\n${formatReport(result, verdicts)}`);
    const name = lines.find((l) => l.startsWith('database '))?.split(' ')[1];
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    try {
      expect((await root.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])).rows).toEqual([]);
    } finally {
      await root.end();
    }
  }, 300_000);

  // TEMPORARY (#1717): the full default run on the CI runner, for the runbook's numbers. Removed before review.
  it('TEMP-1717 full run', async () => {
    const result = await runLoad({ adminUrl: ADMIN as string, ...DEFAULT_LOAD_ARGS }, (line) => console.log(`[load-test] ${line}`));
    console.log(`TEMP-1717 full report\n${formatReport(result, judge(result))}`);
  }, 1_200_000);
});
