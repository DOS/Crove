// VAT working per month or quarter (issue #316): finance.vat.period reads the period's input and output invoices and
// their totals by rate (see domain/vat-return.ts for the rules and their legal sources); finance.vat.export records an
// Excel export of it (GET /api/export/vat.xlsx), like finance.journal.export.
//
// Input invoices are the recorded purchase documents, output invoices the recorded sales documents (sales e-invoices,
// issue #313); both live in crove_finance.purchase_document, told apart by direction.
import { z } from 'zod';
import type { MemberRole } from '@crove/db';
import { VAT_WARNINGS, zVatPeriod, type DocumentDirection } from '@crove/kernel-contract';
import { DomainError, defineCommand, defineQuery, type QueryContext } from '@crove/kernel-runtime';
import { money, type Money } from '@crove/l10n-vn';
import {
  documentVatByRate,
  form01Indicators,
  reducedRateApplies,
  sideTotals,
  vatMismatch,
  vatPeriod,
  type FormIndicator,
  type RateAmounts,
  type SideTotals,
  type VatPeriod,
} from './domain/vat-return.ts';

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

export interface VatReport {
  period: VatPeriod;
  input: VatSide;
  output: VatSide;
  indicators: FormIndicator[];
}

function invoiceView(
  doc: { id: string; issueDate: string; series: string; number: string; partyName: string; partyTaxCode: string | null; subtotal: string; vatAmount: string; total: string },
  lines: Array<{ amount: string; vatRate: string | null }>,
): VatInvoiceView {
  const breakdown = documentVatByRate({ vatAmount: doc.vatAmount, lines });
  const warnings: VatWarning[] = [];
  if (breakdown.rates.some((r) => r.rate === 'other')) warnings.push('rate_unknown');
  if (breakdown.allocated) warnings.push('rate_split');
  if (breakdown.rates.some((r) => r.rate === '8') && !reducedRateApplies(doc.issueDate)) warnings.push('reduced_rate_outside_period');
  const linesTaxable = breakdown.rates.reduce((acc, r) => acc.plus(money(r.taxable)), money(0));
  if (!linesTaxable.equals(money(doc.subtotal))) warnings.push('lines_mismatch');
  if (vatMismatch({ vatAmount: doc.vatAmount, lines })) warnings.push('vat_mismatch');
  return {
    id: doc.id,
    issueDate: doc.issueDate,
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

// The recorded documents of one direction dated in the period, except those voided by a reversal (#165), oldest first:
// purchases for the input side, sales (#313) for the output side. The party is the supplier or the customer.
async function periodInvoices(ctx: QueryContext, period: VatPeriod, direction: DocumentDirection): Promise<VatInvoiceView[]> {
  const docs = await ctx.trx
    .selectFrom('crove_finance.purchase_document as d')
    .innerJoin('crove_kernel.party as p', (join) => join.onRef('p.org_id', '=', 'd.org_id').onRef('p.id', '=', 'd.party_id'))
    .select(['d.id', 'd.invoice_date', 'd.invoice_series', 'd.invoice_number', 'd.subtotal', 'd.vat_amount', 'd.total', 'p.name', 'p.tax_code'])
    .where('d.org_id', '=', ctx.orgId)
    .where('d.direction', '=', direction)
    .where('d.invoice_date', '>=', period.from)
    .where('d.invoice_date', '<=', period.to)
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom('crove_finance.purchase_document_void as v').select('v.document_id').whereRef('v.org_id', '=', 'd.org_id').whereRef('v.document_id', '=', 'd.id'),
        ),
      ),
    )
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
  return docs.map((d) =>
    invoiceView(
      {
        id: d.id,
        issueDate: d.invoice_date,
        series: d.invoice_series,
        number: d.invoice_number,
        partyName: d.name,
        partyTaxCode: d.tax_code,
        subtotal: d.subtotal,
        vatAmount: d.vat_amount,
        total: d.total,
      },
      byDocument.get(d.id) ?? [],
    ),
  );
}

function side(available: boolean, documents: VatInvoiceView[]): VatSide {
  return { available, documents, totals: sideTotals(documents) };
}

export async function loadVatReport(ctx: QueryContext, periodText: string): Promise<VatReport> {
  const period = vatPeriod(periodText);
  const input = side(true, await periodInvoices(ctx, period, 'purchase'));
  // Sales are told apart by the org's tax code (#313). Without one Crove cannot know them, so the output side says it
  // is not available, unless sales were recorded while a tax code was set (they stay in the books and count).
  const org = await ctx.trx.selectFrom('crove_kernel.tenant').select('tax_code').where('org_id', '=', ctx.orgId).executeTakeFirst();
  const sales = await periodInvoices(ctx, period, 'sale');
  const output = side(Boolean(org?.tax_code) || sales.length > 0, sales);
  return { period, input, output, indicators: form01Indicators(input.totals, output.totals) };
}

export const vatPeriodQuery = defineQuery({
  name: 'finance.vat.period',
  input: zVatPeriodInput,
  access: ALL,
  handler: (ctx, input): Promise<VatReport> => loadVatReport(ctx, input.period),
});

// The taxpayer block of the HTKK return (issue #332): the org's tax code (#313) and name.
export interface VatTaxpayer {
  taxCode: string;
  name: string;
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
    const org = await ctx.trx.selectFrom('crove_kernel.tenant').select(['tax_code', 'name', 'vat_filing_period']).where('org_id', '=', ctx.orgId).executeTakeFirst();
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
    return { report: await loadVatReport(ctx, input.period), taxpayer: { taxCode: org.tax_code, name: org.name } };
  },
});

// The file formats of a VAT export: the Excel working (#316, no format in the audit row, as before) or the HTKK XML
// of form 01/GTGT (#332).
export const VAT_EXPORT_FORMATS = ['htkk_01gtgt_xml'] as const;

// Records one export of a period's VAT working after the file is built. It changes nothing: its audit row is the
// record, with the period, the number of invoices and the format, never their content. Same roles as
// finance.vat.period.
export const vatExport = defineCommand({
  name: 'finance.vat.export',
  input: zVatPeriodInput.extend({
    documents: z.number().int().nonnegative().max(2 * VAT_PERIOD_LIMIT),
    format: z.enum(VAT_EXPORT_FORMATS).optional(),
  }),
  risk: 'R0',
  access: ALL,
  handler: async (ctx, input) => {
    ctx.audit(input.format ? { period: input.period, documents: input.documents, format: input.format } : { period: input.period, documents: input.documents });
    return { ok: true as const };
  },
});
