// Migration order check for pull requests (AGENTS.md: a new migration's version is greater than every file on main).
// The runner records each file under its 14-digit version, so a PR that adds a version equal to or older than the
// base's newest either collides with a file already on main or applies out of order on databases that are already
// migrated. Parallel PRs hit this often; re-running the check after main moves catches a PR that fell behind.
//
// Usage: node tools/ci/migration-order.mjs <base-ref> [since-ref]
//   Compares the migration files HEAD adds since <since-ref> (default: the merge base of <base-ref> and HEAD) with
//   the newest version on <base-ref>. CI passes the live base branch as <base-ref> and the merge commit's first
//   parent as <since-ref>. Exits 1 and names each offending file when one is not newer. Renames count as
//   additions, so renaming a file to a newer version is the fix.
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

// The next free version after `newest`: the current UTC time, or newest + 1 minute when the clock is behind.
export function nextVersion(newest, now = new Date()) {
  const stamp = now.toISOString().replace(/\D/g, '').slice(0, 14);
  if (stamp > newest) return stamp;
  const d = new Date(Date.UTC(+newest.slice(0, 4), +newest.slice(4, 6) - 1, +newest.slice(6, 8), +newest.slice(8, 10), +newest.slice(10, 12) + 1));
  return d.toISOString().replace(/\D/g, '').slice(0, 12) + '00';
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).split('\n').filter(Boolean);
}

function main() {
  const [base, sinceArg] = process.argv.slice(2);
  if (!base) throw new Error('usage: node tools/ci/migration-order.mjs <base-ref> [since-ref]');
  const since = sinceArg ?? git(['merge-base', base, 'HEAD'])[0];
  const basePaths = git(['ls-tree', '--name-only', base, DIR]);
  const addedPaths = git(['diff', '--name-only', '--no-renames', '--diff-filter=A', since, 'HEAD', '--', DIR]);
  const { newest, stale } = findStale(basePaths, addedPaths);
  if (stale.length === 0) {
    console.log(`migration order OK: ${addedPaths.length} new file(s), base newest ${newest || 'none'}`);
    return;
  }
  for (const path of stale) {
    console.error(`::error file=${path}::${path} is not newer than the base's newest migration ${newest}; rename it (for example to ${nextVersion(newest)}_...).`);
  }
  process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
