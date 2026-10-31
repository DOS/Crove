// SPDX-License-Identifier: AGPL-3.0-only
// The cards of Settings are siblings in one grid, and several are keyed by the org so a value typed in one org does not
// stay when the page shows another. With one key shared, React matches cards by key when a slot before them renders
// nothing (a card that is off), loses one, and leaves the old card in the page next to its new copy (issue #2099: the
// MISA card showed twice once the bank feed card, off by default, sat before it). So every key is its own.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../src/routes/settings.tsx', import.meta.url), 'utf8');
// The grid of cards and the definition list of the org, the two places where keyed elements are siblings of each other.
const section = (from: string, to: string) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));
const keysOf = (text: string) => [...text.matchAll(/<[A-Z]\w+ key=\{(`[^`]*`|[^}]*)\}/g)].map((m) => m[1] as string);

describe('Settings keys', () => {
  it.each([
    ['the grid of cards', section('<div className="grid gap-6 lg:grid-cols-2">', '<TwoFactorCard />')],
    ['the org details', section('<dl className="mt-3 space-y-2 text-sm">', '</dl>')],
  ])('gives each keyed element of %s its own key', (_name, text) => {
    const keys = keysOf(text);
    expect(keys.length).toBeGreaterThan(2);
    expect(new Set(keys).size).toBe(keys.length);
    // Not just distinct text: a bare org key is the one other keys were sharing.
    for (const key of keys) expect(key).not.toMatch(/^org\.data\??\.slug$/);
  });
});
