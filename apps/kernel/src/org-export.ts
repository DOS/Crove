// The org export job (issue #38, plan §7.9 "Offboarding" step 1; streamed since #212). Streams every exported table of
// the org through the system query kernel.org.export.snapshot (one REPEATABLE READ snapshot for all tables, a cursor
// per table), writes each table as NDJSON (one row per line) in chunks of at most chunkBytes, seals every chunk (see
// export-seal.ts) and stores it content addressed under export/<org_id>/, then a manifest, and records the export
// (kernel.org.export.record) with the date it expires. Memory stays bounded by one chunk plus one FETCH batch,
// whatever the size of the org. A retried job writes new blobs (fresh random bytes in every envelope); the blobs of a
// failed attempt are never recorded and expire with the rest under export/.
import {
  EXPORT_FORMAT,
  EXPORT_MAX_PARTS,
  EXPORT_RECORD_STALE,
  type ExportBatch,
  type ExportEncryption,
  type ExportPart,
  type ExportRecord,
  type ExportTable,
} from '@crove/kernel';
import { exportKey, sha256Hex, type Actor, type BlobStore, type Runtime } from '@crove/kernel-runtime';
import { exportAad, type ExportSealer } from './export-seal.ts';

const SYSTEM: Actor = { type: 'system', component: 'org-export' };
// Times the job records a finished export when another record of the org came first (#1867).
const RECORD_ATTEMPTS = 3;
// NDJSON bytes per stored chunk (before sealing). A chunk is held in memory while it is sealed and written.
export const EXPORT_CHUNK_BYTES = 8 * 1024 * 1024;
export const DEFAULT_EXPORT_RETENTION_DAYS = 35;

export interface OrgExportManifest {
  format: typeof EXPORT_FORMAT;
  orgId: string;
  generatedAt: string;
  expiresAt: string;
  // Every table was read from one database snapshot.
  snapshot: 'repeatable read';
  encryption: ExportEncryption;
  // Rows of kernel.file: the stored documents and email attachments, whose blobs stay under the storage_key (with
  // generation and sha256) each row lists. The rows themselves are in the kernel.file part.
  fileCount: number;
  parts: ExportPart[];
}

export interface OrgExportDeps {
  runtime: Runtime;
  store: BlobStore;
  sealer: ExportSealer;
  // Days the export is kept (EXPORT_RETENTION_DAYS); the record carries the date.
  retentionDays?: number;
}

export interface OrgExportOptions {
  now?: () => Date;
  chunkBytes?: number;
}

const NEWLINE = 0x0a;

export async function runOrgExport(deps: OrgExportDeps, orgId: string, options: OrgExportOptions = {}): Promise<ExportRecord> {
  const now = options.now ?? (() => new Date());
  const chunkBytes = options.chunkBytes ?? EXPORT_CHUNK_BYTES;
  const encoder = new TextEncoder();
  const parts: ExportPart[] = [];
  let fileCount = 0;

  async function storeSealed(plain: Uint8Array, aad: Buffer): Promise<{ key: string; sha256: string; generation: string }> {
    const sealed = deps.sealer.seal(plain, aad);
    const sha256 = sha256Hex(sealed);
    const key = exportKey(orgId, sha256);
    const generation = await deps.store.put(key, sealed, 'application/octet-stream');
    return { key, sha256, generation };
  }

  // The chunk being filled: encoded lines and their size.
  let current: { table: ExportTable; chunk: number; lines: Uint8Array[]; bytes: number; rows: number } | null = null;

  async function flush(): Promise<void> {
    if (!current) return;
    const { table, chunk, lines, bytes, rows } = current;
    current = null;
    if (parts.length >= EXPORT_MAX_PARTS) throw new Error(`EXPORT_TOO_LARGE: more than ${EXPORT_MAX_PARTS} chunks`);
    const plain = new Uint8Array(bytes);
    let offset = 0;
    for (const line of lines) {
      plain.set(line, offset);
      offset += line.byteLength;
      plain[offset++] = NEWLINE;
    }
    const stored = await storeSealed(plain, exportAad(orgId, { table, chunk }));
    parts.push({ table, chunk, ...stored, rows, bytes });
  }

  const sink = async (raw: unknown): Promise<void> => {
    const batch = raw as ExportBatch;
    if (current && current.table !== batch.table) await flush();
    current ??= { table: batch.table, chunk: parts.filter((p) => p.table === batch.table).length, lines: [], bytes: 0, rows: 0 };
    for (const text of batch.lines) {
      const line = encoder.encode(text);
      if (current.rows > 0 && current.bytes + line.byteLength + 1 > chunkBytes) {
        const { table, chunk }: { table: ExportTable; chunk: number } = current;
        await flush();
        current = { table, chunk: chunk + 1, lines: [], bytes: 0, rows: 0 };
      }
      current.lines.push(line);
      current.bytes += line.byteLength + 1;
      current.rows++;
    }
    if (batch.table === 'kernel.file') fileCount += batch.lines.length;
    // The table's last batch closes its last chunk (an empty table still gets one, empty, chunk).
    if (batch.last) await flush();
  };

  await deps.runtime.stream('kernel.org.export.snapshot', {}, { actor: SYSTEM, orgId }, sink);
  await flush();

  const generatedAt = now();
  const expiresAt = new Date(generatedAt.getTime() + (deps.retentionDays ?? DEFAULT_EXPORT_RETENTION_DAYS) * 86_400_000).toISOString();
  const manifest: OrgExportManifest = {
    format: EXPORT_FORMAT,
    orgId,
    generatedAt: generatedAt.toISOString(),
    expiresAt,
    snapshot: 'repeatable read',
    encryption: deps.sealer.encryption,
    fileCount,
    parts,
  };
  const stored = await storeSealed(encoder.encode(JSON.stringify(manifest)), exportAad(orgId, 'manifest'));
  const record: ExportRecord = {
    format: EXPORT_FORMAT,
    manifestKey: stored.key,
    manifestSha256: stored.sha256,
    manifestGeneration: stored.generation,
    fileCount,
    encryption: deps.sealer.encryption,
    expiresAt,
    parts,
  };
  // A record whose transaction began before another of the org's records that took the export lock first is refused
  // (#1867); a new transaction records it after that one.
  for (let attempt = 1; ; attempt++) {
    try {
      await deps.runtime.execute('kernel.org.export.record', record, { actor: SYSTEM, orgId });
      break;
    } catch (error) {
      if (attempt >= RECORD_ATTEMPTS || (error as { code?: string }).code !== EXPORT_RECORD_STALE) throw error;
    }
  }
  return record;
}
