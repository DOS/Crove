// Shared helpers for the experiments: start and SIGKILL worker processes, enqueue through DBOSClient (the API side,
// which runs no workflows), and observe the database as the superuser.
import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DBOSClient } from '@dbos-inc/dbos-sdk';
import pg from 'pg';
import { SCHEMA, observerUrl, runnerUrl, sleep } from './env.ts';

const here = dirname(fileURLToPath(import.meta.url));

export interface Worker {
  id: string;
  proc: ChildProcess;
  output: string[];
}

export async function startWorker(id: string, env: Record<string, string> = {}): Promise<Worker> {
  const proc = spawn(process.execPath, [join(here, 'worker.ts')], {
    env: { ...process.env, EXECUTOR_ID: id, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output: string[] = [];
  const ready = new Promise<void>((resolve, reject) => {
    const onData = (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n').filter(Boolean)) {
        output.push(line);
        if (process.env.SPIKE_VERBOSE && !/DeprecationWarning|trace-deprecation/.test(line)) console.log(`  [${id}] ${line}`);
        if (line.startsWith(`READY ${id}`)) resolve();
      }
    };
    proc.stdout!.on('data', onData);
    proc.stderr!.on('data', onData);
    proc.on('exit', (code) => reject(new Error(`worker ${id} exited with ${code} before READY:\n${output.join('\n')}`)));
  });
  await ready;
  return { id, proc, output };
}

/** SIGKILL: no shutdown hook runs, like an instance that disappears. */
export async function kill(worker: Worker): Promise<void> {
  if (worker.proc.exitCode !== null || worker.proc.signalCode !== null) return;
  const exited = new Promise((resolve) => worker.proc.once('exit', resolve));
  worker.proc.kill('SIGKILL');
  await exited;
}

export async function stop(workers: Worker[]): Promise<void> {
  await Promise.all(workers.map(kill));
}

export async function client(): Promise<DBOSClient> {
  return DBOSClient.create({ systemDatabaseUrl: runnerUrl, systemDatabaseSchemaName: SCHEMA, applicationName: 'crove-spike' });
}

export function observer(): pg.Pool {
  return new pg.Pool({ connectionString: observerUrl, max: 2 });
}

export async function q<T extends pg.QueryResultRow = Record<string, unknown>>(db: pg.Pool, text: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(text, params)).rows;
}

export async function statusCounts(db: pg.Pool, where = 'true', params: unknown[] = []): Promise<Record<string, number>> {
  const rows = await q<{ status: string; n: number }>(
    db,
    `SELECT status, count(*)::int AS n FROM "${SCHEMA}".workflow_status WHERE ${where} GROUP BY status ORDER BY status`,
    params,
  );
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}

export async function waitFor(what: string, check: () => Promise<boolean>, timeoutMs = 120_000, everyMs = 500): Promise<number> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return Date.now() - start;
    await sleep(everyMs);
  }
  throw new Error(`timed out after ${timeoutMs} ms waiting for: ${what}`);
}

/** Connections to the spike database by state and application_name prefix, excluding this observer. */
export async function connections(db: pg.Pool): Promise<{ total: number; active: number; idle: number; idleInTx: number }> {
  const [r] = await q<{ total: number; active: number; idle: number; idle_in_tx: number }>(
    db,
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE state = 'active')::int AS active,
            count(*) FILTER (WHERE state = 'idle')::int AS idle,
            count(*) FILTER (WHERE state LIKE 'idle in transaction%')::int AS idle_in_tx
       FROM pg_stat_activity
      WHERE datname = current_database() AND backend_type = 'client backend' AND usename = 'spike_runner'`,
  );
  return { total: r!.total, active: r!.active, idle: r!.idle, idleInTx: r!.idle_in_tx };
}

export async function resetData(db: pg.Pool): Promise<void> {
  await db.query(`TRUNCATE spike.effects, spike.fair, spike.executor_heartbeat, spike.recovery_log`);
  await db.query(`DELETE FROM "${SCHEMA}".workflow_status`);
}
