// Recording a stored file (plan §7.6, ADR-0013), shared by kernel.file.ingest (uploads and email attachments) and
// kernel.file.archive.record (the entries of a ZIP, #314).
import { z } from 'zod';
import { ACCEPTED_ARCHIVE_TYPES } from '@crove/kernel-contract';
import { DomainError, GENERATION_PATTERN, contentGeneration, fileKey, type CommandContext } from '@crove/kernel-runtime';

// A file reference is the triple (storageKey, generation, sha256) of plan §7.6 (ADR-0013): generation is what the
// store's put returned for the bytes it wrote.
export const zIngestFile = z.object({
  filename: z.string().min(1).max(255),
  contentType: z.string().min(1).max(100),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  storageKey: z.string().min(1),
  generation: z.string().regex(GENERATION_PATTERN),
  // social: an image or video for a Social post (#372, #409), stored like any file but never sent to extraction.
  source: z.enum(['upload', 'email', 'social']),
  // A video's duration, read by the server from the file (#409).
  durationMs: z.number().int().min(0).max(86_400_000).optional(),
});
export type IngestFile = z.infer<typeof zIngestFile>;

// A ZIP archive (#314): stored and recorded like a document, then opened by the worker instead of being read.
export function isArchiveType(contentType: string): boolean {
  return ACCEPTED_ARCHIVE_TYPES.includes(contentType);
}

// Inserts the file row, or finds the org's file with the same bytes (files are deduplicated by content), and queues
// a new document for reading. createdBy is the user who supplied the bytes: approval counts them as an author of
// whatever is read from the file (P10), so callers take it from the actor or from a row the database holds, never
// from command input.
export async function ingestFileRow(ctx: CommandContext, input: IngestFile, createdBy: string | null): Promise<{ fileId: string; duplicate: boolean }> {
  if (input.storageKey !== fileKey(ctx.orgId, input.sha256)) throw new DomainError('INVALID_STORAGE_KEY', 400, 'Khóa lưu trữ không hợp lệ');
  if (input.generation.startsWith('content:') && input.generation !== contentGeneration(input.sha256)) {
    throw new DomainError('INVALID_GENERATION', 400, 'Phiên bản lưu trữ không khớp nội dung tệp');
  }
  const inserted = await ctx.trx
    .insertInto('crove_kernel.file')
    .values({
      org_id: ctx.orgId,
      sha256: input.sha256,
      storage_key: input.storageKey,
      generation: input.generation,
      filename: input.filename,
      content_type: input.contentType,
      size_bytes: String(input.sizeBytes),
      source: input.source,
      duration_ms: input.durationMs === undefined ? null : String(input.durationMs),
      created_by: createdBy,
    })
    .onConflict((oc) => oc.columns(['org_id', 'sha256']).doNothing())
    .returning('id')
    .executeTakeFirst();
  if (!inserted) {
    const existing = await ctx.trx
      .selectFrom('crove_kernel.file')
      .select(['id', 'source'])
      .where('org_id', '=', ctx.orgId)
      .where('sha256', '=', input.sha256)
      .forUpdate()
      .executeTakeFirstOrThrow();
    // Files are deduplicated by content, so the same bytes can arrive as a document and as an image for a Social
    // post (#372). A document is never offered for publishing: an image upload of a document's bytes is refused.
    if (input.source === 'social' && existing.source !== 'social') {
      throw new DomainError('FILE_IS_DOCUMENT', 409, 'Ảnh này đã có trong chứng từ kế toán của tổ chức, hãy dùng ảnh khác cho bài đăng');
    }
    // A document whose bytes were first uploaded as a post image is still read as a document, once.
    if (input.source !== 'social' && existing.source === 'social') {
      const read = await ctx.trx.selectFrom('crove_kernel.extraction').select('id').where('org_id', '=', ctx.orgId).where('file_id', '=', existing.id).limit(1).executeTakeFirst();
      if (!read) {
        await ctx.activity('kernel.file', existing.id, 'file.received', `Nhận chứng từ ${input.filename}`);
        await ctx.emit('kernel.file.ingested', { fileId: existing.id });
        return { fileId: existing.id, duplicate: false };
      }
    }
    return { fileId: existing.id, duplicate: true };
  }
  if (input.source === 'social') return { fileId: inserted.id, duplicate: false };
  await ctx.activity('kernel.file', inserted.id, 'file.received', `Nhận chứng từ ${input.filename}`);
  await ctx.emit('kernel.file.ingested', { fileId: inserted.id });
  return { fileId: inserted.id, duplicate: false };
}
