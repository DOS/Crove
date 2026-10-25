// The voucher form and the Inbox card (#327): amounts as typed, the form's checks in both locales, the cash accounts
// offered per type and the entry the approval posts.
import { describe, expect, it } from 'vitest';
import { translatorFor } from '../src/i18n/runtime.ts';
import type { ChartAccount } from '../src/lib/accounts.ts';
import {
  canEnterVoucher,
  cashAccountChoices,
  isVoucherAmount,
  nextVoucherCursor,
  normalizeAmount,
  previewVoucherJournal,
  VOUCHER_PROBLEMS,
  voucherFormError,
  voucherProblem,
  voucherTotal,
  type VoucherForm,
} from '../src/lib/vouchers.ts';

const vi = translatorFor('vi');
const en = translatorFor('en');
const account = (code: string, active = true): ChartAccount => ({ code, name: code, parentCode: null, rootCode: code.slice(0, 3), active, custom: false });
const form = (patch: Partial<VoucherForm> = {}): VoucherForm => ({
  type: 'cash_payment',
  date: '2026-10-19',
  cashAccount: '1111',
  partyId: '0192f0c0-0000-7000-8000-000000000001',
  description: 'Trả tiền hàng',
  lines: [{ account: '331', amount: '1.500.000' }],
  ...patch,
});

describe('canEnterVoucher', () => {
  it('lets owners, admins and members enter a voucher, never viewers', () => {
    expect(['owner', 'admin', 'member'].map(canEnterVoucher)).toEqual([true, true, true]);
    expect(canEnterVoucher('viewer')).toBe(false);
    expect(canEnterVoucher(undefined)).toBe(false);
  });
});

describe('amounts as typed', () => {
  it('reads Vietnamese and English grouping as whole VND', () => {
    expect(normalizeAmount('1.500.000')).toBe('1500000');
    expect(normalizeAmount(' 1 500 000 ')).toBe('1500000');
    expect(normalizeAmount('1,500,000')).toBe('1500000');
    expect(normalizeAmount('0012')).toBe('12');
  });

  it('keeps anything else as typed, so the form refuses it', () => {
    for (const bad of ['-5', '1,5đ', 'abc', '1e6']) expect(isVoucherAmount(normalizeAmount(bad)), bad).toBe(false);
    // A decimal part or a misplaced separator is not read as a bigger whole amount (#1391 review).
    for (const bad of ['12.34', '1,5', '1.50.000', '1.500,000', '15.00']) expect(normalizeAmount(bad), bad).toBe(bad);
    expect(isVoucherAmount('0')).toBe(false);
    expect(isVoucherAmount('1500000')).toBe(true);
  });

  it('adds the lines exactly, past the safe range of JS numbers', () => {
    expect(voucherTotal([{ amount: '999.999.999.999.999' }, { amount: '1' }])).toBe('1000000000000000');
    expect(voucherTotal([{ amount: '1.000' }, { amount: 'x' }])).toBe('1000');
  });
});

describe('cashAccountChoices', () => {
  it('offers 111 accounts in use for cash vouchers and 112 accounts for bank vouchers', () => {
    const chart = [account('111'), account('1111'), account('1111.HCM', false), account('112'), account('1121'), account('1121.VCB'), account('131')];
    expect(cashAccountChoices(chart, 'cash_receipt').map((a) => a.code)).toEqual(['111', '1111']);
    expect(cashAccountChoices(chart, 'bank_debit').map((a) => a.code)).toEqual(['112', '1121', '1121.VCB']);
  });
});

describe('voucherFormError', () => {
  it('accepts a complete voucher', () => {
    expect(voucherFormError(form(), vi)).toBeNull();
  });

  it('names the first problem in Vietnamese and English', () => {
    expect(voucherFormError(form({ date: '2026-02-30' }), vi)).toBe('Hãy chọn ngày chứng từ');
    expect(voucherFormError(form({ cashAccount: '1121' }), vi)).toBe('Hãy chọn tài khoản 111 hoặc tài khoản con của 111');
    expect(voucherFormError(form({ description: '  ' }), en)).toBe('Enter the reason');
    expect(voucherFormError(form({ lines: [] }), vi)).toBe('Chứng từ cần từ 1 đến 20 dòng hạch toán');
    expect(voucherFormError(form({ lines: [{ account: '1111', amount: '1' }] }), vi)).toBe('Dòng 1: tài khoản đối ứng không được trùng tài khoản tiền');
    expect(voucherFormError(form({ lines: [{ account: '331', amount: '1' }, { account: '6422', amount: '0' }] }), en)).toBe(
      'Line 2: the amount must be a whole number of VND above 0',
    );
    expect(voucherFormError(form({ partyId: '' }), vi)).toBe('Dòng hạch toán vào 131 hoặc 331 cần chọn đối tượng');
    expect(voucherFormError(form({ partyId: '', lines: [{ account: '6422', amount: '22.000' }] }), vi)).toBeNull();
  });
});

describe('previewVoucherJournal', () => {
  it('debits the cash account for money in and credits it for money out', () => {
    expect(previewVoucherJournal({ type: 'bank_credit', cashAccount: '1121', lines: [{ account: '131', amount: '2.000.000' }] })).toEqual([
      { accountCode: '1121', debit: '2000000', credit: '0' },
      { accountCode: '131', debit: '0', credit: '2000000' },
    ]);
    expect(
      previewVoucherJournal({
        type: 'cash_payment',
        cashAccount: '1111',
        lines: [
          { account: '331', amount: '1000000' },
          { account: '6422', amount: '50000', memo: 'Phí' },
        ],
      }),
    ).toEqual([
      { accountCode: '331', debit: '1000000', credit: '0' },
      { accountCode: '6422', debit: '50000', credit: '0', memo: 'Phí' },
      { accountCode: '1111', debit: '0', credit: '1050000' },
    ]);
  });
});

describe('voucherProblem', () => {
  it('reads the problem of a VOUCHER_INVALID refusal, and nothing else', () => {
    expect(voucherProblem({ code: 'VOUCHER_INVALID', data: { problems: ['PARTY_REQUIRED'] } })).toBe('PARTY_REQUIRED');
    expect(voucherProblem({ code: 'ACCOUNT_INACTIVE', data: { problems: ['PARTY_REQUIRED'] } })).toBeNull();
    expect(voucherProblem(null)).toBeNull();
    expect(voucherProblem({ code: 'VOUCHER_INVALID', data: { problems: ['SOMETHING_NEW'] } })).toBeNull();
  });

  it('has words for every problem the kernel names, in both locales', () => {
    for (const problem of VOUCHER_PROBLEMS) {
      expect(vi(`vouchers.problems.${problem}`)).not.toContain('vouchers.');
      expect(en(`vouchers.problems.${problem}`)).not.toContain('vouchers.');
    }
  });
});

describe('nextVoucherCursor (#509)', () => {
  const voucher = (id: string, date: string) => ({
    id,
    type: 'cash_payment' as const,
    number: 1,
    code: 'PC00001',
    date,
    cashAccount: '1111',
    party: null,
    personName: null,
    description: 'x',
    amount: '1',
    journalEntryId: null,
    reversal: null,
    proposalId: null,
  });
  const a = '018f0000-0000-7000-8000-000000000001';
  const b = '018f0000-0000-7000-8000-000000000002';

  it('starts the next page after the last voucher shown, while older ones follow', () => {
    expect(nextVoucherCursor({ items: [voucher(b, '2026-09-20'), voucher(a, '2026-09-01')], more: true })).toEqual({ date: '2026-09-01', id: a });
  });

  it('asks for no next page on the last page or an empty one', () => {
    expect(nextVoucherCursor({ items: [voucher(a, '2026-09-01')], more: false })).toBeUndefined();
    expect(nextVoucherCursor({ items: [], more: true })).toBeUndefined();
  });
});
