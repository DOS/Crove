// The notes screens' small rules (issue #1671, plan docs/plan/notes.md §3.9 and §3.10).
import { NOTE_TAGS_MAX, NOTE_TAG_MAX, NOTE_LIST_VIEWS, type NoteListView } from '@crove/kernel-contract';

// Tags as typed, separated by commas: trimmed, lower case, each once, as many as a note keeps.
export function parseTags(input: string): string[] {
  const tags = input
    .split(',')
    .map((t) => t.trim().toLowerCase().slice(0, NOTE_TAG_MAX))
    .filter((t) => t !== '');
  return [...new Set(tags)].slice(0, NOTE_TAGS_MAX);
}

// A line that looks like it holds a password ("mật khẩu:", "password:", "pass:"): a note is not a password store, so
// the editor warns (notes.md §3.9). Marks are folded first, so "mat khau:" warns too.
export function looksLikePassword(text: string): boolean {
  // It runs on every keystroke, on up to 100,000 characters: a cheap look for "pass" or "kh..u" (marks composed or
  // not) first, and the fold only when one is there.
  if (!/pass|kh\S{0,3}u/i.test(text)) return false;
  const folded = text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/đ/gi, 'd')
    .toLowerCase();
  return /(^|\s)(mat khau|password|pass)\s*[:=]/m.test(folded);
}

// ?note= opens a note and ?list= a list on the notes screen, ?tag= keeps the notes with that tag (#1739); ?q= searches.
// Not ?view=, which Social's calendar uses.
export interface NotesSearch {
  note?: string;
  list?: NoteListView;
  tag?: string;
  q?: string;
}

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseNotesSearch(search: Record<string, unknown>): NotesSearch {
  const out: NotesSearch = {};
  if (typeof search.note === 'string' && ID.test(search.note)) out.note = search.note.toLowerCase();
  if (typeof search.list === 'string' && (NOTE_LIST_VIEWS as readonly string[]).includes(search.list)) out.list = search.list as NoteListView;
  // One tag, as the server keeps it: trimmed and lower case. A comma belongs to the tag (one made through the API may
  // hold one), so it is not split as the tags field is.
  if (typeof search.tag === 'string') {
    const tag = search.tag.trim().toLowerCase().slice(0, NOTE_TAG_MAX);
    if (tag !== '') out.tag = tag;
  }
  if (typeof search.q === 'string' && search.q.trim() !== '') out.q = search.q.trim().slice(0, 200);
  return out;
}

// The list a note's tag chip shows: the one open when it holds the note, otherwise the one that does (the trash, the
// archive, the caller's own, or the shared notes), so the chip never opens a list without the note in it.
export function listOfNote(
  note: { mine: boolean; visibility: 'private' | 'org'; pinned: boolean; archivedAt: string | null; deletedAt: string | null },
  current: NoteListView | undefined,
): NoteListView {
  const holds = (list: NoteListView): boolean => {
    if (list === 'trash') return note.deletedAt !== null;
    if (note.deletedAt !== null) return false;
    if (list === 'archived') return note.archivedAt !== null;
    if (note.archivedAt !== null) return false;
    if (list === 'mine') return note.mine;
    if (list === 'shared') return note.visibility === 'org';
    return note.pinned;
  };
  if (current && holds(current)) return current;
  return (['trash', 'archived', 'mine', 'shared'] as const).find(holds) ?? 'mine';
}

// The tags of a list, most used first (then by name), for the filter's chips.
export function tagCounts(notes: ReadonlyArray<{ tags: readonly string[] }>, limit = 12): Array<{ tag: string; count: number }> {
  const counts = new Map<string, number>();
  for (const n of notes) for (const tag of n.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, 'vi'))
    .slice(0, limit);
}

