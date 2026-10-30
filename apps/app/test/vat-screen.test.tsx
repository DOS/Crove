// SPDX-License-Identifier: AGPL-3.0-only
// Amounts on the VAT screen (DESIGN.md §4.3, #2001): a money column is right-aligned with tabular figures, its header
// included, so the digits of a column line up under it.
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import { catalog } from '../src/i18n/runtime.ts';

vi.mock('../src/lib/api.ts', () => ({ orpc: {}, client: {}, queryClient: {}, apiFetch: () => undefined, getCurrentOrg: () => null, errorMessage: String }));

const { InvoiceTable } = await import('../src/routes/vat.tsx');

const invoice = {
  id: '0192f0aa-1111-7222-8333-944445555666',
  issueDate: '2026-10-05',
  series: 'C26TAA',
  number: '123',
  partyName: 'Công ty An Phát',
  partyTaxCode: '0101234564',
  rates: [{ rate: '10' as const, taxable: '12500000', vat: '1250000' }],
  warnings: [],
};

describe('VAT invoice table', () => {
  it('right-aligns the taxable and VAT columns, header and cells, with tabular figures', () => {
    const html = renderToStaticMarkup(
      <IntlProvider locale="vi" messages={catalog('vi')}>
        <InvoiceTable invoices={[invoice]} partyLabel="Người bán" />
      </IntlProvider>,
    );
    const heads = [...html.matchAll(/<th[^>]*class="([^"]*)"[^>]*>([^<]*)<\/th>/g)].map((m) => ({ cls: m[1] ?? '', text: m[2] ?? '' }));
    const cells = [...html.matchAll(/<td[^>]*class="([^"]*)"[^>]*>/g)].map((m) => m[1] ?? '');
    expect(heads).toHaveLength(7);
    expect(cells).toHaveLength(7);
    for (let i = 0; i < 7; i++) {
      const money = i === 4 || i === 5;
      expect(heads[i]?.cls.includes('text-right'), `header ${heads[i]?.text}`).toBe(money);
      expect(cells[i]?.includes('text-right'), `cell ${i}`).toBe(money);
      if (money) expect(cells[i]).toContain('tabular-nums');
    }
  });
});
