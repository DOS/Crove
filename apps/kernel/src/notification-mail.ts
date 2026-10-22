// The Social notification mail (#579, template social.notification): what happened, to which post or channel, and a
// link that opens it in Crove. The subject was written with the notification; nothing secret is in the mail.
import type { MailTemplate, MailTemplateInput } from './mail-queue.ts';

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
const oneLine = (text: string) => text.replace(/[\r\n\t]+/g, ' ').trim();
// An app path the notification names: the org's post or channels page, or a new post for a channel (a queue running
// low, #1079), nothing else.
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const PATH = new RegExp(`^/o/[a-z0-9][a-z0-9-]{0,62}/social/(channels|${UUID}|new\\?channel=${UUID})$`);

const LEAD: Record<string, string> = {
  review_requested: 'Có một bài đang chờ bạn duyệt.',
  decided_approved: 'Bài của bạn đã được duyệt.',
  decided_changes_requested: 'Người duyệt đề nghị sửa bài của bạn.',
  decided_rejected: 'Bài của bạn bị từ chối.',
  failed: 'Một bài đăng không thành công.',
  // A planned takedown (#861) that did not happen.
  failed_removal: '{brand} chưa tự gỡ được một bài đã hẹn giờ gỡ; bài vẫn còn trên kênh. Hãy gỡ lại từ trang bài viết hoặc gỡ trực tiếp trên nền tảng.',
  needs_attention: 'Một bài đăng cần bạn xử lý trước khi đăng tiếp.',
  channel_expired: 'Một kênh đã hết hạn kết nối; bài lên lịch trên kênh này sẽ chờ đến khi bạn kết nối lại.',
  mention: 'Một thành viên đã nhắc đến bạn trong bình luận nội bộ của một bài.',
  queue_low: 'Hàng đợi đăng bài của một kênh sắp hết bài: có ngày đăng sắp tới chưa có bài nào. Hãy viết thêm bài và xếp vào hàng đợi để kênh không bị bỏ trống.',
};

export async function renderNotificationMail(input: MailTemplateInput): Promise<{ subject: string; text: string; html: string } | null> {
  const { kind, org, post, channel, decision, removal, days, path } = input.payload;
  if (typeof kind !== 'string' || typeof org !== 'string' || typeof path !== 'string' || !PATH.test(path)) return null;
  const lead = LEAD[kind === 'decided' ? `decided_${typeof decision === 'string' ? decision : ''}` : kind === 'failed' && removal === 'scheduled' ? 'failed_removal' : kind];
  if (!lead) return null;
  const leadText = lead.replaceAll('{brand}', input.brand);
  const url = `${input.publicUrl.replace(/\/+$/, '')}${path}`;
  const open = path.endsWith('/channels') ? 'Mở trang kênh' : path.includes('/social/new?') ? 'Viết bài cho kênh này' : 'Mở bài viết';
  // The window the warning looks at (#1079).
  const ahead = kind === 'queue_low' && typeof days === 'string' && /^\d{1,2}$/.test(days) ? `${input.brand} kiểm tra các ngày đăng trong ${days} ngày tới.` : null;
  const lines = [
    leadText,
    ahead,
    typeof post === 'string' && post ? `Bài: ${oneLine(post)}` : null,
    typeof channel === 'string' && channel ? `Kênh: ${oneLine(channel)}` : null,
    `${open}: ${url}`,
    '',
    `Thư này được gửi từ ${input.brand} cho ${oneLine(org)}. Bạn có thể tắt email trong mục Thông báo của Social.`,
  ].filter((l) => l !== null);
  const html = `<!doctype html><html lang="vi"><body style="font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#18181b;line-height:1.5">
<p style="margin:0 0 12px">${escapeHtml(leadText)}</p>
${typeof post === 'string' && post ? `<p style="margin:0 0 4px"><strong>Bài:</strong> ${escapeHtml(oneLine(post))}</p>` : ''}
${typeof channel === 'string' && channel ? `<p style="margin:0 0 4px"><strong>Kênh:</strong> ${escapeHtml(oneLine(channel))}</p>` : ''}
${ahead ? `<p style="margin:0 0 4px">${escapeHtml(ahead)}</p>` : ''}
<p style="margin:16px 0"><a href="${escapeHtml(url)}" style="color:#b91c1c">${escapeHtml(open)}</a></p>
<p style="font-size:12px;color:#71717a">Thư này được gửi từ ${escapeHtml(input.brand)} cho ${escapeHtml(oneLine(org))}. Bạn có thể tắt email trong mục Thông báo của Social.</p>
</body></html>`;
  return { subject: [...oneLine(input.subject ?? leadText)].slice(0, 200).join(''), text: lines.join('\n'), html };
}

export const notificationMailTemplate: MailTemplate = { render: renderNotificationMail };
