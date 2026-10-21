// The search params of the screens the command palette's search results open (#673), and the documents filter.
import { describe, expect, it } from 'vitest';
import { documentNumber, matchesDocument, parseJournalSearch, parseTextSearch } from '../src/lib/search.ts';

describe('parseTextSearch', () => {
  it('keeps a text filter, trimmed, and a tax code the router read as a number', () => {
    expect(parseTextSearch({ q: ' Điện lực ' })).toEqual({ q: 'Điện lực' });
    expect(parseTextSearch({ q: 309876546 })).toEqual({ q: '309876546' });
    expect(parseTextSearch({ q: '0101234564' })).toEqual({ q: '0101234564' });
    expect(parseTextSearch({ q: 'x'.repeat(150) }).q).toHaveLength(100);
  });

  it('drops anything else', () => {
    expect(parseTextSearch({})).toEqual({});
    expect(parseTextSearch({ q: '  ' })).toEqual({});
    expect(parseTextSearch({ q: 1.5 })).toEqual({});
    expect(parseTextSearch({ q: ['a'] })).toEqual({});
  });
});

describe('parseJournalSearch', () => {
  it('keeps calendar-shaped dates only', () => {
    expect(parseJournalSearch({ from: '2026-09-15', to: '2026-09-15' })).toEqual({ from: '2026-09-15', to: '2026-09-15' });
    expect(parseJournalSearch({ from: '15/09/2026', to: 20260915 })).toEqual({});
  });
});

describe('matchesDocument', () => {
  const doc = { series: '1C26TAA', number: '00000123', partyName: 'Công ty Điện lực Hà Nội', issueDate: '2026-09-15' };

  it('matches the number with or without leading zeros, the series, the party without marks and the date', () => {
    for (const q of ['00000123', '123', '1c26taa-00000123', 'dien luc', 'ĐIỆN 123', '2026-09']) expect(matchesDocument(doc, q), q).toBe(true);
    for (const q of ['456', 'phuong nam', 'dien 456']) expect(matchesDocument(doc, q), q).toBe(false);
  });

  it('writes series-number, or the number alone', () => {
    expect(documentNumber(doc)).toBe('1C26TAA-00000123');
    expect(documentNumber({ series: '', number: '12' })).toBe('12');
  });
});
