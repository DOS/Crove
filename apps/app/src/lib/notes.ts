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

// ?note= opens a note and ?list= a list on the notes screen; ?q= searches. Not ?view=, which Social's calendar uses.
export interface NotesSearch {
  note?: string;
  list?: NoteListView;
  q?: string;
}

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseNotesSearch(search: Record<string, unknown>): NotesSearch {
  const out: NotesSearch = {};
  if (typeof search.note === 'string' && ID.test(search.note)) out.note = search.note.toLowerCase();
  if (typeof search.list === 'string' && (NOTE_LIST_VIEWS as readonly string[]).includes(search.list)) out.list = search.list as NoteListView;
  if (typeof search.q === 'string' && search.q.trim() !== '') out.q = search.q.trim().slice(0, 200);
  return out;
}
