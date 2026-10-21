// The command palette (issue #439, DESIGN.md 5.2): which entries match what the user typed, in which order, and the
// key that opens it. No browser or React imports, so it is unit tested.

// parties, documents and entries hold what the org's search found (#673).
export type PaletteGroup = 'go' | 'proposals' | 'parties' | 'documents' | 'entries' | 'orgs' | 'actions';

export const PALETTE_GROUPS: readonly PaletteGroup[] = ['go', 'proposals', 'parties', 'documents', 'entries', 'orgs', 'actions'];

export interface PaletteItem {
  id: string;
  group: PaletteGroup;
  label: string;
  // A second line (a proposal's title and amount); matched like the label.
  detail?: string;
  // Extra words that find the entry without being shown.
  keywords?: string;
}

// Folds case and Vietnamese marks, so "so sach" finds "Sổ sách" and "dien" finds "Điện". Đ has no decomposition in
// Unicode, so it is mapped by hand.
export function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{M}+/gu, '').replace(/[đĐ]/g, 'd').toLowerCase();
}

// The entries whose label, detail or keywords contain every typed word, grouped in PALETTE_GROUPS order. Inside a
// group a label that starts with the query comes first, then one that contains it, then the rest in their original
// order; each group shows at most `perGroup` entries.
export function filterPalette<T extends PaletteItem>(items: readonly T[], query: string, perGroup = 8): T[] {
  const q = fold(query.trim());
  const words = q.split(/\s+/).filter(Boolean);
  const matches = items.flatMap((item, index) => {
    const haystack = fold(`${item.label} ${item.detail ?? ''} ${item.keywords ?? ''}`);
    if (!words.every((w) => haystack.includes(w))) return [];
    const label = fold(item.label);
    const score = !q || label.startsWith(q) ? 0 : label.includes(q) ? 1 : 2;
    return [{ item, index, score }];
  });
  matches.sort(
    (a, b) => PALETTE_GROUPS.indexOf(a.item.group) - PALETTE_GROUPS.indexOf(b.item.group) || a.score - b.score || a.index - b.index,
  );
  const shown = new Map<PaletteGroup, number>();
  return matches.flatMap(({ item }) => {
    const n = shown.get(item.group) ?? 0;
    if (n >= perGroup) return [];
    shown.set(item.group, n + 1);
    return [item];
  });
}

// What the server's search (#673) is asked for, or null: two characters at least, and a letter or a digit among them
// (the server answers nothing for "!!" anyway).
export function searchTerm(query: string): string | null {
  const q = query.trim();
  return q.length >= 2 && /[\p{L}\p{N}]/u.test(q) ? q.slice(0, 100) : null;
}

// The palette's list: what filterPalette kept, then what the server's search found, in PALETTE_GROUPS order so the
// arrow keys walk the list as it is shown. Found entries are not filtered again: the server matched them, by words
// a label may not show (a typed amount, a tax code).
export function withFound<T extends PaletteItem>(local: readonly T[], found: readonly T[]): T[] {
  return [...local, ...found]
    .map((item, index) => ({ item, index }))
    .sort((a, b) => PALETTE_GROUPS.indexOf(a.item.group) - PALETTE_GROUPS.indexOf(b.item.group) || a.index - b.index)
    .map(({ item }) => item);
}

interface KeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey?: boolean;
  repeat?: boolean;
}

// Ctrl K, or Cmd K on a Mac, toggles the palette from anywhere, even while typing in a field.
export function isPaletteShortcut(event: KeyLike): boolean {
  return (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && !event.repeat && event.key.toLowerCase() === 'k';
}

// The step the arrow keys take through `count` results from `active`, wrapping at both ends; null for any other key.
// Home and End stay with the text field (the editable combobox pattern), so they move the caret.
export function moveActive(key: string, active: number, count: number): number | null {
  if (count === 0) return null;
  if (key === 'ArrowDown') return (active + 1) % count;
  if (key === 'ArrowUp') return (active - 1 + count) % count;
  return null;
}
