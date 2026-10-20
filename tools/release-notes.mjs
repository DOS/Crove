// Release notes for the partner (#691; plan §7 rule 6: "an issue is done when it runs on the pilot instance and has a
// one-line Vietnamese release note for the partner"). Each PR may carry one line in its body:
//
//   Release note (vi): Xuất phiếu thu và phiếu chi sang MISA SME.
//
// (the PR template has it). This script lists the PRs squash-merged between two refs, reads their bodies and prints
// the notes as Markdown for the GitHub Release of the tag. A PR without a note, or with an empty one, is internal and
// is left out. No dependencies: run it with plain node.
//
//   node tools/release-notes.mjs <previous tag or empty> <tag>
//
// It reads each PR's body with `gh api` (GH_TOKEN and GITHUB_REPOSITORY in the environment).

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const NOTE_LINE = /^[ \t]*(?:[-*][ \t]+)?(?:\*\*|__)?release note \(vi\):?(?:\*\*|__)?:?[ \t]*(.*)$/im;
// Template filler and explicit "nothing for the partner" answers.
const EMPTY = new Set(['', '-', 'none', 'n/a', 'na', 'không', 'khong', 'không có', 'khong co']);
const MAX_LENGTH = 300;

/**
 * The PR's release note, or null when it has none (or an empty one).
 * @param {string | null | undefined} body
 * @returns {string | null}
 */
export function noteOf(body) {
  if (!body) return null;
  const text = body.replace(/<!--[\s\S]*?-->/g, '');
  const match = NOTE_LINE.exec(text);
  if (!match) return null;
  const note = match[1].trim().replace(/\s+/g, ' ');
  if (EMPTY.has(note.toLowerCase().replace(/[.]$/, ''))) return null;
  return note.length > MAX_LENGTH ? `${note.slice(0, MAX_LENGTH - 1)}…` : note;
}

/**
 * PR numbers from squash-merge subjects ("feat(x): ... (#123)"), oldest first, each once.
 * @param {string[]} subjects git log subjects, newest first (git's order)
 * @returns {number[]}
 */
export function prNumbers(subjects) {
  const seen = new Set();
  const out = [];
  for (const subject of [...subjects].reverse()) {
    const match = /\(#(\d+)\)\s*$/.exec(subject);
    if (!match) continue;
    const n = Number(match[1]);
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

/**
 * @param {{ tag: string, notes: { pr: number, note: string }[] }} release
 * @returns {string}
 */
export function render({ tag, notes }) {
  const lines = [`## Có gì mới trong ${tag}`, ''];
  if (notes.length === 0) {
    lines.push('Bản này không có thay đổi nào bạn cần biết.');
  } else {
    for (const { pr, note } of notes) lines.push(`- ${note} (#${pr})`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * @param {{ tag: string, subjects: string[], body: (pr: number) => string | null }} input
 * @returns {string}
 */
export function releaseNotes({ tag, subjects, body }) {
  const notes = [];
  for (const pr of prNumbers(subjects)) {
    const note = noteOf(body(pr));
    if (note) notes.push({ pr, note });
  }
  return render({ tag, notes });
}

function main(argv) {
  const [previous = '', tag = ''] = argv;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(tag) || (previous && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(previous))) {
    throw new Error('usage: node tools/release-notes.mjs <previous tag or empty> <tag>');
  }
  const repo = process.env.GITHUB_REPOSITORY ?? '';
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error('GITHUB_REPOSITORY must be owner/name');
  const range = previous ? `${previous}..${tag}` : tag;
  const log = execFileSync('git', ['log', '--first-parent', '--format=%s', range], { encoding: 'utf8' });
  const subjects = log.split('\n').filter(Boolean);
  const body = (pr) => {
    try {
      return execFileSync('gh', ['api', `repos/${repo}/pulls/${pr}`, '--jq', '.body // ""'], { encoding: 'utf8' });
    } catch {
      return null; // not a PR of this repo (a number quoted in a subject); nothing to publish
    }
  };
  process.stdout.write(releaseNotes({ tag, subjects, body }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
