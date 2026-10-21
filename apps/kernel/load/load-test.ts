// The Phase 1 load test (plan §13 Phase 1 exit criterion 7, §7.2, issue #998). It creates its own database on a
// PostgreSQL server it reaches as a superuser, migrates it, seeds one org with many parties, measures and drops the
// database. It needs no Crove deployment and touches no other database.
//
//   node apps/kernel/load/load-test.ts --admin-url <postgres URL> [--parties 100000] [--commands 2000]
//        [--concurrency 8] [--queries 30] [--rate 60] [--seconds 30] [--keep]
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
//   - Back-pressure (plan §4.9: outbox lag > 30 s pauses background jobs) is not built yet (#894); reported as such.
//
// Exit codes: 0 every target met, 1 a target missed, 2 the run failed.
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { sql } from 'kysely';
import pg from 'pg';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime, contentGeneration, fileKey, type Actor } from '@crove/kernel-runtime';
import { financeCommands, financeQueries } from '@crove/mod-finance';
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
  keep: boolean;
}

export const DEFAULT_LOAD_ARGS: Omit<LoadArgs, 'adminUrl'> = {
  parties: 100_000,
  commands: 2000,
  concurrency: 8,
  queries: 30,
  rate: 60,
  seconds: 30,
  keep: false,
};

const INTEGER_FLAGS = { '--parties': 'parties', '--commands': 'commands', '--concurrency': 'concurrency', '--queries': 'queries', '--rate': 'rate', '--seconds': 'seconds' } as const;

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
}

export interface LoadVerdict {
  check: string;
  target: string;
  measured: string;
  ok: boolean | null;
}

const ms = (value: number | null) => (value === null ? '-' : `${value.toFixed(1)} ms`);

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
  verdicts.push({ check: 'back-pressure', target: 'pauses background jobs when lag > 30 s', measured: 'not built yet (#894)', ok: null });
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
  lines.push('', 'Targets (plan §13 Phase 1, exit criterion 7):');
  for (const v of verdicts) lines.push(`  ${v.ok === null ? 'N/A ' : v.ok ? 'PASS' : 'FAIL'}  ${v.check}: ${v.measured} (target ${v.target})`);
  return lines.join('\n');
}

const sleep = (msec: number) => new Promise((resolve) => setTimeout(resolve, msec));

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
          firstError ??= error instanceof Error ? `${(error as { code?: string }).code ?? error.name}: ${error.message}`.slice(0, 200) : String(error);
        }
      }
    }),
  );
  return { samples, failed, firstError };
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
  const appPassword = randomUUID();
  const workerPassword = randomUUID();
  let appPool: pg.Pool | undefined;
  let workerPool: pg.Pool | undefined;
  try {
    log(`database ${dbName}: migrating`);
    // The image sets MIGRATIONS_DIR; a checkout uses the repository's migrations.
    await migrate({ adminUrl, dir: process.env.MIGRATIONS_DIR ?? fileURLToPath(new URL('../../../supabase/migrations', import.meta.url)) });
    await setRolePasswords(adminUrl, { crove_app: appPassword, crove_worker: workerPassword });
    appPool = createPool({ connectionString: login(adminUrl, 'crove_app', appPassword), max: args.concurrency + 2 });
    workerPool = createPool({ connectionString: login(adminUrl, 'crove_worker', workerPassword), max: 2 });
    const db: Db = createDb(appPool);
    const worker: Db = createDb(workerPool);
    const runtime = new Runtime(db, { sessions: createSessionStatusSource('off') }).register({
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
      await sql`SELECT crove_kernel.enter_context(${userId}::uuid, ${orgId}::uuid)`.execute(trx);
      return (await sql<{ id: string; tax_code: string | null }>`SELECT id, tax_code FROM crove_kernel.party ORDER BY random() LIMIT ${args.commands}`.execute(trx)).rows;
    });

    log(`running ${args.commands} kernel.party.update and ${args.commands} kernel.file.ingest, ${args.concurrency} at a time`);
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
    const relay = (async () => {
      for (;;) {
        const rows = await claim();
        lags.push(...rows);
        if (rows.length === 0) {
          if (!producing) return;
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
