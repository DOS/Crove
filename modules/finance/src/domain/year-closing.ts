// Year-end closing entries (issue #889), kết chuyển, as pure functions. TT133 closes the year through 911 (Xác định
// kết quả kinh doanh): the revenue and income accounts (classes 5 and 7) and the cost and expense accounts (classes 6
// and 8) are moved to 911, so each of them is zero, and 911's balance, the year's result, is moved to 4212 (Lợi nhuận
// sau thuế chưa phân phối năm nay): a profit credits 4212, a loss debits it.
//
// The balances are each account's own, through the year's last day, so a year that an earlier year left unclosed is
// closed too. One line per account (a sub-account is closed on its own line), in account order: first the revenue
// side and its 911 credit, then the 911 debit and the cost side, then the result. Each line is on one side, as a
// general journal voucher's lines are.
import { money, toMoney, type Money } from '@crove/l10n-vn';
import { CLOSING_ACCOUNT } from './tt133-reports.ts';

export const RETAINED_EARNINGS_ACCOUNT = '4212';

export interface AccountBalance {
  accountCode: string;
  debit: string;
  credit: string;
}

export interface ClosingLine {
  account: string;
  debit: Money;
  credit: Money;
}

// The accounts closed to 911: classes 5 to 8.
export const isResultAccount = (code: string) => /^[5-8]/.test(code);

export function closingLines(balances: readonly AccountBalance[]): ClosingLine[] {
  const zero = money('0');
  const revenue: ClosingLine[] = [];
  const costs: ClosingLine[] = [];
  let toClosing = zero;
  let fromClosing = zero;
  // 911's own balance before closing (it is normally zero), which the result line also clears.
  let closingBefore = zero;
  for (const b of [...balances].sort((x, y) => (x.accountCode < y.accountCode ? -1 : x.accountCode > y.accountCode ? 1 : 0))) {
    const net = money(b.debit).minus(money(b.credit));
    if (b.accountCode.startsWith(CLOSING_ACCOUNT)) {
      closingBefore = closingBefore.plus(net);
      continue;
    }
    if (!isResultAccount(b.accountCode) || net.isZero()) continue;
    if (net.isNegative()) {
      // A credit balance (revenue, income): debit the account, credit 911.
      revenue.push({ account: b.accountCode, debit: toMoney(net.negated()), credit: '0' });
      toClosing = toClosing.plus(net.negated());
    } else {
      // A debit balance (cost, expense): credit the account, debit 911.
      costs.push({ account: b.accountCode, debit: '0', credit: toMoney(net) });
      fromClosing = fromClosing.plus(net);
    }
  }
  const lines: ClosingLine[] = [...revenue];
  if (!toClosing.isZero()) lines.push({ account: CLOSING_ACCOUNT, debit: '0', credit: toMoney(toClosing) });
  if (!fromClosing.isZero()) lines.push({ account: CLOSING_ACCOUNT, debit: toMoney(fromClosing), credit: '0' });
  lines.push(...costs);
  // 911 after the transfers: a credit balance is the year's profit, a debit balance its loss.
  const result = closingBefore.plus(fromClosing).minus(toClosing);
  if (result.isNegative()) {
    lines.push({ account: CLOSING_ACCOUNT, debit: toMoney(result.negated()), credit: '0' });
    lines.push({ account: RETAINED_EARNINGS_ACCOUNT, debit: '0', credit: toMoney(result.negated()) });
  } else if (!result.isZero()) {
    lines.push({ account: RETAINED_EARNINGS_ACCOUNT, debit: toMoney(result), credit: '0' });
    lines.push({ account: CLOSING_ACCOUNT, debit: '0', credit: toMoney(result) });
  }
  return lines;
}

// The year's result as closed: positive for a profit, negative for a loss.
export function closingResult(lines: readonly ClosingLine[]): Money {
  const credit = lines.filter((l) => l.account === RETAINED_EARNINGS_ACCOUNT).reduce((t, l) => t.plus(money(l.credit)).minus(money(l.debit)), money('0'));
  return toMoney(credit);
}

export const closingDescription = (year: number) => `Kết chuyển xác định kết quả kinh doanh năm ${year}`;
