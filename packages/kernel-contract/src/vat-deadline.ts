// When an org's VAT return is due (issue #318), for the multi-client home screen. Vietnam rules (Law on Tax
// Administration 38/2019/QH14, Article 44(1)): a monthly return is due on the 20th of the following month; a quarterly
// return on the last day of the first month of the following quarter. When that day is a Saturday or a Sunday the
// deadline moves to the next Monday (Civil Code 2015, Article 148(5)). Public holidays (Tet and the others, set each
// year) are not applied, so the date shown is never later than the real deadline.
//
// Dates are calendar dates (YYYY-MM-DD) in Vietnam time (UTC+7, no daylight saving).
export const VAT_FILING_PERIODS = ['month', 'quarter'] as const;
export type VatFilingPeriod = (typeof VAT_FILING_PERIODS)[number];

export interface VatDeadline {
  // The period the return covers: "2026-09" for a month, "2026-Q3" for a quarter (the VAT working's period key).
  period: string;
  // The day the return is due, after the weekend rule.
  dueDate: string;
  // Whole days from today to dueDate; 0 on the day itself.
  daysLeft: number;
}

const DAY_MS = 86_400_000;
const VIETNAM_OFFSET_MS = 7 * 3_600_000;

function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function utcDate(year: number, monthIndex: number, day: number): Date {
  return new Date(Date.UTC(year, monthIndex, day));
}

// Today's date in Vietnam.
export function vietnamToday(now: Date = new Date()): string {
  return iso(new Date(now.getTime() + VIETNAM_OFFSET_MS));
}

// Saturday and Sunday move to the following Monday.
function afterWeekend(date: Date): Date {
  const weekday = date.getUTCDay();
  if (weekday === 6) return new Date(date.getTime() + 2 * DAY_MS);
  if (weekday === 0) return new Date(date.getTime() + DAY_MS);
  return date;
}

// The return of the period that contains the given month (monthIndex 0-11): its period key and due date.
function deadlineOf(kind: VatFilingPeriod, year: number, monthIndex: number): { period: string; due: Date } {
  if (kind === 'month') {
    // Date.UTC rolls month 12 over to January of the next year.
    return { period: `${year}-${String(monthIndex + 1).padStart(2, '0')}`, due: afterWeekend(utcDate(year, monthIndex + 1, 20)) };
  }
  const quarter = Math.floor(monthIndex / 3) + 1;
  // Day 0 of the month after the first month of the next quarter is that first month's last day.
  return { period: `${year}-Q${quarter}`, due: afterWeekend(utcDate(year, quarter * 3 + 1, 0)) };
}

// The first VAT return due on or after today: the one for the period before today's (still open until its due date),
// otherwise the one for the period that contains today.
export function nextVatDeadline(kind: VatFilingPeriod, today: string): VatDeadline {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) throw new Error(`not a calendar date: ${today}`);
  const now = new Date(`${today}T00:00:00Z`);
  if (Number.isNaN(now.getTime()) || iso(now) !== today) throw new Error(`not a calendar date: ${today}`);
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const step = kind === 'month' ? 1 : 3;
  const previousStart = utcDate(year, month - (kind === 'month' ? 0 : month % 3) - step, 1);
  let deadline = deadlineOf(kind, previousStart.getUTCFullYear(), previousStart.getUTCMonth());
  if (deadline.due.getTime() < now.getTime()) deadline = deadlineOf(kind, year, month);
  return { period: deadline.period, dueDate: iso(deadline.due), daysLeft: Math.round((deadline.due.getTime() - now.getTime()) / DAY_MS) };
}
