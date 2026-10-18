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

export const RECONCILE_OUTCOMES = ['matched', 'in_inbox', 'amount_mismatch', 'missing', 'void_in_crove', 'void', 'not_on_portal'] as const;
export type ReconcileOutcome = (typeof RECONCILE_OUTCOMES)[number];

export const RECONCILE_DIFFERENCES = ['total', 'vat', 'currency'] as const;
export type ReconcileDifference = (typeof RECONCILE_DIFFERENCES)[number];

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
});

export const zReconcileItem = z.object({
  outcome: z.enum(RECONCILE_OUTCOMES),
  portal: zPortalRow.nullable(),
  crove: zCroveInvoice.nullable(),
  differences: z.array(z.enum(RECONCILE_DIFFERENCES)),
  withoutTaxCode: z.boolean(),
  outsidePeriod: z.boolean(),
  duplicateRows: z.number().int().nonnegative(),
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
    duplicateRows: z.number().int().nonnegative(),
  }),
  items: z.array(zReconcileItem),
});
export type PortalReconciliation = z.infer<typeof zPortalReconciliation>;
