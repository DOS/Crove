// How an amount field reads when the bookkeeper is not typing in it (DESIGN.md §4.2, #1391): "32.832.000" in Vietnamese,
// "32,832,000" in English. The grouping works on the digits as text, never a JS number (AGENTS.md, money), and text that
// is not a whole amount shows as typed, so the form's own check still refuses it.
import type { Locale } from '../i18n/locale.ts';
import { normalizeAmount } from './vouchers.ts';

const SEPARATOR: Record<Locale, string> = { vi: '.', en: ',' };

export function groupAmount(text: string, locale: Locale): string {
  const digits = normalizeAmount(text);
  if (!/^\d+$/.test(digits)) return text;
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, SEPARATOR[locale]);
}
