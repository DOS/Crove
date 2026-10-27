// The pgTAP gate files (plan §10 G3 and G6, issues #1627 and #1643): supabase/tests/database/_*.test.sql, the gate's
// own checks in pgTAP, run on a real PostgreSQL 17 after every migration, with the runner shown failing every way a
// file can fail. Part of the invariant suite: on protected-path PRs, .github/workflows/protected.yml takes this file,
// the runner in pgtap/ (its TAP check and the vendored pgTAP) and the gate files themselves from the base branch, so a
// PR cannot weaken a gate file or the code that judges it for its own run. The modules' pgTAP tests
// (supabase/tests/database/<token>/*.test.sql) run in packages/db/test/pgtap.db.test.ts, with this runner.
//
// The layout test needs no database. Every other case needs CROVE_TEST_ADMIN_URL, a superuser URL; the run creates and
// drops its own database. Without it they are skipped, which fails the invariant job.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GATE_FILE, layoutViolations, listTests, pgtapDatabase, problemsOf, runTap, runTestFile, type PgtapDatabase } from './pgtap/runner.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
// The gate files that must be there: removing one fails the run instead of shrinking it.
const REQUIRED = ['_conformance.test.sql', '_rls_matrix.test.sql'];

it('every file under supabase/tests/database follows the layout, and the gate files are there', () => {
  const files = listTests();
  expect(layoutViolations(files)).toEqual([]);
  expect(files).toEqual(expect.arrayContaining(REQUIRED));
});

const suite = ADMIN ? describe : describe.skip;

suite('pgTAP gate files in supabase/tests/database', () => {
  let db: PgtapDatabase | undefined;

  beforeAll(async () => {
    const created = pgtapDatabase(ADMIN as string);
    db = created;
    await created.ready;
  }, 300_000);

  afterAll(async () => {
    await db?.drop();
  });

  const url = () => (db as PgtapDatabase).url;

  it('runs pgTAP 1.3 on PostgreSQL 17', async () => {
    const run = await runTap(url(), `SELECT plan(2); SELECT is(pgtap_version(), 1.3, 'pgTAP 1.3'); SELECT cmp_ok(pg_version_num(), '>=', 170000, 'PostgreSQL 17 or later');`);
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
    ['an expected error that never comes', `SELECT plan(1); SELECT throws_ok('SELECT 1', '22012');`, /^not ok 1/],
    ['a file that commits', `SELECT plan(1); SELECT ok(true); COMMIT;`, /ended the runner's transaction/],
    ['a file that commits and begins again', `SELECT plan(1); SELECT ok(true); COMMIT; BEGIN;`, /ended the runner's transaction/],
    ['a file that rolls back and begins again', `SELECT plan(1); SELECT ok(true); ROLLBACK; BEGIN;`, /ended the runner's transaction/],
    ['a test hidden in a result of two columns', `SELECT plan(1); SELECT ok(true); SELECT ok(false, 'hidden'), 1;`, /^a TAP line in a result of more than one column.*: not ok 2 - hidden$/],
    ['a plan hidden in a result of two columns', `SELECT 1, plan(1); SELECT ok(true);`, /^a TAP line in a result of more than one column.*: 1\.\.1$/],
    ['a test hidden behind a column of the same name', `SELECT plan(1); SELECT ok(true); SELECT ok(false, 'hidden') AS x, 1 AS x;`, /^a TAP line in a result of more than one column.*: not ok 2 - hidden$/],
    ['a test hidden in an array', `SELECT plan(1); SELECT ok(true); SELECT ARRAY[ok(false)];`, /^pgTAP ran 2 tests but the runner read 1/],
    ['a failure hidden in a DO block behind a forged line', `SELECT plan(2); SELECT ok(true); SELECT 'ok 2'; DO $$ BEGIN PERFORM ok(false); END $$;`, /^pgTAP counts 1 failed tests/],
  ])('fails %s', async (_name, sql, problem) => {
    const problems = problemsOf(await runTap(url(), sql));
    expect(problems.some((p) => problem.test(p)), problems.join('\n')).toBe(true);
  });

  it('passes a file whose tests all pass, with finish() and a setup result of two columns', async () => {
    const run = await runTap(url(), `SELECT plan(1); SELECT 'setup', 2; SELECT ok(true, 'fine'); SELECT * FROM finish();`);
    expect(run).toEqual({ lines: ['1..1', 'ok 1 - fine'], error: null });
  });

  it.each(listTests().filter((f) => GATE_FILE.test(f)))('%s', async (file) => {
    expect(await runTestFile(url(), file), file).toEqual([]);
  });
});
