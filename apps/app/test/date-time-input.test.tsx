// Social's date and time fields (#1432): what a scheduling field shows and sends. The value is the datetime-local string
// lib/social.ts builds and reads, so what reaches the API is what the native input sent, in any time zone, on the days
// the clocks change too. Rendered on the server: the fields read dd/mm/yyyy and 24-hour HH:mm in English as well.
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { afterEach, describe, expect, it } from 'vitest';
import { DateInput } from '../src/components/date-input.tsx';
import { DateTimeInput } from '../src/components/date-time-input.tsx';
import { TimeInput } from '../src/components/time-input.tsx';
import { catalog } from '../src/i18n/runtime.ts';
import { formatDateValue, formatTimeValue, joinDateTime, parseDateText, parseTimeText, splitDateTime } from '../src/lib/date-input.ts';
import * as assign from '../src/lib/social-assign.ts';
import * as social from '../src/lib/social.ts';

// What a person reads in the two fields for a value, and the value typing exactly that gives back.
function throughFields(value: string): string {
  const { date, time } = splitDateTime(value);
  return joinDateTime(parseDateText(formatDateValue(date, 'day'), 'day') ?? '', parseTimeText(formatTimeValue(time)) ?? '');
}

const zone = process.env.TZ;
// The process's time zone, for one case: Node reads TZ again when it changes (the unit tests run in child processes).
function inZone(tz: string, run: () => void) {
  process.env.TZ = tz;
  run();
}
afterEach(() => {
  if (zone === undefined) delete process.env.TZ;
  else process.env.TZ = zone;
});

// Instants on both sides of each zone's clock changes in 2026, and an ordinary afternoon.
const ZONES: { tz: string; offsets: [number, number]; instants: string[] }[] = [
  // Clocks forward 29 March (02:00 to 03:00), back 25 October (03:00 to 02:00).
  { tz: 'Europe/Berlin', offsets: [-60, -120], instants: ['2026-03-29T00:30:00.000Z', '2026-03-29T01:30:00.000Z', '2026-10-25T00:30:00.000Z', '2026-10-25T02:30:00.000Z', '2026-07-01T12:05:00.000Z'] },
  // Forward 8 March, back 1 November.
  { tz: 'America/New_York', offsets: [300, 240], instants: ['2026-03-08T06:30:00.000Z', '2026-03-08T07:30:00.000Z', '2026-11-01T05:30:00.000Z', '2026-11-01T07:30:00.000Z', '2026-12-31T23:59:00.000Z'] },
  // The southern summer: back 5 April, forward 4 October.
  { tz: 'Australia/Sydney', offsets: [-660, -600], instants: ['2026-04-04T15:30:00.000Z', '2026-04-04T17:30:00.000Z', '2026-10-03T15:30:00.000Z', '2026-10-03T16:30:00.000Z'] },
  // No change: Viet Nam.
  { tz: 'Asia/Ho_Chi_Minh', offsets: [-420, -420], instants: ['2026-01-01T00:00:00.000Z', '2026-10-25T07:30:00.000Z'] },
];

describe('the datetime-local round trip through the date and time fields', () => {
  for (const { tz, offsets, instants } of ZONES) {
    it(`sends the instant the native input sent, in ${tz}`, () => {
      inZone(tz, () => {
        // The zone took: January and July are at the offsets of the zone, not of the machine.
        expect([new Date('2026-01-15T12:00:00Z').getTimezoneOffset(), new Date('2026-07-15T12:00:00Z').getTimezoneOffset()].sort((a, b) => b - a)).toEqual([...offsets].sort((a, b) => b - a));
        for (const iso of instants) {
          for (const lib of [social, assign]) {
            const value = lib.toLocalInput(iso);
            expect(value, iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
            // The fields give back the very string they were given, so the instant is the one the native input sent.
            expect(throughFields(value), iso).toBe(value);
            expect(lib.fromLocalInput(throughFields(value)), iso).toBe(iso);
          }
        }
      });
    });
  }

  it('reads a wall time the clocks skip or repeat as the native input did', () => {
    inZone('Europe/Berlin', () => {
      // 02:30 on 29 March does not exist there: it is 03:30 summer time.
      expect(social.fromLocalInput(throughFields('2026-03-29T02:30'))).toBe('2026-03-29T01:30:00.000Z');
      // 02:30 on 25 October comes twice: the first, summer time one.
      expect(social.fromLocalInput(throughFields('2026-10-25T02:30'))).toBe('2026-10-25T00:30:00.000Z');
    });
  });

  it('sends "" while either half is missing, as the native input did', () => {
    expect(joinDateTime(parseDateText('25/10/2026', 'day') ?? '', parseTimeText('14:') ?? '')).toBe('');
    expect(social.fromLocalInput('')).toBeNull();
  });
});

function render(node: ReactNode): string {
  return renderToStaticMarkup(
    <IntlProvider locale="en" messages={catalog('en')}>
      {node}
    </IntlProvider>,
  );
}

describe('TimeInput and DateTimeInput', () => {
  it('shows a time as 24-hour HH:mm with its name, and a picker button that does not share it', () => {
    const html = render(<TimeInput aria-label="Time" value="21:05" onChange={() => undefined} />);
    expect(html).toContain('aria-label="Time"');
    expect(html).toContain('value="21:05"');
    expect(html).toContain('placeholder="hh:mm"');
    expect(html).toContain('aria-label="Open the clock"');
    expect(html).not.toContain('PM');
  });

  it('shows a schedule as dd/mm/yyyy and HH:mm in a named group, with no picker when disabled', () => {
    const html = render(<DateTimeInput aria-label="At a time" value="2026-10-25T14:30" min="2026-10-24T09:00" onChange={() => undefined} />);
    expect(html).toContain('role="group" aria-label="At a time"');
    expect(html).toContain('value="25/10/2026"');
    expect(html).toContain('value="14:30"');
    // The hidden native pickers keep the ISO halves and the earliest day.
    expect(html).toContain('type="date"');
    expect(html).toContain('min="2026-10-24"');
    expect(html).toContain('aria-label="Date"');
    expect(html).toContain('aria-label="Time"');
    const locked = render(<DateTimeInput aria-label="At a time" disabled value="2026-10-25T14:30" onChange={() => undefined} />);
    expect(locked).not.toContain('Open the clock');
    expect(locked).not.toContain('Open the calendar');
  });

  it('marks a date before min on the visible field, and keeps the hidden pickers out of any form', () => {
    const html = render(<DateInput aria-label="Date" value="2026-10-20" min="2026-10-25" onChange={() => undefined} />);
    expect(html).toMatch(/<input[^>]*aria-label="Date"[^>]*aria-invalid="true"/);
    expect(html).toMatch(/<input[^>]*type="date"[^>]*form="crove-picker-without-form"/);
    expect(render(<DateInput aria-label="Date" value="2026-10-25" min="2026-10-25" onChange={() => undefined} />)).not.toContain('aria-invalid="');
    expect(render(<TimeInput aria-label="Time" value="09:30" onChange={() => undefined} />)).toMatch(/type="time"[^>]*form="crove-picker-without-form"/);
    // The browser's message names the bound as dd/mm/yyyy.
    expect(catalog('en').common.dateTooEarly).toBe('Must be {min} or later');
    expect(catalog('vi').common.dateTooEarly).toBe('Không được trước {min}');
  });

  it('names the date half by the id a label points to', () => {
    const html = render(<DateTimeInput id="post-due" aria-labelledby="post-due-label" value="" onChange={() => undefined} />);
    expect(html).toContain('aria-labelledby="post-due-label"');
    expect(html).toContain('id="post-due"');
    expect(html).not.toContain('aria-label="Date"');
  });
});
