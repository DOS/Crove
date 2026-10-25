// The crm.scheduler agent's comment (#1434): the cancelled time and the slots to offer, on the host's wall clock.
import { describe, expect, it } from 'vitest';
import { escalationTitle, proposalText, wallClock, type NextSlots } from '@crove/mod-crm';

const base: NextSlots = {
  bookingId: '0192f0a0-0000-7000-8000-000000000001',
  status: 'cancelled',
  eventType: { title: 'Tư vấn thuế', active: true },
  startsAt: '2026-11-02T03:00:00.000Z',
  timeZone: 'Asia/Ho_Chi_Minh',
  slots: [
    { start: '2026-11-02T02:00:00.000Z', end: '2026-11-02T03:00:00.000Z' },
    { start: '2026-11-03T02:30:00.000Z', end: '2026-11-03T03:30:00.000Z' },
  ],
};

describe('crm.scheduler comment (#1434)', () => {
  it('writes times on the wall clock of the zone, with the Vietnamese weekday', () => {
    expect(wallClock('Asia/Ho_Chi_Minh', Date.parse('2026-11-02T03:00:00Z'))).toBe('10:00 Thứ Hai 02/11/2026');
    expect(wallClock('Asia/Ho_Chi_Minh', Date.parse('2026-11-07T17:30:00Z'))).toBe('00:30 Chủ nhật 08/11/2026');
    expect(wallClock('Europe/Berlin', Date.parse('2026-10-25T00:30:00Z'))).toBe('02:30 Chủ nhật 25/10/2026');
  });

  it('lists the slots to offer, and says why when there are none', () => {
    expect(proposalText(base)).toBe(
      [
        'Khách đã hủy lịch hẹn "Tư vấn thuế" lúc 10:00 Thứ Hai 02/11/2026 (Asia/Ho_Chi_Minh).',
        'Các giờ trống gần nhất trên trang đặt lịch:',
        '- 09:00 Thứ Hai 02/11/2026',
        '- 09:30 Thứ Ba 03/11/2026',
        'Người phụ trách xem thông tin khách trong mục Lịch hẹn và quyết định có mời khách đặt lại hay không.',
      ].join('\n'),
    );
    expect(proposalText({ ...base, slots: [] })).toContain('Trong 14 ngày tới loại lịch hẹn này không còn giờ trống');
    expect(proposalText({ ...base, eventType: { title: 'Tư vấn thuế', active: false } })).toContain('đã được lưu trữ');
    expect(escalationTitle(base)).toBe('Mời khách đặt lại: Tư vấn thuế');
  });
});
