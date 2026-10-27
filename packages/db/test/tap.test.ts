// The TAP check of the pgTAP runner (issue #1627): every way a pgTAP file can fail is refused. pgtap.db.test.ts runs
// the same cases through real pgTAP on PostgreSQL.
import { describe, expect, it } from 'vitest';
import { tapLines, tapProblems } from './tap.ts';

describe('the TAP check of the pgTAP runner', () => {
  it('passes a planned file whose tests all pass, ignoring diagnostics and setup output', () => {
    expect(tapProblems(['1..3', 'ok 1 - has the table', 'set-up value', 'ok 2', '# a note', 'ok 3 - the last one'])).toEqual([]);
  });

  it('fails a test that is not ok', () => {
    expect(tapProblems(['1..2', 'ok 1', 'not ok 2 - deliberate', '# Failed test 2: "deliberate"'])).toEqual(['not ok 2 - deliberate']);
  });

  it('fails when the count of tests run differs from the plan', () => {
    expect(tapProblems(['1..3', 'ok 1', 'ok 2'])).toEqual(['planned 3 tests but ran 2']);
    expect(tapProblems(['1..1', 'ok 1', 'ok 2'])).toEqual(['planned 1 tests but ran 2']);
  });

  it('fails without a plan, with a plan after the tests (no_plan), with two plans or with a plan of 0', () => {
    expect(tapProblems(['ok 1'])).toEqual(['no plan: start the file with SELECT plan(n)']);
    expect(tapProblems(['ok 1', '1..1'])[0]).toMatch(/comes after tests/);
    expect(tapProblems(['1..1', '1..1', 'ok 1'])).toEqual(['2 plans: plan once']);
    expect(tapProblems(['1..0'])).toEqual(['a plan of 0 tests']);
    expect(tapProblems([])).toEqual(['no plan: start the file with SELECT plan(n)']);
  });

  it('fails a skipped test, a skipped file and a TODO test, passing or not', () => {
    expect(tapProblems(['1..1', 'ok 1 # SKIP no data'])[0]).toMatch(/marked SKIP/);
    expect(tapProblems(['1..0 # SKIP nothing here'])).toContain('the whole file is skipped: 1..0 # SKIP nothing here');
    expect(tapProblems(['1..1', 'ok 1 - later # TODO not built'])[0]).toMatch(/marked TODO/);
    expect(tapProblems(['1..1', 'not ok 1 - later # TODO not built'])).toHaveLength(2);
  });

  it('fails tests numbered out of order and a bail out', () => {
    expect(tapProblems(['1..2', 'ok 1', 'ok 3'])).toEqual(['test 2 is numbered 3: ok 3']);
    expect(tapProblems(['1..1', 'Bail out! broken', 'ok 1'])).toEqual(['Bail out! broken']);
  });

  it('splits multi-line values and drops values that are not text', () => {
    expect(tapLines(['1..1', 'not ok 1\n# Failed test 1', 2, null])).toEqual(['1..1', 'not ok 1', '# Failed test 1']);
  });
});
