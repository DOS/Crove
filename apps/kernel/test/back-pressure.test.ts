// Worker watchdog and back-pressure (#894, plan §4.9), without a database: the lag watchdog on fake timers, the
// pausable queue registry against a stub, and the pause and resume decisions.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PausableWork, checkBackPressure, startLagWatchdog } from '../src/back-pressure.ts';

describe('event-loop lag watchdog', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function watch(lags: number[]) {
    const exit = vi.fn();
    const lines: string[] = [];
    let i = 0;
    const stop = startLagWatchdog({
      thresholdMs: 5000,
      sustainMs: 30_000,
      sampleMs: 1000,
      readLagMs: () => lags[Math.min(i++, lags.length - 1)] ?? 0,
      now: () => Date.now(),
      exit,
      log: (line) => lines.push(line),
    });
    return { exit, lines, stop };
  }

  it('exits after lag over 5 s lasts 30 s, with an alert line', () => {
    const { exit, lines } = watch([6000]);
    // The first slow sample, read at 1 s, started 6 s before it: the lag has lasted 30 s at the sample read at 25 s.
    vi.advanceTimersByTime(24_000);
    expect(exit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(exit).toHaveBeenCalledWith(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(lines[0]).toMatch(/^\[alert\] worker event loop lagged over 5000 ms for \d+ s/);
    vi.advanceTimersByTime(10_000);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('exits on one block of 30 s, which a blocked loop reports at once', () => {
    const { exit } = watch([31_000]);
    vi.advanceTimersByTime(1000);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('keeps running when the lag drops before 30 s', () => {
    const lags = [...Array<number>(20).fill(6000), 10, ...Array<number>(20).fill(6000), 10];
    const { exit, stop } = watch(lags);
    vi.advanceTimersByTime(lags.length * 1000);
    expect(exit).not.toHaveBeenCalled();
    stop();
  });

  it('ignores lag at or below the threshold', () => {
    const { exit, stop } = watch([5000]);
    vi.advanceTimersByTime(120_000);
    expect(exit).not.toHaveBeenCalled();
    stop();
  });
});

describe('pausable queues', () => {
  it('stops fetching every registered queue on pause and works them again on resume', async () => {
    const offWork = vi.fn(async (_name: string, _options?: { wait?: boolean }) => {});
    const work = new PausableWork({ offWork });
    const started: string[] = [];
    await work.add('a', async () => started.push('a'));
    await work.add('b', async () => started.push('b'));
    expect(started).toEqual(['a', 'b']);

    await work.pause();
    await work.pause();
    expect(work.paused).toBe(true);
    expect(offWork.mock.calls).toEqual([
      ['a', { wait: false }],
      ['b', { wait: false }],
    ]);
    // A queue registered while paused waits for the resume.
    await work.add('c', async () => started.push('c'));
    expect(started).toEqual(['a', 'b']);

    await work.resume();
    await work.resume();
    expect(work.paused).toBe(false);
    expect(started).toEqual(['a', 'b', 'a', 'b', 'c']);
  });
});

describe('back-pressure check', () => {
  function setup() {
    const state = { paused: false };
    const work = {
      get paused() {
        return state.paused;
      },
      names: ['kernel-agent-wake', 'kernel-mail-bulk'],
      pause: vi.fn(async () => {
        state.paused = true;
      }),
      resume: vi.fn(async () => {
        state.paused = false;
      }),
    };
    const lines: string[] = [];
    const sent: string[] = [];
    return { work, lines, sent, log: (line: string) => lines.push(line), notify: async (text: string) => void sent.push(text) };
  }

  it('pauses over the threshold, stays paused until half of it, then resumes, telling the operator each time', async () => {
    const { work, lines, sent, log, notify } = setup();
    const check = (lag: number) => checkBackPressure({ work, readLagSeconds: async () => lag, thresholdSeconds: 30, log, notify });

    await check(30);
    expect(work.pause).not.toHaveBeenCalled();
    await check(31);
    expect(work.pause).toHaveBeenCalledTimes(1);
    expect(lines[0]).toMatch(/^\[alert\] back-pressure on: outbox lag 31 s is over 30 s.*: kernel-agent-wake, kernel-mail-bulk$/);
    await check(40);
    await check(16);
    expect(work.pause).toHaveBeenCalledTimes(1);
    expect(work.resume).not.toHaveBeenCalled();
    await check(15);
    expect(work.resume).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([
      'back-pressure on: outbox lag 31 s is over 30 s, so agent, bulk mail, archive and retention jobs are paused (docs/runbooks/incidents.md)',
      'back-pressure off: outbox lag 15 s, paused jobs run again',
    ]);
  });

  it('changes nothing when the lag cannot be read', async () => {
    const { work, lines, sent, log, notify } = setup();
    await checkBackPressure({
      work,
      readLagSeconds: async () => {
        throw new Error('connection refused');
      },
      thresholdSeconds: 30,
      log,
      notify,
    });
    expect(work.pause).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
    expect(lines).toEqual(['[back-pressure] could not read the outbox lag: connection refused']);
  });
});
