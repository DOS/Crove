// SPDX-License-Identifier: AGPL-3.0-only
// The Toaster (#1384, #2003), rendered on the server: a toast is a status that holds its line, its action as a button
// read with it and reachable by Tab, and the close button.
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { afterEach, describe, expect, it } from 'vitest';
import { Toaster } from '../src/components/toaster.tsx';
import { catalog } from '../src/i18n/runtime.ts';
import { currentToasts, dismissToast, toast } from '../src/lib/toast.ts';

function render(locale: 'vi' | 'en'): string {
  return renderToStaticMarkup(
    <IntlProvider locale={locale} messages={catalog(locale)}>
      <Toaster />
    </IntlProvider>,
  );
}

const words = (locale: 'vi' | 'en') => (catalog(locale) as unknown as { common: { undo: string; close: string } }).common;

afterEach(() => {
  for (const t of currentToasts()) dismissToast(t.id);
});

describe('Toaster', () => {
  it('renders an undo as a button inside the toast status, before the close button', () => {
    toast('Đã lưu trữ ghi chú', 'success', { action: { label: words('vi').undo, run: () => {} } });
    const html = render('vi');
    const status = /<div role="status"[^>]*>([\s\S]*)<\/div>/.exec(html)?.[1] ?? '';
    expect(status).toContain('Đã lưu trữ ghi chú');
    const buttons = [...status.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)];
    expect(buttons.map((b) => (b[2] ?? '').replace(/<[^>]+>/g, ''))).toEqual(['Hoàn tác', '']);
    expect(buttons[0]?.[1]).toContain('type="button"');
    expect(buttons[0]?.[1]).not.toContain('tabindex="-1"');
    expect(buttons[1]?.[1]).toContain('aria-label="' + words('vi').close + '"');
  });

  it('renders no action button for a plain toast, and has the undo in English', () => {
    toast('Note archived');
    expect(render('en').match(/<button/g)).toHaveLength(1);
    expect(words('en').undo).toBe('Undo');
  });
});
