// The public side of the posting calendar feed (#862): GET /cal/<token>.ics answers an iCalendar file (RFC 5545) that
// Google Calendar or Outlook subscribes to. It runs the migration's definer on the control plane as the API login role;
// the token is the only credential, and only what goes out (time, channel, status, a short title) comes back.
import { sql } from 'kysely';
import type { Runtime } from '@crove/kernel-runtime';

// Calendar apps fetch from shared provider addresses, so one client address may stand for many subscribers.
export const CALENDAR_FEED_HITS_PER_MINUTE = 300;

const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export interface CalendarFeedEvent {
  // The channel post (variant) id.
  id: string;
  postId: string;
  provider: string;
  at: string;
  status: 'scheduled' | 'published';
  title: string;
}

export interface CalendarFeed {
  slug: string;
  name: string;
  events: CalendarFeedEvent[];
}

// null: a malformed token, or one that names no live feed (the same answer either way).
export async function calendarFeed(runtime: Runtime, token: string): Promise<CalendarFeed | null> {
  if (!TOKEN.test(token)) return null;
  return runtime.orgless(async (db) => {
    const { rows } = await sql<{ feed: CalendarFeed | null }>`SELECT crove_social.calendar_feed_events(${token}) AS feed`.execute(db);
    return rows[0]?.feed ?? null;
  });
}

// Short names of the providers, as the app shows them.
const PROVIDERS: Record<string, string> = {
  sandbox: 'Sandbox',
  facebook_page: 'Facebook',
  instagram: 'Instagram',
  zalo_oa: 'Zalo OA',
  tiktok: 'TikTok',
  youtube: 'YouTube',
  threads: 'Threads',
  linkedin: 'LinkedIn',
  x: 'X',
  bluesky: 'Bluesky',
  google_business: 'Google Business',
  telegram: 'Telegram',
  mastodon: 'Mastodon',
  pinterest: 'Pinterest',
  discord: 'Discord',
  wordpress: 'WordPress',
  linkedin_page: 'LinkedIn Page',
};
const STATUS: Record<CalendarFeedEvent['status'], string> = { scheduled: 'Đã lên lịch', published: 'Đã đăng' };

// A TEXT value (RFC 5545 §3.3.11): backslash, semicolon, comma and line breaks escaped, other control characters dropped.
export function escapeText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n')
    .replace(/\p{Cc}/gu, (c) => (c === '\t' ? c : ''));
}

// A content line folded at 75 octets (RFC 5545 §3.1): each further line starts with one space, and a character's
// UTF-8 bytes always stay on one line.
export function foldLine(line: string): string {
  const out: string[] = [];
  let current = '';
  let octets = 0;
  for (const ch of line) {
    const size = Buffer.byteLength(ch, 'utf8');
    if (octets + size > 75) {
      out.push(current);
      current = ' ';
      octets = 1;
    }
    current += ch;
    octets += size;
  }
  out.push(current);
  return out.join('\r\n');
}

// A UTC time in the basic format, 20261005T030000Z.
export function icsTime(at: Date): string {
  return at.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '');
}

export function renderIcs(feed: CalendarFeed, publicUrl: string, now: Date): string {
  const base = publicUrl.replace(/\/+$/, '');
  const stamp = icsTime(now);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Crove//Social//VI',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(`${feed.name} - Crove`)}`,
    // How often clients that honour it should fetch the feed again.
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H',
  ];
  for (const e of feed.events) {
    const at = new Date(e.at);
    if (Number.isNaN(at.getTime())) continue;
    const label = PROVIDERS[e.provider] ?? e.provider;
    const url = `${base}/o/${feed.slug}/social/${e.postId}`;
    lines.push(
      'BEGIN:VEVENT',
      `UID:${e.id}@crove`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${icsTime(at)}`,
      'DURATION:PT15M',
      `SUMMARY:${escapeText(e.title ? `${label}: ${e.title}` : label)}`,
      `DESCRIPTION:${escapeText(`Trạng thái: ${STATUS[e.status] ?? e.status}\nMở trong Crove: ${url}`)}`,
      `URL:${url}`,
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(foldLine).join('\r\n')}\r\n`;
}
