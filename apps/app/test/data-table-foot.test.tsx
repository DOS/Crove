// SPDX-License-Identifier: AGPL-3.0-only
// A table's totals (DESIGN.md §4.3, #2002): the totals row sits in a <tfoot>, which screen readers announce as the
// table's footer, under a rule stronger than the hairline between rows, so the total is set apart by more than a color.
import { TableCell, TableRow } from '@crove/ui/components/table';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/api.ts', () => ({ takeOrgLeftNotice: () => null }));

const { DataTable, TOTAL_RULE } = await import('../src/components/ui.tsx');

describe('DataTable foot', () => {
  it('puts the totals row in a tfoot after the body, under the stronger rule', () => {
    const html = renderToStaticMarkup(
      <DataTable
        head={['Mục', 'Số tiền']}
        numeric={[1]}
        foot={
          <TableRow>
            <TableCell>Tổng cộng</TableCell>
            <TableCell>1.250.000</TableCell>
          </TableRow>
        }
      >
        <TableRow>
          <TableCell>Dòng 1</TableCell>
          <TableCell>1.250.000</TableCell>
        </TableRow>
      </DataTable>,
    );
    const tfoot = /<tfoot[^>]*class="([^"]*)"[^>]*>(.*?)<\/tfoot>/.exec(html);
    expect(tfoot).not.toBeNull();
    // Twice the hairline: a heavier rule, not only another color.
    expect(TOTAL_RULE.split(' ')).toContain('border-t-2');
    const classes = tfoot?.[1]?.split(' ') ?? [];
    for (const c of TOTAL_RULE.split(' ')) expect(classes).toContain(c);
    expect(tfoot?.[2]).toContain('Tổng cộng');
    expect(html.indexOf('</tbody>')).toBeLessThan(html.indexOf('<tfoot'));
    expect(/<tbody[^>]*>(.*?)<\/tbody>/.exec(html)?.[1]).not.toContain('Tổng cộng');
  });

  it('keeps the rule on a total that is the last row of the body, as a statement ends', () => {
    const html = renderToStaticMarkup(
      <DataTable head={['Mục']}>
        <TableRow className={TOTAL_RULE}>
          <TableCell>Tổng cộng nguồn vốn</TableCell>
        </TableRow>
      </DataTable>,
    );
    const tbody = (/<tbody[^>]*class="([^"]*)"/.exec(html)?.[1] ?? '').replaceAll('&amp;', '&');
    // The body clears the last row's bottom hairline only, never its top border.
    expect(tbody).toContain('[&_tr:last-child]:border-b-0');
    expect(tbody).not.toContain('[&_tr:last-child]:border-0');
  });

  it('renders no tfoot for a table without totals', () => {
    const html = renderToStaticMarkup(
      <DataTable head={['Mục']}>
        <TableRow>
          <TableCell>Dòng 1</TableCell>
        </TableRow>
      </DataTable>,
    );
    expect(html).not.toContain('<tfoot');
  });
});
