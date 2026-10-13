// Vietnamese tax codes (MST).
// - 10 digits: enterprise tax code with a check digit (10th digit).
// - 13 digits written as 10 + "-" + 3: a dependent unit / branch of a 10-digit code.
// - 12 digits: an individual's code, which since Circular 86/2024 equals the national ID (CCCD).
// The check digit uses the commonly published weights 31, 29, 23, 19, 17, 13, 7, 5, 3 and
// check = 10 - (weighted sum mod 11). A failed check is reported as a warning, never a hard error.

export type TaxCodeKind = 'enterprise' | 'branch' | 'individual';

export interface TaxCodeInfo {
  normalized: string;
  kind: TaxCodeKind;
  checksumValid: boolean | null;
}

const WEIGHTS = [31, 29, 23, 19, 17, 13, 7, 5, 3] as const;

export function enterpriseCheckDigit(firstNine: string): number | null {
  if (!/^\d{9}$/.test(firstNine)) return null;
  let total = 0;
  for (let i = 0; i < 9; i += 1) total += Number(firstNine[i]) * (WEIGHTS[i] ?? 0);
  const check = 10 - (total % 11);
  return check >= 0 && check <= 9 ? check : null;
}

export function parseTaxCode(raw: string | null | undefined): TaxCodeInfo | null {
  if (!raw) return null;
  const compact = raw.replace(/[\s.]/g, '');
  if (/^\d{10}$/.test(compact)) {
    const check = enterpriseCheckDigit(compact.slice(0, 9));
    return { normalized: compact, kind: 'enterprise', checksumValid: check !== null && check === Number(compact[9]) };
  }
  const branch = /^(\d{10})-?(\d{3})$/.exec(compact);
  if (branch?.[1] && branch[2]) {
    const check = enterpriseCheckDigit(branch[1].slice(0, 9));
    return {
      normalized: `${branch[1]}-${branch[2]}`,
      kind: 'branch',
      checksumValid: check !== null && check === Number(branch[1][9]),
    };
  }
  if (/^\d{12}$/.test(compact)) return { normalized: compact, kind: 'individual', checksumValid: null };
  return null;
}
