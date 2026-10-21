// Fiscal year archive packages (#922) on the ledger screen: which years an owner may ask for, and when a request the
// worker has not recorded counts as stalled. The kernel decides (finance.archive.build); these only shape the screen.
import type { YearArchive } from '@crove/kernel-contract';

// Only owners ask for, list, download and verify packages; the kernel checks again.
export const canArchiveYears = (role: string | null | undefined) => role === 'owner';

// A request the worker has not recorded within this long may be asked again (ARCHIVE_REQUEST_COOLDOWN_MINUTES).
export const ARCHIVE_STALL_MINUTES = 60;

// How many fully locked years back the screen offers. The legal retention is 10 years from each year's end.
const YEARS_OFFERED = 10;

export function isStalled(archive: Pick<YearArchive, 'state' | 'requestedAt'>, now: number): boolean {
  return archive.state === 'requested' && archive.requestedAt !== null && Date.parse(archive.requestedAt) <= now - ARCHIVE_STALL_MINUTES * 60_000;
}

// The last year whose every month is locked: the lock's year when it reaches the 31st of December, else the year before.
export function lastLockedYear(lockedThrough: string | null): number | null {
  if (!lockedThrough || !/^\d{4}-\d{2}-\d{2}$/.test(lockedThrough)) return null;
  const year = Number(lockedThrough.slice(0, 4));
  const last = lockedThrough.endsWith('-12-31') ? year : year - 1;
  return last >= 2000 ? last : null;
}

// The fully locked years an owner may ask for, newest first: not built, and not waiting on a request less than an hour
// old.
export function archivableYears(lockedThrough: string | null, archives: readonly YearArchive[], now: number): number[] {
  const last = lastLockedYear(lockedThrough);
  if (last === null) return [];
  const taken = new Set(archives.filter((a) => a.state === 'built' || !isStalled(a, now)).map((a) => a.year));
  const years: number[] = [];
  for (let year = last; year > last - YEARS_OFFERED && year >= 2000; year--) if (!taken.has(year)) years.push(year);
  return years;
}

// The parts of a recorded package as its manifest lists them (the kernel's YearArchiveManifest, read for display).
export interface ArchiveManifestPart {
  name: string;
  kind: 'journal' | 'ledger' | 'statements' | 'vat_working' | 'vat_xml';
  sha256: string;
  bytes: number;
}

export interface ArchiveManifestView {
  year: number;
  builtAt: string;
  parts: ArchiveManifestPart[];
  documents: { filename: string }[];
  notes: string[];
}
