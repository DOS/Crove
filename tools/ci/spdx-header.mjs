// SPDX-License-Identifier: AGPL-3.0-only
// The license header check for new source files (kernel plan §10, the `license` row; #1953). Ludy is AGPL-3.0-only (the
// README and every package.json say so; ADR-0022, to be written, will record it with the CLA): every source file a pull
// request adds names that license in an SPDX line near its top, so a file copied out of the repository keeps it. Only
// files added from now on are checked; files already on main carry none and are left as they are.
//
// Usage: node tools/ci/spdx-header.mjs [since-ref]
//   Checks the source files HEAD adds since <since-ref> (default: the merge base of origin/main and HEAD). CI passes
//   the merge commit's first parent. A renamed or moved file is not new. Exits 1 and names each file without the line,
//   with the line to add for its kind.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const IDENTIFIER = 'AGPL-3.0-only';

// Source files by extension, and the comment the SPDX line is written in.
const COMMENT = { ts: '//', tsx: '//', mts: '//', cts: '//', js: '//', jsx: '//', mjs: '//', cjs: '//', sql: '--' };

// Files under another license, which keep their own: the pg-boss schema (MIT), written by `pnpm db:vendor:pgboss` from
// pg-boss, and the vendored pgTAP (PostgreSQL License).
const THIRD_PARTY = [/^supabase\/migrations\/\d{14}_crove_jobs_pgboss_v\d+\.sql$/, /^packages\/db\/test\/invariant\/pgtap\/pgtap\.sql$/];

// How many lines from the top the SPDX line may sit on (a shebang may come first).
const HEADER_LINES = 5;

// The comment marker of a source path, or null for any other file.
export function commentOf(path) {
  const ext = /\.([a-z]+)$/.exec(path)?.[1];
  return ext && Object.hasOwn(COMMENT, ext) ? COMMENT[ext] : null;
}

// The SPDX line a source path needs.
export function headerFor(path) {
  return `${commentOf(path)} SPDX-License-Identifier: ${IDENTIFIER}`;
}

// Whether a source file's text carries the SPDX line for Ludy's license in its first lines.
export function hasHeader(text) {
  const pattern = new RegExp(`^\\s*(?://|--|/\\*|\\*)\\s*SPDX-License-Identifier:\\s*${IDENTIFIER.replace(/[.-]/g, '\\$&')}\\s*(?:\\*/)?\\s*$`);
  return text.split('\n', HEADER_LINES).some((line) => pattern.test(line.replace(/\r$/, '')));
}

// The paths among `added` that the check reads: source files that are not third-party.
export function checkedPaths(added) {
  return added.filter((path) => commentOf(path) !== null && !THIRD_PARTY.some((re) => re.test(path)));
}

// Pure check: the checked paths whose text (from `read`) lacks the line.
export function missingHeaders(added, read) {
  return checkedPaths(added).filter((path) => !hasHeader(read(path)));
}

// Files HEAD adds since `since`. Renames are found, so a moved file shows as renamed, not added. NUL-separated (-z), so a
// path with spaces or non-ASCII characters comes back as it is, never quoted.
export function addedFiles(since) {
  const out = execFileSync('git', ['diff', '-z', '--name-only', '--find-renames', '--diff-filter=A', since, 'HEAD'], { encoding: 'utf8' });
  return out.split('\0').filter(Boolean);
}

// A file's text, or '' when it cannot be read as one (a symbolic link to a directory, say), so it is reported.
function readText(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

function main() {
  const since = process.argv[2] ?? execFileSync('git', ['merge-base', 'origin/main', 'HEAD'], { encoding: 'utf8' }).trim();
  const added = addedFiles(since);
  const missing = missingHeaders(added, readText);
  if (missing.length === 0) {
    console.log(`spdx header OK: ${checkedPaths(added).length} new source file(s) checked`);
    return;
  }
  for (const path of missing) {
    console.error(`::error file=${path},line=1::${path} is a new source file without its license line; add \`${headerFor(path)}\` as its first line (after a shebang).`);
  }
  process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
