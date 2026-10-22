// Asking a client company for its missing purchase invoices (issue #669). The tax portal's purchase list (#465) shows,
// per VAT period, the invoices the tax authority has that Crove lacks ('missing'). From that list the accountant sends
// the company one email listing them, and may turn on a monthly reminder:
// - finance.missing_invoices.request (owners, admins, members; R1) queues one mail for a period's missing invoices to
//   the org's contact email (kernel.mail.contact.queue: the kernel mail pipeline, with its log row and suppression
//   check; the worker sends it). At most one request per period an hour.
// - finance.missing_invoices.reminder.set (owners, admins, members; R1) turns the monthly reminder on (a day of the
//   month, 1 to 28) or off.
// - finance.missing_invoices.remind (system) is what the worker runs on that day: one mail listing what is still
//   missing in the periods of the last 12 months, or, when nothing is, no mail and the reminder turns itself off.
// - finance.missing_invoices.status (every role): the contact email, the reminder and the mails sent so far.
// The mail asks the company to reply, or to forward the seller's mail, to the org's inbound address (its Reply-To), so
// the invoices land in the Inbox like any other mail with an invoice (renderMissingInvoiceMail below, run by the
// worker). The client company is the org itself: Crove keeps one org per company the firm keeps books for.
import { sql } from 'kysely';
import { z } from 'zod';
import { zVatPeriod } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand, defineQuery, type QueryContext } from '@crove/kernel-runtime';
import { money } from '@crove/l10n-vn';
import { reconcilePeriod } from './portal-list.ts';
import { vatPeriod } from './domain/vat-return.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const EDITORS: readonly MemberRole[] = ['owner', 'admin', 'member'];

export const MISSING_INVOICE_REQUEST_SOURCE = 'finance.missing_invoices.request';
export const MISSING_INVOICE_REMIND_SOURCE = 'finance.missing_invoices.remind';
// The template of both mails (the worker renders it with renderMissingInvoiceMail).
export const MISSING_INVOICE_TEMPLATE = 'finance.missing_invoices';
export const MISSING_INVOICE_ACTOR = { type: 'system' as const, component: 'finance.missing_invoices' };
// Invoices listed in one mail; the mail says how many more there are.
export const MISSING_INVOICES_PER_MAIL = 150;
// The merge data stays this far under the kernel's cap on it (MAIL_PAYLOAD_MAX_BYTES, 64 KiB), so a mail with long
// seller names is cut short rather than refused.
export const MISSING_INVOICE_PAYLOAD_BYTES = 48 * 1024;
// A seller's name as the mail shows it (the template's oneLine cuts it there too).
const SELLER_NAME_SHOWN = 200;
// A second request for the same period within this long is refused, so a double click mails the company once.
export const REQUEST_COOLDOWN_MS = 60 * 60 * 1000;
// The reminder covers the periods that ended within this many days.
export const REMINDER_LOOKBACK_DAYS = 366;
export const REMINDER_DAY_MAX = 28;
const VN_OFFSET_MS = 7 * 60 * 60 * 1000;

const zItem = z.object({
  sellerName: z.string().max(500),
  sellerTaxCode: z.string().max(20),
  template: z.string().max(20).nullable(),
  series: z.string().max(20),
  number: z.string().max(20),
  issueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  total: z.string().max(40).nullable(),
  currency: z.string().regex(/^[A-Z]{3}$/),
});
const zPeriodItems = z.object({ period: zVatPeriod, count: z.number().int().nonnegative(), items: z.array(zItem) });
// The merge data of both mails, as stored on the mail's row (mail_message.payload).
export const zMissingInvoiceMail = z.object({
  kind: z.enum(['request', 'reminder']),
  orgName: z.string().max(200),
  // The period a request is for (none on a reminder).
  requestPeriod: zVatPeriod.optional(),
  periods: z.array(zPeriodItems).max(40),
  count: z.number().int().nonnegative(),
});
export type MissingInvoiceMail = z.infer<typeof zMissingInvoiceMail>;
type Item = z.infer<typeof zItem>;

// "tháng 9/2026" or "quý 3/2026".
export function periodLabel(period: string): string {
  const [year, part] = period.split('-');
  if (part?.startsWith('Q')) return `quý ${part.slice(1)}/${year}`;
  return `tháng ${Number(part)}/${year}`;
}

// The invoices of a period the portal lists and Crove lacks, in the reconciliation's order.
async function missingIn(ctx: QueryContext, period: string): Promise<Item[]> {
  const { reconciliation } = await reconcilePeriod(ctx, period);
  return reconciliation.items.flatMap((i) =>
    i.outcome === 'missing' && i.portal
      ? [
          {
            sellerName: i.portal.sellerName.slice(0, SELLER_NAME_SHOWN),
            sellerTaxCode: i.portal.sellerTaxCode,
            template: i.portal.template,
            series: i.portal.series,
            number: i.portal.number,
            issueDate: i.portal.issueDate,
            total: i.portal.total,
            currency: i.portal.currency,
          },
        ]
      : [],
  );
}

export type MissingItem = Item;
const bytesOf = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');

// The mail's merge data: every period with its count, and the invoices in order while there are at most
// MISSING_INVOICES_PER_MAIL of them and the data stays within MISSING_INVOICE_PAYLOAD_BYTES. count covers them all, so
// the mail says how many it left out.
export function mailPayload(kind: 'request' | 'reminder', orgName: string, periods: { period: string; items: Item[] }[], requestPeriod?: string): MissingInvoiceMail {
  const count = periods.reduce((n, p) => n + p.items.length, 0);
  const base = { kind, orgName: orgName.slice(0, 200), ...(requestPeriod ? { requestPeriod } : {}), count };
  const shown = periods.map(({ period, items }) => ({ period, count: items.length, items: [] as Item[] }));
  let bytes = bytesOf({ ...base, periods: shown });
  let room = MISSING_INVOICES_PER_MAIL;
  for (const [i, { items }] of periods.entries()) {
    for (const raw of items) {
      const item = { ...raw, sellerName: raw.sellerName.slice(0, SELLER_NAME_SHOWN) };
      const size = bytesOf(item) + 1;
      if (room === 0 || bytes + size > MISSING_INVOICE_PAYLOAD_BYTES) return { ...base, periods: shown };
      shown[i]?.items.push(item);
      bytes += size;
      room -= 1;
    }
  }
  return { ...base, periods: shown };
}

// The missing invoices of the reminder's periods, in period order. An invoice in a month and in its quarter (both
// imported) is listed once, under the first period. A period too large to reconcile (PERIOD_TOO_LARGE) is skipped and
// named in `skipped`; the others still count.
export async function collectMissing(
  periods: readonly string[],
  load: (period: string) => Promise<Item[]>,
): Promise<{ missing: { period: string; items: Item[] }[]; skipped: string[] }> {
  const seen = new Set<string>();
  const missing: { period: string; items: Item[] }[] = [];
  const skipped: string[] = [];
  for (const period of periods) {
    let items: Item[];
    try {
      items = await load(period);
    } catch (error) {
      if (error instanceof DomainError && error.code === 'PERIOD_TOO_LARGE') {
        skipped.push(period);
        continue;
      }
      throw error;
    }
    const fresh = items.filter((item) => {
      const key = `${item.sellerTaxCode}|${item.template ?? ''}|${item.series}|${item.number}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (fresh.length > 0) missing.push({ period, items: fresh });
  }
  return { missing, skipped };
}

// The start of the current month in Vietnam, as an instant.
function vnMonthStart(now: Date): Date {
  const local = new Date(now.getTime() + VN_OFFSET_MS);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) - VN_OFFSET_MS);
}

function vnToday(now: Date): string {
  return new Date(now.getTime() + VN_OFFSET_MS).toISOString().slice(0, 10);
}

interface Queued {
  messageId: string;
  status: 'queued' | 'suppressed';
}

export const missingInvoicesRequest = defineCommand({
  name: 'finance.missing_invoices.request',
  input: z.object({ period: zVatPeriod }),
  risk: 'R1',
  access: EDITORS,
  handler: async (ctx, input) => {
    vatPeriod(input.period);
    // One request per period at a time: concurrent clicks wait here, then see the first one's mail.
    await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`finance.missing_invoices:${ctx.orgId}:${input.period}`}, 0))`.execute(ctx.trx);
    const recent = await ctx.trx
      .selectFrom('crove_kernel.mail_message')
      .select('id')
      .where('org_id', '=', ctx.orgId)
      .where('source', '=', MISSING_INVOICE_REQUEST_SOURCE)
      .where('created_at', '>', new Date(ctx.now.getTime() - REQUEST_COOLDOWN_MS))
      .where(sql<boolean>`payload ->> 'requestPeriod' = ${input.period}`)
      .limit(1)
      .executeTakeFirst();
    if (recent) {
      throw new DomainError('REQUEST_TOO_SOON', 409, `Đã gửi đề nghị cho ${periodLabel(input.period)} trong vòng một giờ qua; hãy đợi rồi gửi lại`);
    }
    const items = await missingIn(ctx, input.period);
    if (items.length === 0) throw new DomainError('NOTHING_MISSING', 409, `Không còn hóa đơn mua vào nào thiếu trong ${periodLabel(input.period)}`);
    const tenant = await ctx.trx.selectFrom('crove_kernel.tenant').select('name').where('org_id', '=', ctx.orgId).executeTakeFirstOrThrow();
    const queued = await ctx.run<Queued>('kernel.mail.contact.queue', {
      source: MISSING_INVOICE_REQUEST_SOURCE,
      templateKey: MISSING_INVOICE_TEMPLATE,
      subject: `Đề nghị bổ sung hóa đơn đầu vào ${periodLabel(input.period)}`,
      payload: mailPayload('request', tenant.name, [{ period: input.period, items }], input.period),
    });
    await ctx.activity(
      'kernel.mail_message',
      queued.messageId,
      'missing_invoices.requested',
      queued.status === 'suppressed'
        ? `Không gửi được đề nghị bổ sung hóa đơn ${periodLabel(input.period)}: email liên hệ đang bị chặn`
        : `Gửi email đề nghị công ty bổ sung ${items.length} hóa đơn mua vào còn thiếu, ${periodLabel(input.period)}`,
    );
    ctx.audit({ period: input.period, count: items.length, message_id: queued.messageId, status: queued.status });
    return { messageId: queued.messageId, status: queued.status, count: items.length };
  },
});

export const missingInvoicesReminderSet = defineCommand({
  name: 'finance.missing_invoices.reminder.set',
  input: z.object({ day: z.number().int().min(1).max(REMINDER_DAY_MAX).nullable() }),
  risk: 'R1',
  access: EDITORS,
  handler: async (ctx, input) => {
    const tenant = await ctx.trx
      .selectFrom('crove_kernel.tenant')
      .select(['contact_email', 'missing_invoice_reminder_day'])
      .where('org_id', '=', ctx.orgId)
      .executeTakeFirstOrThrow();
    if (input.day !== null && !tenant.contact_email) {
      throw new DomainError('CONTACT_EMAIL_REQUIRED', 409, 'Công ty chưa có email liên hệ; chủ sở hữu hoặc quản trị viên nhập email này trong Cài đặt');
    }
    if (tenant.missing_invoice_reminder_day !== input.day) {
      await ctx.trx.updateTable('crove_kernel.tenant').set({ missing_invoice_reminder_day: input.day }).where('org_id', '=', ctx.orgId).execute();
      await ctx.activity(
        'kernel.tenant',
        ctx.orgId,
        'missing_invoices.reminder_set',
        input.day === null ? 'Tắt email nhắc hằng tháng về hóa đơn mua vào còn thiếu' : `Bật email nhắc vào ngày ${input.day} hằng tháng về hóa đơn mua vào còn thiếu`,
      );
    }
    ctx.audit({ day: input.day, previous: tenant.missing_invoice_reminder_day });
    return { day: input.day };
  },
});

export type RemindResult =
  | { action: 'off' | 'already' | 'no_contact' | 'stopped' }
  | { action: 'skipped'; skipped: string[] }
  | { action: 'sent'; messageId: string; status: 'queued' | 'suppressed'; count: number };

// The monthly reminder of one org, run by the worker on the reminder's day. Once a month at most; nothing when the
// reminder is off or the org has no contact email. Covers every period of the last REMINDER_LOOKBACK_DAYS with a read
// portal list. When nothing is missing any more, no mail goes and the reminder turns itself off.
export const missingInvoicesRemind = defineCommand({
  name: 'finance.missing_invoices.remind',
  input: z.object({}),
  risk: 'R1',
  access: 'system',
  handler: async (ctx): Promise<RemindResult> => {
    if (ctx.actor.type !== 'system') throw new DomainError('FORBIDDEN', 403, 'Chỉ tiến trình hệ thống mới gửi được email nhắc');
    await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`finance.missing_invoices:${ctx.orgId}:remind`}, 0))`.execute(ctx.trx);
    const tenant = await ctx.trx
      .selectFrom('crove_kernel.tenant')
      .select(['name', 'contact_email', 'missing_invoice_reminder_day'])
      .where('org_id', '=', ctx.orgId)
      .executeTakeFirstOrThrow();
    if (tenant.missing_invoice_reminder_day === null) return { action: 'off' };
    const sent = await ctx.trx
      .selectFrom('crove_kernel.mail_message')
      .select('id')
      .where('org_id', '=', ctx.orgId)
      .where('source', '=', MISSING_INVOICE_REMIND_SOURCE)
      .where('created_at', '>=', vnMonthStart(ctx.now))
      .limit(1)
      .executeTakeFirst();
    // Once a month: a run that sent nothing (every period too large to reconcile) counts too, so the sweep does not
    // run it again all day.
    const ran = await ctx.trx
      .selectFrom('crove_kernel.audit_event')
      .select('id')
      .where('org_id', '=', ctx.orgId)
      .where('command', '=', 'finance.missing_invoices.remind')
      .where('outcome', '=', 'ok')
      .where('occurred_at', '>=', vnMonthStart(ctx.now))
      .where(sql<boolean>`detail ? 'skipped'`)
      .limit(1)
      .executeTakeFirst();
    if (sent || ran) return { action: 'already' };
    if (!tenant.contact_email) return { action: 'no_contact' };
    const today = vnToday(ctx.now);
    const cutoff = new Date(Date.parse(`${today}T00:00:00Z`) - REMINDER_LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10);
    const listed = await ctx.trx
      .selectFrom('crove_finance.portal_invoice_list')
      .select('period')
      .distinct()
      .where('org_id', '=', ctx.orgId)
      .where('status', '=', 'done')
      .where('removed_at', 'is', null)
      .execute();
    const periods = listed
      .map((l) => l.period)
      .filter((p) => {
        const { from, to } = vatPeriod(p);
        return to >= cutoff && from <= today;
      })
      .sort();
    const { missing, skipped } = await collectMissing(periods, (period) => missingIn(ctx, period));
    if (missing.length === 0 && skipped.length > 0) {
      // Nothing could be checked: the reminder stays on; this run's audit row keeps it from running again this month.
      ctx.audit({ skipped });
      return { action: 'skipped', skipped };
    }
    if (missing.length === 0) {
      await ctx.trx.updateTable('crove_kernel.tenant').set({ missing_invoice_reminder_day: null }).where('org_id', '=', ctx.orgId).execute();
      await ctx.activity('kernel.tenant', ctx.orgId, 'missing_invoices.reminder_stopped', 'Dừng email nhắc hằng tháng vì không còn hóa đơn mua vào nào thiếu');
      ctx.audit({ stopped: true });
      return { action: 'stopped' };
    }
    const payload = mailPayload('reminder', tenant.name, missing);
    const queued = await ctx.run<Queued>('kernel.mail.contact.queue', {
      source: MISSING_INVOICE_REMIND_SOURCE,
      templateKey: MISSING_INVOICE_TEMPLATE,
      subject: 'Nhắc bổ sung hóa đơn đầu vào còn thiếu',
      payload,
    });
    await ctx.activity(
      'kernel.mail_message',
      queued.messageId,
      'missing_invoices.reminded',
      queued.status === 'suppressed' ? 'Không gửi được email nhắc hằng tháng: email liên hệ đang bị chặn' : `Gửi email nhắc công ty bổ sung ${payload.count} hóa đơn mua vào còn thiếu`,
    );
    ctx.audit({ count: payload.count, periods: missing.map((m) => m.period), message_id: queued.messageId, status: queued.status, ...(skipped.length > 0 ? { skipped } : {}) });
    return { action: 'sent', messageId: queued.messageId, status: queued.status, count: payload.count };
  },
});

export const MISSING_INVOICE_HISTORY_LIMIT = 20;

export interface MissingInvoiceStatus {
  contactEmail: string | null;
  reminderDay: number | null;
  // The latest requests and reminders, newest first.
  mails: {
    id: string;
    kind: 'request' | 'reminder';
    status: string;
    periods: string[];
    count: number | null;
    createdAt: string;
    sentAt: string | null;
  }[];
}

export const missingInvoicesStatus = defineQuery({
  name: 'finance.missing_invoices.status',
  input: z.object({}),
  access: ALL,
  handler: async (ctx): Promise<MissingInvoiceStatus> => {
    const tenant = await ctx.trx
      .selectFrom('crove_kernel.tenant')
      .select(['contact_email', 'missing_invoice_reminder_day'])
      .where('org_id', '=', ctx.orgId)
      .executeTakeFirstOrThrow();
    const rows = await ctx.trx
      .selectFrom('crove_kernel.mail_message')
      .select(['id', 'source', 'status', 'payload', 'created_at', 'sent_at'])
      .where('org_id', '=', ctx.orgId)
      .where('source', 'in', [MISSING_INVOICE_REQUEST_SOURCE, MISSING_INVOICE_REMIND_SOURCE])
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(MISSING_INVOICE_HISTORY_LIMIT)
      .execute();
    return {
      contactEmail: tenant.contact_email,
      reminderDay: tenant.missing_invoice_reminder_day,
      mails: rows.map((r) => {
        // The merge data is dropped 30 days after the mail's final status (mail retention); the row still counts.
        const parsed = zMissingInvoiceMail.safeParse(r.payload);
        return {
          id: r.id,
          kind: r.source === MISSING_INVOICE_REQUEST_SOURCE ? ('request' as const) : ('reminder' as const),
          status: r.status,
          periods: parsed.success ? parsed.data.periods.map((p) => p.period) : [],
          count: parsed.success ? parsed.data.count : null,
          createdAt: new Date(r.created_at).toISOString(),
          sentAt: r.sent_at ? new Date(r.sent_at).toISOString() : null,
        };
      }),
    };
  },
});

// ---------------------------------------------------------------------------------------------------------------------
// The mail (rendered by the worker from the stored merge data)
// ---------------------------------------------------------------------------------------------------------------------

export interface RenderedMail {
  text: string;
  html: string;
  replyTo?: string;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}

// Names come from the portal's sheet and the org: one line, no control or format characters, bounded.
function oneLine(value: string, max = 200): string {
  const flat = value
    .replace(/\p{Cf}+/gu, '')
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ')
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

// 1980000 -> "1.980.000 đồng"; other currencies keep their code ("1.234,5 USD").
export function formatAmount(value: string, currency: string): string {
  const fixed = money(value).toFixed();
  const negative = fixed.startsWith('-');
  const [whole = '0', fraction] = (negative ? fixed.slice(1) : fixed).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const amount = `${negative ? '-' : ''}${grouped}${fraction ? `,${fraction}` : ''}`;
  return currency === 'VND' ? `${amount} đồng` : `${amount} ${currency}`;
}

function formatDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

function invoiceLine(item: Item): string {
  const symbol = `${item.template ?? ''}${item.series}`;
  const total = item.total === null ? '' : `, tổng tiền ${formatAmount(item.total, item.currency)}`;
  return `${oneLine(item.sellerName) || 'Người bán'} (MST ${item.sellerTaxCode}): hóa đơn số ${item.number}, ký hiệu ${symbol}, ngày ${formatDate(item.issueDate)}${total}`;
}

/**
 * The request or reminder mail from its stored merge data. replyTo: the org's inbound address when the deployment
 * receives mail; the client then replies or forwards the invoices there, and they reach the Inbox. brand: the product
 * name users see (BRAND_NAME, #1040).
 */
export function renderMissingInvoiceMail(raw: unknown, context: { replyTo: string | null; brand?: string }): RenderedMail {
  const brand = context.brand ?? 'Crove';
  const mail = zMissingInvoiceMail.parse(raw);
  const org = oneLine(mail.orgName);
  const shown = mail.periods.reduce((n, p) => n + p.items.length, 0);
  const more = mail.count - shown;
  const intro =
    mail.kind === 'request'
      ? `Khi đối chiếu với dữ liệu hóa đơn điện tử trên cổng của cơ quan thuế (hoadondientu.gdt.gov.vn), bộ phận kế toán chưa nhận được ${mail.count} hóa đơn đầu vào dưới đây của ${periodLabel(mail.requestPeriod ?? mail.periods[0]?.period ?? '')}.`
      : `Bộ phận kế toán xin nhắc lại: đến nay vẫn còn ${mail.count} hóa đơn đầu vào đã có trên cổng của cơ quan thuế (hoadondientu.gdt.gov.vn) nhưng chưa được gửi cho chúng tôi.`;
  const how = context.replyTo
    ? `Để kê khai thuế đúng hạn, Quý công ty vui lòng gửi tệp XML (kèm bản PDF nếu có) của các hóa đơn này bằng cách trả lời thư này, hoặc chuyển tiếp thư của người bán tới địa chỉ ${context.replyTo}.`
    : 'Để kê khai thuế đúng hạn, Quý công ty vui lòng gửi tệp XML (kèm bản PDF nếu có) của các hóa đơn này bằng cách trả lời thư này.';
  const already = 'Nếu đã gửi hóa đơn nào trong số này, Quý công ty vui lòng bỏ qua hóa đơn đó.';
  const footer =
    mail.kind === 'reminder'
      ? `Thư nhắc này được gửi tự động hằng tháng qua ${brand} cho đến khi bộ phận kế toán nhận đủ hóa đơn.`
      : `Thư này được gửi tự động qua ${brand} theo yêu cầu của bộ phận kế toán.`;
  const groups = mail.periods.filter((p) => p.items.length > 0);
  const heading = (p: (typeof groups)[number]) => {
    const label = periodLabel(p.period);
    return `${label.charAt(0).toUpperCase()}${label.slice(1)} (${p.count} hóa đơn)`;
  };
  const moreLine = more > 0 ? `Và ${more} hóa đơn khác; bộ phận kế toán sẽ gửi danh sách đầy đủ nếu Quý công ty cần.` : null;

  const text = [
    `Kính gửi Quý công ty ${org},`,
    '',
    intro,
    '',
    ...groups.flatMap((p) => [...(mail.kind === 'reminder' ? [heading(p)] : []), ...p.items.map((item, i) => `${i + 1}. ${invoiceLine(item)}`), '']),
    ...(moreLine ? [moreLine, ''] : []),
    how,
    already,
    '',
    'Trân trọng,',
    'Bộ phận kế toán',
    '',
    footer,
  ].join('\n');

  const rows = (items: Item[]) =>
    items
      .map(
        (item) =>
          `<tr><td style="padding:6px 8px;border-bottom:1px solid #d0d7de">${escapeHtml(oneLine(item.sellerName) || 'Người bán')}<br><span style="color:#57606a;font-size:13px">MST ${escapeHtml(item.sellerTaxCode)}</span></td>` +
          `<td style="padding:6px 8px;border-bottom:1px solid #d0d7de;white-space:nowrap">${escapeHtml(item.number)}<br><span style="color:#57606a;font-size:13px">${escapeHtml(`${item.template ?? ''}${item.series}`)}</span></td>` +
          `<td style="padding:6px 8px;border-bottom:1px solid #d0d7de;white-space:nowrap">${escapeHtml(formatDate(item.issueDate))}</td>` +
          `<td style="padding:6px 8px;border-bottom:1px solid #d0d7de;white-space:nowrap;text-align:right">${item.total === null ? '' : escapeHtml(formatAmount(item.total, item.currency))}</td></tr>`,
      )
      .join('');
  const table = (items: Item[]) =>
    `<table style="border-collapse:collapse;width:100%;font-size:14px"><thead><tr>` +
    ['Người bán', 'Số / ký hiệu', 'Ngày', 'Tổng tiền'].map((h, i) => `<th style="padding:6px 8px;border-bottom:2px solid #d0d7de;text-align:${i === 3 ? 'right' : 'left'}">${h}</th>`).join('') +
    `</tr></thead><tbody>${rows(items)}</tbody></table>`;
  const html = `<!doctype html>
<html lang="vi"><body style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1f2328">
<p>Kính gửi Quý công ty <strong>${escapeHtml(org)}</strong>,</p>
<p>${escapeHtml(intro)}</p>
${groups.map((p) => `${mail.kind === 'reminder' ? `<h3 style="font-size:15px;margin:16px 0 4px">${escapeHtml(heading(p))}</h3>` : ''}${table(p.items)}`).join('\n')}
${moreLine ? `<p>${escapeHtml(moreLine)}</p>` : ''}
<p>${escapeHtml(how)}</p>
<p>${escapeHtml(already)}</p>
<p>Trân trọng,<br>Bộ phận kế toán</p>
<p style="font-size:13px;color:#57606a">${escapeHtml(footer)}</p>
</body></html>`;
  return { text, html, ...(context.replyTo ? { replyTo: context.replyTo } : {}) };
}
