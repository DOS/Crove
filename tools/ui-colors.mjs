// Design-token lint for the web app (plan §9, `web` rule): screens and components use the @crove/ui theme tokens
// (`bg-primary`, `text-muted-foreground`, `border-destructive/30`, ...), never Tailwind palette colors
// (`text-rose-300`, `bg-white`) or literal colors (`#7c3aed`, `rgba(...)`, `oklch(...)`). Colors live only in
// packages/ui/src/styles/globals.css. No dependencies; run by `pnpm lint`.
// Usage: node tools/ui-colors.mjs [files...]   (default: every .ts/.tsx file under SCAN_DIRS)
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SCAN_DIRS = ['apps/app/src', 'packages/ui/src'];
// UI copy, not class names.
const SKIP_DIRS = ['apps/app/src/i18n/messages'];

const PALETTE =
  'red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone';
const UTILITY =
  'bg|text|border(?:-[xytrblse])?|ring(?:-offset)?|inset-ring|outline|divide|from|via|to|fill|stroke|shadow|inset-shadow|drop-shadow|decoration|accent|caret|placeholder';
const RULES = [
  { re: new RegExp(`(?<![\\w-])(?:${UTILITY})-(?:${PALETTE})-(?:50|[1-9]00|950)(?![\\w-])`, 'g'), what: 'Tailwind palette color' },
  { re: new RegExp(`(?<![\\w-])(?:${UTILITY})-(?:white|black)(?![\\w-])`, 'g'), what: 'Tailwind palette color' },
  { re: /#[0-9a-fA-F]{3,8}(?![\w-])/g, what: 'literal color' },
  { re: /(?<![\w-])(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/g, what: 'literal color' },
];

// Comments are blanked (keeping line breaks) so that issue references such as "(#113)" do not count as hex colors.
function stripComments(text) {
  const blank = (m) => m.replace(/[^\n]/g, ' ');
  return text.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (m, lead) => lead + blank(m.slice(lead.length)));
}

/** Returns `{ line, match, what }` for each raw color in a source text. */
export function findRawColors(text) {
  const code = stripComments(text);
  const found = [];
  for (const { re, what } of RULES) {
    for (const m of code.matchAll(re)) {
      found.push({ at: m.index, line: code.slice(0, m.index).split('\n').length, match: m[0], what });
    }
  }
  return found.sort((a, b) => a.at - b.at).map(({ line, match, what }) => ({ line, match, what }));
}

function listSources(root, dir) {
  const out = [];
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && !SKIP_DIRS.includes(path)) out.push(...listSources(root, path));
    } else if (/\.tsx?$/.test(entry.name)) {
      out.push(path);
    }
  }
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const root = join(fileURLToPath(import.meta.url), '..', '..');
  const args = process.argv.slice(2);
  const files = args.length ? args.map((f) => relative(root, f).replaceAll('\\', '/')) : SCAN_DIRS.flatMap((d) => listSources(root, d));
  const failures = files.flatMap((file) =>
    findRawColors(readFileSync(join(root, file), 'utf8')).map((f) => `${file}:${f.line}: ${f.what} "${f.match}"; use a theme token from @crove/ui`),
  );
  if (failures.length) {
    console.error(failures.join('\n'));
    console.error(`\nui-colors: ${failures.length} raw color(s). Add or reuse a token in packages/ui/src/styles/globals.css.`);
    process.exit(1);
  }
  console.log(`ui-colors: ${files.length} files, no raw colors`);
}
