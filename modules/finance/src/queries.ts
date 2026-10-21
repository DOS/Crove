import { sql } from 'kysely';
import { z } from 'zod';
import { voucherCode, zId, zLocalDate, type DocumentDirection, type VoucherType } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand, defineQuery, type QueryContext } from '@crove/kernel-runtime';
import { RECEIVABLE_ACCOUNT, VAT_OUTPUT } from '@crove/l10n-vn';
import { chartAccounts, type OrgChartAccount } from './accounts.ts';
import { OPEN_REVERSAL_STATUSES, REVERSAL_KIND } from './reversal.ts';
import { VOUCHER_SOURCE } from './domain/cash-voucher.ts';
import type { PurchaseVoucher, SalesVoucher } from './misa.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const zRange = z.object({ from: zLocalDate.optional(), to: zLocalDate.optional() });

export const vendorsList = defineQuery({
  name: 'finance.vendors.list',
  // all: customers of sales too (the party picker of cash and bank vouchers, #327); vendors only otherwise.
  input: z.object({ q: z.string().max(100).optional(), all: z.boolean().optional() }),
  access: ALL,
  handler: async (ctx, input) => {
    let query = ctx.trx
      .selectFrom('crove_kernel.party as p')
      .select(['p.id', 'p.name', 'p.tax_code', 'p.address'])
      .select((eb) =>
        eb
          .selectFrom('crove_finance.vendor_account_rule as r')
          .select('r.debit_account')
          .whereRef('r.org_id', '=', 'p.org_id')
          .whereRef('r.party_id', '=', 'p.id')
          .as('default_account'),
      )
      .select((eb) =>
        eb
          .selectFrom('crove_finance.purchase_document as d')
          .select(eb.fn.countAll<string>().as('n'))
          .whereRef('d.org_id', '=', 'p.org_id')
          .whereRef('d.party_id', '=', 'p.id')
          .where('d.direction', '=', 'purchase')
          .as('document_count'),
      )
      .where('p.org_id', '=', ctx.orgId)
      .orderBy('p.name')
      .limit(500);
    // Vendors: every party but the customers of sales (issue #313) that never sold to the org.
    if (!input.all) {
      query = query.where(({ not, exists, selectFrom, and }) =>
        not(
          and([
            exists(selectFrom('crove_finance.purchase_document as s').select('s.id').whereRef('s.org_id', '=', 'p.org_id').whereRef('s.party_id', '=', 'p.id').where('s.direction', '=', 'sale')),
            not(
              exists(
                selectFrom('crove_finance.purchase_document as b').select('b.id').whereRef('b.org_id', '=', 'p.org_id').whereRef('b.party_id', '=', 'p.id').where('b.direction', '=', 'purchase'),
              ),
            ),
          ]),
        ),
      );
    }
    if (input.q) {
      const term = `%${input.q.toLowerCase()}%`;
      query = query.where((eb) => eb.or([eb(eb.fn('lower', ['p.name']), 'like', term), eb('p.tax_code', 'like', term)]));
    }
    return (await query.execute()).map((r) => ({
      id: r.id,
      name: r.name,
      taxCode: r.tax_code,
      address: r.address,
      documentCount: Number(r.document_count ?? 0),
      defaultAccount: r.default_account ?? null,
    }));
  },
});

// Recorded documents, purchases and sales (issue #313) together, newest first.
export const documentsList = defineQuery({
  name: 'finance.documents.list',
  input: zRange,
  access: ALL,
  handler: async (ctx, input) => {
    let query = ctx.trx
      .selectFrom('crove_finance.purchase_document as d')
      .innerJoin('crove_kernel.party as p', (join) => join.onRef('p.org_id', '=', 'd.org_id').onRef('p.id', '=', 'd.party_id'))
      .leftJoin('crove_finance.journal_entry as j', (join) =>
        join.onRef('j.org_id', '=', 'd.org_id').onRef('j.source_id', '=', 'd.id').on('j.source_type', '=', 'finance.purchase_document'),
      )
      .leftJoin('crove_finance.purchase_document_void as v', (join) => join.onRef('v.org_id', '=', 'd.org_id').onRef('v.document_id', '=', 'd.id'))
      .select([
        'd.id',
        'd.direction',
        'd.party_id',
        'p.name as party_name',
        'd.invoice_series',
        'd.invoice_number',
        'd.invoice_date',
        'd.subtotal',
        'd.vat_amount',
        'd.total',
        'd.source_file_id',
        'd.replaces_document_id',
        'j.id as journal_entry_id',
        'v.reversal_entry_id as void_entry_id',
        'v.reason as void_reason',
        'v.created_at as voided_at',
      ])
      .where('d.org_id', '=', ctx.orgId)
      .orderBy('d.invoice_date', 'desc')
      .orderBy('d.created_at', 'desc')
      .limit(1000);
    if (input.from) query = query.where('d.invoice_date', '>=', input.from);
    if (input.to) query = query.where('d.invoice_date', '<=', input.to);
    return (await query.execute()).map((r) => ({
      id: r.id,
      direction: r.direction,
      partyId: r.party_id,
      partyName: r.party_name,
      series: r.invoice_series,
      number: r.invoice_number,
      issueDate: r.invoice_date,
      subtotal: r.subtotal,
      vatAmount: r.vat_amount,
      total: r.total,
      journalEntryId: r.journal_entry_id,
      sourceFileId: r.source_file_id,
      voided:
        r.void_entry_id && r.voided_at
          ? { reversalEntryId: r.void_entry_id, reason: r.void_reason ?? '', voidedAt: new Date(r.voided_at).toISOString() }
          : null,
      replacesDocumentId: r.replaces_document_id,
    }));
  },
});

interface EntryRef {
  id: string;
  entryDate: string;
}

export interface JournalEntryView {
  id: string;
  entryDate: string;
  description: string;
  sourceType: string;
  sourceId: string;
  lines: Array<{ lineNo: number; accountCode: string; accountName: string; debit: string; credit: string }>;
  // The reversal link, both ways (#138): the entry this one reverses, and the entry that reversed this one.
  reverses: EntryRef | null;
  reversedBy: EntryRef | null;
  // The reversal proposal of this entry waiting for approval, if any (#204): a second request is refused meanwhile.
  pendingReversalId: string | null;
  // The document the entry records, a purchase or a sale (#313); voided once the entry is reversed (#165).
  document?: {
    id: string;
    direction: DocumentDirection;
    series: string;
    number: string;
    issueDate: string;
    partyName: string;
    partyTaxCode: string | null;
    voided: boolean;
  };
  // The cash or bank voucher the entry posts (#327).
  voucher?: { id: string; type: VoucherType; code: string; partyName: string | null };
}

export const JOURNAL_EXPORT_LIMIT = 20_000;

// Entries with their lines, newest first: those in the date range, or the one entry `id`.
async function loadEntries(
  ctx: QueryContext,
  filter: { from?: string | undefined; to?: string | undefined; limit?: number | undefined; id?: string },
): Promise<JournalEntryView[]> {
  let entries = ctx.trx
    .selectFrom('crove_finance.journal_entry as j')
    .leftJoin('crove_finance.purchase_document as d', (join) =>
      join.onRef('d.org_id', '=', 'j.org_id').onRef('d.id', '=', 'j.source_id').on('j.source_type', '=', 'finance.purchase_document'),
    )
    .leftJoin('crove_kernel.party as p', (join) => join.onRef('p.org_id', '=', 'd.org_id').onRef('p.id', '=', 'd.party_id'))
    .leftJoin('crove_finance.purchase_document_void as v', (join) => join.onRef('v.org_id', '=', 'd.org_id').onRef('v.document_id', '=', 'd.id'))
    // The cash or bank voucher the entry posts (#327), and its party.
    .leftJoin('crove_finance.cash_voucher as cv', (join) =>
      join.onRef('cv.org_id', '=', 'j.org_id').onRef('cv.id', '=', 'j.source_id').on('j.source_type', '=', VOUCHER_SOURCE),
    )
    .leftJoin('crove_kernel.party as vp', (join) => join.onRef('vp.org_id', '=', 'cv.org_id').onRef('vp.id', '=', 'cv.party_id'))
    // The original this entry reverses, and the reversal of this entry (at most one each, by the unique index).
    .leftJoin('crove_finance.journal_entry as o', (join) => join.onRef('o.org_id', '=', 'j.org_id').onRef('o.id', '=', 'j.reverses_entry_id'))
    .leftJoin('crove_finance.journal_entry as r', (join) => join.onRef('r.org_id', '=', 'j.org_id').onRef('r.reverses_entry_id', '=', 'j.id'))
    .select([
      'j.id',
      'j.entry_date',
      'j.description',
      'j.source_type',
      'j.source_id',
      'd.id as document_id',
      'd.direction',
      'd.invoice_series',
      'd.invoice_number',
      'd.invoice_date',
      'p.name as party_name',
      'p.tax_code as party_tax_code',
      'v.document_id as voided_document_id',
      'o.id as reverses_id',
      'o.entry_date as reverses_date',
      'r.id as reversed_by_id',
      'r.entry_date as reversed_by_date',
      'cv.id as voucher_id',
      'cv.voucher_type',
      'cv.number as voucher_number',
      'vp.name as voucher_party_name',
    ])
    .where('j.org_id', '=', ctx.orgId)
    .orderBy('j.entry_date', 'desc')
    .orderBy('j.created_at', 'desc')
    .limit(filter.limit ?? 1000);
  if (filter.id) entries = entries.where('j.id', '=', filter.id);
  if (filter.from) entries = entries.where('j.entry_date', '>=', filter.from);
  if (filter.to) entries = entries.where('j.entry_date', '<=', filter.to);
  const rows = await entries.execute();
  if (rows.length === 0) return [];
  const lines = await ctx.trx
    .selectFrom('crove_finance.journal_line as l')
    // A line names a TT133 account or one of the org's sub-accounts (#319), by code; the name shown is the current one.
    .leftJoin('crove_finance.account as a', 'a.code', 'l.account_code')
    .leftJoin('crove_finance.org_account as o', (join) => join.onRef('o.org_id', '=', 'l.org_id').onRef('o.code', '=', 'l.account_code'))
    .select(['l.entry_id', 'l.line_no', 'l.account_code', 'a.name as tt133_name', 'o.name as own_name', 'l.debit', 'l.credit'])
    .where('l.org_id', '=', ctx.orgId)
    .where(
      'l.entry_id',
      'in',
      rows.map((r) => r.id),
    )
    .orderBy('l.entry_id')
    .orderBy('l.line_no')
    .execute();
  // Reversal proposals waiting for approval, by the entry they name (#204).
  const pending = await ctx.trx
    .selectFrom('crove_kernel.proposal')
    .select(['id', sql<string>`pg_catalog.lower(payload->>'entryId')`.as('entry_id')])
    .where('org_id', '=', ctx.orgId)
    .where('kind', '=', REVERSAL_KIND)
    // The same statuses that refuse another request (prepare_reversal).
    .where('status', 'in', OPEN_REVERSAL_STATUSES)
    .where(
      sql<string>`pg_catalog.lower(payload->>'entryId')`,
      'in',
      rows.map((r) => r.id),
    )
    .execute();
  const pendingByEntry = new Map(pending.map((p) => [p.entry_id, p.id]));
  const byEntry = new Map<string, JournalEntryView['lines']>();
  for (const l of lines) {
    const list = byEntry.get(l.entry_id) ?? [];
    list.push({ lineNo: l.line_no, accountCode: l.account_code, accountName: l.tt133_name ?? l.own_name ?? '', debit: l.debit, credit: l.credit });
    byEntry.set(l.entry_id, list);
  }
  return rows.map((r) => ({
    id: r.id,
    entryDate: r.entry_date,
    description: r.description,
    sourceType: r.source_type,
    sourceId: r.source_id,
    lines: byEntry.get(r.id) ?? [],
    reverses: r.reverses_id && r.reverses_date ? { id: r.reverses_id, entryDate: r.reverses_date } : null,
    reversedBy: r.reversed_by_id && r.reversed_by_date ? { id: r.reversed_by_id, entryDate: r.reversed_by_date } : null,
    pendingReversalId: pendingByEntry.get(r.id) ?? null,
    ...(r.document_id && r.invoice_number && r.invoice_date && r.party_name
      ? {
          document: {
            id: r.document_id,
            direction: r.direction ?? 'purchase',
            series: r.invoice_series ?? '',
            number: r.invoice_number,
            issueDate: r.invoice_date,
            partyName: r.party_name,
            partyTaxCode: r.party_tax_code,
            voided: r.voided_document_id !== null,
          },
        }
      : {}),
    ...(r.voucher_id && r.voucher_type && r.voucher_number !== null
      ? { voucher: { id: r.voucher_id, type: r.voucher_type, code: voucherCode(r.voucher_type, r.voucher_number), partyName: r.voucher_party_name } }
      : {}),
  }));
}

export const journalList = defineQuery({
  name: 'finance.journal.list',
  input: zRange.extend({ limit: z.number().int().positive().max(JOURNAL_EXPORT_LIMIT).optional() }),
  access: ALL,
  handler: (ctx, input): Promise<JournalEntryView[]> => loadEntries(ctx, input),
});

// Records one Excel export of the journal (GET /api/export/journal.xlsx) after the workbook is built. It changes
// nothing: its audit row is the record, counted by crove_kernel.usage_weekly() (issue #311), and holds the number of
// entries exported, never their content. Same roles as finance.journal.list, which the export reads.
// The MISA SME voucher exports (GET /api/export/misa/purchases.xlsx, #317, and /api/export/misa/sales.xlsx, #313)
// record themselves here too, with `format`, so the usage report counts every export to the accountant; `entries` is
// then the number of vouchers. So do the cash receipts and payments (/api/export/misa/receipts.xlsx and
// payments.xlsx, #657).
export const EXPORT_FORMATS = ['journal', 'misa_sme_purchases', 'misa_sme_sales', 'misa_sme_cash_receipts', 'misa_sme_cash_payments'] as const;
export const journalExport = defineCommand({
  name: 'finance.journal.export',
  input: zRange.extend({
    entries: z.number().int().nonnegative().max(JOURNAL_EXPORT_LIMIT),
    format: z.enum(EXPORT_FORMATS).optional(),
  }),
  risk: 'R0',
  access: ALL,
  handler: async (ctx, input) => {
    // The range too, null for an open end (#878), so a document's history can name the exports it was in.
    const range = { from: input.from ?? null, to: input.to ?? null };
    ctx.audit(input.format ? { entries: input.entries, format: input.format, ...range } : { entries: input.entries, ...range });
    return { ok: true as const };
  },
});

interface VoucherSource {
  entryId: string;
  entryDate: string;
  description: string;
  invoice: { series: string; number: string; date: string };
  party: { name: string; taxCode: string | null; address: string | null };
  vatAmount: string;
  lines: Array<{
    lineNo: number;
    description: string;
    unit: string | null;
    quantity: string | null;
    unitPrice: string | null;
    amount: string;
    vatRate: string | null;
    // The line's account: the debit account of a purchase line, the credit (revenue) account of a sale line.
    account: string;
  }>;
}

// The recorded documents of one direction whose journal entry falls in the date range, oldest first, with their lines.
// A voided document (its entry reversed, #165) is left out: it is no longer in Crove's books.
async function loadVouchers(
  ctx: QueryContext,
  direction: DocumentDirection,
  input: { from?: string | undefined; to?: string | undefined; limit?: number | undefined },
): Promise<VoucherSource[]> {
  let documents = ctx.trx
    .selectFrom('crove_finance.journal_entry as j')
    .innerJoin('crove_finance.purchase_document as d', (join) =>
      join.onRef('d.org_id', '=', 'j.org_id').onRef('d.id', '=', 'j.source_id').on('j.source_type', '=', 'finance.purchase_document'),
    )
    .innerJoin('crove_kernel.party as p', (join) => join.onRef('p.org_id', '=', 'd.org_id').onRef('p.id', '=', 'd.party_id'))
    .leftJoin('crove_finance.purchase_document_void as v', (join) => join.onRef('v.org_id', '=', 'd.org_id').onRef('v.document_id', '=', 'd.id'))
    .select([
      'j.id as entry_id',
      'j.entry_date',
      'j.description',
      'd.id as document_id',
      'd.invoice_series',
      'd.invoice_number',
      'd.invoice_date',
      'd.vat_amount',
      'p.name as party_name',
      'p.tax_code as party_tax_code',
      'p.address as party_address',
    ])
    .where('j.org_id', '=', ctx.orgId)
    .where('d.direction', '=', direction)
    .where('j.reverses_entry_id', 'is', null)
    .where('v.document_id', 'is', null)
    .orderBy('j.entry_date')
    .orderBy('j.created_at')
    .orderBy('j.id')
    .limit(input.limit ?? 1000);
  if (input.from) documents = documents.where('j.entry_date', '>=', input.from);
  if (input.to) documents = documents.where('j.entry_date', '<=', input.to);
  const rows = await documents.execute();
  if (rows.length === 0) return [];
  const lines = await ctx.trx
    .selectFrom('crove_finance.purchase_line')
    .select(['document_id', 'line_no', 'description', 'unit', 'quantity', 'unit_price', 'amount', 'vat_rate', 'debit_account', 'credit_account'])
    .where('org_id', '=', ctx.orgId)
    .where(
      'document_id',
      'in',
      rows.map((r) => r.document_id),
    )
    .orderBy('document_id')
    .orderBy('line_no')
    .execute();
  const byDocument = new Map<string, VoucherSource['lines']>();
  for (const l of lines) {
    const list = byDocument.get(l.document_id) ?? [];
    list.push({
      lineNo: l.line_no,
      description: l.description,
      unit: l.unit,
      quantity: l.quantity,
      unitPrice: l.unit_price,
      amount: l.amount,
      vatRate: l.vat_rate,
      // Exactly one is set (purchase_line_one_account), the one of the document's direction.
      account: l.debit_account ?? l.credit_account ?? '',
    });
    byDocument.set(l.document_id, list);
  }
  return rows.map((r) => ({
    entryId: r.entry_id,
    entryDate: r.entry_date,
    description: r.description,
    invoice: { series: r.invoice_series, number: r.invoice_number, date: r.invoice_date },
    party: { name: r.party_name, taxCode: r.party_tax_code, address: r.party_address },
    vatAmount: r.vat_amount,
    lines: byDocument.get(r.document_id) ?? [],
  }));
}

const zVoucherRange = zRange.extend({ limit: z.number().int().positive().max(JOURNAL_EXPORT_LIMIT).optional() });

// Purchase vouchers for the MISA SME export (GET /api/export/misa/purchases.xlsx, issue #317).
export const purchaseVouchers = defineQuery({
  name: 'finance.vouchers.purchases',
  input: zVoucherRange,
  access: ALL,
  handler: async (ctx, input): Promise<PurchaseVoucher[]> =>
    (await loadVouchers(ctx, 'purchase', input)).map(({ party, lines, ...voucher }) => ({
      ...voucher,
      vendor: party,
      lines: lines.map(({ account, ...line }) => ({ ...line, debitAccount: account })),
    })),
});

// Sales vouchers for the MISA SME export (GET /api/export/misa/sales.xlsx, issue #313), posted as the sale was: Dr
// 131, Cr each line's revenue account, Cr 3331.
export const salesVouchers = defineQuery({
  name: 'finance.vouchers.sales',
  input: zVoucherRange,
  access: ALL,
  handler: async (ctx, input): Promise<SalesVoucher[]> =>
    (await loadVouchers(ctx, 'sale', input)).map(({ party, lines, ...voucher }) => ({
      ...voucher,
      customer: party,
      receivableAccount: RECEIVABLE_ACCOUNT,
      vatAccount: VAT_OUTPUT,
      lines: lines.map(({ account, ...line }) => ({ ...line, revenueAccount: account })),
    })),
});

export const journalGet = defineQuery({
  name: 'finance.journal.get',
  input: z.object({ id: zId }),
  access: ALL,
  handler: async (ctx, input): Promise<JournalEntryView> => {
    const [entry] = await loadEntries(ctx, { id: input.id, limit: 1 });
    if (!entry) throw new DomainError('ENTRY_NOT_FOUND', 404, 'Không tìm thấy bút toán');
    return entry;
  },
});

// Of the given proposals, those whose recorded purchase document was voided by reversing its journal entry (#165).
// The kernel asks this through ctx.query (#204), so it does not read the finance schema itself: such a proposal's file
// may be read again into a new proposal.
export const VOIDED_PROPOSALS_QUERY = 'finance.documents.voided_proposals';
export const voidedProposals = defineQuery({
  name: VOIDED_PROPOSALS_QUERY,
  input: z.object({ proposalIds: z.array(zId).max(1000) }),
  access: ALL,
  handler: async (ctx, input): Promise<string[]> => {
    if (input.proposalIds.length === 0) return [];
    const rows = await ctx.trx
      .selectFrom('crove_finance.purchase_document as d')
      .innerJoin('crove_finance.purchase_document_void as v', (join) => join.onRef('v.org_id', '=', 'd.org_id').onRef('v.document_id', '=', 'd.id'))
      .select('d.proposal_id')
      .distinct()
      .where('d.org_id', '=', ctx.orgId)
      .where('d.proposal_id', 'in', input.proposalIds)
      .execute();
    return rows.flatMap((r) => (r.proposal_id ? [r.proposal_id] : []));
  },
});

// The org's chart (#319): the TT133 accounts and the org's sub-accounts, inactive ones included (pickers hide them,
// and the journal still shows them), ordered by code so each sub-account follows its parent.
export const accountsList = defineQuery({
  name: 'finance.accounts.list',
  input: z.object({}),
  access: ALL,
  handler: async (ctx): Promise<OrgChartAccount[]> => [...(await chartAccounts(ctx)).values()].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0)),
});
