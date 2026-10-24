// The Social notification mail (#579, template social.notification): what happened, to which post or channel, and a
// link that opens it in Crove. The subject was written with the notification; nothing secret is in the mail.
import type { MailTemplate, MailTemplateInput } from './mail-queue.ts';

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
const oneLine = (text: string) => text.replace(/[\r\n\t]+/g, ' ').trim();
// An app path the notification names: the org's post or channels page, a new post for a channel (a queue running
// low, #1079), or the posts assigned to the reader (a bulk assignment, #1359), nothing else.
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const PATH = new RegExp(`^/o/[a-z0-9][a-z0-9-]{0,62}/social(/(channels|${UUID}|new\\?channel=${UUID})|\\?assignee=me)$`);

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
  post_outperforming: 'Một bài bạn viết hoặc được giao đang được tương tác nhiều hơn hẳn mức thường lệ. Đây là lúc nên đẩy thêm cho bài, trả lời bình luận hoặc dùng lại nội dung này cho bài sau.',
  // An assignment and its due date (#1359).
  assigned: 'Bạn vừa được giao một bài: hãy viết, sửa hoặc đưa bài đi duyệt để kịp đăng.',
  assigned_many: 'Bạn vừa được giao {count} bài: hãy viết, sửa hoặc đưa các bài này đi duyệt để kịp đăng.',
  assignment_due_soon: 'Một bài được giao cho bạn sẽ đến hạn trong vòng 24 giờ tới mà vẫn chưa đăng.',
  assignment_due_overdue: 'Một bài được giao cho bạn đã quá hạn mà vẫn chưa đăng. Hãy hoàn thiện bài hoặc trao đổi lại hạn với người giao.',
};
// A due date as the dispatch wrote it (#1359): "14:30 26/10/2026".
const DUE = /^\d{2}:\d{2} \d{2}\/\d{2}\/\d{4}$/;
// A bulk assignment's count of posts (#1359).
const COUNT = /^[1-9]\d{0,2}$/;
// A ratio as the notification wrote it (#1132), shown the Vietnamese way (2,5); at least `min`, else none.
const RATIO = /^\d{1,4}(\.\d)?$/;
const ratioVi = (value: unknown, min = 0): string | null => (typeof value === 'string' && RATIO.test(value) && Number(value) >= min ? value.replace('.', ',') : null);

export async function renderNotificationMail(input: MailTemplateInput): Promise<{ subject: string; text: string; html: string } | null> {
  const { kind, org, post, channel, decision, removal, days, ratio, reach, stage, due, count, path } = input.payload;
  if (typeof kind !== 'string' || typeof org !== 'string' || typeof path !== 'string' || !PATH.test(path)) return null;
  // A new post for a channel is a low queue's link only (#1095).
  if (path.includes('/social/new?') && kind !== 'queue_low') return null;
  // The posts assigned to the reader are a bulk assignment's link only (#1359).
  const mine = path.endsWith('/social?assignee=me');
  if (mine && kind !== 'assigned') return null;
  const many = kind === 'assigned' && typeof count === 'string' && COUNT.test(count);
  const key =
    kind === 'decided'
      ? `decided_${typeof decision === 'string' ? decision : ''}`
      : kind === 'failed' && removal === 'scheduled'
        ? 'failed_removal'
        : kind === 'assignment_due'
          ? `assignment_due_${typeof stage === 'string' ? stage : ''}`
          : many
            ? 'assigned_many'
            : kind;
  const lead = LEAD[key];
  if (!lead) return null;
  const leadText = lead.replaceAll('{brand}', input.brand).replaceAll('{count}', many ? (count as string) : '');
  const url = `${input.publicUrl.replace(/\/+$/, '')}${path}`;
  const open = path.endsWith('/channels') ? 'Mở trang kênh' : path.includes('/social/new?') ? 'Viết bài cho kênh này' : mine ? 'Xem các bài được giao cho bạn' : 'Mở bài viết';
  // When the assigned post is due (#1359).
  const dueLine = kind === 'assignment_due' && typeof due === 'string' && DUE.test(due) ? `Hạn: ${due}` : null;
  // The window the warning looks at (#1079).
  const ahead = kind === 'queue_low' && typeof days === 'string' && /^\d{1,2}$/.test(days) ? `${input.brand} kiểm tra các ngày đăng trong ${days} ngày tới.` : null;
  // How much better than usual (#1132): against the channel's recent posts (up to 30), a day after it went out.
  const times = kind === 'post_outperforming' ? ratioVi(ratio) : null;
  // Reach only when it is at least the usual: "gấp 0,5 lần" would read as more.
  const reachTimes = kind === 'post_outperforming' ? ratioVi(reach, 1) : null;
  if (kind === 'post_outperforming' && !times) return null;
  const better = times
    ? `Một ngày sau khi đăng, bài đã được tương tác gấp ${times} lần mức thường lệ của các bài gần đây trên kênh${reachTimes ? `; lượt tiếp cận gấp ${reachTimes} lần` : ''}.`
    : null;
  const lines = [
    leadText,
    ahead,
    better,
    typeof post === 'string' && post ? `Bài: ${oneLine(post)}` : null,
    dueLine,
    typeof channel === 'string' && channel ? `Kênh: ${oneLine(channel)}` : null,
    `${open}: ${url}`,
    '',
    `Thư này được gửi từ ${input.brand} cho ${oneLine(org)}. Bạn có thể tắt email trong mục Thông báo của Social.`,
  ].filter((l) => l !== null);
  const html = `<!doctype html><html lang="vi"><body style="font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#18181b;line-height:1.5">
<p style="margin:0 0 12px">${escapeHtml(leadText)}</p>
${typeof post === 'string' && post ? `<p style="margin:0 0 4px"><strong>Bài:</strong> ${escapeHtml(oneLine(post))}</p>` : ''}
${dueLine ? `<p style="margin:0 0 4px">${escapeHtml(dueLine)}</p>` : ''}
${typeof channel === 'string' && channel ? `<p style="margin:0 0 4px"><strong>Kênh:</strong> ${escapeHtml(oneLine(channel))}</p>` : ''}
${ahead ? `<p style="margin:0 0 4px">${escapeHtml(ahead)}</p>` : ''}
${better ? `<p style="margin:0 0 4px">${escapeHtml(better)}</p>` : ''}
<p style="margin:16px 0"><a href="${escapeHtml(url)}" style="color:#b91c1c">${escapeHtml(open)}</a></p>
<p style="font-size:12px;color:#71717a">Thư này được gửi từ ${escapeHtml(input.brand)} cho ${escapeHtml(oneLine(org))}. Bạn có thể tắt email trong mục Thông báo của Social.</p>
</body></html>`;
  return { subject: [...oneLine(input.subject ?? leadText)].slice(0, 200).join(''), text: lines.join('\n'), html };
}

export const notificationMailTemplate: MailTemplate = { render: renderNotificationMail };
