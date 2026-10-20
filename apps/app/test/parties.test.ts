import { describe, expect, it } from 'vitest';
import { nextCustomerCursor, partyChanges, partySearch, searchParam } from '../src/lib/parties.ts';

const ID = '0190a000-0000-7000-8000-0000000000a1';
const customer = (name: string, id = ID) => ({ id, name, taxCode: null, address: null, email: null, invoiceCount: 0, lastInvoiceDate: null, receivable: '0' });

describe('nextCustomerCursor', () => {
  it('starts after the last customer when more follow, and stops otherwise', () => {
    expect(nextCustomerCursor({ items: [customer('An'), customer('Bình', ID.replace('a1', 'a2'))], more: true })).toEqual({ name: 'Bình', id: ID.replace('a1', 'a2') });
    expect(nextCustomerCursor({ items: [customer('An')], more: false })).toBeUndefined();
    expect(nextCustomerCursor({ items: [], more: true })).toBeUndefined();
  });
});

describe('partySearch', () => {
  it('finds a party by its normalized tax code, else by its name', () => {
    expect(partySearch({ taxCode: ' 0309.876.546 ', name: 'Công ty A' })).toBe('0309876546');
    expect(partySearch({ taxCode: '0309876546001', name: 'Chi nhánh' })).toBe('0309876546-001');
    expect(partySearch({ taxCode: 'không rõ', name: '  Khách lẻ  ' })).toBe('Khách lẻ');
    expect(partySearch({ taxCode: null, name: null })).toBe('');
    expect(partySearch({ taxCode: null, name: 'x'.repeat(150) })).toHaveLength(100);
  });
});

describe('searchParam', () => {
  it('takes a search of at most 100 characters, and a tax code the router read as a number', () => {
    expect(searchParam(' Công ty ')).toBe('Công ty');
    expect(searchParam(309876546)).toBe('309876546');
    expect(searchParam('')).toBeUndefined();
    expect(searchParam('x'.repeat(101))).toBeUndefined();
    expect(searchParam(-1)).toBeUndefined();
    expect(searchParam({ q: 'x' })).toBeUndefined();
  });
});

describe('partyChanges', () => {
  const current = { name: 'Công ty A', taxCode: '0309876546', email: null };

  it('sends only what changed, and nothing when nothing did', () => {
    expect(partyChanges(ID, current, { name: ' Công ty A ', taxCode: '0309876546', email: '' })).toBeNull();
    // The same tax code written another way is no change.
    expect(partyChanges(ID, current, { name: 'Công ty A', taxCode: '0309.876.546', email: '' })).toBeNull();
    expect(partyChanges(ID, current, { name: 'Công ty TNHH A', taxCode: '0309876546', email: ' ketoan@a.vn ' })).toEqual({
      partyId: ID,
      name: 'Công ty TNHH A',
      email: 'ketoan@a.vn',
    });
  });

  it('clears the tax code or the email when the field is emptied, and never sends an empty name', () => {
    expect(partyChanges(ID, { ...current, email: 'a@a.vn' }, { name: '', taxCode: ' ', email: '' })).toEqual({ partyId: ID, taxCode: null, email: null });
    expect(partyChanges(ID, current, { name: 'Công ty A', taxCode: '0101234564', email: '' })).toEqual({ partyId: ID, taxCode: '0101234564' });
  });
});
