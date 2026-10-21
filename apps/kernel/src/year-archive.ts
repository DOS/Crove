// Fiscal year archive packages (issue #922, plan §7.9), worker and verification side. The commands and queries are
// modules/finance/src/year-archive.ts.
//
// runYearArchive builds the package of one year once finance.archive.build asked for it: the journal workbook, the
// ledger workbook (trial balance, general ledger, receivables and payables), the financial statements (B01 and B02),
// the VAT working of every month or quarter of the year (by the org's filing period) and, when the org has a tax code,
// its 01/GTGT XML. Each part is stored once under archive/<org_id>/<year>/<sha256> (content addressed, create-only;
// on S3 with S3_ARCHIVE_LOCK_DAYS it is locked). The manifest lists every part and the original file of every
// document of the year (by storage key, version and sha256; the originals stay where they are, Crove never deletes
// them) and names the command that asked for the build; it is stored the same way and recorded by
// finance.archive.record, whose audit row is the build's.
//
// verifyYearArchive reads the recorded manifest and every part and original at its recorded version, and reports each
// one that is missing or whose bytes no longer hash to the manifest's sha256.
import {
  ARCHIVE_FORMAT,
  JOURNAL_EXPORT_LIMIT,
  buildJournalWorkbook,
  buildLedgerWorkbook,
  buildStatementsWorkbook,
  buildVat01Xml,
  buildVatWorkbook,
  type ArchiveSource,
  type FinancialStatements,
  type JournalEntryView,
  type LedgerBook,
  type RecordedArchive,
  type VatDeclaration,
  type VatReport,
} from '@crove/mod-finance';
import type { YearArchiveVerification } from '@crove/kernel-contract';
import {
  BlobIntegrityError,
  BlobNotFoundError,
  DomainError,
  archiveKey,
  readVerified,
  sha256Hex,
  type Actor,
  type BlobStore,
  type Runtime,
} from '@crove/kernel-runtime';

export const YEAR_ARCHIVE_ACTOR: Actor = { type: 'system', component: 'finance.archive' };
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export interface ArchivePart {
  name: string;
  kind: 'journal' | 'ledger' | 'statements' | 'vat_working' | 'vat_xml';
  key: string;
  generation: string;
  sha256: string;
  bytes: number;
}

export interface ArchiveDocument {
  fileId: string;
  filename: string;
  key: string;
  generation: string | null;
  sha256: string;
}

export interface YearArchiveManifest {
  format: typeof ARCHIVE_FORMAT;
  orgId: string;
  orgSlug: string;
  year: number;
  // Every date up to this one was locked when the package was built.
  lockedThrough: string;
  builtAt: string;
  // The finance.archive.build command that asked for this package (its audit row's command_id).
  requestCommandId: string | null;
  parts: ArchivePart[];
  documents: ArchiveDocument[];
  // What the package leaves out, and why (a VAT XML for an org without a tax code, for example).
  notes: string[];
}

const pad = (n: number) => String(n).padStart(2, '0');

// The VAT periods of a year by the org's filing period: four quarters when it files quarterly, else twelve months.
export function vatPeriods(year: number, filing: ArchiveSource['vatFilingPeriod']): string[] {
  return filing === 'quarter' ? [1, 2, 3, 4].map((q) => `${year}-Q${q}`) : Array.from({ length: 12 }, (_, i) => `${year}-${pad(i + 1)}`);
}

export async function runYearArchive(
  deps: { runtime: Runtime; store: BlobStore },
  orgId: string,
  year: number,
  options: { requestCommandId?: string | null; now?: () => Date } = {},
): Promise<{ manifestKey: string; recorded: boolean }> {
  const { runtime, store } = deps;
  const scope = { actor: YEAR_ARCHIVE_ACTOR, orgId };
  const source = await runtime.query<ArchiveSource>('finance.archive.source', { year }, scope);
  // The lock may have been lifted since the request: build only a year that is still locked through December.
  if (!source.lockedThrough || source.lockedThrough < `${year}-12-31`) {
    throw new DomainError('ARCHIVE_YEAR_OPEN', 422, `Năm ${year} không còn khóa sổ đủ 12 tháng; gói lưu trữ chưa được tạo`);
  }

  const parts: ArchivePart[] = [];
  const notes: string[] = [];
  const store1 = async (name: string, kind: ArchivePart['kind'], bytes: Uint8Array, contentType: string) => {
    const sha256 = sha256Hex(bytes);
    const key = archiveKey(orgId, year, sha256);
    const generation = await store.put(key, bytes, contentType);
    parts.push({ name, kind, key, generation, sha256, bytes: bytes.byteLength });
  };

  const entries = await runtime.query<JournalEntryView[]>('finance.journal.list', { from: `${year}-01-01`, to: `${year}-12-31`, limit: JOURNAL_EXPORT_LIMIT }, scope);
  if (entries.length >= JOURNAL_EXPORT_LIMIT) {
    throw new DomainError('EXPORT_TOO_LARGE', 422, `Năm ${year} có quá nhiều bút toán để đóng gói một lần`);
  }
  await store1(`so-nhat-ky-${year}.xlsx`, 'journal', await buildJournalWorkbook([...entries].reverse(), source.orgSlug), XLSX);
  const book = await runtime.query<LedgerBook>('finance.ledger.book', { period: String(year) }, scope);
  await store1(`so-sach-${year}.xlsx`, 'ledger', await buildLedgerWorkbook(book, source.orgSlug), XLSX);
  const statements = await runtime.query<FinancialStatements>('finance.statements.period', { period: String(year) }, scope);
  await store1(`bao-cao-tai-chinh-${year}.xlsx`, 'statements', await buildStatementsWorkbook(statements, source.orgSlug), XLSX);

  for (const period of vatPeriods(year, source.vatFilingPeriod)) {
    const report = await runtime.query<VatReport>('finance.vat.period', { period }, scope);
    await store1(`gtgt-${period}.xlsx`, 'vat_working', await buildVatWorkbook(report, source.orgSlug), XLSX);
    if (!source.hasTaxCode) continue;
    const declaration = await runtime.query<VatDeclaration>('finance.vat.declaration', { period }, scope);
    // The filing date is the day in Vietnam, not in UTC.
    const xml = buildVat01Xml(declaration, (options.now?.() ?? new Date()).toLocaleDateString('sv-SE', { timeZone: 'Asia/Ho_Chi_Minh' }));
    await store1(`01gtgt-${period}.xml`, 'vat_xml', new TextEncoder().encode(xml), 'application/xml');
  }
  if (!source.hasTaxCode) notes.push('Tổ chức chưa có mã số thuế nên gói không có tờ khai 01/GTGT dạng XML');

  const manifest: YearArchiveManifest = {
    format: ARCHIVE_FORMAT,
    orgId,
    orgSlug: source.orgSlug,
    year,
    lockedThrough: source.lockedThrough,
    builtAt: (options.now?.() ?? new Date()).toISOString(),
    requestCommandId: options.requestCommandId ?? null,
    parts,
    documents: source.files.map((f) => ({ fileId: f.id, filename: f.filename, key: f.key, generation: f.generation, sha256: f.sha256 })),
    notes,
  };
  const bytes = new TextEncoder().encode(JSON.stringify(manifest, null, 2));
  const sha256 = sha256Hex(bytes);
  const manifestKey = archiveKey(orgId, year, sha256);
  const manifestGeneration = await store.put(manifestKey, bytes, 'application/json');
  const { recorded } = await runtime.execute<{ recorded: boolean }>(
    'finance.archive.record',
    { year, manifestKey, manifestSha256: sha256, manifestGeneration, parts: parts.length, documents: manifest.documents.length },
    scope,
  );
  return { manifestKey, recorded };
}

// Reads the recorded manifest of a year (at its version, checked against its sha256).
export async function readYearArchiveManifest(store: BlobStore, archive: RecordedArchive): Promise<YearArchiveManifest> {
  const bytes = await readVerified(store, { key: archive.manifestKey, generation: archive.manifestGeneration, sha256: archive.manifestSha256 });
  return JSON.parse(new TextDecoder().decode(bytes)) as YearArchiveManifest;
}

export async function verifyYearArchive(store: BlobStore, orgId: string, archive: RecordedArchive): Promise<YearArchiveVerification> {
  const problems: YearArchiveVerification['problems'] = [];
  const outcome = (error: unknown): 'missing' | 'changed' | null => {
    if (error instanceof BlobNotFoundError) return 'missing';
    if (error instanceof BlobIntegrityError) return 'changed';
    return null;
  };
  let manifest: YearArchiveManifest;
  try {
    manifest = await readYearArchiveManifest(store, archive);
  } catch (error) {
    const code = outcome(error);
    if (!code) throw error;
    return { year: archive.year, ok: false, checked: 1, problems: [{ code: code === 'changed' ? 'manifest_changed' : 'missing', name: 'manifest' }] };
  }
  let checked = 1;
  // Only the org's own keys are read: a part outside the package's prefix, or an original outside the org's files, was
  // not written by the build.
  const parts = manifest.parts.filter((p) => p.key.startsWith(`archive/${orgId}/${archive.year}/`));
  const documents = manifest.documents.filter((d) => d.key.startsWith(`org/${orgId}/`));
  if (parts.length !== manifest.parts.length || documents.length !== manifest.documents.length) problems.push({ code: 'manifest_changed', name: 'manifest' });
  const items = [...parts.map((p) => ({ name: p.name, ref: p })), ...documents.map((d) => ({ name: d.filename, ref: d }))];
  for (const { name, ref } of items) {
    checked += 1;
    try {
      await readVerified(store, { key: ref.key, generation: ref.generation, sha256: ref.sha256 });
    } catch (error) {
      const code = outcome(error);
      if (!code) throw error;
      problems.push({ code, name });
    }
  }
  return { year: archive.year, ok: problems.length === 0, checked, problems };
}
