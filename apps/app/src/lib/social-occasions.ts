// Vietnamese occasions on the Social calendar (#702): when a post for one is planned, and whether this browser shows
// them (a per-viewer choice, kept in the browser; the calendar shows them unless turned off).
import { OCCASIONS } from '@crove/mod-social/contract';

export const OCCASION_IDS: ReadonlySet<string> = new Set(OCCASIONS.map((o) => o.id));
// A post for an occasion is planned this many days before it, at 09:00.
export const LEAD_DAYS = 3;

// When a post for an occasion on `date` (YYYY-MM-DD, local) is planned: LEAD_DAYS before at 09:00; when that has gone
// by, the next full hour, as long as it is not after the occasion's day; null once the day is over.
export function occasionStart(date: string, now: Date = new Date()): Date | null {
  const [y, m, d] = date.split('-').map(Number);
  if (!y || !m || !d) return null;
  const end = new Date(y, m - 1, d + 1, 0, 0);
  if (end.getTime() <= now.getTime()) return null;
  const planned = new Date(y, m - 1, d - LEAD_DAYS, 9, 0);
  if (planned.getTime() > now.getTime()) return planned;
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours() + 1, 0);
  return next.getTime() < end.getTime() ? next : null;
}

const keyOf = (slug: string) => `crove.social.occasions.${slug}`;
export function occasionsShown(slug: string): boolean {
  try {
    return localStorage.getItem(keyOf(slug)) !== 'off';
  } catch {
    return true;
  }
}
export function setOccasionsShown(slug: string, shown: boolean): void {
  try {
    if (shown) localStorage.removeItem(keyOf(slug));
    else localStorage.setItem(keyOf(slug), 'off');
  } catch {
    // A browser that keeps nothing shows them each time.
  }
}
