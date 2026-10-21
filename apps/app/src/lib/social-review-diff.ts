// What changed in a channel since its last review decision (#944): a word-level diff of the text, the images or videos
// added and removed, and the settings whose value changed. Pure functions, so the review panel only draws the result.

export type DiffKind = 'same' | 'added' | 'removed';
export interface DiffPart {
  kind: DiffKind;
  text: string;
}

// A word (letters, combining marks and digits, so a Vietnamese word with its diacritics stays one token whether it is
// typed composed or decomposed), a line break, a run of other white space, or any other single character.
const TOKEN = /[\p{L}\p{M}\p{N}_]+|\r?\n|[^\S\r\n]+|[^\p{L}\p{M}\p{N}_\s]/gu;

export function tokenize(text: string): string[] {
  return text.match(TOKEN) ?? [];
}

// Above this many cells the longest-common-subsequence table is not built: the changed middle is compared line by line,
// and when even that is too big, shown as removed then added.
const MAX_CELLS = 2_000_000;

// The longest common subsequence of two token lists, as parts in order.
function lcs(a: readonly string[], b: readonly string[]): DiffPart[] {
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  // lengths[i * width + j]: the LCS length of a[i..] and b[j..].
  const lengths = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lengths[i * width + j] = a[i] === b[j] ? (lengths[(i + 1) * width + j + 1] ?? 0) + 1 : Math.max(lengths[(i + 1) * width + j] ?? 0, lengths[i * width + j + 1] ?? 0);
    }
  }
  const parts: DiffPart[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      parts.push({ kind: 'same', text: a[i] as string });
      i++;
      j++;
    } else if ((lengths[(i + 1) * width + j] ?? 0) >= (lengths[i * width + j + 1] ?? 0)) {
      parts.push({ kind: 'removed', text: a[i] as string });
      i++;
    } else {
      parts.push({ kind: 'added', text: b[j] as string });
      j++;
    }
  }
  for (; i < n; i++) parts.push({ kind: 'removed', text: a[i] as string });
  for (; j < m; j++) parts.push({ kind: 'added', text: b[j] as string });
  return parts;
}

// Lines with their line break, so a line-level diff joins back into the same text.
const lines = (tokens: readonly string[]): string[] => {
  const out: string[] = [];
  let line = '';
  for (const t of tokens) {
    line += t;
    if (t === '\n' || t === '\r\n') {
      out.push(line);
      line = '';
    }
  }
  if (line) out.push(line);
  return out;
};

function middle(a: readonly string[], b: readonly string[]): DiffPart[] {
  if (a.length === 0 || b.length === 0 || (a.length + 1) * (b.length + 1) <= MAX_CELLS) return lcs(a, b);
  const la = lines(a);
  const lb = lines(b);
  if ((la.length + 1) * (lb.length + 1) <= MAX_CELLS) return lcs(la, lb);
  return [
    { kind: 'removed', text: a.join('') },
    { kind: 'added', text: b.join('') },
  ];
}

// Each run of changes between unchanged text reads as what was removed, then what was added. White space alone between
// two changes joins the run, so "a b c" to "a x y c" reads "a [b → x y] c" rather than word by interleaved word.
function tidy(parts: readonly DiffPart[]): DiffPart[] {
  const out: DiffPart[] = [];
  let removed = '';
  let added = '';
  const flush = () => {
    if (removed) out.push({ kind: 'removed', text: removed });
    if (added) out.push({ kind: 'added', text: added });
    removed = '';
    added = '';
  };
  for (const [i, p] of parts.entries()) {
    const inRun = removed !== '' || added !== '';
    const next = parts[i + 1];
    if (p.kind === 'same' && inRun && /^[^\S\r\n]+$/.test(p.text) && next !== undefined && next.kind !== 'same') {
      removed += p.text;
      added += p.text;
      continue;
    }
    if (p.kind === 'removed') removed += p.text;
    else if (p.kind === 'added') added += p.text;
    else {
      flush();
      const last = out[out.length - 1];
      if (last?.kind === 'same') last.text += p.text;
      else out.push({ kind: 'same', text: p.text });
    }
  }
  flush();
  return out;
}

// A word-level diff of two texts. Both are compared in NFC, as the content hash compares them, so the same Vietnamese
// text typed with composed or decomposed diacritics is unchanged.
export function diffText(before: string, after: string): DiffPart[] {
  const a = tokenize(before.normalize('NFC'));
  const b = tokenize(after.normalize('NFC'));
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  const parts: DiffPart[] = [];
  if (start > 0) parts.push({ kind: 'same', text: a.slice(0, start).join('') });
  parts.push(...middle(a.slice(start, a.length - end), b.slice(start, b.length - end)));
  if (end > 0) parts.push({ kind: 'same', text: a.slice(a.length - end).join('') });
  return tidy(parts);
}

export const textChanged = (parts: readonly DiffPart[]) => parts.some((p) => p.kind !== 'same');

export interface DiffMedia {
  fileId: string;
  altText: string | null;
  mime: string | null;
}

export interface MediaChanges {
  added: DiffMedia[];
  removed: DiffMedia[];
  // Kept, with another description for screen readers.
  altChanged: Array<{ fileId: string; mime: string | null; before: string | null; after: string | null }>;
  // The same files in another order.
  reordered: boolean;
}

export function diffMedia(before: readonly DiffMedia[], after: readonly DiffMedia[]): MediaChanges {
  const was = new Map(before.map((m) => [m.fileId, m]));
  const now = new Set(after.map((m) => m.fileId));
  const kept = after.filter((m) => was.has(m.fileId));
  const keptBefore = before.filter((m) => now.has(m.fileId));
  return {
    added: after.filter((m) => !was.has(m.fileId)),
    removed: before.filter((m) => !now.has(m.fileId)),
    altChanged: kept.flatMap((m) => {
      const old = (was.get(m.fileId) as DiffMedia).altText ?? null;
      return (old ?? '') === (m.altText ?? '') ? [] : [{ fileId: m.fileId, mime: m.mime, before: old, after: m.altText ?? null }];
    }),
    reordered: kept.some((m, i) => keptBefore[i]?.fileId !== m.fileId),
  };
}

export const mediaChanged = (c: MediaChanges) => c.added.length > 0 || c.removed.length > 0 || c.altChanged.length > 0 || c.reordered;

// JSON with sorted keys, so the order jsonb returns an object in is not a change.
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))) : v,
  );
}

const COMPACT_MAX = 80;

// A setting's value in one short line: a string as it is, anything else as JSON, cut at 80 characters.
export function compactValue(value: unknown): string {
  const text = typeof value === 'string' ? value : (canonical(value) ?? String(value));
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > COMPACT_MAX ? `${flat.slice(0, COMPACT_MAX - 1)}…` : flat;
}

export interface SettingChange {
  key: string;
  // null: the setting was not set on that side.
  before: string | null;
  after: string | null;
}

export function diffSettings(before: Readonly<Record<string, unknown>>, after: Readonly<Record<string, unknown>>): SettingChange[] {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return keys.flatMap((key) => {
    const a = Object.hasOwn(before, key) && before[key] !== undefined ? before[key] : undefined;
    const b = Object.hasOwn(after, key) && after[key] !== undefined ? after[key] : undefined;
    if (a === undefined && b === undefined) return [];
    if (a !== undefined && b !== undefined && canonical(a) === canonical(b)) return [];
    return [{ key, before: a === undefined ? null : compactValue(a), after: b === undefined ? null : compactValue(b) }];
  });
}

export interface ReviewContent {
  body: string;
  title: string | null;
  linkUrl: string | null;
  media: readonly DiffMedia[];
  settings: Readonly<Record<string, unknown>>;
}

export interface ReviewDiff {
  // null when that part did not change.
  body: DiffPart[] | null;
  title: DiffPart[] | null;
  link: { before: string | null; after: string | null } | null;
  media: MediaChanges | null;
  settings: SettingChange[];
}

// The changes from the content of the last decision to the content now; null when a reader would see none.
export function reviewDiff(before: ReviewContent, after: ReviewContent): ReviewDiff | null {
  const body = diffText(before.body, after.body);
  const title = diffText(before.title ?? '', after.title ?? '');
  const linkBefore = before.linkUrl || null;
  const linkAfter = after.linkUrl || null;
  const media = diffMedia(before.media, after.media);
  const diff: ReviewDiff = {
    body: textChanged(body) ? body : null,
    title: textChanged(title) ? title : null,
    link: linkBefore === linkAfter ? null : { before: linkBefore, after: linkAfter },
    media: mediaChanged(media) ? media : null,
    settings: diffSettings(before.settings, after.settings),
  };
  return diff.body || diff.title || diff.link || diff.media || diff.settings.length > 0 ? diff : null;
}
