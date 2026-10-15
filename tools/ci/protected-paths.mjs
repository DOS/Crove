// Protected-path detection for the Decision 7 review flow (plan §10, gate G6; External-tenant gate T15).
// No dependencies, one file: CI copies this script from the base branch before running it, so a PR cannot
// change what counts as protected for its own run.
//
// Usage: node tools/ci/protected-paths.mjs <base-sha> <head-sha>
//   Prints the protected files changed between the merge base and head, and writes `protected=true|false`
//   to $GITHUB_OUTPUT and a table to $GITHUB_STEP_SUMMARY when those are set. Exits 0 either way; a git
//   failure throws, so the CI step fails closed.
//
// Detection uses paths only, never file contents: contents can be hidden from `git diff` (for example by a
// `-diff` or `binary` attribute in .gitattributes), and keyword scans are easy to evade.
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Path rules. Each entry is [regex on the repo-relative path, reason].
export const PROTECTED_PATHS = [
  // CI, repository config and the agent harness.
  [/^\.github\/workflows\//, 'CI workflow'],
  [/^\.github\/actions\//, 'CI action'],
  [/^\.github\/CODEOWNERS$/, 'code owners'],
  [/^\.githooks\//, 'git hook'],
  [/^tools\/install-git-hooks\.mjs$/, 'git hook installer'],
  [/(^|\/)\.gitattributes$/, 'git attributes'],
  [/^\.gitmodules$/, 'git submodules'],
  [/^\.claude\/settings[^/]*$/, 'agent harness settings'],
  [/^\.claude\/hooks\//, 'agent harness hook'],
  [/^\.claude\/agents\//, 'agent definition'],
  [/^\.mcp\.json$/, 'agent tool config'],
  [/^CLAUDE\.md$/, 'agent policy'],
  [/^AGENTS\.md$/, 'agent policy'],
  // Dependencies and test runners: they decide what code and which tests run in CI.
  // Every package.json: `exports`/`main`/`imports` can repoint a package the invariant suite imports,
  // and `scripts`/`pnpm` fields run code, all without touching the lockfile.
  [/(^|\/)package\.json$/, 'package manifest'],
  [/^pnpm-lock\.yaml$/, 'lockfile'],
  [/^pnpm-workspace\.yaml$/, 'workspace and dependency catalog'],
  [/(^|\/)\.npmrc$/, 'package manager config'],
  [/^vitest(\.[a-z]+)?\.(config|workspace)\.[cm]?[jt]s$/, 'test runner config'],
  // The Playwright config and global setup decide which e2e tests run (`testIgnore`, `grep`, a setup that exits
  // early), so they count as test runner config in any directory.
  [/(^|\/)playwright(\.[a-z]+)?\.config\.[cm]?[jt]s$/, 'test runner config'],
  [/(^|\/)global-(setup|teardown)\.[cm]?[jt]s$/, 'test runner global setup'],
  // This gate itself: the detection script and the invariant suite.
  [/^tools\/ci\//, 'protected-path gate'],
  [/(^|\/)test\/invariant\//, 'invariant suite'],
  // Context, policy and authorization: the one write path, context entry, approval policy, identity, HTTP edge.
  [/^packages\/kernel-runtime\/src\//, 'command runtime (context and authorization)'],
  [/^packages\/db\/src\/context\//, 'database context'],
  [/^packages\/db\/src\/index\.ts$/, 'database context guards'],
  [/^packages\/db\/src\/migrate\.ts$/, 'migration runner and hardening guard'],
  [/^packages\/kernel\/src\/(approval|identity)\.ts$/, 'approval policy or identity'],
  [/(^|\/)auth(\/|\.ts$|-[^/]*\.ts$)/, 'authentication'],
  [/^apps\/kernel\/src\/(auth|sessions)[^/]*\.ts$/, 'identity adapter'],
  [/^apps\/kernel\/src\/http\.ts$/, 'HTTP edge (authentication, inbound secret)'],
  // Schema: every migration change (G6 lists GRANT/POLICY/DEFINER/ROLE; any SQL can drop a trigger or
  // replace a function, so all of them count).
  [/^supabase\/migrations\//, 'migration'],
  // SQL tests and legal documents.
  [/(^|\/)_[^/]*\.test\.sql$/, 'SQL invariant test'],
  [/^LICENSE$/, 'license'],
  [/^CLA\.md$/, 'contributor agreement'],
  [/(^|\/)agent-autonomy\.md$/, 'agent autonomy table'],
];

/**
 * Classify changed paths.
 * @param {string[]} paths changed paths (renames give both the old and the new path).
 * @returns {Array<{ path: string, reason: string }>} the protected paths, in input order.
 */
export function classify(paths) {
  const hits = [];
  for (const path of paths) {
    const rule = PROTECTED_PATHS.find(([re]) => re.test(path));
    if (rule) hits.push({ path, reason: rule[1] });
  }
  return hits;
}

/** Parse `git diff --name-status -z` output: NUL-separated status, then one path (two for renames and copies). */
export function parseNameStatusZ(out) {
  const fields = out.split('\0');
  const paths = [];
  for (let i = 0; i < fields.length; ) {
    const status = fields[i++];
    if (!status) continue;
    // Renames and copies list old and new path; both count, so a rename out of a protected path is caught.
    const count = /^[RC]/.test(status) ? 2 : 1;
    for (let n = 0; n < count && i < fields.length; n++) paths.push(fields[i++]);
  }
  return paths;
}

function main(argv) {
  const [base, head] = argv;
  if (!base || !head) {
    console.error('usage: node tools/ci/protected-paths.mjs <base-sha> <head-sha>');
    process.exit(2);
  }
  const out = execFileSync('git', ['-c', 'core.quotePath=false', 'diff', '--no-ext-diff', '--name-status', '-z', '-M', `${base}...${head}`], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const hits = classify(parseNameStatusZ(out));
  const isProtected = hits.length > 0;

  console.log(isProtected ? `Protected paths changed (${hits.length}):` : 'No protected paths changed.');
  for (const h of hits) console.log(`  ${h.path}  (${h.reason})`);

  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `protected=${isProtected}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const rows = hits.map((h) => `| \`${h.path.replace(/[`|]/g, '?')}\` | ${h.reason} |`).join('\n');
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      isProtected
        ? `### Protected paths changed\n\n| File | Why |\n| --- | --- |\n${rows}\n\n`
        : '### No protected paths changed\n\nThe invariant suite and the security review are not required for this PR.\n\n',
    );
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main(process.argv.slice(2));
