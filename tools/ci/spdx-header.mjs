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

// A file's committed text at HEAD (the blob, not the working tree, so a symbolic link is read as the link, never
// followed), or '' when git cannot show it, so it is reported.
function committedText(path) {
  try {
    return execFileSync('git', ['cat-file', '-p', `HEAD:${path}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return '';
  }
}

// GitHub workflow command escaping: a path is untrusted text, so a newline, '%', ':' or ',' in it cannot end the
// annotation or start another command.
export function escapeData(text) {
  return text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}
export function escapeProperty(text) {
  return escapeData(text).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

function main() {
  const since = process.argv[2] ?? execFileSync('git', ['merge-base', 'origin/main', 'HEAD'], { encoding: 'utf8' }).trim();
  const added = addedFiles(since);
  const missing = missingHeaders(added, committedText);
  if (missing.length === 0) {
    console.log(`spdx header OK: ${checkedPaths(added).length} new source file(s) checked`);
    return;
  }
  for (const path of missing) {
    const message = `${path} is a new source file without its license line; add \`${headerFor(path)}\` in its first ${HEADER_LINES} lines (after a shebang, if any), as a line comment or a /* */ comment.`;
    console.error(`::error file=${escapeProperty(path)},line=1::${escapeData(message)}`);
  }
  process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
