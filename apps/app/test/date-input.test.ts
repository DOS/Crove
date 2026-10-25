// Date fields (#1304): what they read and show, whatever the browser's language.
import { describe, expect, it } from 'vitest';
import { formatDateValue, formatTimeValue, joinDateTime, parseDateText, parseTimeText, splitDateTime } from '../src/lib/date-input.ts';

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

describe('time input (#1432)', () => {
  it('reads a 24-hour time, its short and Vietnamese forms, and drops seconds', () => {
    expect(parseTimeText('14:30')).toBe('14:30');
    expect(parseTimeText(' 9:05 ')).toBe('09:05');
    expect(parseTimeText('9h30')).toBe('09:30');
    expect(parseTimeText('14h')).toBe('14:00');
    expect(parseTimeText('09.15')).toBe('09:15');
    expect(parseTimeText('00:00')).toBe('00:00');
    expect(parseTimeText('23:59:30')).toBe('23:59');
  });

  it('refuses what is not a whole time of day', () => {
    for (const text of ['24:00', '12:60', '9:5', '9', '930', '', '2:30 PM', 'trưa']) expect(parseTimeText(text), text).toBeNull();
  });

  it('shows HH:mm, and nothing for no value', () => {
    expect(formatTimeValue('09:05')).toBe('09:05');
    expect(formatTimeValue('09:05:00')).toBe('09:05');
    expect(formatTimeValue('')).toBe('');
    expect(formatTimeValue('25:00')).toBe('');
  });

  it('splits a datetime-local value into its date and time, and joins them back only when both are set', () => {
    expect(splitDateTime('2026-10-25T14:30')).toEqual({ date: '2026-10-25', time: '14:30' });
    expect(splitDateTime('2026-10-25T14:30:15')).toEqual({ date: '2026-10-25', time: '14:30' });
    expect(splitDateTime('')).toEqual({ date: '', time: '' });
    expect(splitDateTime('2026-10-25')).toEqual({ date: '', time: '' });
    expect(joinDateTime('2026-10-25', '14:30')).toBe('2026-10-25T14:30');
    expect(joinDateTime('2026-10-25', '')).toBe('');
    expect(joinDateTime('', '14:30')).toBe('');
  });
});
