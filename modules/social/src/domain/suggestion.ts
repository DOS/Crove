// Suggested edits (#1236): where a suggestion's quoted words are in a text now, and the text with them replaced. Pure
// functions; offsets are UTF-16 code units, as JavaScript strings and the browser's text selection count them.
//
// A suggestion was made against one text: the words [start, end) of it, `quote`. That text may have changed since
// (another suggestion accepted, an edit). The quote still applies:
// - where it was, when the text there is still the quote;
// - else where it is now, when the text holds it exactly once (an edit before it moved it);
// - else nowhere: the suggestion is outdated and is never applied.

import { createHash } from 'node:crypto';
import { FROZEN, IN_FLIGHT, type VariantStatus } from './state.ts';

/** The hash a suggestion records of the whole text it was made against. */
export const textHash = (text: string): string => 'sha256:' + createHash('sha256').update(text, 'utf8').digest('hex');

export interface SuggestedRange {
  start: number;
  end: number;
  quote: string;
}

// How many characters around the quote a view shows, on each side.
export const SUGGESTION_CONTEXT = 40;

/** Where the quote applies in `text` now, or null when it no longer does (outdated). */
export function locateSuggestion(text: string, s: SuggestedRange): { start: number; end: number } | null {
  if (s.quote === '' || s.end - s.start !== s.quote.length) return null;
  if (text.slice(s.start, s.end) === s.quote) return { start: s.start, end: s.end };
  const at = text.indexOf(s.quote);
  if (at === -1 || text.indexOf(s.quote, at + 1) !== -1) return null;
  return { start: at, end: at + s.quote.length };
}

/** The text with the range replaced. */
export function replaceRange(text: string, at: { start: number; end: number }, replacement: string): string {
  return text.slice(0, at.start) + replacement + text.slice(at.end);
}

/** The words just before and after the range, at most SUGGESTION_CONTEXT characters each, cut on whole characters. */
export function contextOf(text: string, at: { start: number; end: number }): { before: string; after: string } {
  const before = Array.from(text.slice(0, at.start));
  const after = Array.from(text.slice(at.end));
  return { before: before.slice(-SUGGESTION_CONTEXT).join(''), after: after.slice(0, SUGGESTION_CONTEXT).join('') };
}

// A channel that went out, or is going out now: its text no longer changes, so no suggestion is made on it or applied.
export const channelFrozen = (v: { status: VariantStatus; content_frozen: boolean }): boolean => v.content_frozen || FROZEN.has(v.status) || IN_FLIGHT.has(v.status);
// The post's own text changes no channel any more once every channel went out.
export const postFrozen = (variants: readonly { status: VariantStatus; content_frozen: boolean }[]): boolean => variants.length > 0 && variants.every(channelFrozen);

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Whether a string holds only whole characters (a selection never splits an emoji in two). */
export const wholeCharacters = (s: string): boolean => !LONE_SURROGATE.test(s);
