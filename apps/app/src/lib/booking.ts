// Helpers for the public booking page (issue #1318): the free slots grouped by day and shown in the visitor's own time
// zone, the week the page reads, and the visitor's zone itself.
import { zonedDate, zonedInstant, type BookingPage } from '@crove/kernel-contract';
import type { Locale } from '../i18n/locale.ts';

export type Slot = BookingPage['slots'][number];

/** The visitor's IANA zone, or Vietnam's when the browser does not say. */
export function visitorTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Ho_Chi_Minh';
  } catch {
    return 'Asia/Ho_Chi_Minh';
  }
}

/**
 * The week `weeks` weeks after today in `timeZone`: from local midnight to local midnight seven days later, so a day is
 * never split between two weeks. What one page read covers.
 */
export function weekRange(now: number, weeks: number, timeZone: string): { from: string; to: string } {
  const start = Date.parse(`${zonedDate(timeZone, now)}T12:00:00Z`) + weeks * 7 * 86_400_000;
  const day = (offset: number) => new Date(start + offset * 86_400_000).toISOString().slice(0, 10);
  return { from: new Date(zonedInstant(timeZone, day(0), 0)).toISOString(), to: new Date(zonedInstant(timeZone, day(7), 0)).toISOString() };
}

/** The slots by day in `timeZone`, days in order, each day's slots in order. */
export function slotsByDay(slots: readonly Slot[], timeZone: string): { date: string; slots: Slot[] }[] {
  const days = new Map<string, Slot[]>();
  for (const s of [...slots].sort((a, b) => a.start.localeCompare(b.start))) {
    const date = zonedDate(timeZone, Date.parse(s.start));
    const list = days.get(date) ?? [];
    list.push(s);
    days.set(date, list);
  }
  return [...days].map(([date, list]) => ({ date, slots: list }));
}

const LOCALE_TAG: Record<Locale, string> = { vi: 'vi-VN', en: 'en-GB' };

/** "09:30" in the zone. */
export function timeIn(iso: string, timeZone: string, locale: Locale): string {
  return new Intl.DateTimeFormat(LOCALE_TAG[locale], { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
}

/** "Thứ Hai, 02/11/2026" for a calendar date. */
export function dayLabel(date: string, locale: Locale): string {
  return new Intl.DateTimeFormat(LOCALE_TAG[locale], { timeZone: 'UTC', weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(`${date}T00:00:00Z`));
}
