// The org export job (issue #38, plan §7.9 "Offboarding" step 1). Reads every exported table of the org through the
// system query kernel.org.export.snapshot, stores each as one JSON document, then a manifest with the stored files
// list, all as content-addressed blobs under the org's prefix, and records the export (kernel.org.export.record).
// A retried job writes the same table blobs again (same bytes, same keys) and a new manifest.
import {
  EXPORT_FORMAT,
  EXPORT_MAX_ROWS,
  EXPORT_TABLE_NAMES,
  type ExportPart,
  type ExportRecord,
  type ExportTable,
} from '@crove/kernel';
import { fileKey, sha256Hex, type Actor, type BlobStore, type Runtime } from '@crove/kernel-runtime';

const SYSTEM: Actor = { type: 'system', component: 'org-export' };

export interface ExportedFile {
  id: unknown;
  filename: unknown;
  contentType: unknown;
  sizeBytes: unknown;
  sha256: unknown;
  storageKey: unknown;
  // The object version the bytes were written as (ADR-0013): with storageKey and sha256, the file's reference.
  generation: unknown;
  source: unknown;
  createdAt: unknown;
}

export interface OrgExportManifest {
  format: typeof EXPORT_FORMAT;
  orgId: string;
  generatedAt: string;
  parts: ExportPart[];
  // The stored files (documents and email attachments): their blobs stay under the same keys in the store.
  files: ExportedFile[];
}

async function putJson(store: BlobStore, orgId: string, value: unknown): Promise<{ key: string; sha256: string; bytes: number }> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const sha256 = sha256Hex(bytes);
  const key = fileKey(orgId, sha256);
  await store.put(key, bytes, 'application/json');
  return { key, sha256, bytes: bytes.byteLength };
}

export async function runOrgExport(deps: { runtime: Runtime; store: BlobStore }, orgId: string, now: () => Date = () => new Date()): Promise<ExportRecord> {
  const parts: ExportPart[] = [];
  let files: ExportedFile[] = [];
  for (const table of EXPORT_TABLE_NAMES) {
    const rows = await deps.runtime.query<Array<Record<string, unknown>>>('kernel.org.export.snapshot', { table }, { actor: SYSTEM, orgId });
    if (rows.length > EXPORT_MAX_ROWS) throw new Error(`EXPORT_TOO_LARGE: ${table} has more than ${EXPORT_MAX_ROWS} rows`);
    const stored = await putJson(deps.store, orgId, { format: EXPORT_FORMAT, orgId, table, rows });
    parts.push({ table: table satisfies ExportTable, ...stored, rows: rows.length });
    if (table === 'kernel.file') {
      files = rows.map((r) => ({
        id: r.id,
        filename: r.filename,
        contentType: r.content_type,
        sizeBytes: r.size_bytes,
        sha256: r.sha256,
        storageKey: r.storage_key,
        generation: r.generation,
        source: r.source,
        createdAt: r.created_at,
      }));
    }
  }
  const manifest: OrgExportManifest = { format: EXPORT_FORMAT, orgId, generatedAt: now().toISOString(), parts, files };
  const stored = await putJson(deps.store, orgId, manifest);
  const record: ExportRecord = { manifestKey: stored.key, manifestSha256: stored.sha256, fileCount: files.length, parts };
  await deps.runtime.execute('kernel.org.export.record', record, { actor: SYSTEM, orgId });
  return record;
}
