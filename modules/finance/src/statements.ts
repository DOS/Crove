// Financial statements for a month, quarter or year (issue #154, backlog M2-10): B01-DNN (statement of financial
// position) at the period's last day and B02-DNN (income statement) for the period, read with the DRAFT line codes
// and account mapping of domain/tt133-reports.ts, which an accountant has not verified yet. The screen and the
// workbook say so; until then the statements help the accountant check the books, not file them.
//
// finance.statements.period answers both for the screen; the Excel export (GET /api/export/statements.xlsx) reads the
// same query and records its download with finance.statements.export, like the other exports.
//
// The pure builders take entries with lines. Balances are summed in SQL instead, one row per account, party and
// reversal (and, for B02, only the period's entries without a line on 911, the year-end closing account), and each row
// is handed over as one entry: the builders only ever add lines up, so the sums are the same and no line limit is
// needed however long the history is.
import { sql } from 'kysely';
import { z } from 'zod';
import type { MemberRole } from '@crove/db';
import { zLedgerPeriod } from '@crove/kernel-contract';
import { defineCommand, defineQuery, type QueryContext } from '@crove/kernel-runtime';
import { chartAccounts } from './accounts.ts';
import { ledgerPeriod, type LedgerPeriod } from './domain/ledger-reports.ts';
import { B01_LINES, B02_LINES, CLOSING_ACCOUNT, buildB01, buildB02, type ReportEntry, type ReportLine, type ReportLineDef, type UnmappedBalance } from './domain/tt133-reports.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
// An org is one legal entity today (plan §4.6): every entry belongs to it.
const LEGAL_ENTITY = 'org';

export const zStatementsInput = z.object({ period: zLedgerPeriod });

export interface UnmappedRow {
  accountCode: string;
  accountName: string | null;
  partyName: string | null;
  // Debit minus credit.
  amount: string;
}

// A line of a statement; `total` marks the lines that add up earlier ones (printed bold on the form).
export interface StatementLine extends ReportLine {
  total: boolean;
}

export interface FinancialStatements {
  period: LedgerPeriod;
  b01: { asOf: string; lines: StatementLine[]; unmapped: UnmappedRow[]; balanced: boolean };
  b02: { from: string; to: string; lines: StatementLine[]; unmapped: UnmappedRow[] };
}

function withTotals(lines: ReportLine[], defs: readonly ReportLineDef[]): StatementLine[] {
  const totals = new Set(defs.filter((d) => d.formula).map((d) => d.code));
  return lines.map((line) => ({ ...line, total: totals.has(line.code) }));
}

interface BalanceRow {
  account_code: string;
  party_id: string | null;
  reversal: boolean;
  debit: string | null;
  credit: string | null;
}

// Each summed row as one entry dated `date` (inside the range the builder reads).
function asEntries(rows: BalanceRow[], date: string): ReportEntry[] {
  return rows.map((r) => ({
    legalEntityId: LEGAL_ENTITY,
    entryDate: date,
    currency: 'VND',
    reversal: r.reversal,
    lines: [{ accountCode: r.account_code, partyId: r.party_id, debit: r.debit ?? '0', credit: r.credit ?? '0' }],
  }));
}

// The debits and credits of the org's entries in [from, to] (from null: since the first entry), per account, party and
// reversal. `withoutClosing` leaves out every entry that has a line on the year-end closing account.
function balances(ctx: QueryContext, from: string | null, to: string, withoutClosing: boolean) {
  let query = ctx.trx
    .selectFrom('crove_finance.journal_line as l')
    .innerJoin('crove_finance.journal_entry as j', (join) => join.onRef('j.org_id', '=', 'l.org_id').onRef('j.id', '=', 'l.entry_id'))
    .select(['l.account_code', 'l.party_id'])
    .select((eb) => [
      eb('j.reverses_entry_id', 'is not', null).as('reversal'),
      eb.fn.sum<string>('l.debit').as('debit'),
      eb.fn.sum<string>('l.credit').as('credit'),
    ])
    .where('l.org_id', '=', ctx.orgId)
    .where('j.entry_date', '<=', to);
  if (from !== null) query = query.where('j.entry_date', '>=', from);
  if (withoutClosing) {
    query = query.where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom('crove_finance.journal_line as c')
            .select(sql<number>`1`.as('one'))
            .whereRef('c.org_id', '=', 'j.org_id')
            .whereRef('c.entry_id', '=', 'j.id')
            .where('c.account_code', 'like', `${CLOSING_ACCOUNT}%`),
        ),
      ),
    );
  }
  return query.groupBy(['l.account_code', 'l.party_id', sql`j.reverses_entry_id IS NOT NULL`]);
}

// B01's balances (every entry up to the period end) and B02's (the period's entries without a closing line) in ONE
// statement (#365), so both statements see the same entries even in the query's READ COMMITTED transaction: an entry
// posted while they read is in both or in neither. The names of unmapped accounts and parties are read afterwards; they
// only label rows whose amounts come from this statement.
async function statementBalances(ctx: QueryContext, period: LedgerPeriod): Promise<{ b01: BalanceRow[]; b02: BalanceRow[] }> {
  const rows = await balances(ctx, null, period.to, false)
    .select(sql.lit('b01').as('part'))
    .unionAll(balances(ctx, period.from, period.to, true).select(sql.lit('b02').as('part')))
    .orderBy('part')
    .orderBy('account_code')
    .execute();
  const split = { b01: [] as BalanceRow[], b02: [] as BalanceRow[] };
  for (const { part, ...row } of rows) split[part === 'b01' ? 'b01' : 'b02'].push(row as BalanceRow);
  return split;
}

async function unmappedRows(ctx: QueryContext, unmapped: UnmappedBalance[]): Promise<UnmappedRow[]> {
  if (unmapped.length === 0) return [];
  const chart = await chartAccounts(ctx);
  const partyIds = [...new Set(unmapped.flatMap((u) => (u.partyId ? [u.partyId] : [])))];
  const parties = new Map<string, string>();
  if (partyIds.length > 0) {
    for (const p of await ctx.trx.selectFrom('crove_kernel.party').select(['id', 'name']).where('org_id', '=', ctx.orgId).where('id', 'in', partyIds).execute()) {
      parties.set(p.id, p.name);
    }
  }
  return unmapped.map((u) => ({
    accountCode: u.accountCode,
    accountName: chart.get(u.accountCode)?.name ?? null,
    partyName: u.partyId ? (parties.get(u.partyId) ?? null) : null,
    amount: u.amount,
  }));
}

export async function financialStatements(ctx: QueryContext, periodText: string): Promise<FinancialStatements> {
  const period = ledgerPeriod(periodText);
  const sums = await statementBalances(ctx, period);
  const b01 = buildB01(asEntries(sums.b01, period.to), LEGAL_ENTITY, period.to);
  const b02 = buildB02(asEntries(sums.b02, period.from), LEGAL_ENTITY, period.from, period.to);
  return {
    period,
    b01: { asOf: period.to, lines: withTotals(b01.lines, B01_LINES), unmapped: await unmappedRows(ctx, b01.unmapped), balanced: b01.balanced },
    b02: { from: period.from, to: period.to, lines: withTotals(b02.lines, B02_LINES), unmapped: await unmappedRows(ctx, b02.unmapped) },
  };
}

export const statementsPeriodQuery = defineQuery({
  name: 'finance.statements.period',
  input: zStatementsInput,
  access: ALL,
  handler: (ctx, input): Promise<FinancialStatements> => financialStatements(ctx, input.period),
});

// Records one Excel export of a period's financial statements after the workbook is built. It changes nothing: its
// audit row (the period) is the record of who took the statements out, and a failure stops the download.
export const statementsExport = defineCommand({
  name: 'finance.statements.export',
  input: zStatementsInput,
  risk: 'R0',
  access: ALL,
  handler: async (ctx, input) => {
    ctx.audit({ period: input.period });
    return { ok: true as const };
  },
});
