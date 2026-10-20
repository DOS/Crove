// The tax portal's purchase-invoice list (issue #465): an .xlsx the accountant exports from hoadondientu.gdt.gov.vn,
// imported per VAT period and reconciled with the purchase documents and pending proposals Crove holds. The rules
// are in @crove/mod-finance (domain/portal-reconcile.ts); these are the shapes the API and the SPA share.
import { z } from 'zod';
import { zId, zLocalDate, zMoney, zVatPeriod } from './schemas.ts';

// How the portal describes an invoice (Trạng thái hóa đơn), read into these. replaced and cancelled no longer count.
export const PORTAL_INVOICE_STATUSES = ['original', 'replacement', 'adjustment', 'replaced', 'adjusted', 'cancelled', 'unknown'] as const;
export type PortalInvoiceStatus = (typeof PORTAL_INVOICE_STATUSES)[number];

export const PORTAL_LIST_STATUSES = ['pending', 'done', 'failed'] as const;
export type PortalListStatus = (typeof PORTAL_LIST_STATUSES)[number];

// declared_late (#560): a Crove document of an earlier invoice date, posted in this period after its own month was
// locked (#478). The VAT working declares it here; the portal lists it under its invoice date, in an earlier period.
export const RECONCILE_OUTCOMES = ['matched', 'in_inbox', 'amount_mismatch', 'missing', 'void_in_crove', 'void', 'not_on_portal', 'declared_late'] as const;
export type ReconcileOutcome = (typeof RECONCILE_OUTCOMES)[number];

export const RECONCILE_DIFFERENCES = ['total', 'vat', 'currency'] as const;
export type ReconcileDifference = (typeof RECONCILE_DIFFERENCES)[number];

// Why a row of the sheet that names an invoice was not read (the same reasons as @crove/extract-contract's
// PORTAL_LIST_SKIP_REASONS; modules/finance/test/portal-reconcile.test.ts checks they agree).
export const PORTAL_LIST_SKIP_REASONS = ['no_tax_code', 'bad_tax_code', 'no_number', 'no_series', 'bad_date', 'bad_amount', 'too_long'] as const;
export type PortalListSkipReason = (typeof PORTAL_LIST_SKIP_REASONS)[number];

// Lists imported for one period while not removed; more is refused (the portal exports a month at a time, per tab).
export const MAX_PORTAL_LISTS_PER_PERIOD = 12;

export const zPortalList = z.object({
  id: zId,
  period: zVatPeriod,
  fileId: zId,
  filename: z.string(),
  status: z.enum(PORTAL_LIST_STATUSES),
  error: z.string().nullable(),
  rowCount: z.number().int().nonnegative().nullable(),
  listFrom: zLocalDate.nullable(),
  listTo: zLocalDate.nullable(),
  // Rows that name an invoice but could not be read: the comparison is incomplete while there are any.
  skippedCount: z.number().int().nonnegative(),
  skipped: z.array(z.object({ rowNo: z.number().int().positive(), reason: z.enum(PORTAL_LIST_SKIP_REASONS) })),
  // Rows left out because they are not the org's purchases: its own sales, and invoices naming another buyer (#506).
  // Expected on a mixed export; a misread buyer code would hide an invoice, so the screen shows them.
  ownSalesCount: z.number().int().nonnegative(),
  otherBuyerCount: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
});
export type PortalListView = z.infer<typeof zPortalList>;

export const zPortalRow = z.object({
  listId: zId,
  rowNo: z.number().int().positive(),
  sellerTaxCode: z.string(),
  sellerName: z.string(),
  template: z.string().nullable(),
  series: z.string(),
  number: z.string(),
  issueDate: zLocalDate,
  currency: z.string(),
  subtotal: zMoney.nullable(),
  vatAmount: zMoney.nullable(),
  total: zMoney.nullable(),
  status: z.enum(PORTAL_INVOICE_STATUSES),
  statusLabel: z.string().nullable(),
});

export const zCroveInvoice = z.object({
  kind: z.enum(['document', 'proposal']),
  id: zId,
  sellerTaxCode: z.string().nullable(),
  sellerName: z.string(),
  template: z.string().nullable(),
  series: z.string(),
  number: z.string(),
  issueDate: zLocalDate,
  currency: z.string(),
  vatAmount: zMoney,
  total: zMoney,
  sourceFileId: zId.nullable(),
  // A recorded document's posting date, the date of its journal entry, which picks its VAT period (#478); null for a
  // proposal.
  postingDate: zLocalDate.nullable(),
});

export const zReconcileItem = z.object({
  outcome: z.enum(RECONCILE_OUTCOMES),
  portal: zPortalRow.nullable(),
  crove: zCroveInvoice.nullable(),
  differences: z.array(z.enum(RECONCILE_DIFFERENCES)),
  withoutTaxCode: z.boolean(),
  outsidePeriod: z.boolean(),
  duplicateRows: z.number().int().nonnegative(),
  duplicateInCrove: z.boolean(),
  // The Crove document is dated in (or, matched to a row of this period's lists, before) this period but posted after
  // it (#478): the VAT working declares it in the period of its posting date (crove.postingDate), flagged declared_late
  // there, not in this one (#560).
  declaredInLaterPeriod: z.boolean(),
});

export const zPortalReconciliation = z.object({
  period: z.object({ period: zVatPeriod, kind: z.enum(['month', 'quarter']), from: zLocalDate, to: zLocalDate }),
  lists: z.array(zPortalList),
  summary: z.object({
    portalInvoices: z.number().int().nonnegative(),
    matched: z.number().int().nonnegative(),
    inInbox: z.number().int().nonnegative(),
    amountMismatch: z.number().int().nonnegative(),
    missing: z.number().int().nonnegative(),
    voidInCrove: z.number().int().nonnegative(),
    void: z.number().int().nonnegative(),
    notOnPortal: z.number().int().nonnegative(),
    declaredLate: z.number().int().nonnegative(),
    duplicateRows: z.number().int().nonnegative(),
  }),
  // At most a fixed number of items per outcome (the first ones, what needs work first); the summary counts all of
  // them. truncated: some outcome has more items than are listed.
  items: z.array(zReconcileItem),
  truncated: z.boolean(),
});
export type PortalReconciliation = z.infer<typeof zPortalReconciliation>;
