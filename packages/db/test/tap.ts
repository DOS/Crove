// The TAP check of the pgTAP runner (issue #1627, plan §10 G3): reads the lines a pgTAP test file printed and says
// why the file fails, if it does. A file passes only when it planned its tests up front with plan(n), n >= 1, ran
// exactly n tests numbered 1..n, every one `ok`, none skipped or marked TODO, and nothing bailed out. A SQL error is
// the runner's to report: it never reaches this check.
//
// Lines that are not TAP (the output of a setup SELECT) are ignored: they cannot hide a failure, since a failed test
// always prints `not ok` and a test that did not run leaves the count short of the plan.

const PLAN = /^1\.\.(\d+)\b(.*)$/;
const TEST = /^(not )?ok\b(?:\s+(\d+))?(.*)$/;
// A SKIP or TODO directive: pgTAP prints `ok 3 # SKIP why` and `not ok 3 - name # TODO why`. pgTAP does not escape
// `#` in a description, so a description holding " # todo" is refused too: strict, and never a false pass.
const DIRECTIVE = /(?:^|\s)#\s*(SKIP|TODO)\b/i;
const BAIL_OUT = /^Bail out!/;

// Every text value of the results, split into lines: pgTAP functions return one text value per call, which may hold
// several lines (a failed test is followed by its diagnostics).
export function tapLines(values: readonly unknown[]): string[] {
  return values.filter((v): v is string => typeof v === 'string').flatMap((v) => v.split('\n'));
}

// The reasons the TAP output fails, empty when it passes.
export function tapProblems(lines: readonly string[]): string[] {
  const problems: string[] = [];
  let planned: number | null = null;
  let plans = 0;
  let count = 0;
  for (const line of lines) {
    const plan = PLAN.exec(line);
    if (plan) {
      plans += 1;
      if (count > 0) problems.push(`the plan "${line}" comes after tests: plan the tests up front with plan(n), not no_plan()`);
      planned = Number(plan[1]);
      if (DIRECTIVE.test(plan[2] ?? '')) problems.push(`the whole file is skipped: ${line}`);
      continue;
    }
    if (BAIL_OUT.test(line)) {
      problems.push(line);
      continue;
    }
    const test = TEST.exec(line);
    if (!test) continue;
    count += 1;
    if (test[2] !== undefined && Number(test[2]) !== count) problems.push(`test ${count} is numbered ${test[2]}: ${line}`);
    if (test[1]) problems.push(line);
    const directive = DIRECTIVE.exec(test[3] ?? '');
    if (directive) problems.push(`a test is marked ${(directive[1] as string).toUpperCase()}, which the gate does not accept: ${line}`);
  }
  if (plans === 0) problems.push('no plan: start the file with SELECT plan(n)');
  if (plans > 1) problems.push(`${plans} plans: plan once`);
  if (planned === 0) problems.push('a plan of 0 tests');
  if (planned !== null && planned !== count) problems.push(`planned ${planned} tests but ran ${count}`);
  return problems;
}
