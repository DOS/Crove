// A member's booking feed as an iCalendar file (#1382, RFC 5545).
import { describe, expect, it } from 'vitest';
import { renderBookingFeedIcs, type BookingFeed } from '../src/booking-feed.ts';

const unfold = (text: string) => text.replace(/\r\n /g, '');
const octets = (line: string) => Buffer.byteLength(line, 'utf8');
const NOW = new Date('2026-11-02T01:00:00Z');

const feed: BookingFeed = {
  slug: 'van-phong',
  name: 'Văn phòng Kế toán; Hà Nội',
  events: [
    {
      id: '0192f0a0-0000-7000-8000-000000000001',
      startsAt: '2026-11-03T02:00:00.000Z',
      endsAt: '2026-11-03T02:30:00.000Z',
      revision: 2,
      title: 'Tư vấn thuế, 30 phút',
      locationKind: 'video',
      location: 'https://meet.example.test/abc',
      visitorName: 'Chị Lan\nNguyễn',
    },
    {
      id: '0192f0a0-0000-7000-8000-000000000002',
      startsAt: '2026-11-04T08:00:00.000Z',
      endsAt: '2026-11-04T09:00:00.000Z',
      revision: 0,
      title: 'Gặp tại văn phòng',
      locationKind: 'in_person',
      location: null,
      visitorName: null,
    },
  ],
};

describe('booking feed (#1382)', () => {
  it('draws one event per booking, with its times, revision, where and the visitor, in CRLF lines of 75 octets at most', () => {
    const text = renderBookingFeedIcs(feed, 'https://crove.example.test/', NOW, 'Crove');
    expect(text.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n')).toBe(true);
    expect(text.endsWith('END:VCALENDAR\r\n')).toBe(true);
    for (const l of text.split('\r\n')) expect(octets(l)).toBeLessThanOrEqual(75);
    const lines = unfold(text).split('\r\n');
    expect(lines).toContain('X-WR-CALNAME:Lịch hẹn Văn phòng Kế toán\\; Hà Nội - Crove');
    expect(lines).toContain('REFRESH-INTERVAL;VALUE=DURATION:PT15M');
    expect(lines.filter((l) => l === 'BEGIN:VEVENT')).toHaveLength(2);
    const first = lines.slice(lines.indexOf('BEGIN:VEVENT'), lines.indexOf('END:VEVENT') + 1);
    expect(first).toEqual([
      'BEGIN:VEVENT',
      'UID:feed-booking-0192f0a0-0000-7000-8000-000000000001@crove',
      'SEQUENCE:2',
      'DTSTAMP:20261102T010000Z',
      'DTSTART:20261103T020000Z',
      'DTEND:20261103T023000Z',
      // The visitor's name on one line; the title's comma escaped.
      'SUMMARY:Tư vấn thuế\\, 30 phút: Chị Lan Nguyễn',
      'LOCATION:https://meet.example.test/abc',
      'DESCRIPTION:Họp trực tuyến: https://meet.example.test/abc\\nMở trong Crove: https://crove.example.test/o/van-phong/bookings',
      'STATUS:CONFIRMED',
      'URL:https://crove.example.test/o/van-phong/bookings',
      'END:VEVENT',
    ]);
    // An erased visitor shows as "Khách", and no location line without a place.
    expect(lines).toContain('SUMMARY:Gặp tại văn phòng: Khách');
    expect(lines.filter((l) => l.startsWith('LOCATION:'))).toHaveLength(1);
  });

  it('draws an empty calendar when the member has no booking, and skips an event with a broken time', () => {
    expect(renderBookingFeedIcs({ ...feed, events: [] }, 'http://localhost:8080', NOW).includes('BEGIN:VEVENT')).toBe(false);
    const broken = renderBookingFeedIcs({ ...feed, events: [{ ...(feed.events[0] as BookingFeed['events'][number]), startsAt: 'not a time' }] }, 'http://localhost:8080', NOW);
    expect(broken.includes('BEGIN:VEVENT')).toBe(false);
  });
});
