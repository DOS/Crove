// Customers and vendors on screen (issue #670). No browser or API imports, so it is unit tested.
import { normalizeTaxCode, type CustomerCursor, type CustomerPage, type PartyUpdate } from '@crove/kernel-contract';

// Where the next page of finance.customers.list starts: after the last customer of this page, when others follow.
export function nextCustomerCursor(page: CustomerPage): CustomerCursor | undefined {
  const last = page.items.at(-1);
  return page.more && last ? { name: last.name, id: last.id } : undefined;
}

// The search that finds one party on the customers screen, for links from elsewhere (a sale proposal, the receivables
// report): its tax code, which only it has, else its name. Empty when there is nothing to search by.
export function partySearch(party: { taxCode: string | null | undefined; name: string | null | undefined }): string {
  return (normalizeTaxCode(party.taxCode) ?? party.name?.trim() ?? '').slice(0, 100);
}

// The ?q= of the customers route: a string the server's search takes (at most 100 characters), or nothing. The router
// reads a digits-only value (a tax code) as a number, so a whole number counts as its digits.
export function searchParam(value: unknown): string | undefined {
  const text = typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value) : value;
  if (typeof text !== 'string') return undefined;
  const q = text.trim();
  return q && q.length <= 100 ? q : undefined;
}

export interface PartyFields {
  name: string;
  taxCode: string | null;
  email: string | null;
}

// What a correction sends: only the fields that changed (an empty tax code or email clears it), or null when nothing
// did. The server normalizes the tax code; the form shows its answer.
export function partyChanges(partyId: string, current: PartyFields, form: { name: string; taxCode: string; email: string }): PartyUpdate | null {
  const name = form.name.trim();
  const taxCode = form.taxCode.trim() || null;
  const email = form.email.trim() || null;
  const changes: PartyUpdate = { partyId };
  if (name && name !== current.name) changes.name = name;
  if (taxCode !== current.taxCode && normalizeTaxCode(taxCode) !== current.taxCode) changes.taxCode = taxCode;
  if (email !== current.email) changes.email = email;
  return Object.keys(changes).length > 1 ? changes : null;
}
