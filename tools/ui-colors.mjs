// Design-token lint for the web app (plan §9, `web` rule): screens and components use the @crove/ui theme tokens
// (`bg-primary`, `text-muted-foreground`, `border-destructive/30`, ...), never Tailwind palette colors
// (`text-rose-300`, `bg-white`), literal colors (`#7c3aed`, `rgba(...)`, `oklch(...)`) or CSS color names
// (`bg-[red]`, `fill="white"`, `style={{ color: 'red' }}`). Colors live only in packages/ui/src/styles/globals.css.
// The palette names come from the installed Tailwind's theme.css, so a Tailwind release that adds a palette is
// covered without editing this file. No dependencies; run by `pnpm lint`.
// Usage: node tools/ui-colors.mjs [files...]   (default: every .ts/.tsx file under SCAN_DIRS and .css under CSS_DIRS)
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
export const SCAN_DIRS = ['apps/app/src', 'packages/ui/src'];
// Stylesheets of the app; packages/ui/src/styles is where the tokens are defined, so it is not scanned.
export const CSS_DIRS = ['apps/app/src'];
// UI copy, not class names.
const SKIP_DIRS = ['apps/app/src/i18n/messages'];

/**
 * Reads the color names of a Tailwind theme.css: `palettes` are the names with shades (`--color-rose-500`),
 * `singles` the ones without (`--color-white`).
 */
export function parseTailwindTheme(css) {
  const palettes = new Set();
  const singles = new Set();
  const shades = new Set();
  for (const m of css.matchAll(/^\s*--color-([a-z]+(?:-[a-z]+)*)(?:-(\d+))?\s*:/gm)) {
    if (m[2]) {
      palettes.add(m[1]);
      shades.add(m[2]);
    } else {
      singles.add(m[1]);
    }
  }
  return { palettes: [...palettes], singles: [...singles], shades: [...shades] };
}

/** The installed Tailwind's theme (the version @crove/ui builds with). */
export function readTailwindTheme() {
  const require = createRequire(join(ROOT, 'packages/ui/package.json'));
  const path = require.resolve('tailwindcss/theme.css');
  const theme = parseTailwindTheme(readFileSync(path, 'utf8'));
  if (!theme.palettes.length || !theme.singles.length || !theme.shades.length) {
    throw new Error(`ui-colors: no --color-* palette found in ${path}; the Tailwind theme format changed`);
  }
  return theme;
}

// CSS named colors (CSS Color 4) other than `transparent`. `none`, `currentColor`, `inherit` and `transparent` are
// allowed. System colors (`Canvas`, `CanvasText`) follow the color scheme and are allowed too: the native select
// options use them.
const NAMED = new Set(
  (
    'aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood ' +
    'cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray ' +
    'darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen ' +
    'darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue ' +
    'firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew ' +
    'hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan ' +
    'lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray ' +
    'lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue ' +
    'mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred ' +
    'midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid ' +
    'palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple ' +
    'rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue ' +
    'slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white ' +
    'whitesmoke yellow yellowgreen'
  ).split(' '),
);

// A CSS identifier on its own (not part of `--my-red`, `red-ish`, `red.png` or `#red`).
const IDENT = /(?<![\w#-])[A-Za-z][\w-]*(?![\w.-])/g;
// One bracketed Tailwind segment, which may hold one level of nested brackets (`has-[[data-tone=red]]:`).
const SEGMENT = String.raw`((?:[^\[\]\s'"\`]|\[[^\[\]\s'"\`]*\])+)`;
// Places where a color value is written; the first two are Tailwind arbitrary values (where `_` is a space).
const TAILWIND_SPOTS = 2;
const VALUE_SPOTS = [
  // Tailwind arbitrary values (`bg-[red]`, `shadow-[0_0_0_1px_red]`), not arbitrary variants (`data-[tone=red]:`,
  // `group-data-[tone=red]/card:`).
  new RegExp(String.raw`-\[${SEGMENT}\](?!(?:\/[\w-]+)?:)`, 'g'),
  // Tailwind arbitrary properties (`[color:red]`, `hover:[background:white]`).
  new RegExp(String.raw`(?<![\w\])-])\[([a-z-]+:${SEGMENT.slice(1)}\](?!(?:\/[\w-]+)?:)`, 'g'),
  // Color attributes in JSX and SVG (`fill="white"`, `stroke={'red'}`, `stopColor="gold"`).
  /(?<![\w-])(?:fill|stroke|color|stopColor|stop-color|floodColor|flood-color|lightingColor|lighting-color|bgcolor)\s*=\s*\{?\s*(['"`])([^'"`\n]*)\1/g,
  // Style objects (`style={{ color: 'red', borderColor: "white" }}`, `'background-color': 'red'`).
  /(?<![\w-])['"]?[A-Za-z-]*(?:[cC]olor|[bB]ackground|[fF]ill|[sS]troke|[sS]hadow|[bB]order|[oO]utline)[A-Za-z-]*['"]?\s*:\s*(['"`])([^'"`\n]*)\1/g,
];
// Declarations in stylesheets (`color: red;`, `border: 1px solid white }`).
const CSS_DECLARATION = /(?<![\w-])-{0,2}[a-z][a-z-]*\s*:\s*([^;{}]+)(?=[;}])/g;

function buildRules({ palettes, singles, shades }) {
  const palette = palettes.join('|');
  const single = singles.join('|');
  const shade = shades.join('|');
  const utility =
    'bg|text|text-shadow|border(?:-[xytrblse])?|ring(?:-offset)?|inset-ring|outline|divide|from|via|to|fill|stroke|shadow|inset-shadow|drop-shadow|decoration|accent|caret|placeholder';
  return [
    { re: new RegExp(`(?<![\\w-])(?:${utility})-(?:${palette})-(?:${shade})(?![\\w-])`, 'g'), what: 'Tailwind palette color' },
    { re: new RegExp(`(?<![\\w-])(?:${utility})-(?:${single})(?![\\w-])`, 'g'), what: 'Tailwind palette color' },
    // The palette as a variable (`bg-[var(--color-rose-500)]`, `color: var(--color-white)`).
    { re: new RegExp(`--color-(?:(?:${palette})-(?:${shade})|${single})(?![\\w-])`, 'g'), what: 'Tailwind palette color' },
    { re: /(?<!&)#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/g, what: 'literal color' },
    { re: /(?<![\w-])(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/g, what: 'literal color' },
  ];
}

let rules;

// Comments are blanked (keeping line breaks) so that issue references such as "(#113)" do not count as hex colors.
function stripComments(text) {
  const blank = (m) => m.replace(/[^\n]/g, ' ');
  return text.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (m, lead) => lead + blank(m.slice(lead.length)));
}

function namedColors(code, spot, tailwind, found) {
  for (const m of code.matchAll(spot)) {
    const value = m[m.length - 1];
    const start = m.index + m[0].lastIndexOf(value);
    // Tailwind writes spaces as `_` in arbitrary values (`shadow-[0_0_0_1px_red]`), but not in a variable name
    // (`var(--brand_red)`); same length, so offsets hold.
    const spaced = tailwind ? value.replace(/(--[\w-]+)|_/g, (m, name) => name ?? ' ') : value;
    for (const id of spaced.matchAll(IDENT)) {
      if (NAMED.has(id[0].toLowerCase())) found.push({ at: start + id.index, match: id[0], what: 'CSS color name' });
    }
  }
}

/**
 * Returns `{ line, match, what }` for each raw color in a source text. `css: true` reads it as a stylesheet
 * (declarations) instead of TypeScript (attributes and style objects). `theme` (from `parseTailwindTheme`)
 * replaces the installed Tailwind theme.
 * @param {string} text
 * @param {{ css?: boolean, theme?: ReturnType<typeof parseTailwindTheme> }} [options]
 */
export function findRawColors(text, { css = false, theme } = {}) {
  const active = theme ? buildRules(theme) : (rules ??= buildRules(readTailwindTheme()));
  const code = stripComments(text);
  const found = [];
  for (const { re, what } of active) {
    for (const m of code.matchAll(re)) found.push({ at: m.index, match: m[0], what });
  }
  const spots = css ? [...VALUE_SPOTS.slice(0, TAILWIND_SPOTS), CSS_DECLARATION] : VALUE_SPOTS;
  spots.forEach((spot, i) => namedColors(code, spot, i < TAILWIND_SPOTS, found));
  return found
    .sort((a, b) => a.at - b.at)
    .filter((f, i, all) => i === 0 || f.at !== all[i - 1].at)
    .map(({ at, match, what }) => ({ line: code.slice(0, at).split('\n').length, match, what }));
}

function listSources(root, dir, pattern) {
  const out = [];
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && !SKIP_DIRS.includes(path)) out.push(...listSources(root, path, pattern));
    } else if (pattern.test(entry.name)) {
      out.push(path);
    }
  }
  return out;
}

/** Every file the lint reads by default, relative to the repo root. */
export function defaultFiles(root = ROOT) {
  return [...SCAN_DIRS.flatMap((d) => listSources(root, d, /\.tsx?$/)), ...CSS_DIRS.flatMap((d) => listSources(root, d, /\.css$/))];
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  const files = args.length ? args.map((f) => relative(ROOT, f).replaceAll('\\', '/')) : defaultFiles();
  const failures = files.flatMap((file) =>
    findRawColors(readFileSync(join(ROOT, file), 'utf8'), { css: file.endsWith('.css') }).map(
      (f) => `${file}:${f.line}: ${f.what} "${f.match}"; use a theme token from @crove/ui`,
    ),
  );
  if (failures.length) {
    console.error(failures.join('\n'));
    console.error(`\nui-colors: ${failures.length} raw color(s). Add or reuse a token in packages/ui/src/styles/globals.css.`);
    process.exit(1);
  }
  console.log(`ui-colors: ${files.length} files, no raw colors`);
}
