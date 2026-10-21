import { describe, expect, it } from 'vitest';
import { nextCustomerCursor, partySearch } from '../src/lib/parties.ts';

const ID = '0190a000-0000-7000-8000-0000000000a1';
const customer = (name: string, id = ID) => ({
  id,
  name,
  taxCode: null,
  address: null,
  email: null,
  phone: null,
  version: 1,
  duplicates: [],
  invoiceCount: 0,
  lastInvoiceDate: null,
  receivable: '0',
});

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
