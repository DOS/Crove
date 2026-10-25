// The tax portal's purchase-invoice list (issue #465). The accountant exports the month's purchase invoices from
// hoadondientu.gdt.gov.vn ("Tra cứu hóa đơn", "Hóa đơn điện tử mua vào", "Xuất Excel") and uploads the .xlsx here,
// for one client (the org) and one VAT period:
// - finance.portal_list.import (owners, admins, members; R1) files an uploaded spreadsheet as a pending list of the
//   period and asks the worker to read it.
// - The worker reads the file in crove-extract (kind portal_invoice_list, External-tenant gate T12: nothing is parsed
//   in the API or the worker), checks the sandbox's answer again (importPortalList below) and records the outcome
//   with finance.portal_list.record (system only): the rows, or why the list could not be used.
// - finance.portal_list.remove (owners, admins, members; R1) takes a list out of its period (a wrong file, an older
//   export); it is kept, never deleted.
// - finance.portal_list.reconcile (every role) compares the rows of the period's lists with the purchase documents
//   Crove recorded and the purchase proposals waiting in the Inbox (domain/portal-reconcile.ts).
// Only purchases: sales invoices (#313) are the org's own and are not on this list.
import { sql } from 'kysely';
import { z } from 'zod';
import {
  EXTRACT_LIMITS,
  EXTRACT_LIMIT_RETRIES,
  type ExtractClient,
  type ExtractFailure,
  type ExtractedPortalList,
} from '@crove/extract-contract';
import {
  MAX_IMPORT_BYTES,
  MAX_PORTAL_LISTS_PER_PERIOD,
  PORTAL_LIST_SKIP_REASONS,
  XLSX_CONTENT_TYPE,
  zId,
  zLocalDate,
  zVatPeriod,
  type PortalListView,
  type PortalReconciliation,
} from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand, defineQuery, readVerified, type BlobStore, type QueryContext, type Runtime } from '@crove/kernel-runtime';
import { isCalendarDate, parseTaxCode, toMoney, money } from '@crove/l10n-vn';
import { portalStatus } from './domain/portal-status.ts';
import { PORTAL_SYNC_CONTENT_TYPE, readSyncedList } from './domain/portal-api.ts';
import { reconcilePortalList, type CroveInvoice, type PortalRow, type Reconciliation } from './domain/portal-reconcile.ts';
import { vatPeriod, type VatPeriod } from './domain/vat-return.ts';
import { defaultLegalEntityId, resolveLegalEntity } from './legal-entity.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const EDITORS: readonly MemberRole[] = ['owner', 'admin', 'member'];
export const PORTAL_LIST_ACTOR = { type: 'system' as const, component: 'finance.portal_list' };
// Purchase documents and proposals read for one reconciliation; more is refused rather than cut short.
export const PORTAL_RECONCILE_LIMIT = 20_000;
// Rows of the done lists of one period, all lists together. A list that would take the period past it is recorded as
// failed, so a reconciliation (any role may run it, and the screen polls it while a list is read) reads a bounded
// number of rows (#506).
export const PORTAL_PERIOD_ROW_LIMIT = 50_000;
// Reconciliation items returned per outcome. The summary counts every item; a section past the limit shows its first
// items (in the order of reconcilePortalList) and says how many there are in all.
export const PORTAL_RECONCILE_ITEMS_PER_OUTCOME = 500;
const ROW_INSERT_BATCH = 500;
const vnNumber = (n: number) => n.toLocaleString('vi-VN');
// The lists of one VAT period of one legal entity (#1280) are serialized; portal-sync.ts takes the same lock.
export const portalPeriodLock = (orgId: string, legalEntityId: string, period: string) =>
  sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`finance.portal_list:${orgId}:${legalEntityId}:${period}`}, 0))`;

export const portalListImport = defineCommand({
  name: 'finance.portal_list.import',
  // The list of one legal entity's period (#1280): legalEntityId as in zLegalEntityChoice.
  input: z.object({ period: zVatPeriod, fileId: zId, legalEntityId: zId.optional() }),
  risk: 'R1',
  access: EDITORS,
  handler: async (ctx, input) => {
    vatPeriod(input.period);
    const file = await ctx.trx
      .selectFrom('crove_kernel.file')
      .select(['id', 'filename', 'content_type', 'size_bytes', 'source'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.fileId)
      .executeTakeFirst();
    if (!file) throw new DomainError('NOT_FOUND', 404, 'Không tìm thấy tệp đã tải lên');
    // Only a workbook uploaded for an import (purpose 'import': a ZIP container recorded as .xlsx, never sent to
    // extraction). An uploaded or emailed document, even a ZIP, is not a portal list (#506).
    if (file.source !== 'import' || file.content_type !== XLSX_CONTENT_TYPE) {
      throw new DomainError('UNSUPPORTED_TYPE', 415, 'Danh sách hóa đơn phải là tệp Excel .xlsx tải lên ở màn hình đối chiếu với cổng thuế');
    }
    if (Number(file.size_bytes) > MAX_IMPORT_BYTES) throw new DomainError('TOO_LARGE', 413, 'Tệp danh sách vượt quá 10 MB');
    // A purchase list is told apart from another company's or the sales list by the org's tax code (checkPortalList).
    const tenant = await ctx.trx.selectFrom('crove_kernel.tenant').select('tax_code').where('org_id', '=', ctx.orgId).executeTakeFirst();
    if (!tenant?.tax_code) {
      throw new DomainError('TAX_CODE_REQUIRED', 409, 'Hãy nhập mã số thuế của công ty trong Cài đặt trước khi nhập danh sách hóa đơn từ cổng thuế');
    }
    const legalEntityId = await resolveLegalEntity(ctx, input.legalEntityId);
    // Serializes imports of one period, so the count below and the unique index agree.
    await portalPeriodLock(ctx.orgId, legalEntityId, input.period).execute(ctx.trx);
    const active = await ctx.trx
      .selectFrom('crove_finance.portal_invoice_list')
      .select(['id', 'file_id', 'legal_entity_id'])
      .where('org_id', '=', ctx.orgId)
      .where('period', '=', input.period)
      .where('removed_at', 'is', null)
      .execute();
    // A file is one period's list once, in whichever entity it was imported (the unique index is per org and period).
    if (active.some((l) => l.file_id === input.fileId)) {
      throw new DomainError('PORTAL_LIST_EXISTS', 409, `Tệp này đã được nhập cho kỳ ${input.period}`);
    }
    if (active.filter((l) => l.legal_entity_id === legalEntityId).length >= MAX_PORTAL_LISTS_PER_PERIOD) {
      throw new DomainError('PORTAL_LIST_LIMIT', 409, `Mỗi kỳ nhập tối đa ${MAX_PORTAL_LISTS_PER_PERIOD} danh sách; hãy gỡ bớt danh sách cũ`);
    }
    const list = await ctx.trx
      .insertInto('crove_finance.portal_invoice_list')
      .values({
        org_id: ctx.orgId,
        legal_entity_id: legalEntityId,
        period: input.period,
        file_id: file.id,
        filename: file.filename.slice(0, 255),
        created_by: ctx.actor.type === 'user' ? ctx.actor.userId : null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    ctx.audit({ period: input.period, file_id: file.id, legal_entity_id: legalEntityId });
    await ctx.activity('finance.portal_invoice_list', list.id, 'portal_list.imported', `Nhập danh sách hóa đơn mua vào từ cổng thuế, kỳ ${input.period}`);
    await ctx.emit('finance.portal_list.import_requested', { listId: list.id });
    return { listId: list.id };
  },
});

export const portalListRemove = defineCommand({
  name: 'finance.portal_list.remove',
  input: z.object({ listId: zId }),
  risk: 'R1',
  access: EDITORS,
  handler: async (ctx, input) => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới gỡ được danh sách');
    const removed = await ctx.trx
      .updateTable('crove_finance.portal_invoice_list')
      .set({ removed_at: sql<Date>`pg_catalog.now()`, removed_by: ctx.actor.userId })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.listId)
      .where('removed_at', 'is', null)
      .returning(['id', 'period'])
      .executeTakeFirst();
    if (!removed) throw new DomainError('NOT_FOUND', 404, 'Không tìm thấy danh sách, hoặc danh sách đã được gỡ');
    ctx.audit({ period: removed.period });
    await ctx.activity('finance.portal_invoice_list', removed.id, 'portal_list.removed', `Gỡ danh sách hóa đơn từ cổng thuế khỏi kỳ ${removed.period}`);
    return { listId: removed.id };
  },
});

// The list a worker job reads, while it is still pending.
export const portalListSource = defineQuery({
  name: 'finance.portal_list.source',
  input: z.object({ listId: zId }),
  access: 'system',
  handler: async (ctx, input) => {
    const row = await ctx.trx
      .selectFrom('crove_finance.portal_invoice_list as l')
      .innerJoin('crove_kernel.file as f', (join) => join.onRef('f.org_id', '=', 'l.org_id').onRef('f.id', '=', 'l.file_id'))
      .innerJoin('crove_kernel.tenant as t', 't.org_id', 'l.org_id')
      .select(['l.id', 'l.status', 'l.period', 'f.storage_key', 'f.generation', 'f.sha256', 'f.content_type', 't.tax_code'])
      .where('l.org_id', '=', ctx.orgId)
      .where('l.id', '=', input.listId)
      .executeTakeFirst();
    if (!row) return null;
    return {
      id: row.id,
      pending: row.status === 'pending',
      period: row.period,
      orgTaxCode: row.tax_code,
      file: { key: row.storage_key, generation: row.generation, sha256: row.sha256 },
      // An uploaded workbook, or the portal answer a sync stored (#325).
      contentType: row.content_type,
    };
  },
});

const zRecordRow = z.object({
  rowNo: z.number().int().min(1).max(1_048_576),
  sellerTaxCode: z.string().regex(/^[0-9]{10}(-[0-9]{3})?$|^[0-9]{12}$/),
  sellerName: z.string().max(500),
  template: z.string().regex(/^[0-9A-Z]{1,11}$/).nullable(),
  series: z.string().min(1).max(20),
  number: z.string().min(1).max(20),
  issueDate: zLocalDate,
  currency: z.string().regex(/^[A-Z]{3}$/),
  subtotal: z.string().nullable(),
  vatAmount: z.string().nullable(),
  total: z.string().nullable(),
  status: z.enum(['original', 'replacement', 'adjustment', 'replaced', 'adjusted', 'cancelled', 'unknown']),
  statusLabel: z.string().max(200).nullable(),
  checkResult: z.string().max(200).nullable(),
});

export const portalListRecord = defineCommand({
  name: 'finance.portal_list.record',
  input: z.discriminatedUnion('status', [
    z.object({
      listId: zId,
      status: z.literal('done'),
      listFrom: zLocalDate.nullable(),
      listTo: zLocalDate.nullable(),
      buyerTaxCode: z.string().nullable(),
      rows: z
        .array(zRecordRow)
        .max(EXTRACT_LIMITS.maxPortalListRows)
        .refine((rows) => new Set(rows.map((r) => r.rowNo)).size === rows.length, 'rowNo repeats'),
      ownSalesCount: z.number().int().min(0).max(1_048_576),
      otherBuyerCount: z.number().int().min(0).max(1_048_576),
      skippedCount: z.number().int().min(0).max(1_048_576),
      skipped: z.array(z.object({ rowNo: z.number().int().min(1).max(1_048_576), reason: z.enum(PORTAL_LIST_SKIP_REASONS) })).max(EXTRACT_LIMITS.maxPortalListSkipped),
    }),
    z.object({ listId: zId, status: z.literal('failed'), error: z.string().min(1).max(2000) }),
  ]),
  risk: 'R1',
  access: 'system',
  handler: async (ctx, input) => {
    const list = await ctx.trx
      .selectFrom('crove_finance.portal_invoice_list')
      .select(['id', 'status', 'period', 'legal_entity_id'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.listId)
      .forUpdate()
      .executeTakeFirst();
    // A list already recorded (a retried job) or gone is left as it is.
    if (!list || list.status !== 'pending') return { listId: input.listId, recorded: false };
    if (input.status === 'done' && input.skippedCount < input.skipped.length) {
      throw new DomainError('INVALID', 400, 'Số dòng bỏ qua ít hơn số dòng được liệt kê');
    }
    const fail = async (error: string) => {
      await ctx.trx
        .updateTable('crove_finance.portal_invoice_list')
        .set({ status: 'failed', error, recorded_at: sql<Date>`pg_catalog.now()` })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', list.id)
        .execute();
      ctx.audit({ status: 'failed' });
      await ctx.activity('finance.portal_invoice_list', list.id, 'portal_list.failed', `Không đọc được danh sách hóa đơn kỳ ${list.period}`);
      // The importer and the owners and admins hear about it (#671, finance.notification.dispatch).
      await ctx.emit('finance.portal_list.recorded', { listId: list.id });
      return { listId: list.id, recorded: true };
    };
    if (input.status === 'failed') return fail(input.error);
    // The period's rows (of the list's legal entity, #1280) stay within PORTAL_PERIOD_ROW_LIMIT; serialized with the
    // period's imports and other records.
    await portalPeriodLock(ctx.orgId, list.legal_entity_id, list.period).execute(ctx.trx);
    const held = await ctx.trx
      .selectFrom('crove_finance.portal_invoice_list')
      .select(sql<string>`coalesce(sum(row_count), 0)::text`.as('rows'))
      .where('org_id', '=', ctx.orgId)
      .where('legal_entity_id', '=', list.legal_entity_id)
      .where('period', '=', list.period)
      .where('status', '=', 'done')
      .where('removed_at', 'is', null)
      .executeTakeFirstOrThrow();
    if (Number(held.rows) + input.rows.length > PORTAL_PERIOD_ROW_LIMIT) {
      return fail(
        `Kỳ ${list.period} đã có ${vnNumber(Number(held.rows))} hóa đơn từ các danh sách đã nhập, thêm ${vnNumber(input.rows.length)} hóa đơn của danh sách này sẽ vượt mức ${vnNumber(PORTAL_PERIOD_ROW_LIMIT)} hóa đơn mỗi kỳ; hãy gỡ các danh sách trùng hoặc cũ rồi nhập lại`,
      );
    }
    for (let i = 0; i < input.rows.length; i += ROW_INSERT_BATCH) {
      await ctx.trx
        .insertInto('crove_finance.portal_invoice_row')
        .values(
          input.rows.slice(i, i + ROW_INSERT_BATCH).map((r) => ({
            org_id: ctx.orgId,
            list_id: list.id,
            row_no: r.rowNo,
            seller_tax_code: r.sellerTaxCode,
            seller_name: r.sellerName,
            template: r.template,
            series: r.series,
            number: r.number,
            issue_date: r.issueDate,
            currency: r.currency,
            subtotal: r.subtotal,
            vat_amount: r.vatAmount,
            total: r.total,
            status: r.status,
            status_label: r.statusLabel,
            check_result: r.checkResult,
          })),
        )
        .execute();
    }
    await ctx.trx
      .updateTable('crove_finance.portal_invoice_list')
      .set({
        status: 'done',
        row_count: input.rows.length,
        list_from: input.listFrom,
        list_to: input.listTo,
        buyer_tax_code: input.buyerTaxCode,
        skipped_count: input.skippedCount,
        skipped: input.skipped.length > 0 ? JSON.stringify(input.skipped) : null,
        own_sales_count: input.ownSalesCount,
        other_buyer_count: input.otherBuyerCount,
        recorded_at: sql<Date>`pg_catalog.now()`,
      })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', list.id)
      .execute();
    ctx.audit({ status: 'done', rows: input.rows.length, skipped: input.skippedCount, own_sales: input.ownSalesCount, other_buyers: input.otherBuyerCount });
    await ctx.activity('finance.portal_invoice_list', list.id, 'portal_list.read', `Đọc ${input.rows.length} hóa đơn từ danh sách của cổng thuế, kỳ ${list.period}`);
    // Missing or different invoices are told to the importer and the owners and admins (#671).
    await ctx.emit('finance.portal_list.recorded', { listId: list.id });
    return { listId: list.id, recorded: true };
  },
});

async function periodLists(ctx: QueryContext, period: string, legalEntityId: string): Promise<PortalListView[]> {
  const lists = await ctx.trx
    .selectFrom('crove_finance.portal_invoice_list')
    .select(['id', 'period', 'file_id', 'filename', 'status', 'error', 'row_count', 'list_from', 'list_to', 'skipped_count', 'skipped', 'own_sales_count', 'other_buyer_count', 'created_at'])
    .where('org_id', '=', ctx.orgId)
    .where('legal_entity_id', '=', legalEntityId)
    .where('period', '=', period)
    .where('removed_at', 'is', null)
    .orderBy('created_at')
    .orderBy('id')
    .execute();
  return lists.map((l) => ({
    id: l.id,
    period: l.period,
    fileId: l.file_id,
    filename: l.filename,
    status: l.status,
    error: l.error,
    rowCount: l.row_count,
    listFrom: l.list_from,
    listTo: l.list_to,
    skippedCount: l.skipped_count,
    skipped: skippedRows(l.skipped),
    ownSalesCount: l.own_sales_count,
    otherBuyerCount: l.other_buyer_count,
    createdAt: new Date(l.created_at).toISOString(),
  }));
}

// The skipped rows as stored (jsonb written by finance.portal_list.record from a checked list), read defensively.
function skippedRows(value: unknown): PortalListView['skipped'] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((v: unknown) => {
    const r = v as { rowNo?: unknown; reason?: unknown } | null;
    return r && typeof r.rowNo === 'number' && typeof r.reason === 'string' && (PORTAL_LIST_SKIP_REASONS as readonly string[]).includes(r.reason)
      ? [{ rowNo: r.rowNo, reason: r.reason as PortalListView['skipped'][number]['reason'] }]
      : [];
  });
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

// Crove's purchases dated in [from, to]: the recorded documents that are not voided, and the purchase proposals waiting
// in the Inbox. Also the documents dated before the period but posted in it (#478): the VAT working declares them in
// the period of their posting date, so the reconciliation reports them there (declared_late, #560). Each document
// carries its posting date, the date of its own journal entry (every document has one: purchase_document_entry). All of
// one legal entity (#1280): its documents, and the proposals that name it (or name none, for the default entity).
async function croveInvoices(ctx: QueryContext, from: string, to: string, period: { from: string; to: string }, legalEntityId: string): Promise<CroveInvoice[]> {
  const documents = await ctx.trx
    .selectFrom('crove_finance.purchase_document as d')
    .innerJoin('crove_kernel.party as p', (join) => join.onRef('p.org_id', '=', 'd.org_id').onRef('p.id', '=', 'd.party_id'))
    .leftJoin('crove_kernel.proposal as q', (join) => join.onRef('q.org_id', '=', 'd.org_id').onRef('q.id', '=', 'd.proposal_id'))
    .leftJoin('crove_finance.journal_entry as j', (join) =>
      join.onRef('j.org_id', '=', 'd.org_id').onRef('j.source_id', '=', 'd.id').on('j.source_type', '=', 'finance.purchase_document'),
    )
    .select([
      'd.id',
      'p.tax_code',
      'p.name',
      'd.invoice_series',
      'd.invoice_number',
      'd.invoice_date',
      'd.currency',
      'd.vat_amount',
      'd.total',
      'd.source_file_id',
      'j.entry_date',
      sql<string | null>`q.payload #>> '{invoice,template}'`.as('template'),
    ])
    .where('d.org_id', '=', ctx.orgId)
    .where('d.legal_entity_id', '=', legalEntityId)
    .where('d.direction', '=', 'purchase')
    .where((eb) =>
      eb.or([
        eb.and([eb('d.invoice_date', '>=', from), eb('d.invoice_date', '<=', to)]),
        eb.and([eb('d.invoice_date', '<', period.from), eb('j.entry_date', '>=', period.from), eb('j.entry_date', '<=', period.to)]),
      ]),
    )
    .where(({ not, exists, selectFrom }) =>
      not(exists(selectFrom('crove_finance.purchase_document_void as v').select('v.document_id').whereRef('v.org_id', '=', 'd.org_id').whereRef('v.document_id', '=', 'd.id'))),
    )
    .limit(PORTAL_RECONCILE_LIMIT + 1)
    .execute();
  const isDefault = legalEntityId === (await defaultLegalEntityId(ctx));
  const proposals = await ctx.trx
    .selectFrom('crove_kernel.proposal')
    .select(['id', 'payload', 'source_file_id'])
    .where('org_id', '=', ctx.orgId)
    .where(isDefault ? sql<boolean>`coalesce(payload ->> 'legalEntityId', ${legalEntityId}) = ${legalEntityId}` : sql<boolean>`payload ->> 'legalEntityId' = ${legalEntityId}`)
    .where('kind', '=', 'finance.purchase')
    .where('status', '=', 'pending')
    .where(sql`coalesce(payload ->> 'direction', 'purchase')`, '=', 'purchase')
    .where(sql`payload #>> '{invoice,issueDate}'`, '>=', from)
    .where(sql`payload #>> '{invoice,issueDate}'`, '<=', to)
    .limit(PORTAL_RECONCILE_LIMIT + 1)
    .execute();
  if (documents.length + proposals.length > PORTAL_RECONCILE_LIMIT) {
    throw new DomainError('PERIOD_TOO_LARGE', 422, `Kỳ này có hơn ${PORTAL_RECONCILE_LIMIT} hóa đơn mua vào; hệ thống chưa đối chiếu được khối lượng này`);
  }
  const out: CroveInvoice[] = documents.map((d) => ({
    kind: 'document',
    id: d.id,
    sellerTaxCode: d.tax_code,
    sellerName: d.name,
    template: d.template,
    series: d.invoice_series,
    number: d.invoice_number,
    issueDate: d.invoice_date,
    currency: d.currency,
    vatAmount: d.vat_amount,
    total: d.total,
    sourceFileId: d.source_file_id,
    postingDate: d.entry_date,
  }));
  for (const p of proposals) {
    // A pending proposal's payload passed zPurchaseProposal when it was stored; it is read defensively all the same.
    const payload = p.payload as { seller?: { taxCode?: unknown; name?: unknown }; invoice?: Record<string, unknown> } | null;
    const invoice = payload?.invoice;
    if (!invoice || typeof invoice.series !== 'string' || typeof invoice.number !== 'string' || typeof invoice.issueDate !== 'string') continue;
    const taxCode = typeof payload?.seller?.taxCode === 'string' ? (parseTaxCode(payload.seller.taxCode)?.normalized ?? null) : null;
    out.push({
      kind: 'proposal',
      id: p.id,
      sellerTaxCode: taxCode,
      sellerName: typeof payload?.seller?.name === 'string' ? payload.seller.name : '',
      template: typeof invoice.template === 'string' ? invoice.template : null,
      series: invoice.series,
      number: invoice.number,
      issueDate: invoice.issueDate,
      currency: typeof invoice.currency === 'string' ? invoice.currency.toUpperCase() : 'VND',
      vatAmount: typeof invoice.vatTotal === 'string' ? invoice.vatTotal : '0',
      total: typeof invoice.total === 'string' ? invoice.total : '0',
      sourceFileId: p.source_file_id,
      postingDate: null,
    });
  }
  return out;
}

// The first `limit` items of each outcome, in their order. The summary is computed before, over every item.
export function firstPerOutcome<T extends { outcome: string }>(items: readonly T[], limit: number): T[] {
  const seen = new Map<string, number>();
  return items.filter((item) => {
    const n = (seen.get(item.outcome) ?? 0) + 1;
    seen.set(item.outcome, n);
    return n <= limit;
  });
}

// The full reconciliation of one VAT period: the period, its lists and every item (uncut). The reconcile query cuts
// the items per outcome; the missing-invoice request (#669) reads the 'missing' ones. Of one legal entity (#1280).
export async function reconcilePeriod(
  ctx: QueryContext,
  periodKey: string,
  legalEntityId: string,
): Promise<{ period: VatPeriod; lists: PortalListView[]; reconciliation: Reconciliation }> {
  const period = vatPeriod(periodKey);
  const lists = await periodLists(ctx, periodKey, legalEntityId);
  const done = lists.filter((l) => l.status === 'done').map((l) => l.id);
  const rows: PortalRow[] =
    done.length === 0
      ? []
      : (
          await ctx.trx
            .selectFrom('crove_finance.portal_invoice_row')
            .select(['list_id', 'row_no', 'seller_tax_code', 'seller_name', 'template', 'series', 'number', 'issue_date', 'currency', 'subtotal', 'vat_amount', 'total', 'status', 'status_label'])
            .where('org_id', '=', ctx.orgId)
            .where('list_id', 'in', done)
            .orderBy('list_id')
            .orderBy('row_no')
            .execute()
        ).map((r) => ({
          listId: r.list_id,
          rowNo: r.row_no,
          sellerTaxCode: r.seller_tax_code,
          sellerName: r.seller_name,
          template: r.template,
          series: r.series,
          number: r.number,
          issueDate: r.issue_date,
          currency: r.currency,
          subtotal: r.subtotal,
          vatAmount: r.vat_amount,
          total: r.total,
          status: r.status,
          statusLabel: r.status_label,
        }));
  // Rows dated outside the period are still matched, so Crove's side is read for every date the rows have, and a
  // month around it (an invoice booked on a slightly different date than the portal shows still counts).
  const dates = rows.map((r) => r.issueDate).sort();
  const from = addDays([period.from, dates[0] ?? period.from].sort()[0] ?? period.from, -31);
  const to = addDays([period.to, dates.at(-1) ?? period.to].sort().at(-1) ?? period.to, 31);
  // Without a list there is nothing to compare: Crove's invoices are not all reported as "not on the portal".
  const reconciliation = done.length === 0 ? reconcilePortalList([], [], period) : reconcilePortalList(rows, await croveInvoices(ctx, from, to, period, legalEntityId), period);
  return { period, lists, reconciliation };
}

export const portalListReconcile = defineQuery({
  name: 'finance.portal_list.reconcile',
  input: z.object({ period: zVatPeriod, legalEntityId: zId.optional() }),
  access: ALL,
  handler: async (ctx, input): Promise<PortalReconciliation> => {
    const { period, lists, reconciliation } = await reconcilePeriod(ctx, input.period, await resolveLegalEntity(ctx, input.legalEntityId));
    const items = firstPerOutcome(reconciliation.items, PORTAL_RECONCILE_ITEMS_PER_OUTCOME);
    return { period, lists, summary: reconciliation.summary, items, truncated: items.length < reconciliation.items.length };
  },
});

export interface PortalListDeps {
  runtime: Runtime;
  store: BlobStore;
  extract: ExtractClient;
}

interface ListSource {
  id: string;
  pending: boolean;
  period: string;
  orgTaxCode: string | null;
  file: { key: string; generation: string | null; sha256: string };
  contentType: string;
}

function unreadable(result: ExtractFailure): string {
  switch (result.code) {
    case 'too_large':
      return 'Tệp danh sách quá lớn (tối đa 10 MB)';
    case 'timeout':
      return 'Đọc tệp quá lâu nên đã dừng; hãy chia danh sách thành nhiều tệp nhỏ hơn';
    case 'memory':
      return 'Tệp quá phức tạp để đọc; hãy chia danh sách thành nhiều tệp nhỏ hơn';
    default:
      // The sandbox says what is wrong with the file; the text stays plain data wherever it is shown.
      return result.message || 'Không đọc được danh sách hóa đơn';
  }
}

export function recordPortalListFailure(runtime: Runtime, orgId: string, listId: string, error: string) {
  return runtime.execute('finance.portal_list.record', { listId, status: 'failed', error: error.slice(0, 2000) }, { actor: PORTAL_LIST_ACTOR, orgId });
}

// Checks the sandbox's answer again (it is untrusted) and turns it into the rows recorded for the list, or a reason the
// list cannot be used. Pure, so the rules are tested without a database. The portal's list names both parties on each
// row and has the same columns for purchases and sales, so the parties decide: a purchase list is one where the org is
// the buyer. Rows where the org is the seller (its own sales) or someone else is the buyer are not purchases of the
// org and are dropped; a list with none left is refused with the reason.
// The sandbox reads dates as calendar dates and numbers rows by their place in the sheet; an answer that breaks either
// (an impossible date, a row number twice) is refused here with the reason, not left to the database insert (#506).
export interface CheckedPortalList {
  ok: true;
  rows: z.infer<typeof zRecordRow>[];
  listFrom: string | null;
  listTo: string | null;
  // Rows dropped as not the org's purchases: the org is the seller, or another buyer is named.
  ownSales: number;
  otherBuyers: number;
}

export function checkPortalList(list: ExtractedPortalList, orgTaxCode: string | null): CheckedPortalList | { ok: false; error: string } {
  const own = parseTaxCode(orgTaxCode)?.normalized ?? null;
  // Without the org's tax code any company's list, or the sales list, would pass as the org's purchases.
  if (!own) return { ok: false, error: 'Hãy nhập mã số thuế của công ty trong Cài đặt rồi nhập lại danh sách' };
  const preamble = parseTaxCode(list.buyerTaxCode)?.normalized ?? null;
  const otherCompany = (code: string) =>
    `Danh sách này của mã số thuế ${code}, không phải của công ty này (${own}); hãy kiểm tra đã chọn đúng khách hàng chưa`;
  if (own && preamble && own !== preamble) return { ok: false, error: otherCompany(preamble) };
  for (const date of [list.listFrom, list.listTo]) {
    if (date !== null && !isCalendarDate(date)) return { ok: false, error: `Khoảng ngày tra cứu trong tệp có ngày không hợp lệ (${date}); hãy xuất lại danh sách từ cổng thuế` };
  }
  if (list.listFrom !== null && list.listTo !== null && list.listFrom > list.listTo) {
    return { ok: false, error: `Khoảng ngày tra cứu trong tệp không hợp lệ (từ ${list.listFrom} đến ${list.listTo}); hãy xuất lại danh sách từ cổng thuế` };
  }
  const rowNos = new Set<number>();
  for (const r of list.rows) {
    if (rowNos.has(r.rowNo)) return { ok: false, error: `Kết quả đọc tệp có dòng ${r.rowNo} hai lần; hãy nhập lại danh sách` };
    rowNos.add(r.rowNo);
    if (!isCalendarDate(r.issueDate)) return { ok: false, error: `Dòng ${r.rowNo}: ngày lập hóa đơn không hợp lệ (${r.issueDate})` };
  }
  if (list.rows.length === 0 && list.skippedCount > 0) {
    return { ok: false, error: `Không đọc được hóa đơn nào trong danh sách (${list.skippedCount} dòng lỗi, ví dụ dòng ${list.skipped[0]?.rowNo ?? '?'}); hãy kiểm tra tệp` };
  }
  if (list.rows.length === 0) {
    return { ok: false, error: 'Danh sách không có hóa đơn nào; hãy kiểm tra đã tra cứu đúng kỳ ở mục "Hóa đơn điện tử mua vào"' };
  }
  const rows: z.infer<typeof zRecordRow>[] = [];
  let ownSales = 0;
  const foreignBuyers = new Map<string, number>();
  for (const r of list.rows) {
    const seller = parseTaxCode(r.sellerTaxCode)?.normalized;
    if (!seller) return { ok: false, error: `Dòng ${r.rowNo}: mã số thuế người bán không hợp lệ` };
    const buyer = parseTaxCode(r.buyerTaxCode)?.normalized ?? null;
    if (own && seller === own) {
      ownSales += 1;
      continue;
    }
    if (own && buyer && buyer !== own) {
      foreignBuyers.set(buyer, (foreignBuyers.get(buyer) ?? 0) + 1);
      continue;
    }
    const amount = (value: string | null) => (value === null ? null : toMoney(money(value)));
    rows.push({
      rowNo: r.rowNo,
      sellerName: r.sellerName,
      template: r.template,
      series: r.series,
      number: r.number,
      issueDate: r.issueDate,
      currency: r.currency,
      statusLabel: r.statusLabel,
      checkResult: r.checkResult,
      sellerTaxCode: seller, subtotal: amount(r.subtotal), vatAmount: amount(r.vatAmount), total: amount(r.total),
      status: portalStatus(r.statusLabel),
    });
  }
  const otherBuyers = [...foreignBuyers.values()].reduce((sum, n) => sum + n, 0);
  if (rows.length === 0) {
    if (ownSales > 0 && ownSales >= otherBuyers) {
      return { ok: false, error: 'Đây là danh sách hóa đơn bán ra; hãy tra cứu ở mục "Hóa đơn điện tử mua vào" rồi xuất lại' };
    }
    const [mostCommon] = [...foreignBuyers].sort((a, b) => b[1] - a[1]);
    if (mostCommon) return { ok: false, error: otherCompany(mostCommon[0]) };
  }
  return { ok: true, rows, listFrom: list.listFrom, listTo: list.listTo, ownSales, otherBuyers };
}

// Reads one imported list and records the outcome. `attempt` is the job's retry count. A sandbox that cannot answer
// throws (ExtractServiceError) and the job is retried; a file the sandbox refuses is recorded as failed. A timeout or
// memory answer may come from load, so it is retried EXTRACT_LIMIT_RETRIES times first.
export async function importPortalList(deps: PortalListDeps, orgId: string, listId: string, attempt = 0): Promise<{ rows: number } | null> {
  const source = await deps.runtime.query<ListSource | null>('finance.portal_list.source', { listId }, { actor: PORTAL_LIST_ACTOR, orgId });
  if (!source || !source.pending) return null;
  const bytes = await readVerified(deps.store, source.file);
  let list: ExtractedPortalList;
  if (source.contentType === PORTAL_SYNC_CONTENT_TYPE) {
    // A list the assisted sync fetched from the portal's API (#325): JSON the API already checked and stored, read
    // here with the same rules (domain/portal-api.ts); no file format to parse, so no sandbox round trip.
    const range = vatPeriod(source.period);
    const synced = readSyncedList(bytes, range);
    if (!synced.ok) {
      await recordPortalListFailure(deps.runtime, orgId, listId, synced.error);
      return null;
    }
    list = synced.list;
  } else {
    const result = await deps.extract.extract('portal_invoice_list', bytes);
    if (!result.ok) {
      const limitHit = result.code === 'timeout' || result.code === 'memory';
      if (limitHit && attempt < EXTRACT_LIMIT_RETRIES) throw new Error(`crove-extract stopped at a limit: ${result.code}`);
      await recordPortalListFailure(deps.runtime, orgId, listId, unreadable(result));
      return null;
    }
    list = result.list;
  }
  const checked = checkPortalList(list, source.orgTaxCode);
  if (!checked.ok) {
    await recordPortalListFailure(deps.runtime, orgId, listId, checked.error);
    return null;
  }
  await deps.runtime.execute(
    'finance.portal_list.record',
    {
      listId,
      status: 'done',
      listFrom: checked.listFrom,
      listTo: checked.listTo,
      buyerTaxCode: parseTaxCode(list.buyerTaxCode)?.normalized ?? null,
      rows: checked.rows,
      skippedCount: list.skippedCount,
      skipped: list.skipped,
      ownSalesCount: checked.ownSales,
      otherBuyerCount: checked.otherBuyers,
    },
    { actor: PORTAL_LIST_ACTOR, orgId },
  );
  return { rows: checked.rows.length };
}
