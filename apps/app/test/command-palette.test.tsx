// The command palette (#439) with what the org's search found (#673), rendered on the server: found entries appear
// under their own groups after the screens, and the status line says while the search runs or when it failed, in
// place of "nothing matches".
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it } from 'vitest';
import { CommandPalette, type PaletteEntry } from '../src/components/command-palette.tsx';
import { vi as viMessages } from '../src/i18n/messages/vi.ts';
import { catalog } from '../src/i18n/runtime.ts';

const t = viMessages.palette;
const none = () => {};
const entries: PaletteEntry[] = [{ id: 'go:journal', group: 'go', label: 'Sổ nhật ký', run: none }];
const found: PaletteEntry[] = [
  { id: 'entry:1', group: 'entries', label: 'Tiền điện tháng 9', detail: '15/09/2026, 1.980.000 ₫', run: none },
  { id: 'party:1', group: 'parties', label: 'Công ty Điện lực Hà Nội', detail: 'MST 0101234564', run: none },
];

const render = (props: Partial<Parameters<typeof CommandPalette>[0]>) =>
  renderToStaticMarkup(
    <IntlProvider locale="vi" messages={catalog('vi')}>
      <CommandPalette entries={entries} open={false} onOpenChange={none} {...props} />
    </IntlProvider>,
  );

describe('CommandPalette with search results', () => {
  it('lists found entries in their groups, parties before entries, after the screens', () => {
    const html = render({ found });
    const order = [t.groups.go, 'Sổ nhật ký', t.groups.parties, 'Công ty Điện lực Hà Nội', 'MST 0101234564', t.groups.entries, 'Tiền điện tháng 9'].map((s) =>
      html.indexOf(s),
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(html).not.toContain(t.searching);
  });

  it('says the search is running, and does not claim nothing matches meanwhile', () => {
    const html = render({ entries: [], search: 'searching' });
    expect(html).toContain(t.searching);
    expect(html).not.toContain(t.empty);
  });

  it('says the search failed', () => {
    const html = render({ entries: [], search: 'failed' });
    expect(html).toContain(t.searchFailed);
    expect(html).not.toContain(t.empty);
    expect(render({ entries: [] })).toContain(t.empty);
  });
});
