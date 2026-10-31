// Reconciling the tax portal's purchase-invoice list with what Crove holds (issue #465). Pure functions: the portal
// rows of the period's imported lists on one side; on the other, the purchase documents Crove recorded and the
// purchase proposals still waiting in the Inbox. Amounts are decimal strings, compared through decimal.js.
//
// An invoice is the same on both sides when the seller's tax code, the series (ký hiệu hóa đơn) and the number match,
// and the template (ký hiệu mẫu số) does not contradict them (either side may lack it: AI-read invoices often do). A
// Crove invoice without a seller tax code matches on series and number when exactly one portal invoice has them.
// The amount is a check, not part of the key: a match with a different total (or VAT, or currency) is reported.
//
// The same function compares the sales list (#2141, the portal's "bán ra" export) with the org's recorded sales: the
// portal rows keep the seller that issued them (the org or one of its branches) and a recorded sale has no seller, so it
// meets a row on series and number, when exactly one portal invoice has them (the rule for an invoice without a tax
// code), and two branches' invoices of the same series and number are flagged rather than merged. "missing" is a sale
// the tax authority has that the books lack (output VAT understated), "amount_mismatch" a sale booked with another
// total or VAT. Nothing here writes to the books.
//
// Status on the portal (Trạng thái hóa đơn):
// - original, replacement, adjustment, adjusted, unknown: the invoice counts; missing from Crove means "upload it".
//   An adjusted invoice still counts (the adjustment is a separate invoice).
// - replaced, cancelled: the invoice no longer counts. Missing from Crove is right; present in Crove means the books
//   hold an invoice the tax authority no longer accepts (reverse it, or reject the proposal).
//
// Late invoices (#478, #560): the portal lists an invoice by its invoice date, the VAT working counts a purchase in the
// period of its posting date. They differ for an invoice approved after its own month was locked and posted in a later
// open month. The match stays by invoice date (that is what the portal's list holds), and the reconciliation says where
// the VAT working declares it: in its own period the item is flagged declaredInLaterPeriod (with the posting date on
// the Crove side), and in the period it was posted in it is reported as declared_late, so both periods agree with the
// VAT working instead of one of them silently disagreeing.
import { PORTAL_INVOICE_STATUSES, RECONCILE_DIFFERENCES, RECONCILE_OUTCOMES, type PortalInvoiceStatus, type ReconcileDifference, type ReconcileOutcome } from '@crove/kernel-contract';
import { approxEqual, normalizeNumber, normalizeSeries, type Money } from '@crove/l10n-vn';

export { PORTAL_INVOICE_STATUSES, RECONCILE_DIFFERENCES, RECONCILE_OUTCOMES, type PortalInvoiceStatus, type ReconcileDifference, type ReconcileOutcome };

// Statuses after which the invoice no longer counts for the period.
const VOID_STATUSES: ReadonlySet<PortalInvoiceStatus> = new Set(['replaced', 'cancelled']);

export interface PortalRow {
  listId: string;
  rowNo: number;
  sellerTaxCode: string;
  sellerName: string;
  // The buyer on a sales list's row (null on a purchase row).
  buyerTaxCode: string | null;
  template: string | null;
  series: string;
  number: string;
  issueDate: string;
  currency: string;
  subtotal: Money | null;
  vatAmount: Money | null;
  total: Money | null;
  status: PortalInvoiceStatus;
  statusLabel: string | null;
}

export interface CroveInvoice {
  // document: recorded in the books; proposal: read from a file and waiting for approval in the Inbox.
  kind: 'document' | 'proposal';
  id: string;
  sellerTaxCode: string | null;
  sellerName: string;
  // The customer of a recorded sale (null on a purchase).
  buyerTaxCode: string | null;
  buyerName: string | null;
  template: string | null;
  series: string;
  number: string;
  issueDate: string;
  currency: string;
  vatAmount: Money;
  total: Money;
  sourceFileId: string | null;
  // A recorded document's posting date (its journal entry's date), which picks its VAT period; null for a proposal.
  postingDate: string | null;
}

// The outcomes (RECONCILE_OUTCOMES, shared with the API contract):
// - matched: on both sides, amounts agree. in_inbox: the same, but Crove's copy waits in the Inbox.
// - amount_mismatch: on both sides with a different total, VAT or currency.
// - missing: a counting invoice on the portal that Crove lacks: upload its XML.
// - void_in_crove: replaced or cancelled on the portal but held by Crove (booked or waiting): reverse it or reject it.
// - void: replaced or cancelled on the portal and absent from Crove, as it should be.
// - not_on_portal: in Crove for the period but on none of the period's lists.
// - declared_late: a Crove document dated before the period and posted in it (its month was locked), on none of the
//   period's lists: the VAT working declares it in this period, while the portal lists it in its own. Nothing to do.

export interface ReconcileItem {
  outcome: ReconcileOutcome;
  portal: PortalRow | null;
  crove: CroveInvoice | null;
  differences: ReconcileDifference[];
  // Matched on series and number alone (the Crove invoice has no seller tax code).
  withoutTaxCode: boolean;
  // A portal invoice dated outside the period it was imported for.
  outsidePeriod: boolean;
  // Further rows of the same invoice on the period's lists (the same list exported twice, or two overlapping lists).
  duplicateRows: number;
  // A second copy in Crove of an invoice already matched to a portal row (not_on_portal only): reject or reverse it.
  duplicateInCrove: boolean;
  // The Crove document is dated in (or before) the period but posted after it: the VAT working declares it in the
  // period of its posting date, not in this one.
  declaredInLaterPeriod: boolean;
}

export interface ReconcileSummary {
  portalInvoices: number;
  matched: number;
  inInbox: number;
  amountMismatch: number;
  missing: number;
  voidInCrove: number;
  void: number;
  notOnPortal: number;
  declaredLate: number;
  duplicateRows: number;
}

export interface Reconciliation {
  items: ReconcileItem[];
  summary: ReconcileSummary;
}

// "1C26TAA" with template 1 (or none) is template 1, series C26TAA: some sellers write the template into the series.
// A seven-character series starting with a digit is split that way; anything else stays as written.
export function invoiceSymbol(template: string | null, series: string): { template: string | null; series: string } {
  const s = normalizeSeries(series);
  const t = template === null ? null : template.trim().toUpperCase().replace(/\s+/g, '') || null;
  const split = /^([0-9])([CK][0-9]{2}[A-Z]{3})$/.exec(s);
  if (split?.[1] && split[2] && (t === null || t === split[1])) return { template: split[1], series: split[2] };
  return { template: t, series: s };
}

const keyOf = (taxCode: string, series: string, number: string) => `${taxCode}|${series}|${normalizeNumber(number)}`;
const looseKeyOf = (series: string, number: string) => `${series}|${normalizeNumber(number)}`;

const templatesAgree = (a: string | null, b: string | null) => a === null || b === null || a === b;

function differences(portal: PortalRow, crove: CroveInvoice): ReconcileDifference[] {
  const out: ReconcileDifference[] = [];
  if (portal.currency !== crove.currency) out.push('currency');
  // Invoices round per line; one dong either way is the same amount.
  if (portal.total !== null && !approxEqual(portal.total, crove.total)) out.push('total');
  if (portal.vatAmount !== null && !approxEqual(portal.vatAmount, crove.vatAmount)) out.push('vat');
  return out;
}

const RANK: Record<ReconcileOutcome, number> = {
  missing: 0,
  void_in_crove: 1,
  amount_mismatch: 2,
  not_on_portal: 3,
  in_inbox: 4,
  matched: 5,
  declared_late: 6,
  void: 7,
};

// Posted after the period: a document dated up to the end of the period whose entry is dated after it.
function declaredLater(crove: CroveInvoice | null, period: { from: string; to: string }): boolean {
  return crove !== null && crove.postingDate !== null && crove.issueDate <= period.to && crove.postingDate > period.to;
}

// Dated before the period and posted in it: the VAT working declares it in this period (declared_late there).
function declaredHere(crove: CroveInvoice, period: { from: string; to: string }): boolean {
  return crove.postingDate !== null && crove.issueDate < period.from && crove.postingDate >= period.from && crove.postingDate <= period.to;
}

// rows: every row of the period's done, not removed lists. crove: the org's purchase documents (not voided) and
// pending purchase proposals; those dated in [from, to] that match nothing are reported as not on the portal, and
// documents dated before it but posted in it that match nothing as declared late.
export function reconcilePortalList(rows: readonly PortalRow[], crove: readonly CroveInvoice[], period: { from: string; to: string }): Reconciliation {
  // Crove's side by key. A document is preferred over a proposal for the same invoice (a pending duplicate of a booked
  // invoice is not a second invoice).
  const normalizedCrove = crove.map((c) => ({ invoice: c, ...invoiceSymbol(c.template, c.series) }));
  const byKey = new Map<string, typeof normalizedCrove>();
  const byLooseKey = new Map<string, typeof normalizedCrove>();
  for (const entry of normalizedCrove) {
    const taxCode = entry.invoice.sellerTaxCode;
    const map = taxCode ? byKey : byLooseKey;
    const key = taxCode ? keyOf(taxCode, entry.series, entry.invoice.number) : looseKeyOf(entry.series, entry.invoice.number);
    map.set(key, [...(map.get(key) ?? []), entry]);
  }
  const used = new Set<CroveInvoice>();
  // Crove invoices that repeat one already matched to a portal row.
  const duplicates = new Set<CroveInvoice>();

  // The portal's side, one invoice per key and template; later rows of the same invoice count as duplicates. When the
  // same invoice appears with different statuses (two lists exported at different times), the later list's row wins
  // only if it voids the invoice: once replaced or cancelled, an invoice stays so.
  // Rows are the same invoice by the same rule as a match: key, and templates that do not contradict (a row without a
  // template joins the invoice its key names; a template seen later fills one that was missing).
  // Per key, the invoices by template and the one without a template (there is at most one: it is only created first,
  // and the first templated row fills it), so each row finds its invoice in constant time.
  type PortalInvoice = { row: PortalRow; template: string | null; series: string; duplicates: number };
  const groups = new Map<string, { first: PortalInvoice; byTemplate: Map<string, PortalInvoice>; untemplated: PortalInvoice | null }>();
  const invoices: PortalInvoice[] = [];
  for (const row of rows) {
    const symbol = invoiceSymbol(row.template, row.series);
    const key = keyOf(row.sellerTaxCode, symbol.series, row.number);
    const group = groups.get(key);
    let seen: PortalInvoice | null = null;
    if (group) {
      if (symbol.template === null) {
        seen = group.first;
      } else {
        seen = group.byTemplate.get(symbol.template) ?? group.untemplated;
        if (seen && seen === group.untemplated) {
          seen.template = symbol.template;
          group.byTemplate.set(symbol.template, seen);
          group.untemplated = null;
        }
      }
    }
    if (!seen) {
      const created: PortalInvoice = { row, ...symbol, duplicates: 0 };
      invoices.push(created);
      if (!group) {
        groups.set(key, {
          first: created,
          byTemplate: new Map(created.template === null ? [] : [[created.template, created]]),
          untemplated: created.template === null ? created : null,
        });
      } else if (created.template !== null) {
        group.byTemplate.set(created.template, created);
      }
      continue;
    }
    seen.duplicates += 1;
    if (VOID_STATUSES.has(row.status) && !VOID_STATUSES.has(seen.row.status)) seen.row = row;
  }
  // How many portal invoices share a series and number, for the match without a tax code.
  const looseCount = new Map<string, number>();
  for (const p of invoices) looseCount.set(looseKeyOf(p.series, p.row.number), (looseCount.get(looseKeyOf(p.series, p.row.number)) ?? 0) + 1);

  const items: ReconcileItem[] = [];
  for (const p of invoices) {
    const { row } = p;
    const exact = (byKey.get(keyOf(row.sellerTaxCode, p.series, row.number)) ?? []).filter((c) => !used.has(c.invoice) && templatesAgree(c.template, p.template));
    const looseKey = looseKeyOf(p.series, row.number);
    const loose =
      exact.length === 0 && looseCount.get(looseKey) === 1
        ? (byLooseKey.get(looseKey) ?? []).filter((c) => !used.has(c.invoice) && templatesAgree(c.template, p.template))
        : [];
    const candidates = exact.length > 0 ? exact : loose;
    // One Crove invoice answers the portal row, a recorded document before a proposal. Any other candidate is a second
    // copy of the same invoice in Crove (a pending proposal of a booked invoice, or the invoice booked twice): it is not
    // used here, so it is reported below as not on the portal and marked as a duplicate.
    const match = candidates.find((c) => c.invoice.kind === 'document') ?? candidates[0];
    const crove = match?.invoice ?? null;
    if (crove) used.add(crove);
    for (const c of candidates) if (c.invoice !== crove) duplicates.add(c.invoice);
    const voided = VOID_STATUSES.has(row.status);
    const diffs = crove && !voided ? differences(row, crove) : [];
    const outcome: ReconcileOutcome = voided
      ? crove
        ? 'void_in_crove'
        : 'void'
      : !crove
        ? 'missing'
        : diffs.length > 0
          ? 'amount_mismatch'
          : crove.kind === 'proposal'
            ? 'in_inbox'
            : 'matched';
    items.push({
      outcome,
      portal: row,
      crove,
      differences: diffs,
      withoutTaxCode: crove !== null && exact.length === 0,
      outsidePeriod: row.issueDate < period.from || row.issueDate > period.to,
      duplicateRows: p.duplicates,
      duplicateInCrove: false,
      declaredInLaterPeriod: declaredLater(crove, period),
    });
  }

  for (const { invoice } of normalizedCrove) {
    const duplicate = duplicates.has(invoice);
    const outside = invoice.issueDate < period.from || invoice.issueDate > period.to;
    // Declared in this period though dated before it (posted late): reported, so the period agrees with the VAT working.
    const late = !duplicate && declaredHere(invoice, period);
    // A duplicate is reported whatever its date: the portal row it repeats may be outside the period.
    if (used.has(invoice) || (!duplicate && !late && outside)) continue;
    used.add(invoice);
    items.push({
      outcome: late ? 'declared_late' : 'not_on_portal',
      portal: null,
      crove: invoice,
      differences: [],
      withoutTaxCode: false,
      outsidePeriod: outside,
      duplicateRows: 0,
      duplicateInCrove: duplicate,
      declaredInLaterPeriod: declaredLater(invoice, period),
    });
  }

  items.sort((a, b) => {
    const rank = RANK[a.outcome] - RANK[b.outcome];
    if (rank !== 0) return rank;
    const da = a.portal?.issueDate ?? a.crove?.issueDate ?? '';
    const db = b.portal?.issueDate ?? b.crove?.issueDate ?? '';
    return da < db ? -1 : da > db ? 1 : 0;
  });

  const count = (outcome: ReconcileOutcome) => items.filter((i) => i.outcome === outcome).length;
  return {
    items,
    summary: {
      portalInvoices: invoices.length,
      matched: count('matched'),
      inInbox: count('in_inbox'),
      amountMismatch: count('amount_mismatch'),
      missing: count('missing'),
      voidInCrove: count('void_in_crove'),
      void: count('void'),
      notOnPortal: count('not_on_portal'),
      declaredLate: count('declared_late'),
      duplicateRows: invoices.reduce((sum, p) => sum + p.duplicates, 0),
    },
  };
}
