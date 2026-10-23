// Bold and italic text (#1179), as Planable's and Publer's composer buttons make it: Facebook, LinkedIn, X and Threads
// have no rich text, so a styled word is written with the letters of Unicode's Mathematical Alphanumeric Symbols block
// (U+1D400 to U+1D7FF), which every platform shows as is. Pure and isomorphic: the composer styles the selection with
// it, and the banned-word matcher and the duplicate check fold the block back to plain letters before comparing, so a
// word typed in bold is the same word.
//
// Styling maps A to Z and a to z of the selection, and for bold and bold italic the digits 0 to 9 (the block has no
// italic digits, so italic leaves them plain and bold italic uses the bold ones). Vietnamese letters are taken apart
// (NFD): the base letter is mapped and its combining marks kept after it, then the text is put back together (NFC),
// which leaves a styled letter with its marks and recomposes everything else; đ and Đ have no base letter to map and
// stay plain, as do other scripts, punctuation and spaces. Links (with a scheme, www., an email or a bare address on
// a known top-level domain), hashtags, @mentions and emoji are never changed, even inside the selection, so a hashtag
// keeps working and a keycap emoji (1️⃣) keeps its digit: the same token rules as the AI proofread's check
// (packages/agent/src/proofread.ts, which this browser-safe module cannot import). Removing the style folds the
// selection back to plain letters, tokens included (a plain token is unchanged by it; a styled one becomes plain).
//
// The block leaves out letters Unicode had encoded before it, in Letterlike Symbols: italic h is U+210E (ℎ), and a
// few script, fraktur and double-struck capitals and small letters. Styling writes ℎ for italic h, and folding maps
// those 24 letterlike symbols back too, besides the block itself; nothing else is folded (not full NFKC), so a
// superscript, a circled letter or a full-width letter stays what it is.
//
// Counting: each styled letter is one code point above U+FFFF (two UTF-16 units). X counts it 2 in its weighted count
// (countText 'weighted' already does: only characters up to U+10FF count 1), and a Vietnamese mark after it 1 more,
// since a styled letter cannot be precomposed with its marks; Threads and Mastodon count code points. Screen readers
// read these letters badly or spell them out, and search may not find them, so the composer says to keep them for a
// few words.

export const TEXT_STYLES = ['bold', 'italic', 'boldItalic'] as const;
export type TextStyle = (typeof TEXT_STYLES)[number];

// The first code point of each style's capitals, small letters and digits (null: the style has no digits).
const STYLE_START: Readonly<Record<TextStyle, { upper: number; lower: number; digit: number | null }>> = {
  bold: { upper: 0x1d400, lower: 0x1d41a, digit: 0x1d7ce },
  italic: { upper: 0x1d434, lower: 0x1d44e, digit: null },
  boldItalic: { upper: 0x1d468, lower: 0x1d482, digit: 0x1d7ce },
};
// The holes in the styles used here: where the block's code point is reserved, the letter it would be.
const STYLE_HOLES: ReadonlyMap<number, number> = new Map([[0x1d455, 0x210e]]);

// The letterlike symbols standing in for the block's reserved code points: italic h; script B E F H I L M R e g o;
// fraktur C H I R Z; double-struck C H N P Q R Z.
const LETTERLIKE_HOLES = 'ℎℬℰℱℋℐℒℳℛℯℊℴℭℌℑℜℨℂℍℕℙℚℝℤ';
const HOLE_SET: ReadonlySet<number> = new Set([...LETTERLIKE_HOLES].map((c) => c.codePointAt(0) as number));
const FOLDABLE = new RegExp(`[\\u{1D400}-\\u{1D7FF}${LETTERLIKE_HOLES}]`, 'gu');
const HAS_FOLDABLE = new RegExp(FOLDABLE.source, 'u');

/** Whether a code point is one folding maps: the Mathematical Alphanumeric block, or one of the letterlike symbols in its holes. */
export const isFoldable = (cp: number): boolean => (cp >= 0x1d400 && cp <= 0x1d7ff) || HOLE_SET.has(cp);

// Each foldable character's plain form, NFKC of the character alone: one code point (a Latin or Greek letter, a digit,
// or a symbol such as ∇), or the character itself for a reserved code point.
const folded = new Map<string, string>();
const foldOne = (ch: string): string => {
  let plain = folded.get(ch);
  if (plain === undefined) {
    plain = ch.normalize('NFKC');
    folded.set(ch, plain);
  }
  return plain;
};

/**
 * The text with every Mathematical Alphanumeric symbol (and the letterlike symbols in the block's holes) as its plain
 * letter or digit; nothing else changes, not even the normal form. A bold 𝐀 is A and a bold Greek 𝚨 is Greek Α, never a
 * Latin A.
 */
export function foldMathAlphanumerics(text: string): string {
  return HAS_FOLDABLE.test(text) ? text.replace(FOLDABLE, foldOne) : text;
}

/** Whether the text holds styled letters (anything folding would change). */
export const hasStyledText = (text: string): boolean => HAS_FOLDABLE.test(text);

function styleCodePoint(cp: number, style: TextStyle): number {
  const start = STYLE_START[style];
  let out = cp;
  if (cp >= 0x41 && cp <= 0x5a) out = start.upper + (cp - 0x41);
  else if (cp >= 0x61 && cp <= 0x7a) out = start.lower + (cp - 0x61);
  else if (cp >= 0x30 && cp <= 0x39 && start.digit !== null) out = start.digit + (cp - 0x30);
  return STYLE_HOLES.get(out) ?? out;
}

/** The text in a style (or plain, with null), every character of it: the composer's selection goes through styleSelection, which keeps tokens. */
export function styleText(text: string, style: TextStyle | null): string {
  const plain = foldMathAlphanumerics(text).normalize('NFD');
  if (style === null) return plain.normalize('NFC');
  let out = '';
  for (const ch of plain) out += String.fromCodePoint(styleCodePoint(ch.codePointAt(0) as number, style));
  return out.normalize('NFC');
}

// Tokens never styled, as the AI proofread's check finds them (packages/agent/src/proofread.ts).
const TLDS = 'com|net|org|vn|io|co|me|app|shop|store|info|biz|asia|online|site|xyz|dev|ai|edu|gov|link|page|cc|tv';
const LINK = new RegExp(
  [
    String.raw`(?:https?:\/\/|www\.)[^\s<>"'“”‘’]+`,
    String.raw`[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+`,
    String.raw`(?<![\p{L}\p{N}_.@-])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:${TLDS})(?:\.vn)?(?![\p{L}\p{N}_-])(?:\/[^\s<>"'“”‘’]*)?`,
  ].join('|'),
  'giu',
);
const HASHTAG = /(?<![\p{L}\p{M}\p{N}_&#])#[\p{L}\p{M}\p{N}_]+/gu;
const MENTION = /(?<![\p{L}\p{M}\p{N}_.@])@[\p{L}\p{M}\p{N}_.]+/gu;
const EMOJI = /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u;
let graphemes: Intl.Segmenter | null = null;

/** The UTF-16 ranges [start, end) of the text's links, hashtags, @mentions and emoji, sorted and merged. */
export function styleTokens(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const pattern of [LINK, HASHTAG, MENTION]) for (const m of text.matchAll(pattern)) ranges.push([m.index, m.index + m[0].length]);
  graphemes ??= new Intl.Segmenter('en', { granularity: 'grapheme' });
  for (const { segment, index } of graphemes.segment(text)) if (EMOJI.test(segment)) ranges.push([index, index + segment.length]);
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  return merged;
}

const MARK = /^\p{M}$/u;
const isLowSurrogate = (text: string, i: number) => {
  const c = text.charCodeAt(i);
  return c >= 0xdc00 && c <= 0xdfff;
};
// Moves an offset off the middle of a surrogate pair and off the marks of a letter, so no letter is cut from its marks.
function startOfUnit(text: string, i: number): number {
  let at = i;
  while (at > 0 && at < text.length && (isLowSurrogate(text, at) || MARK.test(String.fromCodePoint(text.codePointAt(at) as number)))) at -= isLowSurrogate(text, at - 1) ? 2 : 1;
  return Math.max(0, at);
}
function endOfUnit(text: string, i: number): number {
  let at = i;
  while (at > 0 && at < text.length && (isLowSurrogate(text, at) || MARK.test(String.fromCodePoint(text.codePointAt(at) as number)))) at += isLowSurrogate(text, at) ? 1 : (text.codePointAt(at) as number) > 0xffff ? 2 : 1;
  return Math.min(text.length, at);
}

/**
 * The text with its selection [start, end) (UTF-16 offsets, as a textarea gives them) in a style, or plain with null,
 * and the selection over the changed part. The selection is widened to whole letters with their marks; links,
 * hashtags, @mentions and emoji in it (found in the whole text, so one the selection cuts is kept whole) are left as
 * they are when styling. An empty selection changes nothing.
 */
export function styleSelection(text: string, start: number, end: number, style: TextStyle | null): { text: string; start: number; end: number } {
  // An empty selection changes nothing, even one inside a letter and its marks.
  const lo = Math.max(0, Math.min(start, end, text.length));
  const hi = Math.max(0, Math.min(Math.max(start, end), text.length));
  if (lo === hi) return { text, start: lo, end: hi };
  const from = startOfUnit(text, lo);
  const to = endOfUnit(text, Math.max(from, hi));
  if (from === to) return { text, start: from, end: to };
  let out = '';
  let at = from;
  const plainToken = (token: string) => {
    const plain = foldMathAlphanumerics(token);
    return plain === token ? token : plain.normalize('NFC');
  };
  for (const [a, b] of styleTokens(text)) {
    if (b <= at) continue;
    if (a >= to) break;
    if (a > at) out += styleText(text.slice(at, a), style);
    const token = text.slice(Math.max(a, at), Math.min(b, to));
    out += style === null ? plainToken(token) : token;
    at = Math.min(b, to);
  }
  if (at < to) out += styleText(text.slice(at, to), style);
  return { text: text.slice(0, from) + out + text.slice(to), start: from, end: from + out.length };
}
