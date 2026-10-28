// Fast docs check: replaces agent review for docs-only PRs. No dependencies.
// Usage: node tools/docs-check.mjs [--changed [base]] [files...]
//   default            check every tracked *.md and docs/**/*.html file
//   --changed [base]   check only files changed vs base (default origin/main) plus staged/unstaged
//   files...           check exactly these files
// Checks: (a) no em/en dashes, (b) HTML tags balanced + dark color-scheme meta,
// (c) relative links resolve, (d) no crude pronouns in Vietnamese HTML.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

// The buffer reaches past Node's default 1 MiB, which `git ls-files` outgrows near 15k paths (#1640).
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 });
const root = git('rev-parse', '--show-toplevel').trim();
const lines = (out) => out.split('\n').map((s) => s.trim()).filter(Boolean);

const isDoc = (f) => /\.md$/i.test(f) || (/^docs\/.*\.html?$/i.test(f));
const isHtml = (f) => /\.html?$/i.test(f);

function listFiles(argv) {
  const ci = argv.indexOf('--changed');
  if (ci !== -1) {
    const base = argv[ci + 1] && !argv[ci + 1].startsWith('-') ? argv[ci + 1] : 'origin/main';
    const set = new Set();
    try {
      for (const f of lines(git('diff', '--name-only', '--diff-filter=d', `${base}...HEAD`))) set.add(f);
    } catch {
      // base unavailable: fall back to checking everything below
      return lines(git('ls-files'));
    }
    for (const f of lines(git('diff', '--name-only', '--diff-filter=d', 'HEAD'))) set.add(f);
    return [...set];
  }
  const explicit = argv.filter((a) => !a.startsWith('-'));
  if (explicit.length) return explicit;
  return lines(git('ls-files'));
}

const failures = [];
const fail = (file, line, msg) => failures.push(`${file}:${line}: ${msg}`);
const lineOf = (text, idx) => text.slice(0, idx).split('\n').length;

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
// Raw-text elements: contents are not markup.
const RAW = new Set(['script', 'style', 'pre-never']);

function checkDashes(file, text) {
  const re = /—|–|&mdash;|&ndash;|&#8212;|&#8211;|&#x2014;|&#x2013;/gi;
  let m;
  while ((m = re.exec(text))) fail(file, lineOf(text, m.index), `dash character "${m[0]}" (use a hyphen)`);
}

function checkHtml(file, text) {
  if (!/<meta[^>]+name=["']color-scheme["'][^>]*content=["'][^"']*dark/i.test(text)
    && !/<meta[^>]+content=["'][^"']*dark[^"']*["'][^>]*name=["']color-scheme["']/i.test(text)) {
    fail(file, 1, 'missing <meta name="color-scheme" content="dark ...">');
  }
  const stack = [];
  const re = /<!--[\s\S]*?-->|<!doctype[^>]*>|<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/gi;
  let m;
  while ((m = re.exec(text))) {
    if (!m[2]) continue;
    const closing = m[1] === '/';
    const name = m[2].toLowerCase();
    const selfClosed = m[3].trimEnd().endsWith('/');
    const line = lineOf(text, m.index);
    if (!closing) {
      if (VOID.has(name) || selfClosed) continue;
      stack.push({ name, line });
      if (RAW.has(name)) {
        const end = text.toLowerCase().indexOf(`</${name}`, re.lastIndex);
        if (end !== -1) re.lastIndex = end;
      }
    } else {
      if (VOID.has(name)) continue;
      const top = stack.pop();
      if (!top) fail(file, line, `unexpected closing </${name}>`);
      else if (top.name !== name) {
        fail(file, line, `closing </${name}> does not match <${top.name}> opened at line ${top.line}`);
        // resync: drop to the matching opener if present
        const i = stack.map((s) => s.name).lastIndexOf(name);
        if (i !== -1) stack.length = i;
      }
    }
  }
  for (const s of stack) fail(file, s.line, `unclosed <${s.name}>`);

  if (/<html[^>]+lang=["']vi/i.test(text)) {
    const visible = text.replace(/<(script|style)[\s\S]*?<\/\1>/gi, (s) => s.replace(/[^\n]/g, ' '));
    const re2 = /(?<![\p{L}\p{N}_])(mày|tao)(?![\p{L}\p{N}_])/giu;
    while ((m = re2.exec(visible))) fail(file, lineOf(text, m.index), `crude pronoun "${m[0]}" in Vietnamese doc`);
  }
}

function checkLinks(file, text) {
  const targets = [];
  if (/\.md$/i.test(file)) {
    // Mask fenced and inline code so example links are ignored.
    const masked = text.replace(/```[\s\S]*?```|`[^`\n]*`/g, (s) => s.replace(/[^\n]/g, ' '));
    for (const m of masked.matchAll(/!?\[[^\]\n]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) targets.push([m[1], m.index]);
    for (const m of masked.matchAll(/<a\s[^>]*href=["']([^"']+)["']/gi)) targets.push([m[1], m.index]);
  } else {
    for (const m of text.matchAll(/\b(?:href|src)=["']([^"']+)["']/gi)) targets.push([m[1], m.index]);
  }
  for (const [raw, idx] of targets) {
    if (/^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(raw)) continue; // external, mailto:, anchors
    const path = decodeURIComponent(raw.split('#')[0].split('?')[0]);
    if (!path) continue;
    const abs = path.startsWith('/') ? join(root, path) : resolve(root, dirname(file), path);
    if (!existsSync(abs)) fail(file, lineOf(text, idx), `broken relative link "${raw}"`);
  }
}

const started = performance.now();
const files = listFiles(process.argv.slice(2)).filter((f) => isDoc(f) && existsSync(join(root, f)));
for (const file of files) {
  const text = readFileSync(join(root, file), 'utf8');
  checkDashes(file, text);
  checkLinks(file, text);
  if (isHtml(file)) checkHtml(file, text);
}

const ms = Math.round(performance.now() - started);
if (failures.length) {
  console.error(failures.join('\n'));
  console.error(`\ndocs-check: ${failures.length} problem(s) in ${files.length} file(s) (${ms} ms)`);
  process.exit(1);
}
console.log(`docs-check: ${files.length} file(s) OK (${ms} ms)`);
