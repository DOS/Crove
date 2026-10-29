// The Phase 1 load test (plan §13 Phase 1 exit criterion 7, §7.2, issue #998). It creates its own database on a
// PostgreSQL server it reaches as a superuser, migrates it, seeds one org with many parties, measures and drops the
// database. It needs no Crove deployment and touches no other database.
//
//   node apps/kernel/load/load-test.ts --admin-url <postgres URL> [--parties 100000] [--commands 2000]
//        [--concurrency 8] [--queries 30] [--rate 60] [--seconds 30] [--pause-seconds 30] [--check-seconds 10] [--keep]
//
// A tool, not product code: it lives outside apps/kernel/src, so the one-write-path check (#680) does not cover its
// seeding and its own connections. Everything it measures runs through the runtime and the definers like the API.
//
// What it measures, against the plan's targets:
//   - R1 commands through Runtime.execute with the session status check on (kernel.party.update on the seeded parties,
//     and kernel.file.ingest), as the API runs them: p50, p95, p99. Target: p95 < 150 ms.
//   - The party list and search queries over the seeded parties (finance.vendors.list, finance.customers.list,
//     finance.search): p95 per query. Reported, no target in the plan.
//   - The outbox: kernel.file.ingest at --rate commands per second for --seconds while one relay loop claims the events
//     the way the worker does (crove_kernel.outbox_claim, 100 at a time). Lag is from the event's emit to its claim,
//     both by the database clock: an event id is a UUIDv7 whose first 48 bits are the emit time in milliseconds. Targets: p95 lag < 2 s, at least 50 events per second relayed.
//     The relay here claims and drops; the worker also sends each claimed event to its job queue, so this is the
//     database's share of the lag.
//   - Back-pressure (plan §4.9, built in #894, measured here since #1717): with pg-boss on the throwaway database and
//     the worker's own PausableWork and checkBackPressure (apps/kernel/src/back-pressure.ts), the relay stops while
//     kernel.file.ingest keeps running at --rate, so the outbox lag climbs past --pause-seconds
//     (OUTBOX_LAG_PAUSE_SECONDS). The check runs every --check-seconds, as the worker's does. Measured: how long after
//     the lag passed the threshold the agent, bulk mail, archive and retention queues paused, whether their jobs sent
//     meanwhile waited while an interactive queue's job and the commands ran, and how long after the relay brought the
//     lag back to half the threshold the queues resumed and worked the jobs that waited. Target: each within one check
//     (plus BACK_PRESSURE_SLACK_MS for the check itself), every background job held, interactive work running.
//
// Exit codes: 0 every target met, 1 a target missed, 2 the run failed.
import { randomBytes, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { sql } from 'kysely';
import pg from 'pg';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelManifest, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime, contentGeneration, fileKey, mintContextToken, type Actor } from '@crove/kernel-runtime';
import { financeCommands, financeManifest, financeQueries } from '@crove/mod-finance';
import { PgBoss } from 'pg-boss';
import { BACK_PRESSURE_CHECK_MS, DEFAULT_OUTBOX_LAG_PAUSE_SECONDS, PausableWork, checkBackPressure, outboxLagSeconds } from '../src/back-pressure.ts';
import { jobKey } from '../src/job-keys.ts';
import { JOB_SCHEMA, QUEUES } from '../src/jobs-schema.ts';
import { MAIL_BULK_QUEUE } from '../src/mail-queue.ts';
import { createSessionStatusSource } from '../src/sessions.ts';

export const LOAD_EXIT = { ok: 0, missed: 1, failed: 2 } as const;

export const LOAD_TARGETS = { commandP95Ms: 150, outboxLagP95Ms: 2000, eventsPerSecond: 50 } as const;

export interface LoadArgs {
  adminUrl: string;
  parties: number;
  commands: number;
  concurrency: number;
  queries: number;
  rate: number;
  seconds: number;
  // The back-pressure threshold (OUTBOX_LAG_PAUSE_SECONDS) and how often it is checked (BACK_PRESSURE_CHECK_MS).
  pauseSeconds: number;
  checkSeconds: number;
  keep: boolean;
}

export const DEFAULT_LOAD_ARGS: Omit<LoadArgs, 'adminUrl'> = {
  parties: 100_000,
  commands: 2000,
  concurrency: 8,
  queries: 30,
  rate: 60,
  seconds: 30,
  pauseSeconds: DEFAULT_OUTBOX_LAG_PAUSE_SECONDS,
  checkSeconds: BACK_PRESSURE_CHECK_MS / 1000,
  keep: false,
};

const INTEGER_FLAGS = {
  '--parties': 'parties',
  '--commands': 'commands',
  '--concurrency': 'concurrency',
  '--queries': 'queries',
  '--rate': 'rate',
  '--seconds': 'seconds',
  '--pause-seconds': 'pauseSeconds',
  '--check-seconds': 'checkSeconds',
} as const;

export function parseLoadArgs(argv: readonly string[], env: Record<string, string | undefined> = {}): LoadArgs {
  const args: LoadArgs = { adminUrl: env.CROVE_TEST_ADMIN_URL ?? '', ...DEFAULT_LOAD_ARGS };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i] as string;
    if (flag === '--keep') {
      args.keep = true;
      continue;
    }
    const value = argv[++i];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    if (flag === '--admin-url') {
      args.adminUrl = value;
      continue;
    }
    const key = INTEGER_FLAGS[flag as keyof typeof INTEGER_FLAGS];
    if (!key) throw new Error(`unknown flag ${flag}`);
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > 1_000_000) throw new Error(`${flag} must be a whole number from 1 to 1000000`);
    args[key] = n;
  }
  if (!args.adminUrl) throw new Error('--admin-url (or CROVE_TEST_ADMIN_URL) is required: a superuser URL of a PostgreSQL 17 server');
  return args;
}

// The value below which `p` of the samples fall (nearest rank). Null for no samples.
export function percentile(samples: readonly number[], p: number): number | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return sorted[rank - 1] as number;
}

export interface LoadResult {
  parties: number;
  commands: { name: string; count: number; failed: number; firstError: string | null; p50: number | null; p95: number | null; p99: number | null }[];
  queries: { name: string; count: number; p95: number | null }[];
  // sustained: events produced at --rate with the relay running (lag). drain: a backlog of events claimed by one relay
  // as fast as it can (capacity).
  outbox: {
    rate: number;
    produced: number;
    relayed: number;
    lagP95: number | null;
    lagMax: number | null;
    backlog: number;
    drainSeconds: number;
    eventsPerSecond: number;
  };
  // Locks held server-wide (pg_locks), sampled while the commands run: the context guard reads pg_locks on every
  // context entry (plan §4.5 item 1, gate row T10).
  locks: { samples: number; p50: number | null; p95: number | null; max: number | null };
  backPressure: BackPressureResult;
}

// One queue of each kind the worker pauses (plan §4.9; apps/kernel/src/worker.ts registers them with background.add),
// and one queue a person waits for, which back-pressure leaves running.
export const BACK_PRESSURE_QUEUES: readonly string[] = [QUEUES.agentDispatch, MAIL_BULK_QUEUE, QUEUES.archiveWrite, QUEUES.retention];
export const INTERACTIVE_QUEUE = QUEUES.notify;
// What a pause or resume may take beyond one check interval: the check's own lag read and pg-boss offWork or work.
export const BACK_PRESSURE_SLACK_MS = 1000;
// How long background jobs sent during the pause must wait: longer than pg-boss's default polling interval (2 s), so a
// queue still being fetched would have run its job by then.
export const BACK_PRESSURE_HOLD_MS = 4000;

// Times are milliseconds from the start of the stall (the relay stopped), null for what never happened.
export interface BackPressureResult {
  thresholdSeconds: number;
  checkSeconds: number;
  queues: string[];
  lagOverAt: number | null;
  pausedAt: number | null;
  lagUnderHalfAt: number | null;
  resumedAt: number | null;
  maxLagSeconds: number;
  // Background jobs sent once the queues paused (or once the wait for a pause gave up): how many did not run before the
  // relay caught up, and how many ran after the resume.
  sent: number;
  held: number;
  ranAfterResume: number;
  // The interactive queue's job sent at the same time ran while the background queues were paused.
  interactiveRan: boolean;
  // kernel.file.ingest at --rate during the stall and the pause: interactive commands keep running.
  commands: { count: number; failed: number; firstError: string | null; p95: number | null };
}

// The guard's cost per context entry measured in #105: about 13 us with an idle lock table plus about 0.27 us per lock
// held server-wide.
export const GUARD_BASE_US = 13;
export const GUARD_PER_LOCK_US = 0.27;
export const guardCostUs = (locks: number) => GUARD_BASE_US + GUARD_PER_LOCK_US * locks;

export interface LoadVerdict {
  check: string;
  target: string;
  measured: string;
  ok: boolean | null;
}

const ms = (value: number | null) => (value === null ? '-' : `${value.toFixed(1)} ms`);
const secs = (value: number | null) => (value === null ? 'never' : `${(value / 1000).toFixed(1)} s`);
const delay = (from: number | null, to: number | null) => (from === null || to === null ? null : to - from);

// The back-pressure targets: the background queues pause within one check of the lag passing the threshold and
// hold every job sent meanwhile; they resume within one check of the lag falling to half the threshold and work
// those jobs; interactive work (the commands, the interactive queue) keeps running throughout.
export function judgeBackPressure(bp: BackPressureResult): LoadVerdict[] {
  const withinMs = bp.checkSeconds * 1000 + BACK_PRESSURE_SLACK_MS;
  const within = `within ${bp.checkSeconds} s + ${BACK_PRESSURE_SLACK_MS / 1000} s (one check and its own time)`;
  const pauseDelay = delay(bp.lagOverAt, bp.pausedAt);
  const resumeDelay = delay(bp.lagUnderHalfAt, bp.resumedAt);
  const total = bp.queues.length;
  return [
    {
      check: 'back-pressure pause',
      target: `${within} of outbox lag > ${bp.thresholdSeconds} s; ${total}/${total} background jobs held`,
      measured: `${pauseDelay === null ? 'never paused' : `${secs(pauseDelay)} after the lag passed ${bp.thresholdSeconds} s`}; ${bp.held}/${bp.sent} held`,
      ok: pauseDelay !== null && pauseDelay >= 0 && pauseDelay <= withinMs && bp.sent === total && bp.held === total,
    },
    {
      check: 'back-pressure resume',
      target: `${within} of outbox lag <= ${bp.thresholdSeconds / 2} s; the held jobs run`,
      measured: `${resumeDelay === null ? 'never resumed' : `${secs(resumeDelay)} after the lag fell to ${bp.thresholdSeconds / 2} s`}; ${bp.ranAfterResume}/${bp.held} ran`,
      ok: resumeDelay !== null && resumeDelay >= 0 && resumeDelay <= withinMs && bp.ranAfterResume === total,
    },
    {
      check: 'interactive work under back-pressure',
      target: `p95 kernel.file.ingest < ${LOAD_TARGETS.commandP95Ms} ms, no failures; ${INTERACTIVE_QUEUE} runs while paused`,
      measured: `${ms(bp.commands.p95)}, ${bp.commands.failed} failed; ${bp.interactiveRan ? 'ran' : 'did not run'}`,
      ok: bp.interactiveRan && bp.commands.count > 0 && bp.commands.failed === 0 && bp.commands.p95 !== null && bp.commands.p95 < LOAD_TARGETS.commandP95Ms,
    },
  ];
}

// Each plan target against what was measured. ok is null for a target that cannot be measured yet.
export function judge(result: LoadResult): LoadVerdict[] {
  const verdicts: LoadVerdict[] = result.commands.map((c) => ({
    check: `p95 ${c.name}`,
    target: `< ${LOAD_TARGETS.commandP95Ms} ms, no failures`,
    measured: `${ms(c.p95)}, ${c.failed} failed`,
    ok: c.p95 !== null && c.p95 < LOAD_TARGETS.commandP95Ms && c.failed === 0,
  }));
  verdicts.push({
    check: 'p95 outbox lag',
    target: `< ${LOAD_TARGETS.outboxLagP95Ms} ms`,
    measured: ms(result.outbox.lagP95),
    ok: result.outbox.lagP95 !== null && result.outbox.lagP95 < LOAD_TARGETS.outboxLagP95Ms,
  });
  verdicts.push({
    check: 'events relayed per second (1 relay, backlog)',
    target: `>= ${LOAD_TARGETS.eventsPerSecond}`,
    measured: result.outbox.eventsPerSecond.toFixed(1),
    ok: result.outbox.eventsPerSecond >= LOAD_TARGETS.eventsPerSecond,
  });
  verdicts.push(...judgeBackPressure(result.backPressure));
  return verdicts;
}

export function formatReport(result: LoadResult, verdicts: readonly LoadVerdict[]): string {
  const lines = [`Crove load test: ${result.parties} parties in one org`, ''];
  lines.push('Commands (Runtime.execute, session check on):');
  for (const c of result.commands) {
    lines.push(`  ${c.name.padEnd(24)} n=${c.count} failed=${c.failed} p50=${ms(c.p50)} p95=${ms(c.p95)} p99=${ms(c.p99)}`);
    if (c.firstError) lines.push(`    first failure: ${c.firstError}`);
  }
  lines.push('Queries over the parties:');
  for (const q of result.queries) lines.push(`  ${q.name.padEnd(24)} n=${q.count} p95=${ms(q.p95)}`);
  const o = result.outbox;
  lines.push(`Outbox at ${o.rate}/s: ${o.produced} events produced, ${o.relayed} relayed, lag p95=${ms(o.lagP95)} max=${ms(o.lagMax)}`);
  lines.push(`Outbox backlog: ${o.backlog} events drained by one relay in ${o.drainSeconds.toFixed(2)} s (${o.eventsPerSecond.toFixed(1)}/s)`);
  const l = result.locks;
  if (l.samples > 0 && l.p95 !== null && l.max !== null) {
    lines.push(`Locks held server-wide during the commands: n=${l.samples} p50=${l.p50} p95=${l.p95} max=${l.max}`);
    lines.push(`  context guard cost per entry (#105: ${GUARD_BASE_US} us + ${GUARD_PER_LOCK_US} us per lock): ${guardCostUs(l.p95).toFixed(1)} us at p95, ${guardCostUs(l.max).toFixed(1)} us at max`);
  } else {
    lines.push('Locks held server-wide during the commands: no sample');
  }
  const bp = result.backPressure;
  lines.push(`Back-pressure (threshold ${bp.thresholdSeconds} s, checked every ${bp.checkSeconds} s; ${bp.queues.join(', ')}), times from the relay stopping:`);
  const step = (what: string, from: number | null, to: number | null) =>
    to === null ? `${what}: never` : `${what} at ${secs(to)}${from === null ? '' : ` (${secs(to - from)} later)`}`;
  lines.push(`  lag passed ${bp.thresholdSeconds} s at ${secs(bp.lagOverAt)}, ${step('queues paused', bp.lagOverAt, bp.pausedAt)}, max lag ${bp.maxLagSeconds.toFixed(1)} s`);
  lines.push(`  lag back to ${bp.thresholdSeconds / 2} s at ${secs(bp.lagUnderHalfAt)}, ${step('queues resumed', bp.lagUnderHalfAt, bp.resumedAt)}`);
  lines.push(
    `  background jobs: ${bp.sent} sent ${bp.pausedAt === null ? 'after the wait for a pause' : 'while paused'}, ${bp.held} held, ${bp.ranAfterResume} ran after the resume; ${INTERACTIVE_QUEUE} ${bp.interactiveRan ? 'ran' : 'did not run'} while paused`,
  );
  lines.push(`  kernel.file.ingest meanwhile: n=${bp.commands.count} failed=${bp.commands.failed} p95=${ms(bp.commands.p95)}`);
  if (bp.commands.firstError) lines.push(`    first failure: ${bp.commands.firstError}`);
  lines.push('', 'Targets (plan §13 Phase 1, exit criterion 7):');
  for (const v of verdicts) lines.push(`  ${v.ok === null ? 'N/A ' : v.ok ? 'PASS' : 'FAIL'}  ${v.check}: ${v.measured} (target ${v.target})`);
  return lines.join('\n');
}

const sleep = (msec: number) => new Promise((resolve) => setTimeout(resolve, msec));

// Counts pg_locks every intervalMs on its own connection until stop() is called, and returns the counts. A failing
// sampler never fails the run: it stops, keeps the counts taken so far and reports why.
export interface LockCountClient {
  connect(): Promise<unknown>;
  query(text: string): Promise<{ rows: { n: number }[] }>;
  end(): Promise<unknown>;
}

export function sampleLocks(
  adminUrl: string,
  intervalMs: number,
  connect: (url: string) => LockCountClient = (url) => new pg.Client({ connectionString: url }),
): { stop: () => Promise<{ counts: number[]; error: string | null }> } {
  const counts: number[] = [];
  let running = true;
  let error: string | null = null;
  const loop = (async () => {
    const client = connect(adminUrl);
    try {
      await client.connect();
      while (running) {
        counts.push((await client.query('SELECT count(*)::int AS n FROM pg_catalog.pg_locks')).rows[0]?.n ?? 0);
        await sleep(intervalMs);
      }
    } catch (e) {
      error = e instanceof Error ? e.message.slice(0, 200) : String(e);
    } finally {
      await client.end().catch(() => undefined);
    }
  })();
  return {
    stop: async () => {
      running = false;
      await loop;
      return { counts, error };
    },
  };
}

// pg-boss emits its errors as plain objects with a message, not as Error instances.
const describeError = (error: unknown) => {
  if (error === null || typeof error !== 'object' || typeof (error as { message?: unknown }).message !== 'string') return String(error);
  const { code, name, message } = error as { code?: string; name?: string; message: string };
  return `${code ?? name ?? 'Error'}: ${message}`.slice(0, 200);
};

async function timed(fn: () => Promise<unknown>): Promise<number> {
  const started = performance.now();
  await fn();
  return performance.now() - started;
}

// Runs `count` calls of `fn` with `concurrency` at a time; returns each call's duration and the failures.
async function pool(count: number, concurrency: number, fn: (i: number) => Promise<unknown>): Promise<{ samples: number[]; failed: number; firstError: string | null }> {
  const samples: number[] = [];
  let failed = 0;
  let firstError: string | null = null;
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, count) }, async () => {
      while (next < count) {
        const i = next++;
        try {
          samples.push(await timed(() => fn(i)));
        } catch (error) {
          failed++;
          firstError ??= describeError(error);
        }
      }
    }),
  );
  return { samples, failed, firstError };
}

export interface BackPressureRun {
  // pg-boss on the throwaway database, as the worker login.
  bossUrl: string;
  worker: Db;
  orgId: string;
  // An interactive command, and the relay's claim of up to 100 outbox events (returns their lags).
  ingest: () => Promise<unknown>;
  claim: () => Promise<number[]>;
  rate: number;
  thresholdSeconds: number;
  checkSeconds: number;
  log: (line: string) => void;
}

// The back-pressure phase. It starts with an empty outbox and leaves one: the relay stops while kernel.file.ingest runs
// at `rate` per second, the worker's check (checkBackPressure, every checkSeconds) pauses the background queues once
// the lag passes the threshold, background and interactive jobs are sent, and the relay then catches up so the check
// resumes the queues. The lag is read every 100 ms on its own connection and by each check, which records when it passed
// the threshold and when it fell back to half of it.
export async function measureBackPressure(run: BackPressureRun): Promise<BackPressureResult> {
  const thresholdMs = run.thresholdSeconds * 1000;
  const checkMs = run.checkSeconds * 1000;
  const boss = new PgBoss({ connectionString: run.bossUrl, schema: JOB_SCHEMA, migrate: false, createSchema: false, supervise: false, schedule: false });
  boss.on('error', (error) => run.log(`[pg-boss] ${describeError(error)}`));
  await boss.start();
  // When each job ran (performance.now()), by its tag.
  const ran = new Map<string, number>();
  const handler = async ([job]: { data: { tag: string } }[]) => {
    if (job) ran.set(job.data.tag, performance.now());
  };
  const send = (queue: string, tag: string) => boss.send(queue, { tag }, { singletonKey: jobKey(run.orgId, queue, tag) });
  const waitFor = async (tags: readonly string[], timeoutMs: number) => {
    const until = performance.now() + timeoutMs;
    while (tags.some((t) => !ran.has(t)) && performance.now() < until) await sleep(50);
    return tags.every((t) => ran.has(t));
  };
  const work = new PausableWork(boss);
  let running = true;
  let checking = false;
  let pressureTimer: ReturnType<typeof setInterval> | undefined;
  // The first failure of a loop or a check; the waits below stop on it and the phase fails with it.
  let phaseError: unknown = null;
  const loops: Promise<unknown>[] = [];
  const inflight: Promise<unknown>[] = [];
  const loop = (body: () => Promise<void>) => {
    loops.push(
      body().catch((error: unknown) => {
        phaseError ??= error;
      }),
    );
  };
  try {
    // The background queues as the worker works them (batch of 1, pg-boss's default polling). The interactive queue is
    // worked outside PausableWork, as the worker works the queues a person waits for, and polled as fast as pg-boss
    // allows so the check of it is quick; that it keeps running is a sanity check of the setup, while the commands
    // below are the interactive work the plan means.
    for (const queue of BACK_PRESSURE_QUEUES) await work.add(queue, () => boss.work<{ tag: string }>(queue, { batchSize: 1 }, handler));
    await boss.work<{ tag: string }>(INTERACTIVE_QUEUE, { batchSize: 1, pollingIntervalSeconds: 0.5 }, handler);
    const warm = [...BACK_PRESSURE_QUEUES, INTERACTIVE_QUEUE];
    for (const queue of warm) await send(queue, `${queue}:before`);
    if (!(await waitFor(warm.map((q) => `${q}:before`), 30_000))) {
      throw new Error(`back-pressure: a queue did not work its job before the stall (${warm.filter((q) => !ran.has(`${q}:before`)).join(', ')})`);
    }

    run.log(`back-pressure: relay stopped, kernel.file.ingest at ${run.rate}/s, threshold ${run.thresholdSeconds} s, checked every ${run.checkSeconds} s`);
    const stallStart = performance.now();
    const at = () => performance.now() - stallStart;
    // Set by the loops below; an object, so the reads after each wait are not narrowed to the initial null.
    const m: Pick<BackPressureResult, 'lagOverAt' | 'pausedAt' | 'lagUnderHalfAt' | 'resumedAt' | 'maxLagSeconds'> = {
      lagOverAt: null,
      pausedAt: null,
      lagUnderHalfAt: null,
      resumedAt: null,
      maxLagSeconds: 0,
    };
    // Every lag read, the sampler's and the check's own, so the check never acts on a crossing not yet recorded. While
    // the relay is stopped the lag grows one second per second, so the crossing of the threshold is placed where the
    // first reading over it says it was; the fall to half is abrupt (the relay drains the backlog at once) and is the
    // first reading at or under it.
    const observe = (lag: number) => {
      const t = at();
      m.maxLagSeconds = Math.max(m.maxLagSeconds, lag);
      if (m.lagOverAt === null && lag > run.thresholdSeconds) m.lagOverAt = Math.max(0, t - (lag - run.thresholdSeconds) * 1000);
      else if (m.lagOverAt !== null && m.lagUnderHalfAt === null && lag <= run.thresholdSeconds / 2) m.lagUnderHalfAt = t;
    };
    const readLag = async () => {
      const lag = await outboxLagSeconds(run.worker);
      observe(lag);
      return lag;
    };

    // Interactive commands at `rate` per second until the end of the phase.
    const samples: number[] = [];
    let failed = 0;
    let firstError: string | null = null;
    loop(async () => {
      for (let i = 0; running; i++) {
        const wait = stallStart + (i * 1000) / run.rate - performance.now();
        if (wait > 0) await sleep(wait);
        if (!running) break;
        inflight.push(
          timed(run.ingest).then(
            (d) => samples.push(d),
            (error: unknown) => {
              failed++;
              firstError ??= describeError(error);
            },
          ),
        );
      }
    });
    // The lag, every 100 ms on its own connection.
    loop(async () => {
      while (running) {
        await readLag();
        await sleep(100);
      }
    });
    // The worker's check on the worker's schedule: one at a time, every checkSeconds. The paused moment is when the
    // queues have stopped fetching; the resumed one is when they start fetching again, before any of them has.
    const watched = {
      get paused() {
        return work.paused;
      },
      get names() {
        return work.names;
      },
      pause: async () => {
        await work.pause();
        m.pausedAt ??= at();
      },
      resume: async () => {
        m.resumedAt ??= at();
        await work.resume();
      },
    };
    pressureTimer = setInterval(() => {
      if (checking || !running) return;
      checking = true;
      void checkBackPressure({ work: watched, readLagSeconds: readLag, thresholdSeconds: run.thresholdSeconds, log: run.log })
        .catch((error: unknown) => {
          phaseError ??= error;
        })
        .finally(() => {
          checking = false;
        });
    }, checkMs);
    const until = async (done: () => boolean, deadline: number) => {
      while (!done() && at() < deadline && phaseError === null) await sleep(50);
      if (phaseError !== null) throw phaseError;
    };

    // Wait for the pause, giving up three checks after the lag should have passed the threshold.
    await until(() => m.pausedAt !== null, thresholdMs + 3 * checkMs + 5000);
    if (m.pausedAt === null) run.log(`back-pressure: the queues did not pause (lag ${m.maxLagSeconds.toFixed(1)} s); sending the jobs anyway`);
    const held = BACK_PRESSURE_QUEUES.map((q) => `${q}:paused`);
    const interactiveTag = `${INTERACTIVE_QUEUE}:paused`;
    const sentAt = performance.now();
    for (const queue of BACK_PRESSURE_QUEUES) await send(queue, `${queue}:paused`);
    await send(INTERACTIVE_QUEUE, interactiveTag);
    await waitFor([interactiveTag], 15_000);
    const holdLeft = sentAt + BACK_PRESSURE_HOLD_MS - performance.now();
    if (holdLeft > 0) await sleep(holdLeft);
    if (phaseError !== null) throw phaseError;
    const interactiveRan = ran.has(interactiveTag) && work.paused;
    const heldCount = held.filter((t) => !ran.has(t)).length;

    // The relay catches up and keeps up until the end; the check then resumes the queues.
    run.log('back-pressure: relay running again');
    const releasedAt = at();
    loop(async () => {
      while (running) if ((await run.claim()).length === 0) await sleep(10);
    });
    await until(() => m.resumedAt !== null, releasedAt + 3 * checkMs + 5000);
    const resumedPerf = m.resumedAt === null ? null : stallStart + m.resumedAt;
    if (resumedPerf !== null) await waitFor(held, 15_000);
    const ranAfterResume = resumedPerf === null ? 0 : held.filter((t) => (ran.get(t) ?? -1) >= resumedPerf).length;

    running = false;
    clearInterval(pressureTimer);
    await Promise.all(loops);
    await Promise.all(inflight);
    while (checking) await sleep(10);
    if (phaseError !== null) throw phaseError;
    // What the commands still in flight emitted, so the outbox is empty again.
    while ((await run.claim()).length > 0);
    return {
      thresholdSeconds: run.thresholdSeconds,
      checkSeconds: run.checkSeconds,
      queues: [...BACK_PRESSURE_QUEUES],
      ...m,
      sent: held.length,
      held: heldCount,
      ranAfterResume,
      interactiveRan,
      commands: { count: samples.length, failed, firstError, p95: percentile(samples, 95) },
    };
  } finally {
    // On a failure too: nothing of the phase still runs when the caller ends the pools and drops the database.
    running = false;
    if (pressureTimer) clearInterval(pressureTimer);
    await Promise.allSettled(loops);
    await Promise.allSettled(inflight);
    while (checking) await sleep(10);
    await boss.stop({ graceful: false });
  }
}

const login = (adminUrl: string, user: string, password: string) => {
  const url = new URL(adminUrl);
  url.username = user;
  url.password = password;
  return url.toString();
};

export async function runLoad(args: LoadArgs, log: (line: string) => void = console.log): Promise<LoadResult> {
  const dbName = `crove_load_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const root = new pg.Client({ connectionString: args.adminUrl });
  await root.connect();
  await root.query(`CREATE DATABASE ${dbName}`);
  await root.end();
  const base = new URL(args.adminUrl);
  base.pathname = `/${dbName}`;
  const adminUrl = base.toString();
  // The context token key (#1822): the run's own unless one is set, installed by migrate and held by the runtime.
  const contextTokenKey = process.env.CROVE_CONTEXT_TOKEN_KEY ?? randomBytes(32).toString('base64');
  const appPassword = randomUUID();
  const workerPassword = randomUUID();
  let appPool: pg.Pool | undefined;
  let workerPool: pg.Pool | undefined;
  try {
    log(`database ${dbName}: migrating`);
    // The image sets MIGRATIONS_DIR; a checkout uses the repository's migrations.
    await migrate({ adminUrl, dir: process.env.MIGRATIONS_DIR ?? fileURLToPath(new URL('../../../supabase/migrations', import.meta.url)), contextTokenKey });
    await setRolePasswords(adminUrl, { crove_app: appPassword, crove_worker: workerPassword });
    appPool = createPool({ connectionString: login(adminUrl, 'crove_app', appPassword), max: args.concurrency + 2 });
    // The relay, the lag sampler and the back-pressure check each hold one at a time.
    workerPool = createPool({ connectionString: login(adminUrl, 'crove_worker', workerPassword), max: 4 });
    const db: Db = createDb(appPool);
    const worker: Db = createDb(workerPool);
    // Input hashes keyed as the server writes them (#1732), so the run measures their cost too.
    // The manifests of the modules it registers, as the server passes them (#1710, #1772).
    const runtime = new Runtime(db, { manifests: [kernelManifest.tables, financeManifest.tables], sessions: createSessionStatusSource('off'), inputHash: 'keyed', contextTokenKey }).register({
      commands: [...kernelCommands, ...financeCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries],
    });

    const userId = await upsertIdentity(db, { issuer: 'load-test', subject: randomUUID(), email: 'load@example.com', name: null });
    const actor: Actor = { type: 'user', userId, aal: 'aal1', sessionId: randomUUID() };
    const { orgId } = await createOrg(runtime, actor, 'Load test org');
    const scope = { actor, orgId };

    log(`seeding ${args.parties} parties`);
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      await admin.query(
        `INSERT INTO crove_kernel.party (org_id, name, tax_code, address)
         SELECT $1, 'Công ty TNHH Thử tải ' || n, '8' || lpad(n::text, 9, '0'), 'Số ' || n || ' Đường Thử, Quận 1, TP Hồ Chí Minh'
         FROM generate_series(1, $2) AS n`,
        [orgId, args.parties],
      );
      await admin.query('ANALYZE crove_kernel.party');
    } finally {
      await admin.end();
    }
    // Parties to edit, read in the org's context (the app role sees tenant rows only there).
    const ids = await db.transaction().execute(async (trx) => {
      const token = mintContextToken(contextTokenKey, { userId, sessionId: null, orgId, aal: 'aal1', mfaAt: null });
      await sql`SELECT crove_kernel.enter_user_context(${orgId}::uuid, ${token}::text)`.execute(trx);
      return (await sql<{ id: string; tax_code: string | null }>`SELECT id, tax_code FROM crove_kernel.party ORDER BY random() LIMIT ${args.commands}`.execute(trx)).rows;
    });

    log(`running ${args.commands} kernel.party.update and ${args.commands} kernel.file.ingest, ${args.concurrency} at a time`);
    const lockSampler = sampleLocks(adminUrl, 100);
    const update = await pool(ids.length, args.concurrency, (i) =>
      runtime.execute(
        'kernel.party.update',
        // A tax code, once set, is kept (PARTY_TAX_CODE_LOCKED): the edit renames and sets a phone.
        { partyId: ids[i]?.id, version: 1, name: `Công ty TNHH Đã sửa ${i}`, taxCode: ids[i]?.tax_code ?? null, address: null, email: null, phone: '028 3822 0000' },
        scope,
      ),
    );
    const ingest = async () => {
      const sha256 = randomUUID().replace(/-/g, '').padEnd(64, '0');
      return runtime.execute(
        'kernel.file.ingest',
        { filename: 'hd.xml', contentType: 'application/xml', sizeBytes: 1024, sha256, storageKey: fileKey(orgId, sha256), generation: contentGeneration(sha256), source: 'upload' },
        scope,
      );
    };
    const ingestRun = await pool(args.commands, args.concurrency, ingest);
    const { counts: lockCounts, error: lockError } = await lockSampler.stop();
    if (lockError) log(`lock sampler stopped early after ${lockCounts.length} samples: ${lockError}`);

    log(`running the party queries ${args.queries} times each`);
    const queries: LoadResult['queries'] = [];
    for (const [name, input] of [
      ['finance.vendors.list', {}],
      ['finance.vendors.list (q)', { q: 'Thử tải 4242' }],
      ['finance.customers.list', {}],
      ['finance.search', { q: 'Thử tải 4242' }],
    ] as const) {
      const queryName = name.split(' ')[0] as string;
      const run = await pool(args.queries, 1, () => runtime.query(queryName, input, scope));
      queries.push({ name, count: run.samples.length, p95: percentile(run.samples, 95) });
    }

    // The relay loop of the worker, claiming 100 at a time; returns each claimed event's lag in ms (emit to claim, by the
    // database clock: an event id is a UUIDv7 whose first 48 bits are its emit time).
    const claim = async (): Promise<number[]> =>
      (
        await worker.transaction().execute(
          async (trx) =>
            (
              await sql<{ lag_ms: number }>`
                SELECT extract(epoch FROM clock_timestamp()) * 1000
                       - ('x' || substr(replace(event_id::text, '-', ''), 1, 12))::bit(48)::bigint AS lag_ms
                FROM crove_kernel.outbox_claim(100)`.execute(trx)
            ).rows,
        )
      ).map((r) => Number(r.lag_ms));
    // What the command phase left, so the next phase starts empty.
    while ((await claim()).length > 0);

    log(`outbox: ${args.rate} kernel.file.ingest per second for ${args.seconds} s, one relay`);
    const lags: number[] = [];
    let producing = true;
    // The relay stops only on an empty claim that started after the last command committed. A claim that started
    // earlier may have taken its snapshot before that commit and come back empty while production ended meanwhile;
    // stopping on it left that event behind (19 of 20 relayed, #1241).
    const relay = (async () => {
      for (;;) {
        const done = !producing;
        const rows = await claim();
        lags.push(...rows);
        if (rows.length === 0) {
          if (done) return;
          await sleep(10);
        }
      }
    })();
    const started = performance.now();
    let produced = 0;
    const inflight: Promise<unknown>[] = [];
    for (let i = 0; i < args.rate * args.seconds; i++) {
      const wait = started + (i * 1000) / args.rate - performance.now();
      if (wait > 0) await sleep(wait);
      inflight.push(ingest().then(() => produced++, () => undefined));
    }
    await Promise.all(inflight);
    producing = false;
    await relay;

    const backlog = Math.max(args.rate * args.seconds, 1000);
    log(`outbox: a backlog of ${backlog} events, drained by one relay`);
    await pool(backlog, args.concurrency, ingest);
    const drainStarted = performance.now();
    let drained = 0;
    for (let batch = await claim(); batch.length > 0; batch = await claim()) drained += batch.length;
    const drainSeconds = (performance.now() - drainStarted) / 1000;

    const backPressure = await measureBackPressure({
      bossUrl: login(adminUrl, 'crove_worker', workerPassword),
      worker,
      orgId,
      ingest,
      claim,
      rate: args.rate,
      thresholdSeconds: args.pauseSeconds,
      checkSeconds: args.checkSeconds,
      log,
    });

    return {
      parties: args.parties,
      commands: [
        { name: 'kernel.party.update', count: update.samples.length, failed: update.failed, firstError: update.firstError, p50: percentile(update.samples, 50), p95: percentile(update.samples, 95), p99: percentile(update.samples, 99) },
        { name: 'kernel.file.ingest', count: ingestRun.samples.length, failed: ingestRun.failed, firstError: ingestRun.firstError, p50: percentile(ingestRun.samples, 50), p95: percentile(ingestRun.samples, 95), p99: percentile(ingestRun.samples, 99) },
      ],
      queries,
      outbox: {
        rate: args.rate,
        produced,
        relayed: lags.length,
        lagP95: percentile(lags, 95),
        lagMax: lags.length ? Math.max(...lags) : null,
        backlog: drained,
        drainSeconds,
        eventsPerSecond: drainSeconds > 0 ? drained / drainSeconds : 0,
      },
      locks: {
        samples: lockCounts.length,
        p50: percentile(lockCounts, 50),
        p95: percentile(lockCounts, 95),
        max: lockCounts.length ? Math.max(...lockCounts) : null,
      },
      backPressure,
    };
  } finally {
    await appPool?.end();
    await workerPool?.end();
    if (!args.keep) {
      const cleanup = new pg.Client({ connectionString: args.adminUrl });
      await cleanup.connect();
      await cleanup.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await cleanup.end();
    } else {
      log(`kept database ${dbName}`);
    }
  }
}

export async function runLoadTest(argv: readonly string[]): Promise<number> {
  let args: LoadArgs;
  try {
    args = parseLoadArgs(argv, process.env);
  } catch (error) {
    console.error(`[load-test] ${(error as Error).message}`);
    return LOAD_EXIT.failed;
  }
  try {
    const result = await runLoad(args, (line) => console.log(`[load-test] ${line}`));
    const verdicts = judge(result);
    console.log(formatReport(result, verdicts));
    return verdicts.some((v) => v.ok === false) ? LOAD_EXIT.missed : LOAD_EXIT.ok;
  } catch (error) {
    console.error('[load-test] the run failed', error);
    return LOAD_EXIT.failed;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(await runLoadTest(process.argv.slice(2)));
