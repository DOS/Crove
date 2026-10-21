// The proposal reminder mail (#676, template kernel.proposal.reminder): a proposal has waited the days its org set,
// for the people who may approve it (remind) or for the owners (escalate), with a link that opens it in the Inbox.
// The subject was written with the mail; nothing secret is in it.
import type { MailTemplate, MailTemplateInput } from './mail-queue.ts';

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
const oneLine = (text: string) => text.replace(/[\r\n\t]+/g, ' ').trim();
// An app path the mail names: one proposal of the org's Inbox, nothing else.
const PATH = /^\/o\/[a-z0-9][a-z0-9-]{0,62}\/inbox\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const LEAD: Record<string, (days: number) => string> = {
  remind: (days) => `Một đề xuất đang chờ bạn duyệt đã ${days} ngày.`,
  escalate: (days) => `Một đề xuất của tổ chức chưa được ai duyệt sau ${days} ngày.`,
};

export async function renderProposalReminderMail(input: MailTemplateInput): Promise<{ subject: string; text: string; html: string } | null> {
  const { stage, org, title, days, path } = input.payload;
  if (typeof stage !== 'string' || typeof org !== 'string' || typeof path !== 'string' || !PATH.test(path)) return null;
  if (typeof days !== 'number' || !Number.isInteger(days) || days < 0) return null;
  const lead = Object.hasOwn(LEAD, stage) ? LEAD[stage]?.(days) : undefined;
  if (!lead) return null;
  const url = `${input.publicUrl.replace(/\/+$/, '')}${path}`;
  const name = typeof title === 'string' && title ? [...oneLine(title)].slice(0, 200).join('') : null;
  const footer = `Thư này được gửi từ Crove cho ${oneLine(org)}, theo cài đặt nhắc duyệt của tổ chức.`;
  const lines = [lead, name ? `Đề xuất: ${name}` : null, `Mở đề xuất: ${url}`, '', footer].filter((l) => l !== null);
  const html = `<!doctype html><html lang="vi"><body style="font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#18181b;line-height:1.5">
<p style="margin:0 0 12px">${escapeHtml(lead)}</p>
${name ? `<p style="margin:0 0 4px"><strong>Đề xuất:</strong> ${escapeHtml(name)}</p>` : ''}
<p style="margin:16px 0"><a href="${escapeHtml(url)}" style="color:#b91c1c">Mở đề xuất</a></p>
<p style="font-size:12px;color:#71717a">${escapeHtml(footer)}</p>
</body></html>`;
  return { subject: [...oneLine(input.subject ?? lead)].slice(0, 200).join(''), text: lines.join('\n'), html };
}

export const proposalReminderMailTemplate: MailTemplate = { render: renderProposalReminderMail };
