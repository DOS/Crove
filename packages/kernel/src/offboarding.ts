// Org offboarding (issue #38, plan §7.9). The owner starts it with kernel.org.offboard (R3): the org moves to
// 'offboarding', where only owners can enter it, and the worker exports the org's data: one JSON document per table
// plus a manifest with the stored files list, written to the blob store under the org's prefix. The export is recorded
// by the system command kernel.org.export.record (its audit row holds the manifest), and owners read it with
// kernel.org.export.get. Deleting the org's records is a later staff step; accounting records are kept for the legal
// retention period (docs/runbooks/org-offboarding.md has the deletion map).
import { sql } from 'kysely';
import { z } from 'zod';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand, defineQuery, fileKey } from '@crove/kernel-runtime';

const OWNERS: readonly MemberRole[] = ['owner'];

// The tables an export contains, with the columns left out. Machinery (idempotency keys, outbox, session records,
// inbound address tokens and drop counts) is not tenant data and stays out; so do secrets: the inbound token (the
// owner sees the address in the app) and invite token hashes. The snapshot reads as the system actor, so only tables
// an owner may read in full belong here.
export const EXPORT_TABLES = {
  'kernel.tenant': { from: 'crove_kernel.tenant', omit: ['inbound_token'] },
  'kernel.tenant_member': { from: 'crove_kernel.tenant_member', omit: [] },
  'kernel.member_invite': { from: 'crove_kernel.member_invite', omit: ['token_sha256'] },
  'kernel.party': { from: 'crove_kernel.party', omit: [] },
  'kernel.file': { from: 'crove_kernel.file', omit: [] },
  'kernel.inbound_message': { from: 'crove_kernel.inbound_message', omit: [] },
  'kernel.extraction': { from: 'crove_kernel.extraction', omit: [] },
  'kernel.proposal': { from: 'crove_kernel.proposal', omit: [] },
  'kernel.activity': { from: 'crove_kernel.activity', omit: [] },
  'kernel.audit_event': { from: 'crove_kernel.audit_event', omit: [] },
  'finance.purchase_document': { from: 'crove_finance.purchase_document', omit: [] },
  'finance.purchase_line': { from: 'crove_finance.purchase_line', omit: [] },
  'finance.journal_entry': { from: 'crove_finance.journal_entry', omit: [] },
  'finance.journal_line': { from: 'crove_finance.journal_line', omit: [] },
  'finance.vendor_account_rule': { from: 'crove_finance.vendor_account_rule', omit: [] },
} as const satisfies Record<string, { from: string; omit: readonly string[] }>;

export type ExportTable = keyof typeof EXPORT_TABLES;
export const EXPORT_TABLE_NAMES = Object.keys(EXPORT_TABLES) as [ExportTable, ...ExportTable[]];
export const zExportTable = z.enum(EXPORT_TABLE_NAMES);
export const EXPORT_FORMAT = 'crove.org-export.v1';
// Rows per table one export holds in memory. A larger table fails the export clearly (EXPORT_TOO_LARGE) until the
// export streams its rows (follow-up).
export const EXPORT_MAX_ROWS = 200_000;
// A new export request while the last one is younger than this and has not finished is refused.
export const EXPORT_REQUEST_COOLDOWN_MINUTES = 15;

const zSha256 = z.string().regex(/^[0-9a-f]{64}$/);
const zPart = z.object({
  table: zExportTable,
  key: z.string().max(200),
  sha256: zSha256,
  rows: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
});
export type ExportPart = z.infer<typeof zPart>;

const zExportRecord = z.object({
  manifestKey: z.string().max(200),
  manifestSha256: zSha256,
  fileCount: z.number().int().nonnegative(),
  parts: z.array(zPart).min(1).max(EXPORT_TABLE_NAMES.length),
});
export type ExportRecord = z.infer<typeof zExportRecord>;

// Moves the org to 'offboarding' (only owners can enter it from then on) and asks the worker for an export. The
// owner types the org's slug to confirm. Run again while offboarding, it only asks for a new export (for example after
// a failed one). R3: it takes the org out of service for everyone else, so it needs a fresh second factor (P11). A
// deferred trigger refuses the status change without this command's audit row.
export const offboardOrg = defineCommand({
  name: 'kernel.org.offboard',
  input: z.object({ confirmSlug: z.string().max(48) }),
  risk: 'R3',
  access: OWNERS,
  handler: async (ctx, input) => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ chủ sở hữu mới đóng được tổ chức');
    const tenant = await ctx.trx
      .selectFrom('crove_kernel.tenant')
      .select(['slug', 'status'])
      .where('org_id', '=', ctx.orgId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (tenant.slug !== input.confirmSlug) {
      throw new DomainError('SLUG_MISMATCH', 422, 'Mã tổ chức nhập vào không khớp; hãy nhập đúng mã để xác nhận');
    }
    if (tenant.status !== 'active' && tenant.status !== 'offboarding') {
      throw new DomainError('ORG_CLOSED', 409, 'Tổ chức đã đóng');
    }
    const started = tenant.status === 'active';
    if (!started) {
      // Asking again while an export is still being made only queues duplicate work.
      const { rows } = await sql<{ pending: boolean }>`
        SELECT EXISTS (
          SELECT 1 FROM crove_kernel.audit_event r
          WHERE r.org_id = ${ctx.orgId}::uuid AND r.command = 'kernel.org.offboard' AND r.outcome = 'ok'
            AND r.occurred_at > pg_catalog.now() - pg_catalog.make_interval(mins => ${EXPORT_REQUEST_COOLDOWN_MINUTES}::int)
            AND NOT EXISTS (
              SELECT 1 FROM crove_kernel.audit_event d
              WHERE d.org_id = r.org_id AND d.command = 'kernel.org.export.record' AND d.outcome = 'ok' AND d.occurred_at >= r.occurred_at
            )
        ) AS pending`.execute(ctx.trx);
      if (rows[0]?.pending) {
        throw new DomainError('EXPORT_PENDING', 409, 'Dữ liệu đang được xuất; hãy đợi bản xuất hiện tại xong rồi thử lại');
      }
    }
    if (started) {
      await ctx.trx.updateTable('crove_kernel.tenant').set({ status: 'offboarding' }).where('org_id', '=', ctx.orgId).execute();
    }
    ctx.audit({ previous_status: tenant.status, status: 'offboarding', export_requested: true });
    await ctx.activity(
      'kernel.org',
      ctx.orgId,
      started ? 'org.offboarding_started' : 'org.export_requested',
      started ? 'Bắt đầu đóng tổ chức; chỉ chủ sở hữu còn truy cập được, dữ liệu đang được xuất' : 'Yêu cầu xuất lại dữ liệu tổ chức',
    );
    await ctx.emit('kernel.org.export_requested', { requestedBy: ctx.actor.userId });
    return { status: 'offboarding' as const, exportRequested: true as const };
  },
});

// One table of the org, for the export job (system only). RLS keeps the rows to the org in context; the org_id filter
// says so explicitly.
export const exportSnapshot = defineQuery({
  name: 'kernel.org.export.snapshot',
  input: z.object({ table: zExportTable }),
  access: 'system',
  handler: async (ctx, input) => {
    const spec = EXPORT_TABLES[input.table];
    const omit = spec.omit as readonly string[];
    // spec.from is one of the constant names above, never input.
    const { rows } = await sql<{ row: Record<string, unknown> }>`
      SELECT to_jsonb(t) - ${sql.val([...omit])}::text[] AS row
      FROM ${sql.raw(spec.from)} t
      WHERE t.org_id = ${ctx.orgId}::uuid
      LIMIT ${EXPORT_MAX_ROWS + 1}`.execute(ctx.trx);
    return rows.map((r) => r.row);
  },
});

// Records a finished export (system only). Every key must be a content address under this org's prefix.
export const recordExport = defineCommand({
  name: 'kernel.org.export.record',
  input: zExportRecord,
  risk: 'R1',
  access: 'system',
  handler: async (ctx, input) => {
    const keys = [{ key: input.manifestKey, sha256: input.manifestSha256 }, ...input.parts];
    if (keys.some((k) => k.key !== fileKey(ctx.orgId, k.sha256))) {
      throw new DomainError('INVALID_STORAGE_KEY', 400, 'Khóa lưu trữ không hợp lệ');
    }
    ctx.audit({ manifest_key: input.manifestKey, manifest_sha256: input.manifestSha256, file_count: input.fileCount, parts: input.parts });
    await ctx.activity('kernel.org', ctx.orgId, 'org.export_ready', `Đã xuất dữ liệu tổ chức (${input.parts.length} bảng, ${input.fileCount} tệp)`);
    return { ok: true as const };
  },
});

export interface OrgExportView {
  status: 'active' | 'offboarding' | 'closed';
  requestedAt: string | null;
  export: {
    createdAt: string;
    manifestKey: string;
    manifestSha256: string;
    fileCount: number;
    parts: ExportPart[];
  } | null;
}

// The org's offboarding state and its newest export, for owners. Read from the audit rows of kernel.org.offboard and
// kernel.org.export.record. An export older than the newest request is still shown, so the owner always has the last
// one that finished.
export const orgExportGet = defineQuery({
  name: 'kernel.org.export.get',
  input: z.object({}),
  access: OWNERS,
  handler: async (ctx): Promise<OrgExportView> => {
    const tenant = await ctx.trx.selectFrom('crove_kernel.tenant').select('status').where('org_id', '=', ctx.orgId).executeTakeFirstOrThrow();
    const newest = (command: string) =>
      ctx.trx
        .selectFrom('crove_kernel.audit_event')
        .select(['occurred_at', 'detail'])
        .where('org_id', '=', ctx.orgId)
        .where('command', '=', command)
        .where('outcome', '=', 'ok')
        .orderBy('occurred_at', 'desc')
        .orderBy('id', 'desc')
        .limit(1)
        .executeTakeFirst();
    const requested = await newest('kernel.org.offboard');
    const recorded = await newest('kernel.org.export.record');
    const detail = recorded
      ? z
          .object({ manifest_key: z.string(), manifest_sha256: zSha256, file_count: z.number().int(), parts: z.array(zPart) })
          .safeParse(recorded.detail)
      : null;
    return {
      status: tenant.status,
      requestedAt: requested ? requested.occurred_at.toISOString() : null,
      export:
        recorded && detail?.success
          ? {
              createdAt: recorded.occurred_at.toISOString(),
              manifestKey: detail.data.manifest_key,
              manifestSha256: detail.data.manifest_sha256,
              fileCount: detail.data.file_count,
              parts: detail.data.parts,
            }
          : null,
    };
  },
});

export const offboardingCommands = [offboardOrg, recordExport];
export const offboardingQueries = [exportSnapshot, orgExportGet];
