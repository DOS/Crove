import type { PurchaseProposal } from '@crove/kernel-contract';

// The journal memo and proposal title of an invoice: "HĐ <series>-<number> <supplier>" for a purchase, "HĐ bán
// <series>-<number> <customer>" for a sale (issue #313).
export function journalMemo(payload: Pick<PurchaseProposal, 'direction' | 'seller' | 'buyer'> & { invoice: Pick<PurchaseProposal['invoice'], 'series' | 'number'> }): string {
  return `${invoiceLabel(payload)} ${payload.direction === 'sale' ? payload.buyer.name : payload.seller.name}`.trim();
}

// The invoice alone, "HĐ <series>-<number>" or "HĐ bán <series>-<number>", without the party's name: for activity
// summaries, which keep no classified value (#1634).
export function invoiceLabel(payload: Pick<PurchaseProposal, 'direction'> & { invoice: Pick<PurchaseProposal['invoice'], 'series' | 'number'> }): string {
  const { invoice } = payload;
  const number = `${invoice.series ? `${invoice.series}-` : ''}${invoice.number}`;
  return payload.direction === 'sale' ? `HĐ bán ${number}` : `HĐ ${number}`;
}
