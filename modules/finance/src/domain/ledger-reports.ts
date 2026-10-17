// Ledger reports for a period (issue #321), as pure functions over posted journal lines:
// - the trial balance (bảng cân đối số phát sinh, form F01-DNN of Circular 133/2016/TT-BTC): per account the opening
//   balance, the period's debits and credits and the closing balance, each sub-account rolled up into its parent
//   along the chart (crove_finance.account.parent_code);
// - the general ledger of an account (sổ cái, sổ chi tiết tài khoản): the opening balance, every line of the period on
//   the account or its sub-accounts with the accounts on the other side of the entry, and the running balance;
// - receivables and payables per party (sổ chi tiết thanh toán với người mua, người bán: 131 and 331): opening
//   balance, increases, decreases and closing balance per customer or vendor.
//
// Every posted entry counts and nothing is left out. A reversal is a posted entry like any other: its lines add to
// the period's debits and credits as posted (each line of the original with debit and credit swapped), and the
// balances net out. B02 (tt133-reports.ts) treats reversals differently because it reports revenue, not turnover.
// The opening balance of a period is every entry dated before it, so an opening-balance entry is simply one of them.
//
// Receivable and payable accounts (131, 331 and their sub-accounts) show their balance per party on the trial
// balance, as on the statement of financial position: a vendor paid in advance is a debit balance of 331 next to the
// credit balances of the vendors still owed, not a smaller credit balance. Other accounts show their net balance.
//
// Amounts are decimal strings; arithmetic goes through decimal.js, never JS numbers.
import { LEDGER_PERIOD_PATTERN } from '@crove/kernel-contract';
import { money, type DecimalValue, type Money } from '@crove/l10n-vn';
import { canonical, parseDecimal } from './money.ts';
import { vatPeriod } from './vat-return.ts';

export { LEDGER_PERIOD_PATTERN };

export const RECEIVABLE_ACCOUNT = '131';
export const PAYABLE_ACCOUNT = '331';
// Accounts whose trial balance rows split the balance per party (with their sub-accounts).
export const PARTY_BALANCE_ACCOUNTS: readonly string[] = [RECEIVABLE_ACCOUNT, PAYABLE_ACCOUNT];

export interface LedgerPeriod {
  period: string;
  kind: 'month' | 'quarter' | 'year';
  from: string;
  to: string;
}

// A month ("2026-09"), a quarter ("2026-Q3") or a year ("2026"), both dates included.
export function ledgerPeriod(period: string): LedgerPeriod {
  const match = LEDGER_PERIOD_PATTERN.exec(period);
  if (!match || !match[1]) throw new Error(`not a ledger period: ${JSON.stringify(period)}`);
  if (match[2] === undefined) return { period, kind: 'year', from: `${match[1]}-01-01`, to: `${match[1]}-12-31` };
  return vatPeriod(period);
}

export interface ChartAccount {
  code: string;
  name: string;
  parentCode: string | null;
}

// Debits and credits of one (account, party) before the period: the opening balance.
export interface OpeningBalance {
  accountCode: string;
  partyId: string | null;
  debit: Money;
  credit: Money;
}

// One posted line of the period. The caller passes them in posting order (entry date, then the order the entries
// were posted, then line number); the running balances follow that order.
export interface PeriodLine {
  entryId: string;
  entryDate: string;
  reference: string | null;
  description: string;
  reversal: boolean;
  lineNo: number;
  accountCode: string;
  partyId: string | null;
  debit: Money;
  credit: Money;
}

export interface TrialBalanceAmounts {
  openingDebit: Money;
  openingCredit: Money;
  debit: Money;
  credit: Money;
  closingDebit: Money;
  closingCredit: Money;
}

export interface TrialBalanceRow extends TrialBalanceAmounts {
  accountCode: string;
  accountName: string;
  parentCode: string | null;
  level: number;
}

export interface TrialBalance {
  // Depth first along the chart: each account, then its sub-accounts.
  rows: TrialBalanceRow[];
  // The sums of the top-level rows (a sub-account is already in its parent).
  totals: TrialBalanceAmounts;
  // Opening debits equal opening credits, period debits equal period credits, closing debits equal closing credits.
  balanced: boolean;
}

interface Amounts {
  openingDebit: DecimalValue;
  openingCredit: DecimalValue;
  debit: DecimalValue;
  credit: DecimalValue;
  closingDebit: DecimalValue;
  closingCredit: DecimalValue;
}

const zero = (): Amounts => ({
  openingDebit: money(0),
  openingCredit: money(0),
  debit: money(0),
  credit: money(0),
  closingDebit: money(0),
  closingCredit: money(0),
});

const AMOUNT_KEYS = ['openingDebit', 'openingCredit', 'debit', 'credit', 'closingDebit', 'closingCredit'] as const;

function add(a: Amounts, b: Amounts): Amounts {
  const out = zero();
  for (const key of AMOUNT_KEYS) out[key] = a[key].plus(b[key]);
  return out;
}

function toMoney(a: Amounts): TrialBalanceAmounts {
  return {
    openingDebit: canonical(a.openingDebit),
    openingCredit: canonical(a.openingCredit),
    debit: canonical(a.debit),
    credit: canonical(a.credit),
    closingDebit: canonical(a.closingDebit),
    closingCredit: canonical(a.closingCredit),
  };
}

// The chart by code, and an account's line up to the top: [code, parent, grandparent, ...]. An account missing from
// the chart (the foreign key forbids it) is its own top. A cycle (also impossible) stops at the first repeat.
class Chart {
  readonly byCode: ReadonlyMap<string, ChartAccount>;
  constructor(accounts: ReadonlyArray<ChartAccount>) {
    this.byCode = new Map(accounts.map((a) => [a.code, a]));
  }

  lineage(code: string): string[] {
    const out = [code];
    let parent = this.byCode.get(code)?.parentCode ?? null;
    while (parent !== null && !out.includes(parent)) {
      out.push(parent);
      parent = this.byCode.get(parent)?.parentCode ?? null;
    }
    return out;
  }

  // The account itself or one of its sub-accounts, at any depth.
  within(code: string, root: string): boolean {
    return this.lineage(code).includes(root);
  }

  parentOf(code: string): string | null {
    const lineage = this.lineage(code);
    return lineage[1] ?? null;
  }

  name(code: string): string {
    return this.byCode.get(code)?.name ?? '';
  }
}

function sideSplit(nets: Iterable<DecimalValue>): { debit: DecimalValue; credit: DecimalValue } {
  let debit = money(0);
  let credit = money(0);
  for (const net of nets) {
    if (net.isPositive() && !net.isZero()) debit = debit.plus(net);
    else if (net.isNegative() && !net.isZero()) credit = credit.minus(net);
  }
  return { debit, credit };
}

const partyKey = (partyId: string | null) => partyId ?? '';

// The trial balance of the period: the opening balances (entries dated before it) and the period's lines.
export function trialBalance(chartAccounts: ReadonlyArray<ChartAccount>, opening: ReadonlyArray<OpeningBalance>, lines: ReadonlyArray<PeriodLine>): TrialBalance {
  const chart = new Chart(chartAccounts);
  // Per account posted to: the opening net balance (debit minus credit) and the period's net change per party, and
  // the period's debits and credits.
  const own = new Map<string, { opening: Map<string, DecimalValue>; change: Map<string, DecimalValue>; debit: DecimalValue; credit: DecimalValue }>();
  const ownOf = (code: string) => {
    let entry = own.get(code);
    if (!entry) {
      entry = { opening: new Map(), change: new Map(), debit: money(0), credit: money(0) };
      own.set(code, entry);
    }
    return entry;
  };
  for (const o of opening) {
    const entry = ownOf(o.accountCode);
    const key = partyKey(o.partyId);
    entry.opening.set(key, (entry.opening.get(key) ?? money(0)).plus(parseDecimal(o.debit)).minus(parseDecimal(o.credit)));
  }
  for (const l of lines) {
    const entry = ownOf(l.accountCode);
    const key = partyKey(l.partyId);
    const debit = parseDecimal(l.debit);
    const credit = parseDecimal(l.credit);
    entry.debit = entry.debit.plus(debit);
    entry.credit = entry.credit.plus(credit);
    entry.change.set(key, (entry.change.get(key) ?? money(0)).plus(debit).minus(credit));
  }

  // The amounts of each account's own lines.
  const ownAmounts = new Map<string, Amounts>();
  for (const [code, entry] of own) {
    const perParty = PARTY_BALANCE_ACCOUNTS.some((root) => chart.within(code, root));
    const parties = new Set([...entry.opening.keys(), ...entry.change.keys()]);
    const openingNets: DecimalValue[] = [];
    const closingNets: DecimalValue[] = [];
    for (const party of parties) {
      const openingNet = entry.opening.get(party) ?? money(0);
      openingNets.push(openingNet);
      closingNets.push(openingNet.plus(entry.change.get(party) ?? money(0)));
    }
    const sum = (values: DecimalValue[]) => values.reduce((acc, v) => acc.plus(v), money(0));
    const openingSides = sideSplit(perParty ? openingNets : [sum(openingNets)]);
    const closingSides = sideSplit(perParty ? closingNets : [sum(closingNets)]);
    ownAmounts.set(code, {
      openingDebit: openingSides.debit,
      openingCredit: openingSides.credit,
      debit: entry.debit,
      credit: entry.credit,
      closingDebit: closingSides.debit,
      closingCredit: closingSides.credit,
    });
  }

  // Every account posted to and every account above it; each row is its own lines plus its sub-accounts' rows.
  const children = new Map<string | null, Set<string>>();
  for (const code of own.keys()) {
    const lineage = chart.lineage(code);
    lineage.forEach((c, i) => {
      const parent = lineage[i + 1] ?? null;
      const set = children.get(parent) ?? new Set<string>();
      set.add(c);
      children.set(parent, set);
    });
  }
  const sortedChildren = (parent: string | null) => [...(children.get(parent) ?? [])].sort((a, b) => a.localeCompare(b));
  const totalOf = new Map<string, Amounts>();
  const amountsOf = (code: string): Amounts => {
    const cached = totalOf.get(code);
    if (cached) return cached;
    let total = ownAmounts.get(code) ?? zero();
    for (const child of sortedChildren(code)) total = add(total, amountsOf(child));
    totalOf.set(code, total);
    return total;
  };

  const rows: TrialBalanceRow[] = [];
  const visit = (code: string, level: number) => {
    const amounts = amountsOf(code);
    if (AMOUNT_KEYS.every((key) => amounts[key].isZero())) return;
    rows.push({ accountCode: code, accountName: chart.name(code), parentCode: chart.parentOf(code), level, ...toMoney(amounts) });
    for (const child of sortedChildren(code)) visit(child, level + 1);
  };
  let totals = zero();
  for (const top of sortedChildren(null)) {
    visit(top, 0);
    totals = add(totals, amountsOf(top));
  }
  const balanced = totals.openingDebit.equals(totals.openingCredit) && totals.debit.equals(totals.credit) && totals.closingDebit.equals(totals.closingCredit);
  return { rows, totals: toMoney(totals), balanced };
}

export interface AccountLedgerLine {
  entryId: string;
  entryDate: string;
  reference: string | null;
  description: string;
  reversal: boolean;
  // The account the line is on: the account itself or one of its sub-accounts.
  accountCode: string;
  // The accounts on the other side of the entry (tài khoản đối ứng), by line number.
  counterAccounts: string[];
  partyId: string | null;
  debit: Money;
  credit: Money;
  // Debit minus credit after this line.
  balance: Money;
}

export interface AccountLedger {
  account: { code: string; name: string };
  // Debit minus credit; negative is a credit balance.
  opening: Money;
  lines: AccountLedgerLine[];
  debit: Money;
  credit: Money;
  closing: Money;
}

// The general ledger of an account and its sub-accounts for the period, with the running balance.
export function accountLedger(
  chartAccounts: ReadonlyArray<ChartAccount>,
  opening: ReadonlyArray<OpeningBalance>,
  lines: ReadonlyArray<PeriodLine>,
  accountCode: string,
): AccountLedger {
  const chart = new Chart(chartAccounts);
  const inAccount = (code: string) => chart.within(code, accountCode);
  let balance = money(0);
  for (const o of opening) if (inAccount(o.accountCode)) balance = balance.plus(parseDecimal(o.debit)).minus(parseDecimal(o.credit));
  const openingBalance = balance;

  const byEntry = new Map<string, PeriodLine[]>();
  for (const l of lines) {
    const list = byEntry.get(l.entryId) ?? [];
    list.push(l);
    byEntry.set(l.entryId, list);
  }
  let debit = money(0);
  let credit = money(0);
  const out: AccountLedgerLine[] = [];
  for (const l of lines) {
    if (!inAccount(l.accountCode)) continue;
    const d = parseDecimal(l.debit);
    const c = parseDecimal(l.credit);
    debit = debit.plus(d);
    credit = credit.plus(c);
    balance = balance.plus(d).minus(c);
    const isDebit = !d.isZero();
    const counter: string[] = [];
    for (const other of [...(byEntry.get(l.entryId) ?? [])].sort((a, b) => a.lineNo - b.lineNo)) {
      const otherIsDebit = !parseDecimal(other.debit).isZero();
      if (otherIsDebit !== isDebit && !counter.includes(other.accountCode)) counter.push(other.accountCode);
    }
    out.push({
      entryId: l.entryId,
      entryDate: l.entryDate,
      reference: l.reference,
      description: l.description,
      reversal: l.reversal,
      accountCode: l.accountCode,
      counterAccounts: counter,
      partyId: l.partyId,
      debit: canonical(d),
      credit: canonical(c),
      balance: canonical(balance),
    });
  }
  return {
    account: { code: accountCode, name: chart.name(accountCode) },
    opening: canonical(openingBalance),
    lines: out,
    debit: canonical(debit),
    credit: canonical(credit),
    closing: canonical(balance),
  };
}

export interface PartyInfo {
  name: string;
  taxCode: string | null;
}

export interface PartyBalance {
  partyId: string | null;
  partyName: string | null;
  partyTaxCode: string | null;
  // In the account's own direction: what the customer owes (131), or what is owed to the vendor (331). Negative is an
  // advance (a customer who paid ahead, a vendor paid ahead).
  opening: Money;
  increase: Money;
  decrease: Money;
  closing: Money;
}

export interface PartyLedger {
  accountCode: string;
  // By party name; lines with no party last.
  rows: PartyBalance[];
  totals: { opening: Money; increase: Money; decrease: Money; closing: Money };
}

// Receivables (131: increases are debits) or payables (331: increases are credits) per party for the period, with
// their sub-accounts. A party whose four amounts are all zero is left out.
export function partyLedger(
  chartAccounts: ReadonlyArray<ChartAccount>,
  opening: ReadonlyArray<OpeningBalance>,
  lines: ReadonlyArray<PeriodLine>,
  accountCode: typeof RECEIVABLE_ACCOUNT | typeof PAYABLE_ACCOUNT,
  parties: ReadonlyMap<string, PartyInfo>,
): PartyLedger {
  const chart = new Chart(chartAccounts);
  // +1: the balance is debit minus credit (131); -1: credit minus debit (331).
  const sign = accountCode === RECEIVABLE_ACCOUNT ? 1 : -1;
  const byParty = new Map<string, { partyId: string | null; opening: DecimalValue; increase: DecimalValue; decrease: DecimalValue }>();
  const of = (partyId: string | null) => {
    const key = partyKey(partyId);
    let entry = byParty.get(key);
    if (!entry) {
      entry = { partyId, opening: money(0), increase: money(0), decrease: money(0) };
      byParty.set(key, entry);
    }
    return entry;
  };
  for (const o of opening) {
    if (!chart.within(o.accountCode, accountCode)) continue;
    const entry = of(o.partyId);
    entry.opening = entry.opening.plus(parseDecimal(o.debit).minus(parseDecimal(o.credit)).times(sign));
  }
  for (const l of lines) {
    if (!chart.within(l.accountCode, accountCode)) continue;
    const entry = of(l.partyId);
    const [up, down] = sign === 1 ? [l.debit, l.credit] : [l.credit, l.debit];
    entry.increase = entry.increase.plus(parseDecimal(up));
    entry.decrease = entry.decrease.plus(parseDecimal(down));
  }
  const rows: PartyBalance[] = [];
  let totals = { opening: money(0), increase: money(0), decrease: money(0), closing: money(0) };
  for (const entry of byParty.values()) {
    const closing = entry.opening.plus(entry.increase).minus(entry.decrease);
    if (entry.opening.isZero() && entry.increase.isZero() && entry.decrease.isZero() && closing.isZero()) continue;
    const info = entry.partyId === null ? undefined : parties.get(entry.partyId);
    rows.push({
      partyId: entry.partyId,
      partyName: info?.name ?? null,
      partyTaxCode: info?.taxCode ?? null,
      opening: canonical(entry.opening),
      increase: canonical(entry.increase),
      decrease: canonical(entry.decrease),
      closing: canonical(closing),
    });
    totals = {
      opening: totals.opening.plus(entry.opening),
      increase: totals.increase.plus(entry.increase),
      decrease: totals.decrease.plus(entry.decrease),
      closing: totals.closing.plus(closing),
    };
  }
  rows.sort((a, b) => {
    if ((a.partyId === null) !== (b.partyId === null)) return a.partyId === null ? 1 : -1;
    return (a.partyName ?? '').localeCompare(b.partyName ?? '', 'vi') || (a.partyId ?? '').localeCompare(b.partyId ?? '');
  });
  return {
    accountCode,
    rows,
    totals: { opening: canonical(totals.opening), increase: canonical(totals.increase), decrease: canonical(totals.decrease), closing: canonical(totals.closing) },
  };
}
