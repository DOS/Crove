// Date fields (#1304): what they read and show, whatever the browser's language.
import { describe, expect, it } from 'vitest';
import { formatDateValue, parseDateText } from '../src/lib/date-input.ts';

describe('date input', () => {
  it('reads a day as dd/mm/yyyy, its short and dashed forms, and ISO', () => {
    expect(parseDateText('05/09/2026', 'day')).toBe('2026-09-05');
    expect(parseDateText('5/9/2026', 'day')).toBe('2026-09-05');
    expect(parseDateText(' 05-09-2026 ', 'day')).toBe('2026-09-05');
    expect(parseDateText('05.09.2026', 'day')).toBe('2026-09-05');
    // The e2e specs fill ISO, as the native inputs took.
    expect(parseDateText('2026-09-05', 'day')).toBe('2026-09-05');
  });

  it('refuses what is not a whole, real day', () => {
    for (const text of ['31/02/2026', '29/02/2026', '00/01/2026', '01/13/2026', '1/1', '', '2026-02-30', 'hôm nay']) {
      expect(parseDateText(text, 'day'), text).toBeNull();
    }
    expect(parseDateText('29/02/2028', 'day')).toBe('2028-02-29');
  });

  it('reads a month as mm/yyyy and ISO', () => {
    expect(parseDateText('09/2026', 'month')).toBe('2026-09');
    expect(parseDateText('9/2026', 'month')).toBe('2026-09');
    expect(parseDateText('2026-09', 'month')).toBe('2026-09');
    for (const text of ['13/2026', '0/2026', '2026-13', '2026', '']) expect(parseDateText(text, 'month'), text).toBeNull();
  });

  it('shows an ISO value as dd/mm/yyyy or mm/yyyy, and nothing for no value', () => {
    expect(formatDateValue('2026-09-05', 'day')).toBe('05/09/2026');
    expect(formatDateValue('2026-09', 'month')).toBe('09/2026');
    expect(formatDateValue('', 'day')).toBe('');
    expect(formatDateValue('garbage', 'month')).toBe('');
  });
});
