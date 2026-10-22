// The abuse-limit mail (#675, template kernel.usage.deferred): the org used its daily limit of one metric, so the
// items that came after wait for the next day's budget. For the org's owners, at most once per metric in any 24 hours,
// with a link to the org's Inbox. Nothing is dropped; the mail says so.
import type { MailTemplate, MailTemplateInput } from './mail-queue.ts';

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
const oneLine = (text: string) => text.replace(/[\r\n\t]+/g, ' ').trim();
// An app path the mail names: the org's Inbox, nothing else.
const PATH = /^\/o\/[a-z0-9][a-z0-9-]{0,62}\/inbox$/;

const WHAT: Record<string, string> = {
  inbound_emails: 'số email nhận hóa đơn',
  attachment_bytes: 'dung lượng tệp đính kèm',
  extraction_pages: 'số trang đọc chứng từ',
  ai_cost: 'chi phí AI',
};

// The time the items are tried again, in Vietnam time, as "14:05 ngày 21/10/2026".
function vietnamTime(iso: string): string | null {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  const parts = new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric', hourCycle: 'h23' }).formatToParts(at);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('hour')}:${part('minute')} ngày ${part('day')}/${part('month')}/${part('year')}`;
}

export async function renderUsageDeferredMail(input: MailTemplateInput): Promise<{ subject: string; text: string; html: string } | null> {
  const { metric, org, retryAt, path } = input.payload;
  if (typeof metric !== 'string' || !Object.hasOwn(WHAT, metric)) return null;
  if (typeof org !== 'string' || typeof path !== 'string' || !PATH.test(path) || typeof retryAt !== 'string') return null;
  const when = vietnamTime(retryAt);
  if (!when) return null;
  const url = `${input.publicUrl.replace(/\/+$/, '')}${path}`;
  const lead = `Tổ chức ${oneLine(org)} đã dùng hết hạn mức ${WHAT[metric]} trong 24 giờ.`;
  const keep = `Các thư và chứng từ đến sau được giữ lại, không bị mất, và sẽ được xử lý tiếp từ khoảng ${when} (giờ Việt Nam).`;
  const footer = `Hạn mức do người vận hành ${input.brand} đặt để một tổ chức không dùng hết tài nguyên chung. Nếu tổ chức cần hạn mức cao hơn, hãy liên hệ người vận hành.`;
  const lines = [lead, keep, `Mở Inbox: ${url}`, '', footer];
  const html = `<!doctype html><html lang="vi"><body style="font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#18181b;line-height:1.5">
<p style="margin:0 0 12px">${escapeHtml(lead)}</p>
<p style="margin:0 0 12px">${escapeHtml(keep)}</p>
<p style="margin:16px 0"><a href="${escapeHtml(url)}" style="color:#b91c1c">Mở Inbox</a></p>
<p style="font-size:12px;color:#71717a">${escapeHtml(footer)}</p>
</body></html>`;
  return { subject: [...oneLine(input.subject ?? lead)].slice(0, 200).join(''), text: lines.join('\n'), html };
}

export const usageDeferredMailTemplate: MailTemplate = { render: renderUsageDeferredMail };
