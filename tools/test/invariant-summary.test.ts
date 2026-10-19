import { describe, expect, it } from 'vitest';
import {
  MAX_ANNOTATIONS,
  MAX_LISTED,
  annotations,
  escapeMarkdown,
  excerpt,
  fenced,
  findProblems,
  logLines,
  markdown,
} from '../ci/invariant-summary.mjs';

const cwd = '/runner/work/Crove/Crove';
const file = (name: string, status: string, tests: object[], message = '') => ({ name: `${cwd}/${name}`, status, message, assertionResults: tests });
const test = (title: string, status: string, failureMessages: string[] = [], ancestorTitles = ['suite']) => ({ ancestorTitles, title, status, failureMessages });

// The shape of a vitest JSON report (Jest compatible), as `--reporter=json` writes it.
function report(testResults: object[], numbers: Partial<Record<string, number>> = {}) {
  return { numTotalTests: 0, numPassedTests: 0, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0, testResults, ...numbers };
}

describe('invariant suite report (#498)', () => {
  const stack = [
    '\u001b[31mAssertionError: expected 1792349717 to be 1792349718\u001b[39m',
    `    at ${cwd}/apps/kernel/test/invariant/kernel-invariants.db.test.ts:494:7`,
    `    at file://${cwd}/node_modules/.pnpm/vitest@5.0.4/node_modules/vitest/dist/chunks/run.js:1632:3`,
    '    at new Promise (<anonymous>)',
    '    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)',
  ].join('\n');
  const failing = report(
    [
      file('apps/kernel/test/invariant/kernel-invariants.db.test.ts', 'failed', [
        test('reads the assurance level', 'failed', [stack], ['kernel invariants', 'tokens']),
        test('passes', 'passed'),
        test('is skipped', 'skipped'),
      ]),
      file('packages/db/test/invariant/context.db.test.ts', 'failed', [], 'Failed to load url ./missing.ts'),
      file('apps/kernel/test/invariant/rls-matrix.db.test.ts', 'passed', [test('isolates', 'passed')]),
    ],
    { numTotalTests: 4, numPassedTests: 2, numFailedTests: 1, numPendingTests: 1 },
  );

  it('finds failed tests, skipped tests and files that failed outside a test, with paths relative to the checkout', () => {
    const problems = findProblems(failing, cwd);
    expect(problems.failed).toEqual([
      {
        path: 'apps/kernel/test/invariant/kernel-invariants.db.test.ts',
        name: 'kernel invariants › tokens › reads the assurance level',
        message: 'AssertionError: expected 1792349717 to be 1792349718\n    at apps/kernel/test/invariant/kernel-invariants.db.test.ts:494:7',
      },
    ]);
    expect(problems.skipped).toEqual([{ path: 'apps/kernel/test/invariant/kernel-invariants.db.test.ts', name: 'suite › is skipped', status: 'skipped' }]);
    expect(problems.brokenFiles).toEqual([{ path: 'packages/db/test/invariant/context.db.test.ts', message: 'Failed to load url ./missing.ts' }]);
  });

  it('writes the counts and each problem to the job summary', () => {
    const text = markdown(failing, findProblems(failing, cwd));
    expect(text).toContain('### Invariant suite: 2 passed, 1 failed, 1 skipped (4 tests)');
    expect(text).toContain('#### Test files that failed outside a test\n\n- `packages/db/test/invariant/context.db.test.ts`\n  ```text\n  Failed to load url ./missing.ts\n  ```');
    expect(text).toContain('- `apps/kernel/test/invariant/kernel-invariants.db.test.ts`: kernel invariants › tokens › reads the assurance level\n  ```text\n  AssertionError');
    expect(text).toContain('#### Skipped tests (a skipped invariant test fails this job)\n\n- `apps/kernel/test/invariant/kernel-invariants.db.test.ts`: suite › is skipped (skipped)');
    expect(text).not.toContain('node_modules');
    expect(text).not.toContain('\u001b');
  });

  it('says so when every test passed, or when none ran', () => {
    const passed = report([file('a/test/invariant/x.db.test.ts', 'passed', [test('ok', 'passed')])], { numTotalTests: 1, numPassedTests: 1 });
    expect(markdown(passed, findProblems(passed, cwd))).toBe('### Invariant suite: 1 passed, 0 failed, 0 skipped (1 tests)\n\nEvery invariant test passed.\n');
    const empty = report([]);
    expect(markdown(empty, findProblems(empty, cwd))).toContain('No invariant test ran.');
  });

  it('lists at most MAX_LISTED failed tests in the summary and counts the rest', () => {
    const tests = Array.from({ length: MAX_LISTED + 5 }, (_, i) => test(`case ${i}`, 'failed', ['boom']));
    const many = report([file('a/test/invariant/x.db.test.ts', 'failed', tests)], { numTotalTests: tests.length, numFailedTests: tests.length });
    const text = markdown(many, findProblems(many, cwd));
    expect(text).toContain(`suite › case ${MAX_LISTED - 1}`);
    expect(text).not.toContain(`suite › case ${MAX_LISTED}\n`);
    expect(text).toContain('- ...and 5 more; the job log lists them all.');
    expect(logLines(many, findProblems(many, cwd)).filter((line) => line.startsWith('FAILED '))).toHaveLength(MAX_LISTED + 5);
  });

  it('keeps test names and messages from breaking the Markdown', () => {
    expect(escapeMarkdown('a <b> `c` [d](e) *f*')).toBe('a \\<b\\> \\`c\\` \\[d\\]\\(e\\) \\*f\\*');
    expect(fenced('one ``` two', '  ')).toBe('  ````text\n  one ``` two\n  ````');
    expect(fenced('plain')).toBe('```text\nplain\n```');
  });

  it('shortens a long failure message and points to the log for the rest', () => {
    const long = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
    const short = excerpt(long, cwd, 3);
    expect(short).toBe('line 0\nline 1\nline 2\n... (17 more lines in the job log)');
  });

  it('emits one escaped error annotation per problem, at most MAX_ANNOTATIONS', () => {
    const lines = annotations(findProblems(failing, cwd));
    expect(lines).toEqual([
      '::error file=packages/db/test/invariant/context.db.test.ts,title=Invariant test file failed to run::Failed to load url ./missing.ts',
      // `:` and `,` are escaped only in properties; the message keeps them, with its line break escaped.
      '::error file=apps/kernel/test/invariant/kernel-invariants.db.test.ts,title=Invariant test failed%3A kernel invariants › tokens › reads the assurance level::AssertionError: expected 1792349717 to be 1792349718%0A    at apps/kernel/test/invariant/kernel-invariants.db.test.ts:494:7',
    ]);
    const tests = Array.from({ length: MAX_ANNOTATIONS + 3 }, (_, i) => test(`case ${i}, 100%`, 'failed', ['boom']));
    const many = report([file('a/test/invariant/x.db.test.ts', 'failed', tests)]);
    const all = annotations(findProblems(many, cwd));
    expect(all).toHaveLength(MAX_ANNOTATIONS);
    expect(all[0]).toBe('::error file=a/test/invariant/x.db.test.ts,title=Invariant test failed%3A suite › case 0%2C 100%25::boom');
  });
});
