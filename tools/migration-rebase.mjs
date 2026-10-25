// Assigns a branch's new migrations their final versions right before it merges (issue #1492). The runner applies
// migrations in version order, so a new file must be newer than every file on main (tools/ci/migration-order.mjs).
// Versions are therefore not reserved ahead: a branch writes its migration under any version above main's newest when
// it starts, and right before merging the lead merges origin/main and runs
//
//   pnpm migration:rebase [base-ref]        (default origin/main, fetched first)
//
// When any migration the branch adds is not newer than the base's newest, every one of them is renamed, in its order,
// to consecutive whole hours after the base's newest (renaming only the stale ones could reorder the branch's own
// files). Each old version is replaced in the files the branch changed (comments, docs and tests that name the file;
// nothing else can name a file main has never had). The renames are staged, not committed. A clean tree is required.
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

// Pure: `text` with each renamed file's old version replaced by its new one, all in one pass (a new version may be
// another file's old one, so replacing one rename after another could rename a file twice).
export function rewriteReferences(text, renames) {
  if (renames.length === 0) return text;
  const map = new Map(renames.map(({ from, to }) => [versionOf(from), versionOf(to)]));
  return text.replace(new RegExp(`(?<!\\d)(${[...map.keys()].join('|')})(?!\\d)`, 'g'), (version) => map.get(version) ?? version);
}

// `cwd`: the repository (default the current directory).
export function rebaseMigrations({ base = 'origin/main', fetch = true, log = console.log, cwd = process.cwd() } = {}) {
  const git = (args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).split('\n').filter(Boolean);
  if (git(['status', '--porcelain']).length > 0) throw new Error('the working tree has changes; commit or set them aside first');
  if (fetch && base.startsWith('origin/')) git(['fetch', '--quiet', 'origin', base.slice('origin/'.length)]);
  const mergeBase = git(['merge-base', base, 'HEAD'])[0];
  const added = git(['diff', '--name-only', '--no-renames', '--diff-filter=A', mergeBase, 'HEAD', '--', DIR]);
  const renames = planRenames(git(['ls-tree', '--name-only', base, DIR]), added);
  if (renames.length === 0) {
    log(`migration:rebase: nothing to rename (${added.length} new file(s), all newer than ${base})`);
    return renames;
  }
  // Every file the branch changed, the migrations included, under its name after the renames.
  const renamedTo = new Map(renames.map(({ from, to }) => [from, to]));
  const changed = git(['diff', '--name-only', '--diff-filter=AMR', mergeBase, 'HEAD']).map((path) => renamedTo.get(path) ?? path);
  for (const { from, to } of renames) {
    git(['mv', from, to]);
    log(`migration:rebase: ${from} -> ${to}`);
  }
  for (const path of changed) {
    const before = readFileSync(join(cwd, path), 'utf8');
    const after = rewriteReferences(before, renames);
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
    rebaseMigrations({ base: process.argv[2] ?? 'origin/main' });
  } catch (error) {
    console.error(`migration:rebase: ${error.message}`);
    process.exitCode = 1;
  }
}
