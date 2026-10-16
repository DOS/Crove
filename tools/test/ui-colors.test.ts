import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { findRawColors } from '../ui-colors.mjs';

const matches = (text: string) => findRawColors(text).map((f: { match: string }) => f.match);

describe('design-token lint (ui-colors)', () => {
  it('flags Tailwind palette colors with any variant or opacity', () => {
    expect(matches('<p className="text-rose-300 hover:bg-emerald-500/10 border-zinc-800/80 dark:ring-violet-950">')).toEqual([
      'text-rose-300',
      'bg-emerald-500',
      'border-zinc-800',
      'ring-violet-950',
    ]);
    expect(matches("cn('bg-white', 'stroke-black', '!text-amber-400')")).toEqual(['bg-white', 'stroke-black', 'text-amber-400']);
  });

  it('flags literal colors in classes, styles and attributes', () => {
    expect(matches('<rect fill="#612BD3" className="bg-[#fff]" />')).toEqual(['#612BD3', '#fff']);
    expect(matches("bg-[radial-gradient(ellipse_at_top,rgba(124,58,237,0.18),transparent)] style={{ color: 'oklch(0.5 0.2 293)' }}")).toEqual([
      'rgba(',
      'oklch(',
    ]);
  });

  it('accepts theme tokens and ignores comments', () => {
    const ok = [
      '<p className="bg-primary/15 text-muted-foreground border-destructive/30 text-subtle-foreground fill-brand">',
      'bg-[radial-gradient(ellipse_at_top,color-mix(in_oklch,var(--primary)_18%,transparent),transparent_60%)]',
      '// Owner only (#113): fresh MFA, see #89',
      '/* issue #139, bg-rose-500 in a comment */',
      'text-red-ish bg-blue-gray text-roses-300',
    ];
    for (const text of ok) expect(matches(text), text).toEqual([]);
  });

  it('does not treat the // in a URL as a comment', () => {
    expect(matches("const url = 'https://example.test/path'; const c = 'text-rose-300';")).toEqual(['text-rose-300']);
  });

  it('reports line numbers', () => {
    expect(findRawColors('const a = 1;\n// #fff\n<b className="text-zinc-500" />')).toEqual([{ line: 3, match: 'text-zinc-500', what: 'Tailwind palette color' }]);
  });

  it('passes on the current app and design system sources', () => {
    expect(() => execFileSync(process.execPath, ['tools/ui-colors.mjs'], { stdio: 'pipe' })).not.toThrow();
  });
});
