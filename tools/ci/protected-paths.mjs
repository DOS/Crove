// Protected-path detection for the Decision 7 review flow (plan §10, gate G6; External-tenant gate T15).
// No dependencies, one file: CI copies this script from the base branch before running it, so a PR cannot
// change what counts as protected for its own run.
//
// Usage: node tools/ci/protected-paths.mjs <base-sha> <head-sha>
//   Prints the protected files changed between the merge base and head, and writes `protected=true|false`
//   to $GITHUB_OUTPUT and a table to $GITHUB_STEP_SUMMARY when those are set. Exits 0 either way.
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Path rules. Each entry is [regex on the repo-relative path, reason].
export const PROTECTED_PATHS = [
  // CI and agent harness: workflows, hooks, agent settings.
  [/^\.github\/workflows\//, 'CI workflow'],
  [/^\.github\/actions\//, 'CI action'],
  [/^\.githooks\//, 'git hook'],
  [/^tools\/install-git-hooks\.mjs$/, 'git hook installer'],
  [/^\.claude\/settings[^/]*$/, 'agent harness settings'],
  [/^\.claude\/hooks\//, 'agent harness hook'],
  // This gate itself: the detection script, the invariant suite and its runner config.
  [/^tools\/ci\//, 'protected-path gate'],
  [/(^|\/)test\/invariant\//, 'invariant suite'],
  [/^vitest\.invariant\.config\.ts$/, 'invariant suite config'],
  // Context, policy and authorization: the one write path, context entry, approval policy, identity.
  [/^packages\/kernel-runtime\/src\//, 'command runtime (context and authorization)'],
  [/^packages\/db\/src\/context\//, 'database context'],
  [/^packages\/db\/src\/index\.ts$/, 'database context guards'],
  [/^packages\/kernel\/src\/(approval|identity)\.ts$/, 'approval policy or identity'],
  [/(^|\/)auth(\/|\.ts$|-[^/]*\.ts$)/, 'authentication'],
  [/^apps\/kernel\/src\/(auth|sessions)[^/]*\.ts$/, 'identity adapter'],
  // SQL tests and policy documents.
  [/(^|\/)_[^/]*\.test\.sql$/, 'SQL invariant test'],
  [/^AGENTS\.md$/, 'agent policy'],
  [/^LICENSE$/, 'license'],
  [/^CLA\.md$/, 'contributor agreement'],
  [/(^|\/)agent-autonomy\.md$/, 'agent autonomy table'],
];

// A migration is protected when it touches privileges, policies, definer functions or roles (G6).
export const MIGRATION_PATH = /^supabase\/migrations\/[^/]+\.sql$/;
export const MIGRATION_SENSITIVE =
  /\b(GRANT|REVOKE|POLICY|SECURITY\s+DEFINER|DEFINER|BYPASSRLS|ROW\s+LEVEL\s+SECURITY|apply_tenant_rls|(CREATE|ALTER|DROP|SET)\s+ROLE|OWNER\s+TO|DEFAULT\s+PRIVILEGES)\b/i;

/**
 * Classify changed files.
 * @param {Array<{ status: string, path: string }>} changes `git diff --name-status` entries (renames give the new path).
 * @param {(path: string) => string} sqlOf text of a changed migration to scan (its diff, or the whole file).
 * @returns {Array<{ path: string, reason: string }>} the protected files, in input order.
 */
export function classify(changes, sqlOf) {
  const hits = [];
  for (const { status, path } of changes) {
    const rule = PROTECTED_PATHS.find(([re]) => re.test(path));
    if (rule) {
      hits.push({ path, reason: rule[1] });
    } else if (MIGRATION_PATH.test(path)) {
      // Applied migrations are never edited or deleted, so anything but an addition is suspicious.
      if (status !== 'A') hits.push({ path, reason: `migration ${status === 'D' ? 'deleted' : 'changed'}` });
      else if (MIGRATION_SENSITIVE.test(sqlOf(path))) hits.push({ path, reason: 'migration with GRANT/POLICY/DEFINER/ROLE' });
    }
  }
  return hits;
}

/** Parse `git diff --name-status -M` output. */
export function parseNameStatus(out) {
  const changes = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [code, ...paths] = line.split('\t');
    const status = code.charAt(0);
    // Renames and copies list old and new path; both count, so a rename out of a protected path is caught.
    for (const path of paths) changes.push({ status: status === 'R' || status === 'C' ? 'M' : status, path });
  }
  return changes;
}

function main(argv) {
  const [base, head] = argv;
  if (!base || !head) {
    console.error('usage: node tools/ci/protected-paths.mjs <base-sha> <head-sha>');
    process.exit(2);
  }
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const changes = parseNameStatus(git('diff', '--name-status', '-M', `${base}...${head}`));
  const hits = classify(changes, (path) => git('diff', `${base}...${head}`, '--', path));
  const isProtected = hits.length > 0;

  console.log(isProtected ? `Protected paths changed (${hits.length}):` : 'No protected paths changed.');
  for (const h of hits) console.log(`  ${h.path}  (${h.reason})`);

  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `protected=${isProtected}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const rows = hits.map((h) => `| \`${h.path}\` | ${h.reason} |`).join('\n');
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      isProtected
        ? `### Protected paths changed\n\n| File | Why |\n| --- | --- |\n${rows}\n\n`
        : '### No protected paths changed\n\nThe invariant suite and the security review are not required for this PR.\n\n',
    );
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main(process.argv.slice(2));
