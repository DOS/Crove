// The normalized form of a Vietnamese tax code (MST), or null when the text is not one: 10 digits (an enterprise), 10
// digits, a hyphen and 3 digits (a dependent unit), or 12 digits (an individual). Spaces and dots are ignored, and a
// dependent unit's hyphen is optional. Same rules as parseTaxCode in @crove/l10n-vn, which this package does not
// depend on (modules/finance/test/tax-code.test.ts keeps the two in step); the check digit is not enforced here.
export function normalizeTaxCode(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const compact = raw.replace(/[\s.]/g, '');
  if (/^\d{10}$/.test(compact) || /^\d{12}$/.test(compact)) return compact;
  const branch = /^(\d{10})-?(\d{3})$/.exec(compact);
  return branch ? `${branch[1]}-${branch[2]}` : null;
}
