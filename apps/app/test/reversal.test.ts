// What the journal screen offers for a reversal and how it explains refusals (#165), in both locales.
import { describe, expect, it } from 'vitest';
import { translatorFor } from '../src/i18n/runtime.ts';
import { formatDate } from '../src/lib/format.ts';
import { canAskReversal, defaultReversalDate, localToday, reversalErrorMessage, reversalFormError } from '../src/lib/reversal.ts';

const vi = translatorFor('vi');
const en = translatorFor('en');
const viDate = (value: string) => formatDate(value, 'vi');
const plain = { reverses: null, reversedBy: null };
const ref = { id: '0f6c3a52-8d3b-4c1e-9a77-5b2f0e9d1c00' };
const formError = (entryDate: string, reason: string, originalDate: string) => reversalFormError({ entryDate, reason }, originalDate, vi, viDate);

describe('canAskReversal', () => {
  it('offers a reversal to owners, admins and members on an entry that is neither a reversal nor reversed', () => {
    for (const role of ['owner', 'admin', 'member']) expect(canAskReversal(plain, role)).toBe(true);
  });

  it('never offers it to viewers, without a role, on a reversal or on an entry already reversed', () => {
    expect(canAskReversal(plain, 'viewer')).toBe(false);
    expect(canAskReversal(plain, undefined)).toBe(false);
    expect(canAskReversal({ reverses: ref, reversedBy: null }, 'owner')).toBe(false);
    expect(canAskReversal({ reverses: null, reversedBy: ref }, 'owner')).toBe(false);
  });

  it('does not offer it again while a reversal of the entry waits for approval (#204)', () => {
    expect(canAskReversal({ ...plain, pendingReversalId: ref.id }, 'owner')).toBe(false);
    expect(canAskReversal({ ...plain, pendingReversalId: null }, 'owner')).toBe(true);
  });
});

describe('reversal dates', () => {
  it("formats today in the user's time zone", () => {
    expect(localToday(new Date(2026, 9, 5, 23, 59))).toBe('2026-10-05');
  });

  it('defaults to today, or to the original date when that is later', () => {
    expect(defaultReversalDate('2026-10-01', '2026-10-16')).toBe('2026-10-16');
    expect(defaultReversalDate('2026-10-20', '2026-10-16')).toBe('2026-10-20');
  });
});

describe('reversalFormError', () => {
  it('accepts a date on or after the original and a reason', () => {
    expect(formError('2026-10-01', 'Ghi nhầm tài khoản', '2026-10-01')).toBeNull();
    expect(formError('2026-10-16', 'x', '2026-10-01')).toBeNull();
  });

  it('requires a real date that is not before the original', () => {
    expect(formError('', 'x', '2026-10-01')).toBe('Hãy chọn ngày ghi bút toán đảo');
    expect(formError('2026-02-30', 'x', '2026-01-01')).toBe('Hãy chọn ngày ghi bút toán đảo');
    expect(formError('2026-09-30', 'x', '2026-10-01')).toBe(`Ngày bút toán đảo không được trước ngày của bút toán gốc (${viDate('2026-10-01')})`);
  });

  it('requires a reason of at most 500 characters', () => {
    expect(formError('2026-10-01', '   ', '2026-10-01')).toBe('Hãy nhập lý do đảo bút toán');
    expect(formError('2026-10-01', 'a'.repeat(501), '2026-10-01')).toBe('Lý do tối đa 500 ký tự');
    expect(formError('2026-10-01', ` ${'a'.repeat(500)} `, '2026-10-01')).toBeNull();
  });

  it('speaks English too', () => {
    expect(reversalFormError({ entryDate: '2026-10-01', reason: '' }, '2026-10-01', en, viDate)).toBe('Enter the reason for the reversal');
  });
});

describe('reversalErrorMessage', () => {
  const partial = { code: 'INVALID', status: 422, message: 'Dữ liệu không hợp lệ', data: { reason: 'partial_mirror' } };

  it('explains the partial mirror refusal from its code and reason, in the user language', () => {
    expect(reversalErrorMessage(partial, vi, 'vi')).toContain('không được xem tất cả các dòng');
    expect(reversalErrorMessage(partial, en, 'en')).toContain('cannot see all of its lines');
  });

  it("shows the server's message for other refusals, and a fallback without one", () => {
    expect(reversalErrorMessage({ code: 'ALREADY_REVERSED', message: 'Bút toán này đã được đảo' }, vi, 'vi')).toBe('Bút toán này đã được đảo');
    expect(reversalErrorMessage({ code: 'INVALID', message: 'Dữ liệu không hợp lệ' }, vi, 'vi')).toBe('Dữ liệu không hợp lệ');
    expect(reversalErrorMessage(null, vi, 'vi')).toBe('Đã có lỗi xảy ra');
  });

  it('words known kernel codes in English instead of the Vietnamese message', () => {
    expect(reversalErrorMessage({ code: 'ALREADY_REVERSED', message: 'Bút toán này đã được đảo' }, en, 'en')).toBe('This journal entry was already reversed.');
  });
});
