// Org offboarding (issue #38, plan §7.9). The owner starts it with kernel.org.offboard (R3): the org moves to
// 'offboarding', where only owners can enter it, and the worker exports the org's data: every table as NDJSON (one row
// per line), streamed from one database snapshot and stored in bounded chunks, plus a manifest, all under the org's
// export prefix (export/<org_id>/) and encrypted at rest when the deployment has an export key (#212). The export is
// recorded by the system command kernel.org.export.record (its audit row lists the parts), owners read it with
// kernel.org.export.get, and the daily retention job deletes it after EXPORT_RETENTION_DAYS. Deleting the org's
// records is a later staff step; accounting records are kept for the legal retention period
// (docs/runbooks/org-offboarding.md has the deletion map).
import { sql } from 'kysely';
import { z } from 'zod';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand, defineQuery, exportKey, GENERATION_PATTERN } from '@crove/kernel-runtime';

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
  // The org chart and its work (ADR-0029). Runs, wake-ups, budgets and kill switches are machinery and stay out.
  'kernel.position': { from: 'crove_kernel.position', omit: [] },
  'kernel.agent': { from: 'crove_kernel.agent', omit: [] },
  'kernel.task': { from: 'crove_kernel.task', omit: [] },
  'kernel.task_comment': { from: 'crove_kernel.task_comment', omit: [] },
  // Connected channel accounts (ADR-0025). Their sealed tokens (crove_kernel.credential) are secrets and stay out.
  'kernel.channel_connection': { from: 'crove_kernel.channel_connection', omit: [] },
  'finance.purchase_document': { from: 'crove_finance.purchase_document', omit: [] },
  'finance.purchase_line': { from: 'crove_finance.purchase_line', omit: [] },
  'finance.journal_entry': { from: 'crove_finance.journal_entry', omit: [] },
  'finance.journal_line': { from: 'crove_finance.journal_line', omit: [] },
  'finance.vendor_account_rule': { from: 'crove_finance.vendor_account_rule', omit: [] },
  'social.post': { from: 'crove_social.post', omit: [] },
  'social.post_variant': { from: 'crove_social.post_variant', omit: [] },
  'social.post_approval': { from: 'crove_social.post_approval', omit: [] },
  'social.queue': { from: 'crove_social.queue', omit: [] },
  'social.queue_slot': { from: 'crove_social.queue_slot', omit: [] },
} as const satisfies Record<string, { from: string; omit: readonly string[] }>;

export type ExportTable = keyof typeof EXPORT_TABLES;
export const EXPORT_TABLE_NAMES = Object.keys(EXPORT_TABLES) as [ExportTable, ...ExportTable[]];
export const zExportTable = z.enum(EXPORT_TABLE_NAMES);
// v2 (#212): NDJSON chunks under export/<org_id>/, sealed (see apps/kernel/src/export-seal.ts). v1 exports (one JSON
// document per table under org/<org_id>/) are no longer served; the owner asks for a new export.
export const EXPORT_FORMAT = 'crove.org-export.v2';
// Rows per FETCH from the export cursor: the most one batch holds in memory.
export const EXPORT_FETCH_ROWS = 1000;
// Chunks one export may record (with the default 8 MiB chunks, 16 GiB of NDJSON); the audit row of the record lists
// them all. Past it the export fails with EXPORT_TOO_LARGE.
export const EXPORT_MAX_PARTS = 2048;
// How long an export is kept (plan §7.9: 35 to 90 days); the deployment picks within the range (EXPORT_RETENTION_DAYS).
export const EXPORT_RETENTION_MIN_DAYS = 35;
export const EXPORT_RETENTION_MAX_DAYS = 90;
// A new export request while the last one is younger than this and has not finished is refused.
export const EXPORT_REQUEST_COOLDOWN_MINUTES = 15;

const zSha256 = z.string().regex(/^[0-9a-f]{64}$/);
const zGeneration = z.string().regex(GENERATION_PATTERN);
// One stored chunk of a table: rows `rows` of the table, in order after the chunks with a lower number. sha256 is of
// the stored (sealed) bytes, bytes the size of the NDJSON inside.
const zPart = z.object({
  table: zExportTable,
  chunk: z.number().int().nonnegative().max(EXPORT_MAX_PARTS),
  key: z.string().max(200),
  sha256: zSha256,
  generation: zGeneration,
  rows: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
});
export type ExportPart = z.infer<typeof zPart>;
export const zExportEncryption = z.enum(['aes-256-gcm', 'none']);
export type ExportEncryption = z.infer<typeof zExportEncryption>;

const zExportRecord = z
  .object({
    format: z.literal(EXPORT_FORMAT),
    manifestKey: z.string().max(200),
    manifestSha256: zSha256,
    manifestGeneration: zGeneration,
    fileCount: z.number().int().nonnegative(),
    encryption: zExportEncryption,
    expiresAt: z.iso.datetime(),
    parts: z.array(zPart).min(EXPORT_TABLE_NAMES.length).max(EXPORT_MAX_PARTS),
  })
  .superRefine((record, ctx) => {
    // Every table, each with chunks 0..n-1 in order: the download concatenates them.
    let index = 0;
    for (const table of EXPORT_TABLE_NAMES) {
      let chunk = 0;
      while (record.parts[index]?.table === table) {
        if (record.parts[index]?.chunk !== chunk) ctx.addIssue({ code: 'custom', message: `chunks of ${table} out of order`, path: ['parts', index] });
        index++;
        chunk++;
      }
      if (chunk === 0) ctx.addIssue({ code: 'custom', message: `no chunk for ${table}`, path: ['parts'] });
    }
    if (index !== record.parts.length) ctx.addIssue({ code: 'custom', message: 'parts in an unexpected order', path: ['parts', index] });
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
          WHERE r.org_id = ${ctx.orgId}::uuid AND r.command = 'kernel.org.offboard' AND r.outcome = 'ok' AND r.actor_type <> 'agent'
            AND r.occurred_at > pg_catalog.now() - pg_catalog.make_interval(mins => ${EXPORT_REQUEST_COOLDOWN_MINUTES}::int)
            AND NOT EXISTS (
              SELECT 1 FROM crove_kernel.audit_event d
              WHERE d.org_id = r.org_id AND d.command = 'kernel.org.export.record' AND d.outcome = 'ok' AND d.actor_type <> 'agent'
                AND d.occurred_at >= r.occurred_at
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

// One batch of a streamed export: up to EXPORT_FETCH_ROWS rows of one table as JSON text, in table order. `last` is
// set on the table's final batch (which may be empty).
export interface ExportBatch {
  table: ExportTable;
  lines: string[];
  last: boolean;
}

// The org's tables for the export job (system only), streamed: a server-side cursor per table hands out
// EXPORT_FETCH_ROWS rows at a time to the sink, which stores them before the next FETCH, so memory stays bounded
// whatever the table's size. Runtime.stream() runs it in one REPEATABLE READ, READ ONLY transaction: every table is
// read from the same snapshot, so the parts agree with each other (no journal line without its entry, no file row
// added between two tables). RLS keeps the rows to the org in context; the org_id filter says so explicitly. With
// `table` it streams that table only.
export const exportSnapshot = defineQuery({
  name: 'kernel.org.export.snapshot',
  input: z.object({ table: zExportTable.optional() }),
  access: 'system',
  stream: true,
  handler: async (ctx, input, sink) => {
    if (!sink) throw new DomainError('STREAM_ONLY', 400, 'Truy vấn này chỉ đọc theo luồng');
    const tables = input.table ? [input.table] : EXPORT_TABLE_NAMES;
    let rows = 0;
    for (const table of tables) {
      const spec = EXPORT_TABLES[table];
      const omit = spec.omit as readonly string[];
      // spec.from is one of the constant names above, never input.
      await sql`
        DECLARE crove_org_export NO SCROLL CURSOR FOR
        SELECT (to_jsonb(t) - ${sql.val([...omit])}::text[])::text AS line
        FROM ${sql.raw(spec.from)} t
        WHERE t.org_id = ${ctx.orgId}::uuid`.execute(ctx.trx);
      for (;;) {
        const batch = await sql<{ line: string }>`FETCH ${sql.raw(String(EXPORT_FETCH_ROWS))} FROM crove_org_export`.execute(ctx.trx);
        const last = batch.rows.length < EXPORT_FETCH_ROWS;
        rows += batch.rows.length;
        await sink({ table, lines: batch.rows.map((r) => r.line), last } satisfies ExportBatch);
        if (last) break;
      }
      await sql`CLOSE crove_org_export`.execute(ctx.trx);
    }
    return { tables: tables.length, rows };
  },
});

// Records a finished export (system only). Every key must be a content address under this org's export prefix, and the
// parts must name every table with its chunks in order.
export const recordExport = defineCommand({
  name: 'kernel.org.export.record',
  input: zExportRecord,
  risk: 'R1',
  access: 'system',
  handler: async (ctx, input) => {
    const keys = [{ key: input.manifestKey, sha256: input.manifestSha256 }, ...input.parts];
    if (keys.some((k) => k.key !== exportKey(ctx.orgId, k.sha256))) {
      throw new DomainError('INVALID_STORAGE_KEY', 400, 'Khóa lưu trữ không hợp lệ');
    }
    ctx.audit({
      format: input.format,
      manifest_key: input.manifestKey,
      manifest_sha256: input.manifestSha256,
      manifest_generation: input.manifestGeneration,
      file_count: input.fileCount,
      encryption: input.encryption,
      expires_at: input.expiresAt,
      parts: input.parts,
    });
    await ctx.activity(
      'kernel.org',
      ctx.orgId,
      'org.export_ready',
      `Đã xuất dữ liệu tổ chức (${EXPORT_TABLE_NAMES.length} bảng, ${input.parts.length} phần, ${input.fileCount} tệp)`,
    );
    return { ok: true as const };
  },
});

// One table of an export, for the settings screen.
export interface ExportTableSummary {
  table: ExportTable;
  rows: number;
  bytes: number;
  chunks: number;
}

export interface OrgExportView {
  status: 'active' | 'offboarding' | 'closed';
  requestedAt: string | null;
  export: {
    createdAt: string;
    expiresAt: string;
    // The download route refuses an expired export even before the retention job deletes it.
    expired: boolean;
    encryption: ExportEncryption;
    manifestKey: string;
    manifestSha256: string;
    manifestGeneration: string;
    fileCount: number;
    parts: ExportPart[];
    tables: ExportTableSummary[];
  } | null;
}

function summarize(parts: readonly ExportPart[]): ExportTableSummary[] {
  return EXPORT_TABLE_NAMES.map((table) => {
    const own = parts.filter((p) => p.table === table);
    return { table, rows: own.reduce((n, p) => n + p.rows, 0), bytes: own.reduce((n, p) => n + p.bytes, 0), chunks: own.length };
  });
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
        // An agent never runs these commands; its audit rows never stand for them (issue #285).
        .where('actor_type', '<>', 'agent')
        .orderBy('occurred_at', 'desc')
        .orderBy('id', 'desc')
        .limit(1)
        .executeTakeFirst();
    const requested = await newest('kernel.org.offboard');
    const recorded = await newest('kernel.org.export.record');
    // A v1 record (before #212) does not parse and reads as no export.
    const detail = recorded
      ? z
          .object({
            format: z.literal(EXPORT_FORMAT),
            manifest_key: z.string(),
            manifest_sha256: zSha256,
            manifest_generation: zGeneration,
            file_count: z.number().int(),
            encryption: zExportEncryption,
            expires_at: z.iso.datetime(),
            parts: z.array(zPart),
          })
          .safeParse(recorded.detail)
      : null;
    return {
      status: tenant.status,
      requestedAt: requested ? requested.occurred_at.toISOString() : null,
      export:
        recorded && detail?.success
          ? {
              createdAt: recorded.occurred_at.toISOString(),
              expiresAt: detail.data.expires_at,
              expired: Date.parse(detail.data.expires_at) <= Date.now(),
              encryption: detail.data.encryption,
              manifestKey: detail.data.manifest_key,
              manifestSha256: detail.data.manifest_sha256,
              manifestGeneration: detail.data.manifest_generation,
              fileCount: detail.data.file_count,
              parts: detail.data.parts,
              tables: summarize(detail.data.parts),
            }
          : null,
    };
  },
});

export const offboardingCommands = [offboardOrg, recordExport];
// A day past an export's expiresAt its blobs may go: the download already refuses it, and the daily job never runs
// ahead of the date the owner was shown.
export const EXPORT_EXPIRY_GRACE_HOURS = 24;

// The blob keys of the org's exports that have not expired yet (plus the grace day), for the retention job (system
// only). Every other export blob of the org (an expired export, or a failed attempt that was never recorded) may be
// deleted. Read from the audit rows of kernel.org.export.record, so the date the owner was shown decides, whatever the
// deployment's EXPORT_RETENTION_DAYS is today.
export const exportLiveKeys = defineQuery({
  name: 'kernel.org.export.live_keys',
  input: z.object({}),
  access: 'system',
  handler: async (ctx): Promise<string[]> => {
    const { rows } = await sql<{ key: string }>`
      SELECT k.key FROM crove_kernel.audit_event r
      CROSS JOIN LATERAL (
        SELECT r.detail->>'manifest_key' AS key
        UNION ALL
        SELECT p->>'key' FROM pg_catalog.jsonb_array_elements(r.detail->'parts') p
      ) k
      WHERE r.org_id = ${ctx.orgId}::uuid AND r.command = 'kernel.org.export.record' AND r.outcome = 'ok' AND r.actor_type <> 'agent'
        AND r.detail->>'format' = ${EXPORT_FORMAT}
        AND (r.detail->>'expires_at')::timestamptz > pg_catalog.now() - pg_catalog.make_interval(hours => ${EXPORT_EXPIRY_GRACE_HOURS}::int)
        AND k.key IS NOT NULL`.execute(ctx.trx);
    return rows.map((r) => r.key);
  },
});

export const offboardingQueries = [exportSnapshot, orgExportGet, exportLiveKeys];
