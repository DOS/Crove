import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { defaultFiles, findRawColors, parseTailwindTheme, readTailwindTheme } from '../ui-colors.mjs';

type Found = { line: number; match: string; what: string };
const matches = (text: string, css = false) => findRawColors(text, { css }).map((f: Found) => f.match);

describe('design-token lint (ui-colors)', () => {
  it('flags Tailwind palette colors with any variant or opacity', () => {
    expect(matches('<p className="text-rose-300 hover:bg-emerald-500/10 border-zinc-800/80 dark:ring-violet-950">')).toEqual([
      'text-rose-300',
      'bg-emerald-500',
      'border-zinc-800',
      'ring-violet-950',
    ]);
    expect(matches("cn('bg-white', 'stroke-black', '!text-amber-400')")).toEqual(['bg-white', 'stroke-black', 'text-amber-400']);
    expect(matches('bg-mauve-500 text-olive-300 border-mist-200 fill-taupe-900 text-shadow-rose-500')).toEqual([
      'bg-mauve-500',
      'text-olive-300',
      'border-mist-200',
      'fill-taupe-900',
      'text-shadow-rose-500',
    ]);
    expect(matches('bg-[var(--color-rose-500)] text-[var(--color-white)]')).toEqual(['--color-rose-500', '--color-white']);
  });

  it('reads the palettes from the installed Tailwind theme', () => {
    const theme = readTailwindTheme();
    // Every palette Tailwind 4 shipped when the lint was written, so a parsing slip cannot silently drop one.
    for (const name of 'red orange amber yellow lime green emerald teal cyan sky blue indigo violet purple fuchsia pink rose slate gray zinc neutral stone mauve olive mist taupe'.split(' ')) {
      expect(theme.palettes, name).toContain(name);
    }
    expect(theme.singles).toEqual(expect.arrayContaining(['black', 'white']));
    expect(theme.shades).toEqual(expect.arrayContaining(['50', '500', '950']));
  });

  it('reads hyphenated palette names', () => {
    expect(parseTailwindTheme('  --color-light-blue-500: oklch(1 0 0);').palettes).toEqual(['light-blue']);
  });

  it('picks up a palette that a new Tailwind theme adds', () => {
    const theme = parseTailwindTheme('@theme default {\n  --color-plum-50: oklch(1 0 0);\n  --color-plum-975: oklch(0.1 0 0);\n  --color-ink: #000;\n  --spacing: 0.25rem;\n}');
    expect(theme).toEqual({ palettes: ['plum'], singles: ['ink'], shades: ['50', '975'] });
    expect(findRawColors('text-plum-975 bg-ink bg-plum-500', { theme }).map((f: Found) => f.match)).toEqual(['text-plum-975', 'bg-ink']);
  });

  it('flags literal colors in classes, styles and attributes', () => {
    expect(matches('<rect fill="#612BD3" className="bg-[#fff]" />')).toEqual(['#612BD3', '#fff']);
    expect(matches("bg-[radial-gradient(ellipse_at_top,rgba(124,58,237,0.18),transparent)] style={{ color: 'oklch(0.5 0.2 293)' }}")).toEqual([
      'rgba(',
      'oklch(',
    ]);
  });

  it('flags CSS color names in arbitrary values', () => {
    expect(matches('<div className="bg-[red] shadow-[0_0_0_1px_white] hover:[color:Navy] border-[rebeccapurple]/50" />')).toEqual([
      'red',
      'white',
      'Navy',
      'rebeccapurple',
    ]);
  });

  it('flags CSS color names in color attributes', () => {
    expect(matches('<path fill="white" stroke={"red"} /><stop stopColor="gold" /><font color=\'teal\'>')).toEqual(['white', 'red', 'gold', 'teal']);
  });

  it('flags CSS color names in style objects', () => {
    expect(matches("<p style={{ color: 'red', borderColor: \"white\", border: '1px solid tomato', 'background-color': 'navy' }} />")).toEqual([
      'red',
      'white',
      'tomato',
      'navy',
    ]);
  });

  it('allows none, currentColor, transparent, inherit and system colors', () => {
    const ok = [
      '<svg fill="none" stroke="currentColor" color="inherit" />',
      "<p style={{ color: 'currentColor', background: 'transparent', borderColor: 'inherit' }} />",
      '<option className="bg-[Canvas] text-[CanvasText] bg-[transparent] text-[currentColor]" />',
      '<div className="data-[tone=red]:bg-primary group-data-[variant=white]/x:text-link bg-[--my-red] bg-[url(red.png)]" />',
      '<div className="has-[[data-tone=red]]:bg-primary group-has-[[data-tone=red]]/card:text-link [&_[data-x=red]]:p-1" />',
      '<div className="bg-[var(--brand_red)]" /><rect fill="url(#gold)" />',
      "const variant = { fill: 'primary', color: 'success' }; const [red] = values;",
    ];
    for (const text of ok) expect(matches(text), text).toEqual([]);
  });

  it('reads stylesheets: declarations, @apply and arbitrary values', () => {
    expect(matches('a { color: red; }\n.x { border: 1px solid White }\n.y { @apply bg-zinc-500 text-[gold]; }', true)).toEqual([
      'red',
      'White',
      'bg-zinc-500',
      'gold',
    ]);
    const ok = "@import '@crove/ui/globals.css';\n/* red */\nhtml, body, #root { height: 100%; }\na:hover { color: currentColor; background: transparent; outline: none; }";
    expect(matches(ok, true)).toEqual([]);
  });

  it('scans the app stylesheets by default', () => {
    expect(defaultFiles()).toContain('apps/app/src/styles.css');
  });

  it('accepts theme tokens and ignores comments', () => {
    const ok = [
      '<p className="bg-primary/15 text-muted-foreground border-destructive/30 text-subtle-foreground fill-brand">',
      'bg-[radial-gradient(ellipse_at_top,color-mix(in_oklch,var(--primary)_18%,transparent),transparent_60%)]',
      '// Owner only (#113): fresh MFA, see #89',
      '/* issue #139, bg-rose-500 in a comment, fill="white" */',
      'text-red-ish bg-blue-gray text-roses-300',
      '<span>&#123; #12345 #1234567</span>',
    ];
    for (const text of ok) expect(matches(text), text).toEqual([]);
  });

  it('does not treat the // in a URL as a comment', () => {
    expect(matches("const url = 'https://example.test/path'; const c = 'text-rose-300';")).toEqual(['text-rose-300']);
  });

  it('reports line numbers', () => {
    expect(findRawColors('const a = 1;\n// #fff\n<b className="text-zinc-500" />')).toEqual([{ line: 3, match: 'text-zinc-500', what: 'Tailwind palette color' }]);
    expect(findRawColors('a {\n  color: red;\n}', { css: true })).toEqual([{ line: 2, match: 'red', what: 'CSS color name' }]);
  });

  it('passes on the current app and design system sources', () => {
    expect(() => execFileSync(process.execPath, ['tools/ui-colors.mjs'], { stdio: 'pipe' })).not.toThrow();
  });
});
