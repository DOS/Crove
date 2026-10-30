// SPDX-License-Identifier: AGPL-3.0-only
// The Toaster (#1384, #2003, #2026), rendered on the server: the list is one status region that is there before any
// toast, so a new toast is an addition screen readers read; a toast's action is a button read with it and reachable by
// Tab and by F8, which the toast says; and the close button.
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { afterEach, describe, expect, it } from 'vitest';
import { Toaster } from '../src/components/toaster.tsx';
import { catalog } from '../src/i18n/runtime.ts';
import { currentToasts, dismissToast, isToastShortcut, toast } from '../src/lib/toast.ts';

function render(locale: 'vi' | 'en'): string {
  return renderToStaticMarkup(
    <IntlProvider locale={locale} messages={catalog(locale)}>
      <Toaster />
    </IntlProvider>,
  );
}

const words = (locale: 'vi' | 'en') => (catalog(locale) as unknown as { common: { undo: string; close: string; toasts: string } }).common;

afterEach(() => {
  for (const t of currentToasts()) dismissToast(t.id);
});

describe('Toaster', () => {
  it('keeps its status region mounted while there is no toast (#2026)', () => {
    // Not atomic: a new toast is read alone, not with the older ones.
    expect(render('vi')).toMatch(new RegExp(`^<div role="status" aria-atomic="false" aria-relevant="additions" aria-label="${words('vi').toasts}" class="[^"]*"></div>$`));
  });

  it('renders an undo as a button inside the status, before the close button, and says F8 reaches it', () => {
    toast('Đã lưu trữ ghi chú', 'success', { action: { label: words('vi').undo, run: () => {} } });
    const html = render('vi');
    expect(html.match(/role="status"/g)).toHaveLength(1);
    expect(html).toContain('Đã lưu trữ ghi chú<span class="sr-only"> Nhấn F8 để tới nút Hoàn tác.</span>');
    // The opening tags of its buttons, in order: the undo, labelled by its text, then the close button.
    const buttons = [...html.matchAll(/<button([^>]*)>/g)].map((b) => b[1] ?? '');
    expect(buttons).toHaveLength(2);
    expect(html).toMatch(/<button[^>]*>Hoàn tác<\/button>/);
    expect(html.indexOf('>Hoàn tác<')).toBeLessThan(html.indexOf('aria-label="' + words('vi').close + '"'));
    expect(buttons[0]).toContain('type="button"');
    expect(buttons[0]).toContain('aria-keyshortcuts="F8"');
    expect(buttons[0]).not.toContain('tabindex="-1"');
    expect(buttons[1]).toContain('aria-label="' + words('vi').close + '"');
  });

  it('renders no action button or F8 line for a plain toast, and the words in English', () => {
    toast('Note archived');
    const html = render('en');
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).not.toContain('F8');
    expect(words('en').undo).toBe('Undo');
    toast('Note moved to the trash', 'success', { action: { label: 'Undo', run: () => {} } });
    expect(render('en')).toContain('<span class="sr-only"> Press F8 to reach Undo.</span>');
  });

  it('says F8 only on the newest toast, the one F8 reaches', () => {
    toast('Note archived', 'success', { action: { label: 'Undo', run: () => {} } });
    toast('Marked done: Call the client', 'success', { action: { label: 'Undo', run: () => {} } });
    const html = render('en');
    expect(html.match(/Press F8/g)).toHaveLength(1);
    expect(html.indexOf('Press F8')).toBeGreaterThan(html.indexOf('Marked done: Call the client'));
  });
});

describe('isToastShortcut', () => {
  const key = (k: string, mods: Partial<{ altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; repeat: boolean }> = {}) => ({
    key: k,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    repeat: false,
    ...mods,
  });

  it('is F8 alone, pressed once', () => {
    expect(isToastShortcut(key('F8'))).toBe(true);
    for (const mod of ['altKey', 'ctrlKey', 'metaKey', 'shiftKey', 'repeat'] as const) expect(isToastShortcut(key('F8', { [mod]: true }))).toBe(false);
    expect(isToastShortcut(key('F7'))).toBe(false);
    expect(isToastShortcut(key('8'))).toBe(false);
  });
});
