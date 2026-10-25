// The public side of a member's booking feed (#1382): GET /cal/<token>.ics, the posting calendar feed's route (#862),
// also answers a member's bookings as an iCalendar file (RFC 5545) that Google Calendar, Outlook or Apple Calendar
// subscribes to. It runs the migration's definer on the control plane as the API login role; the token is the only
// credential, and only what the member needs on their own calendar comes back: times, the event type, where, and the
// visitor's name (no email, phone or note).
import { sql } from 'kysely';
import type { Runtime } from '@crove/kernel-runtime';
import { escapeText, foldLine, icsTime } from './calendar-feed.ts';

const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export interface BookingFeedEvent {
  // The booking id.
  id: string;
  startsAt: string;
  endsAt: string;
  revision: number;
  title: string;
  locationKind: 'in_person' | 'phone' | 'video';
  location: string | null;
  // NULL once the visitor's personal data was erased.
  visitorName: string | null;
}

export interface BookingFeed {
  slug: string;
  name: string;
  events: BookingFeedEvent[];
}

// null: a malformed token, or one that names no live feed (the same answer either way).
export async function bookingFeed(runtime: Runtime, token: string): Promise<BookingFeed | null> {
  if (!TOKEN.test(token)) return null;
  return runtime.orgless(async (db) => {
    const { rows } = await sql<{ feed: BookingFeed | null }>`SELECT crove_crm.booking_feed_events(${token}) AS feed`.execute(db);
    return rows[0]?.feed ?? null;
  });
}

const LOCATIONS: Record<BookingFeedEvent['locationKind'], string> = { in_person: 'Gặp trực tiếp', phone: 'Gọi điện', video: 'Họp trực tuyến' };

// One line, at most 200 characters: a title or a name never breaks the event's layout.
const oneLine = (text: string) => [...text.replace(/\s+/g, ' ').trim()].slice(0, 200).join('');

// brand: the product name users see (BRAND_NAME, #1045). PRODID and UID keep "Crove": they identify the software. The
// UID differs from the one in the booking's mails (booking-<id>@crove), so a host who also added the mail's event keeps
// two entries in two calendars instead of one entry the calendar app may refuse as a duplicate.
export function renderBookingFeedIcs(feed: BookingFeed, publicUrl: string, now: Date, brand = 'Crove'): string {
  const base = publicUrl.replace(/\/+$/, '');
  const stamp = icsTime(now);
  const url = `${base}/o/${feed.slug}/bookings`;
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Crove//Booking feed//VI',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(`Lịch hẹn ${feed.name} - ${brand}`)}`,
    // How often clients that honour it should fetch the feed again.
    'REFRESH-INTERVAL;VALUE=DURATION:PT15M',
    'X-PUBLISHED-TTL:PT15M',
  ];
  for (const e of feed.events) {
    const start = new Date(e.startsAt);
    const end = new Date(e.endsAt);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) continue;
    const visitor = oneLine(e.visitorName ?? '') || 'Khách';
    const where = `${LOCATIONS[e.locationKind] ?? e.locationKind}${e.location ? `: ${oneLine(e.location)}` : ''}`;
    lines.push(
      'BEGIN:VEVENT',
      `UID:feed-booking-${e.id}@crove`,
      `SEQUENCE:${Number.isInteger(e.revision) && e.revision >= 0 ? e.revision : 0}`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${icsTime(start)}`,
      `DTEND:${icsTime(end)}`,
      `SUMMARY:${escapeText(`${oneLine(e.title)}: ${visitor}`)}`,
      ...(e.location ? [`LOCATION:${escapeText(oneLine(e.location))}`] : []),
      `DESCRIPTION:${escapeText(`${where}\nMở trong ${brand}: ${url}`)}`,
      'STATUS:CONFIRMED',
      `URL:${url}`,
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(foldLine).join('\r\n')}\r\n`;
}
