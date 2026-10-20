// The scheduled client report mail (#704, template social.report): the schedule's name, the period, the headline
// numbers the run stored and a link to the full report. The link is minted when the mail goes out
// (social.report_schedule.mint_link), one per recipient, so its token is never in the mail queue.
import type { MailTemplate, MailTemplateInput } from './mail-queue.ts';

interface ReportMailData {
  name: string;
  periodStart: string;
  periodEnd: string;
  timeZone: string;
  test: boolean;
  posts: number;
  reach: number;
  impressions: number;
  engagement: number;
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
const oneLine = (text: string) => text.replace(/[\r\n\t]+/g, ' ').trim();

function dataOf(payload: Readonly<Record<string, unknown>>): ReportMailData | null {
  const { name, periodStart, periodEnd, timeZone, test, posts, reach, impressions, engagement } = payload;
  const numbers = [posts, reach, impressions, engagement];
  if (typeof name !== 'string' || typeof periodStart !== 'string' || typeof periodEnd !== 'string' || typeof timeZone !== 'string') return null;
  if (!numbers.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0)) return null;
  if (Number.isNaN(Date.parse(periodStart)) || Number.isNaN(Date.parse(periodEnd))) return null;
  return { name: oneLine(name), periodStart, periodEnd, timeZone, test: test === true, posts: posts as number, reach: reach as number, impressions: impressions as number, engagement: engagement as number };
}

function day(iso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('vi-VN', { timeZone, day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(iso));
  } catch {
    return new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(iso));
  }
}

export async function renderReportMail(input: MailTemplateInput): Promise<{ subject: string; text: string; html: string } | null> {
  const data = dataOf(input.payload);
  if (!data) return null;
  const link = await input.execute<{ token: string; expiresAt: string }>('social.report_schedule.mint_link', { messageId: input.messageId });
  const url = `${input.publicUrl.replace(/\/+$/, '')}/-/report#${link.token}`;
  const from = day(data.periodStart, data.timeZone);
  // The period ends at a midnight; its last day is the one before.
  const to = day(new Date(Date.parse(data.periodEnd) - 1).toISOString(), data.timeZone);
  const n = new Intl.NumberFormat('vi-VN');
  const rows: [string, number][] = [
    ['Bài đã đăng', data.posts],
    ['Lượt tiếp cận', data.reach],
    ['Lượt hiển thị', data.impressions],
    ['Lượt tương tác', data.engagement],
  ];
  const until = day(link.expiresAt, data.timeZone);
  const subject = oneLine(`${data.test ? '[Thử] ' : ''}${input.subject ?? `Báo cáo mạng xã hội: ${data.name}`}`).slice(0, 200);
  const text = [
    data.test ? 'Đây là thư thử của lịch gửi báo cáo.' : null,
    data.name,
    `Kỳ báo cáo: ${from} - ${to}`,
    '',
    ...rows.map(([label, value]) => `${label}: ${n.format(value)}`),
    '',
    `Xem báo cáo đầy đủ: ${url}`,
    `Liên kết dùng được đến ngày ${until}.`,
    '',
    'Thư này được gửi tự động từ Crove theo lịch gửi báo cáo.',
  ]
    .filter((line) => line !== null)
    .join('\n');
  const html = `<!doctype html><html lang="vi"><body style="font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#18181b;line-height:1.5">
${data.test ? '<p style="color:#52525b">Đây là thư thử của lịch gửi báo cáo.</p>' : ''}
<h1 style="font-size:18px;margin:0 0 4px">${escapeHtml(data.name)}</h1>
<p style="margin:0 0 16px;color:#52525b">Kỳ báo cáo: ${escapeHtml(from)} - ${escapeHtml(to)}</p>
<table style="border-collapse:collapse;margin:0 0 16px">
${rows.map(([label, value]) => `<tr><td style="padding:4px 16px 4px 0">${escapeHtml(label)}</td><td style="padding:4px 0;font-weight:600;text-align:right">${escapeHtml(n.format(value))}</td></tr>`).join('\n')}
</table>
<p style="margin:0 0 8px"><a href="${escapeHtml(url)}" style="color:#b91c1c">Xem báo cáo đầy đủ</a></p>
<p style="margin:0 0 16px;font-size:13px;color:#52525b">Liên kết dùng được đến ngày ${escapeHtml(until)}.</p>
<p style="font-size:12px;color:#71717a">Thư này được gửi tự động từ Crove theo lịch gửi báo cáo.</p>
</body></html>`;
  return { subject, text, html };
}

export const reportMailTemplate: MailTemplate = { render: renderReportMail };
