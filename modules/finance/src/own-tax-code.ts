// Whether an invoice party's tax code is the org's own (issue #313), its branch codes included (#686): a company that
// issues invoices from a branch prints `<its 10-digit code>-NNN` as the seller, and those are its own sales. Both codes
// are compared normalized (parseTaxCode, as kernel.org.set_tax_code stores the org's). An org whose own code is a
// branch code owns only that code: the head office and the other branches are other taxpayers in its books.
import { parseTaxCode } from '@crove/l10n-vn';

export function isOwnTaxCode(code: string | null | undefined, orgTaxCode: string | null | undefined): boolean {
  const party = parseTaxCode(code);
  const org = parseTaxCode(orgTaxCode);
  if (!party || !org) return false;
  if (party.normalized === org.normalized) return true;
  return org.kind === 'enterprise' && party.kind === 'branch' && party.normalized.startsWith(`${org.normalized}-`);
}
