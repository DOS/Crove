// The pgTAP runner (plan §10 G3, §5.3 naming table, issues #1627 and #1643). It lives in the invariant suite with its
// TAP check (tap.ts) and the vendored pgTAP (pgtap.sql), so on protected-path PRs the base branch's copy of all three
// judges the gate files (supabase/tests/database/_*.test.sql, also taken from the base branch by protected.yml). Like
// every file under test/invariant/, it imports nothing from outside this directory but the code under test
// (../../../src/migrate.ts). packages/db/test/pgtap.db.test.ts uses it for the modules' tests.
//
// Layout (§5.3): supabase/tests/database/_<name>.test.sql for the gate's own checks (a protected path, like the
// invariant suite) and supabase/tests/database/<token>/<desc>.test.sql for a module's tests, <token> a module id. Any
// other file there fails the layout test, so a misnamed test cannot be skipped silently.
//
// The database: one throwaway database, migrated with the built-in runner, then pgTAP (pgTAP 1.3.4, vendored: see that
// file's header) installed into its own schema `pgtap` with USAGE for every role, so a test may SET ROLE to a Crove
// role. pgTAP is installed after `migrate`, so the hardening guard never sees it, and never by a migration, so it never
// reaches a deployed database.
//
// Each file runs on a fresh connection as the superuser, inside a transaction the runner opens and rolls back, with
// search_path = pgtap (pg_catalog and pg_temp stay implicit, so Crove objects are named with their schema). A file holds
// no transaction control of its own: the runner fails a file that ended its transaction. It fails a file that raises a
// SQL error, one that prints a TAP line in a result of more than one column (which it does not read), and one whose TAP
// output does not pass the check in tap.ts: no plan(n) up front, a count that differs from the plan, a test that is not
// ok, a SKIP or a TODO. pgTAP keeps its state in temporary tables that plan() creates with grants to PUBLIC, so call
// plan() before any SET ROLE: Crove roles may not create temporary objects (T17).
import { randomBytes } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { migrate } from '../../../src/migrate.ts';
import { isTapLine, tapLines, tapProblems } from './tap.ts';

const MIGRATIONS = fileURLToPath(new URL('../../../../../supabase/migrations', import.meta.url));
export const TESTS = fileURLToPath(new URL('../../../../../supabase/tests/database', import.meta.url));
const PGTAP = fileURLToPath(new URL('./pgtap.sql', import.meta.url));

// Module ids of the migration naming rule (§5.3), the directories a module's tests live in.
const TOKENS = ['kernel', 'jobs', 'crm', 'service', 'social', 'email', 'sign', 'finance', 'hr', 'projects'];
export const GATE_FILE = /^_[a-z0-9]+(_[a-z0-9]+)*\.test\.sql$/;
export const MODULE_FILE = new RegExp(`^(${TOKENS.join('|')})/[a-z0-9]+(_[a-z0-9]+)*\\.test\\.sql$`);

// Every file under supabase/tests/database, relative and with forward slashes, sorted. Synchronous: vitest needs the
// cases when it collects the suite, before any hook runs.
export function listTests(): string[] {
  return readdirSync(TESTS, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => `${e.parentPath}/${e.name}`.slice(TESTS.length + 1).replaceAll('\\', '/'))
    .sort();
}

export interface Run {
  lines: string[];
  // The SQL error, or the runner's own refusal, when the file did not run to its end or printed TAP it does not read.
  error: string | null;
}

// Runs one test file's SQL in a transaction on a fresh connection and rolls it back.
export async function runTap(url: string, sql: string): Promise<Run> {
  const client = new pg.Client({ connectionString: url, application_name: 'crove-pgtap' });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL search_path = pgtap');
    const txid = async () => (await client.query<{ id: string }>('SELECT pg_catalog.pg_current_xact_id()::text AS id')).rows[0]?.id;
    const before = await txid();
    let results: pg.QueryResult | pg.QueryResult[];
    try {
      // The simple query protocol: the whole file in one round trip, a result per statement.
      results = (await client.query(sql)) as unknown as pg.QueryResult | pg.QueryResult[];
    } catch (error) {
      const e = error as Error & { code?: string; where?: string };
      return { lines: [], error: `SQL error${e.code ? ` ${e.code}` : ''}: ${e.message}${e.where ? `\n${e.where}` : ''}` };
    }
    const all = Array.isArray(results) ? results : [results];
    const values = all.filter((r) => r.fields?.length === 1).flatMap((r) => r.rows.map((row: Record<string, unknown>) => Object.values(row)[0]));
    const lines = tapLines(values);
    // A result of several columns is not read, so a TAP line there could hide a test from the count: refuse it.
    const hidden = all
      .filter((r) => (r.fields?.length ?? 0) > 1)
      .flatMap((r) => tapLines(r.rows.flatMap((row: Record<string, unknown>) => Object.values(row))))
      .find(isTapLine);
    if (hidden !== undefined) return { lines, error: `a TAP line in a result of more than one column, which the runner does not read: ${hidden}` };
    // Another transaction id: the file ran COMMIT or ROLLBACK itself, with or without a BEGIN after it (outside a
    // transaction block, the query runs in a transaction of its own).
    if ((await txid()) !== before) {
      return { lines, error: "the file ended the runner's transaction: drop its BEGIN, COMMIT and ROLLBACK" };
    }
    return { lines, error: null };
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    await client.end();
  }
}

// Why a run fails, empty when it passes.
export const problemsOf = (run: Run) => (run.error ? [run.error] : tapProblems(run.lines));

// Runs a test file of supabase/tests/database, by its relative path.
export async function runTestFile(url: string, file: string): Promise<string[]> {
  return problemsOf(await runTap(url, await readFile(`${TESTS}/${file}`, 'utf8')));
}

export interface PgtapDatabase {
  url: string;
  drop(): Promise<void>;
}

// Creates a throwaway database from the superuser URL `adminUrl`, migrates it and installs pgTAP. drop() removes it;
// call it from afterAll even when this throws, so a half-built database is dropped too.
export function pgtapDatabase(adminUrl: string): PgtapDatabase & { ready: Promise<void> } {
  const dbName = `crove_test_pgtap_${Date.now()}_${randomBytes(4).toString('hex')}`;
  const target = new URL(adminUrl);
  target.pathname = `/${dbName}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  let created = false;
  const ready = (async () => {
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    created = true;
    await migrate({ adminUrl: target.toString(), dir: MIGRATIONS });
    const client = new pg.Client({ connectionString: target.toString() });
    await client.connect();
    try {
      await client.query('CREATE SCHEMA pgtap');
      await client.query('GRANT USAGE ON SCHEMA pgtap TO PUBLIC');
      await client.query('SET search_path = pgtap');
      await client.query(await readFile(PGTAP, 'utf8'));
    } finally {
      await client.end();
    }
  })();
  return {
    url: target.toString(),
    ready,
    async drop() {
      await ready.catch(() => {});
      try {
        if (created) await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      } finally {
        await admin.end().catch(() => {});
      }
    },
  };
}
