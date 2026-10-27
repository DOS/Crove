// Fiscal year archive packages (issue #922, plan §7.9 "Legal retention", Accounting Law 88/2015 Art. 41): once every
// month of a year is locked, an owner asks for the year's package; the worker builds it once and it is kept for the
// legal retention period (at least 10 years). The fiscal year is the calendar year.
// - finance.archive.build: owners only, R3 (fresh MFA). Refuses a year with an unlocked month, a year already built and
//   a request still in progress; asks the worker through the finance.archive_requested event.
// - finance.archive.source: the worker's inputs (system only): the org's slug and VAT filing period, the lock, and the
//   original file of every document whose entry falls in the year.
// - finance.archive.record: the worker records the built package (system only): the manifest's key, version and
//   sha256, as the audit row of the build. A second record of the same year is ignored.
// - finance.archive.list and finance.archive.get: owners read the packages, from those audit rows.
// The package's parts are content-addressed blobs under archive/<org_id>/<year>/ (never listed, never deleted by Crove).
import { sql } from 'kysely';
import { z } from 'zod';
import type { MemberRole } from '@crove/db';
import { zArchiveYear, type YearArchive, type YearArchives } from '@crove/kernel-contract';
import { DomainError, archiveKey, defineCommand, defineQuery, type QueryContext } from '@crove/kernel-runtime';

const OWNERS: readonly MemberRole[] = ['owner'];
// A request the worker has not recorded within this long is shown as failed and may be asked again.
export const ARCHIVE_REQUEST_COOLDOWN_MINUTES = 60;
export const ARCHIVE_FORMAT = 'crove-year-archive-v1';

const zSha256 = z.string().regex(/^[0-9a-f]{64}$/);
const zGeneration = z.string().min(1).max(200);

// The detail of a finance.archive.record audit row.
const zRecorded = z.object({
  format: z.literal(ARCHIVE_FORMAT),
  year: zArchiveYear,
  manifest_key: z.string(),
  manifest_sha256: zSha256,
  manifest_generation: zGeneration,
  parts: z.number().int(),
  documents: z.number().int(),
});

export interface RecordedArchive {
  year: number;
  builtAt: string;
  manifestKey: string;
  manifestSha256: string;
  manifestGeneration: string;
  parts: number;
  documents: number;
}

// The audit rows of one command for the org, newest first (all years, or one).
async function auditRows(ctx: QueryContext, command: string, year?: number) {
  let query = ctx.trx
    .selectFrom('crove_kernel.audit_event')
    .select(['occurred_at', 'detail', 'command_id'])
    .where('org_id', '=', ctx.orgId)
    .where('command', '=', command)
    .where('outcome', '=', 'ok')
    // An agent never runs these commands; its audit rows never stand for them (issue #285).
    .where('actor_type', '<>', 'agent');
  if (year !== undefined) query = query.where(sql<string>`detail ->> 'year'`, '=', String(year));
  return query.orderBy('occurred_at', 'desc').orderBy('id', 'desc').execute();
}

function recorded(row: { occurred_at: Date; detail: unknown }): RecordedArchive | null {
  const detail = zRecorded.safeParse(row.detail);
  if (!detail.success) return null;
  return {
    year: detail.data.year,
    builtAt: row.occurred_at.toISOString(),
    manifestKey: detail.data.manifest_key,
    manifestSha256: detail.data.manifest_sha256,
    manifestGeneration: detail.data.manifest_generation,
    parts: detail.data.parts,
    documents: detail.data.documents,
  };
}

// How far the books are locked. The package holds the documents of every legal entity of the org (#1280), so it is
// the earliest lock of all of them: an entity that has posted and never locked leaves the year open. Owners see every
// entity.
async function lockedThrough(ctx: QueryContext): Promise<string | null> {
  const rows = await ctx.trx.selectFrom('crove_finance.period_lock').select('locked_through').where('org_id', '=', ctx.orgId).execute();
  if (rows.length === 0 || rows.some((r) => r.locked_through === null)) return null;
  return rows.map((r) => r.locked_through as string).sort()[0] ?? null;
}

async function archiveOf(ctx: QueryContext, year: number): Promise<YearArchive | null> {
  const built = (await auditRows(ctx, 'finance.archive.record', year)).map(recorded).find((r) => r !== null);
  if (built) {
    return { year, state: 'built', requestedAt: null, builtAt: built.builtAt, manifestSha256: built.manifestSha256, parts: built.parts, documents: built.documents };
  }
  const requested = (await auditRows(ctx, 'finance.archive.build', year))[0];
  if (!requested) return null;
  return { year, state: 'requested', requestedAt: requested.occurred_at.toISOString(), builtAt: null, manifestSha256: null, parts: null, documents: null };
}

export const yearArchiveBuild = defineCommand({
  name: 'finance.archive.build',
  input: z.object({ year: zArchiveYear }),
  risk: 'R3',
  // Asks for the year's legal retention package (Accounting Law Art. 41), built once and never deleted by Crove.
  sideEffect: 'legal',
  access: OWNERS,
  handler: async (ctx, input): Promise<YearArchive> => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ chủ sở hữu mới đóng gói lưu trữ được');
    // One request per org and year at a time: two owners asking at once queue one build.
    await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`finance.archive:${ctx.orgId}:${input.year}`}, 0))`.execute(ctx.trx);
    const through = await lockedThrough(ctx);
    if (!through || through < `${input.year}-12-31`) {
      throw new DomainError('ARCHIVE_YEAR_OPEN', 422, `Năm ${input.year} còn tháng chưa khóa sổ; hãy khóa sổ đến tháng 12/${input.year} rồi đóng gói lưu trữ`);
    }
    const current = await archiveOf(ctx, input.year);
    if (current?.state === 'built') {
      throw new DomainError('ARCHIVE_EXISTS', 409, `Năm ${input.year} đã được đóng gói lưu trữ; gói lưu trữ chỉ tạo một lần`);
    }
    if (current?.requestedAt && Date.parse(current.requestedAt) > Date.now() - ARCHIVE_REQUEST_COOLDOWN_MINUTES * 60_000) {
      throw new DomainError('ARCHIVE_PENDING', 409, `Gói lưu trữ năm ${input.year} đang được tạo; hãy đợi xong rồi xem lại`);
    }
    ctx.audit({ year: input.year, locked_through: through });
    await ctx.activity('finance.archive', ctx.orgId, 'archive.requested', `Yêu cầu đóng gói lưu trữ năm ${input.year}`);
    await ctx.emit('finance.archive_requested', { year: input.year, requestCommandId: ctx.commandId });
    return { year: input.year, state: 'requested', requestedAt: ctx.now.toISOString(), builtAt: null, manifestSha256: null, parts: null, documents: null };
  },
});

export interface ArchiveSourceFile {
  id: string;
  filename: string;
  contentType: string;
  key: string;
  generation: string | null;
  sha256: string;
}

export interface ArchiveSource {
  orgSlug: string;
  vatFilingPeriod: 'month' | 'quarter' | null;
  hasTaxCode: boolean;
  lockedThrough: string | null;
  // The package already recorded for the year, if any: the worker builds nothing more (a job retried after its record).
  recorded: RecordedArchive | null;
  // The original file of every document (purchase or sale) whose entry is dated in the year, once each.
  files: ArchiveSourceFile[];
  // The legal entities whose books go in the package (#1280): the default entity, then every other entity with an entry
  // dated up to the year's end. Each gets its own journal, ledger, statements and VAT working.
  legalEntities: Array<{ id: string; isDefault: boolean }>;
}

export const yearArchiveSource = defineQuery({
  name: 'finance.archive.source',
  input: z.object({ year: zArchiveYear }),
  access: 'system',
  handler: async (ctx, input): Promise<ArchiveSource> => {
    const tenant = await ctx.trx
      .selectFrom('crove_kernel.tenant')
      .select(['slug', 'vat_filing_period', 'tax_code'])
      .where('org_id', '=', ctx.orgId)
      .executeTakeFirstOrThrow();
    const files = await ctx.trx
      .selectFrom('crove_finance.journal_entry as j')
      .innerJoin('crove_finance.purchase_document as d', (join) => join.onRef('d.org_id', '=', 'j.org_id').onRef('d.id', '=', 'j.source_id'))
      .innerJoin('crove_kernel.file as f', (join) => join.onRef('f.org_id', '=', 'd.org_id').onRef('f.id', '=', 'd.source_file_id'))
      .select(['f.id', 'f.filename', 'f.content_type', 'f.storage_key', 'f.generation', 'f.sha256'])
      .distinct()
      .where('j.org_id', '=', ctx.orgId)
      .where('j.source_type', '=', 'finance.purchase_document')
      .where('j.entry_date', '>=', `${input.year}-01-01`)
      .where('j.entry_date', '<=', `${input.year}-12-31`)
      .orderBy('f.id')
      .execute();
    const legalEntities = await ctx.trx
      .selectFrom('crove_kernel.legal_entity as e')
      .select(['e.id', 'e.is_default'])
      .where('e.org_id', '=', ctx.orgId)
      .where((eb) =>
        eb.or([
          eb('e.is_default', '=', true),
          eb.exists(
            eb
              .selectFrom('crove_finance.journal_entry as j')
              .select('j.id')
              .whereRef('j.org_id', '=', 'e.org_id')
              .whereRef('j.legal_entity_id', '=', 'e.id')
              .where('j.entry_date', '<=', `${input.year}-12-31`),
          ),
        ]),
      )
      .orderBy('e.is_default', 'desc')
      .orderBy('e.id')
      .execute();
    return {
      orgSlug: tenant.slug,
      vatFilingPeriod: tenant.vat_filing_period,
      hasTaxCode: tenant.tax_code !== null,
      lockedThrough: await lockedThrough(ctx),
      recorded: (await auditRows(ctx, 'finance.archive.record', input.year)).map(recorded).find((r) => r !== null) ?? null,
      files: files.map((f) => ({ id: f.id, filename: f.filename, contentType: f.content_type, key: f.storage_key, generation: f.generation, sha256: f.sha256 })),
      legalEntities: legalEntities.map((e) => ({ id: e.id, isDefault: e.is_default })),
    };
  },
});

export const zArchiveRecord = z.object({
  year: zArchiveYear,
  manifestKey: z.string().max(200),
  manifestSha256: zSha256,
  manifestGeneration: zGeneration,
  parts: z.number().int().min(0),
  documents: z.number().int().min(0),
});

export const yearArchiveRecord = defineCommand({
  name: 'finance.archive.record',
  input: zArchiveRecord,
  risk: 'R1',
  // Records, as its audit row, the package the worker already wrote; the package itself is build's effect. R3 here
  // would put the worker under P13 (a system R3 needs an approved proposal), which the plan does not call for.
  sideEffect: 'internal',
  access: 'system',
  handler: async (ctx, input): Promise<{ recorded: boolean }> => {
    if (input.manifestKey !== archiveKey(ctx.orgId, input.year, input.manifestSha256)) {
      throw new DomainError('INVALID_STORAGE_KEY', 422, 'Khóa lưu trữ của gói không hợp lệ');
    }
    await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`finance.archive:${ctx.orgId}:${input.year}`}, 0))`.execute(ctx.trx);
    // Written once: a second build of the same year (two workers at once) keeps the first record.
    if ((await archiveOf(ctx, input.year))?.state === 'built') {
      ctx.audit({ year: input.year, duplicate: true, manifest_key: input.manifestKey });
      return { recorded: false };
    }
    ctx.audit({
      format: ARCHIVE_FORMAT,
      year: input.year,
      manifest_key: input.manifestKey,
      manifest_sha256: input.manifestSha256,
      manifest_generation: input.manifestGeneration,
      parts: input.parts,
      documents: input.documents,
    });
    await ctx.activity('finance.archive', ctx.orgId, 'archive.built', `Đã đóng gói lưu trữ năm ${input.year} (${input.documents} chứng từ gốc)`);
    return { recorded: true };
  },
});

export const yearArchiveList = defineQuery({
  name: 'finance.archive.list',
  input: z.object({}),
  access: OWNERS,
  handler: async (ctx): Promise<YearArchives> => {
    const years = new Set<number>();
    for (const command of ['finance.archive.build', 'finance.archive.record']) {
      for (const row of await auditRows(ctx, command)) {
        const year = zArchiveYear.safeParse((row.detail as { year?: unknown } | null)?.year);
        if (year.success) years.add(year.data);
      }
    }
    const archives: YearArchive[] = [];
    for (const year of [...years].sort((a, b) => b - a)) {
      const archive = await archiveOf(ctx, year);
      if (archive) archives.push(archive);
    }
    return { lockedThrough: await lockedThrough(ctx), archives };
  },
});

// The recorded package of a year, for the download route and the verification (owners, and the system).
export const yearArchiveGet = defineQuery({
  name: 'finance.archive.get',
  input: z.object({ year: zArchiveYear }),
  access: OWNERS,
  handler: async (ctx, input): Promise<RecordedArchive | null> =>
    (await auditRows(ctx, 'finance.archive.record', input.year)).map(recorded).find((r) => r !== null) ?? null,
});

export const yearArchiveCommands = [yearArchiveBuild, yearArchiveRecord];
export const yearArchiveQueries = [yearArchiveSource, yearArchiveList, yearArchiveGet];
