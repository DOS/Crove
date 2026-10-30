// SPDX-License-Identifier: AGPL-3.0-only
// The party edit form (#887, #2004), rendered on the server: the page checks the fields in its own words, so the browser's
// checks are off; each field is labelled and ready to name its error, and a locked tax code names the hint that says why.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import { catalog } from '../src/i18n/runtime.ts';

vi.mock('../src/lib/api.ts', () => {
  // orpc.<a>.<b>.mutationOptions() / key(): nothing is ever sent.
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'mutationOptions') return () => ({ mutationFn: () => Promise.resolve({}) });
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });
  return { orpc: node([]), queryClient: new QueryClient(), errorMessage: (e: unknown) => String(e), takeOrgLeftNotice: () => null };
});

const { EditParty } = await import('../src/components/party-edit.tsx');

const party = (taxCode: string | null) => ({ id: 'p1', name: 'Công ty Mẫu', taxCode, address: null, email: null, phone: null, version: 1, duplicates: [] });

function render(taxCode: string | null): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <IntlProvider locale="vi" messages={catalog('vi')}>
        <EditParty party={party(taxCode)} ns="vendors" onDone={() => undefined} />
      </IntlProvider>
    </QueryClientProvider>,
  );
}

const input = (html: string, id: string) => html.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`))?.[0] ?? '';

describe('EditParty', () => {
  it('checks the fields itself, with no error shown before the user leaves a field or submits', () => {
    const html = render(null);
    expect(html).toMatch(/<form[^>]*novalidate/i);
    for (const key of ['name', 'taxCode', 'email']) {
      expect(html).toContain(`for="party-p1-${key}"`);
      expect(input(html, `party-p1-${key}`)).not.toContain('aria-invalid="');
    }
    expect(html).not.toContain('-error"');
  });

  it('links a locked tax code to the hint that says it cannot change', () => {
    const html = render('0101234564');
    expect(input(html, 'party-p1-taxCode')).toContain('aria-describedby="party-p1-taxCode-hint"');
    expect(html).toContain('id="party-p1-taxCode-hint"');
    expect(input(html, 'party-p1-taxCode')).toContain('disabled');
  });
});
