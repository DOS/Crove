// Customers on screen (issue #670). No browser or API imports, so it is unit tested.
import { normalizeTaxCode, type CustomerCursor, type CustomerPage } from '@crove/kernel-contract';

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
