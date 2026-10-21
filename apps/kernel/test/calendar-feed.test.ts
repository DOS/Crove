// The posting calendar feed's iCalendar file (#862), unit part: escaping, folding at 75 octets with Vietnamese text,
// and the calendar's structure. The database and HTTP part is in social-calendar-feed.db.test.ts.
import { describe, expect, it } from 'vitest';
import { escapeText, foldLine, icsTime, renderIcs, type CalendarFeed } from '../src/calendar-feed.ts';

const unfold = (text: string) => text.replace(/\r\n /g, '');
const octets = (line: string) => Buffer.byteLength(line, 'utf8');

describe('calendar feed (#862)', () => {
  it('escapes backslashes, semicolons, commas and line breaks, and drops other control characters', () => {
    expect(escapeText('a\\b; c, d\ne\r\nf\rg')).toBe('a\\\\b\\; c\\, d\\ne\\nf\\ng');
    expect(escapeText('x\u0000y\u0007z\tw')).toBe('xyz\tw');
  });

  it('folds lines at 75 octets without splitting a character, and unfolds to the same text', () => {
    const line = `SUMMARY:${'Khai trương cửa hàng mới ở Hà Nội, ưu đãi đặc biệt cho khách hàng thân thiết '.repeat(4)}`;
    const folded = foldLine(line);
    const parts = folded.split('\r\n');
    expect(parts.length).toBeGreaterThan(4);
    for (const p of parts) expect(octets(p)).toBeLessThanOrEqual(75);
    for (const p of parts.slice(1)) expect(p.startsWith(' ')).toBe(true);
    expect(unfold(folded)).toBe(line);
    // A three-byte letter that would end at octet 77 starts the next line, and so does a four-byte emoji.
    expect(foldLine(`${'a'.repeat(74)}ệ`)).toBe(`${'a'.repeat(74)}\r\n ệ`);
    expect(foldLine(`${'a'.repeat(73)}🎉b`)).toBe(`${'a'.repeat(73)}\r\n 🎉b`);
    // Exactly 75 octets stay on one line.
    expect(foldLine('a'.repeat(75))).toBe('a'.repeat(75));
    expect(foldLine('a'.repeat(76))).toBe(`${'a'.repeat(75)}\r\n a`);
  });

  it('writes UTC times in the basic format', () => {
    expect(icsTime(new Date('2026-10-05T03:04:05.678Z'))).toBe('20261005T030405Z');
  });

  it('draws one event per channel post, with CRLF line ends', () => {
    const feed: CalendarFeed = {
      slug: 'cua-hang',
      name: 'Cửa hàng; Bánh, Trà',
      events: [
        { id: '01900000-0000-7000-8000-000000000001', postId: '01900000-0000-7000-8000-0000000000aa', provider: 'facebook_page', at: '2026-10-25T02:00:00+00:00', status: 'scheduled', title: 'Khai trương' },
        { id: '01900000-0000-7000-8000-000000000002', postId: '01900000-0000-7000-8000-0000000000bb', provider: 'zalo_oa', at: '2026-10-01T09:30:00Z', status: 'published', title: '' },
      ],
    };
    const text = renderIcs(feed, 'https://crove.example/', new Date('2026-10-21T08:00:00Z'));
    expect(text.endsWith('\r\n')).toBe(true);
    expect(text.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
    const lines = unfold(text).split('\r\n');
    expect(lines.slice(0, 6)).toEqual(['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Crove//Social//VI', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:Cửa hàng\\; Bánh\\, Trà - Crove']);
    expect(lines.filter((l) => l === 'BEGIN:VEVENT')).toHaveLength(2);
    expect(lines.filter((l) => l === 'END:VEVENT')).toHaveLength(2);
    expect(lines.at(-2)).toBe('END:VCALENDAR');
    const first = lines.slice(lines.indexOf('BEGIN:VEVENT'), lines.indexOf('END:VEVENT') + 1);
    expect(first).toEqual([
      'BEGIN:VEVENT',
      'UID:01900000-0000-7000-8000-000000000001@crove',
      'DTSTAMP:20261021T080000Z',
      'DTSTART:20261025T020000Z',
      'DURATION:PT15M',
      'SUMMARY:Facebook: Khai trương',
      'DESCRIPTION:Trạng thái: Đã lên lịch\\nMở trong Crove: https://crove.example/o/cua-hang/social/01900000-0000-7000-8000-0000000000aa',
      'URL:https://crove.example/o/cua-hang/social/01900000-0000-7000-8000-0000000000aa',
      'END:VEVENT',
    ]);
    // No title: the channel alone.
    expect(lines).toContain('SUMMARY:Zalo OA');
    expect(lines).toContain('DTSTART:20261001T093000Z');
    expect(lines.some((l) => l.startsWith('DESCRIPTION:Trạng thái: Đã đăng\\n'))).toBe(true);
    for (const l of text.split('\r\n')) expect(octets(l)).toBeLessThanOrEqual(75);
  });

  it('draws an empty calendar when nothing goes out', () => {
    const text = renderIcs({ slug: 'a-b', name: 'A', events: [] }, 'http://localhost:8080', new Date());
    expect(text).toContain('BEGIN:VCALENDAR\r\n');
    expect(text).not.toContain('BEGIN:VEVENT');
    expect(text.endsWith('END:VCALENDAR\r\n')).toBe(true);
  });
});
