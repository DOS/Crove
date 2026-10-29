// Gapless numbering (ADR-0021 section 2, issue #1401): the commands and the query around the kernel's number series.
// Numbers are taken by ctx.numbering.allocate inside a posting command (and, for cash and journal vouchers, by the
// database's own insert triggers); they are never deleted or reused. A number declared void keeps its allocation row and
// gets a second, append-only row in crove_kernel.number_void.
//
// - kernel.number.void (R2, owners and admins): declares one allocated number void, with a reason. The database checks
//   the actor and the allocation again (crove_kernel.void_number), and refuses a second void of the same number.
// - kernel.number.policy.set (R2, owners and admins): the reset policy of a document type in a legal entity: 'yearly'
//   (the default), 'monthly' or 'never', chosen before the document type's first number; once it has numbers, its
//   reset stays (CONFLICT), so no period is numbered from 1 again beside numbers it already holds.
// - kernel.number.allocations: the numbers of one series, newest first, each with its record and its void, if any.
import { sql } from 'kysely';
import { z } from 'zod';
import { NUMBER_RESETS, type MemberRole } from '@crove/db';
import { DomainError, defineCommand, defineQuery, type QueryContext } from '@crove/kernel-runtime';

const ADMINS: readonly MemberRole[] = ['owner', 'admin'];
const READERS: readonly MemberRole[] = ['owner', 'admin', 'member'];

export type NumberReset = (typeof NUMBER_RESETS)[number];
// The document type of a series, as the database checks it (number_series.doc_type).
const zDocType = z.string().regex(/^[a-z][a-z0-9_.]*$/).max(100);
const zPeriodKey = z.string().regex(/^(\d{4}|\d{4}-(0[1-9]|1[0-2])|-)$/);
export const NUMBER_VOID_REASON_MAX = 500;
export const NUMBER_PAGE_SIZE = 100;

const notFound = () => new DomainError('NOT_FOUND', 404, 'Không tìm thấy số chứng từ này');

// The legal entity the input names, or the org's default, as the caller sees it (le_scope hides the others).
async function entityOf(ctx: Pick<QueryContext, 'trx' | 'orgId'>, legalEntityId: string | undefined | null): Promise<string> {
  let q = ctx.trx.selectFrom('crove_kernel.legal_entity').select('id').where('org_id', '=', ctx.orgId);
  q = legalEntityId ? q.where('id', '=', legalEntityId) : q.where('is_default', '=', true);
  const row = await q.executeTakeFirst();
  if (!row) throw new DomainError('LEGAL_ENTITY_NOT_FOUND', 422, 'Không tìm thấy pháp nhân này trong tổ chức');
  return row.id;
}

export interface NumberVoided {
  voidId: string;
  allocationId: string;
  docType: string;
  periodKey: string;
  number: number;
}

export const numberVoid = defineCommand({
  name: 'kernel.number.void',
  input: z.strictObject({
    allocationId: z.uuid(),
    reason: z.string().trim().min(1).max(NUMBER_VOID_REASON_MAX),
  }),
  risk: 'R2',
  // Internal (#1563): it records a fact in the numbering tables and changes no document, posting or outside system.
  sideEffect: 'internal',
  access: ADMINS,
  target: (input) => ({ type: 'kernel.number_allocation', id: input.allocationId }),
  handler: async (ctx, input): Promise<NumberVoided> => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
    const allocation = await ctx.trx
      .selectFrom('crove_kernel.number_allocation as a')
      .innerJoin('crove_kernel.number_series as s', (join) => join.onRef('s.org_id', '=', 'a.org_id').onRef('s.id', '=', 'a.series_id'))
      .leftJoin('crove_kernel.number_void as v', (join) => join.onRef('v.org_id', '=', 'a.org_id').onRef('v.allocation_id', '=', 'a.id'))
      .select(['a.id', 'a.number', 'a.target_type', 'a.target_id', 'a.legal_entity_id', 's.doc_type', 's.period_key', 'v.id as void_id'])
      .where('a.org_id', '=', ctx.orgId)
      .where('a.id', '=', input.allocationId)
      .executeTakeFirst();
    if (!allocation) throw notFound();
    const alreadyVoid = () => new DomainError('CONFLICT', 409, 'Số chứng từ này đã được hủy');
    if (allocation.void_id) throw alreadyVoid();
    // A voucher keeps its number for good: it is reversed, never voided by number (review of #1573).
    if (allocation.target_type === 'finance.cash_voucher' || allocation.target_type === 'finance.journal_voucher') {
      throw new DomainError('CONFLICT', 409, 'Không hủy riêng số của phiếu; hãy đảo bút toán của phiếu, phiếu giữ nguyên số');
    }
    const { voidId } = await ctx.numbering.void({ allocationId: allocation.id, reason: input.reason }).catch((error: { code?: string; message?: string }) => {
      // A void of the same number committed after the read above.
      if (error?.code === '23505') throw alreadyVoid();
      if (error?.code === '23503') throw notFound();
      throw error;
    });
    const number = Number(allocation.number);
    const voided = { voidId, allocationId: allocation.id, docType: allocation.doc_type, periodKey: allocation.period_key, number };
    ctx.audit({ ...voided, targetType: allocation.target_type, targetId: allocation.target_id, reason: input.reason });
    // The allocation's entity, whatever its target type: the row is read only where that entity is (#1728), and for a
    // target type the trigger maps, the database checks it is the record's own. The reason a member typed stays on the
    // void row (crove_kernel.number_void), read under its entity's scope, not in the timeline's text (#1825).
    await ctx.activity(allocation.target_type, allocation.target_id, 'number.voided', `Hủy số ${number} (${allocation.doc_type}, ${allocation.period_key})`, {
      legalEntityId: allocation.legal_entity_id,
    });
    return voided;
  },
});

export const numberPolicySet = defineCommand({
  name: 'kernel.number.policy.set',
  input: z.strictObject({
    legalEntityId: z.uuid().nullable().optional(),
    docType: zDocType,
    reset: z.enum(NUMBER_RESETS),
  }),
  risk: 'R2',
  // Internal (#1563): it records a fact in the numbering tables and changes no document, posting or outside system.
  sideEffect: 'internal',
  access: ADMINS,
  handler: async (ctx, input): Promise<{ legalEntityId: string; docType: string; reset: NumberReset; previous: NumberReset }> => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
    const legalEntityId = await entityOf(ctx, input.legalEntityId);
    const { rows } = await sql<{ previous: NumberReset }>`
      SELECT crove_kernel.number_series_policy_set(${legalEntityId}::uuid, ${input.docType}::text, ${input.reset}::text) AS previous`
      .execute(ctx.trx)
      .catch((error: { code?: string; message?: string }) => {
        // The document type already has numbers (review of #1573).
        if (error?.code === '55000' && error.message === 'NUMBER_POLICY_IN_USE') {
          throw new DomainError('CONFLICT', 409, 'Loại chứng từ này đã cấp số; không đổi được cách đánh số lại nữa');
        }
        throw error;
      });
    const previous = rows[0]?.previous ?? 'yearly';
    ctx.audit({ legalEntityId, docType: input.docType, reset: input.reset, previous });
    return { legalEntityId, docType: input.docType, reset: input.reset, previous };
  },
});

export interface NumberAllocationView {
  allocationId: string;
  number: number;
  targetType: string;
  targetId: string;
  allocatedBy: string | null;
  allocatedAt: string;
  void: { voidId: string; reason: string; voidedBy: string | null; voidedAt: string } | null;
}

export interface NumberSeriesPage {
  legalEntityId: string;
  docType: string;
  periodKey: string;
  // The number the next allocation takes (1 when the series has none yet).
  nextNumber: number;
  items: NumberAllocationView[];
  more: boolean;
}

export const numberAllocations = defineQuery({
  name: 'kernel.number.allocations',
  input: z.strictObject({
    legalEntityId: z.uuid().optional(),
    docType: zDocType,
    periodKey: zPeriodKey,
    // The number of the last row of the previous page.
    before: z.number().int().positive().optional(),
  }),
  access: READERS,
  handler: async (ctx, input): Promise<NumberSeriesPage> => {
    const legalEntityId = await entityOf(ctx, input.legalEntityId);
    const series = await ctx.trx
      .selectFrom('crove_kernel.number_series')
      .select(['id', 'next_number'])
      .where('org_id', '=', ctx.orgId)
      .where('legal_entity_id', '=', legalEntityId)
      .where('doc_type', '=', input.docType)
      .where('period_key', '=', input.periodKey)
      .executeTakeFirst();
    const page = { legalEntityId, docType: input.docType, periodKey: input.periodKey };
    if (!series) return { ...page, nextNumber: 1, items: [], more: false };
    let q = ctx.trx
      .selectFrom('crove_kernel.number_allocation as a')
      .leftJoin('crove_kernel.number_void as v', (join) => join.onRef('v.org_id', '=', 'a.org_id').onRef('v.allocation_id', '=', 'a.id'))
      .select(['a.id', 'a.number', 'a.target_type', 'a.target_id', 'a.allocated_by', 'a.allocated_at', 'v.id as void_id', 'v.reason', 'v.voided_by', 'v.voided_at'])
      .where('a.org_id', '=', ctx.orgId)
      .where('a.series_id', '=', series.id)
      .orderBy('a.number', 'desc')
      .limit(NUMBER_PAGE_SIZE + 1);
    if (input.before) q = q.where('a.number', '<', String(input.before));
    const rows = await q.execute();
    return {
      ...page,
      nextNumber: Number(series.next_number),
      items: rows.slice(0, NUMBER_PAGE_SIZE).map((r) => ({
        allocationId: r.id,
        number: Number(r.number),
        targetType: r.target_type,
        targetId: r.target_id,
        allocatedBy: r.allocated_by,
        allocatedAt: new Date(r.allocated_at).toISOString(),
        void:
          r.void_id && r.reason !== null && r.voided_at !== null
            ? { voidId: r.void_id, reason: r.reason, voidedBy: r.voided_by, voidedAt: new Date(r.voided_at).toISOString() }
            : null,
      })),
      more: rows.length > NUMBER_PAGE_SIZE,
    };
  },
});

export const numberingCommands = [numberVoid, numberPolicySet];
export const numberingQueries = [numberAllocations];
