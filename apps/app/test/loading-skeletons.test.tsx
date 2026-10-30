// SPDX-License-Identifier: AGPL-3.0-only
// Loading (DESIGN.md §5.3, #2005): a page or a list loads as a skeleton shaped like its content; a spinner is only for
// a button or a small region. No component returns a lone spinner as its whole state or a whole loading branch, but
// for the small regions listed below.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
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

// Spinners left on purpose, in a button's place or a small region beside its words (DESIGN.md §5.3), by file and count:
// a page, a list or a card loads as a skeleton instead.
const SMALL_REGIONS: Readonly<Record<string, number>> = {
  // Waiting for the host's answer, next to "waiting" (the visitor's and the manage page).
  'routes/booking-page.tsx': 2,
  // "Reading the document again", in a line with its words.
  'routes/inbox-detail.tsx': 1,
  // The forwarding address, one line in its card.
  'routes/inbox.tsx': 1,
  // A figure in an overview tile.
  'routes/overview.tsx': 1,
  // Checking whether the reset needs a code, under the form's title.
  'routes/reset-password.tsx': 1,
  // A tax deadline's date in the calendar's definition list.
  'routes/settings.tsx': 1,
  // The portal's captcha image, in its box.
  'components/portal-sync.tsx': 1,
};

// A spinner that is a component's whole return, or a line of its own (the whole branch of a loading ternary).
const LONE_SPINNER = /return <Spinner[^>]*\/>;|^\s*<Spinner \/>\s*$/gm;

describe('loading states', () => {
  it('loads pages, lists and cards as skeletons; a spinner only in a small region', () => {
    const counts = Object.fromEntries(
      sources(src)
        .filter((path) => !paused(path))
        .map((path) => [relative(src, path).split(sep).join('/'), readFileSync(path, 'utf8').match(LONE_SPINNER)?.length ?? 0] as const)
        .filter(([, n]) => n > 0),
    );
    expect(counts).toEqual(SMALL_REGIONS);
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
