// Find and replace in post text (#1144), pure. The pattern is literal text, never a regular expression: it is searched
// for with indexOf, so no character of it means anything special and no input can make the search backtrack. Matches
// are found left to right and never overlap; the replacement goes in as it was typed ($1 or $& are plain text too).
//
// Case-insensitive search folds each UTF-16 unit of the text and the pattern to lower case where the lower case is one
// unit (Đ and đ, Ạ and ạ, A and a), so positions in the folded text are positions in the text. A whole word is a match
// with no letter, digit, combining mark or underscore right before or after it, so "sale" does not match in "wholesale".
export interface ReplaceOptions {
  find: string;
  replace: string;
  caseSensitive: boolean;
  wholeWord: boolean;
}

// The text around the first match, for the preview: up to REPLACE_CONTEXT units on each side, with an ellipsis where the
// text goes on.
export const REPLACE_CONTEXT = 40;
export interface ReplaceExcerpt {
  before: string;
  match: string;
  after: string;
}

export type ReplaceOutcome =
  // count 0: no match, text unchanged.
  | { count: number; text: string; first: ReplaceExcerpt | null; overflow: false }
  // The result would be longer than max: given up as soon as that is known, so a short pattern and a long replacement
  // never build a huge string.
  | { count: number; text: null; first: ReplaceExcerpt | null; overflow: true };

function fold(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charAt(i);
    const lower = c.toLowerCase();
    out += lower.length === 1 ? lower : c;
  }
  return out;
}

const WORD = /[\p{L}\p{N}\p{M}_]/u;
const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff;

// The code point that ends right before i, and the one that starts at i ('' at either end of the text).
function before(s: string, i: number): string {
  if (i <= 0) return '';
  if (i >= 2 && isLow(s.charCodeAt(i - 1)) && isHigh(s.charCodeAt(i - 2))) return s.slice(i - 2, i);
  return s.charAt(i - 1);
}
function after(s: string, i: number): string {
  if (i >= s.length) return '';
  return String.fromCodePoint(s.codePointAt(i) as number);
}

function excerpt(text: string, at: number, end: number): ReplaceExcerpt {
  let start = Math.max(0, at - REPLACE_CONTEXT);
  let stop = Math.min(text.length, end + REPLACE_CONTEXT);
  // Never half a surrogate pair at either edge.
  if (start > 0 && isLow(text.charCodeAt(start))) start -= 1;
  if (stop < text.length && isLow(text.charCodeAt(stop))) stop += 1;
  return {
    before: `${start > 0 ? '…' : ''}${text.slice(start, at)}`,
    match: text.slice(at, end),
    after: `${text.slice(end, stop)}${stop < text.length ? '…' : ''}`,
  };
}

// Every match of the pattern in the text replaced, with the number of matches and the first one in its context.
export function replaceLiteral(text: string, options: ReplaceOptions, max = Number.POSITIVE_INFINITY): ReplaceOutcome {
  const { find, replace } = options;
  if (find.length === 0 || text.length < find.length) return { count: 0, text, first: null, overflow: false };
  const hay = options.caseSensitive ? text : fold(text);
  const needle = options.caseSensitive ? find : fold(find);
  let out = '';
  let last = 0;
  let from = 0;
  let count = 0;
  let first: ReplaceExcerpt | null = null;
  while (from <= hay.length - needle.length) {
    const at = hay.indexOf(needle, from);
    if (at < 0) break;
    const end = at + needle.length;
    if (options.wholeWord && (WORD.test(before(text, at)) || WORD.test(after(text, end)))) {
      from = at + 1;
      continue;
    }
    first ??= excerpt(text, at, end);
    out += text.slice(last, at) + replace;
    last = end;
    from = end;
    count += 1;
    if (out.length > max) return { count, text: null, first, overflow: true };
  }
  if (count === 0) return { count: 0, text, first: null, overflow: false };
  out += text.slice(last);
  if (out.length > max) return { count, text: null, first, overflow: true };
  return { count, text: out, first, overflow: false };
}
