// Calendar dates and months in Vietnam (UTC+7 all year: no daylight saving), the one helper for "today" and "this
// month" that the kernel, the modules and the SPA share (#560). The books count days and months there: a period lock,
// a posting date, a VAT period, a return's date.
//
// Which clock: these read the caller's clock (a Date, the process clock by default). A rule the database enforces
// reads the database clock instead, so every check of one rule agrees whichever process runs it: lock_period() refuses
// a month that has not ended by pg_catalog.now(), and the "not after today" bound of a late posting date reads the
// same clock in the posting's transaction (@crove/mod-finance period-lock.ts, databaseToday). The SPA uses these for
// its hints only; the kernel checks again.
export const VIETNAM_TIME_ZONE = 'Asia/Ho_Chi_Minh';

const VIETNAM_OFFSET_MS = 7 * 3_600_000;

// 'YYYY-MM-DD' of `now` in Vietnam.
export function vietnamToday(now: Date = new Date()): string {
  return new Date(now.getTime() + VIETNAM_OFFSET_MS).toISOString().slice(0, 10);
}

// 'YYYY-MM' of `now` in Vietnam.
export function vietnamMonth(now: Date = new Date()): string {
  return vietnamToday(now).slice(0, 7);
}
