// Suggested edits (#1236): the words a member selected in a text box, as the server takes them (offsets in UTF-16 code
// units, as the browser counts them). The server checks them again against the text it holds.

export interface SelectedRange {
  start: number;
  end: number;
  quote: string;
}

// The most characters a suggestion quotes (the contract's SOCIAL_SUGGESTION_MAX).
export const SUGGEST_QUOTE_MAX = 4000;

const HIGH = /[\uD800-\uDBFF]/;
const LOW = /[\uDC00-\uDFFF]/;

/**
 * The selection of a text, or null when nothing is selected or too much is. A selection that cuts an emoji in two is
 * widened to the whole emoji, and white space at its ends is left out (a double click often takes the space after a
 * word).
 */
export function selectedRange(text: string, selectionStart: number | null, selectionEnd: number | null): SelectedRange | null {
  if (selectionStart === null || selectionEnd === null) return null;
  let start = Math.max(0, Math.min(selectionStart, selectionEnd));
  let end = Math.min(text.length, Math.max(selectionStart, selectionEnd));
  if (start > 0 && LOW.test(text[start] ?? '') && HIGH.test(text[start - 1] ?? '')) start -= 1;
  if (end < text.length && LOW.test(text[end] ?? '') && HIGH.test(text[end - 1] ?? '')) end += 1;
  while (start < end && /\s/.test(text[start] ?? '')) start += 1;
  while (end > start && /\s/.test(text[end - 1] ?? '')) end -= 1;
  if (end <= start || end - start > SUGGEST_QUOTE_MAX) return null;
  return { start, end, quote: text.slice(start, end) };
}
