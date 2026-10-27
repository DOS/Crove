// The pgTAP runner (plan §10 G3, §5.3 naming table, issue #1627): every SQL test under supabase/tests/database runs on a
// real PostgreSQL 17 after every migration, in the `db` test project.
//
// Layout (§5.3): supabase/tests/database/_<name>.test.sql for the gate's own checks (a protected path, like the
// invariant suite) and supabase/tests/database/<token>/<desc>.test.sql for a module's tests, <token> a module id. Any
// other file there fails the run, so a misnamed test cannot be skipped silently.
//
// The database: one throwaway database, migrated with the built-in runner, then pgTAP from packages/db/test/vendor
// (pgTAP 1.3.4, vendored: see that file's header) installed into its own schema `pgtap` with USAGE for every role, so
// a test may SET ROLE to a Crove role. pgTAP is installed after `migrate`, so the hardening guard never sees it, and
// never by a migration, so it never reaches a deployed database.
//
// Each file runs on a fresh connection as the superuser, inside a transaction the runner opens and rolls back, with
// search_path = pgtap (pg_catalog and pg_temp stay implicit, so Crove objects are named with their schema). A file holds
// no transaction control of its own: the runner fails a file that ended its transaction. It fails a file that raises a
// SQL error, and one whose TAP output does not pass the check in tap.ts: no plan(n) up front, a count that differs from
// the plan, a test that is not ok, a SKIP or a TODO. pgTAP keeps its state in temporary tables that plan() creates
// with grants to PUBLIC, so call plan() before any SET ROLE: Crove roles may not create temporary objects (T17).
//
// Set CROVE_TEST_ADMIN_URL to a superuser URL; the run creates and drops its own database.
import { randomBytes } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../src/migrate.ts';
import { tapLines, tapProblems } from './tap.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const TESTS = fileURLToPath(new URL('../../../supabase/tests/database', import.meta.url));
const PGTAP = fileURLToPath(new URL('./vendor/pgtap.sql', import.meta.url));

// Module ids of the migration naming rule (§5.3), the directories a module's tests live in.
const TOKENS = ['kernel', 'jobs', 'crm', 'service', 'social', 'email', 'sign', 'finance', 'hr', 'projects'];
const GATE_FILE = /^_[a-z0-9]+(_[a-z0-9]+)*\.test\.sql$/;
const MODULE_FILE = new RegExp(`^(${TOKENS.join('|')})/[a-z0-9]+(_[a-z0-9]+)*\\.test\\.sql$`);
// The gate's smoke files: removing one fails the run instead of shrinking it.
const REQUIRED = ['_conformance.test.sql', '_rls_matrix.test.sql'];

// Every file under supabase/tests/database, relative and with forward slashes, sorted. Synchronous: vitest needs the
// cases when it collects the suite, before any hook runs.
function listTests(): string[] {
  return readdirSync(TESTS, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => `${e.parentPath}/${e.name}`.slice(TESTS.length + 1).replaceAll('\\', '/'))
    .sort();
}

interface Run {
  lines: string[];
  // The SQL error, or the runner's own refusal, when the file did not run to its end.
  error: string | null;
}

// Runs one test file's SQL in a transaction on a fresh connection and rolls it back.
async function runTap(url: string, sql: string): Promise<Run> {
  const client = new pg.Client({ connectionString: url, application_name: 'crove-pgtap' });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL search_path = pgtap');
    let results: pg.QueryResult | pg.QueryResult[];
    try {
      // The simple query protocol: the whole file in one round trip, a result per statement.
      results = (await client.query(sql)) as unknown as pg.QueryResult | pg.QueryResult[];
    } catch (error) {
      const e = error as Error & { code?: string; where?: string };
      return { lines: [], error: `SQL error${e.code ? ` ${e.code}` : ''}: ${e.message}${e.where ? `\n${e.where}` : ''}` };
    }
    const values = (Array.isArray(results) ? results : [results])
      .filter((r) => r.fields?.length === 1)
      .flatMap((r) => r.rows.map((row: Record<string, unknown>) => Object.values(row)[0]));
    // SAVEPOINT fails outside a transaction block: the file ran COMMIT or ROLLBACK itself.
    try {
      await client.query('SAVEPOINT pgtap_runner_check');
    } catch {
      return { lines: tapLines(values), error: 'the file ended the runner\'s transaction: drop its BEGIN, COMMIT and ROLLBACK' };
    }
    return { lines: tapLines(values), error: null };
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    await client.end();
  }
}

// Why a run fails, empty when it passes.
const problemsOf = (run: Run) => (run.error ? [run.error] : tapProblems(run.lines));

const suite = ADMIN ? describe : describe.skip;

suite('pgTAP tests in supabase/tests/database', () => {
  const dbName = `crove_test_pgtap_${Date.now()}_${randomBytes(4).toString('hex')}`;
  let admin: pg.Client;
  let created = false;
  let url = '';

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: ADMIN });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    created = true;
    const target = new URL(ADMIN as string);
    target.pathname = `/${dbName}`;
    url = target.toString();
    await migrate({ adminUrl: url, dir: MIGRATIONS });
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      await client.query('CREATE SCHEMA pgtap');
      await client.query('GRANT USAGE ON SCHEMA pgtap TO PUBLIC');
      await client.query('SET search_path = pgtap');
      await client.query(await readFile(PGTAP, 'utf8'));
    } finally {
      await client.end();
    }
  }, 300_000);

  afterAll(async () => {
    if (created) await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin?.end();
  });

  it('every file follows the layout, and the gate files are there', () => {
    const files = listTests();
    expect(files.filter((f) => !GATE_FILE.test(f) && !MODULE_FILE.test(f))).toEqual([]);
    expect(files).toEqual(expect.arrayContaining(REQUIRED));
  });

  it('runs pgTAP 1.3 on PostgreSQL 17', async () => {
    const run = await runTap(url, `SELECT plan(2); SELECT is(pgtap_version(), 1.3, 'pgTAP 1.3'); SELECT cmp_ok(pg_version_num(), '>=', 170000, 'PostgreSQL 17 or later');`);
    expect(problemsOf(run)).toEqual([]);
  });

  // The runner itself, on real pgTAP: a run that should fail does. Each case names the problem it must report.
  it.each([
    ['a failed assertion', `SELECT plan(2); SELECT ok(true); SELECT ok(false, 'deliberate');`, /^not ok 2 - deliberate$/],
    ['fewer tests than planned', `SELECT plan(2); SELECT ok(true);`, /^planned 2 tests but ran 1$/],
    ['more tests than planned', `SELECT plan(1); SELECT ok(true); SELECT ok(true);`, /^planned 1 tests but ran 2$/],
    ['no plan up front', `SELECT * FROM no_plan(); SELECT ok(true); SELECT * FROM finish();`, /comes after tests/],
    ['a skipped test', `SELECT plan(1); SELECT skip('not now', 1);`, /marked SKIP/],
    ['a TODO test', `SELECT plan(1); SELECT * FROM todo('later', 1); SELECT ok(true);`, /marked TODO/],
    ['a SQL error', `SELECT plan(1); SELECT ok(1 / 0 = 1);`, /^SQL error 22012/],
    ['an error raised in an assertion', `SELECT plan(1); SELECT throws_ok('SELECT 1', '22012');`, /^not ok 1/],
    ['a file that commits', `SELECT plan(1); SELECT ok(true); COMMIT;`, /ended the runner's transaction/],
  ])('fails %s', async (_name, sql, problem) => {
    const problems = problemsOf(await runTap(url, sql));
    expect(problems.some((p) => problem.test(p)), problems.join('\n')).toBe(true);
  });

  it('passes a file whose tests all pass, with finish()', async () => {
    const run = await runTap(url, `SELECT plan(1); SELECT ok(true, 'fine'); SELECT * FROM finish();`);
    expect(run).toEqual({ lines: ['1..1', 'ok 1 - fine'], error: null });
  });

  it.each(listTests().filter((f) => f.endsWith('.test.sql')))('%s', async (file) => {
    const sql = await readFile(`${TESTS}/${file}`, 'utf8');
    expect(problemsOf(await runTap(url, sql)), file).toEqual([]);
  });
});
