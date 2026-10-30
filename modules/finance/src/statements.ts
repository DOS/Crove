// Financial statements for a month, quarter or year (issue #154, backlog M2-10): B01-DNN (statement of financial
// position) at the period's last day and B02-DNN (income statement) for the period, read with the DRAFT line codes
// and account mapping of domain/tt133-reports.ts, which an accountant has not verified yet. The screen and the
// workbook say so; until then the statements help the accountant check the books, not file them.
//
// finance.statements.period answers both for the screen; the Excel export (GET /api/export/statements.xlsx) reads the
// same query and records its download with finance.statements.export, like the other exports.
//
// Next to the period, the screen and the workbook carry the comparison columns (#2090): B01's start of year (its
// balances at the end of the previous year) and B02 for the same period of the previous year and, for a month or a
// quarter, for the period right before it (domain/statement-comparison.ts). They are read in the same statement as the
// period's own balances and only add what a column shows: the line amounts by code.
//
// The pure builders take entries with lines. Balances are summed in SQL instead, one row per account, party and
// reversal (and, for B02, only the period's entries without a line on 911, the year-end closing account), and each row
// is handed over as one entry: the builders only ever add lines up, so the sums are the same and no line limit is
// needed however long the history is.
import { sql } from 'kysely';
import { z } from 'zod';
import type { MemberRole } from '@crove/db';
import { zId, zLedgerPeriod } from '@crove/kernel-contract';
import { defineCommand, defineQuery, type QueryContext } from '@crove/kernel-runtime';
import { chartAccounts } from './accounts.ts';
import { resolveLegalEntity } from './legal-entity.ts';
import { ledgerPeriod, type LedgerPeriod } from './domain/ledger-reports.ts';
import { comparisonPlan, type ComparisonPlan } from './domain/statement-comparison.ts';
import { B01_LINES, B02_LINES, CLOSING_ACCOUNT, buildB01, buildB02, type ReportEntry, type ReportLine, type ReportLineDef, type UnmappedBalance } from './domain/tt133-reports.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];

// The statements of one legal entity (#1280): legalEntityId as in zLegalEntityChoice.
export const zStatementsInput = z.object({ period: zLedgerPeriod, legalEntityId: zId.optional() });

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

// What financialStatements() reads, and what the HTKK export builds on (statements-htkk.ts).
export interface StatementsBody {
  period: LedgerPeriod;
  b01: { asOf: string; lines: StatementLine[]; unmapped: UnmappedRow[]; balanced: boolean };
  b02: { from: string; to: string; lines: StatementLine[]; unmapped: UnmappedRow[] };
}

// The line amounts of one column, by line code; a code the column's period has no entries for reads 0, never absent.
export type ColumnAmounts = Record<string, string>;

// B02 for another period, shown beside the period's own. `unmapped` counts the balances of that period no line reads
// (the column is then incomplete), as the period's own `unmapped` list does for its statement.
export interface ComparedPeriod {
  period: string;
  from: string;
  to: string;
  amounts: ColumnAmounts;
  unmapped: number;
}

export interface StatementsComparison {
  // B01 at the end of the previous year (`asOf`); null before 2000, where there is no previous year. `balanced` and
  // `unmapped` are B01's own two warnings for that date: a start of year that does not balance or is incomplete must
  // not read as a clean comparison.
  startOfYear: { asOf: string; amounts: ColumnAmounts; balanced: boolean; unmapped: number } | null;
  // B02 for the same period of the previous year (a year: the previous year); null before 2000.
  lastYear: ComparedPeriod | null;
  // B02 for the month or quarter right before; null for a year, whose previous year is `lastYear`.
  previous: ComparedPeriod | null;
}

// The statements the screen and the workbook show: the period's own and the comparison columns.
export interface FinancialStatements extends StatementsBody {
  comparison: StatementsComparison;
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

// Each summed row as one entry of the legal entity dated `date` (inside the range the builder reads).
function asEntries(rows: BalanceRow[], date: string, legalEntityId: string): ReportEntry[] {
  return rows.map((r) => ({
    legalEntityId,
    entryDate: date,
    currency: 'VND',
    reversal: r.reversal,
    lines: [{ accountCode: r.account_code, partyId: r.party_id, debit: r.debit ?? '0', credit: r.credit ?? '0' }],
  }));
}

// The debits and credits of the legal entity's entries in [from, to] (from null: since the first entry), per account,
// party and reversal. `withoutClosing` leaves out every entry that has a line on the year-end closing account.
function balances(ctx: QueryContext, legalEntityId: string, from: string | null, to: string, withoutClosing: boolean) {
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
    .where('l.legal_entity_id', '=', legalEntityId)
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

type Part = 'b01' | 'b02' | 'start' | 'last_year' | 'previous';

// B01's balances (every entry up to the period end) and B02's (the period's entries without a closing line) in ONE
// statement (#365), so both statements see the same entries even in the query's READ COMMITTED transaction: an entry
// posted while they read is in both or in neither. The comparison columns' balances (#2090) ride in the same
// statement: B01 at the end of the previous year, and B02 of the periods `plan` names. The names of unmapped accounts
// and parties are read afterwards; they only label rows whose amounts come from this statement.
async function statementBalances(ctx: QueryContext, period: LedgerPeriod, legalEntityId: string, plan: ComparisonPlan | null): Promise<Record<Part, BalanceRow[]>> {
  let query = balances(ctx, legalEntityId, null, period.to, false)
    .select(sql.lit('b01').as('part'))
    .unionAll(balances(ctx, legalEntityId, period.from, period.to, true).select(sql.lit('b02').as('part')));
  if (plan?.startOfYear) query = query.unionAll(balances(ctx, legalEntityId, null, plan.startOfYear, false).select(sql.lit('start').as('part')));
  if (plan?.lastYear) query = query.unionAll(balances(ctx, legalEntityId, plan.lastYear.from, plan.lastYear.to, true).select(sql.lit('last_year').as('part')));
  if (plan?.previous) query = query.unionAll(balances(ctx, legalEntityId, plan.previous.from, plan.previous.to, true).select(sql.lit('previous').as('part')));
  const rows = await query.orderBy('part').orderBy('account_code').execute();
  const split: Record<Part, BalanceRow[]> = { b01: [], b02: [], start: [], last_year: [], previous: [] };
  for (const { part, ...row } of rows) split[part as Part].push(row as BalanceRow);
  return split;
}

const amountsOf = (lines: ReportLine[]): ColumnAmounts => Object.fromEntries(lines.map((line) => [line.code, line.amount]));

function comparedPeriod(period: LedgerPeriod | null, rows: BalanceRow[], legalEntityId: string): ComparedPeriod | null {
  if (!period) return null;
  const b02 = buildB02(asEntries(rows, period.from, legalEntityId), legalEntityId, period.from, period.to);
  return { period: period.period, from: period.from, to: period.to, amounts: amountsOf(b02.lines), unmapped: b02.unmapped.length };
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

async function readStatements(ctx: QueryContext, periodText: string, legalEntityId: string, withComparison: boolean) {
  const period = ledgerPeriod(periodText);
  const plan = withComparison ? comparisonPlan(period) : null;
  const sums = await statementBalances(ctx, period, legalEntityId, plan);
  const b01 = buildB01(asEntries(sums.b01, period.to, legalEntityId), legalEntityId, period.to);
  const b02 = buildB02(asEntries(sums.b02, period.from, legalEntityId), legalEntityId, period.from, period.to);
  const body: StatementsBody = {
    period,
    b01: { asOf: period.to, lines: withTotals(b01.lines, B01_LINES), unmapped: await unmappedRows(ctx, b01.unmapped), balanced: b01.balanced },
    b02: { from: period.from, to: period.to, lines: withTotals(b02.lines, B02_LINES), unmapped: await unmappedRows(ctx, b02.unmapped) },
  };
  return { body, sums, plan };
}

// The statements of one legal entity (#1280), without the comparison columns: what the HTKK export reads for the year
// and the year before it.
export async function financialStatements(ctx: QueryContext, periodText: string, legalEntityId: string): Promise<StatementsBody> {
  return (await readStatements(ctx, periodText, legalEntityId, false)).body;
}

// The same with the comparison columns (#2090), for the screen and the workbook.
export async function comparedStatements(ctx: QueryContext, periodText: string, legalEntityId: string): Promise<FinancialStatements> {
  const { body, sums, plan } = await readStatements(ctx, periodText, legalEntityId, true);
  const start = plan?.startOfYear ?? null;
  const startB01 = start === null ? null : buildB01(asEntries(sums.start, start, legalEntityId), legalEntityId, start);
  return {
    ...body,
    comparison: {
      startOfYear: start === null || startB01 === null ? null : { asOf: start, amounts: amountsOf(startB01.lines), balanced: startB01.balanced, unmapped: startB01.unmapped.length },
      lastYear: comparedPeriod(plan?.lastYear ?? null, sums.last_year, legalEntityId),
      previous: comparedPeriod(plan?.previous ?? null, sums.previous, legalEntityId),
    },
  };
}

export const statementsPeriodQuery = defineQuery({
  name: 'finance.statements.period',
  input: zStatementsInput,
  access: ALL,
  handler: async (ctx, input): Promise<FinancialStatements> => comparedStatements(ctx, input.period, await resolveLegalEntity(ctx, input.legalEntityId)),
});

// Records one export of a period's financial statements after the file is built. It changes nothing: its audit row
// (the period) is the record of who took the statements out, and a failure stops the download. The HTKK XML of a
// year's statements (#920) also records its format and the warnings the file was made with; the Excel workbook
// records no format, as before.
export const STATEMENTS_EXPORT_FORMATS = ['htkk_bctc_xml'] as const;
export const statementsExport = defineCommand({
  name: 'finance.statements.export',
  input: zStatementsInput.extend({
    format: z.enum(STATEMENTS_EXPORT_FORMATS).optional(),
    warnings: z.array(z.string().max(40)).max(10).optional(),
  }),
  risk: 'R0',
  sideEffect: 'none',
  access: ALL,
  handler: async (ctx, input) => {
    ctx.audit({ period: input.period, ...(input.legalEntityId ? { legal_entity_id: input.legalEntityId } : {}), ...(input.format ? { format: input.format } : {}), ...(input.warnings ? { warnings: input.warnings } : {}) });
    return { ok: true as const };
  },
});
