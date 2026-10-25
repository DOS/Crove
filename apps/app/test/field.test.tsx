// Form fields whose error is linked to them (DESIGN.md §4.2, #1515): the control's id, aria-invalid and aria-describedby
// name the hint and the error rendered under it, and a refused submit moves the focus to the first invalid field.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// ui.tsx reads one notice from the API module, which needs a browser window to load.
vi.mock('../src/lib/api.ts', () => ({ takeOrgLeftNotice: () => null }));
const { Field, FieldError, fieldControl, focusFirstInvalid, isEmailAddress } = await import('../src/components/ui.tsx');

const attrs = (html: string, tag: string) => html.match(new RegExp(`<${tag}\\b[^>]*>`))?.[0] ?? '';

describe('fieldControl', () => {
  it('names the hint and the error only when they are shown, and marks the control invalid only with an error', () => {
    expect(fieldControl('tax')).toEqual({ id: 'tax', 'aria-invalid': undefined, 'aria-describedby': undefined });
    expect(fieldControl('tax', { hint: true })).toEqual({ id: 'tax', 'aria-invalid': undefined, 'aria-describedby': 'tax-hint' });
    expect(fieldControl('tax', { error: true })).toEqual({ id: 'tax', 'aria-invalid': true, 'aria-describedby': 'tax-error' });
    expect(fieldControl('tax', { hint: true, error: true })).toEqual({ id: 'tax', 'aria-invalid': true, 'aria-describedby': 'tax-hint tax-error' });
  });
});

describe('Field', () => {
  it('labels the control and links it to its hint and its visible error', () => {
    const html = renderToStaticMarkup(
      <Field id="tax" label="Mã số thuế" hint="10 hoặc 13 chữ số" error="Mã số thuế không hợp lệ">
        {(control) => <input {...control} />}
      </Field>,
    );
    expect(attrs(html, 'label')).toContain('for="tax"');
    const input = attrs(html, 'input');
    expect(input).toContain('id="tax"');
    expect(input).toContain('aria-invalid="true"');
    expect(input).toContain('aria-describedby="tax-hint tax-error"');
    expect(html).toContain('<p id="tax-hint" class="text-xs text-muted-foreground">10 hoặc 13 chữ số</p>');
    expect(html).toContain('id="tax-error"');
    expect(html).toMatch(/id="tax-error"[^>]*>Mã số thuế không hợp lệ</);
    // The label names the field alone: the error is outside it.
    expect(html).toMatch(/<label[^>]*>Mã số thuế<\/label>/);
  });

  it('is not invalid and names no error while the value is fine, and makes up an id when none is given', () => {
    const html = renderToStaticMarkup(<Field label="Email">{(control) => <input {...control} />}</Field>);
    const input = attrs(html, 'input');
    expect(input).not.toContain('aria-invalid');
    expect(input).not.toContain('aria-describedby');
    expect(html).not.toContain('-error');
    const id = /id="([^"]+)"/.exec(input)?.[1] ?? '';
    expect(id).not.toBe('');
    expect(attrs(html, 'label')).toContain(`for="${id}"`);
  });

  it('leaves the label out when the control is named another way', () => {
    const html = renderToStaticMarkup(<Field error="Sai">{(control) => <input aria-label="Tên" {...control} />}</Field>);
    expect(html).not.toContain('<label');
    expect(attrs(html, 'input')).toContain('aria-invalid="true"');
  });
});

describe('FieldError', () => {
  it('renders nothing without a message, and the message under the id the control names otherwise', () => {
    expect(renderToStaticMarkup(<FieldError id="x">{null}</FieldError>)).toBe('');
    expect(renderToStaticMarkup(<FieldError id="x">Sai</FieldError>)).toBe('<p id="x-error" class="text-xs text-destructive">Sai</p>');
  });
});

describe('focusFirstInvalid', () => {
  const element = (focusable: boolean, inner?: { focus: () => void }) => ({
    focus: vi.fn(),
    matches: () => focusable,
    querySelector: () => inner ?? null,
  });

  it('focuses the first field marked invalid', () => {
    const field = element(true);
    const form = { querySelector: vi.fn(() => field) };
    expect(focusFirstInvalid(form as unknown as ParentNode)).toBe(true);
    expect(form.querySelector).toHaveBeenCalledWith('[aria-invalid="true"]');
    expect(field.focus).toHaveBeenCalled();
  });

  it('focuses into a group marked invalid (a fieldset of checkboxes)', () => {
    const checkbox = { focus: vi.fn() };
    const group = element(false, checkbox);
    expect(focusFirstInvalid({ querySelector: () => group } as unknown as ParentNode)).toBe(true);
    expect(group.focus).not.toHaveBeenCalled();
    expect(checkbox.focus).toHaveBeenCalled();
  });

  it('does nothing when no field is marked', () => {
    expect(focusFirstInvalid({ querySelector: () => null } as unknown as ParentNode)).toBe(false);
    expect(focusFirstInvalid(null)).toBe(false);
  });
});

describe('isEmailAddress', () => {
  it('accepts what an email field accepts and refuses the rest', () => {
    for (const ok of ['ketoan@congty.vn', 'a.b+c@x.co', ' ten@congty.vn ', 'a@localhost']) expect(isEmailAddress(ok)).toBe(true);
    for (const bad of ['', 'ketoan', 'ketoan@', '@congty.vn', 'ke toan@congty.vn', 'a@b..vn', 'a@-b.vn']) expect(isEmailAddress(bad)).toBe(false);
  });
});
