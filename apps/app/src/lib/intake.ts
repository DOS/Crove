// Bulk intake (issue #314): the state of one upload batch in the Inbox, many documents or ZIP archives at once. Each
// file is uploaded on its own (so one bad file never fails the others), then followed through files.batch until it
// is read: a proposal, a likely duplicate, or a failure. An archive becomes the documents it held, each followed the
// same way. No React or API imports, so it is unit tested; the Inbox wires it up.
import type { ArchiveEntryReason, BatchFile, FileStatus } from '@crove/kernel-contract';

// Files one batch may hold (files.batch answers for at most this many); a larger month goes in as ZIP archives.
export const MAX_INTAKE_FILES = 500;
// Uploads running at once.
export const INTAKE_CONCURRENCY = 3;
// How often a batch with files still being read is polled.
export const INTAKE_POLL_MS = 2000;

const MAX_BYTES = 25 * 1024 * 1024;
const EXTENSIONS = ['xml', 'pdf', 'jpg', 'jpeg', 'png', 'webp', 'zip'];

export type IntakeState =
  | 'queued'
  | 'uploading'
  // The server refused the upload (or it never arrived); error says why.
  | 'upload_failed'
  | 'processing'
  | 'proposed'
  | 'duplicate'
  | 'failed'
  // An archive opened into its entries.
  | 'expanded'
  // An entry of an archive that was not filed; reason says why.
  | 'rejected';

export interface IntakeItem {
  key: string;
  name: string;
  state: IntakeState;
  fileId: string | null;
  // The bytes were already in the org (the server found the same file), so nothing new is read.
  existing: boolean;
  // Why the server could not read the file (its own words), once it tried.
  error: string | null;
  // Why the upload failed: an error the Inbox words when it renders (so a language switch rewords it).
  uploadError: unknown;
  reason: ArchiveEntryReason | null;
  archive: boolean;
  // The entries of an opened archive.
  entries: IntakeItem[];
}

export function isArchiveName(name: string): boolean {
  return /\.zip$/i.test(name);
}

// What the SPA can tell before sending: the size, and the extension (the server decides by the content).
export function precheck(file: { name: string; size: number }): 'ok' | 'too_large' | 'unsupported' {
  if (file.size > MAX_BYTES) return 'too_large';
  const extension = /\.([a-z0-9]+)$/i.exec(file.name)?.[1]?.toLowerCase() ?? '';
  return EXTENSIONS.includes(extension) ? 'ok' : 'unsupported';
}

export function newItem(key: string, name: string): IntakeItem {
  return { key, name, state: 'queued', fileId: null, existing: false, error: null, uploadError: null, reason: null, archive: isArchiveName(name), entries: [] };
}

// The item once its upload answered: a new file is read next; a file the org already had is a duplicate.
export function uploaded(item: IntakeItem, result: { fileId: string; duplicate: boolean }): IntakeItem {
  return { ...item, fileId: result.fileId, existing: result.duplicate, state: result.duplicate ? 'duplicate' : 'processing' };
}

const fromStatus = (status: FileStatus['status']): IntakeState => status;

function entryItem(parent: string, index: number, entry: NonNullable<BatchFile['entries']>[number]): IntakeItem {
  const base: IntakeItem = {
    key: `${parent}/${index}`,
    name: entry.name,
    state: 'processing',
    fileId: entry.file?.id ?? null,
    existing: entry.outcome === 'duplicate',
    error: entry.file?.error ?? null,
    uploadError: null,
    reason: entry.reason,
    archive: false,
    entries: [],
  };
  if (entry.outcome === 'rejected') return { ...base, state: 'rejected' };
  if (entry.outcome === 'duplicate') return { ...base, state: 'duplicate' };
  return { ...base, state: entry.file ? fromStatus(entry.file.status) : 'processing' };
}

// The items with what files.batch says about the files they uploaded. Items still uploading, refused, or already in
// the org keep their own state.
export function applyBatch(items: readonly IntakeItem[], batch: readonly BatchFile[] | undefined): IntakeItem[] {
  if (!batch) return [...items];
  const byId = new Map(batch.map((file) => [file.id, file]));
  return items.map((item) => {
    const file = item.fileId && !item.existing ? byId.get(item.fileId) : undefined;
    if (!file) return item;
    return {
      ...item,
      state: fromStatus(file.status),
      error: file.error,
      archive: item.archive || file.status === 'expanded' || file.entries !== null,
      entries: (file.entries ?? []).map((entry, index) => entryItem(item.key, index, entry)),
    };
  });
}

const SETTLED: ReadonlySet<IntakeState> = new Set(['upload_failed', 'proposed', 'duplicate', 'failed', 'rejected']);

// The documents of the batch: an opened archive counts as the entries it held, anything else as itself.
export function leaves(items: readonly IntakeItem[]): IntakeItem[] {
  return items.flatMap((item) => (item.state === 'expanded' ? leaves(item.entries) : [item]));
}

export interface IntakeSummary {
  total: number;
  settled: number;
  proposed: number;
  duplicate: number;
  failed: number;
}

export function summarize(items: readonly IntakeItem[]): IntakeSummary {
  const all = leaves(items);
  const count = (states: IntakeState[]) => all.filter((item) => states.includes(item.state)).length;
  return {
    total: all.length,
    settled: all.filter((item) => SETTLED.has(item.state)).length,
    proposed: count(['proposed']),
    duplicate: count(['duplicate']),
    failed: count(['failed', 'upload_failed', 'rejected']),
  };
}

export function isSettled(items: readonly IntakeItem[]): boolean {
  return leaves(items).every((item) => SETTLED.has(item.state));
}

// The files the server still has to finish: uploaded, new, and not settled (an opened archive while an entry is).
export function pendingIds(items: readonly IntakeItem[]): string[] {
  return items.flatMap((item) => {
    if (!item.fileId || item.existing) return [];
    if (item.state === 'expanded') return leaves(item.entries).every((entry) => SETTLED.has(entry.state)) ? [] : [item.fileId];
    return item.state === 'processing' ? [item.fileId] : [];
  });
}

// Runs fn over items with at most `limit` at once.
export async function eachLimited<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const index = next++;
      await fn(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
}
