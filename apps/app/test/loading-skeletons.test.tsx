// SPDX-License-Identifier: AGPL-3.0-only
// Loading (DESIGN.md §5.3, #2005): a page or a list loads as a skeleton shaped like its content; a spinner is only for
// a button or a small region. No component returns a lone spinner as its whole state, and the settings cards load their
// rows as rows.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import { catalog } from '../src/i18n/runtime.ts';

vi.mock('../src/lib/api.ts', () => ({ takeOrgLeftNotice: () => null }));

const { PageSkeleton, ProposalSkeleton, RowsSkeleton } = await import('../src/components/ui.tsx');

const src = join(import.meta.dirname, '..', 'src');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith('.tsx') ? [path] : [];
  });
}

// Social is paused (decision D5): its screens are left as they are until it reopens.
const paused = (path: string) => basename(path).startsWith('social');

// The settings cards whose rows load in place (#2005).
const SETTINGS_LISTS = ['account-rules.tsx', 'accounts.tsx', 'event-types.tsx', 'legal-entities.tsx', 'misa-goods-codes.tsx', 'working-hours.tsx'];

describe('loading states', () => {
  it('has no component whose whole loading state is a spinner', () => {
    const offenders = sources(src)
      .filter((path) => !paused(path))
      .filter((path) => /return <Spinner\b[^>]*\/>;/.test(readFileSync(path, 'utf8')))
      .map((path) => relative(src, path));
    expect(offenders).toEqual([]);
  });

  it('loads the settings lists as rows, not a spinner', () => {
    for (const name of SETTINGS_LISTS) {
      const text = readFileSync(join(src, 'routes', name), 'utf8');
      expect(text, name).toContain('<RowsSkeleton');
      expect(text, name).not.toMatch(/\? \(\s*<Spinner \/>\s*\) :/);
    }
  });

  it('says the region is busy and loading, in words a screen reader reads', () => {
    for (const node of [<PageSkeleton key="p" />, <ProposalSkeleton key="r" />, <RowsSkeleton key="w" />]) {
      const html = renderToStaticMarkup(
        <IntlProvider locale="vi" messages={catalog('vi')}>
          {node}
        </IntlProvider>,
      );
      expect(html).toContain('aria-busy="true"');
      expect(html).toContain(`<span class="sr-only">${catalog('vi').common.loading}</span>`);
      // No spinner inside: the spinner is the one element with role="status".
      expect(html).not.toContain('role="status"');
    }
  });
});
