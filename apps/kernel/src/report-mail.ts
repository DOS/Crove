// The scheduled client report mail (#704, template social.report): the schedule's name, the period, the headline
// numbers the run stored and a link to the full report. The link is minted when the mail goes out
// (social.report_schedule.mint_link), one per recipient, so its token is never in the mail queue. A report of exactly
// one month carries a line of the org's monthly goals (#1056), as the run worked them out.
import type { MailTemplate, MailTemplateInput } from './mail-queue.ts';

interface ReportMailData {
  name: string;
  // The org that sends it (#735), named in the footer; absent from mails queued before.
  orgName: string | null;
  periodStart: string;
  periodEnd: string;
  timeZone: string;
  test: boolean;
  posts: number;
  reach: number;
  impressions: number;
  engagement: number;
  // Absent from mails queued before goals, and when the period is not one month or there are no goals.
  goals: { month: string; items: GoalLine[] } | null;
}

interface GoalLine {
  channel: string | null;
  metric: string;
  target: number;
  actual: number | null;
  status: string;
}

const GOAL_LABELS: Readonly<Record<string, string>> = {
  posts: 'Bài đã đăng',
  reach: 'Lượt tiếp cận',
  impressions: 'Lượt hiển thị',
  engagement: 'Lượt tương tác',
  followersGained: 'Người theo dõi mới',
};
const GOAL_STATUS: Readonly<Record<string, string>> = {
  met: 'đạt',
  missed: 'chưa đạt',
  on_track: 'đúng tiến độ',
  behind: 'chậm tiến độ',
  no_data: 'chưa có số liệu',
};
const count = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

// The goals the run stored, or null when there are none or they are not in the expected shape.
function goalsOf(value: unknown): ReportMailData['goals'] {
  if (typeof value !== 'object' || value === null) return null;
  const { month, items } = value as { month?: unknown; items?: unknown };
  if (typeof month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || !Array.isArray(items)) return null;
  const lines: GoalLine[] = [];
  for (const item of items.slice(0, 20)) {
    if (typeof item !== 'object' || item === null) return null;
    const { channel, metric, target, actual, status } = item as Record<string, unknown>;
    if (typeof metric !== 'string' || !(metric in GOAL_LABELS) || typeof status !== 'string' || !(status in GOAL_STATUS)) return null;
    if (!count(target) || target <= 0 || (actual !== null && !count(actual))) return null;
    if (channel !== null && typeof channel !== 'string') return null;
    lines.push({ channel: channel === null ? null : oneLine(channel).slice(0, 120), metric, target, actual: actual as number | null, status });
  }
  return lines.length === 0 ? null : { month, items: lines };
}

/** The progress line of a report mail (#1056): how many goals were met, then each goal with its count and target. */
export function goalLine(goals: NonNullable<ReportMailData['goals']>): string {
  const n = new Intl.NumberFormat('vi-VN');
  const [year, month] = goals.month.split('-');
  const met = goals.items.filter((g) => g.status === 'met').length;
  const parts = goals.items.map((g) => `${g.channel ? `${g.channel}: ` : ''}${GOAL_LABELS[g.metric]} ${g.actual === null ? '-' : n.format(g.actual)}/${n.format(g.target)} (${GOAL_STATUS[g.status]})`);
  return `Mục tiêu tháng ${month}/${year}: đạt ${met}/${goals.items.length} - ${parts.join(', ')}`;
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
const oneLine = (text: string) => text.replace(/[\r\n\t]+/g, ' ').trim();

function dataOf(payload: Readonly<Record<string, unknown>>): ReportMailData | null {
  const { name, orgName, periodStart, periodEnd, timeZone, test, posts, reach, impressions, engagement } = payload;
  const numbers = [posts, reach, impressions, engagement];
  if (typeof name !== 'string' || typeof periodStart !== 'string' || typeof periodEnd !== 'string' || typeof timeZone !== 'string') return null;
  if (!numbers.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0)) return null;
  if (Number.isNaN(Date.parse(periodStart)) || Number.isNaN(Date.parse(periodEnd))) return null;
  return { goals: goalsOf(payload.goals), name: oneLine(name), orgName: typeof orgName === 'string' && orgName.trim() ? oneLine(orgName).slice(0, 200) : null, periodStart, periodEnd, timeZone, test: test === true, posts: posts as number, reach: reach as number, impressions: impressions as number, engagement: engagement as number };
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
    ...(data.goals ? ['', goalLine(data.goals)] : []),
    '',
    `Xem báo cáo đầy đủ: ${url}`,
    `Liên kết dùng được đến ngày ${until}.`,
    '',
    data.orgName ? `Thư này được ${data.orgName} gửi tự động qua Crove theo lịch gửi báo cáo.` : 'Thư này được gửi tự động từ Crove theo lịch gửi báo cáo.',
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
${data.goals ? `<p style="margin:0 0 16px">${escapeHtml(goalLine(data.goals))}</p>` : ''}
<p style="margin:0 0 8px"><a href="${escapeHtml(url)}" style="color:#b91c1c">Xem báo cáo đầy đủ</a></p>
<p style="margin:0 0 16px;font-size:13px;color:#52525b">Liên kết dùng được đến ngày ${escapeHtml(until)}.</p>
<p style="font-size:12px;color:#71717a">${data.orgName ? `Thư này được ${escapeHtml(data.orgName)} gửi tự động qua Crove theo lịch gửi báo cáo.` : 'Thư này được gửi tự động từ Crove theo lịch gửi báo cáo.'}</p>
</body></html>`;
  return { subject, text, html };
}

export const reportMailTemplate: MailTemplate = { render: renderReportMail };
