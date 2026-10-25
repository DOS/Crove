// Ledger reports for a month, quarter or year (issue #321): finance.ledger.period answers the trial balance and the
// receivables and payables per party, finance.ledger.account the general ledger of one account, and
// finance.ledger.book all of them for the Excel workbook (GET /api/export/ledger.xlsx), whose download
// finance.ledger.export records, like finance.vat.export. The rules are pure functions in domain/ledger-reports.ts.
//
// Every posted entry counts, reversals included; the opening balance is every entry dated before the period.
import { sql } from 'kysely';
import { z } from 'zod';
import type { MemberRole } from '@crove/db';
import { zAccountCode, zId, zLedgerPeriod } from '@crove/kernel-contract';
import { DomainError, defineCommand, defineQuery, type QueryContext } from '@crove/kernel-runtime';
import { mergeChart, type OrgAccountRow, type Tt133AccountRow } from './accounts.ts';
import { resolveLegalEntity } from './legal-entity.ts';
import {
  PAYABLE_ACCOUNT,
  RECEIVABLE_ACCOUNT,
  accountLedger,
  ledgerPeriod,
  partyLedger,
  trialBalance,
  type AccountLedger,
  type AccountLedgerLine,
  type ChartAccount,
  type LedgerPeriod,
  type OpeningBalance,
  type PartyInfo,
  type PartyLedger,
  type PeriodLine,
  type TrialBalance,
} from './domain/ledger-reports.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];

// More journal lines than this in one period is refused rather than cut short: a partial ledger is wrong.
export const LEDGER_LINE_LIMIT = 50_000;

// The books of one legal entity (#1280): legalEntityId as in zLegalEntityChoice.
export const zLedgerPeriodInput = z.object({ period: zLedgerPeriod, legalEntityId: zId.optional() });

export interface LedgerReport {
  period: LedgerPeriod;
  trialBalance: TrialBalance;
  receivables: PartyLedger;
  payables: PartyLedger;
}

export interface AccountLedgerView extends Omit<AccountLedger, 'lines'> {
  period: LedgerPeriod;
  lines: Array<Omit<AccountLedgerLine, 'partyId'> & { partyName: string | null }>;
}

// Everything the workbook holds: the report, and the general ledger of every top-level account on the trial balance
// (each with its sub-accounts). `lines` is the number of journal lines of the period, for the export's audit row.
export interface LedgerBook extends LedgerReport {
  ledgers: AccountLedgerView[];
  lines: number;
}

interface LedgerData {
  period: LedgerPeriod;
  chart: ChartAccount[];
  opening: OpeningBalance[];
  lines: PeriodLine[];
  parties: Map<string, PartyInfo>;
}

// What the one statement of loadLedgerData answers: each part a JSON array, money and dates as text (a JSON number
// would lose a NUMERIC's digits in JavaScript; the text is what the driver returns for a NUMERIC or a date column).
interface LedgerDataRow {
  tt133: Tt133AccountRow[];
  own: OrgAccountRow[];
  opening: Array<{ account_code: string; party_id: string | null; debit: string | null; credit: string | null }>;
  // Each line as [id, entry_date, description, reverses_entry_id, invoice_series, invoice_number, line_no, account_code,
  // party_id, debit, credit]: an array, not an object, since a period may have tens of thousands of lines.
  lines: Array<[string, string, string, string | null, string | null, string | null, number, string, string | null, string, string]>;
  parties: Array<{ id: string; name: string; tax_code: string | null }>;
}

// The chart, the opening balance, the period's lines and their parties in ONE statement (#365): a statement sees one
// snapshot even in the query's READ COMMITTED transaction, so an entry posted while the report reads is in all of it or
// in none (four statements could show a reversal in the period without the entry it undoes in the opening balance).
// The parts are typed Kysely queries; the statement around them only aggregates each into a JSON array. The lines are
// those of one legal entity (#1280); the chart and the parties are the org's.
async function loadLedgerData(ctx: QueryContext, periodText: string, legalEntityId: string): Promise<LedgerData> {
  const period = ledgerPeriod(periodText);
  // The org's whole chart (#319): the TT133 accounts and the org's sub-accounts, inactive ones included (posted lines
  // may name them). A sub-account's parent is its parent_code, so it rolls up into its parent like a TT133 account.
  const tt133 = ctx.trx.selectFrom('crove_finance.account').select(['code', 'name', 'parent_code']);
  const own = ctx.trx.selectFrom('crove_finance.org_account').select(['code', 'name', 'parent_code', 'root_code', 'active']).where('org_id', '=', ctx.orgId);

  // A line of a party marked as a duplicate (#887) counts under the party kept.
  const kept = sql<string | null>`COALESCE(dp.duplicate_of, l.party_id)`;

  // The opening balance: the debits and credits of every entry dated before the period, per account and party.
  const opening = ctx.trx
    .selectFrom('crove_finance.journal_line as l')
    .innerJoin('crove_finance.journal_entry as j', (join) => join.onRef('j.org_id', '=', 'l.org_id').onRef('j.id', '=', 'l.entry_id'))
    .leftJoin('crove_kernel.party as dp', (join) => join.onRef('dp.org_id', '=', 'l.org_id').onRef('dp.id', '=', 'l.party_id'))
    .select('l.account_code')
    .select(kept.as('party_id'))
    .select((eb) => [eb.fn.sum<string>('l.debit').as('debit'), eb.fn.sum<string>('l.credit').as('credit')])
    .where('l.org_id', '=', ctx.orgId)
    .where('l.legal_entity_id', '=', legalEntityId)
    .where('j.entry_date', '<', period.from)
    .groupBy(['l.account_code', kept]);

  // The period's lines in posting order; the purchase invoice an entry records gives its reference. The aggregate
  // below orders them again, which is what guarantees the order; sorting here first keeps that second sort cheap.
  const lines = ctx.trx
    .selectFrom('crove_finance.journal_entry as j')
    .innerJoin('crove_finance.journal_line as l', (join) => join.onRef('l.org_id', '=', 'j.org_id').onRef('l.entry_id', '=', 'j.id'))
    .leftJoin('crove_finance.purchase_document as d', (join) =>
      join.onRef('d.org_id', '=', 'j.org_id').onRef('d.id', '=', 'j.source_id').on('j.source_type', '=', 'finance.purchase_document'),
    )
    .leftJoin('crove_kernel.party as dp', (join) => join.onRef('dp.org_id', '=', 'l.org_id').onRef('dp.id', '=', 'l.party_id'))
    .select(kept.as('party_id'))
    .select([
      'j.id',
      'j.entry_date',
      'j.created_at',
      'j.description',
      'j.reverses_entry_id',
      'd.invoice_series',
      'd.invoice_number',
      'l.line_no',
      'l.account_code',
      'l.debit',
      'l.credit',
    ])
    .where('j.org_id', '=', ctx.orgId)
    .where('j.legal_entity_id', '=', legalEntityId)
    .where('j.entry_date', '>=', period.from)
    .where('j.entry_date', '<=', period.to)
    .orderBy('j.entry_date')
    .orderBy('j.created_at')
    .orderBy('j.id')
    .orderBy('l.line_no')
    .limit(LEDGER_LINE_LIMIT + 1);

  // The parties the opening balance and the lines name.
  const parties = ctx.trx
    .selectFrom('crove_kernel.party')
    .select(['id', 'name', 'tax_code'])
    .where('org_id', '=', ctx.orgId)
    .where('id', 'in', sql<string>`(SELECT party_id FROM opening WHERE party_id IS NOT NULL UNION SELECT party_id FROM lines WHERE party_id IS NOT NULL)`);

  const { rows } = await sql<LedgerDataRow>`
    WITH opening AS ${opening}, lines AS ${lines}
    SELECT
      (SELECT coalesce(json_agg(json_build_object('code', a.code, 'name', a.name, 'parent_code', a.parent_code)), '[]') FROM ${tt133} AS a) AS tt133,
      (SELECT coalesce(json_agg(json_build_object('code', a.code, 'name', a.name, 'parent_code', a.parent_code, 'root_code', a.root_code, 'active', a.active)), '[]')
         FROM ${own} AS a) AS own,
      (SELECT coalesce(json_agg(json_build_object('account_code', o.account_code, 'party_id', o.party_id, 'debit', o.debit::text, 'credit', o.credit::text)
                                ORDER BY o.account_code), '[]')
         FROM opening AS o) AS opening,
      (SELECT coalesce(json_agg(json_build_array(r.id, r.entry_date::text, r.description, r.reverses_entry_id, r.invoice_series, r.invoice_number,
                                                 r.line_no, r.account_code, r.party_id, r.debit::text, r.credit::text)
                                ORDER BY r.entry_date, r.created_at, r.id, r.line_no), '[]')
         FROM lines AS r) AS lines,
      (SELECT coalesce(json_agg(json_build_object('id', p.id, 'name', p.name, 'tax_code', p.tax_code)), '[]') FROM ${parties} AS p) AS parties
  `.execute(ctx.trx);
  const data = rows[0];
  if (!data) throw new Error('the ledger statement returned no row');
  if (data.lines.length > LEDGER_LINE_LIMIT) {
    throw new DomainError('PERIOD_TOO_LARGE', 422, `Kỳ này có hơn ${LEDGER_LINE_LIMIT} dòng bút toán; hãy chọn kỳ ngắn hơn`);
  }

  const chart = [...mergeChart(data.tt133, data.own).values()]
    .map((a) => ({ code: a.code, name: a.name, parentCode: a.parentCode }))
    .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  const partyInfo = new Map<string, PartyInfo>();
  for (const p of data.parties) partyInfo.set(p.id, { name: p.name, taxCode: p.tax_code });

  return {
    period,
    chart,
    opening: data.opening.map((o) => ({ accountCode: o.account_code, partyId: o.party_id, debit: o.debit ?? '0', credit: o.credit ?? '0' })),
    lines: data.lines.map(([id, entryDate, description, reversesEntryId, invoiceSeries, invoiceNumber, lineNo, accountCode, partyId, debit, credit]) => ({
      entryId: id,
      entryDate,
      reference: invoiceNumber ? `${invoiceSeries ? `${invoiceSeries}-` : ''}${invoiceNumber}` : null,
      description,
      reversal: reversesEntryId !== null,
      lineNo,
      accountCode,
      partyId,
      debit,
      credit,
    })),
    parties: partyInfo,
  };
}

// The trial balance of a calendar year, for the HTKK statements (#920). A year can hold more lines than the reports
// load (LEDGER_LINE_LIMIT), and a filing cannot choose a shorter period, so the year's lines are summed per account
// and party in SQL instead: trialBalance only adds debits and credits up and nets them per party, so one summed row
// per (account, party) gives the same balance as every line. The chart, the opening balance and the sums are read in
// ONE statement, as in loadLedgerData (#365).
export async function yearTrialBalance(ctx: QueryContext, year: number, legalEntityId: string): Promise<TrialBalance> {
  const period = ledgerPeriod(String(year));
  const tt133 = ctx.trx.selectFrom('crove_finance.account').select(['code', 'name', 'parent_code']);
  const own = ctx.trx.selectFrom('crove_finance.org_account').select(['code', 'name', 'parent_code', 'root_code', 'active']).where('org_id', '=', ctx.orgId);
  const kept = sql<string | null>`COALESCE(dp.duplicate_of, l.party_id)`;
  const sums = (from: string | null, to: string) => {
    let q = ctx.trx
      .selectFrom('crove_finance.journal_line as l')
      .innerJoin('crove_finance.journal_entry as j', (join) => join.onRef('j.org_id', '=', 'l.org_id').onRef('j.id', '=', 'l.entry_id'))
      .leftJoin('crove_kernel.party as dp', (join) => join.onRef('dp.org_id', '=', 'l.org_id').onRef('dp.id', '=', 'l.party_id'))
      .select('l.account_code')
      .select(kept.as('party_id'))
      .select((eb) => [eb.fn.sum<string>('l.debit').as('debit'), eb.fn.sum<string>('l.credit').as('credit')])
      .where('l.org_id', '=', ctx.orgId)
      .where('l.legal_entity_id', '=', legalEntityId);
    q = from === null ? q.where('j.entry_date', '<', to) : q.where('j.entry_date', '>=', from).where('j.entry_date', '<=', to);
    return q.groupBy(['l.account_code', kept]);
  };
  const json = (alias: string) =>
    sql.raw(
      `coalesce(json_agg(json_build_object('account_code', ${alias}.account_code, 'party_id', ${alias}.party_id, 'debit', ${alias}.debit::text, 'credit', ${alias}.credit::text) ORDER BY ${alias}.account_code), '[]')`,
    );
  type Sum = { account_code: string; party_id: string | null; debit: string | null; credit: string | null };
  const { rows } = await sql<{ tt133: Tt133AccountRow[]; own: OrgAccountRow[]; opening: Sum[]; year: Sum[] }>`
    SELECT
      (SELECT coalesce(json_agg(json_build_object('code', a.code, 'name', a.name, 'parent_code', a.parent_code)), '[]') FROM ${tt133} AS a) AS tt133,
      (SELECT coalesce(json_agg(json_build_object('code', a.code, 'name', a.name, 'parent_code', a.parent_code, 'root_code', a.root_code, 'active', a.active)), '[]')
         FROM ${own} AS a) AS own,
      (SELECT ${json('o')} FROM ${sums(null, period.from)} AS o) AS opening,
      (SELECT ${json('y')} FROM ${sums(period.from, period.to)} AS y) AS year
  `.execute(ctx.trx);
  const data = rows[0];
  if (!data) throw new Error('the trial balance statement returned no row');
  const chart = [...mergeChart(data.tt133, data.own).values()]
    .map((a) => ({ code: a.code, name: a.name, parentCode: a.parentCode }))
    .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  const opening = data.opening.map((o) => ({ accountCode: o.account_code, partyId: o.party_id, debit: o.debit ?? '0', credit: o.credit ?? '0' }));
  // Each (account, party) sum as one line of the year; only its account, party and amounts are read.
  const lines: PeriodLine[] = data.year.map((y, i) => ({
    entryId: `sum-${i}`,
    entryDate: period.to,
    reference: null,
    description: '',
    reversal: false,
    lineNo: i,
    accountCode: y.account_code,
    partyId: y.party_id,
    debit: y.debit ?? '0',
    credit: y.credit ?? '0',
  }));
  return trialBalance(chart, opening, lines);
}

function report(data: LedgerData): LedgerReport {
  return {
    period: data.period,
    trialBalance: trialBalance(data.chart, data.opening, data.lines),
    receivables: partyLedger(data.chart, data.opening, data.lines, RECEIVABLE_ACCOUNT, data.parties),
    payables: partyLedger(data.chart, data.opening, data.lines, PAYABLE_ACCOUNT, data.parties),
  };
}

function ledgerView(data: LedgerData, accountCode: string): AccountLedgerView {
  const ledger = accountLedger(data.chart, data.opening, data.lines, accountCode);
  return {
    period: data.period,
    ...ledger,
    lines: ledger.lines.map(({ partyId, ...line }) => ({ ...line, partyName: partyId ? (data.parties.get(partyId)?.name ?? null) : null })),
  };
}

export const ledgerPeriodQuery = defineQuery({
  name: 'finance.ledger.period',
  input: zLedgerPeriodInput,
  access: ALL,
  handler: async (ctx, input): Promise<LedgerReport> => report(await loadLedgerData(ctx, input.period, await resolveLegalEntity(ctx, input.legalEntityId))),
});

export const ledgerAccountQuery = defineQuery({
  name: 'finance.ledger.account',
  input: zLedgerPeriodInput.extend({ accountCode: zAccountCode }),
  access: ALL,
  handler: async (ctx, input): Promise<AccountLedgerView> => {
    const data = await loadLedgerData(ctx, input.period, await resolveLegalEntity(ctx, input.legalEntityId));
    if (!data.chart.some((a) => a.code === input.accountCode)) {
      throw new DomainError('UNKNOWN_ACCOUNT', 422, `Tài khoản ${input.accountCode} không có trong hệ thống tài khoản của tổ chức`);
    }
    return ledgerView(data, input.accountCode);
  },
});

// The whole workbook's content in one read: read by the Excel export only, so it is not in the oRPC contract.
export const ledgerBookQuery = defineQuery({
  name: 'finance.ledger.book',
  input: zLedgerPeriodInput,
  access: ALL,
  handler: async (ctx, input): Promise<LedgerBook> => {
    const data = await loadLedgerData(ctx, input.period, await resolveLegalEntity(ctx, input.legalEntityId));
    const base = report(data);
    const ledgers = base.trialBalance.rows.filter((row) => row.level === 0).map((row) => ledgerView(data, row.accountCode));
    return { ...base, ledgers, lines: data.lines.length };
  },
});

// Records one Excel export of a period's ledger reports after the workbook is built. It changes nothing: its audit
// row is the record, with the period and the number of journal lines, never their content. Same roles as the reports.
export const ledgerExport = defineCommand({
  name: 'finance.ledger.export',
  input: zLedgerPeriodInput.extend({ lines: z.number().int().nonnegative().max(LEDGER_LINE_LIMIT) }),
  risk: 'R0',
  access: ALL,
  handler: async (ctx, input) => {
    ctx.audit({ period: input.period, lines: input.lines, ...(input.legalEntityId ? { legal_entity_id: input.legalEntityId } : {}) });
    return { ok: true as const };
  },
});
