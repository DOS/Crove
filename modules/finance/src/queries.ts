import { z } from 'zod';
import { zLocalDate } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { defineQuery } from '@crove/kernel-runtime';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const zRange = z.object({ from: zLocalDate.optional(), to: zLocalDate.optional() });

export const vendorsList = defineQuery({
  name: 'finance.vendors.list',
  input: z.object({ q: z.string().max(100).optional() }),
  access: ALL,
  handler: async (ctx, input) => {
    let query = ctx.trx
      .selectFrom('crove_kernel.party as p')
      .select(['p.id', 'p.name', 'p.tax_code', 'p.address'])
      .select((eb) =>
        eb
          .selectFrom('crove_finance.purchase_document as d')
          .select(eb.fn.countAll<string>().as('n'))
          .whereRef('d.org_id', '=', 'p.org_id')
          .whereRef('d.party_id', '=', 'p.id')
          .as('document_count'),
      )
      .where('p.org_id', '=', ctx.orgId)
      .orderBy('p.name')
      .limit(500);
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
    }));
  },
});

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
      .select([
        'd.id',
        'd.party_id',
        'p.name as party_name',
        'd.invoice_series',
        'd.invoice_number',
        'd.invoice_date',
        'd.subtotal',
        'd.vat_amount',
        'd.total',
        'd.source_file_id',
        'j.id as journal_entry_id',
      ])
      .where('d.org_id', '=', ctx.orgId)
      .orderBy('d.invoice_date', 'desc')
      .orderBy('d.created_at', 'desc')
      .limit(1000);
    if (input.from) query = query.where('d.invoice_date', '>=', input.from);
    if (input.to) query = query.where('d.invoice_date', '<=', input.to);
    return (await query.execute()).map((r) => ({
      id: r.id,
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
    }));
  },
});

export interface JournalEntryView {
  id: string;
  entryDate: string;
  description: string;
  sourceType: string;
  sourceId: string;
  lines: Array<{ lineNo: number; accountCode: string; accountName: string; debit: string; credit: string }>;
  document?: { series: string; number: string; issueDate: string; partyName: string; partyTaxCode: string | null };
}

export const journalList = defineQuery({
  name: 'finance.journal.list',
  input: zRange,
  access: ALL,
  handler: async (ctx, input): Promise<JournalEntryView[]> => {
    let entries = ctx.trx
      .selectFrom('crove_finance.journal_entry as j')
      .leftJoin('crove_finance.purchase_document as d', (join) =>
        join.onRef('d.org_id', '=', 'j.org_id').onRef('d.id', '=', 'j.source_id'),
      )
      .leftJoin('crove_kernel.party as p', (join) => join.onRef('p.org_id', '=', 'd.org_id').onRef('p.id', '=', 'd.party_id'))
      .select([
        'j.id',
        'j.entry_date',
        'j.description',
        'j.source_type',
        'j.source_id',
        'd.invoice_series',
        'd.invoice_number',
        'd.invoice_date',
        'p.name as party_name',
        'p.tax_code as party_tax_code',
      ])
      .where('j.org_id', '=', ctx.orgId)
      .orderBy('j.entry_date', 'desc')
      .orderBy('j.created_at', 'desc')
      .limit(1000);
    if (input.from) entries = entries.where('j.entry_date', '>=', input.from);
    if (input.to) entries = entries.where('j.entry_date', '<=', input.to);
    const rows = await entries.execute();
    if (rows.length === 0) return [];
    const lines = await ctx.trx
      .selectFrom('crove_finance.journal_line as l')
      .innerJoin('crove_finance.account as a', 'a.code', 'l.account_code')
      .select(['l.entry_id', 'l.line_no', 'l.account_code', 'a.name', 'l.debit', 'l.credit'])
      .where('l.org_id', '=', ctx.orgId)
      .where(
        'l.entry_id',
        'in',
        rows.map((r) => r.id),
      )
      .orderBy('l.entry_id')
      .orderBy('l.line_no')
      .execute();
    const byEntry = new Map<string, JournalEntryView['lines']>();
    for (const l of lines) {
      const list = byEntry.get(l.entry_id) ?? [];
      list.push({ lineNo: l.line_no, accountCode: l.account_code, accountName: l.name, debit: l.debit, credit: l.credit });
      byEntry.set(l.entry_id, list);
    }
    return rows.map((r) => ({
      id: r.id,
      entryDate: r.entry_date,
      description: r.description,
      sourceType: r.source_type,
      sourceId: r.source_id,
      lines: byEntry.get(r.id) ?? [],
      ...(r.invoice_number && r.invoice_date && r.party_name
        ? {
            document: {
              series: r.invoice_series ?? '',
              number: r.invoice_number,
              issueDate: r.invoice_date,
              partyName: r.party_name,
              partyTaxCode: r.party_tax_code,
            },
          }
        : {}),
    }));
  },
});

export const accountsList = defineQuery({
  name: 'finance.accounts.list',
  input: z.object({}),
  access: ALL,
  handler: async (ctx) =>
    (await ctx.trx.selectFrom('crove_finance.account').select(['code', 'name', 'parent_code']).orderBy('code').execute()).map((a) => ({
      code: a.code,
      name: a.name,
      parentCode: a.parent_code,
    })),
});
