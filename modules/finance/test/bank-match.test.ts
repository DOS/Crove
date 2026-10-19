// Who a bank statement line paid or was paid by (#326, stage 2a): the reasons in order (tax code, invoice number with
// the amount, name without its legal form, open balance), a tie leaving the choice to the user, and the text helpers.
import { describe, expect, it } from 'vitest';
import { matchLine, nameKey, numbersIn, taxCodesIn, type MatchBalance, type MatchInvoice, type MatchParty } from '../src/index.ts';

const P1 = '00000000-0000-7000-8000-000000000001';
const P2 = '00000000-0000-7000-8000-000000000002';
const P3 = '00000000-0000-7000-8000-000000000003';

const parties: MatchParty[] = [
  { id: P1, name: 'Công ty TNHH Thương mại Hòa Bình', taxCode: '0101234564' },
  { id: P2, name: 'CÔNG TY CỔ PHẦN AN PHÚ', taxCode: '0309876546' },
  { id: P3, name: 'Công ty TNHH Thành Công', taxCode: null },
];

const line = (description: string, amount = '1500000') => ({ description, amount });

describe('matchLine', () => {
  it('takes the tax code written in the description first', () => {
    const match = matchLine(line('CK MST 0309876546 THUONG MAI HOA BINH'), parties, [], []);
    expect(match.suggested).toEqual({ partyId: P2, reason: 'tax_code' });
    // The name is a weaker reason: listed, not chosen.
    expect(match.candidates).toEqual([
      { partyId: P2, reason: 'tax_code' },
      { partyId: P1, reason: 'name' },
    ]);
  });

  it('reads a branch tax code and ignores digits that only contain a tax code', () => {
    expect(taxCodesIn('MST 0101234564-001; ref 20101234564 and 0309876546')).toEqual(['0101234564-001', '0309876546']);
    // A dash and other than three digits make a reference, not a tax code.
    expect(taxCodesIn('ma GD 0101234564-12, 0309876546-1234')).toEqual([]);
    const branch: MatchParty[] = [{ id: P1, name: 'Chi nhánh Hòa Bình', taxCode: '0101234564-001' }];
    expect(matchLine(line('TT MST 0101234564 - 001'), branch, [], []).suggested).toEqual({ partyId: P1, reason: 'tax_code' });
    expect(matchLine(line('ref 20101234564'), parties, [], []).suggested).toBeNull();
  });

  it('finds an invoice of the amount by its number, with or without leading zeros', () => {
    const invoices: MatchInvoice[] = [
      { partyId: P3, series: 'C26TAA', number: '00000123', total: '1500000' },
      { partyId: P2, series: 'C26TBB', number: '124', total: '1500000' },
    ];
    expect(numbersIn('TT HD so 0000123, HĐ124')).toEqual(new Set(['123', '124']));
    const match = matchLine(line('THANH TOAN HD 123'), parties, invoices, []);
    expect(match.suggested).toEqual({ partyId: P3, reason: 'invoice', invoice: { series: 'C26TAA', number: '00000123' } });
    // The number alone is not enough: the invoice must be for the line's amount.
    expect(matchLine(line('THANH TOAN HD 123', '1400000'), parties, invoices, []).suggested).toBeNull();
  });

  it('finds a name without its legal form, written apart or run together, and never a name of legal words only', () => {
    expect(nameKey('Công ty TNHH Thương mại Hòa Bình')).toEqual(['thuong', 'mai', 'hoa', 'binh']);
    expect(nameKey('CÔNG TY CỔ PHẦN AN PHÚ')).toEqual(['an', 'phu']);
    expect(nameKey('Công ty TNHH Thành Công')).toEqual(['thanh', 'cong']);
    expect(nameKey('Công ty TNHH')).toBeNull();
    expect(nameKey('ABC Trading Co., Ltd')).toEqual(['abc', 'trading']);
    expect(matchLine(line('CONG TY TNHH THUONG MAI HOA BINH CHUYEN TIEN'), parties, [], []).suggested).toEqual({ partyId: P1, reason: 'name' });
    expect(matchLine(line('THUONGMAIHOABINH chuyen khoan'), parties, [], []).suggested).toEqual({ partyId: P1, reason: 'name' });
    // "AN PHU" needs to stand as words: run together it is too short to count.
    expect(matchLine(line('ANPHU TT'), parties, [], []).suggested).toBeNull();
    expect(matchLine(line('KHACH HANG AN PHU TT'), parties, [], []).suggested).toEqual({ partyId: P2, reason: 'name' });
    // A word of another name does not count: "THANH" alone is not "Thành Công".
    expect(matchLine(line('NGUYEN VAN THANH chuyen tien'), parties, [], []).suggested).toBeNull();
  });

  it('falls back to a party whose open balance equals the amount', () => {
    const balances: MatchBalance[] = [
      { partyId: P1, balance: '1500000.00' },
      { partyId: P2, balance: '900000' },
    ];
    expect(matchLine(line('CK den tu TK 1234567890'), parties, [], balances).suggested).toEqual({ partyId: P1, reason: 'balance' });
    // The sign of the line does not matter: the module passes the balances of the line's side.
    expect(matchLine(line('CK', '-1500000'), parties, [], balances).suggested).toEqual({ partyId: P1, reason: 'balance' });
  });

  it('chooses nobody when two parties share the strongest reason, and lists them', () => {
    const balances: MatchBalance[] = [
      { partyId: P1, balance: '1500000' },
      { partyId: P2, balance: '1500000' },
    ];
    const match = matchLine(line('CK'), parties, [], balances);
    expect(match.suggested).toBeNull();
    expect(match.candidates.map((c) => c.partyId)).toEqual([P1, P2]);
    // A stronger reason for one of them decides.
    expect(matchLine(line('CK THUONG MAI HOA BINH'), parties, [], balances).suggested).toEqual({ partyId: P1, reason: 'name' });
  });

  it('lists each party once, under its strongest reason, and ignores parties it was not given', () => {
    const invoices: MatchInvoice[] = [{ partyId: '00000000-0000-7000-8000-000000000009', series: 'X', number: '7', total: '1500000' }];
    const match = matchLine(line('MST 0101234564 HOA BINH HD 7'), parties, invoices, [{ partyId: P1, balance: '1500000' }]);
    expect(match.candidates).toEqual([{ partyId: P1, reason: 'tax_code' }]);
  });
});
