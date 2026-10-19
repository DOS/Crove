// Cash and bank vouchers (issue #327): the problems of a voucher, its TT133 journal, its number and its texts.
import { describe, expect, it } from 'vitest';
import {
  VOUCHER_TYPES,
  cashRootOf,
  defaultCounterAccount,
  isInflow,
  needsParty,
  voucherCode,
  zCashVoucherRequest,
  zVoucherAmount,
  type VoucherLine,
  type VoucherType,
} from '@crove/kernel-contract';
import { journalIsBalanced, money, sum } from '@crove/l10n-vn';
import { buildVoucherJournal, voucherEntryDescription, voucherProblems, voucherTitle, voucherTotal } from '../src/domain/cash-voucher.ts';

const PARTY = '0192f0c0-0000-7000-8000-000000000001';
const voucher = (type: VoucherType, cashAccount: string, lines: VoucherLine[], partyId: string | null = PARTY) => ({ type, cashAccount, partyId, lines });

describe('voucher numbers', () => {
  it('writes the prefix of each type and five digits', () => {
    expect(voucherCode('cash_receipt', 1)).toBe('PT00001');
    expect(voucherCode('cash_payment', 12)).toBe('PC00012');
    expect(voucherCode('bank_credit', 123)).toBe('BC00123');
    expect(voucherCode('bank_debit', 99999)).toBe('BN99999');
  });

  it('keeps every digit past five', () => {
    expect(voucherCode('cash_payment', 123456)).toBe('PC123456');
  });
});

describe('voucher types', () => {
  it('maps each type to its money direction, cash root and usual counter account', () => {
    expect(VOUCHER_TYPES.map((t) => [t, isInflow(t), cashRootOf(t), defaultCounterAccount(t)])).toEqual([
      ['cash_receipt', true, '111', '131'],
      ['cash_payment', false, '111', '331'],
      ['bank_credit', true, '112', '131'],
      ['bank_debit', false, '112', '331'],
    ]);
  });

  it('asks for a party on 131 and 331 and their sub-accounts only', () => {
    expect(['131', '1311', '131.HN', '331', '3311', '331.NCC'].every(needsParty)).toBe(true);
    expect(['1331', '3331', '141', '6422', '511', '1388'].some(needsParty)).toBe(false);
  });
});

describe('voucher amounts', () => {
  it('takes whole VND above zero only', () => {
    for (const ok of ['1', '1500000', '000100', '999999999999999']) expect(zVoucherAmount.safeParse(ok).success, ok).toBe(true);
    for (const bad of ['0', '000', '-5', '1.5', '1,000', '1e6', '', ' 1', '1000000000000000']) expect(zVoucherAmount.safeParse(bad).success, bad).toBe(false);
  });

  it('refuses a request without lines or with more than 20', () => {
    const base = { type: 'cash_payment', date: '2026-10-19', cashAccount: '1111', description: 'Trả tiền hàng' };
    expect(zCashVoucherRequest.safeParse({ ...base, lines: [] }).success).toBe(false);
    const line = { account: '331', amount: '1000' };
    expect(zCashVoucherRequest.safeParse({ ...base, lines: Array.from({ length: 20 }, () => line) }).success).toBe(true);
    expect(zCashVoucherRequest.safeParse({ ...base, lines: Array.from({ length: 21 }, () => line) }).success).toBe(false);
  });

  it('adds the lines with decimal arithmetic', () => {
    expect(voucherTotal([{ amount: '999999999999990' }, { amount: '9' }])).toBe('999999999999999');
    expect(voucherTotal([{ amount: '1500000' }, { amount: '250000' }])).toBe('1750000');
  });
});

describe('voucher problems', () => {
  it('accepts a payment from cash to a vendor and a bank credit from a customer', () => {
    expect(voucherProblems(voucher('cash_payment', '1111', [{ account: '331', amount: '5500000' }]))).toEqual([]);
    expect(voucherProblems(voucher('bank_credit', '1121.VCB', [{ account: '131', amount: '11000000' }]))).toEqual([]);
    expect(voucherProblems(voucher('cash_receipt', '111', [{ account: '1121', amount: '2000000' }], null))).toEqual([]);
  });

  it('refuses a cash account of the other kind', () => {
    expect(voucherProblems(voucher('cash_payment', '1121', [{ account: '331', amount: '1' }]))).toEqual(['CASH_ACCOUNT_TYPE']);
    expect(voucherProblems(voucher('bank_debit', '1111', [{ account: '331', amount: '1' }]))).toEqual(['CASH_ACCOUNT_TYPE']);
    expect(voucherProblems(voucher('bank_credit', '131', [{ account: '511', amount: '1' }]))).toEqual(['CASH_ACCOUNT_TYPE']);
  });

  it('refuses a line on the voucher\'s own cash account', () => {
    expect(voucherProblems(voucher('cash_receipt', '1111', [{ account: '1111', amount: '1' }]))).toEqual(['LINE_IS_CASH_ACCOUNT']);
  });

  it('asks for a party when a line settles 131 or 331', () => {
    expect(voucherProblems(voucher('bank_debit', '1121', [{ account: '6422', amount: '22000' }, { account: '331', amount: '1' }], null))).toEqual(['PARTY_REQUIRED']);
    expect(voucherProblems(voucher('bank_debit', '1121', [{ account: '6422', amount: '22000' }], null))).toEqual([]);
  });

  it('refuses a total that does not fit', () => {
    expect(voucherProblems(voucher('cash_receipt', '1111', [{ account: '131', amount: '999999999999999' }, { account: '131', amount: '1' }]))).toEqual(['TOTAL_TOO_LARGE']);
  });
});

describe('voucher journal', () => {
  const lines = (journal: ReturnType<typeof buildVoucherJournal>) => journal.map((j) => [j.lineNo, j.accountCode, j.debit, j.credit, j.memo]);

  it('posts a cash receipt as Dr 111x, Cr the lines', () => {
    const journal = buildVoucherJournal({ type: 'cash_receipt', cashAccount: '1111', description: 'Thu tiền hàng', lines: [{ account: '131', amount: '11000000' }] });
    expect(lines(journal)).toEqual([
      [1, '1111', '11000000', '0', 'Thu tiền hàng'],
      [2, '131', '0', '11000000', 'Thu tiền hàng'],
    ]);
    expect(journalIsBalanced(journal)).toBe(true);
  });

  it('posts a cash payment as Dr the lines, Cr 111x', () => {
    const journal = buildVoucherJournal({
      type: 'cash_payment',
      cashAccount: '1111',
      description: 'Trả tiền hàng',
      lines: [
        { account: '331', amount: '5000000', memo: 'HĐ 0000123' },
        { account: '331', amount: '500000', memo: 'HĐ 0000124' },
      ],
    });
    expect(lines(journal)).toEqual([
      [1, '331', '5000000', '0', 'HĐ 0000123'],
      [2, '331', '500000', '0', 'HĐ 0000124'],
      [3, '1111', '0', '5500000', 'Trả tiền hàng'],
    ]);
    expect(journalIsBalanced(journal)).toBe(true);
  });

  it('posts a bank credit as Dr 112x and a bank debit as Cr 112x, a fee on its own line', () => {
    const credit = buildVoucherJournal({ type: 'bank_credit', cashAccount: '1121.VCB', description: 'Khách trả tiền', lines: [{ account: '131', amount: '20000000' }] });
    expect(lines(credit)[0]).toEqual([1, '1121.VCB', '20000000', '0', 'Khách trả tiền']);
    const debit = buildVoucherJournal({
      type: 'bank_debit',
      cashAccount: '1121',
      description: 'Chuyển khoản trả nhà cung cấp',
      lines: [
        { account: '331', amount: '30000000' },
        { account: '6422', amount: '11000', memo: 'Phí chuyển khoản' },
      ],
    });
    expect(lines(debit)).toEqual([
      [1, '331', '30000000', '0', 'Chuyển khoản trả nhà cung cấp'],
      [2, '6422', '11000', '0', 'Phí chuyển khoản'],
      [3, '1121', '0', '30011000', 'Chuyển khoản trả nhà cung cấp'],
    ]);
    expect(sum(debit.map((j) => money(j.debit))).toFixed()).toBe('30011000');
    expect(journalIsBalanced(debit)).toBe(true);
  });
});

describe('voucher texts', () => {
  it('describes the entry by code, reason and party', () => {
    expect(voucherEntryDescription('PC00012', { description: 'Trả tiền hàng', party: { name: 'Công ty ABC' } })).toBe('PC00012 Trả tiền hàng (Công ty ABC)');
    expect(voucherEntryDescription('BN00001', { description: 'Phí ngân hàng', party: null })).toBe('BN00001 Phí ngân hàng');
  });

  it('titles the proposal with the type and the amount grouped by dots', () => {
    expect(voucherTitle({ type: 'cash_payment', total: '1500000', description: 'Trả tiền hàng', party: { name: 'Công ty ABC' } })).toBe(
      'Phiếu chi 1.500.000 đ: Trả tiền hàng (Công ty ABC)',
    );
    expect(voucherTitle({ type: 'bank_credit', total: '950', description: 'Lãi tiền gửi', party: null })).toBe('Giấy báo Có 950 đ: Lãi tiền gửi');
  });
});
