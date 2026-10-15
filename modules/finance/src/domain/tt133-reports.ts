// DRAFT: TT133 (Circular 133/2016/TT-BTC) financial statements for small and medium enterprises, computed
// from posted entries as pure functions:
// - B01-DNN, Statement of financial position (Báo cáo tình hình tài chính), at a date;
// - B02-DNN, Income statement (Báo cáo kết quả hoạt động kinh doanh), for a period.
// The line codes and the account mapping below were written from the circular's form and its guidance as we
// understand them. An accountant has not verified them yet (issue #154); until then these reports are not
// for filing. The mapping is data, so a correction is a change to the tables, not to the code.
import { money, type DecimalValue, type Money } from '@crove/l10n-vn';
import type { PostedEntry } from './ledger.ts';
import { canonical, parseDecimal } from './money.ts';

export interface ReportLineInput {
  accountCode: string;
  partyId: string | null;
  debit: Money;
  credit: Money;
}

export interface ReportEntry {
  legalEntityId: string;
  entryDate: string;
  currency: string;
  // A reversal (it has `reverses_id`). Its lines count as negative amounts on the side of the line they
  // undo, so a cancelled sale lowers revenue (B02 code 01) instead of appearing as a deduction (code 02).
  reversal: boolean;
  lines: ReadonlyArray<ReportLineInput>;
}

// How a rule reads the accounts it matches (by prefix of the account code):
// - 'debit' / 'credit': the debit (or credit) balance of each account, or of each (account, party) when
//   `byParty` is set, so a customer who paid in advance is a liability, not a smaller receivable;
// - 'netDebit' / 'netCredit': the net balance over all matched accounts, which may be negative;
// - 'debitTurnover' / 'creditTurnover': the debits (or credits) posted in the period.
export type Take = 'debit' | 'credit' | 'netDebit' | 'netCredit' | 'debitTurnover' | 'creditTurnover';

export interface AccountRule {
  prefixes: readonly string[];
  take: Take;
  // -1 for the lines the form marks (*): contra accounts shown as negative amounts.
  sign?: -1;
  byParty?: true;
}

export interface ReportLineDef {
  code: string;
  label: string;
  rules?: readonly AccountRule[];
  // Earlier codes, added (+1) or subtracted (-1).
  formula?: ReadonlyArray<readonly [1 | -1, string]>;
}

export interface ReportLine {
  code: string;
  label: string;
  amount: Money;
}

export interface UnmappedBalance {
  accountCode: string;
  partyId: string | null;
  amount: Money;
}

export interface Report {
  lines: ReportLine[];
  // Balances (B01) or period activity (B02) that no line reads. Non-empty means the mapping is incomplete
  // for this ledger and the report must not be used.
  unmapped: UnmappedBalance[];
}

const plus = (...codes: string[]) => codes.map((c) => [1, c] as const);

// B01-DNN (TT133), going-concern form. Codes and mapping: DRAFT, see the header.
export const B01_LINES: readonly ReportLineDef[] = [
  { code: '110', label: 'Tiền và các khoản tương đương tiền', rules: [{ prefixes: ['111', '112'], take: 'debit' }] },
  { code: '121', label: 'Chứng khoán kinh doanh', rules: [{ prefixes: ['121'], take: 'debit' }] },
  { code: '122', label: 'Đầu tư nắm giữ đến ngày đáo hạn', rules: [{ prefixes: ['128'], take: 'debit' }] },
  { code: '123', label: 'Đầu tư góp vốn vào đơn vị khác', rules: [{ prefixes: ['228'], take: 'debit' }] },
  { code: '124', label: 'Dự phòng tổn thất đầu tư tài chính (*)', rules: [{ prefixes: ['2291', '2292'], take: 'credit', sign: -1 }] },
  { code: '120', label: 'Đầu tư tài chính', formula: plus('121', '122', '123', '124') },
  { code: '131', label: 'Phải thu của khách hàng', rules: [{ prefixes: ['131'], take: 'debit', byParty: true }] },
  { code: '132', label: 'Trả trước cho người bán', rules: [{ prefixes: ['331'], take: 'debit', byParty: true }] },
  { code: '133', label: 'Vốn kinh doanh ở đơn vị trực thuộc', rules: [{ prefixes: ['1361'], take: 'debit' }] },
  { code: '134', label: 'Phải thu khác', rules: [{ prefixes: ['1368', '1386', '1388', '141', '334', '338'], take: 'debit' }] },
  { code: '135', label: 'Tài sản thiếu chờ xử lý', rules: [{ prefixes: ['1381'], take: 'debit' }] },
  { code: '136', label: 'Dự phòng phải thu khó đòi (*)', rules: [{ prefixes: ['2293'], take: 'credit', sign: -1 }] },
  { code: '130', label: 'Các khoản phải thu', formula: plus('131', '132', '133', '134', '135', '136') },
  { code: '141', label: 'Hàng tồn kho', rules: [{ prefixes: ['151', '152', '153', '154', '155', '156', '157'], take: 'debit' }] },
  { code: '142', label: 'Dự phòng giảm giá hàng tồn kho (*)', rules: [{ prefixes: ['2294'], take: 'credit', sign: -1 }] },
  { code: '140', label: 'Hàng tồn kho', formula: plus('141', '142') },
  { code: '151', label: 'Tài sản cố định: nguyên giá', rules: [{ prefixes: ['211'], take: 'debit' }] },
  { code: '152', label: 'Tài sản cố định: giá trị hao mòn lũy kế (*)', rules: [{ prefixes: ['2141', '2142', '2143'], take: 'credit', sign: -1 }] },
  { code: '150', label: 'Tài sản cố định', formula: plus('151', '152') },
  { code: '161', label: 'Bất động sản đầu tư: nguyên giá', rules: [{ prefixes: ['217'], take: 'debit' }] },
  { code: '162', label: 'Bất động sản đầu tư: giá trị hao mòn lũy kế (*)', rules: [{ prefixes: ['2147'], take: 'credit', sign: -1 }] },
  { code: '160', label: 'Bất động sản đầu tư', formula: plus('161', '162') },
  { code: '170', label: 'Xây dựng cơ bản dở dang', rules: [{ prefixes: ['241'], take: 'debit' }] },
  { code: '181', label: 'Thuế GTGT được khấu trừ', rules: [{ prefixes: ['133'], take: 'debit' }] },
  { code: '182', label: 'Tài sản khác', rules: [{ prefixes: ['242', '333'], take: 'debit' }] },
  { code: '180', label: 'Tài sản khác', formula: plus('181', '182') },
  { code: '200', label: 'TỔNG CỘNG TÀI SẢN', formula: plus('110', '120', '130', '140', '150', '160', '170', '180') },
  { code: '311', label: 'Phải trả người bán', rules: [{ prefixes: ['331'], take: 'credit', byParty: true }] },
  { code: '312', label: 'Người mua trả tiền trước', rules: [{ prefixes: ['131'], take: 'credit', byParty: true }] },
  { code: '313', label: 'Thuế và các khoản phải nộp Nhà nước', rules: [{ prefixes: ['333'], take: 'credit' }] },
  { code: '314', label: 'Phải trả người lao động', rules: [{ prefixes: ['334'], take: 'credit' }] },
  { code: '315', label: 'Phải trả khác', rules: [{ prefixes: ['335', '3368', '338', '1388'], take: 'credit' }] },
  { code: '316', label: 'Vay và nợ thuê tài chính', rules: [{ prefixes: ['341'], take: 'credit' }] },
  { code: '317', label: 'Phải trả nội bộ về vốn kinh doanh', rules: [{ prefixes: ['3361'], take: 'credit' }] },
  { code: '318', label: 'Dự phòng phải trả', rules: [{ prefixes: ['352'], take: 'credit' }] },
  { code: '319', label: 'Quỹ khen thưởng, phúc lợi', rules: [{ prefixes: ['353'], take: 'credit' }] },
  { code: '320', label: 'Quỹ phát triển khoa học và công nghệ', rules: [{ prefixes: ['356'], take: 'credit' }] },
  { code: '300', label: 'NỢ PHẢI TRẢ', formula: plus('311', '312', '313', '314', '315', '316', '317', '318', '319', '320') },
  { code: '411', label: 'Vốn góp của chủ sở hữu', rules: [{ prefixes: ['4111'], take: 'credit' }] },
  { code: '412', label: 'Thặng dư vốn cổ phần', rules: [{ prefixes: ['4112'], take: 'netCredit' }] },
  { code: '413', label: 'Vốn khác của chủ sở hữu', rules: [{ prefixes: ['4118'], take: 'credit' }] },
  { code: '414', label: 'Cổ phiếu quỹ (*)', rules: [{ prefixes: ['419'], take: 'debit', sign: -1 }] },
  { code: '415', label: 'Chênh lệch tỷ giá hối đoái', rules: [{ prefixes: ['413'], take: 'netCredit' }] },
  { code: '416', label: 'Các quỹ thuộc vốn chủ sở hữu', rules: [{ prefixes: ['418'], take: 'credit' }] },
  // Retained earnings include the result not yet closed to 421: revenue, income and expense accounts
  // (classes 5 to 8) and 911. After the year-end closing entries those are all zero.
  { code: '417', label: 'Lợi nhuận sau thuế chưa phân phối', rules: [{ prefixes: ['421', '5', '6', '7', '8', '911'], take: 'netCredit' }] },
  { code: '400', label: 'VỐN CHỦ SỞ HỮU', formula: plus('411', '412', '413', '414', '415', '416', '417') },
  { code: '500', label: 'TỔNG CỘNG NGUỒN VỐN', formula: plus('300', '400') },
];

// B02-DNN (TT133). Codes and mapping: DRAFT, see the header. Code 23 (interest expense, part of 22) reads
// the detail account 6351: TT133 has no standard sub-account for it, so this is a Crove convention the
// accountant must confirm.
export const B02_LINES: readonly ReportLineDef[] = [
  { code: '01', label: 'Doanh thu bán hàng và cung cấp dịch vụ', rules: [{ prefixes: ['511'], take: 'creditTurnover' }] },
  { code: '02', label: 'Các khoản giảm trừ doanh thu', rules: [{ prefixes: ['511'], take: 'debitTurnover' }] },
  { code: '10', label: 'Doanh thu thuần về bán hàng và cung cấp dịch vụ', formula: [[1, '01'], [-1, '02']] },
  { code: '11', label: 'Giá vốn hàng bán', rules: [{ prefixes: ['632'], take: 'netDebit' }] },
  { code: '20', label: 'Lợi nhuận gộp về bán hàng và cung cấp dịch vụ', formula: [[1, '10'], [-1, '11']] },
  { code: '21', label: 'Doanh thu hoạt động tài chính', rules: [{ prefixes: ['515'], take: 'netCredit' }] },
  { code: '22', label: 'Chi phí tài chính', rules: [{ prefixes: ['635'], take: 'netDebit' }] },
  { code: '23', label: 'Trong đó: Chi phí lãi vay', rules: [{ prefixes: ['6351'], take: 'netDebit' }] },
  { code: '24', label: 'Chi phí quản lý kinh doanh', rules: [{ prefixes: ['642'], take: 'netDebit' }] },
  { code: '30', label: 'Lợi nhuận thuần từ hoạt động kinh doanh', formula: [[1, '20'], [1, '21'], [-1, '22'], [-1, '24']] },
  { code: '31', label: 'Thu nhập khác', rules: [{ prefixes: ['711'], take: 'netCredit' }] },
  { code: '32', label: 'Chi phí khác', rules: [{ prefixes: ['811'], take: 'netDebit' }] },
  { code: '40', label: 'Lợi nhuận khác', formula: [[1, '31'], [-1, '32']] },
  { code: '50', label: 'Tổng lợi nhuận kế toán trước thuế', formula: [[1, '30'], [1, '40']] },
  { code: '51', label: 'Chi phí thuế thu nhập doanh nghiệp', rules: [{ prefixes: ['821'], take: 'netDebit' }] },
  { code: '60', label: 'Lợi nhuận sau thuế thu nhập doanh nghiệp', formula: [[1, '50'], [-1, '51']] },
];

// The account the year-end closing entries go through. B02 leaves out every entry that touches it, so the
// statement shows the period's activity whether or not the year has been closed.
export const CLOSING_ACCOUNT = '911';

// Report input from ledger entries; a reversal is an entry with `reversesId`.
export function reportEntries(entries: ReadonlyArray<PostedEntry>): ReportEntry[] {
  return entries.map((e) => ({ legalEntityId: e.legalEntityId, entryDate: e.entryDate, currency: e.currency, reversal: e.reversesId !== null, lines: e.lines }));
}

// Debit and credit totals of one account, or of one (account, party).
interface Bucket {
  accountCode: string;
  partyId: string | null;
  debit: DecimalValue;
  credit: DecimalValue;
}

function matches(rule: AccountRule, accountCode: string): boolean {
  return rule.prefixes.some((p) => accountCode.startsWith(p));
}

function checkCurrency(entries: ReadonlyArray<ReportEntry>, bookCurrency: string): void {
  const other = entries.find((e) => e.currency !== bookCurrency);
  if (other) throw new Error(`reports are in the book currency ${bookCurrency}; an entry dated ${other.entryDate} is in ${other.currency}`);
}

function buckets(entries: ReadonlyArray<ReportEntry>, byParty: boolean): Bucket[] {
  const map = new Map<string, Bucket>();
  for (const entry of entries) {
    for (const line of entry.lines) {
      const partyId = byParty ? line.partyId : null;
      const key = JSON.stringify([line.accountCode, partyId]);
      const bucket = map.get(key) ?? { accountCode: line.accountCode, partyId, debit: money(0), credit: money(0) };
      const debit = parseDecimal(line.debit);
      const credit = parseDecimal(line.credit);
      if (entry.reversal) {
        bucket.debit = bucket.debit.minus(credit);
        bucket.credit = bucket.credit.minus(debit);
      } else {
        bucket.debit = bucket.debit.plus(debit);
        bucket.credit = bucket.credit.plus(credit);
      }
      map.set(key, bucket);
    }
  }
  return [...map.values()].sort((a, b) => a.accountCode.localeCompare(b.accountCode) || (a.partyId ?? '').localeCompare(b.partyId ?? ''));
}

function evaluate(defs: readonly ReportLineDef[], ruleValue: (rule: AccountRule) => DecimalValue): ReportLine[] {
  const values = new Map<string, DecimalValue>();
  const lines: ReportLine[] = [];
  for (const def of defs) {
    let value = money(0);
    for (const rule of def.rules ?? []) value = value.plus(ruleValue(rule).times(rule.sign ?? 1));
    for (const [sign, code] of def.formula ?? []) {
      const part = values.get(code);
      if (part === undefined) throw new Error(`line ${def.code} refers to ${code}, which is not defined before it`);
      value = value.plus(part.times(sign));
    }
    values.set(def.code, value);
    lines.push({ code: def.code, label: def.label, amount: canonical(value) });
  }
  return lines;
}

interface AccountReaders {
  debit: AccountRule | undefined;
  credit: AccountRule | undefined;
  byParty: boolean;
}

// The rules that read each side of an account's balance. Each side must be read at most once, or the
// statement would count it twice, and all rules on one account must agree on the party grouping.
function readersOf(rules: readonly AccountRule[], accountCode: string): AccountReaders {
  const matching = rules.filter((r) => matches(r, accountCode));
  const debit = matching.filter((r) => r.take === 'debit' || r.take === 'netDebit' || r.take === 'netCredit');
  const credit = matching.filter((r) => r.take === 'credit' || r.take === 'netDebit' || r.take === 'netCredit');
  if (debit.length > 1 || credit.length > 1) throw new Error(`B01 mapping reads account ${accountCode} more than once`);
  const byParty = matching.some((r) => r.byParty === true);
  if (byParty && !matching.every((r) => r.byParty === true)) throw new Error(`B01 mapping groups account ${accountCode} inconsistently`);
  return { debit: debit[0], credit: credit[0], byParty };
}

// The entries of one legal entity: a statement is per legal entity, never a sum over several.
function ofEntity(entries: ReadonlyArray<ReportEntry>, legalEntityId: string, bookCurrency: string): ReportEntry[] {
  const own = entries.filter((e) => e.legalEntityId === legalEntityId);
  checkCurrency(own, bookCurrency);
  return own;
}

// B01 of one legal entity at `asOf` (inclusive), from every entry dated on or before it.
export function buildB01(
  entries: ReadonlyArray<ReportEntry>,
  legalEntityId: string,
  asOf: string,
  bookCurrency = 'VND',
): Report & { balanced: boolean } {
  const upTo = ofEntity(entries, legalEntityId, bookCurrency).filter((e) => e.entryDate <= asOf);
  const rules = B01_LINES.flatMap((d) => d.rules ?? []);
  const perParty = buckets(upTo, true);
  const perAccount = buckets(upTo, false);
  const readers = new Map(perAccount.map((b) => [b.accountCode, readersOf(rules, b.accountCode)]));
  // The balances each account is read at: per party when its rules say so, else per account.
  const balances = [
    ...perAccount.filter((b) => readers.get(b.accountCode)?.byParty !== true),
    ...perParty.filter((b) => readers.get(b.accountCode)?.byParty === true),
  ];

  const ruleValue = (rule: AccountRule): DecimalValue => {
    if (rule.take === 'debitTurnover' || rule.take === 'creditTurnover') throw new Error(`B01 does not read turnover (${rule.take})`);
    let value = money(0);
    for (const b of balances.filter((x) => matches(rule, x.accountCode))) {
      const net = b.debit.minus(b.credit);
      if (rule.take === 'netDebit') value = value.plus(net);
      else if (rule.take === 'netCredit') value = value.minus(net);
      else if (rule.take === 'debit' && net.greaterThan(0)) value = value.plus(net);
      else if (rule.take === 'credit' && net.lessThan(0)) value = value.minus(net);
    }
    return value;
  };
  const lines = evaluate(B01_LINES, ruleValue);

  // A balance whose side no rule reads: the statement would silently drop it.
  const unmapped: UnmappedBalance[] = [];
  for (const b of balances) {
    const net = b.debit.minus(b.credit);
    if (net.isZero()) continue;
    const reader = readers.get(b.accountCode);
    if ((net.greaterThan(0) ? reader?.debit : reader?.credit) === undefined) {
      unmapped.push({ accountCode: b.accountCode, partyId: b.partyId, amount: canonical(net) });
    }
  }

  const total = (code: string) => money(lines.find((l) => l.code === code)?.amount ?? '0');
  return { lines, unmapped, balanced: total('200').equals(total('500')) };
}

// B02 of one legal entity for the period [from, to] (inclusive), leaving out the year-end closing entries
// (any line on 911).
export function buildB02(entries: ReadonlyArray<ReportEntry>, legalEntityId: string, from: string, to: string, bookCurrency = 'VND'): Report {
  const inPeriod = ofEntity(entries, legalEntityId, bookCurrency).filter(
    (e) => e.entryDate >= from && e.entryDate <= to && !e.lines.some((l) => l.accountCode.startsWith(CLOSING_ACCOUNT)),
  );
  const activity = buckets(inPeriod, false);
  const rules = B02_LINES.flatMap((d) => d.rules ?? []);
  const ruleValue = (rule: AccountRule): DecimalValue => {
    let value = money(0);
    for (const b of activity.filter((x) => matches(rule, x.accountCode))) {
      if (rule.take === 'debitTurnover') value = value.plus(b.debit);
      else if (rule.take === 'creditTurnover') value = value.plus(b.credit);
      else if (rule.take === 'netDebit') value = value.plus(b.debit.minus(b.credit));
      else if (rule.take === 'netCredit') value = value.plus(b.credit.minus(b.debit));
      else throw new Error(`B02 does not read balances (${rule.take})`);
    }
    return value;
  };
  const lines = evaluate(B02_LINES, ruleValue);

  // Activity on a revenue, income or expense account (classes 5 to 8) that no line reads.
  const unmapped: UnmappedBalance[] = activity
    .filter((b) => /^[5-8]/.test(b.accountCode) && !rules.some((r) => matches(r, b.accountCode)))
    .filter((b) => !(b.debit.isZero() && b.credit.isZero()))
    .map((b) => ({ accountCode: b.accountCode, partyId: null, amount: canonical(b.debit.minus(b.credit)) }));
  return { lines, unmapped };
}

