// The assisted purchase-invoice sync from the tax portal (issue #325, ADR-0036): the finance side. The API logs in to
// the portal with what the accountant typed (apps/kernel/src/portal-sync.ts) and fetches the period's purchase list as
// JSON; the rules that read it are in domain/portal-api.ts.
// - finance.portal_sync.call / call_end (owners, admins, members; R1) record each call to the portal in
//   crove_kernel.external_call before and after it is made (ADR-0025 decision 5): who, which step, the outcome class.
//   Never a password, a CAPTCHA answer, a token or a response body. The login step is refused after repeated wrong
//   passwords for the org, so Crove never locks the client's portal account by retrying.
// - finance.portal_sync.list (owners, admins, members; R1) files the stored JSON answer as a pending list of the
//   period, in place of the period's earlier synced lists (Excel imports stay), and asks the worker to record it, as
//   finance.portal_list.import does for an upload: the worker reads the evidence file (importPortalList), checks it with
//   the same rules and records the rows with finance.portal_list.record, the one write path for portal rows.
// - finance.portal_sync.xml_plan (same roles, read only) lists the invoices of a synced list the portal has an XML for
//   and Crove has no invoice for yet, minus those already fetched for that list.
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { z } from 'zod';
import { zId, zVatPeriod, MAX_PORTAL_LISTS_PER_PERIOD, PORTAL_XML_PER_SYNC } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand, defineQuery } from '@crove/kernel-runtime';
import { parseTaxCode } from '@crove/l10n-vn';
import { portalPeriodLock, reconcilePeriod } from './portal-list.ts';
import { defaultLegalEntityId, legalEntityNotAllowed } from './legal-entity.ts';
import { PORTAL_SYNC_CONTENT_TYPE, XML_CHECK_RESULT } from './domain/portal-api.ts';
import { vatPeriod } from './domain/vat-return.ts';

const EDITORS: readonly MemberRole[] = ['owner', 'admin', 'member'];
export const PORTAL_SYNC_TARGET = 'gdt_einvoice';
const KEY_PREFIX = 'finance.portal_sync:';
// Logins of one org that did not succeed (other than a refused CAPTCHA) since its last successful login, within a day,
// before the login step is refused (the portal locks an account after a few wrong passwords; Crove stops first), and
// logins of any outcome per org per hour.
export const PORTAL_WRONG_PASSWORD_LIMIT = 3;
export const PORTAL_LOGINS_PER_HOUR = 20;

// ---------------------------------------------------------------------------------------------------------------------
// The call ledger
// ---------------------------------------------------------------------------------------------------------------------

// Outcome classes of a call (never the portal's own text, which may echo what was sent).
export const PORTAL_CALL_ERRORS = ['WRONG_CAPTCHA', 'WRONG_PASSWORD', 'ACCOUNT_LOCKED', 'RATE_LIMITED', 'BLOCKED', 'UNAVAILABLE', 'BAD_ANSWER', 'SESSION_EXPIRED', 'TOO_LARGE', 'TOO_SLOW'] as const;
export type PortalCallError = (typeof PORTAL_CALL_ERRORS)[number];
const ERROR_KIND: Record<PortalCallError, 'token_expired' | 'permission' | 'bad_request' | 'rate_limited' | 'transient' | 'unknown'> = {
  WRONG_CAPTCHA: 'bad_request',
  WRONG_PASSWORD: 'permission',
  ACCOUNT_LOCKED: 'permission',
  RATE_LIMITED: 'rate_limited',
  BLOCKED: 'rate_limited',
  UNAVAILABLE: 'transient',
  BAD_ANSWER: 'unknown',
  SESSION_EXPIRED: 'token_expired',
  TOO_LARGE: 'bad_request',
  TOO_SLOW: 'transient',
};

// The key of an invoice's XML download within one synced list: the same invoice is fetched at most once per list.
export function xmlCallKey(listId: string, invoice: { sellerTaxCode: string; template: string | null; series: string; number: string }): string {
  return `${KEY_PREFIX}xml:${listId}:${invoice.sellerTaxCode}:${invoice.template ?? '-'}:${invoice.series}:${invoice.number}`;
}

const zInvoiceKey = z.object({
  sellerTaxCode: z.string().regex(/^[0-9]{10}(-[0-9]{3})?$|^[0-9]{12}$/),
  template: z.string().regex(/^[0-9A-Z]{1,11}$/).nullable(),
  series: z.string().regex(/^[0-9A-Z]{1,20}$/),
  number: z.string().regex(/^[0-9]{1,20}$/),
});

export const portalSyncCall = defineCommand({
  name: 'finance.portal_sync.call',
  input: z.discriminatedUnion('step', [
    z.object({ step: z.literal('captcha'), period: zVatPeriod }),
    z.object({ step: z.literal('login'), period: zVatPeriod, consent: z.literal(true) }),
    z.object({ step: z.literal('list'), period: zVatPeriod }),
    z.object({ step: z.literal('xml'), listId: zId, invoice: zInvoiceKey }),
  ]),
  risk: 'R1',
  access: EDITORS,
  handler: async (ctx, input) => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới lấy được dữ liệu từ cổng thuế');
    const userId = ctx.actor.userId;
    // The portal user name is the client's tax code; a purchase list is also told apart by it (checkPortalList).
    const tenant = await ctx.trx.selectFrom('crove_kernel.tenant').select('tax_code').where('org_id', '=', ctx.orgId).executeTakeFirst();
    const taxCode = parseTaxCode(tenant?.tax_code)?.normalized;
    if (!taxCode) {
      throw new DomainError('TAX_CODE_REQUIRED', 409, 'Hãy nhập mã số thuế của công ty trong Cài đặt trước khi lấy dữ liệu từ cổng thuế');
    }
    let key: string;
    if (input.step === 'xml') {
      key = xmlCallKey(input.listId, input.invoice);
    } else {
      vatPeriod(input.period);
      key = `${KEY_PREFIX}${input.step}:${input.period}:${userId}:${randomUUID()}`;
    }
    if (input.step === 'login') {
      // Serializes the org's logins, so two at once cannot both pass the count below.
      await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`finance.portal_sync.login:${ctx.orgId}`}, 0))`.execute(ctx.trx);
      // Fails closed: every login since the client's last successful one (within a day) that did not succeed counts,
      // unless the portal clearly refused only the CAPTCHA: a wrong password, a locked account, an answer Crove could not
      // read, an outage, and a login still in flight may all have reached the password check.
      const recent = await ctx.trx
        .selectFrom('crove_kernel.external_call')
        .select([
          sql<string>`count(*) FILTER (WHERE started_at > pg_catalog.now() - interval '1 hour')::text`.as('logins'),
          sql<string>`count(*) FILTER (WHERE state <> 'succeeded' AND coalesce(error_code, '') <> 'WRONG_CAPTCHA'
            AND started_at > coalesce((SELECT max(s.started_at) FROM crove_kernel.external_call s
              WHERE s.org_id = ${ctx.orgId} AND s.target = ${PORTAL_SYNC_TARGET} AND s.step = 'login' AND s.state = 'succeeded'), '-infinity'))::text`.as('failed'),
          sql<string>`count(*) FILTER (WHERE state = 'started' AND started_at > pg_catalog.now() - interval '1 minute')::text`.as('inflight'),
        ])
        .where('org_id', '=', ctx.orgId)
        .where('target', '=', PORTAL_SYNC_TARGET)
        .where('step', '=', 'login')
        .where('started_at', '>', sql<Date>`pg_catalog.now() - interval '1 day'`)
        .executeTakeFirstOrThrow();
      if (Number(recent.failed) >= PORTAL_WRONG_PASSWORD_LIMIT) {
        throw new DomainError(
          'PORTAL_PASSWORD_GUARD',
          429,
          `Đã có ${PORTAL_WRONG_PASSWORD_LIMIT} lần đăng nhập cổng thuế không thành công cho khách hàng này kể từ lần đăng nhập được gần nhất. Hệ thống tạm dừng đăng nhập để tài khoản của khách hàng không bị khóa; hãy kiểm tra lại mật khẩu với khách hàng (hoặc đăng nhập thử trên hoadondientu.gdt.gov.vn) rồi thử lại sau một ngày`,
        );
      }
      // Another login for this client is still waiting for the portal (perhaps on another API instance).
      if (Number(recent.inflight) > 0) {
        throw new DomainError('PORTAL_SYNC_BUSY', 409, 'Đang có một lượt đăng nhập cổng thuế khác cho khách hàng này; hãy đợi lượt đó xong');
      }
      if (Number(recent.logins) >= PORTAL_LOGINS_PER_HOUR) {
        throw new DomainError('RATE_LIMITED', 429, 'Đã đăng nhập cổng thuế cho khách hàng này nhiều lần trong một giờ qua; hãy thử lại sau');
      }
      // The accountant confirmed the client's consent to this use of its portal account.
      ctx.audit({ period: input.period, consent: true });
    } else {
      ctx.audit(input.step === 'xml' ? { list_id: input.listId } : { period: input.period });
    }
    // A download found started (the request that made it died) is a GET, safe to make again: it counts once more.
    const inserted = await ctx.trx
      .insertInto('crove_kernel.external_call')
      .values({ org_id: ctx.orgId, key, module: 'finance', target: PORTAL_SYNC_TARGET, step: input.step, retry_safety: 'safe', started_at: ctx.now })
      .onConflict((oc) => oc.columns(['org_id', 'key']).doNothing())
      .returning('id')
      .executeTakeFirst();
    if (!inserted) {
      const again = await ctx.trx
        .updateTable('crove_kernel.external_call')
        .set({ state: 'started', calls: sql<number>`calls + 1`, updated_at: ctx.now })
        .where('org_id', '=', ctx.orgId)
        .where('key', '=', key)
        .where('state', 'in', ['started', 'ambiguous'])
        .where('calls', '<', 1000)
        .returning('id')
        .executeTakeFirst();
      if (!again) throw new DomainError('PORTAL_CALL_DONE', 409, 'Hóa đơn này đã được tải trong lượt lấy dữ liệu này');
    }
    return { key, taxCode };
  },
});

export const portalSyncCallEnd = defineCommand({
  name: 'finance.portal_sync.call_end',
  input: z.object({
    key: z.string().startsWith(KEY_PREFIX).max(500),
    // retry: the portal did not answer this time (down, rate limited, session expired); the call may be made again
    // under the same key (state ambiguous), unlike a failed one.
    outcome: z.enum(['succeeded', 'failed', 'retry']),
    error: z.enum(PORTAL_CALL_ERRORS).optional(),
    // What came back, without content: a file id, or a count of rows or pages.
    externalRef: z.string().regex(/^[0-9a-zA-Z:-]{1,100}$/).optional(),
  }),
  risk: 'R1',
  access: EDITORS,
  handler: async (ctx, input) => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới lấy được dữ liệu từ cổng thuế');
    const ok = input.outcome === 'succeeded';
    const ended = await ctx.trx
      .updateTable('crove_kernel.external_call')
      .set(
        ok
          ? { state: 'succeeded', external_ref: input.externalRef ?? null, finished_at: ctx.now, updated_at: ctx.now }
          : input.outcome === 'retry'
            ? { state: 'ambiguous', error_kind: ERROR_KIND[input.error ?? 'UNAVAILABLE'], error_code: input.error ?? 'UNAVAILABLE', updated_at: ctx.now }
            : { state: 'failed', error_kind: ERROR_KIND[input.error ?? 'BAD_ANSWER'], error_code: input.error ?? 'BAD_ANSWER', finished_at: ctx.now, updated_at: ctx.now },
      )
      .where('org_id', '=', ctx.orgId)
      .where('key', '=', input.key)
      .where('target', '=', PORTAL_SYNC_TARGET)
      .where('state', 'in', ['started', 'ambiguous'])
      .returning(['step'])
      .executeTakeFirst();
    if (!ended) return { recorded: false };
    ctx.audit({ step: ended.step, outcome: input.outcome, ...(input.error ? { error: input.error } : {}) });
    return { recorded: true };
  },
});

// ---------------------------------------------------------------------------------------------------------------------
// The synced list
// ---------------------------------------------------------------------------------------------------------------------

export const portalSyncList = defineCommand({
  name: 'finance.portal_sync.list',
  input: z.object({ period: zVatPeriod, fileId: zId }),
  risk: 'R1',
  access: EDITORS,
  handler: async (ctx, input) => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới lấy được dữ liệu từ cổng thuế');
    vatPeriod(input.period);
    // Only a portal answer the API stored: a JSON import file of this org, never a document or an uploaded sheet. Files
    // are deduplicated by content per org, so another member who fetched the same answer gets the same file.
    const file = await ctx.trx
      .selectFrom('crove_kernel.file')
      .select(['id', 'source', 'content_type', 'created_by'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.fileId)
      .executeTakeFirst();
    if (!file || file.source !== 'import' || file.content_type !== PORTAL_SYNC_CONTENT_TYPE) throw new DomainError('NOT_FOUND', 404, 'Không tìm thấy dữ liệu đã lấy từ cổng thuế');
    // The portal is logged in to with the org's tax code, so a synced list is the default legal entity's (#1280) until
    // the sync logs in per entity.
    const legalEntityId = await defaultLegalEntityId(ctx);
    if (legalEntityId === null) throw legalEntityNotAllowed();
    await portalPeriodLock(ctx.orgId, legalEntityId, input.period).execute(ctx.trx);
    const active = await ctx.trx
      .selectFrom('crove_finance.portal_invoice_list')
      .select(['id', 'file_id', 'status'])
      .where('org_id', '=', ctx.orgId)
      .where('legal_entity_id', '=', legalEntityId)
      .where('period', '=', input.period)
      .where('removed_at', 'is', null)
      .execute();
    // The portal answered exactly as for a list already in the period: nothing new to record.
    const same = active.find((l) => l.file_id === input.fileId);
    if (same) return { listId: same.id, unchanged: true };
    // The latest portal answer replaces the period's earlier synced lists (kept, never deleted); Excel imports stay.
    const synced = await ctx.trx
      .selectFrom('crove_finance.portal_invoice_list as l')
      .innerJoin('crove_kernel.file as f', (join) => join.onRef('f.org_id', '=', 'l.org_id').onRef('f.id', '=', 'l.file_id'))
      .select('l.id')
      .where('l.org_id', '=', ctx.orgId)
      .where('l.legal_entity_id', '=', legalEntityId)
      .where('l.period', '=', input.period)
      .where('l.removed_at', 'is', null)
      .where('f.content_type', '=', PORTAL_SYNC_CONTENT_TYPE)
      .execute();
    if (synced.length > 0) {
      await ctx.trx
        .updateTable('crove_finance.portal_invoice_list')
        .set({ removed_at: sql<Date>`pg_catalog.now()`, removed_by: ctx.actor.userId })
        .where('org_id', '=', ctx.orgId)
        .where(
          'id',
          'in',
          synced.map((l) => l.id),
        )
        .where('removed_at', 'is', null)
        .execute();
    }
    if (active.length - synced.length >= MAX_PORTAL_LISTS_PER_PERIOD) {
      throw new DomainError('PORTAL_LIST_LIMIT', 409, `Mỗi kỳ nhập tối đa ${MAX_PORTAL_LISTS_PER_PERIOD} danh sách; hãy gỡ bớt danh sách cũ`);
    }
    const list = await ctx.trx
      .insertInto('crove_finance.portal_invoice_list')
      .values({ org_id: ctx.orgId, legal_entity_id: legalEntityId, period: input.period, file_id: file.id, filename: `Cổng thuế ${input.period}.json`, created_by: ctx.actor.userId })
      .returning('id')
      .executeTakeFirstOrThrow();
    ctx.audit({ period: input.period, file_id: file.id, source: 'portal_sync', replaced: synced.length });
    await ctx.activity('finance.portal_invoice_list', list.id, 'portal_list.synced', `Lấy danh sách hóa đơn mua vào từ cổng thuế, kỳ ${input.period}`);
    // The worker records it (importPortalList reads the evidence file instead of asking the sandbox).
    await ctx.emit('finance.portal_list.import_requested', { listId: list.id });
    return { listId: list.id, unchanged: false };
  },
});

export interface PortalXmlItem {
  sellerTaxCode: string;
  template: string | null;
  series: string;
  number: string;
}

export interface PortalXmlPlan {
  // The synced list: pending while the worker records it, failed when it could not be used, done.
  status: 'pending' | 'done' | 'failed';
  pending: PortalXmlItem[];
  remaining: number;
}

export const portalSyncXmlPlan = defineQuery({
  name: 'finance.portal_sync.xml_plan',
  input: z.object({ listId: zId, period: zVatPeriod, limit: z.number().int().min(0).max(PORTAL_XML_PER_SYNC) }),
  access: EDITORS,
  handler: async (ctx, input): Promise<PortalXmlPlan> => {
    const list = await ctx.trx
      .selectFrom('crove_finance.portal_invoice_list as l')
      .innerJoin('crove_kernel.file as f', (join) => join.onRef('f.org_id', '=', 'l.org_id').onRef('f.id', '=', 'l.file_id'))
      .select(['l.id', 'l.period', 'l.status', 'l.legal_entity_id'])
      .where('l.org_id', '=', ctx.orgId)
      .where('l.id', '=', input.listId)
      // The list of the period the portal session was opened for, not another one of the org.
      .where('l.period', '=', input.period)
      .where('l.removed_at', 'is', null)
      .where('f.content_type', '=', PORTAL_SYNC_CONTENT_TYPE)
      .executeTakeFirst();
    if (!list) throw new DomainError('NOT_FOUND', 404, 'Không tìm thấy danh sách đã lấy từ cổng thuế');
    // Still being recorded by the worker, or refused by it (the screen shows why): nothing to download yet.
    if (list.status !== 'done') return { status: list.status, pending: [], remaining: 0 };
    const withXml = new Set(
      (
        await ctx.trx
          .selectFrom('crove_finance.portal_invoice_row')
          .select('row_no')
          .where('org_id', '=', ctx.orgId)
          .where('list_id', '=', list.id)
          .where('check_result', '=', XML_CHECK_RESULT)
          .execute()
      ).map((r) => r.row_no),
    );
    const { reconciliation } = await reconcilePeriod(ctx, list.period, list.legal_entity_id);
    const seen = new Set<string>();
    const missing: PortalXmlItem[] = [];
    for (const item of reconciliation.items) {
      const row = item.portal;
      if (item.outcome !== 'missing' || !row || row.listId !== list.id || !withXml.has(row.rowNo)) continue;
      const invoice = { sellerTaxCode: row.sellerTaxCode, template: row.template, series: row.series, number: row.number };
      const key = xmlCallKey(list.id, invoice);
      if (seen.has(key)) continue;
      seen.add(key);
      missing.push(invoice);
    }
    // Downloads already finished for this list (fetched, or refused by the portal) are not tried again.
    const finished = new Set(
      (
        await ctx.trx
          .selectFrom('crove_kernel.external_call')
          .select('key')
          .where('org_id', '=', ctx.orgId)
          .where('target', '=', PORTAL_SYNC_TARGET)
          .where('step', '=', 'xml')
          .where('key', 'like', `${KEY_PREFIX}xml:${list.id}:%`)
          .where('state', 'in', ['succeeded', 'failed'])
          .execute()
      ).map((r) => r.key),
    );
    const done = (
      await ctx.trx
        .selectFrom('crove_kernel.external_call')
        .select(sql<string>`count(*)::text`.as('n'))
        .where('org_id', '=', ctx.orgId)
        .where('target', '=', PORTAL_SYNC_TARGET)
        .where('step', '=', 'xml')
        .where('key', 'like', `${KEY_PREFIX}xml:${list.id}:%`)
        .executeTakeFirstOrThrow()
    ).n;
    const left = missing.filter((m) => !finished.has(xmlCallKey(list.id, m)));
    // At most PORTAL_XML_PER_SYNC downloads per synced list; the rest waits for the next sync.
    const budget = Math.max(0, PORTAL_XML_PER_SYNC - Number(done));
    const allowed = left.slice(0, budget);
    return { status: 'done', pending: allowed.slice(0, input.limit), remaining: allowed.length };
  },
});

export const portalSyncCommands = [portalSyncCall, portalSyncCallEnd, portalSyncList];
// Before any budget is spent or the portal is called: the member may run the sync (owners, admins, members) and the
// org has a tax code, the portal user name. Read only.
export const portalSyncCheck = defineQuery({
  name: 'finance.portal_sync.check',
  input: z.object({}),
  access: EDITORS,
  handler: async (ctx): Promise<{ taxCode: string }> => {
    const tenant = await ctx.trx.selectFrom('crove_kernel.tenant').select('tax_code').where('org_id', '=', ctx.orgId).executeTakeFirst();
    const taxCode = parseTaxCode(tenant?.tax_code)?.normalized;
    if (!taxCode) {
      throw new DomainError('TAX_CODE_REQUIRED', 409, 'Hãy nhập mã số thuế của công ty trong Cài đặt trước khi lấy dữ liệu từ cổng thuế');
    }
    return { taxCode };
  },
});

export const portalSyncQueries = [portalSyncXmlPlan, portalSyncCheck];
