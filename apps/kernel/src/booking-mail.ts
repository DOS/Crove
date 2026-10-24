// The booking mails (#1319, template crm.booking): a booking confirmed, moved or cancelled, to the visitor and to the
// host, and the reminders to the visitor. A confirmation, a move and a cancel carry the booking as an .ics event (RFC
// 5545; one UID per booking, its revision as SEQUENCE, so a calendar app updates the event it already holds). Times are
// written in the recipient's zone.
//
// The merge data names the booking, never the visitor: the template reads the visitor's details and the manage token
// when it sends the mail (crm.booking.mail_data, as the worker), so an erased visitor is gone from queued mail too and
// the token never sits in the queue. The visitor's mails carry the link to cancel or move the booking; it stops working
// at the next cancel or move.
import { z } from 'zod';
import type { BookingMailData } from '@crove/mod-crm';
import { escapeText, foldLine, icsTime } from './calendar-feed.ts';
import type { MailTemplate, MailTemplateInput } from './mail-queue.ts';

const zText = (max: number) => z.string().max(max);
const zPayload = z.object({
  kind: z.enum(['confirmed', 'moved', 'cancelled', 'reminder']),
  recipient: z.enum(['visitor', 'host']),
  bookingId: z.uuid(),
  revision: z.number().int().min(0),
  org: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).max(63),
  orgName: zText(200),
  type: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).max(60),
  title: zText(200),
  startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.iso.datetime({ offset: true }),
  timeZone: zText(64),
  locationKind: z.enum(['in_person', 'phone', 'video']),
  location: zText(500).nullable(),
});
type Payload = z.infer<typeof zPayload>;
// The payload with the visitor's name as the booking holds it when the mail is sent.
type Booking = Payload & { visitorName: string };

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
const oneLine = (text: string) => text.replace(/[\r\n\t]+/g, ' ').trim();

const LOCATIONS: Record<Payload['locationKind'], string> = { in_person: 'Gặp trực tiếp', phone: 'Gọi điện', video: 'Họp trực tuyến' };

const LEADS: Record<Payload['kind'], Record<Payload['recipient'], (p: Booking) => string>> = {
  confirmed: {
    visitor: (p) => `Lịch hẹn của bạn với ${p.orgName} đã được xác nhận.`,
    host: (p) => `${p.visitorName} vừa đặt một lịch hẹn với bạn.`,
  },
  moved: {
    visitor: (p) => `Lịch hẹn của bạn với ${p.orgName} đã được đổi sang giờ mới.`,
    host: (p) => `${p.visitorName} đã đổi giờ lịch hẹn với bạn.`,
  },
  cancelled: {
    visitor: (p) => `Lịch hẹn của bạn với ${p.orgName} đã được hủy.`,
    host: (p) => `${p.visitorName} đã hủy lịch hẹn với bạn. Khung giờ này đã trống lại.`,
  },
  reminder: {
    visitor: (p) => `Nhắc bạn lịch hẹn sắp tới với ${p.orgName}.`,
    host: (p) => `Nhắc bạn lịch hẹn sắp tới với ${p.visitorName}.`,
  },
};

const pad = (n: number) => String(n).padStart(2, '0');
// "Thứ Hai, 02/11/2026, 09:00 - 09:30 (Asia/Ho_Chi_Minh)" in the zone given; the zone itself when Intl does not know it.
export function bookingWhen(startsAt: string, endsAt: string, timeZone: string): string {
  let zone = timeZone;
  try {
    new Intl.DateTimeFormat('vi-VN', { timeZone: zone });
  } catch {
    zone = 'UTC';
  }
  const parts = (at: string) => {
    const f = new Intl.DateTimeFormat('en-GB', { timeZone: zone, weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    return Object.fromEntries(f.formatToParts(new Date(at)).map((p) => [p.type, p.value])) as Record<string, string>;
  };
  const WEEKDAYS: Record<string, string> = { Mon: 'Thứ Hai', Tue: 'Thứ Ba', Wed: 'Thứ Tư', Thu: 'Thứ Năm', Fri: 'Thứ Sáu', Sat: 'Thứ Bảy', Sun: 'Chủ nhật' };
  const s = parts(startsAt);
  const e = parts(endsAt);
  const time = (p: Record<string, string>) => `${pad(Number(p.hour))}:${p.minute}`;
  return `${WEEKDAYS[s.weekday ?? ''] ?? s.weekday}, ${s.day}/${s.month}/${s.year}, ${time(s)} - ${time(e)} (${zone})`;
}

// The booking as an iCalendar file: PUBLISH for a booking that stands, CANCEL with STATUS:CANCELLED for one that does
// not. PRODID and the UID's domain name the software, not the product.
export function bookingIcs(p: Booking, brand: string, now: Date): string {
  const cancelled = p.kind === 'cancelled';
  const summary = p.recipient === 'host' ? `${p.title}: ${p.visitorName}` : `${p.title} - ${p.orgName}`;
  const description = [`${LOCATIONS[p.locationKind]}${p.location ? `: ${p.location}` : ''}`, `Gửi từ ${brand}`].join('\n');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Crove//Booking//VI',
    'CALSCALE:GREGORIAN',
    `METHOD:${cancelled ? 'CANCEL' : 'PUBLISH'}`,
    'BEGIN:VEVENT',
    `UID:booking-${p.bookingId}@crove`,
    `SEQUENCE:${p.revision}`,
    `DTSTAMP:${icsTime(now)}`,
    `DTSTART:${icsTime(new Date(p.startsAt))}`,
    `DTEND:${icsTime(new Date(p.endsAt))}`,
    `SUMMARY:${escapeText(oneLine(summary))}`,
    ...(p.location ? [`LOCATION:${escapeText(oneLine(p.location))}`] : []),
    `DESCRIPTION:${escapeText(description)}`,
    `STATUS:${cancelled ? 'CANCELLED' : 'CONFIRMED'}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return `${lines.map(foldLine).join('\r\n')}\r\n`;
}

export async function renderBookingMail(input: MailTemplateInput, now: () => Date = () => new Date()) {
  const parsed = zPayload.safeParse(input.payload);
  if (!parsed.success) return null;
  const data = await input.execute<BookingMailData>('crm.booking.mail_data', { bookingId: parsed.data.bookingId });
  const visitor = data.visitor;
  const p: Booking = { ...parsed.data, visitorName: visitor?.name ? [...oneLine(visitor.name)].slice(0, 100).join('') : 'Khách' };
  const base = input.publicUrl.replace(/\/+$/, '');
  // The visitor's link to cancel or move, while the booking stands; its token goes in the fragment, which browsers never
  // send to a server.
  const manageUrl = p.recipient === 'visitor' && p.kind !== 'cancelled' && data.token ? `${base}/-/b/${p.org}/${p.type}#m=${data.token}` : null;
  const lead = LEADS[p.kind][p.recipient](p);
  const details: Array<[string, string]> = [
    ['Lịch hẹn', oneLine(p.title)],
    ['Thời gian', bookingWhen(p.startsAt, p.endsAt, p.timeZone)],
    ['Hình thức', `${LOCATIONS[p.locationKind]}${p.location ? `: ${oneLine(p.location)}` : ''}`],
  ];
  if (p.recipient === 'host') {
    details.push(['Khách', p.visitorName]);
    if (visitor?.email) details.push(['Email', oneLine(visitor.email)]);
    if (visitor?.phone) details.push(['Điện thoại', oneLine(visitor.phone)]);
    if (visitor?.note) details.push(['Ghi chú', visitor.note]);
  }
  const footer = `Thư này được gửi từ ${input.brand} thay mặt ${oneLine(p.orgName)}.`;
  const greeting = p.recipient === 'visitor' && visitor?.name ? `Chào ${p.visitorName},` : 'Chào bạn,';
  const text = [
    greeting,
    '',
    lead,
    '',
    ...details.map(([k, v]) => `${k}: ${v}`),
    ...(manageUrl ? ['', `Đổi giờ hoặc hủy lịch: ${manageUrl}`, 'Liên kết này chỉ dùng được một lần.'] : []),
    '',
    footer,
  ].join('\n');
  const html = `<!doctype html><html lang="vi"><body style="font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#18181b;line-height:1.5">
<p style="margin:0 0 12px">${escapeHtml(greeting)}</p>
<p style="margin:0 0 12px">${escapeHtml(lead)}</p>
<table style="border-collapse:collapse;margin:0 0 16px">${details
    .map(([k, v]) => `<tr><td style="padding:2px 12px 2px 0;color:#71717a;vertical-align:top">${escapeHtml(k)}</td><td style="padding:2px 0;white-space:pre-line">${escapeHtml(v)}</td></tr>`)
    .join('')}</table>
${manageUrl ? `<p style="margin:16px 0"><a href="${escapeHtml(manageUrl)}" style="color:#b91c1c">Đổi giờ hoặc hủy lịch</a><br><span style="font-size:12px;color:#71717a">Liên kết này chỉ dùng được một lần.</span></p>` : ''}
<p style="font-size:12px;color:#71717a">${escapeHtml(footer)}</p>
</body></html>`;
  const subject = [...oneLine(input.subject ?? lead)].slice(0, 200).join('');
  const attachments =
    p.kind === 'reminder'
      ? []
      : [{ filename: 'lich-hen.ics', contentType: `text/calendar; method=${p.kind === 'cancelled' ? 'CANCEL' : 'PUBLISH'}; charset=UTF-8`, content: bookingIcs(p, input.brand, now()) }];
  return { subject, text, html, ...(attachments.length ? { attachments } : {}) };
}

export const bookingMailTemplate: MailTemplate = { render: (input) => renderBookingMail(input) };
