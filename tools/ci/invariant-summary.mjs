// Report of an invariant suite run for .github/workflows/protected.yml (#498). The job log of a failed run is mostly
// the database container's log, and the API returns only its tail, so the failing tests are written where they can be
// read without the full log: the job summary (Markdown, for the browser), one error annotation per failed test (shown
// on the PR), and a short plain listing in the step's log. It never decides the job: the vitest step and the skipped
// check do; this exits 0 whatever the report says.
//
// Usage: node tools/ci/invariant-summary.mjs <vitest-json-report>
//   Appends Markdown to $GITHUB_STEP_SUMMARY when it is set. Paths are shown relative to the working directory.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { pathToFileURL } from 'node:url';

export const MAX_LISTED = 30; // failed tests written out in the summary; the count covers the rest
export const MAX_ANNOTATIONS = 10; // GitHub keeps at most 10 error annotations per step
const MAX_LINES = 12; // lines of each failure message

export function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex -- the escape character is what is being removed
  return text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
}

// Stack frames that say nothing about the test: inside node_modules, Node's internals, or anonymous.
const NOISE = /\/node_modules\/|^\s*at .*(\(<anonymous>\)|\(?node:internal)/;

// The first lines of a failure message: no colors, no noise frames, paths relative to `cwd`.
export function excerpt(message, cwd, lines = MAX_LINES) {
  const root = cwd.endsWith('/') ? cwd : `${cwd}/`;
  const kept = stripAnsi(message)
    .split('\n')
    .filter((line) => !NOISE.test(line))
    .map((line) => line.replaceAll(`file://${root}`, '').replaceAll(root, '').trimEnd());
  while (kept.length > 0 && kept.at(-1) === '') kept.pop();
  if (kept.length <= lines) return kept.join('\n');
  return [...kept.slice(0, lines), `... (${kept.length - lines} more lines in the job log)`].join('\n');
}

// What went wrong in a vitest JSON report: failed tests, skipped ones (the job refuses those), and test files that
// failed outside any test, such as a file that cannot be loaded.
export function findProblems(report, cwd) {
  const failed = [];
  const skipped = [];
  const brokenFiles = [];
  for (const file of report.testResults ?? []) {
    const path = relative(cwd, file.name ?? '') || String(file.name);
    let failedHere = 0;
    for (const test of file.assertionResults ?? []) {
      const name = [...(test.ancestorTitles ?? []), test.title].join(' › ');
      if (test.status === 'failed') {
        failedHere += 1;
        failed.push({ path, name, message: excerpt((test.failureMessages ?? []).join('\n'), cwd) });
      } else if (test.status !== 'passed') {
        skipped.push({ path, name, status: test.status });
      }
    }
    if (file.status === 'failed' && failedHere === 0) brokenFiles.push({ path, message: excerpt(file.message || 'failed', cwd) });
  }
  return { failed, skipped, brokenFiles };
}

export function counts(report) {
  const skipped = (report.numPendingTests ?? 0) + (report.numTodoTests ?? 0);
  return `${report.numPassedTests ?? 0} passed, ${report.numFailedTests ?? 0} failed, ${skipped} skipped (${report.numTotalTests ?? 0} tests)`;
}

// Markdown text outside code: every ASCII punctuation character that Markdown or HTML could act on is escaped.
export function escapeMarkdown(text) {
  return text.replace(/[\\`*_{}[\]()<>#+\-.!|~&]/g, '\\$&');
}

// A fenced block the text cannot close: the fence is longer than any run of backticks in it.
export function fenced(text, indent = '') {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return [`${fence}text`, ...text.split('\n'), fence].map((line) => `${indent}${line}`).join('\n');
}

function code(path) {
  return `\`${path.replaceAll('`', "'")}\``;
}

export function markdown(report, problems) {
  const { failed, skipped, brokenFiles } = problems;
  const out = [`### Invariant suite: ${counts(report)}`, ''];
  if (failed.length === 0 && skipped.length === 0 && brokenFiles.length === 0) {
    out.push(report.numPassedTests > 0 ? 'Every invariant test passed.' : 'No invariant test ran.', '');
    return out.join('\n');
  }
  if (brokenFiles.length > 0) {
    out.push('#### Test files that failed outside a test', '');
    for (const file of brokenFiles) out.push(`- ${code(file.path)}`, fenced(file.message, '  '));
    out.push('');
  }
  if (failed.length > 0) {
    out.push('#### Failed tests', '');
    for (const test of failed.slice(0, MAX_LISTED)) out.push(`- ${code(test.path)}: ${escapeMarkdown(test.name)}`, fenced(test.message, '  '));
    if (failed.length > MAX_LISTED) out.push(`- ...and ${failed.length - MAX_LISTED} more; the job log lists them all.`);
    out.push('');
  }
  if (skipped.length > 0) {
    out.push('#### Skipped tests (a skipped invariant test fails this job)', '');
    for (const test of skipped) out.push(`- ${code(test.path)}: ${escapeMarkdown(test.name)} (${test.status})`);
    out.push('');
  }
  return out.join('\n');
}

// Workflow command escaping (actions/toolkit): `%`, CR and LF in the message; also `:` and `,` in a property.
function escapeData(text) {
  return text.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}

function escapeProperty(text) {
  return escapeData(text).replaceAll(':', '%3A').replaceAll(',', '%2C');
}

export function annotations(problems) {
  const items = [
    ...problems.brokenFiles.map((file) => ({ path: file.path, title: 'Invariant test file failed to run', message: file.message })),
    ...problems.failed.map((test) => ({ path: test.path, title: `Invariant test failed: ${test.name}`, message: test.message })),
  ];
  return items
    .slice(0, MAX_ANNOTATIONS)
    .map((item) => `::error file=${escapeProperty(item.path)},title=${escapeProperty(item.title)}::${escapeData(item.message)}`);
}

// The plain listing for the step's log.
export function logLines(report, problems) {
  const lines = [`invariant suite: ${counts(report)}`];
  for (const file of problems.brokenFiles) lines.push(`FILE FAILED ${file.path}`, ...file.message.split('\n').map((line) => `    ${line}`));
  for (const test of problems.failed) lines.push(`FAILED ${test.path} > ${test.name}`, ...test.message.split('\n').map((line) => `    ${line}`));
  for (const test of problems.skipped) lines.push(`SKIPPED ${test.path} > ${test.name} (${test.status})`);
  return lines;
}

function main() {
  const [reportPath] = process.argv.slice(2);
  if (!reportPath) throw new Error('usage: node tools/ci/invariant-summary.mjs <vitest-json-report>');
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!existsSync(reportPath)) {
    const text = 'No vitest report was written: the run stopped before reporting. The log of the step that ran the suite has the error.';
    console.log(text);
    if (summaryPath) appendFileSync(summaryPath, `### Invariant suite: no report\n\n${text}\n`);
    return;
  }
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  const problems = findProblems(report, process.cwd());
  for (const line of [...logLines(report, problems), ...annotations(problems)]) console.log(line);
  if (summaryPath) appendFileSync(summaryPath, markdown(report, problems));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
