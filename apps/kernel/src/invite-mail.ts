// The invite email (issue #129). Sent by the API right after kernel.member.invite.create commits, because only that
// response holds the raw token: the database keeps its SHA-256, and the outbox payload is stored as plain JSON, so a
// worker could never build the link. The trade-off: delivery is synchronous with a few retries inside the request,
// not a durable job. If every attempt fails the failure is logged (error codes only) and the answer is unchanged:
// the inviter always sees the one-time link and can pass it on, and a new invite for the same email replaces the old
// one and sends a new mail.
//
// The mail is the same whether or not the email has an account, and says nothing about one.
import { deliver, type Delivery, type DeliverOptions, type Mailer, type OutboundMail } from './mail.ts';

export type InviteRole = 'admin' | 'member' | 'viewer';

const ROLE_LABEL: Record<InviteRole, string> = { admin: 'quản trị', member: 'thành viên', viewer: 'chỉ xem' };

export interface InviteMailInput {
  to: string;
  orgName: string;
  inviterName: string | null;
  inviterEmail: string;
  role: InviteRole;
  expiresAt: string;
  // The accept path from the command (`/-/invite#<token>`), joined to PUBLIC_URL here.
  acceptPath: string;
  // The Message-ID of the invite's mail_message row (#538), so the mail and its row name the same message.
  messageId?: string;
}

export type SendInviteMail = (invite: InviteMailInput) => Promise<Delivery>;

// Operator configuration only (plan §7.7): the link never takes its host from the request.
export function acceptUrl(publicUrl: string, acceptPath: string): string {
  return `${publicUrl.replace(/\/+$/, '')}${acceptPath}`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}

// Names come from users (org name, display name): one line, no control characters, bounded.
function oneLine(value: string, max = 120): string {
  // Control, line separator and format characters (bidi overrides could reorder a subject among them).
  const flat = value
    .replace(/\p{Cf}+/gu, '')
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ')
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const EXPIRY_PARTS = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Ho_Chi_Minh',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

// "10:00 ngày 23/10/2026 (giờ Việt Nam)", the same on every ICU build.
export function formatExpiry(iso: string): string {
  const parts = Object.fromEntries(EXPIRY_PARTS.formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
  return `${parts.hour}:${parts.minute} ngày ${parts.day}/${parts.month}/${parts.year} (giờ Việt Nam)`;
}

export function inviteMail(input: InviteMailInput, publicUrl: string): OutboundMail {
  const url = acceptUrl(publicUrl, input.acceptPath);
  const org = oneLine(input.orgName);
  const inviterEmail = oneLine(input.inviterEmail, 320);
  const inviter = input.inviterName ? `${oneLine(input.inviterName)} (${inviterEmail})` : inviterEmail;
  const role = ROLE_LABEL[input.role];
  const expires = formatExpiry(input.expiresAt);
  const subject = `Lời mời tham gia ${org} trên Crove`;
  const text = [
    'Xin chào,',
    '',
    `${inviter} mời bạn tham gia tổ chức "${org}" trên Crove với vai trò ${role}.`,
    '',
    'Mở liên kết sau để xem và chấp nhận lời mời:',
    url,
    '',
    `Hãy đăng nhập hoặc tạo tài khoản bằng đúng địa chỉ email này (${input.to}); lời mời chỉ dành cho email được mời. Nếu chưa có tài khoản, hãy tạo tài khoản sau khi mở liên kết này, trên cùng thiết bị.`,
    `Liên kết dùng được một lần và hết hạn lúc ${expires}.`,
    '',
    'Nếu bạn không mong đợi lời mời này, hãy bỏ qua email. Bạn chỉ vào tổ chức khi tự chấp nhận lời mời.',
  ].join('\n');
  const html = `<!doctype html>
<html lang="vi"><body style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1f2328">
<p>Xin chào,</p>
<p>${escapeHtml(inviter)} mời bạn tham gia tổ chức <strong>${escapeHtml(org)}</strong> trên Crove với vai trò ${escapeHtml(role)}.</p>
<p><a href="${escapeHtml(url)}" style="display:inline-block;padding:10px 16px;background:#1f6feb;color:#ffffff;text-decoration:none;border-radius:6px">Xem và chấp nhận lời mời</a></p>
<p style="font-size:13px;color:#57606a">Nếu nút không mở được, hãy dán liên kết này vào trình duyệt:<br><span style="word-break:break-all">${escapeHtml(url)}</span></p>
<p>Hãy đăng nhập hoặc tạo tài khoản bằng đúng địa chỉ email này (${escapeHtml(input.to)}); lời mời chỉ dành cho email được mời. Nếu chưa có tài khoản, hãy tạo tài khoản sau khi mở liên kết này, trên cùng thiết bị. Liên kết dùng được một lần và hết hạn lúc ${escapeHtml(expires)}.</p>
<p style="font-size:13px;color:#57606a">Nếu bạn không mong đợi lời mời này, hãy bỏ qua email. Bạn chỉ vào tổ chức khi tự chấp nhận lời mời.</p>
</body></html>`;
  return { to: input.to, subject, text, html, ...(input.messageId ? { messageId: input.messageId } : {}) };
}

export function createInviteMailSender(mailer: Mailer, publicUrl: string, options: DeliverOptions = {}): SendInviteMail {
  // async: a template error becomes a rejected promise, never a synchronous throw past the caller's handler.
  return async (invite) => deliver(mailer, inviteMail(invite, publicUrl), { label: 'invite mail', ...options });
}
