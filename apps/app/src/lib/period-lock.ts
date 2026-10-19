// Period lock (#329) on the ledger screen: who may lock and unlock, and months as YYYY-MM in Vietnam time, as the
// kernel counts them (finance.period.lock refuses a month that has not ended there).
// The roles that may lock (finance.period.lock) and unlock (finance.period.unlock); the kernel checks again.
export const canLockPeriods = (role: string | null | undefined) => role === 'owner' || role === 'admin';
export const canUnlockPeriods = (role: string | null | undefined) => role === 'owner';

// 'YYYY-MM' of `date` in Vietnam.
export function currentMonth(date: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit' }).formatToParts(date);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}`;
}

export function previousMonth(month: string): string {
  const [year, m] = month.split('-').map(Number) as [number, number];
  return m === 1 ? `${year - 1}-12` : `${year}-${String(m - 1).padStart(2, '0')}`;
}

// 'MM/YYYY', as Vietnamese accounting writes a month.
export const monthLabel = (month: string) => `${month.slice(5, 7)}/${month.slice(0, 4)}`;

// A purchase invoice dated in a locked month (#478) may be posted on a later date in an open month.
// 'YYYY-MM-DD' of `date` in Vietnam.
export function currentDate(date: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

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
