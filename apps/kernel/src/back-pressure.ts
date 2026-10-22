// Worker watchdog and back-pressure (plan §4.9 "CPU-heavy work" and "Back-pressure", issue #894).
//   Watchdog: event-loop lag above WORKER_LAG_EXIT_MS (5 s) for WORKER_LAG_SUSTAIN_MS (30 s) exits the process (exit
//   code 1), so the container restarts it instead of leaving a worker that holds its jobs and relays nothing.
//   Back-pressure: while the oldest unpublished outbox event is older than OUTBOX_LAG_PAUSE_SECONDS, the worker stops
//   fetching background, agent and bulk jobs (PAUSABLE_QUEUES), so the relay and interactive work get the database
//   and the event loop. They are fetched again once the outbox has caught up.
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { sql } from 'kysely';
import type { Db } from '@crove/db';

export const WORKER_LAG_EXIT_MS = 5000;
export const WORKER_LAG_SUSTAIN_MS = 30_000;
export const LAG_SAMPLE_MS = 1000;
export const DEFAULT_OUTBOX_LAG_PAUSE_SECONDS = 30;
export const BACK_PRESSURE_CHECK_MS = 10_000;

export interface LagWatchdogOptions {
  thresholdMs: number;
  sustainMs: number;
  exit: (code: number) => void;
  sampleMs?: number;
  // The largest event-loop delay since the last read, in milliseconds (default: a perf_hooks histogram).
  readLagMs?: () => number;
  now?: () => number;
  log?: (line: string) => void;
}

function histogramLag(): { read: () => number; stop: () => void } {
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  return {
    read: () => {
      const max = histogram.max / 1e6;
      histogram.reset();
      return max;
    },
    stop: () => histogram.disable(),
  };
}

// Starts the watchdog and returns its stop function. Lag counts as sustained from the start of the first slow sample
// (its time less its lag, since a blocked loop reports the whole block at once) until a sample is fast again.
export function startLagWatchdog(options: LagWatchdogOptions): () => void {
  const now = options.now ?? Date.now;
  const log = options.log ?? ((line: string) => console.error(line));
  const histogram = options.readLagMs ? null : histogramLag();
  const read = options.readLagMs ?? (histogram as { read: () => number }).read;
  let slowSince: number | null = null;
  const timer = setInterval(() => {
    const lag = read();
    const at = now();
    if (lag <= options.thresholdMs) {
      slowSince = null;
      return;
    }
    slowSince ??= at - lag;
    if (at - slowSince >= options.sustainMs) {
      clearInterval(timer);
      histogram?.stop();
      log(`[alert] worker event loop lagged over ${options.thresholdMs} ms for ${Math.round((at - slowSince) / 1000)} s (last ${Math.round(lag)} ms): exiting so it restarts`);
      options.exit(1);
    }
  }, options.sampleMs ?? LAG_SAMPLE_MS);
  timer.unref();
  return () => {
    clearInterval(timer);
    histogram?.stop();
  };
}

// The queues back-pressure pauses: agents, bulk mail and archive or retention work. Everything a person waits for
// (extraction, inbound mail, transactional mail, notifications, publishing, sign-out, exports) keeps running.
export interface WorkStopper {
  offWork(name: string, options?: { wait?: boolean }): Promise<void>;
}

export class PausableWork {
  readonly #boss: WorkStopper;
  readonly #queues: { name: string; start: () => Promise<unknown> }[] = [];
  #paused = false;

  constructor(boss: WorkStopper) {
    this.#boss = boss;
  }

  get paused(): boolean {
    return this.#paused;
  }

  get names(): string[] {
    return this.#queues.map((q) => q.name);
  }

  // Registers a queue and starts working it (start calls boss.work with its options and handler).
  async add(name: string, start: () => Promise<unknown>): Promise<void> {
    this.#queues.push({ name, start });
    if (!this.#paused) await start();
  }

  // Stops fetching; jobs already running finish.
  async pause(): Promise<void> {
    if (this.#paused) return;
    this.#paused = true;
    await Promise.all(this.#queues.map((q) => this.#boss.offWork(q.name, { wait: false })));
  }

  async resume(): Promise<void> {
    if (!this.#paused) return;
    this.#paused = false;
    await Promise.all(this.#queues.map((q) => q.start()));
  }
}

export async function outboxLagSeconds(workerDb: Db): Promise<number> {
  const { rows } = await sql<{ lag: number }>`SELECT crove_kernel.outbox_lag_seconds() AS lag`.execute(workerDb);
  return Number(rows[0]?.lag ?? 0);
}

export interface BackPressureDeps {
  work: Pick<PausableWork, 'paused' | 'pause' | 'resume' | 'names'>;
  readLagSeconds: () => Promise<number>;
  thresholdSeconds: number;
  log?: (line: string) => void;
  // Tells the operator (the alert webhook, as for the prober); a failure is the caller's to log.
  notify?: ((text: string) => Promise<void>) | undefined;
}

// One check: pauses above the threshold and resumes once the lag is back to half of it, so a lag hovering at the
// threshold does not pause and resume every check. A failed read changes nothing.
export async function checkBackPressure(deps: BackPressureDeps): Promise<void> {
  const log = deps.log ?? ((line: string) => console.warn(line));
  let lag: number;
  try {
    lag = await deps.readLagSeconds();
  } catch (error) {
    log(`[back-pressure] could not read the outbox lag: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  let text: string | null = null;
  if (lag > deps.thresholdSeconds && !deps.work.paused) {
    await deps.work.pause();
    text = `back-pressure on: outbox lag ${Math.round(lag)} s is over ${deps.thresholdSeconds} s, so agent, bulk mail, archive and retention jobs are paused (docs/runbooks/incidents.md)`;
    log(`[alert] ${text}: ${deps.work.names.join(', ')}`);
  } else if (lag <= deps.thresholdSeconds / 2 && deps.work.paused) {
    await deps.work.resume();
    text = `back-pressure off: outbox lag ${Math.round(lag)} s, paused jobs run again`;
    log(`[back-pressure] ${text}`);
  }
  if (text && deps.notify) await deps.notify(text);
}
