// The booking mails (#1319): the visitor's carry a manage link minted at send time and an .ics event; the host's carry
// the visitor's details, read at send time; a cancel's event cancels; data the template does not expect fails the mail.
import { describe, expect, it } from 'vitest';
import { bookingWhen, renderBookingMail } from '../src/booking-mail.ts';
import type { MailTemplateInput } from '../src/mail-queue.ts';

const TOKEN = `${'a'.repeat(32)}.2.${'b'.repeat(32)}`;
const NOW = new Date('2026-11-01T00:00:00.000Z');
const base = {
  kind: 'confirmed',
  recipient: 'visitor',
  bookingId: '0192f0aa-0000-7000-8000-000000000001',
  revision: 2,
  org: 'cong-ty-a',
  orgName: 'Công ty A',
  type: 'tu-van',
  title: 'Tư vấn thuế',
  startsAt: '2026-11-02T02:00:00.000Z',
  endsAt: '2026-11-02T02:30:00.000Z',
  timeZone: 'Asia/Ho_Chi_Minh',
  locationKind: 'video',
  location: 'https://meet.example.test/x',
};
const VISITOR = { name: 'Nguyễn Văn Khách', email: 'khach@example.test', phone: '0901234567', note: 'Hỏi về <thuế>' };

function input(payload: Record<string, unknown>, token: string | null = TOKEN, visitor: typeof VISITOR | null = VISITOR): MailTemplateInput & { asked: unknown[] } {
  const asked: unknown[] = [];
  return {
    asked,
    messageId: 'm1',
    subject: 'Đã xác nhận lịch hẹn: Tư vấn thuế',
    payload,
    publicUrl: 'https://app.example.test/',
    inboundAddress: null,
    brand: 'Crove',
    execute: async <T,>(command: string, args: unknown) => {
      asked.push([command, args]);
      return { token, visitor } as T;
    },
  };
}

describe('booking mails (#1319)', () => {
  it('writes the time in the zone given, with the Vietnamese weekday', () => {
    expect(bookingWhen(base.startsAt, base.endsAt, 'Asia/Ho_Chi_Minh')).toBe('Thứ Hai, 02/11/2026, 09:00 - 09:30 (Asia/Ho_Chi_Minh)');
    expect(bookingWhen(base.startsAt, base.endsAt, 'Europe/Berlin')).toBe('Thứ Hai, 02/11/2026, 03:00 - 03:30 (Europe/Berlin)');
  });

  it("gives the visitor a manage link minted at send time and the booking's .ics event", async () => {
    const i = input(base);
    const mail = await renderBookingMail(i, () => NOW);
    expect(i.asked).toEqual([['crm.booking.mail_data', { bookingId: base.bookingId }]]);
    expect(mail?.subject).toBe('Đã xác nhận lịch hẹn: Tư vấn thuế');
    expect(mail?.text).toContain('Chào Nguyễn Văn Khách,');
    expect(mail?.text).toContain('Thời gian: Thứ Hai, 02/11/2026, 09:00 - 09:30 (Asia/Ho_Chi_Minh)');
    expect(mail?.text).toContain(`Đổi giờ hoặc hủy lịch: https://app.example.test/-/b/cong-ty-a/tu-van#m=${TOKEN}`);
    expect(mail?.html).toContain(`href="https://app.example.test/-/b/cong-ty-a/tu-van#m=${TOKEN}"`);
    const [ics] = mail?.attachments ?? [];
    expect(ics).toMatchObject({ filename: 'lich-hen.ics', contentType: 'text/calendar; method=PUBLISH; charset=UTF-8' });
    const lines = ics?.content.split('\r\n') ?? [];
    expect(lines).toEqual(
      expect.arrayContaining([
        'METHOD:PUBLISH',
        `UID:booking-${base.bookingId}@crove`,
        'SEQUENCE:2',
        'DTSTAMP:20261101T000000Z',
        'DTSTART:20261102T020000Z',
        'DTEND:20261102T023000Z',
        'SUMMARY:Tư vấn thuế - Công ty A',
        'LOCATION:https://meet.example.test/x',
        'STATUS:CONFIRMED',
      ]),
    );
  });

  it("gives the host the visitor's details and no manage link", async () => {
    const mail = await renderBookingMail(input({ ...base, recipient: 'host' }), () => NOW);
    expect(mail?.text).toContain('Khách: Nguyễn Văn Khách');
    expect(mail?.text).toContain('Email: khach@example.test');
    expect(mail?.text).toContain('Ghi chú: Hỏi về <thuế>');
    expect(mail?.html).toContain('Hỏi về &lt;thuế&gt;');
    expect(mail?.text).not.toContain('#m=');
    expect(mail?.attachments?.[0]?.content).toContain('SUMMARY:Tư vấn thuế: Nguyễn Văn Khách');
  });

  it('cancels the event on a cancel, sends no link once the booking stands no more, and no file with a reminder', async () => {
    const cancelled = await renderBookingMail(input({ ...base, kind: 'cancelled' }), () => NOW);
    expect(cancelled?.text).not.toContain('#m=');
    expect(cancelled?.attachments?.[0]).toMatchObject({ contentType: 'text/calendar; method=CANCEL; charset=UTF-8' });
    expect(cancelled?.attachments?.[0]?.content).toContain('STATUS:CANCELLED');
    const noToken = await renderBookingMail(input({ ...base, kind: 'reminder' }, null), () => NOW);
    expect(noToken?.text).not.toContain('#m=');
    expect(noToken?.attachments).toBeUndefined();
  });

  it('writes no name of a visitor erased since the mail was queued', async () => {
    const mail = await renderBookingMail(input({ ...base, recipient: 'host' }, TOKEN, { name: null, email: null, phone: null, note: null } as never), () => NOW);
    expect(mail?.text).not.toContain('Nguyễn');
    expect(mail?.text).not.toContain('khach@');
    expect(mail?.text).toContain('Khách: Khách');
  });

  it('fails a mail whose data is not what the template expects', async () => {
    expect(await renderBookingMail(input({ ...base, kind: 'other' }))).toBeNull();
    expect(await renderBookingMail(input({ ...base, org: '../evil' }))).toBeNull();
    expect(await renderBookingMail(input({ ...base, startsAt: 'tomorrow' }))).toBeNull();
  });
});
