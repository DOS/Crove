// The scheduled client report mail (#704) with the monthly goals line (#1056): a mail queued with goals carries one line
// of them in text and HTML, escaped; one queued without them, or with goals in another shape, reads as before.
import { describe, expect, it } from 'vitest';
import { goalLine, renderReportMail } from '../src/report-mail.ts';

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
