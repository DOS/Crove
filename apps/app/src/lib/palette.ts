// The command palette (issue #439, DESIGN.md 5.2): which entries match what the user typed, in which order, and the
// key that opens it. No browser or React imports, so it is unit tested.

export type PaletteGroup = 'go' | 'proposals' | 'orgs' | 'actions';

export const PALETTE_GROUPS: readonly PaletteGroup[] = ['go', 'proposals', 'orgs', 'actions'];

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
