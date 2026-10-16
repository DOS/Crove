// Locale-aware display formatting for money, numbers and dates. Components use the bound versions from useFormat().
import { FORMAT_LOCALE, type Locale } from '../i18n/locale.ts';

const DECIMAL = /^-?\d+(\.\d+)?$/;
const numberFormats = new Map<string, Intl.NumberFormat>();

function numberFormat(locale: Locale, currency?: string): Intl.NumberFormat {
  const key = `${locale}|${currency ?? ''}`;
  let format = numberFormats.get(key);
  if (!format) {
    format = new Intl.NumberFormat(FORMAT_LOCALE[locale], currency ? { style: 'currency', currency } : { maximumFractionDigits: 4 });
    numberFormats.set(key, format);
  }
  return format;
}

// Formats a decimal string (e.g. "1980000.0000") as money in the currency's usual precision (no decimals for VND).
// The string is passed to Intl.NumberFormat as is, which formats it as an exact decimal (ES2023), never as a float.
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
  return new Intl.DateTimeFormat(FORMAT_LOCALE[locale], { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' }).format(
    Date.UTC(Number(y), Number(m) - 1, Number(d)),
  );
}

// A point in time in the browser's time zone.
export function formatDateTime(value: string | null | undefined, locale: Locale): string {
  if (!value) return '';
  return new Date(value).toLocaleString(FORMAT_LOCALE[locale], { dateStyle: 'short', timeStyle: 'short' });
}
