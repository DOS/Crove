// Customers and party details (issue #670).
// - finance.customers.list: the customers of the org, by name, a page at a time. A customer is a party on one of the
//   org's sales documents (#313), or any party with a line on 131 (an opening balance or a receipt names it). Each row
//   carries what the customer owes today (every posted line on 131 and its sub-accounts naming it, reversals included,
//   as the ledger reports count them) and its latest invoice still in the books.
// - finance.party.update: owners and admins correct a customer's or vendor's name, tax code or contact email (R1: no
//   amount and no posted entry changes; each correction is undone by another). A party's id never changes, so every
//   document, voucher and journal line keeps naming the same party; reports show its current name and tax code.
import { sql } from 'kysely';
import { z } from 'zod';
import { CUSTOMER_PAGE_SIZE, zCustomerCursor, zPartyUpdate, type CustomerPage } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand, defineQuery } from '@crove/kernel-runtime';
import { RECEIVABLE_ACCOUNT, parseTaxCode } from '@crove/l10n-vn';
import { canonical, parseDecimal } from './domain/money.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const MANAGERS: readonly MemberRole[] = ['owner', 'admin'];

export const customersList = defineQuery({
  name: 'finance.customers.list',
  input: z.object({ q: z.string().max(100).optional(), after: zCustomerCursor.optional() }),
  access: ALL,
  handler: async (ctx, input): Promise<CustomerPage> => {
    let query = ctx.trx
      // Per customer, the sales documents still in the books: a voided one (#165) is no longer a sale of the org.
      .with('sales', (db) =>
        db
          .selectFrom('crove_finance.purchase_document as d')
          .leftJoin('crove_finance.purchase_document_void as v', (join) => join.onRef('v.org_id', '=', 'd.org_id').onRef('v.document_id', '=', 'd.id'))
          .select('d.party_id')
          .select((eb) => [
            eb.fn.count<string>('d.id').filterWhere('v.document_id', 'is', null).as('invoice_count'),
            eb.fn.max('d.invoice_date').filterWhere('v.document_id', 'is', null).as('last_invoice_date'),
          ])
          .where('d.org_id', '=', ctx.orgId)
          .where('d.direction', '=', 'sale')
          .groupBy('d.party_id'),
      )
      // Per party, its balance on 131: a sub-account's code extends its parent's (1311, 131.HCM), so the prefix is the
      // whole subtree, as the financial statements read it.
      .with('receivable', (db) =>
        db
          .selectFrom('crove_finance.journal_line as l')
          .select('l.party_id')
          .select(sql<string>`sum(l.debit - l.credit)`.as('balance'))
          .where('l.org_id', '=', ctx.orgId)
          .where('l.account_code', 'like', `${RECEIVABLE_ACCOUNT}%`)
          .where('l.party_id', 'is not', null)
          .groupBy('l.party_id'),
      )
      .selectFrom('crove_kernel.party as p')
      .leftJoin('sales as s', 's.party_id', 'p.id')
      .leftJoin('receivable as r', 'r.party_id', 'p.id')
      .select(['p.id', 'p.name', 'p.tax_code', 'p.address', 'p.email', 's.invoice_count', 's.last_invoice_date', 'r.balance'])
      .where('p.org_id', '=', ctx.orgId)
      .where((eb) => eb.or([eb('s.party_id', 'is not', null), eb('r.party_id', 'is not', null)]))
      .orderBy('p.name')
      .orderBy('p.id')
      // One more than a page, to tell whether another page follows.
      .limit(CUSTOMER_PAGE_SIZE + 1);
    if (input.q) {
      const term = `%${input.q.toLowerCase()}%`;
      query = query.where((eb) => eb.or([eb(eb.fn('lower', ['p.name']), 'like', term), eb('p.tax_code', 'like', term)]));
    }
    if (input.after) query = query.where(sql<boolean>`(p.name, p.id) > (${input.after.name}, ${input.after.id}::uuid)`);
    const rows = await query.execute();
    return {
      items: rows.slice(0, CUSTOMER_PAGE_SIZE).map((r) => ({
        id: r.id,
        name: r.name,
        taxCode: r.tax_code,
        address: r.address,
        email: r.email,
        invoiceCount: Number(r.invoice_count ?? 0),
        lastInvoiceDate: r.last_invoice_date ?? null,
        receivable: canonical(parseDecimal(r.balance ?? '0')),
      })),
      more: rows.length > CUSTOMER_PAGE_SIZE,
    };
  },
});

export const updateParty = defineCommand({
  name: 'finance.party.update',
  input: zPartyUpdate,
  risk: 'R1',
  access: MANAGERS,
  handler: async (ctx, input) => {
    // Locked: two corrections of one party wait for each other, so each audit row records what it replaced.
    const party = await ctx.trx
      .selectFrom('crove_kernel.party')
      .select(['id', 'name', 'tax_code', 'email'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.partyId)
      .forUpdate()
      .executeTakeFirst();
    if (!party) throw new DomainError('PARTY_NOT_FOUND', 404, 'Không tìm thấy khách hàng hoặc nhà cung cấp');
    const name = input.name ?? party.name;
    let taxCode = party.tax_code;
    if (input.taxCode !== undefined) {
      const raw = input.taxCode?.trim() || null;
      const parsed = raw === null ? null : parseTaxCode(raw);
      if (raw !== null && !parsed) {
        throw new DomainError('INVALID_TAX_CODE', 422, 'Mã số thuế không hợp lệ: cần 10 chữ số, 10 chữ số kèm 3 chữ số đơn vị phụ thuộc, hoặc 12 chữ số');
      }
      taxCode = parsed?.normalized ?? null;
    }
    const email = input.email === undefined ? party.email : input.email;
    const after = { name, taxCode, email };
    const before = { name: party.name, taxCode: party.tax_code, email: party.email };
    if (name === before.name && taxCode === before.taxCode && email === before.email) {
      ctx.audit({ partyId: party.id, changed: [] });
      return { partyId: party.id, ...after };
    }
    // Invoices and bank lines find a party by its tax code, so it stays one party's.
    if (taxCode !== null && taxCode !== before.taxCode) {
      const other = await ctx.trx
        .selectFrom('crove_kernel.party')
        .select('name')
        .where('org_id', '=', ctx.orgId)
        .where('tax_code', '=', taxCode)
        .where('id', '<>', party.id)
        .executeTakeFirst();
      if (other) throw new DomainError('TAX_CODE_TAKEN', 409, `Mã số thuế ${taxCode} đã thuộc về ${other.name}`, { taxCode });
    }
    await ctx.trx
      .updateTable('crove_kernel.party')
      .set((eb) => ({
        name,
        tax_code: taxCode,
        email,
        // Entered by a person now, no longer only as the invoice said.
        source_trust: 'user',
        verified_at: ctx.now,
        verified_by: ctx.actor.type === 'user' ? ctx.actor.userId : null,
        version: eb('version', '+', 1),
        updated_at: ctx.now,
      }))
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', party.id)
      .execute()
      .catch((error: unknown) => {
        // Another party took the tax code meanwhile (an invoice recorded it); the unique index refused this one.
        if ((error as { code?: string } | null)?.code === '23505') throw new DomainError('TAX_CODE_TAKEN', 409, `Mã số thuế ${taxCode} đã thuộc về một đối tượng khác`, { taxCode });
        throw error;
      });
    const changed = (Object.keys(after) as Array<keyof typeof after>).filter((key) => after[key] !== before[key]);
    // Which fields changed, and the tax code before and after when it did.
    ctx.audit({ partyId: party.id, changed, ...(changed.includes('taxCode') ? { taxCode, previousTaxCode: before.taxCode } : {}) });
    await ctx.activity('kernel.party', party.id, 'party.updated', name === before.name ? `Sửa thông tin của ${name}` : `Đổi tên ${before.name} thành ${name}`);
    return { partyId: party.id, ...after };
  },
});
