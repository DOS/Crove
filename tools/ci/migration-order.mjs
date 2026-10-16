// Migration order check for pull requests (AGENTS.md: a new migration's version is greater than every file on main).
// The runner records each file under its 14-digit version, so a PR that adds a version equal to or older than the
// base's newest either collides with a file already on main or applies out of order on databases that are already
// migrated. Parallel PRs hit this often. GitHub does not re-run PR checks when the base moves, so
// tools/ci/migration-recheck.mjs re-runs this check on open PRs after every push to main.
//
// Usage: node tools/ci/migration-order.mjs <base-ref> [since-ref]
//   Compares the migration files HEAD adds since <since-ref> (default: the merge base of <base-ref> and HEAD) with
//   the newest version on <base-ref>. CI passes the live base branch as <base-ref> and the merge commit's first
//   parent as <since-ref>. Exits 1 and names each offending file with a free version to rename it to. Renames
//   count as additions, so renaming a file to a newer version is the fix.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const DIR = 'supabase/migrations/';
const VERSION = /^supabase\/migrations\/(\d{14})_[^/]+\.sql$/;

export function versionOf(path) {
  return VERSION.exec(path)?.[1];
}

// Pure check: `basePaths` are the migration paths on the base, `addedPaths` those the PR adds.
export function findStale(basePaths, addedPaths) {
  const newest = basePaths.map(versionOf).filter(Boolean).sort().at(-1) ?? '';
  const stale = addedPaths.filter((path) => {
    const version = versionOf(path);
    return version !== undefined && version <= newest;
  });
  return { newest, stale };
}

// `count` free versions on whole hours, each later than `after` (a 14-digit version, or '' for none).
export function nextVersions(after, count = 1) {
  const start = after
    ? Date.UTC(+after.slice(0, 4), +after.slice(4, 6) - 1, +after.slice(6, 8), +after.slice(8, 10))
    : Date.UTC(1970, 0, 1);
  const hour = 3_600_000;
  return Array.from({ length: count }, (_, i) =>
    new Date(start + (i + 1) * hour).toISOString().replace(/\D/g, '').slice(0, 10).concat('0000'),
  );
}

// The rename for each stale file: whole hours after the base's newest and after every file the PR adds, so the
// suggestions collide neither with main nor with each other nor with the PR's other migrations.
export function suggestRenames(newest, addedPaths, stale) {
  const after = [newest, ...addedPaths.map(versionOf).filter(Boolean)].sort().at(-1) ?? '';
  const versions = nextVersions(after, stale.length);
  return stale.map((path, i) => ({ from: path, to: `${DIR}${versions[i]}${path.slice(DIR.length + 14)}` }));
}

export function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).split('\n').filter(Boolean);
}

export function migrationPaths(ref) {
  return git(['ls-tree', '--name-only', ref, DIR]);
}

// Files under supabase/migrations that `head` adds since `since`. --no-renames: a renamed file shows as deleted
// plus added, so it is checked under its new name.
export function addedMigrations(since, head) {
  return git(['diff', '--name-only', '--no-renames', '--diff-filter=A', since, head, '--', DIR]);
}

function main() {
  const [base, sinceArg] = process.argv.slice(2);
  if (!base) throw new Error('usage: node tools/ci/migration-order.mjs <base-ref> [since-ref]');
  const since = sinceArg ?? git(['merge-base', base, 'HEAD'])[0];
  const addedPaths = addedMigrations(since, 'HEAD');
  const { newest, stale } = findStale(migrationPaths(base), addedPaths);
  if (stale.length === 0) {
    console.log(`migration order OK: ${addedPaths.length} new file(s), base newest ${newest || 'none'}`);
    return;
  }
  for (const { from, to } of suggestRenames(newest, addedPaths, stale)) {
    console.error(`::error file=${from}::${from} is not newer than the base's newest migration ${newest}; rename it to ${to} (git mv) and push.`);
  }
  process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
