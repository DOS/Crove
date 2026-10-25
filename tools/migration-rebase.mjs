// Assigns a branch's new migrations their final versions right before it merges (issue #1492). The runner applies
// migrations in version order, so a new file must be newer than every file on main (tools/ci/migration-order.mjs).
// Versions are therefore not reserved ahead: a branch writes its migration under any version above main's newest when
// it starts, and right before merging the lead merges origin/main and runs
//
//   pnpm migration:rebase [base-ref] [--no-fetch]   (default origin/main, fetched first unless --no-fetch)
//
// When any migration the branch adds is not newer than the base's newest, every one of them is renamed, in its order,
// to consecutive whole hours after the base's newest (renaming only the stale ones could reorder the branch's own
// files). In the files the branch changed (comments, docs and tests that name the file; nothing else can name a file
// main has never had; binary files are skipped), each renamed file's full name is replaced, and so is its bare version
// unless a file on the base holds the same version: then a bare mention may mean main's file, so it is left alone and
// the run says so. The renames are staged, not committed.
// Tracked files must have no uncommitted changes; untracked files are left alone.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { findStale, nextVersions, versionOf } from './ci/migration-order.mjs';

const DIR = 'supabase/migrations/';

// Pure: the renames for `added` (the branch's new migration paths) given the base's migration paths. None when every
// added file is already newer than the base's newest; otherwise all of them, in version order, to consecutive whole
// hours after it.
export function planRenames(basePaths, addedPaths) {
  const added = addedPaths.filter((path) => versionOf(path) !== undefined).sort();
  const { newest, stale } = findStale(basePaths, added);
  if (stale.length === 0) return [];
  const versions = nextVersions(newest, added.length);
  return added
    .map((from, i) => ({ from, to: `${DIR}${versions[i]}${from.slice(DIR.length + 14)}` }))
    .filter(({ from, to }) => from !== to);
}

// Pure: `text` with each renamed file's old name (version and suffix, with or without .sql) replaced by its new one, and
// its bare old version by the new version unless `taken` (the base's versions) holds it, all in one pass (a new version
// may be another file's old one, so replacing one rename after another could rename a file twice).
export function rewriteReferences(text, renames, taken = []) {
  if (renames.length === 0) return text;
  const stem = (path) => path.slice(path.lastIndexOf('/') + 1).replace(/\.sql$/, '');
  const names = new Map(renames.map(({ from, to }) => [stem(from), stem(to)]));
  const busy = new Set(taken);
  const bare = new Map(renames.filter(({ from }) => !busy.has(versionOf(from))).map(({ from, to }) => [versionOf(from), versionOf(to)]));
  const alternatives = [`(${[...names.keys()].join('|')})(?![A-Za-z0-9_])`];
  if (bare.size > 0) alternatives.push(`(${[...bare.keys()].join('|')})(?!\\d)`);
  return text.replace(new RegExp(`(?<!\\d)(?:${alternatives.join('|')})`, 'g'), (match, name) => (name ? names.get(name) : bare.get(match)) ?? match);
}

// `cwd`: the repository (default the current directory).
export function rebaseMigrations({ base = 'origin/main', fetch = true, log = console.log, cwd = process.cwd() } = {}) {
  const git = (args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).split('\n').filter(Boolean);
  if (git(['status', '--porcelain', '--untracked-files=no']).length > 0) throw new Error('the working tree has changes; commit or set them aside first');
  if (fetch && base.startsWith('origin/')) git(['fetch', '--quiet', 'origin', base.slice('origin/'.length)]);
  const mergeBase = git(['merge-base', base, 'HEAD'])[0];
  const added = git(['diff', '--name-only', '--no-renames', '--diff-filter=A', mergeBase, 'HEAD', '--', DIR]);
  const basePaths = git(['ls-tree', '--name-only', base, DIR]);
  const renames = planRenames(basePaths, added);
  if (renames.length === 0) {
    log(`migration:rebase: nothing to rename (${added.length} new file(s), all newer than ${base})`);
    return renames;
  }
  // Every file the branch changed, the migrations included, under its name after the renames.
  const renamedTo = new Map(renames.map(({ from, to }) => [from, to]));
  const changed = git(['diff', '--name-only', '--diff-filter=AMR', mergeBase, 'HEAD']).map((path) => renamedTo.get(path) ?? path);
  const taken = basePaths.map(versionOf).filter((version) => version !== undefined);
  for (const { from, to } of renames) {
    git(['mv', from, to]);
    log(`migration:rebase: ${from} -> ${to}`);
    const twin = basePaths.find((path) => versionOf(path) === versionOf(from));
    if (twin) log(`migration:rebase: ${versionOf(from)} is also ${twin} on ${base}: only full file names were updated; check bare mentions of ${versionOf(from)} by hand`);
  }
  for (const path of changed) {
    const bytes = readFileSync(join(cwd, path));
    // A binary file (a PDF or image fixture) is never rewritten as text.
    if (bytes.includes(0)) continue;
    const before = bytes.toString('utf8');
    const after = rewriteReferences(before, renames, taken);
    if (after !== before) {
      writeFileSync(join(cwd, path), after);
      git(['add', path]);
      log(`migration:rebase: updated references in ${path}`);
    }
  }
  log('migration:rebase: staged; commit, push and wait for green before merging');
  return renames;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const args = process.argv.slice(2);
    rebaseMigrations({ base: args.find((arg) => arg !== '--no-fetch') ?? 'origin/main', fetch: !args.includes('--no-fetch') });
  } catch (error) {
    console.error(`migration:rebase: ${error.message}`);
    process.exitCode = 1;
  }
}
