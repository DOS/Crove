// Bulk intake (issue #314): a ZIP archive of documents. The API stores the archive as a file like any upload
// (kernel.file.ingest, created by the uploading member), and so does inbound email for a ZIP attachment (#432, no
// creator); the worker has it opened in the parsing sandbox, sniffs and stores every entry, and records them here in
// one transaction: each entry becomes a file of its own, created by the member who uploaded the archive, and goes to
// extraction like an upload. The archive's single extraction run (method
// 'archive') keeps what each entry became. An archive is opened once; it is never read again and never has a proposal.
import { z } from 'zod';
import { ACCEPTED_UPLOAD_TYPES, ARCHIVE_ENTRY_REASONS, MAX_BATCH_ENTRIES, MAX_BATCH_FILES, MAX_EMAIL_ARCHIVE_DOCUMENTS, zId, type BatchFile, type FileStatus } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand, defineQuery } from '@crove/kernel-runtime';
import { archiveEntries, fileStatuses, type StoredArchiveEntry } from './file-status.ts';
import { uploaderEntity } from './extraction.ts';
import { ingestFileRow, isArchiveType, zIngestFile } from './files.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];

// Entries one archive may file: the sandbox's limit (EXTRACT_LIMITS.maxArchiveEntries, directories included).
export const MAX_ARCHIVE_ENTRIES = 500;

// The archive to open (worker only): null when the file is not an archive. expanded: it already has its run.
export const archiveSource = defineQuery({
  name: 'kernel.file.archive.source',
  input: z.object({ fileId: zId }),
  access: 'system',
  handler: async (ctx, input) => {
    const file = await ctx.trx
      .selectFrom('crove_kernel.file')
      .select(['id', 'filename', 'content_type', 'storage_key', 'generation', 'sha256', 'source'])
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
  sideEffect: 'internal',
  access: 'system',
  target: (input) => ({ type: 'kernel.file', id: input.fileId }),
  handler: async (ctx, input) => {
    const archive = await ctx.trx
      .selectFrom('crove_kernel.file')
      .select(['id', 'filename', 'content_type', 'created_by', 'source'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.fileId)
      .forUpdate()
      .executeTakeFirst();
    if (!archive) throw new DomainError('NOT_FOUND', 404, 'Không tìm thấy tệp');
    if (!isArchiveType(archive.content_type)) throw new DomainError('NOT_ARCHIVE', 409, 'Tệp này không phải tệp ZIP');
    const existing = await ctx.trx.selectFrom('crove_kernel.extraction').select('id').where('org_id', '=', ctx.orgId).where('file_id', '=', archive.id).limit(1).executeTakeFirst();
    if (existing) return { extractionId: existing.id, duplicate: true, fileIds: [] as string[] };

    // An archive that came by email (#432) files its entries as email attachments, and only its first
    // MAX_EMAIL_ARCHIVE_DOCUMENTS documents in archive order: anyone who knows the org's address can send one.
    const email = archive.source === 'email';
    const fileable = (entry: ArchiveEntryInput | undefined): entry is Extract<ArchiveEntryInput, { outcome: 'stored' }> =>
      entry?.outcome === 'stored' && ACCEPTED_UPLOAD_TYPES.includes(entry.file.contentType);
    const overLimit = new Set<number>();
    if (email) {
      let documents = 0;
      input.entries.forEach((entry, index) => {
        if (fileable(entry) && ++documents > MAX_EMAIL_ARCHIVE_DOCUMENTS) overLimit.add(index);
      });
    }
    const entries: StoredArchiveEntry[] = input.entries.map((entry, index) => ({
      name: entry.name,
      outcome: 'rejected' as const,
      reason: overLimit.has(index) ? 'email_limit' : entry.outcome === 'rejected' ? entry.reason : 'unsupported_type',
      fileId: null,
    }));
    for (const index of archiveIngestOrder(input.entries)) {
      const entry = input.entries[index];
      // The worker sniffed the type from the bytes; only documents are filed, whatever it sends.
      if (!fileable(entry) || overLimit.has(index)) continue;
      // The archive's uploader is the creator of every entry, so approval counts them as an author of each invoice
      // read from it (P10), exactly as if they had uploaded the files one by one. An emailed archive has none.
      const filed = await ingestFileRow(ctx, { ...entry.file, source: email ? 'email' : 'upload' }, archive.created_by);
      entries[index] = { name: entry.name, outcome: filed.duplicate ? 'duplicate' : 'stored', reason: null, fileId: filed.fileId };
    }
    const entity = await uploaderEntity(ctx, archive.created_by);
    const run = await ctx.trx
      .insertInto('crove_kernel.extraction')
      .values({
        org_id: ctx.orgId,
        ...(entity ? { legal_entity_id: entity } : {}),
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
// The answer holds at most MAX_BATCH_ENTRIES entries in all, given out to the archives in the order asked: an archive
// past that budget comes with its first entries only (or none) and entriesTruncated, and is asked about again alone.
export const filesBatch = defineQuery({
  name: 'kernel.files.batch',
  input: z.object({ ids: z.array(zId).min(1).max(MAX_BATCH_FILES) }),
  access: ALL,
  handler: async (ctx, input): Promise<BatchFile[]> => {
    const ids = [...new Set(input.ids)];
    const rows = new Map((await fileStatuses(ctx, { ids })).map((row) => [row.status.id, row]));
    let budget = MAX_BATCH_ENTRIES;
    const slices: Array<{ fileId: string; limit: number }> = [];
    for (const id of ids) {
      const count = rows.get(id)?.entryCount;
      if (!count) continue;
      const limit = Math.min(count, budget);
      slices.push({ fileId: id, limit });
      budget -= limit;
    }
    const entries = await archiveEntries(ctx, slices);
    const childIds = [...new Set([...entries.values()].flatMap((list) => list.flatMap((e) => (e.fileId ? [e.fileId] : []))))];
    const children = new Map<string, FileStatus>();
    for (let i = 0; i < childIds.length; i += MAX_BATCH_FILES) {
      for (const row of await fileStatuses(ctx, { ids: childIds.slice(i, i + MAX_BATCH_FILES) })) children.set(row.status.id, row.status);
    }
    return ids.flatMap((id) => {
      const row = rows.get(id);
      if (!row) return [];
      const list = row.entryCount === null ? null : (entries.get(id) ?? []);
      return [
        {
          ...row.status,
          entryCount: row.entryCount,
          entriesTruncated: list !== null && list.length < (row.entryCount ?? 0),
          entries: list ? list.map((e) => ({ name: e.name, outcome: e.outcome, reason: e.reason, file: e.fileId ? (children.get(e.fileId) ?? null) : null })) : null,
        },
      ];
    });
  },
});

export const archiveQueries = [archiveSource, filesBatch];
export const archiveCommands = [recordArchive];
