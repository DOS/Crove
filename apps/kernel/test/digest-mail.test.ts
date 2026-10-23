// The weekly digest mail (#1104): what it says, in Vietnamese with the product name given, the links it builds from app
// paths only, and the merge data it refuses.
import { describe, expect, it } from 'vitest';
import { renderDigestMail } from '../src/digest-mail.ts';

const POST = '0190a3c4-0000-7000-8000-000000000001';
const OTHER = '0190a3c4-0000-7000-8000-000000000002';
const base = {
  org: 'Cửa hàng <A>',
  week: '2026-W44',
  lastWeek: { from: '2026-10-19', to: '2026-10-26' },
  thisWeek: { from: '2026-10-26', to: '2026-11-01' },
  home: '/o/cua-hang-a/social',
  settings: '/o/cua-hang-a/social/notifications',
  last: {
    published: 3,
    channels: [
      { name: 'Trang chính', provider: 'facebook', published: 2, failed: 1 },
      { name: 'Kênh phụ', provider: 'threads', published: 1, failed: 0 },
    ],
    top: [{ text: 'Khuyến mãi <b>lớn</b>', channel: 'Trang chính', engagement: 1234, path: `/o/cua-hang-a/social/${POST}` }],
    failures: { total: 7, items: [{ text: 'Bài lỗi', channel: 'Trang chính', path: `/o/cua-hang-a/social/${OTHER}` }] },
  },
  next: {
    days: [
      { date: '2026-10-26', planned: 2 },
      { date: '2026-10-27', planned: 0 },
    ],
    emptyQueueDays: [{ channel: 'Kênh phụ', dates: ['2026-10-29', '2026-10-31'] }],
  },
  review: null as null | { total: number; items: { text: string; path: string }[] },
};
const render = (payload: unknown, brand = 'Crove') =>
  renderDigestMail({
    messageId: 'm1',
    subject: 'Bản tin tuần 26/10 - 01/11 của Cửa hàng <A>',
    payload: payload as Record<string, unknown>,
    publicUrl: 'https://crove.example/',
    brand,
    inboundAddress: null,
    execute: () => Promise.reject(new Error('not used')),
  });

describe('weekly digest mail (#1104)', () => {
  it('says what went out last week and what is planned this week, with links to the posts', async () => {
    const mail = await render(base);
    expect(mail?.subject).toBe('Bản tin tuần 26/10 - 01/11 của Cửa hàng <A>');
    const text = mail?.text ?? '';
    expect(text).toContain('Bản tin tuần của Cửa hàng <A>');
    expect(text).toContain('Tuần trước (19/10 - 26/10)');
    expect(text).toContain('Đã đăng: 3 bài');
    expect(text).toContain('- Trang chính: 2 bài đã đăng, 1 bài không thành công');
    expect(text).toContain('- Kênh phụ: 1 bài đã đăng');
    expect(text).toContain(`1. Khuyến mãi <b>lớn</b> (Trang chính, 1.234 lượt tương tác): https://crove.example/o/cua-hang-a/social/${POST}`);
    expect(text).toContain('Bài đăng không thành công: 7 bài');
    expect(text).toContain('- và 6 bài khác');
    expect(text).toContain('- Thứ Hai 26/10: 2 bài');
    expect(text).toContain('- Thứ Ba 27/10: chưa có bài');
    expect(text).toContain('- Kênh phụ: Thứ Năm 29/10, Thứ Bảy 31/10');
    expect(text).toContain('Mở Crove: https://crove.example/o/cua-hang-a/social');
    expect(text).toContain('Cài đặt thông báo: https://crove.example/o/cua-hang-a/social/notifications');
    expect(text).not.toContain('chờ bạn duyệt');
    // The HTML escapes what members wrote.
    expect(mail?.html).toContain('Khuyến mãi &lt;b&gt;lớn&lt;/b&gt;');
    expect(mail?.html).toContain('Cửa hàng &lt;A&gt;');
    expect(mail?.html).not.toContain('<b>lớn</b>');
    expect(mail?.html).toContain(`href="https://crove.example/o/cua-hang-a/social/${POST}"`);
  });

  it('names the product it was given, and lists the reviews only when there are some', async () => {
    const mail = await render({ ...base, review: { total: 2, items: [{ text: 'Chờ duyệt', path: `/o/cua-hang-a/social/${POST}` }] } }, 'Sổ Xanh');
    expect(mail?.text).toContain('trên Sổ Xanh');
    expect(mail?.text).toContain('Mở Sổ Xanh: ');
    expect(mail?.text).toContain('Thư này được gửi từ Sổ Xanh cho Cửa hàng <A>');
    expect(mail?.text).not.toContain('Crove');
    expect(mail?.text).toContain('Bài đang chờ bạn duyệt: 2 bài');
    expect(mail?.text).toContain(`- Chờ duyệt: https://crove.example/o/cua-hang-a/social/${POST}`);
    expect(mail?.text).toContain('- và 1 bài khác');
    expect((await render({ ...base, review: { total: 0, items: [] } }))?.text).not.toContain('chờ bạn duyệt');
  });

  it('keeps a placeholder a member wrote as text', async () => {
    const mail = await render({ ...base, org: 'Tiệm {brand}', last: { ...base.last, channels: [{ name: '{org}', provider: 'x', published: 1, failed: 0 }] } });
    expect(mail?.text).toContain('Bản tin tuần của Tiệm {brand}');
    expect(mail?.text).toContain('- {org}: 1 bài đã đăng');
  });

  it('refuses links outside the org Social pages and merge data of another shape', async () => {
    const bad = [
      { ...base, home: 'https://evil.example/o/a/social' },
      { ...base, home: '//evil.example' },
      { ...base, settings: '/o/cua-hang-a/settings' },
      { ...base, last: { ...base.last, top: [{ ...base.last.top[0], path: '/o/cua-hang-a/social/new?next=//evil.example' }] } },
      { ...base, review: { total: 1, items: [{ text: 'x', path: `/o/cua-hang-a/social/${POST}/../../admin` }] } },
      { ...base, week: '2026-W54' },
      { ...base, last: { ...base.last, published: -1 } },
      { ...base, next: undefined },
      null,
    ];
    for (const payload of bad) expect(await render(payload)).toBeNull();
  });
});
