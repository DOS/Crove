// Customers (issue #670): finance.customers.list, the customers of the org by name, a page at a time. A customer is a
// party on one of the org's sales documents (#313), or any party with a line on 131 (an opening balance or a receipt
// names it). Each row carries what the customer owes today (every posted line on 131 and its sub-accounts naming it,
// reversals included, as the ledger reports count them) and its latest invoice still in the books. A party and the
// parties marked as its duplicates (#887) are one, as on the vendors list: the kept party alone is listed, with the
// sales and the receivable of all of them, and found by the name or tax code of any of them. Editing a customer goes
// through kernel.party.update and the duplicate commands, as for vendors.
import { sql } from 'kysely';
import { z } from 'zod';
import { CUSTOMER_PAGE_SIZE, zCustomerCursor, type CustomerPage } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { defineQuery } from '@crove/kernel-runtime';
import { RECEIVABLE_ACCOUNT } from '@crove/l10n-vn';
import { canonical, parseDecimal } from './domain/money.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];

export const customersList = defineQuery({
  name: 'finance.customers.list',
  input: z.object({ q: z.string().max(100).optional(), after: zCustomerCursor.optional() }),
  access: ALL,
  handler: async (ctx, input): Promise<CustomerPage> => {
    // The party a row counts under: the kept one for a duplicate, the party itself otherwise.
    const kept = sql<string>`coalesce(x.duplicate_of, x.id)`;
    let query = ctx.trx
      // Per customer, the sales documents still in the books: a voided one (#165) is no longer a sale of the org.
      .with('sales', (db) =>
        db
          .selectFrom('crove_finance.purchase_document as d')
          .innerJoin('crove_kernel.party as x', (join) => join.onRef('x.org_id', '=', 'd.org_id').onRef('x.id', '=', 'd.party_id'))
          .leftJoin('crove_finance.purchase_document_void as v', (join) => join.onRef('v.org_id', '=', 'd.org_id').onRef('v.document_id', '=', 'd.id'))
          .select(kept.as('party_id'))
          .select((eb) => [
            eb.fn.count<string>('d.id').filterWhere('v.document_id', 'is', null).as('invoice_count'),
            eb.fn.max('d.invoice_date').filterWhere('v.document_id', 'is', null).as('last_invoice_date'),
          ])
          .where('d.org_id', '=', ctx.orgId)
          .where('d.direction', '=', 'sale')
          .groupBy(kept),
      )
      // Per customer, its balance on 131: a sub-account's code extends its parent's (1311, 131.HCM), so the prefix is
      // the whole subtree, as the financial statements read it.
      .with('receivable', (db) =>
        db
          .selectFrom('crove_finance.journal_line as l')
          .innerJoin('crove_kernel.party as x', (join) => join.onRef('x.org_id', '=', 'l.org_id').onRef('x.id', '=', 'l.party_id'))
          .select(kept.as('party_id'))
          .select(sql<string>`sum(l.debit - l.credit)`.as('balance'))
          .where('l.org_id', '=', ctx.orgId)
          .where('l.account_code', 'like', `${RECEIVABLE_ACCOUNT}%`)
          .groupBy(kept),
      )
      .selectFrom('crove_kernel.party as p')
      .leftJoin('sales as s', 's.party_id', 'p.id')
      .leftJoin('receivable as r', 'r.party_id', 'p.id')
      .select(['p.id', 'p.name', 'p.tax_code', 'p.address', 'p.email', 'p.phone', 'p.version', 's.invoice_count', 's.last_invoice_date', 'r.balance'])
      .select(
        sql<Array<{ id: string; name: string; taxCode: string | null }>>`(
          SELECT coalesce(json_agg(json_build_object('id', x.id, 'name', x.name, 'taxCode', x.tax_code) ORDER BY x.name, x.id), '[]'::json)
            FROM crove_kernel.party x WHERE x.org_id = p.org_id AND x.duplicate_of = p.id)`.as('duplicates'),
      )
      .where('p.org_id', '=', ctx.orgId)
      .where('p.duplicate_of', 'is', null)
      .where((eb) => eb.or([eb('s.party_id', 'is not', null), eb('r.party_id', 'is not', null)]))
      .orderBy('p.name')
      .orderBy('p.id')
      // One more than a page, to tell whether another page follows.
      .limit(CUSTOMER_PAGE_SIZE + 1);
    if (input.q) {
      // Found by the name or tax code of the customer or of any of its duplicates.
      const term = `%${input.q.toLowerCase()}%`;
      query = query.where(
        sql<boolean>`EXISTS (SELECT 1 FROM crove_kernel.party m WHERE m.org_id = p.org_id AND (m.id = p.id OR m.duplicate_of = p.id) AND (lower(m.name) LIKE ${term} OR m.tax_code LIKE ${term}))`,
      );
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
        phone: r.phone,
        version: r.version,
        duplicates: r.duplicates,
        invoiceCount: Number(r.invoice_count ?? 0),
        lastInvoiceDate: r.last_invoice_date ?? null,
        receivable: canonical(parseDecimal(r.balance ?? '0')),
      })),
      more: rows.length > CUSTOMER_PAGE_SIZE,
    };
  },
});
