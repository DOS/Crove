// Reordering a channel's queue from the app (#1020): the date range a shuffle takes, and which channels of a post can
// be moved to the front. The commands decide; these only keep the buttons and the range honest.
import { zonedToEpoch } from '@crove/mod-social/contract';

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

// The start of a local calendar day (yyyy-mm-dd, `after` days later) in a zone; null when the text is not a date.
function startOfDay(date: string, timeZone: string, after = 0): number | null {
  const m = DAY.exec(date);
  if (!m) return null;
  // Calendar day arithmetic on day numbers only, no zone involved.
  const day = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + after));
  if (Number.isNaN(day.getTime())) return null;
  return zonedToEpoch({ year: day.getUTCFullYear(), month: day.getUTCMonth() + 1, day: day.getUTCDate(), hour: 0, minute: 0 }, timeZone);
}

// The instants a shuffle of the days from..to (yyyy-mm-dd, both included, either may be empty) takes, in the queue's
// time zone: from the start of the first day to the last instant before the day after the last. null: a date is not
// one, or the range ends before it starts.
export function shuffleRange(from: string, to: string, timeZone: string): { from?: string; to?: string } | null {
  const start = from ? startOfDay(from, timeZone) : undefined;
  const next = to ? startOfDay(to, timeZone, 1) : undefined;
  if (start === null || next === null) return null;
  const end = next === undefined ? undefined : next - 1;
  if (start !== undefined && end !== undefined && start >= end) return null;
  return { ...(start !== undefined ? { from: new Date(start).toISOString() } : {}), ...(end !== undefined ? { to: new Date(end).toISOString() } : {}) };
}

// A channel waiting in a queue slot that is still ahead, with no time of its own or retry time deciding when it goes out.
export function canMoveToFront(v: { status: string; queueSlotAt: string | null; effectiveAt: string | null }, now = Date.now()): boolean {
  return v.status === 'scheduled' && v.queueSlotAt !== null && v.effectiveAt === v.queueSlotAt && Date.parse(v.queueSlotAt) > now;
}
