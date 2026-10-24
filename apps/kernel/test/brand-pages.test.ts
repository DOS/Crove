// Pages and texts the kernel serves outside the app and mail name the product by BRAND_NAME (#1045): the public
// status page, the bio page, the calendar feed and the chat alert test line. "Crove" when it is not given.
import { describe, expect, it } from 'vitest';
import { renderBioPage, type BioView } from '../src/bio-page.ts';
import { renderIcs, type CalendarFeed } from '../src/calendar-feed.ts';
import { CHAT_ALERT_TEST_TEXT, chatAlertTestText } from '../src/chat-alerts.ts';
import { probeStatus, renderStatusPage, statusView } from '../src/status-page.ts';

const NOW = new Date('2026-10-20T12:00:00Z');
const BIO: BioView = { title: 'Tiệm bánh', about: null, avatar: false, avatarId: null, buttons: [], posts: [] };
const FEED: CalendarFeed = {
  slug: 'tiem-banh',
  name: 'Tiệm bánh',
  events: [{ id: '01900000-0000-7000-8000-000000000001', postId: '01900000-0000-7000-8000-0000000000aa', provider: 'facebook_page', at: '2026-10-25T02:00:00+00:00', status: 'scheduled', title: 'Khai trương' }],
};
const unfold = (text: string) => text.replace(/\r\n /g, '');

describe('brand name outside the app (#1045)', () => {
  it('keeps "Crove" when no brand is given', () => {
    expect(renderStatusPage(statusView(probeStatus(NOW, []), NOW))).toContain('<title>Trạng thái hệ thống - Crove</title>');
    expect(renderBioPage('tiem-banh', BIO)).toContain('<footer>Crove</footer>');
    expect(unfold(renderIcs(FEED, 'https://crove.example', NOW))).toContain('X-WR-CALNAME:Tiệm bánh - Crove');
    expect(CHAT_ALERT_TEST_TEXT.startsWith('Crove: tin thử.')).toBe(true);
  });

  it('names the configured brand, escaped in HTML, and keeps the software identifiers', () => {
    expect(renderStatusPage(statusView(probeStatus(NOW, []), NOW), "Sổ & Co's")).toContain('<title>Trạng thái hệ thống - Sổ &amp; Co&#39;s</title>');
    const bio = renderBioPage('tiem-banh', BIO, 'Tên Mới');
    expect(bio).toContain('<footer>Tên Mới</footer>');
    expect(bio).not.toContain('Crove');
    const ics = unfold(renderIcs(FEED, 'https://crove.example', NOW, 'Tên Mới'));
    expect(ics).toContain('X-WR-CALNAME:Tiệm bánh - Tên Mới');
    expect(ics).toContain('Mở trong Tên Mới: https://crove.example/o/tiem-banh/social/');
    // PRODID and UID name the software that wrote the feed, not the product.
    expect(ics).toContain('PRODID:-//Crove//Social//VI');
    expect(chatAlertTestText('Tên Mới')).toBe('Tên Mới: tin thử. Từ giờ nhóm sẽ nhận tin báo về bài đăng mạng xã hội tại đây.');
  });
});
