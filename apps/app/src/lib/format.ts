// Locale-aware display formatting for money, numbers and dates. Components use the bound versions from useFormat().
import { FORMAT_LOCALE, type Locale } from '../i18n/locale.ts';

const DECIMAL = /^-?\d+(\.\d+)?$/;
const numberFormats = new Map<string, Intl.NumberFormat>();
const decimalFormats = new Map<string, Intl.NumberFormat>();
const dateFormats = new Map<Locale, Intl.DateTimeFormat>();

// The ledger keeps amounts with 4 decimals (NUMERIC(20,4)); money is shown with up to as many.
const LEDGER_DECIMALS = 4;

function numberFormat(locale: Locale, currency?: string): Intl.NumberFormat {
  const key = `${locale}|${currency ?? ''}`;
  let format = numberFormats.get(key);
  if (!format) {
    if (currency) {
      // The currency's usual decimals as the minimum (none for VND, 2 for USD), up to the ledger's 4 when the amount has
      // them: never rounded to whole đồng.
      const usual = new Intl.NumberFormat(FORMAT_LOCALE[locale], { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 0;
      format = new Intl.NumberFormat(FORMAT_LOCALE[locale], {
        style: 'currency',
        currency,
        minimumFractionDigits: usual,
        maximumFractionDigits: Math.max(usual, LEDGER_DECIMALS),
      });
    } else {
      format = new Intl.NumberFormat(FORMAT_LOCALE[locale], { maximumFractionDigits: LEDGER_DECIMALS });
    }
    numberFormats.set(key, format);
  }
  return format;
}

// A decimal string with up to `digits` decimals, exactly as given up to there (AI budgets and costs keep 6). A value
// that is not a decimal string is shown as is.
export function formatDecimal(value: string, locale: Locale, digits: number): string {
  if (!DECIMAL.test(value)) return value;
  const key = `${locale}|${digits}`;
  let format = decimalFormats.get(key);
  if (!format) {
    format = new Intl.NumberFormat(FORMAT_LOCALE[locale], { maximumFractionDigits: digits });
    decimalFormats.set(key, format);
  }
  return format.format(value as `${number}`);
}

// Formats a decimal string (e.g. "1980000.0000") as money: the currency's usual decimals (none for VND), more only
// when the amount has them, up to the 4 the ledger keeps (issue #215). So an amount the ledger holds is shown exactly
// and the lines of an entry always add up to its totals on screen; rounding each line to whole đồng could show a line
// 1 ₫ off the total it adds up to. Digits past the fourth (an invoice line read with more) round half away from zero,
// as the ledger rounds them. The string is passed to Intl.NumberFormat as is, which formats it as an exact decimal
// (Intl.NumberFormat v3: Chrome 106, Firefox 116, Safari 15.4). Older engines read it as a float, exact up to 15
// significant digits.
export function formatMoney(value: string | null | undefined, locale: Locale, currency = 'VND'): string {
  if (value === null || value === undefined || value === '') return '';
  if (!DECIMAL.test(value)) return value;
  try {
    return numberFormat(locale, currency).format(value as `${number}`);
  } catch {
    // Not an ISO 4217 code (for example a currency the extractor misread): show the amount and the code as given.
    return `${numberFormat(locale).format(value as `${number}`)} ${currency}`;
  }
}

// Counts and other plain numbers; decimal strings are formatted exactly, like money.
export function formatNumber(value: number | bigint | string, locale: Locale): string {
  if (typeof value === 'string' && !DECIMAL.test(value)) return value;
  return numberFormat(locale).format(value as number | bigint | `${number}`);
}

// A calendar date ("2026-10-16", or the date part of a timestamp) as written in the locale. Computed in UTC so the
// day never shifts with the browser's time zone.
export function formatDate(value: string | null | undefined, locale: Locale): string {
  if (!value) return '';
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return value;
  const [, y, m, d] = match;
  let format = dateFormats.get(locale);
  if (!format) {
    format = new Intl.DateTimeFormat(FORMAT_LOCALE[locale], { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' });
    dateFormats.set(locale, format);
  }
  return format.format(Date.UTC(Number(y), Number(m) - 1, Number(d)));
}

// A point in time in the browser's time zone.
// Hours and minutes in the locale's clock (24 h in Vietnamese).
export function formatTime(value: string | null | undefined, locale: Locale): string {
  if (!value) return '';
  return new Date(value).toLocaleTimeString(FORMAT_LOCALE[locale], { hour: '2-digit', minute: '2-digit' });
}

// The month and year of a point in time, in the browser's time zone ("tháng 10 năm 2026", "October 2026").
export function formatMonthYear(value: string, locale: Locale): string {
  return new Date(value).toLocaleDateString(FORMAT_LOCALE[locale], { month: 'long', year: 'numeric' });
}

// The short weekday of a point in time, in the browser's time zone ("Th 2", "Mon").
export function formatWeekdayShort(value: string, locale: Locale): string {
  return new Date(value).toLocaleDateString(FORMAT_LOCALE[locale], { weekday: 'short' });
}

export function formatDateTime(value: string | null | undefined, locale: Locale): string {
  if (!value) return '';
  return new Date(value).toLocaleString(FORMAT_LOCALE[locale], { dateStyle: 'short', timeStyle: 'short' });
}
