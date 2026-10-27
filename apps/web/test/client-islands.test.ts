// Static sections ship no client JavaScript (DESIGN.md §6.3, #1655): the only client components of the site are the
// interactive pieces below, each with its reason, so a new 'use client' file is a decision made in review. The bytes
// they add up to are capped in perf-budget.ts.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(import.meta.dirname, '..', 'src');

const ISLANDS: Record<string, string> = {
  'components/landing/app-shell.tsx': "the hero's product picture plays the AI Inbox once it scrolls into view",
  'components/landing/copy-command.tsx': 'copies the self-host command to the clipboard',
  'components/landing/mobile-menu.tsx': "the phone header's disclosure menu",
  'components/landing/org-chart.tsx': 'picking a position in the org chart shows its panel',
  'components/landing/theme-toggle.tsx': 'switches between the light and dark theme and remembers the choice',
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(tsx?|jsx?|mjs)$/.test(entry.name) ? [path] : [];
  });
}

// A module is a client component when its first statement is the 'use client' directive.
function isClient(source: string): boolean {
  const code = source.replace(/^(\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*/, '');
  return /^['"]use client['"]/.test(code);
}

describe('client components (apps/web/src)', () => {
  it('are only the listed interactive pieces', () => {
    const found = sourceFiles(SRC)
      .filter((path) => isClient(readFileSync(path, 'utf8')))
      .map((path) => relative(SRC, path).replaceAll('\\', '/'))
      .sort();
    expect(found).toEqual(Object.keys(ISLANDS).sort());
  });
});
