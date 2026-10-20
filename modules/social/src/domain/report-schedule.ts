// When a client report schedule (#704) sends, and the period a send covers, in the schedule's IANA time zone. Instants
// are epoch milliseconds; nothing here reads the clock.
import { localTime, zonedToEpoch } from './queue.ts';

export type ReportCadence = 'weekly' | 'monthly';
export type ReportPeriod = 'previous_week' | 'previous_month' | 'last_7_days' | 'last_30_days';

export interface ReportScheduleSpec {
  cadence: ReportCadence;
  // ISO weekday (1 = Monday) for a weekly schedule; day of the month (1 to 28) for a monthly one.
  weekday: number | null;
  monthDay: number | null;
  sendHour: number;
  timeZone: string;
}

const DAY = 86_400_000;

// The first send strictly after `afterMs`.
export function nextReportRun(spec: ReportScheduleSpec, afterMs: number): number {
  const start = localTime(afterMs, spec.timeZone);
  let day = Date.UTC(start.year, start.month - 1, start.day);
  // A month and a half covers every monthly day (1 to 28) and every weekday.
  for (let i = 0; i < 45; i++, day += DAY) {
    const d = new Date(day);
    const weekday = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
    const match = spec.cadence === 'weekly' ? weekday === spec.weekday : d.getUTCDate() === spec.monthDay;
    if (!match) continue;
    const at = zonedToEpoch({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: spec.sendHour, minute: 0 }, spec.timeZone);
    if (at > afterMs) return at;
  }
  throw new Error('no report run within 45 days');
}

const midnight = (dayUtc: number, timeZone: string) => {
  const d = new Date(dayUtc);
  return zonedToEpoch({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: 0, minute: 0 }, timeZone);
};

// The period a send at `runMs` covers, [start, end), from local midnights: the week before (Monday to Sunday), the
// month before, or the 7 or 30 days before the day of the send.
export function reportPeriodAt(period: ReportPeriod, runMs: number, timeZone: string): { start: number; end: number } {
  const l = localTime(runMs, timeZone);
  const today = Date.UTC(l.year, l.month - 1, l.day);
  switch (period) {
    case 'previous_week': {
      const monday = today - (l.weekday - 1) * DAY;
      return { start: midnight(monday - 7 * DAY, timeZone), end: midnight(monday, timeZone) };
    }
    case 'previous_month':
      return { start: midnight(Date.UTC(l.year, l.month - 2, 1), timeZone), end: midnight(Date.UTC(l.year, l.month - 1, 1), timeZone) };
    case 'last_7_days':
      return { start: midnight(today - 7 * DAY, timeZone), end: midnight(today, timeZone) };
    case 'last_30_days':
      return { start: midnight(today - 30 * DAY, timeZone), end: midnight(today, timeZone) };
  }
}
