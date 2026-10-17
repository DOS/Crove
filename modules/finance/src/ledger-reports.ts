// Ledger reports for a month, quarter or year (issue #321): finance.ledger.period answers the trial balance and the
// receivables and payables per party, finance.ledger.account the general ledger of one account, and
// finance.ledger.book all of them for the Excel workbook (GET /api/export/ledger.xlsx), whose download
// finance.ledger.export records, like finance.vat.export. The rules are pure functions in domain/ledger-reports.ts.
//
// Every posted entry counts, reversals included; the opening balance is every entry dated before the period.
import { z } from 'zod';
import type { MemberRole } from '@crove/db';
import { zAccountCode, zLedgerPeriod } from '@crove/kernel-contract';
import { DomainError, defineCommand, defineQuery, type QueryContext } from '@crove/kernel-runtime';
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

export const zLedgerPeriodInput = z.object({ period: zLedgerPeriod });

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

async function loadLedgerData(ctx: QueryContext, periodText: string): Promise<LedgerData> {
  const period = ledgerPeriod(periodText);
  const chart = (await ctx.trx.selectFrom('crove_finance.account').select(['code', 'name', 'parent_code']).orderBy('code').execute()).map((a) => ({
    code: a.code,
    name: a.name,
    parentCode: a.parent_code,
  }));

  // The opening balance: the debits and credits of every entry dated before the period, per account and party.
  const opening = await ctx.trx
    .selectFrom('crove_finance.journal_line as l')
    .innerJoin('crove_finance.journal_entry as j', (join) => join.onRef('j.org_id', '=', 'l.org_id').onRef('j.id', '=', 'l.entry_id'))
    .select(['l.account_code', 'l.party_id'])
    .select((eb) => [eb.fn.sum<string>('l.debit').as('debit'), eb.fn.sum<string>('l.credit').as('credit')])
    .where('l.org_id', '=', ctx.orgId)
    .where('j.entry_date', '<', period.from)
    .groupBy(['l.account_code', 'l.party_id'])
    .orderBy('l.account_code')
    .execute();

  // The period's lines in posting order; the purchase invoice an entry records gives its reference.
  const rows = await ctx.trx
    .selectFrom('crove_finance.journal_entry as j')
    .innerJoin('crove_finance.journal_line as l', (join) => join.onRef('l.org_id', '=', 'j.org_id').onRef('l.entry_id', '=', 'j.id'))
    .leftJoin('crove_finance.purchase_document as d', (join) =>
      join.onRef('d.org_id', '=', 'j.org_id').onRef('d.id', '=', 'j.source_id').on('j.source_type', '=', 'finance.purchase_document'),
    )
    .select([
      'j.id',
      'j.entry_date',
      'j.description',
      'j.reverses_entry_id',
      'd.invoice_series',
      'd.invoice_number',
      'l.line_no',
      'l.account_code',
      'l.party_id',
      'l.debit',
      'l.credit',
    ])
    .where('j.org_id', '=', ctx.orgId)
    .where('j.entry_date', '>=', period.from)
    .where('j.entry_date', '<=', period.to)
    .orderBy('j.entry_date')
    .orderBy('j.created_at')
    .orderBy('j.id')
    .orderBy('l.line_no')
    .limit(LEDGER_LINE_LIMIT + 1)
    .execute();
  if (rows.length > LEDGER_LINE_LIMIT) {
    throw new DomainError('PERIOD_TOO_LARGE', 422, `Kỳ này có hơn ${LEDGER_LINE_LIMIT} dòng bút toán; hãy chọn kỳ ngắn hơn`);
  }

  const partyIds = [...new Set([...opening, ...rows].flatMap((r) => (r.party_id ? [r.party_id] : [])))];
  const parties = new Map<string, PartyInfo>();
  if (partyIds.length > 0) {
    const found = await ctx.trx
      .selectFrom('crove_kernel.party')
      .select(['id', 'name', 'tax_code'])
      .where('org_id', '=', ctx.orgId)
      .where('id', 'in', partyIds)
      .execute();
    for (const p of found) parties.set(p.id, { name: p.name, taxCode: p.tax_code });
  }

  return {
    period,
    chart,
    opening: opening.map((o) => ({ accountCode: o.account_code, partyId: o.party_id, debit: o.debit ?? '0', credit: o.credit ?? '0' })),
    lines: rows.map((r) => ({
      entryId: r.id,
      entryDate: r.entry_date,
      reference: r.invoice_number ? `${r.invoice_series ? `${r.invoice_series}-` : ''}${r.invoice_number}` : null,
      description: r.description,
      reversal: r.reverses_entry_id !== null,
      lineNo: r.line_no,
      accountCode: r.account_code,
      partyId: r.party_id,
      debit: r.debit,
      credit: r.credit,
    })),
    parties,
  };
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
  handler: async (ctx, input): Promise<LedgerReport> => report(await loadLedgerData(ctx, input.period)),
});

export const ledgerAccountQuery = defineQuery({
  name: 'finance.ledger.account',
  input: zLedgerPeriodInput.extend({ accountCode: zAccountCode }),
  access: ALL,
  handler: async (ctx, input): Promise<AccountLedgerView> => {
    const data = await loadLedgerData(ctx, input.period);
    if (!data.chart.some((a) => a.code === input.accountCode)) {
      throw new DomainError('UNKNOWN_ACCOUNT', 422, `Tài khoản ${input.accountCode} không thuộc hệ thống tài khoản`);
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
    const data = await loadLedgerData(ctx, input.period);
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
    ctx.audit({ period: input.period, lines: input.lines });
    return { ok: true as const };
  },
});
