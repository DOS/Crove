// The scheduled client report mail (#704) with the org's white-label branding (#1053): the agency's name in the header
// and the footer, its accent on the header's rule, no "Crove" when the org hides it, and exactly the mail of before
// when the org has no branding. The accent goes into a style attribute, so only #rrggbb gets there. With the monthly
// goals line (#1056): a mail queued with goals carries one line of them in text and HTML, escaped; one queued without
// them, or with goals in another shape, reads as before.
import { describe, expect, it } from 'vitest';
import { goalLine, renderReportMail } from '../src/report-mail.ts';

const TOKEN = 'b'.repeat(43);

function mail(brand: unknown, payload: Record<string, unknown> = {}, product = 'Crove') {
  return renderReportMail({
    messageId: '00000000-0000-4000-8000-000000000001',
    subject: null,
    payload: {
      name: 'Báo cáo tuần',
      orgName: 'Công ty Sao Mai',
      periodStart: '2026-10-11T17:00:00.000Z',
      periodEnd: '2026-10-18T17:00:00.000Z',
      timeZone: 'Asia/Ho_Chi_Minh',
      test: false,
      posts: 3,
      reach: 1200,
      impressions: 3400,
      engagement: 56,
      ...payload,
    },
    publicUrl: 'https://crove.example/',
    brand: product,
    inboundAddress: null,
    execute: async <T,>(command: string) => {
      expect(command).toBe('social.report_schedule.mint_link');
      return { token: TOKEN, expiresAt: '2026-11-01T00:00:00.000Z', ...(brand === undefined ? {} : { brand }) } as T;
    },
  });
}

describe('report mail branding (#1053)', () => {
  it('is the mail of before without branding (or with an array where the brand should be): no header line, the Crove footer', async () => {
    for (const brand of [undefined, null, [], ['Sao Mai Agency', '#1d4ed8']]) {
      const out = await mail(brand);
      expect(out).not.toBeNull();
      expect(out?.html).not.toContain('border-bottom:3px solid');
      expect(out?.html).toContain('Thư này được Công ty Sao Mai gửi tự động qua Crove theo lịch gửi báo cáo.');
      expect(out?.text.split('\n')[0]).toBe('Báo cáo tuần');
      expect(out?.text).toContain('qua Crove');
      expect(out?.html).toContain(`https://crove.example/-/report#${TOKEN}`);
    }
    const anonymous = await mail(null, { orgName: undefined });
    expect(anonymous?.html).toContain('Thư này được gửi tự động từ Crove theo lịch gửi báo cáo.');
  });

  // #1040: the footer names the product by BRAND_NAME.
  it('names the product by BRAND_NAME in the footer', async () => {
    const out = await mail(null, {}, 'Tên Mới');
    expect(out?.html).toContain('Thư này được Công ty Sao Mai gửi tự động qua Tên Mới theo lịch gửi báo cáo.');
    expect(`${out?.subject}${out?.text}${out?.html}`).not.toContain('Crove');
  });

  it('puts the agency name and accent in the header and the name in the footer', async () => {
    const out = await mail({ name: 'Sao Mai Agency', accent: '#1d4ed8', hideCrove: false });
    expect(out?.html).toContain('border-bottom:3px solid #1d4ed8">Sao Mai Agency</p>');
    expect(out?.html).toContain('Thư này được Sao Mai Agency gửi tự động qua Crove theo lịch gửi báo cáo.');
    expect(out?.text.split('\n')[0]).toBe('Sao Mai Agency');
  });

  it('says nothing of Crove when the org hides it, and falls back to the org name and a neutral rule', async () => {
    const out = await mail({ name: null, accent: null, hideCrove: true });
    expect(out?.html).toContain('border-bottom:3px solid #e4e4e7">Công ty Sao Mai</p>');
    expect(out?.html).toContain('Thư này được Công ty Sao Mai gửi tự động theo lịch gửi báo cáo.');
    expect(out?.html).not.toContain('Crove');
    expect(out?.text).not.toContain('Crove');
    // The link still goes to the deployment's report page.
    expect(out?.html).toContain(`href="https://crove.example/-/report#${TOKEN}"`);
  });

  it('escapes the name and keeps anything but #rrggbb out of the style attribute', async () => {
    const out = await mail({ name: '<img src=x onerror=alert(1)>\r\nBcc: x@evil.example', accent: 'red;background:url(https://evil.example/)', hideCrove: true });
    expect(out?.html).not.toContain('<img');
    expect(out?.html).toContain('&lt;img src=x onerror=alert(1)&gt; Bcc: x@evil.example');
    expect(out?.html).not.toContain('url(');
    expect(out?.html).toContain('border-bottom:3px solid #e4e4e7"');
    // One line in the text part too.
    expect(out?.text.split('\n')[0]).toBe('<img src=x onerror=alert(1)> Bcc: x@evil.example');
    expect(out?.subject).toBe('Báo cáo mạng xã hội: Báo cáo tuần');
    const upper = await mail({ name: 'A', accent: '#1D4ED8', hideCrove: false });
    expect(upper?.html).toContain('border-bottom:3px solid #e4e4e7"');
  });
});

const base = {
  name: 'Báo cáo tháng',
  orgName: 'Agency A',
  periodStart: '2026-08-31T17:00:00.000Z',
  periodEnd: '2026-09-30T17:00:00.000Z',
  timeZone: 'Asia/Ho_Chi_Minh',
  test: false,
  posts: 12,
  reach: 45_000,
  impressions: 60_000,
  engagement: 900,
};
const goals = {
  month: '2026-09',
  items: [
    { channel: null, metric: 'posts', target: 12, actual: 12, status: 'met' },
    { channel: null, metric: 'reach', target: 50_000, actual: 45_000, status: 'missed' },
    { channel: 'Trang <Facebook>', metric: 'followersGained', target: 100, actual: null, status: 'no_data' },
  ],
};

function render(payload: Record<string, unknown>) {
  return renderReportMail({
    messageId: '00000000-0000-4000-8000-000000000001',
    subject: null,
    payload,
    publicUrl: 'https://crove.example',
    brand: 'Crove',
    inboundAddress: null,
    execute: async <T>() => ({ token: 'a'.repeat(43), expiresAt: '2026-11-15T00:00:00.000Z' }) as T,
  });
}

describe('report mail goals line (#1056)', () => {
  it('words the goals of the month: how many were met, then each with its count and target', () => {
    expect(goalLine(goals)).toBe(
      'Mục tiêu tháng 09/2026: đạt 1/3 - Bài đã đăng 12/12 (đạt), Lượt tiếp cận 45.000/50.000 (chưa đạt), Trang <Facebook>: Người theo dõi mới -/100 (chưa có số liệu)',
    );
  });

  it('puts the line in the text and, escaped, in the HTML', async () => {
    const mail = await render({ ...base, goals });
    expect(mail?.text).toContain('Mục tiêu tháng 09/2026: đạt 1/3 - Bài đã đăng 12/12 (đạt)');
    expect(mail?.html).toContain('Trang &lt;Facebook&gt;: Người theo dõi mới');
    expect(mail?.html).not.toContain('Trang <Facebook>');
  });

  it('reads as before without goals or with goals in another shape', async () => {
    const before = await render(base);
    expect(before?.text).not.toContain('Mục tiêu');
    expect(before?.html).not.toContain('Mục tiêu');
    for (const bad of [
      { month: '2026-13', items: goals.items },
      { month: '2026-09', items: [] },
      { month: '2026-09', items: [{ channel: null, metric: 'posts', target: 0, actual: 1, status: 'met' }] },
      { month: '2026-09', items: [{ channel: null, metric: 'secret', target: 1, actual: 1, status: 'met' }] },
      { month: '2026-09', items: [{ channel: null, metric: 'posts', target: 1, actual: 'x', status: 'met' }] },
      'goals',
    ]) {
      const mail = await render({ ...base, goals: bad });
      expect(mail?.text).toBe(before?.text);
    }
  });
});
