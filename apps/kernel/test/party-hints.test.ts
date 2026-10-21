// Duplicate hints for parties (#887): which pairs look like one party, why, and which of the two to keep.
import { describe, expect, it } from 'vitest';
import { duplicateHints, nameCore, nameSimilarity, phoneKey, type HintParty } from '@crove/kernel';

let next = 0;
const party = (name: string, folded: string, extra: Partial<HintParty> = {}): HintParty => {
  next += 1;
  return { id: `00000000-0000-4000-8000-${String(next).padStart(12, '0')}`, name, folded, taxCode: null, phone: null, createdAt: `2026-10-0${next % 9}T00:00:00.000Z`, ...extra };
};

describe('duplicate hints', () => {
  it('compares names without their legal form, and skips names with too little left', () => {
    expect(nameCore('cong ty tnhh dich vu mau')).toBe('dich vu mau');
    expect(nameCore('cong ty co phan mot thanh vien abc')).toBe('abc');
    expect(nameCore('cong ty tnhh')).toBeNull();
    expect(nameCore('cong ty ab')).toBeNull();
    expect(nameSimilarity('dich vu mau', 'dich vu mau')).toBe(1);
    expect(nameSimilarity('dien luc ha noi', 'dien luc ha nam')).toBeGreaterThan(0.6);
    expect(nameSimilarity('dien luc ha noi', 'nuoc sach song da')).toBeLessThan(0.2);
  });

  it('keys a phone by its last 9 digits, whatever the prefix and separators', () => {
    expect(phoneKey('+84 24 3826 0000')).toBe('438260000');
    expect(phoneKey('024.3826.0000')).toBe(phoneKey('+84 24 3826 0000'));
    expect(phoneKey('12345')).toBeNull();
    expect(phoneKey(null)).toBeNull();
  });

  it('pairs names alike, one enterprise and its branch, and the same phone, keeping the one with a tax code', () => {
    const coded = party('CÔNG TY TNHH DỊCH VỤ MẪU', 'cong ty tnhh dich vu mau', { taxCode: '0101234564' });
    const named = party('Cty TNHH Dịch vụ Mẫu', 'cty tnhh dich vu mau');
    const branch = party('Chi nhánh Hà Nội', 'chi nhanh ha noi', { taxCode: '0101234564-001' });
    const phoneA = party('Anh Minh', 'anh minh', { phone: '0912 345 678' });
    const phoneB = party('Cửa hàng Minh Anh', 'cua hang minh anh', { phone: '+84912345678' });
    const other = party('Nước sạch Sông Đà', 'nuoc sach song da');
    const hints = duplicateHints([named, coded, branch, phoneA, phoneB, other]);
    expect(hints.map((h) => [h.keep.name, h.duplicate.name, h.reasons])).toEqual([
      ['CÔNG TY TNHH DỊCH VỤ MẪU', 'Chi nhánh Hà Nội', ['tax_code']],
      ['Anh Minh', 'Cửa hàng Minh Anh', ['phone']],
      ['CÔNG TY TNHH DỊCH VỤ MẪU', 'Cty TNHH Dịch vụ Mẫu', ['name']],
    ]);
  });

  it('never pairs two enterprises with different tax codes, however alike their names', () => {
    const a = party('Công ty TNHH Mẫu Một', 'cong ty tnhh mau mot', { taxCode: '0101234564' });
    const b = party('Công ty TNHH Mẫu Một', 'cong ty tnhh mau mot', { taxCode: '0309876546' });
    expect(duplicateHints([a, b])).toEqual([]);
  });

  it('keeps the older of two parties without a tax code', () => {
    const older = party('Mẫu A', 'mau a', { createdAt: '2026-01-01T00:00:00.000Z' });
    const newer = party('Mau A', 'mau a', { createdAt: '2026-02-01T00:00:00.000Z' });
    expect(duplicateHints([newer, older])).toEqual([{ keep: { id: older.id, name: 'Mẫu A', taxCode: null }, duplicate: { id: newer.id, name: 'Mau A', taxCode: null }, reasons: ['name'] }]);
  });
});
