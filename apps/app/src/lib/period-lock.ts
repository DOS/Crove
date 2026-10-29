// Period lock (#329) on the ledger screen: who may lock and unlock, and months as YYYY-MM. Today and this month in
// Vietnam come from @crove/kernel-contract (vietnamToday, vietnamMonth), the helper the kernel shares (#560); here they
// read the browser's clock and only shape the hints, since the kernel decides by the database clock.
import { PERIOD_UNLOCK_PERMISSION } from '@crove/kernel-contract';

// Who may lock (finance.period.lock: owners and admins) and unlock (finance.period.unlock: owners, and a chief accountant
// through an org-wide role assignment, ADR-0021, #1279); the kernel checks again.
export const canLockPeriods = (role: string | null | undefined) => role === 'owner' || role === 'admin';
export const canUnlockPeriods = (role: string | null | undefined, permissions: readonly string[] = []) =>
  role === 'owner' || (role != null && permissions.includes(PERIOD_UNLOCK_PERMISSION));

export function previousMonth(month: string): string {
  const [year, m] = month.split('-').map(Number) as [number, number];
  return m === 1 ? `${year - 1}-12` : `${year}-${String(m - 1).padStart(2, '0')}`;
}

// 'MM/YYYY', as Vietnamese accounting writes a month.
export const monthLabel = (month: string) => `${month.slice(5, 7)}/${month.slice(0, 4)}`;

// A purchase invoice dated in a locked month (#478) may be posted on a later date in an open month.
// The day after a YYYY-MM-DD date: after the last locked day, the first open one.
export function nextDay(date: string): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
}

// Whether the kernel takes this posting date for an invoice whose month is locked through lockedThrough: an open day
// (after the lock), not after today. The kernel checks again, against the invoice date too.
export function postingDateAllowed(postingDate: string, lockedThrough: string, today: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(postingDate) && postingDate > lockedThrough && postingDate <= today;
}
