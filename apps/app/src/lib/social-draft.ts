// Unsaved edits of a Social post kept in this browser (#634), so a reload, a closed tab or a crash loses nothing. One
// entry per org and post ('new' for the composer), with the post's revision it started from: an entry for an older
// revision is not offered. Storage can be missing or full (a private window); then nothing is kept and nothing breaks.

const PREFIX = 'crove.social.draft';
// An entry older than this is dropped when read.
export const DRAFT_TTL_MS = 7 * 86_400_000;

export interface StoredDraft<T> {
  savedAt: string;
  revision: number | null;
  data: T;
}

const keyOf = (slug: string, id: string) => `${PREFIX}:${slug}:${id}`;

export function saveDraft<T>(slug: string, id: string, revision: number | null, data: T, now = new Date()): void {
  try {
    localStorage.setItem(keyOf(slug, id), JSON.stringify({ savedAt: now.toISOString(), revision, data } satisfies StoredDraft<T>));
  } catch {
    // No storage: the edits live only in the page.
  }
}

export function loadDraft<T>(slug: string, id: string, now = Date.now()): StoredDraft<T> | null {
  try {
    const raw = localStorage.getItem(keyOf(slug, id));
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<StoredDraft<T>>;
    const at = typeof value.savedAt === 'string' ? Date.parse(value.savedAt) : Number.NaN;
    if (!Number.isFinite(at) || now - at > DRAFT_TTL_MS || value.data === undefined) {
      localStorage.removeItem(keyOf(slug, id));
      return null;
    }
    return { savedAt: value.savedAt as string, revision: typeof value.revision === 'number' ? value.revision : null, data: value.data };
  } catch {
    return null;
  }
}

export function clearDraft(slug: string, id: string): void {
  try {
    localStorage.removeItem(keyOf(slug, id));
  } catch {
    // Nothing kept, nothing to clear.
  }
}

// The text with an insert at the cursor (or over the selection), and where the cursor goes after it.
export function insertText(text: string, start: number, end: number, insert: string): { text: string; cursor: number } {
  const from = Math.max(0, Math.min(start, text.length));
  const to = Math.max(from, Math.min(end, text.length));
  return { text: text.slice(0, from) + insert + text.slice(to), cursor: from + insert.length };
}
