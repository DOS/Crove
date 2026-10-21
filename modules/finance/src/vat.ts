// VAT working per month or quarter (issue #316): finance.vat.period reads the period's input and output invoices and
// their totals by rate (see domain/vat-return.ts for the rules and their legal sources); finance.vat.export records an
// Excel export of it (GET /api/export/vat.xlsx), like finance.journal.export.
//
// Input invoices are the recorded purchase documents, output invoices the recorded sales documents (sales e-invoices,
// issue #313); both live in crove_finance.purchase_document, told apart by direction. A document recorded from e-invoice
// XML since #685 carries the invoice's own VAT table (crove_finance.purchase_tax_rate), which splits it by rate exactly;
// the others are split by estimate from their lines and flagged rate_split when that spreads VAT over several rates.
//
// The period of an input invoice is its posting date, the date of its journal entry (#478). That is its invoice date,
// except for an invoice recorded after its own month was locked, or dated on or before the org's opening entry (#366),
// which the approver posts on a later date: it is then declared in the period of that date, flagged declared_late when
// that is a later period than its invoice date's (posted later in the same period, it is an ordinary invoice of it).
// Source (checked 2026-10-19 against the General Department of Taxation's published answers, not the texts themselves):
// input VAT is declared in the period it arises (Law on VAT No. 48/2024/QH15, Article 14(1)(đ)), and an omission found
// later that lowers the tax payable, as a missed input invoice does, is declared in the period it is found (Decree
// 181/2025/ND-CP, Article 23(5) and (6)); one that raises it needs a supplementary return for its own period. Treating
// a late-received invoice as such an omission is an inference for the partner's accountant to confirm (#61). An output
// invoice always stays in its invoice period: a sale is never posted late (record.ts).
import { z } from 'zod';
import type { MemberRole } from '@crove/db';
import { INPUT_VAT_CHECK_OUTCOMES, VAT_WARNINGS, zId, zVatPeriod, type DocumentDirection } from '@crove/kernel-contract';
import { DomainError, defineCommand, defineQuery, type QueryContext } from '@crove/kernel-runtime';
import { money, type Money } from '@crove/l10n-vn';
import {
  documentVatByRate,
  form01Indicators,
  reducedRateApplies,
  type InvoiceRateInput,
  sideTotals,
  vatMismatch,
  vatPeriod,
  type FormIndicator,
  type RateAmounts,
  type SideTotals,
  type VatPeriod,
} from './domain/vat-return.ts';
import { needsPaymentCheck, nonCashThreshold, paymentMethodKind, type PaymentMethodKind } from './domain/non-cash-payment.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];

// More invoices than this in one period (per side) is refused rather than cut short: a partial VAT working is wrong.
export const VAT_PERIOD_LIMIT = 5_000;

export const zVatPeriodInput = z.object({ period: zVatPeriod });

// Why an invoice needs a look before the figures are filed (VAT_WARNINGS, shared with the API contract).
export { VAT_WARNINGS };
export type VatWarning = (typeof VAT_WARNINGS)[number];

export interface VatInvoiceView {
  id: string;
  issueDate: string;
  // The date of its journal entry, which chooses the period (#478).
  postingDate: string;
  series: string;
  number: string;
  partyName: string;
  partyTaxCode: string | null;
  subtotal: Money;
  vatAmount: Money;
  total: Money;
  rates: RateAmounts[];
  warnings: VatWarning[];
}

export interface VatSide {
  // false: Crove has no source for this side: the output side until the org sets its tax code (#313). The documents
  // and totals are then empty.
  available: boolean;
  documents: VatInvoiceView[];
  totals: SideTotals;
}

// An input invoice that needs proof of non-cash payment before its VAT is deducted (#917), with the accountant's mark.
export interface VatPaymentCheck {
  documentId: string;
  paymentMethod: string | null;
  methodKind: PaymentMethodKind;
  threshold: Money;
  total: Money;
  vatAmount: Money;
  mark: { outcome: 'paid_by_bank' | 'not_deductible'; voucherId: string | null; note: string | null; markedAt: string } | null;
}

export interface VatPaymentChecks {
  items: VatPaymentCheck[];
  vatAtRisk: Money;
  notDeductibleVat: Money;
  unchecked: number;
  // [24] minus the VAT marked not deductible: what [25] may hold once every item is checked.
  suggested25: Money;
}

export interface VatReport {
  period: VatPeriod;
  input: VatSide;
  output: VatSide;
  indicators: FormIndicator[];
  paymentChecks: VatPaymentChecks;
}

function invoiceView(
  period: VatPeriod,
  doc: {
    id: string;
    issueDate: string;
    postingDate: string;
    series: string;
    number: string;
    partyName: string;
    partyTaxCode: string | null;
    subtotal: string;
    vatAmount: string;
    total: string;
  },
  lines: Array<{ amount: string; vatRate: string | null }>,
  invoiceRates: InvoiceRateInput[],
): VatInvoiceView {
  const breakdown = documentVatByRate({ vatAmount: doc.vatAmount, subtotal: doc.subtotal, lines, invoiceRates });
  const warnings: VatWarning[] = [];
  if (breakdown.rates.some((r) => r.rate === 'other')) warnings.push('rate_unknown');
  if (breakdown.allocated) warnings.push('rate_split');
  if (breakdown.rates.some((r) => r.rate === '8') && !reducedRateApplies(doc.issueDate)) warnings.push('reduced_rate_outside_period');
  const linesTaxable = lines.reduce((acc, l) => acc.plus(money(l.amount)), money(0));
  if (!linesTaxable.equals(money(doc.subtotal))) warnings.push('lines_mismatch');
  if (vatMismatch({ vatAmount: doc.vatAmount, lines })) warnings.push('vat_mismatch');
  // An invoice of an earlier period, posted in this one after its own month was locked (#478).
  if (doc.issueDate < period.from) warnings.push('declared_late');
  return {
    id: doc.id,
    issueDate: doc.issueDate,
    postingDate: doc.postingDate,
    series: doc.series,
    number: doc.number,
    partyName: doc.partyName,
    partyTaxCode: doc.partyTaxCode,
    subtotal: money(doc.subtotal).toFixed(),
    vatAmount: money(doc.vatAmount).toFixed(),
    total: money(doc.total).toFixed(),
    rates: breakdown.rates,
    warnings,
  };
}

// The recorded documents of one direction in the period, except those voided by a reversal (#165), oldest first:
// purchases for the input side, by posting date (#478), and sales (#313) for the output side, by invoice date. The
// party is the supplier or the customer. Each document has exactly one entry of its own: journal_entry is unique by
// source, and a document commits only together with its entry (purchase_document_entry, #560), so the inner join drops
// none. A reversal is an entry of another source.
interface PeriodInvoice {
  view: VatInvoiceView;
  paymentMethod: string | null;
}

async function periodInvoices(ctx: QueryContext, period: VatPeriod, direction: DocumentDirection): Promise<PeriodInvoice[]> {
  const periodDate = direction === 'purchase' ? 'j.entry_date' : 'd.invoice_date';
  const docs = await ctx.trx
    .selectFrom('crove_finance.purchase_document as d')
    .innerJoin('crove_kernel.party as p', (join) => join.onRef('p.org_id', '=', 'd.org_id').onRef('p.id', '=', 'd.party_id'))
    .innerJoin('crove_finance.journal_entry as j', (join) =>
      join.onRef('j.org_id', '=', 'd.org_id').onRef('j.source_id', '=', 'd.id').on('j.source_type', '=', 'finance.purchase_document'),
    )
    .select(['d.id', 'd.invoice_date', 'j.entry_date', 'd.invoice_series', 'd.invoice_number', 'd.subtotal', 'd.vat_amount', 'd.total', 'd.payment_method', 'p.name', 'p.tax_code'])
    .where('d.org_id', '=', ctx.orgId)
    .where('d.direction', '=', direction)
    .where(periodDate, '>=', period.from)
    .where(periodDate, '<=', period.to)
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom('crove_finance.purchase_document_void as v').select('v.document_id').whereRef('v.org_id', '=', 'd.org_id').whereRef('v.document_id', '=', 'd.id'),
        ),
      ),
    )
    .orderBy(periodDate)
    .orderBy('d.invoice_date')
    .orderBy('d.invoice_series')
    .orderBy('d.invoice_number')
    .orderBy('d.id')
    .limit(VAT_PERIOD_LIMIT + 1)
    .execute();
  if (docs.length > VAT_PERIOD_LIMIT) {
    throw new DomainError('PERIOD_TOO_LARGE', 422, `Kỳ này có hơn ${VAT_PERIOD_LIMIT} hóa đơn; Crove chưa lập được bảng kê lớn như vậy`);
  }
  if (docs.length === 0) return [];
  const lines = await ctx.trx
    .selectFrom('crove_finance.purchase_line')
    .select(['document_id', 'amount', 'vat_rate'])
    .where('org_id', '=', ctx.orgId)
    .where(
      'document_id',
      'in',
      docs.map((d) => d.id),
    )
    .orderBy('document_id')
    .orderBy('line_no')
    .execute();
  const byDocument = new Map<string, Array<{ amount: string; vatRate: string | null }>>();
  for (const line of lines) {
    const list = byDocument.get(line.document_id) ?? [];
    list.push({ amount: line.amount, vatRate: line.vat_rate });
    byDocument.set(line.document_id, list);
  }
  // The invoice's own VAT table, for the documents recorded from e-invoice XML since #685.
  const rateRows = await ctx.trx
    .selectFrom('crove_finance.purchase_tax_rate')
    .select(['document_id', 'vat_rate', 'taxable_amount', 'vat_amount'])
    .where('org_id', '=', ctx.orgId)
    .where(
      'document_id',
      'in',
      docs.map((d) => d.id),
    )
    .orderBy('document_id')
    .orderBy('row_no')
    .execute();
  const ratesByDocument = new Map<string, InvoiceRateInput[]>();
  for (const row of rateRows) {
    const list = ratesByDocument.get(row.document_id) ?? [];
    list.push({ rate: row.vat_rate, taxable: row.taxable_amount, vat: row.vat_amount });
    ratesByDocument.set(row.document_id, list);
  }
  return docs.map((d) => ({
    paymentMethod: d.payment_method,
    view: invoiceView(
      period,
      {
        id: d.id,
        issueDate: d.invoice_date,
        postingDate: d.entry_date,
        series: d.invoice_series,
        number: d.invoice_number,
        partyName: d.name,
        partyTaxCode: d.tax_code,
        subtotal: d.subtotal,
        vatAmount: d.vat_amount,
        total: d.total,
      },
      byDocument.get(d.id) ?? [],
      ratesByDocument.get(d.id) ?? [],
    ),
  }));
}

function side(available: boolean, documents: VatInvoiceView[]): VatSide {
  return { available, documents, totals: sideTotals(documents) };
}

type CheckMark = NonNullable<VatPaymentCheck['mark']>;

// The latest mark of each of the org's documents in ids (#917); a cleared mark counts as none.
async function latestMarks(ctx: QueryContext, ids: string[]): Promise<Map<string, CheckMark>> {
  const marks = new Map<string, CheckMark>();
  if (ids.length === 0) return marks;
  const rows = await ctx.trx
    .selectFrom('crove_finance.input_vat_check')
    .select(['document_id', 'outcome', 'voucher_id', 'note', 'created_at'])
    .distinctOn('document_id')
    .where('org_id', '=', ctx.orgId)
    .where('document_id', 'in', ids)
    .orderBy('document_id')
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .execute();
  for (const row of rows) {
    if (row.outcome === 'cleared') continue;
    marks.set(row.document_id, { outcome: row.outcome, voucherId: row.voucher_id, note: row.note, markedAt: new Date(row.created_at).toISOString() });
  }
  return marks;
}

// The input invoices of the period that need proof of non-cash payment, and the [25] they leave (#917).
function paymentChecks(input: PeriodInvoice[], marks: Map<string, CheckMark>, vat24: Money): VatPaymentChecks {
  const items: VatPaymentCheck[] = [];
  let atRisk = money(0);
  let notDeductible = money(0);
  let unchecked = 0;
  for (const { view, paymentMethod } of input) {
    if (!needsPaymentCheck({ issueDate: view.issueDate, total: view.total, paymentMethod })) continue;
    const mark = marks.get(view.id) ?? null;
    if (mark?.outcome !== 'paid_by_bank') atRisk = atRisk.plus(money(view.vatAmount));
    if (mark?.outcome === 'not_deductible') notDeductible = notDeductible.plus(money(view.vatAmount));
    if (!mark) {
      unchecked += 1;
      // Flagged on its row too, until the accountant marks it.
      view.warnings.push('check_payment');
    }
    items.push({
      documentId: view.id,
      paymentMethod,
      methodKind: paymentMethodKind(paymentMethod),
      threshold: nonCashThreshold(view.issueDate).amount,
      total: view.total,
      vatAmount: view.vatAmount,
      mark,
    });
  }
  return {
    items,
    vatAtRisk: atRisk.toFixed(),
    notDeductibleVat: notDeductible.toFixed(),
    unchecked,
    suggested25: money(vat24).minus(notDeductible).toFixed(),
  };
}

export async function loadVatReport(ctx: QueryContext, periodText: string): Promise<VatReport> {
  const period = vatPeriod(periodText);
  const purchases = await periodInvoices(ctx, period, 'purchase');
  const marks = await latestMarks(
    ctx,
    purchases.map((p) => p.view.id),
  );
  const input = side(
    true,
    purchases.map((p) => p.view),
  );
  // Sales are told apart by the org's tax code (#313). Without one Crove cannot know them, so the output side says it
  // is not available, unless sales were recorded while a tax code was set (they stay in the books and count).
  const org = await ctx.trx.selectFrom('crove_kernel.tenant').select('tax_code').where('org_id', '=', ctx.orgId).executeTakeFirst();
  const sales = (await periodInvoices(ctx, period, 'sale')).map((p) => p.view);
  const output = side(Boolean(org?.tax_code) || sales.length > 0, sales);
  return { period, input, output, indicators: form01Indicators(input.totals, output.totals), paymentChecks: paymentChecks(purchases, marks, input.totals.vat) };
}

export const vatPeriodQuery = defineQuery({
  name: 'finance.vat.period',
  input: zVatPeriodInput,
  access: ALL,
  handler: (ctx, input): Promise<VatReport> => loadVatReport(ctx, input.period),
});

// The taxpayer block of the HTKK return (issue #332): the org's tax code (#313), name and address (#324, #692).
export interface VatTaxpayer {
  taxCode: string;
  name: string;
  address: string | null;
}

export interface VatDeclaration {
  report: VatReport;
  taxpayer: VatTaxpayer;
}

// The VAT working of a period with the taxpayer it is declared for, for the HTKK XML export
// (GET /api/export/vat-01gtgt.xml). A return names the taxpayer's tax code, so an org without one is refused.
export const vatDeclarationQuery = defineQuery({
  name: 'finance.vat.declaration',
  input: zVatPeriodInput,
  access: ALL,
  handler: async (ctx, input): Promise<VatDeclaration> => {
    const org = await ctx.trx.selectFrom('crove_kernel.tenant').select(['tax_code', 'name', 'address', 'vat_filing_period']).where('org_id', '=', ctx.orgId).executeTakeFirst();
    if (!org?.tax_code) {
      throw new DomainError('TAX_CODE_REQUIRED', 422, 'Tổ chức chưa có mã số thuế. Nhập mã số thuế trong Cài đặt rồi xuất lại.');
    }
    // A return is filed for the org's filing period (#318): a monthly filer does not file a quarterly return. Unset
    // means nobody said, so either kind is allowed. Only the XML is refused; the Excel working stays open for any
    // period as an analysis tool (it is not a filing).
    const kind = vatPeriod(input.period).kind;
    if (org.vat_filing_period && org.vat_filing_period !== kind) {
      throw new DomainError(
        'PERIOD_KIND_MISMATCH',
        422,
        org.vat_filing_period === 'month'
          ? 'Tổ chức khai thuế GTGT theo tháng nên không xuất được tờ khai XML theo quý. Chọn một tháng, hoặc đổi kỳ khai trong Cài đặt.'
          : 'Tổ chức khai thuế GTGT theo quý nên không xuất được tờ khai XML theo tháng. Chọn một quý, hoặc đổi kỳ khai trong Cài đặt.',
      );
    }
    return { report: await loadVatReport(ctx, input.period), taxpayer: { taxCode: org.tax_code, name: org.name, address: org.address } };
  },
});

// The file formats of a VAT export: the Excel working (#316, no format in the audit row, as before) or the HTKK XML
// of form 01/GTGT (#332).
export const VAT_EXPORT_FORMATS = ['htkk_01gtgt_xml'] as const;

// Records one export of a period's VAT working after the file is built. It changes nothing: its audit row is the
// record, with the period, the number of invoices, the format and the [25] choice, never their content. Same roles as
// finance.vat.period.
export const vatExport = defineCommand({
  name: 'finance.vat.export',
  input: zVatPeriodInput.extend({
    documents: z.number().int().nonnegative().max(2 * VAT_PERIOD_LIMIT),
    format: z.enum(VAT_EXPORT_FORMATS).optional(),
    // The HTKK XML with [25] = [24] (#692), or with the suggested [25] (#917), the accountant's choice for that download.
    deductInput: z.boolean().optional(),
    deductSuggested: z.boolean().optional(),
  }),
  risk: 'R0',
  access: ALL,
  handler: async (ctx, input) => {
    ctx.audit({
      period: input.period,
      documents: input.documents,
      ...(input.format ? { format: input.format } : {}),
      ...(input.deductInput ? { deduct_input: true } : {}),
      ...(input.deductSuggested ? { deduct_suggested: true } : {}),
    });
    return { ok: true as const };
  },
});

const MARKERS: readonly MemberRole[] = ['owner', 'admin', 'member'];

// The accountant's mark on an input invoice that needs proof of non-cash payment (#917): paid_by_bank (optionally
// with the bank voucher, báo Nợ, that paid it), not_deductible, or cleared. One appended row per mark; the latest is the
// invoice's state, and the audit row records each one. It changes no figure of the books: only the suggested [25].
export const vatPaymentMark = defineCommand({
  name: 'finance.vat.payment_mark',
  input: z.object({
    documentId: zId,
    outcome: z.enum(INPUT_VAT_CHECK_OUTCOMES),
    voucherId: zId.nullable().optional(),
    note: z.string().trim().min(1).max(500).nullable().optional(),
  }),
  risk: 'R1',
  access: MARKERS,
  handler: async (ctx, input) => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới đánh dấu được hóa đơn');
    const doc = await ctx.trx
      .selectFrom('crove_finance.purchase_document as d')
      .select(['d.id', 'd.direction', 'd.invoice_date', 'd.total', 'd.payment_method'])
      .where('d.org_id', '=', ctx.orgId)
      .where('d.id', '=', input.documentId)
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom('crove_finance.purchase_document_void as v').select('v.document_id').whereRef('v.org_id', '=', 'd.org_id').whereRef('v.document_id', '=', 'd.id'),
          ),
        ),
      )
      .executeTakeFirst();
    if (!doc || doc.direction !== 'purchase') throw new DomainError('NOT_FOUND', 404, 'Không tìm thấy hóa đơn mua vào');
    if (!needsPaymentCheck({ issueDate: doc.invoice_date, total: doc.total, paymentMethod: doc.payment_method })) {
      throw new DomainError('NOT_FLAGGED', 409, 'Hóa đơn này không cần kiểm tra chứng từ thanh toán không dùng tiền mặt');
    }
    const voucherId = input.voucherId ?? null;
    if (voucherId !== null) {
      if (input.outcome !== 'paid_by_bank') throw new DomainError('VOUCHER_NOT_BANK', 422, 'Chỉ gắn chứng từ ngân hàng khi hóa đơn đã thanh toán qua ngân hàng');
      const voucher = await ctx.trx
        .selectFrom('crove_finance.cash_voucher')
        .select('voucher_type')
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', voucherId)
        .executeTakeFirst();
      if (voucher?.voucher_type !== 'bank_debit') throw new DomainError('VOUCHER_NOT_BANK', 422, 'Chứng từ này không phải giấy báo Nợ của tổ chức');
    }
    const note = input.note ?? null;
    await ctx.trx
      .insertInto('crove_finance.input_vat_check')
      .values({ org_id: ctx.orgId, document_id: doc.id, outcome: input.outcome, voucher_id: voucherId, note, marked_by: ctx.actor.userId })
      .execute();
    ctx.audit({ document_id: doc.id, outcome: input.outcome, ...(voucherId ? { voucher_id: voucherId } : {}) });
    return { documentId: doc.id, outcome: input.outcome };
  },
});
