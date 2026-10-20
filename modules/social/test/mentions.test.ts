// @mentions in post comments (#793): tokens in, names out, and the @query being typed.
import { describe, expect, it } from 'vitest';
import { MENTIONS_MAX, commentParts, mentionLabels, mentionQuery, mentionsForEditing, mentionsForStoring, mentionsOf } from '../src/domain/mentions.ts';

const LAN = '018f0000-0000-7000-8000-000000000001';
const ANH = '018f0000-0000-7000-8000-000000000002';

describe('comment mentions', () => {
  it('reads each mentioned member once, in order, up to the cap', () => {
    expect(mentionsOf(`<@${LAN}> và <@${ANH}>, nhắc lại <@${LAN}>`)).toEqual([LAN, ANH]);
    expect(mentionsOf('@Lan viết tay, <@not-an-id>')).toEqual([]);
    const many = Array.from({ length: 30 }, (_, i) => `<@018f0000-0000-7000-8000-${String(i).padStart(12, '0')}>`).join(' ');
    expect(mentionsOf(many)).toHaveLength(MENTIONS_MAX);
  });

  it('splits a comment into text and mentions for showing it', () => {
    expect(commentParts(`Chào <@${LAN}>!`)).toEqual([{ text: 'Chào ' }, { mention: LAN }, { text: '!' }]);
    expect(commentParts('Không nhắc ai')).toEqual([{ text: 'Không nhắc ai' }]);
  });

  it('turns tokens into names for the box and back, longer names first', () => {
    const names = new Map([
      [LAN, 'Lan'],
      [ANH, 'Lan Anh'],
    ]);
    const shown = mentionsForEditing(`<@${ANH}> và <@${LAN}> xem`, (id) => names.get(id) ?? null);
    expect(shown.text).toBe('@Lan Anh và @Lan xem');
    expect(mentionsForStoring(shown.text, shown.picked)).toBe(`<@${ANH}> và <@${LAN}> xem`);
    // A member who left keeps the token.
    expect(mentionsForEditing(`<@${LAN}>`, () => null).text).toBe(`<@${LAN}>`);
    // A name typed by hand, not picked, stays text.
    expect(mentionsForStoring('@Lan xem', [])).toBe('@Lan xem');
    // Only a whole @name: not a longer word, not inside an address.
    expect(mentionsForStoring('@Lanh và lan@Lan.vn, @Lan.', [['Lan', LAN]])).toBe(`@Lanh và lan@Lan.vn, <@${LAN}>.`);
  });

  it('tells two members with the same name apart by their email', () => {
    const labels = mentionLabels([
      { userId: LAN, name: 'Nam', email: 'nam1@shop.vn' },
      { userId: ANH, name: 'Nam', email: 'nam2@shop.vn' },
      { userId: 'x', name: 'Hà', email: 'ha@shop.vn' },
    ]);
    expect([...labels.values()]).toEqual(['Nam (nam1@shop.vn)', 'Nam (nam2@shop.vn)', 'Hà']);
    const stored = mentionsForStoring('@Nam (nam2@shop.vn) và @Nam (nam1@shop.vn)', [
      ['Nam (nam1@shop.vn)', LAN],
      ['Nam (nam2@shop.vn)', ANH],
    ]);
    expect(stored).toBe(`<@${ANH}> và <@${LAN}>`);
  });

  it('finds the @query at the caret only at the start of a word', () => {
    expect(mentionQuery('Chào @La', 8)).toEqual({ start: 5, query: 'La' });
    expect(mentionQuery('@', 1)).toEqual({ start: 0, query: '' });
    expect(mentionQuery('mail@shop.vn', 12)).toBeNull();
    expect(mentionQuery('@Lan\nxem', 8)).toBeNull();
    expect(mentionQuery('không có', 8)).toBeNull();
  });
});
