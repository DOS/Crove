// Bulk intake (issue #314), worker side: a stored ZIP archive is opened in crove-extract, never in this process
// (External-tenant gate T12). The sandbox's answer is untrusted: the client validated its shape, and here every entry
// is decoded, checked against its declared size, sniffed by content and stored under the org's content address before
// kernel.file.archive.record files it, in one transaction, as a document of its own. Each document is then read by
// the ordinary extraction job, one sandbox call per file, so a batch of 200 never runs as one long request.
import { EXTRACT_LIMITS, EXTRACT_LIMIT_RETRIES, type ExtractClient, type ExtractFailure } from '@crove/extract-contract';
import { ACCEPTED_UPLOAD_TYPES, MAX_UPLOAD_BYTES, type ArchiveEntryReason } from '@crove/kernel-contract';
import type { ArchiveEntryInput } from '@crove/kernel';
import { fileKey, putFile, readVerified, sha256Hex, type BlobStore, type Runtime } from '@crove/kernel-runtime';
import { safeFilename, sniffType } from './sniff.ts';

export const ARCHIVE_ACTOR = { type: 'system' as const, component: 'kernel.archive' };
// Entries stored at once while an archive is filed (a bucket round trip each).
const STORE_CONCURRENCY = 4;

export interface ArchiveDeps {
  runtime: Runtime;
  store: BlobStore;
  extract: ExtractClient;
}

export interface ArchiveSource {
  id: string;
  filename: string;
  content_type: string;
  storage_key: string;
  generation: string | null;
  sha256: string;
  expanded: boolean;
}

// The archive behind an extraction job, or null when the file is not an archive (it is read as a document).
export function archiveSource(runtime: Runtime, orgId: string, fileId: string): Promise<ArchiveSource | null> {
  return runtime.query<ArchiveSource | null>('kernel.file.archive.source', { fileId }, { actor: ARCHIVE_ACTOR, orgId });
}

export function recordArchiveFailure(runtime: Runtime, orgId: string, fileId: string, error: string) {
  return runtime.execute('kernel.file.archive.record', { fileId, status: 'failed', error: error.slice(0, 2000), entries: [] }, { actor: ARCHIVE_ACTOR, orgId });
}

function unopenable(result: ExtractFailure): string {
  switch (result.code) {
    case 'too_large':
      return 'Tệp ZIP quá lớn (tối đa 25 MB)';
    case 'timeout':
      return 'Mở tệp ZIP quá lâu nên đã dừng; hãy chia thành nhiều tệp ZIP nhỏ hơn';
    case 'memory':
      return 'Tệp ZIP cần quá nhiều bộ nhớ để mở; hãy chia thành nhiều tệp ZIP nhỏ hơn';
    default:
      // The sandbox says what is wrong with the archive; the text stays plain data wherever it is shown.
      return result.message || 'Không mở được tệp ZIP';
  }
}

// At most `max` UTF-16 units without splitting a surrogate pair: a lone surrogate is valid in a JS string but not in
// jsonb, where the entry names are kept, and would fail the whole record.
export function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

// The name an entry is listed under (its path in the archive), within what the record command takes.
export function entryName(name: string): string {
  // toWellFormed: a lone surrogate anywhere in a name the sandbox sent becomes U+FFFD instead of failing the write.
  return truncateText((name || '(không tên)').toWellFormed(), 255);
}
// The name the entry is filed under: its last path segment, with the extension of the type its bytes have.
function entryFilename(name: string, contentType: string): string {
  const base = name.split('/').filter(Boolean).pop() ?? '';
  return safeFilename(base, contentType);
}

// Runs fn over items with at most `limit` at once, keeping the order of the results.
async function mapLimited<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return results;
}

// Opens the archive and files its entries. `attempt` is the job's retry count (0 on the first run). A sandbox that
// cannot answer throws (ExtractServiceError) and the job is retried; an archive the sandbox refuses is recorded as
// failed. A timeout or memory answer may come from load, so it is retried EXTRACT_LIMIT_RETRIES times first: a hostile
// archive must not hold the shared parser slot again and again.
export async function expandArchive(deps: ArchiveDeps, orgId: string, source: ArchiveSource, attempt = 0): Promise<{ fileIds: string[] }> {
  if (source.expanded) return { fileIds: [] };
  const bytes = await readVerified(deps.store, { key: source.storage_key, generation: source.generation, sha256: source.sha256 });
  const opened = await deps.extract.extract('zip', bytes);
  if (!opened.ok) {
    const limitHit = opened.code === 'timeout' || opened.code === 'memory';
    if (limitHit && attempt < EXTRACT_LIMIT_RETRIES) throw new Error(`crove-extract stopped at a limit: ${opened.code}`);
    await recordArchiveFailure(deps.runtime, orgId, source.id, unopenable(opened));
    return { fileIds: [] };
  }
  const listed = opened.archive.entries;
  // The sandbox's limits, checked again on its answer.
  let total = 0;
  for (const entry of listed) if (entry.content !== null) total += entry.sizeBytes;
  if (listed.length > EXTRACT_LIMITS.maxArchiveEntries || total > EXTRACT_LIMITS.maxArchiveTotalBytes) {
    await recordArchiveFailure(deps.runtime, orgId, source.id, 'Tệp ZIP vượt giới hạn số tệp hoặc dung lượng');
    return { fileIds: [] };
  }

  const entries = await mapLimited(listed, STORE_CONCURRENCY, async (entry): Promise<ArchiveEntryInput> => {
    const name = entryName(entry.name);
    const reject = (reason: ArchiveEntryReason): ArchiveEntryInput => ({ outcome: 'rejected', name, reason });
    if (entry.rejected !== null || entry.content === null) return reject(entry.rejected ?? 'corrupt');
    // A copy of its own: a small Buffer is a view of Node's shared pool, whose other bytes must not travel with it.
    const content = Uint8Array.from(Buffer.from(entry.content, 'base64'));
    if (content.byteLength !== entry.sizeBytes) return reject('corrupt');
    if (content.byteLength === 0) return reject('empty');
    if (content.byteLength > MAX_UPLOAD_BYTES) return reject('too_large');
    // The content decides the type, as for an upload; an archive inside the archive is never opened.
    const contentType = sniffType(content);
    if (contentType === 'application/zip') return reject('nested_archive');
    if (!contentType || !ACCEPTED_UPLOAD_TYPES.includes(contentType)) return reject('unsupported_type');
    const sha256 = sha256Hex(content);
    const storageKey = fileKey(orgId, sha256);
    const generation = await putFile(deps.store, storageKey, content, contentType, sha256);
    return {
      outcome: 'stored',
      name,
      file: { filename: entryFilename(name, contentType), contentType, sizeBytes: content.byteLength, sha256, storageKey, generation },
    };
  });
  return deps.runtime.execute<{ fileIds: string[] }>('kernel.file.archive.record', { fileId: source.id, status: 'done', error: null, entries }, { actor: ARCHIVE_ACTOR, orgId });
}
