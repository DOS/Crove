// The scheduled client report mail (#704) with the org's white-label branding (#1053): the agency's name in the header
// and the footer, its accent on the header's rule, no "Crove" when the org hides it, and exactly the mail of before
// when the org has no branding. The accent goes into a style attribute, so only #rrggbb gets there.
import { describe, expect, it } from 'vitest';
import { renderReportMail } from '../src/report-mail.ts';

const TOKEN = 'b'.repeat(43);

function mail(brand: unknown, payload: Record<string, unknown> = {}) {
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
