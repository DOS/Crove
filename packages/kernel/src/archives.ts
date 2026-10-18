// Bulk intake (issue #314): a ZIP archive of documents. The API stores the archive as a file like any upload
// (kernel.file.ingest, created by the uploading member); the worker has it opened in the parsing sandbox, sniffs and
// stores every entry, and records them here in one transaction: each entry becomes a file of its own, created by the
// member who uploaded the archive, and goes to extraction like an upload. The archive's single extraction run (method
// 'archive') keeps what each entry became. An archive is opened once; it is never read again and never has a proposal.
import { z } from 'zod';
import { ACCEPTED_UPLOAD_TYPES, ARCHIVE_ENTRY_REASONS, MAX_BATCH_FILES, zId, type BatchFile, type FileStatus } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand, defineQuery } from '@crove/kernel-runtime';
import { fileStatuses, type StoredArchiveEntry } from './file-status.ts';
import { ingestFileRow, isArchiveType, zIngestFile } from './files.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];

// Entries one archive may file: the sandbox's limit (EXTRACT_LIMITS.maxArchiveEntries, directories included).
export const MAX_ARCHIVE_ENTRIES = 500;
// Entries of opened archives whose files one batch query resolves; past it an entry's file reads as null.
export const MAX_BATCH_ENTRIES = 2000;

// The archive to open (worker only): null when the file is not an archive. expanded: it already has its run.
export const archiveSource = defineQuery({
  name: 'kernel.file.archive.source',
  input: z.object({ fileId: zId }),
  access: 'system',
  handler: async (ctx, input) => {
    const file = await ctx.trx
      .selectFrom('crove_kernel.file')
      .select(['id', 'filename', 'content_type', 'storage_key', 'generation', 'sha256'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.fileId)
      .executeTakeFirst();
    if (!file || !isArchiveType(file.content_type)) return null;
    const run = await ctx.trx.selectFrom('crove_kernel.extraction').select('id').where('org_id', '=', ctx.orgId).where('file_id', '=', file.id).limit(1).executeTakeFirst();
    return { ...file, expanded: Boolean(run) };
  },
});

const zEntryName = z.string().min(1).max(255);
const zArchivedFile = zIngestFile.pick({ filename: true, contentType: true, sizeBytes: true, sha256: true, storageKey: true, generation: true });
const zArchiveEntryInput = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('stored'), name: zEntryName, file: zArchivedFile }),
  z.object({ outcome: z.literal('rejected'), name: zEntryName, reason: z.enum(ARCHIVE_ENTRY_REASONS) }),
]);
export type ArchiveEntryInput = z.infer<typeof zArchiveEntryInput>;

// The order the stored entries of an archive are filed in: by sha256, then by their place in the archive. Filing
// locks each file row (an existing one FOR UPDATE, a new one by its unique key), so two archives that share files take
// those locks in the same order and never deadlock, whatever order their directories list them in; among entries
// with the same bytes the first in the archive is the one filed, the others are its duplicates.
export function archiveIngestOrder(entries: readonly ArchiveEntryInput[]): number[] {
  return entries
    .flatMap((entry, index) => (entry.outcome === 'stored' ? [{ index, sha256: entry.file.sha256 }] : []))
    .sort((a, b) => (a.sha256 < b.sha256 ? -1 : a.sha256 > b.sha256 ? 1 : a.index - b.index))
    .map((item) => item.index);
}

// Records the opening of an archive (worker only): done with its entries, or failed with the reason (then no entry).
// A no-op once the archive has its run, so a retried job never files the entries twice.
export const recordArchive = defineCommand({
  name: 'kernel.file.archive.record',
  input: z
    .object({
      fileId: zId,
      status: z.enum(['done', 'failed']),
      error: z.string().max(2000).nullable(),
      entries: z.array(zArchiveEntryInput).max(MAX_ARCHIVE_ENTRIES),
    })
    .refine((input) => input.status === 'done' || input.entries.length === 0, 'a failed opening files no entry'),
  risk: 'R1',
  access: 'system',
  target: (input) => ({ type: 'kernel.file', id: input.fileId }),
  handler: async (ctx, input) => {
    const archive = await ctx.trx
      .selectFrom('crove_kernel.file')
      .select(['id', 'filename', 'content_type', 'created_by'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.fileId)
      .forUpdate()
      .executeTakeFirst();
    if (!archive) throw new DomainError('NOT_FOUND', 404, 'Không tìm thấy tệp');
    if (!isArchiveType(archive.content_type)) throw new DomainError('NOT_ARCHIVE', 409, 'Tệp này không phải tệp ZIP');
    const existing = await ctx.trx.selectFrom('crove_kernel.extraction').select('id').where('org_id', '=', ctx.orgId).where('file_id', '=', archive.id).limit(1).executeTakeFirst();
    if (existing) return { extractionId: existing.id, duplicate: true, fileIds: [] as string[] };

    const entries: StoredArchiveEntry[] = input.entries.map((entry) => ({
      name: entry.name,
      outcome: 'rejected' as const,
      reason: entry.outcome === 'rejected' ? entry.reason : 'unsupported_type',
      fileId: null,
    }));
    for (const index of archiveIngestOrder(input.entries)) {
      const entry = input.entries[index];
      // The worker sniffed the type from the bytes; only documents are filed, whatever it sends.
      if (!entry || entry.outcome !== 'stored' || !ACCEPTED_UPLOAD_TYPES.includes(entry.file.contentType)) continue;
      // The archive's uploader is the creator of every entry, so approval counts them as an author of each invoice
      // read from it (P10), exactly as if they had uploaded the files one by one.
      const filed = await ingestFileRow(ctx, { ...entry.file, source: 'upload' }, archive.created_by);
      entries[index] = { name: entry.name, outcome: filed.duplicate ? 'duplicate' : 'stored', reason: null, fileId: filed.fileId };
    }
    const run = await ctx.trx
      .insertInto('crove_kernel.extraction')
      .values({
        org_id: ctx.orgId,
        file_id: archive.id,
        method: 'archive',
        status: input.status,
        result: JSON.stringify({ entries }),
        checks: '[]',
        error: input.error,
        completed_at: ctx.now,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const count = (outcome: StoredArchiveEntry['outcome']) => entries.filter((e) => e.outcome === outcome).length;
    const stored = count('stored');
    const duplicate = count('duplicate');
    const rejected = count('rejected');
    ctx.audit({ status: input.status, stored, duplicate, rejected });
    if (input.status === 'done') {
      await ctx.activity('kernel.file', archive.id, 'archive.expanded', `Mở ${archive.filename}: ${stored} tệp mới, ${duplicate} tệp đã có, ${rejected} tệp bỏ qua`);
    } else {
      await ctx.activity('kernel.file', archive.id, 'extraction.failed', input.error ?? 'Không mở được tệp ZIP');
    }
    return { extractionId: run.id, duplicate: false, fileIds: entries.flatMap((e) => (e.fileId ? [e.fileId] : [])) };
  },
});

// The files of an upload batch, as the SPA tracks them (#314): each file's status, and for an opened archive what each
// entry became, with the entry's own file status. Ids of other orgs, unknown ids and Social images read as missing.
export const filesBatch = defineQuery({
  name: 'kernel.files.batch',
  input: z.object({ ids: z.array(zId).min(1).max(MAX_BATCH_FILES) }),
  access: ALL,
  handler: async (ctx, input): Promise<BatchFile[]> => {
    const rows = new Map((await fileStatuses(ctx, { ids: [...new Set(input.ids)] })).map((row) => [row.status.id, row]));
    const childIds = [...new Set([...rows.values()].flatMap((row) => (row.entries ?? []).flatMap((e) => (e.fileId ? [e.fileId] : []))))].slice(0, MAX_BATCH_ENTRIES);
    const children = new Map<string, FileStatus>();
    for (let i = 0; i < childIds.length; i += MAX_BATCH_FILES) {
      for (const row of await fileStatuses(ctx, { ids: childIds.slice(i, i + MAX_BATCH_FILES) })) children.set(row.status.id, row.status);
    }
    return input.ids.flatMap((id) => {
      const row = rows.get(id);
      if (!row) return [];
      rows.delete(id);
      return [
        {
          ...row.status,
          entries: row.entries ? row.entries.map((e) => ({ name: e.name, outcome: e.outcome, reason: e.reason, file: e.fileId ? (children.get(e.fileId) ?? null) : null })) : null,
        },
      ];
    });
  },
});

export const archiveQueries = [archiveSource, filesBatch];
export const archiveCommands = [recordArchive];
