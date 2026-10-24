// Text variations (#1260, as SocialBee's post variations and ContentStudio's evergreen campaign): an evergreen (#393)
// or recurring (#979) post keeps up to 5 other texts, and each copy the worker makes takes the next one in turn as its
// text, wrapping around, so X and LinkedIn, which refuse a repeated text (#1156), get a new one each time. The post
// keeps the position of the next one (a cursor). Pure: the commands read and write the list under the post's lock.

export const TEXT_VARIATIONS_MAX = 5;
// A variation is the copy's text, so it takes a post text's limit (crove_social.text_variations_valid).
export const TEXT_VARIATION_CHARS_MAX = 100_000;

export interface TextVariation {
  text: string;
  // Written by AI (#583): a copy made from it is tainted, and reviewed like any AI text.
  ai: boolean;
}

/**
 * The stored list as the commands wrote it, or [] when the value is not one (the database refuses other shapes, so []
 * here means no variations).
 */
export function parseTextVariations(value: unknown): TextVariation[] {
  if (!Array.isArray(value) || value.length > TEXT_VARIATIONS_MAX) return [];
  const out: TextVariation[] = [];
  for (const item of value) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return [];
    const { text, ai } = item as Record<string, unknown>;
    if (typeof text !== 'string' || typeof ai !== 'boolean' || text.trim() === '' || text.length > TEXT_VARIATION_CHARS_MAX) return [];
    out.push({ text, ai });
  }
  return new Set(out.map((v) => v.text)).size === out.length ? out : [];
}

// The cursor as a position of a list of `count`: 0 for an empty list, else wrapped into it.
export function cursorOf(count: number, cursor: number): number {
  if (count <= 0 || !Number.isInteger(cursor) || cursor < 0) return 0;
  return cursor % count;
}

// The positions in the order the next copy tries them: the cursor's first, then the next ones in turn, wrapping.
export function variationOrder(count: number, cursor: number): number[] {
  const start = cursorOf(count, cursor);
  return Array.from({ length: Math.max(count, 0) }, (_, i) => (start + i) % count);
}

/**
 * The variation the next copy takes, and the cursor after it: the one at the cursor, unless its text would repeat a
 * recent post on a channel that refuses that (`repeats`), when the next one in turn that would not is taken. When every
 * one would, the one at the cursor is taken all the same (the post page and review then warn, as for any copy). Null
 * for an empty list: the copy repeats what went out.
 */
export function pickVariation(count: number, cursor: number, repeats: (index: number) => boolean): { index: number; next: number } | null {
  if (count <= 0) return null;
  const index = variationOrder(count, cursor).find((at) => !repeats(at)) ?? cursorOf(count, cursor);
  return { index, next: (index + 1) % count };
}

/**
 * The cursor after a person replaced the list: it stays on the variation it named when that text is still there
 * (moved, or others added or removed around it), else on the same position when the list is still that long, else on
 * the first.
 */
export function cursorAfterEdit(before: readonly TextVariation[], cursor: number, after: readonly TextVariation[]): number {
  if (after.length === 0) return 0;
  const named = before[cursorOf(before.length, cursor)];
  if (named) {
    const moved = after.findIndex((v) => v.text === named.text);
    if (moved >= 0) return moved;
  }
  return cursor >= 0 && cursor < after.length ? cursor : 0;
}

/**
 * The list a person saved, with the AI mark kept on every text that had it: a save never drops the mark from a text
 * it did not change (the page keeps it on an AI text a person edits, too). Texts are kept as given.
 */
export function keepAiMarks(before: readonly TextVariation[], after: readonly TextVariation[]): TextVariation[] {
  const ai = new Set(before.filter((v) => v.ai).map((v) => v.text));
  return after.map((v) => ({ text: v.text, ai: v.ai || ai.has(v.text) }));
}
