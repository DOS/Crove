// Search across parties, documents and journal entries (issue #673), for the command palette. finance.search folds
// what was typed the way the stored search columns fold each row (crove_kernel.search_fold, migration
// 20261023050000_crove_finance_search: Vietnamese marks, đ and case ignored), so "dien luc" finds "Điện lực". Every
// word must start a word of the row (a prefix match): parties by name or tax code, documents by series and number or
// by their party, entries by description, and entries by amount when what was typed reads as one. Each group holds at
// most SEARCH_LIMIT rows: parties with the closest match first, documents and entries newest first. It runs as the
// member, so row security keeps it inside the org.
import { sql } from 'kysely';
import { z } from 'zod';
import type { DocumentDirection } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { defineQuery, type QueryContext } from '@crove/kernel-runtime';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];

export const SEARCH_LIMIT = 8;
// Parties matched by a search whose documents are looked up by party id (see searchDocuments).
const PARTY_IDS_LIMIT = 200;

export interface SearchResult {
  // customerOnly: a customer of sales (#313) that never sold to the org, so not among the vendors.
  parties: Array<{
    id: string;
    name: string;
    taxCode: string | null;
    customerOnly: boolean;
  }>;
  documents: Array<{
    id: string;
    direction: DocumentDirection;
    series: string;
    number: string;
    issueDate: string;
    partyName: string;
    total: string;
    proposalId: string | null;
    voided: boolean;
  }>;
  entries: Array<{
    id: string;
    entryDate: string;
    description: string;
    amount: string;
  }>;
}

// What was typed, read as an amount in dong: digits with dots, commas or spaces between groups of three
// ("1.234.567", "1,234,567", "1 234 567"), or digits alone, with an optional "đ" or "VND" after them. Null otherwise.
// Decimals are not read: a dong amount has none, and "1,5" is not an amount anyone types to find an entry.
export function searchAmount(text: string): string | null {
  const t = text
    .trim()
    .replace(/\s*(đ|vnd|vnđ)$/i, '')
    .trim();
  const grouped = /^\d{1,3}(?:([.,\s])\d{3})(?:\1\d{3})*$/.test(t);
  if (!grouped && !/^\d+$/.test(t)) return null;
  const digits = t.replace(/\D/g, '').replace(/^0+(?=\d)/, '');
  return digits.length <= 15 ? digits : null;
}

// The stored search columns (migration 20261023050000), each with its GIN index.
const PARTY_VECTOR = sql`p.search`;
const DOCUMENT_VECTOR = sql`d.search`;
const ENTRY_VECTOR = sql`j.search`;

async function searchParties(ctx: QueryContext, q: string): Promise<SearchResult['parties']> {
  const rows = await ctx.trx
    .selectFrom('crove_kernel.party as p')
    .select(['p.id', 'p.name', 'p.tax_code'])
    // The same test as finance.vendors.list, which leaves these parties out.
    .select(({ and, exists, not, selectFrom }) =>
      and([
        exists(
          selectFrom('crove_finance.purchase_document as s')
            .select('s.id')
            .whereRef('s.org_id', '=', 'p.org_id')
            .whereRef('s.party_id', '=', 'p.id')
            .where('s.direction', '=', 'sale'),
        ),
        not(
          exists(
            selectFrom('crove_finance.purchase_document as b')
              .select('b.id')
              .whereRef('b.org_id', '=', 'p.org_id')
              .whereRef('b.party_id', '=', 'p.id')
              .where('b.direction', '=', 'purchase'),
          ),
        ),
      ]).as('customer_only'),
    )
    .where('p.org_id', '=', ctx.orgId)
    .where(sql<boolean>`${PARTY_VECTOR} @@ crove_kernel.search_query(${q})`)
    // The exact tax code first, then the rows that match more of the words, then by name.
    .orderBy(sql`p.tax_code IS NOT DISTINCT FROM ${q.trim()}`, 'desc')
    .orderBy(sql`pg_catalog.ts_rank(${PARTY_VECTOR}, crove_kernel.search_query(${q}))`, 'desc')
    .orderBy('p.name')
    .limit(SEARCH_LIMIT)
    .execute();
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    taxCode: r.tax_code,
    customerOnly: Boolean(r.customer_only),
  }));
}

// Documents whose own series or number match, and documents of the parties that match, in two queries so each uses
// its index; merged newest first.
async function searchDocuments(ctx: QueryContext, q: string): Promise<SearchResult['documents']> {
  const base = () =>
    ctx.trx
      .selectFrom('crove_finance.purchase_document as d')
      .innerJoin('crove_kernel.party as p', (join) => join.onRef('p.org_id', '=', 'd.org_id').onRef('p.id', '=', 'd.party_id'))
      .leftJoin('crove_finance.purchase_document_void as v', (join) => join.onRef('v.org_id', '=', 'd.org_id').onRef('v.document_id', '=', 'd.id'))
      .select([
        'd.id',
        'd.direction',
        'd.invoice_series',
        'd.invoice_number',
        sql<string>`pg_catalog.to_char(d.invoice_date, 'YYYY-MM-DD')`.as('issue_date'),
        'd.created_at',
        'd.total',
        'd.proposal_id',
        'p.name as party_name',
        'v.document_id as voided_id',
      ])
      .where('d.org_id', '=', ctx.orgId)
      .orderBy('d.invoice_date', 'desc')
      .orderBy('d.created_at', 'desc')
      .limit(SEARCH_LIMIT);
  const byNumber = await base()
    .where(sql<boolean>`${DOCUMENT_VECTOR} @@ crove_kernel.search_query(${q})`)
    .execute();
  // The matching parties first: none (the usual case for a number) skips the query, and a short list is read
  // through the party index. Past PARTY_IDS_LIMIT the words are generic enough that the newest documents are
  // found quickly by date.
  const parties = await ctx.trx
    .selectFrom('crove_kernel.party as p')
    .select('p.id')
    .where('p.org_id', '=', ctx.orgId)
    .where(sql<boolean>`${PARTY_VECTOR} @@ crove_kernel.search_query(${q})`)
    .limit(PARTY_IDS_LIMIT + 1)
    .execute();
  const byParty =
    parties.length === 0
      ? []
      : parties.length <= PARTY_IDS_LIMIT
        ? await base()
            .where('d.party_id', 'in', parties.map((r) => r.id))
            .execute()
        : await base()
            .where('d.party_id', 'in', (eb) =>
              eb
                .selectFrom('crove_kernel.party as p')
                .select('p.id')
                .where('p.org_id', '=', ctx.orgId)
                .where(sql<boolean>`${PARTY_VECTOR} @@ crove_kernel.search_query(${q})`),
            )
            .execute();
  // A number match is what was looked for, so those come first; then the party's documents.
  const seen = new Set<string>();
  return [...byNumber, ...byParty]
    .filter((r) => !seen.has(r.id) && seen.add(r.id))
    .slice(0, SEARCH_LIMIT)
    .map((r) => ({
      id: r.id,
      direction: r.direction,
      series: r.invoice_series,
      number: r.invoice_number,
      issueDate: r.issue_date,
      partyName: r.party_name,
      total: r.total,
      proposalId: r.proposal_id,
      voided: r.voided_id !== null,
    }));
}

async function searchEntries(ctx: QueryContext, q: string): Promise<SearchResult['entries']> {
  const amount = searchAmount(q);
  const base = () =>
    ctx.trx
      .selectFrom('crove_finance.journal_entry as j')
      .select(['j.id', sql<string>`pg_catalog.to_char(j.entry_date, 'YYYY-MM-DD')`.as('entry_date'), 'j.created_at', 'j.description'])
      // The entry's amount: the sum of its debits (it balances, so its credits sum the same).
      .select((eb) =>
        eb
          .selectFrom('crove_finance.journal_line as l')
          .select(sql<string>`pg_catalog.sum(l.debit)`.as('s'))
          .whereRef('l.org_id', '=', 'j.org_id')
          .whereRef('l.entry_id', '=', 'j.id')
          .as('amount'),
      )
      .where('j.org_id', '=', ctx.orgId)
      .orderBy('j.entry_date', 'desc')
      .orderBy('j.created_at', 'desc')
      .limit(SEARCH_LIMIT);
  const byText = await base()
    .where(sql<boolean>`${ENTRY_VECTOR} @@ crove_kernel.search_query(${q})`)
    .execute();
  const byAmount =
    amount === null
      ? []
      : await base()
          .where('j.id', 'in', (eb) =>
            eb
              .selectFrom('crove_finance.journal_line as l')
              .select('l.entry_id')
              .where('l.org_id', '=', ctx.orgId)
              .where(sql<boolean>`(l.debit + l.credit) = ${amount}::numeric`),
          )
          .execute();
  const seen = new Set<string>();
  return [...byText, ...byAmount]
    .filter((r) => !seen.has(r.id) && seen.add(r.id))
    .sort((a, b) => b.entry_date.localeCompare(a.entry_date) || new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .slice(0, SEARCH_LIMIT)
    .map((r) => ({
      id: r.id,
      entryDate: r.entry_date,
      description: r.description,
      amount: r.amount ?? '0',
    }));
}

export const searchQuery = defineQuery({
  name: 'finance.search',
  // Two characters at least: a one-letter prefix matches nearly every row and says nothing.
  input: z.object({ q: z.string().trim().min(2).max(100) }),
  access: ALL,
  handler: async (ctx, input): Promise<SearchResult> => {
    // Nothing left to match once folded ("!!", "--"): no query to run.
    if (!/[\p{L}\p{N}]/u.test(input.q)) return { parties: [], documents: [], entries: [] };
    return {
      parties: await searchParties(ctx, input.q),
      documents: await searchDocuments(ctx, input.q),
      entries: await searchEntries(ctx, input.q),
    };
  },
});
