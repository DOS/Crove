// SPDX-License-Identifier: AGPL-3.0-only
// Field borders reach 3:1 against the surface they sit on, in both themes (DESIGN.md 3.1 and 7, WCAG 1.4.11, #2114).
// The tokens are read from globals.css, so a later edit of --field-border cannot slip under the floor unseen.
/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const css = readFileSync(fileURLToPath(new URL('../src/styles/globals.css', import.meta.url)), 'utf8');

// The declarations of one theme block (`:root` or `.dark`), up to the closing brace at the start of a line.
function block(selector: string): Map<string, string> {
  const start = css.indexOf(`\n${selector} {`);
  if (start < 0) throw new Error(`no ${selector} block in globals.css`);
  const end = css.indexOf('\n}', start + 1);
  const tokens = new Map<string, string>();
  for (const match of css.slice(start, end).matchAll(/^\s+--([\w-]+):\s*([^;]+);/gm)) tokens.set(match[1] ?? '', (match[2] ?? '').trim());
  return tokens;
}

// OKLCH to linear sRGB (Ottosson's matrices), then WCAG relative luminance on the clamped channels.
function luminance(value: string): number {
  const parts = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(value);
  if (!parts) throw new Error(`not a plain oklch() value: ${value}`);
  const [lightness, chroma, hue] = [Number(parts[1]), Number(parts[2]), (Number(parts[3]) * Math.PI) / 180];
  const a = chroma * Math.cos(hue);
  const b = chroma * Math.sin(hue);
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const channels = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
  const [r, g, bl] = channels.map((channel) => Math.min(1, Math.max(0, channel)));
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (bl ?? 0);
}

function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

const SURFACES = ['background', 'card', 'popover'];

describe('field border contrast (WCAG 1.4.11)', () => {
  it('measures a known pair correctly', () => {
    expect(contrast('oklch(0 0 0)', 'oklch(1 0 0)')).toBeCloseTo(21, 1);
    // The border the fields had before #2114 was 1.38:1 on the light canvas.
    expect(contrast('oklch(0.88 0.008 290)', 'oklch(0.985 0.003 290)')).toBeCloseTo(1.38, 1);
  });

  for (const [theme, selector] of [['light', ':root'], ['dark', '.dark']] as const) {
    const tokens = block(selector);
    for (const surface of SURFACES) {
      it(`--field-border is at least 3:1 against --${surface} in ${theme}`, () => {
        const border = tokens.get('field-border');
        const background = tokens.get(surface);
        if (!border || !background) throw new Error(`--field-border or --${surface} missing in the ${theme} block`);
        expect(contrast(border, background)).toBeGreaterThanOrEqual(3);
      });
    }
  }

  it('the Tailwind theme maps the token, so border-field-border emits a rule', () => {
    expect(css).toContain('--color-field-border: var(--field-border);');
  });

  it('the field components draw their border with the token', () => {
    for (const file of ['input', 'textarea', 'native-select', 'checkbox']) {
      const source = readFileSync(fileURLToPath(new URL(`../src/components/${file}.tsx`, import.meta.url)), 'utf8');
      expect(source, file).toContain('border-field-border');
      expect(source, file).not.toMatch(/border-input/);
    }
  });
});
