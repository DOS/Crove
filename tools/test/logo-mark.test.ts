// SPDX-License-Identifier: AGPL-3.0-only
// The Ludy mark (three tiles in an L and Vy's spark, #2052) is drawn in several places that cannot import one another:
// the app's `Logo`, the landing page's `LudyMark` and the SVG files under apps/web/public. This keeps their paths
// identical, keeps the light and dark colors where DESIGN.md puts them, and keeps the old Crove mark out of the sources.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

const BRAND = 'apps/web/public/brand';
// Both paths of the mark, from the reference file: the tiles, then the spark.
const [TILES, SPARK] = [...read(`${BRAND}/ludy-mark.svg`).matchAll(/<path fill="[^"]+" d="([^"]+)"\/>/g)].map((m) => m[1] ?? '');

// Every file that draws the whole mark.
const DRAWS_THE_MARK = [
  'apps/app/src/components/ui.tsx',
  'apps/web/src/components/landing/ui.tsx',
  `${BRAND}/ludy-mark.svg`,
  `${BRAND}/ludy-mark-dark.svg`,
  `${BRAND}/ludy-wordmark.svg`,
  `${BRAND}/ludy-wordmark-dark.svg`,
  'apps/web/public/favicon.svg',
  'apps/app/public/favicon.svg',
];

function sources(dir: string): string[] {
  return readdirSync(join(ROOT, dir)).flatMap((name) => {
    const path = `${dir}/${name}`;
    if (statSync(join(ROOT, path)).isDirectory()) return name === 'node_modules' ? [] : sources(path);
    return /\.(tsx?|css|svg|html|webmanifest)$/.test(name) ? [path] : [];
  });
}

describe('the Ludy logo (#2052)', () => {
  it('has the same tiles and spark in every file that draws it', () => {
    expect(TILES).toMatch(/^M0 11/);
    expect(SPARK).toMatch(/^M71 0/);
    for (const file of DRAWS_THE_MARK) {
      const text = read(file);
      expect(text, file).toContain(TILES);
      expect(text, file).toContain(SPARK);
    }
  });

  it('takes the tile and spark colors of DESIGN.md in the light and the dark files', () => {
    for (const [file, tile, spark] of [
      ['ludy-mark.svg', '#612BD3', '#14A88C'],
      ['ludy-wordmark.svg', '#612BD3', '#14A88C'],
      ['ludy-mark-dark.svg', '#7C4DEB', '#3FD0B0'],
      ['ludy-wordmark-dark.svg', '#7C4DEB', '#3FD0B0'],
    ] as const) {
      const text = read(`${BRAND}/${file}`);
      expect(text, file).toContain(`<path fill="${tile}" d="${TILES}"/>`);
      expect(text, file).toContain(`<path fill="${spark}" d="${SPARK}"/>`);
    }
  });

  it('letters "Ludy" the same in the light and the dark wordmark, in a box as high as the mark (#2059)', () => {
    const wordmark = (file: string) => {
      const text = read(`${BRAND}/${file}`);
      const paths = [...text.matchAll(/<path fill="[^"]+" d="([^"]+)"\/>/g)].map((m) => m[1] ?? '');
      return { lettering: paths[2] ?? '', box: /viewBox="(0 0 \d+ \d+)"/.exec(text)?.[1] };
    };
    const light = wordmark('ludy-wordmark.svg');
    const dark = wordmark('ludy-wordmark-dark.svg');
    expect(light.lettering).toMatch(/^M\d/);
    expect(dark).toEqual(light);
    expect(light.box).toMatch(/^0 0 \d+ 92$/);
    // The lettering stays inside the box. Every command of the path (M, L, Q) has absolute coordinate pairs, so the
    // numbers alternate x, y.
    const [, width] = /^0 0 (\d+) /.exec(light.box ?? '') ?? [];
    const numbers = (light.lettering.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
    expect(Math.max(...numbers.filter((_, i) => i % 2 === 0))).toBeLessThanOrEqual(Number(width));
    expect(Math.max(...numbers.filter((_, i) => i % 2 === 1))).toBeLessThanOrEqual(92);
    expect(Math.min(...numbers)).toBeGreaterThanOrEqual(0);
  });

  it('serves one Apple touch icon from the landing page and the app, a full white square with no alpha (#2059)', () => {
    const appIcon = readFileSync(join(ROOT, 'apps/app/public/assets/icon-maskable-512.png'));
    expect(appIcon.equals(readFileSync(join(ROOT, `${BRAND}/apple-touch-icon.png`)))).toBe(true);
    // PNG color type 2 is RGB: iOS fills the transparent corners of an icon with black.
    expect(appIcon[25]).toBe(2);
  });

  it('serves one favicon from the landing page and the app', () => {
    expect(read('apps/app/public/favicon.svg')).toBe(read('apps/web/public/favicon.svg'));
  });

  it('no longer draws the Crove mark (a ring C with two sparkles)', () => {
    const offenders = ['apps/app/src', 'apps/app/public', 'apps/web/src', 'apps/web/public', 'packages/ui/src'].flatMap(sources).filter((file) => read(file).includes('M141.5 33.7'));
    expect(offenders).toEqual([]);
  });
});
