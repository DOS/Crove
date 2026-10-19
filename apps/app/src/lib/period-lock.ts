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
