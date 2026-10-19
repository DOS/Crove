import { money } from './money.ts';

type Decimal = ReturnType<typeof money>;

/**
 * An invoice VAT rate read from text (TSuat of Decree 123 e-invoices, or what extraction read).
 * - `exempt`: "KCT" or "KKKNT", no VAT (0%).
 * - `other`: "KHAC" with an optional ratio ("KHAC:5.26%"); `percent` is null without a usable ratio (0 < r <= 100).
 * - `percent`: a plain rate, 0 to 100, with or without the percent sign.
 * - `unknown`: anything else, including a rate above 100.
 */
export type ParsedVatRate =
  | { kind: 'exempt'; code: 'KCT' | 'KKKNT'; percent: Decimal }
  | { kind: 'other'; percent: Decimal | null }
  | { kind: 'percent'; percent: Decimal }
  | { kind: 'unknown' };

const OTHER = /^KHAC(?::(\d{1,3}(?:\.\d+)?)%?)?$/;
const PLAIN = /^(\d{1,3}(?:\.\d+)?)%?$/;

/** The one VAT-rate parser (case and spaces ignored); the MISA export and the 1331/1332 split both use it. */
export function parseVatRate(rate: string | null | undefined): ParsedVatRate {
  const text = (rate ?? '').trim().toUpperCase().replace(/\s+/g, '');
  if (text === 'KCT' || text === 'KKKNT') return { kind: 'exempt', code: text, percent: money(0) };
  const other = OTHER.exec(text);
  if (other) {
    const ratio = other[1] === undefined ? null : money(other[1]);
    return { kind: 'other', percent: ratio && ratio.greaterThan(0) && ratio.lessThanOrEqualTo(100) ? ratio : null };
  }
  const plain = PLAIN.exec(text);
  if (plain?.[1] !== undefined) {
    const percent = money(plain[1]);
    if (percent.lessThanOrEqualTo(100)) return { kind: 'percent', percent };
  }
  return { kind: 'unknown' };
}
