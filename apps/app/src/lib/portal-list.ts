// The tax portal reconciliation screen (issue #465): who may import a list, which sections the outcomes fall into and
// in what order, and when to poll. The kernel decides every rule; these only arrange its answer.
import { z } from 'zod';
import { MAX_IMPORT_BYTES, type MissingInvoiceStatusView, type PortalListDirection, type PortalReconciliation, type ReconcileOutcome } from '@crove/kernel-contract';
import { readSearch, type Defined } from './search.ts';
import { periodChoiceOf } from './vat.ts';

export type ReconcileItem = PortalReconciliation['items'][number];

// ?period= (as the VAT screen, #1513) and ?direction=sale of the screen: the sales tab (#2141), left out for the
// purchase list, so a notification about a sales list opens the right tab.
const zPortalSearch = z.object({
  period: z.string().refine((key) => periodChoiceOf(key) !== null).optional().catch(undefined),
  direction: z.literal('sale').optional().catch(undefined),
});
export type PortalSearch = Defined<z.output<typeof zPortalSearch>>;
export const parsePortalSearch = (search: Record<string, unknown>): PortalSearch => readSearch(zPortalSearch, search);

// The search to write for a picked period and tab: the default period and the purchase tab leave no param.
export function portalSearch(key: string, defaultKey: string, direction: PortalListDirection): PortalSearch {
  return { ...(key === defaultKey ? {} : { period: key }), ...(direction === 'sale' ? { direction: 'sale' as const } : {}) };
}

// The roles that may import and remove lists (finance.portal_list.import and .remove); the kernel checks again.
export function canImportPortalList(role: string | null | undefined): boolean {
  return role === 'owner' || role === 'admin' || role === 'member';
}

// Sections of the screen, what needs work first. The last three are folded away by default: nothing to do there.
// declared_late (#560) lists the invoices of earlier periods the VAT working declares in this one.
export const SECTIONS: ReadonlyArray<{ outcome: ReconcileOutcome; folded: boolean }> = [
  { outcome: 'missing', folded: false },
  { outcome: 'void_in_crove', folded: false },
  { outcome: 'amount_mismatch', folded: false },
  { outcome: 'not_on_portal', folded: false },
  { outcome: 'in_inbox', folded: false },
  { outcome: 'matched', folded: true },
  { outcome: 'declared_late', folded: true },
  { outcome: 'void', folded: true },
];

export function itemsByOutcome(items: readonly ReconcileItem[]): Map<ReconcileOutcome, ReconcileItem[]> {
  const out = new Map<ReconcileOutcome, ReconcileItem[]>();
  for (const item of items) {
    const bucket = out.get(item.outcome);
    if (bucket) bucket.push(item);
    else out.set(item.outcome, [item]);
  }
  return out;
}

// How many items an outcome has in all (the summary counts every item; the list may stop short, #506).
export function outcomeTotal(summary: PortalReconciliation['summary'], outcome: ReconcileOutcome): number {
  switch (outcome) {
    case 'missing':
      return summary.missing;
    case 'void_in_crove':
      return summary.voidInCrove;
    case 'amount_mismatch':
      return summary.amountMismatch;
    case 'not_on_portal':
      return summary.notOnPortal;
    case 'in_inbox':
      return summary.inInbox;
    case 'matched':
      return summary.matched;
    case 'declared_late':
      return summary.declaredLate;
    case 'void':
      return summary.void;
  }
}

// While a list is being read the screen asks again every few seconds.
export function pollWhilePending(data: PortalReconciliation | undefined, ms = 2000): number | false {
  return data?.lists.some((l) => l.status === 'pending') ? ms : false;
}

// What the file picker checks before uploading; the server checks the bytes again.
export function pickProblem(file: { name: string; size: number }): 'not_xlsx' | 'too_large' | null {
  if (/\.xls$/i.test(file.name) || !/\.xlsx$/i.test(file.name)) return 'not_xlsx';
  if (file.size > MAX_IMPORT_BYTES) return 'too_large';
  return null;
}

// Series and number as the portal shows them ("1C26TAA-123", template included when known).
export function invoiceLabel(invoice: { template: string | null; series: string; number: string }): string {
  return `${invoice.template ?? ''}${invoice.series}-${invoice.number}`;
}

// Asking the company for its missing invoices (issue #669).
export type MissingInvoiceMail = MissingInvoiceStatusView['mails'][number];

// "09/2026" or "Q3/2026", the same in every language.
export function formatPeriod(period: string): string {
  const [year, part] = period.split('-');
  return `${part}/${year}`;
}

// Polls the request history while a mail is still waiting or being sent.
export function pollWhileSending(data: MissingInvoiceStatusView | undefined, ms = 2000): number | false {
  return data?.mails.some((m) => m.status === 'queued' || m.status === 'sending') ? ms : false;
}

// Statuses after which nothing went out, shown as a warning.
export function mailFailed(status: MissingInvoiceMail['status']): boolean {
  return status === 'suppressed' || status === 'failed' || status === 'bounced' || status === 'complained' || status === 'ambiguous';
}
