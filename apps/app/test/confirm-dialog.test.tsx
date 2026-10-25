// The confirmation dialog that replaces window.confirm (#1512), rendered on the server while closed: its trigger is the
// button given, with its label, says it opens a dialog, and is disabled while the page is busy.
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it } from 'vitest';
import { Button } from '@crove/ui/components/button';
import { ConfirmDialog } from '../src/components/confirm-dialog.tsx';
import { catalog } from '../src/i18n/runtime.ts';

function render(disabled: boolean): string {
  return renderToStaticMarkup(
    <IntlProvider locale="en" messages={catalog('en')}>
      <ConfirmDialog render={<Button variant="outline" />} disabled={disabled} title="Read again?" description="It replaces the proposal." confirm="Read again" onConfirm={() => undefined}>
        Read again
      </ConfirmDialog>
    </IntlProvider>,
  );
}

describe('ConfirmDialog', () => {
  it('renders only its trigger while closed, marked as opening a dialog', () => {
    const html = render(false);
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('>Read again</button>');
    expect(html).not.toContain('It replaces the proposal.');
    expect(html).not.toMatch(/<button[^>]* disabled=""/);
  });

  it('disables the trigger while the page is busy', () => {
    expect(render(true)).toMatch(/<button[^>]* disabled=""/);
  });
});
