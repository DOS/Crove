import { describe, expect, it } from 'vitest';
import { comparableText } from '@crove/channel';
import { duplicateText, newestDuplicate, refusesDuplicates, styleSelection, styleText, type DuplicateCandidate } from '../src/contract.ts';

describe('duplicateText (#1156)', () => {
  it('drops links, t.co ones and bare hosts alike', () => {
    expect(duplicateText('Khai trương chi nhánh mới\n\nhttps://t.co/abc123 https://t.co/media1')).toBe('Khai trương chi nhánh mới');
    expect(duplicateText('Khai trương chi nhánh mới https://crove.vn/khai-truong')).toBe(duplicateText('Khai trương chi nhánh mới https://t.co/x1'));
    expect(duplicateText('Xem crove.vn/gia nhé')).toBe('Xem nhé');
    // Not a link: a host on a TLD X does not find without a scheme stays, as in comparableText.
    expect(duplicateText('TP.HCM hôm nay')).toBe('TP.HCM hôm nay');
  });

  it('decodes the entities X writes in one pass', () => {
    expect(duplicateText('Cà phê &amp; bánh &lt;mới&gt;')).toBe('Cà phê & bánh <mới>');
    expect(duplicateText('Cà phê & bánh')).toBe(duplicateText('Cà phê &amp; bánh'));
    expect(duplicateText('&amp;lt;')).toBe('&lt;');
  });

  it('collapses white space and composes letters', () => {
    expect(duplicateText('  Ưu   đãi\n\n\tcuối tuần  ')).toBe('Ưu đãi cuối tuần');
    expect(duplicateText('Việt'.normalize('NFD'))).toBe('Việt');
  });

  it('keeps every word, case and punctuation: one word changed is another text', () => {
    expect(duplicateText('Ưu đãi cuối tuần')).not.toBe(duplicateText('Ưu đãi cuối tháng'));
    expect(duplicateText('Ưu đãi!')).not.toBe(duplicateText('Ưu đãi.'));
    expect(duplicateText('Ưu đãi')).not.toBe(duplicateText('ưu đãi'));
  });

  it('compares styled letters (#1179) as their plain ones, links included', () => {
    expect(duplicateText(styleText('Ưu đãi cuối tuần', 'bold'))).toBe('Ưu đãi cuối tuần');
    expect(duplicateText(`${styleText('Khuyến mãi', 'italic')} ${styleText('crove.vn/gia', 'bold')}`)).toBe('Khuyến mãi');
    const half = styleSelection('Ưu đãi cuối tuần #sale', 0, 6, 'boldItalic').text;
    expect(duplicateText(half)).toBe(duplicateText('Ưu đãi cuối tuần #sale'));
    // Still case sensitive: a bold capital is a capital.
    expect(duplicateText(styleText('ƯU ĐÃI', 'bold'))).not.toBe(duplicateText('Ưu đãi'));
  });

  it('compares as the X adapter compares a post with what it sent', () => {
    for (const text of ['a &lt;b&gt; &amp; c https://t.co/x', 'Khai trương crove.vn/a\n\n  mới', 'Việt'.normalize('NFD'), '&amp;lt;', '', ' https://a.vn ']) {
      expect(duplicateText(text)).toBe(comparableText(text));
    }
  });
});

describe('newestDuplicate (#1156)', () => {
  const at = (iso: string) => new Date(iso);
  const candidates: DuplicateCandidate[] = [
    { text: 'Ưu đãi cuối tuần https://t.co/a', at: at('2026-10-10T02:00:00Z'), status: 'published' },
    { text: 'Ưu đãi cuối tuần', at: at('2026-10-20T02:00:00Z'), status: 'published' },
    { text: 'Ưu   đãi cuối tuần', at: at('2026-10-30T02:00:00Z'), status: 'queued' },
    { text: 'Khác hẳn', at: at('2026-11-30T02:00:00Z'), status: 'scheduled' },
  ];

  it('names the newest match, scheduled ahead of published', () => {
    expect(newestDuplicate('Ưu đãi cuối tuần https://crove.vn/uu-dai', candidates)).toEqual({ at: '2026-10-30T02:00:00.000Z', status: 'queued' });
    expect(newestDuplicate('Ưu đãi cuối tuần', candidates.slice(0, 2))).toEqual({ at: '2026-10-20T02:00:00.000Z', status: 'published' });
  });

  it('catches the same text sent again in bold (#1179)', () => {
    expect(newestDuplicate(styleText('Ưu đãi cuối tuần', 'bold'), candidates.slice(0, 2))).toEqual({ at: '2026-10-20T02:00:00.000Z', status: 'published' });
    expect(newestDuplicate('Ưu đãi cuối tuần', [{ text: styleText('Ưu đãi cuối tuần', 'italic'), at: at('2026-10-10T02:00:00Z'), status: 'published' }])).not.toBeNull();
  });

  it('finds nothing for another text, or a text of links alone', () => {
    expect(newestDuplicate('Ưu đãi cuối tháng', candidates)).toBeNull();
    expect(newestDuplicate('https://t.co/a', [{ text: 'https://t.co/b', at: at('2026-10-10T02:00:00Z'), status: 'published' }])).toBeNull();
    expect(newestDuplicate('', [{ text: '', at: null, status: 'scheduled' }])).toBeNull();
  });

  it('refuses outright only on X and LinkedIn', () => {
    expect(['x', 'linkedin', 'linkedin_page'].every(refusesDuplicates)).toBe(true);
    expect(['facebook_page', 'threads', 'bluesky', 'mastodon', 'telegram'].some(refusesDuplicates)).toBe(false);
  });
});
