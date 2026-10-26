// The weekly digest mail (#1104, template social.digest): last week's posts per channel, the three with the most
// engagement and the failures; this week's posts per day, the queue days still empty, and for owners and admins the
// posts waiting for their review. The command (social.digest.send) wrote the merge data for one member, from the
// channels they may use; this only checks its shape and lays it out. Every link is an app path of the org's Social
// pages, checked here before the public URL is put in front of it; nothing secret is in the mail.
import { z } from 'zod';
import type { MailTemplate, MailTemplateInput } from './mail-queue.ts';

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
const oneLine = (text: string) => text.replace(/[\r\n\t]+/g, ' ').trim();

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const SLUG = '[a-z0-9][a-z0-9-]{0,62}';
const zDate = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/);
const zText = z.string().max(400);
const zCount = z.number().int().min(0).max(1_000_000_000_000);
const zPostPath = z.string().regex(new RegExp(`^/o/${SLUG}/social/${UUID}$`));
const zLine = z.object({ text: zText, channel: zText, path: zPostPath });

const zDigest = z.object({
  org: zText,
  week: z.string().regex(/^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/),
  lastWeek: z.object({ from: zDate, to: zDate }),
  thisWeek: z.object({ from: zDate, to: zDate }),
  home: z.string().regex(new RegExp(`^/o/${SLUG}/social$`)),
  settings: z.string().regex(new RegExp(`^/o/${SLUG}/social/notifications$`)),
  last: z.object({
    published: zCount,
    channels: z.array(z.object({ name: zText, provider: z.string().max(32), published: zCount, failed: zCount })).max(20),
    top: z.array(zLine.extend({ engagement: zCount })).max(3),
    failures: z.object({ total: zCount, items: z.array(zLine).max(5) }),
  }),
  next: z.object({
    days: z.array(z.object({ date: zDate, planned: zCount })).max(7),
    emptyQueueDays: z.array(z.object({ channel: zText, dates: z.array(zDate).max(8) })).max(20),
  }),
  review: z.object({ total: zCount, items: z.array(z.object({ text: zText, path: zPostPath })).max(5) }).nullable(),
});

// ISO weekday of a calendar date (1 = Monday).
const WEEKDAYS = ['Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy', 'Chủ nhật'];
const weekdayOf = (date: string) => WEEKDAYS[(new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7] ?? '';
const dayMonth = (date: string) => `${date.slice(8, 10)}/${date.slice(5, 7)}`;
const number = (n: number) => new Intl.NumberFormat('vi-VN').format(n);
const posts = (n: number) => `${number(n)} bài`;

// The texts, with {brand} for the product name.
const TEXT = {
  title: 'Bản tin tuần của {org}',
  intro: 'Tóm tắt hoạt động mạng xã hội của {org} trên {brand}: tuần trước đã đăng những gì và tuần này đã lên lịch ra sao.',
  lastWeek: 'Tuần trước ({from} - {to})',
  published: 'Đã đăng: {n}',
  noneThere: 'Tuần trước không có bài nào được đăng.',
  channel: '{channel}: {published} đã đăng',
  channelFailed: '{channel}: {published} đã đăng, {failed} không thành công',
  top: 'Ba bài được tương tác nhiều nhất',
  engagement: '{n} lượt tương tác',
  failures: 'Bài đăng không thành công: {n}',
  more: 'và {n} bài khác',
  thisWeek: 'Tuần này ({from} - {to})',
  day: '{weekday} {date}: {n}',
  dayEmpty: '{weekday} {date}: chưa có bài',
  emptyDays: 'Ngày đăng còn trống trong hàng đợi',
  review: 'Bài đang chờ bạn duyệt: {n}',
  open: 'Mở {brand}',
  openPost: 'Mở bài',
  footer: 'Thư này được gửi từ {brand} cho {org}, mỗi sáng thứ Hai. Bạn có thể tắt bản tin hằng tuần trong mục Thông báo của Social.',
  settings: 'Cài đặt thông báo',
} as const;

const fill = (text: string, values: Readonly<Record<string, string>>) => text.replace(/\{(\w+)\}/g, (all, key: string) => values[key] ?? all);

export async function renderDigestMail(input: MailTemplateInput): Promise<{ subject: string; text: string; html: string } | null> {
  const parsed = zDigest.safeParse(input.payload);
  if (!parsed.success) return null;
  const d = parsed.data;
  const root = input.publicUrl.replace(/\/+$/, '');
  const url = (path: string) => `${root}${path}`;
  const org = oneLine(d.org);
  const t = (key: keyof typeof TEXT, values: Readonly<Record<string, string>> = {}) => fill(TEXT[key], { brand: input.brand, org, ...values });
  const range = (w: { from: string; to: string }) => ({ from: dayMonth(w.from), to: dayMonth(w.to) });

  // Each part as a heading and lines; a line may link to a post.
  type Line = { text: string; path?: string };
  const sections: { heading: string; lines: Line[] }[] = [];
  const last: Line[] = [];
  if (d.last.published === 0) last.push({ text: t('noneThere') });
  else last.push({ text: t('published', { n: posts(d.last.published) }) });
  for (const c of d.last.channels) {
    last.push({ text: c.failed > 0 ? t('channelFailed', { channel: oneLine(c.name), published: posts(c.published), failed: posts(c.failed) }) : t('channel', { channel: oneLine(c.name), published: posts(c.published) }) });
  }
  sections.push({ heading: t('lastWeek', range(d.lastWeek)), lines: last });
  if (d.last.top.length > 0) {
    sections.push({
      heading: t('top'),
      lines: d.last.top.map((p, i) => ({ text: `${i + 1}. ${oneLine(p.text) || '...'} (${oneLine(p.channel)}, ${t('engagement', { n: number(p.engagement) })})`, path: p.path })),
    });
  }
  if (d.last.failures.total > 0) {
    const rest = d.last.failures.total - d.last.failures.items.length;
    sections.push({
      heading: t('failures', { n: posts(d.last.failures.total) }),
      lines: [...d.last.failures.items.map((f) => ({ text: `${oneLine(f.text) || '...'} (${oneLine(f.channel)})`, path: f.path })), ...(rest > 0 ? [{ text: t('more', { n: number(rest) }) }] : [])],
    });
  }
  sections.push({
    heading: t('thisWeek', range(d.thisWeek)),
    lines: d.next.days.map((day) => ({ text: day.planned > 0 ? t('day', { weekday: weekdayOf(day.date), date: dayMonth(day.date), n: posts(day.planned) }) : t('dayEmpty', { weekday: weekdayOf(day.date), date: dayMonth(day.date) }) })),
  });
  if (d.next.emptyQueueDays.length > 0) {
    sections.push({
      heading: t('emptyDays'),
      lines: d.next.emptyQueueDays.map((q) => ({ text: `${oneLine(q.channel)}: ${q.dates.map((date) => `${weekdayOf(date)} ${dayMonth(date)}`).join(', ')}` })),
    });
  }
  if (d.review && d.review.total > 0) {
    const rest = d.review.total - d.review.items.length;
    sections.push({
      heading: t('review', { n: posts(d.review.total) }),
      lines: [...d.review.items.map((r) => ({ text: oneLine(r.text) || '...', path: r.path })), ...(rest > 0 ? [{ text: t('more', { n: number(rest) }) }] : [])],
    });
  }

  const text = [
    t('title'),
    '',
    t('intro'),
    ...sections.flatMap((s) => ['', s.heading, ...s.lines.map((l) => `- ${l.text}${l.path ? `: ${url(l.path)}` : ''}`)]),
    '',
    `${t('open')}: ${url(d.home)}`,
    '',
    t('footer'),
    `${t('settings')}: ${url(d.settings)}`,
  ].join('\n');
  const html = `<!doctype html><html lang="vi"><body style="font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#18181b;line-height:1.5">
<h1 style="font-size:18px;margin:0 0 8px">${escapeHtml(t('title'))}</h1>
<p style="margin:0 0 16px">${escapeHtml(t('intro'))}</p>
${sections
  .map(
    (s) => `<h2 style="font-size:15px;margin:16px 0 4px">${escapeHtml(s.heading)}</h2>
<ul style="margin:0;padding-left:20px">${s.lines.map((l) => `<li>${escapeHtml(l.text)}${l.path ? ` <a href="${escapeHtml(url(l.path))}" style="color:#b91c1c">${escapeHtml(TEXT.openPost)}</a>` : ''}</li>`).join('')}</ul>`,
  )
  .join('\n')}
<p style="margin:20px 0"><a href="${escapeHtml(url(d.home))}" style="color:#b91c1c">${escapeHtml(t('open'))}</a></p>
<p style="font-size:12px;color:#71717a">${escapeHtml(t('footer'))} <a href="${escapeHtml(url(d.settings))}" style="color:#71717a">${escapeHtml(t('settings'))}</a></p>
</body></html>`;
  return { subject: [...oneLine(input.subject ?? t('title'))].slice(0, 200).join(''), text, html };
}

export const digestMailTemplate: MailTemplate = { render: renderDigestMail };
