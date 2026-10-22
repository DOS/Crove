// Banned and sensitive words (#1055): an org's list of words or phrases it does not want in its posts, each a warning
// or a block, for every channel or some. Pure and isomorphic: the composer marks matches as a person types with the same
// rules the commands apply before review, approval and scheduling. Crove ships no list of its own; a preset based on
// advertising law needs a lawyer's review first.
//
// Matching works on units: a character with the combining marks that follow it, so a letter typed decomposed (a + ́)
// is the same unit as the precomposed one. Two units match when they are the same letter ignoring case (after NFC), or
// when they share a base letter and one of them carries no mark: "chua khoi" matches "chữa khỏi" and the other way
// round, and "đ" matches "d", while "chưa" does not match "chữa", whose marks differ. A space in a phrase matches any
// run of white space. Format characters (zero-width spaces and joiners, the soft hyphen) inside a match are skipped,
// so they cannot hide a word. A phrase that starts or ends with a letter or digit matches only at a word boundary:
// the unit before and after it is not a letter or digit (Unicode letters and digits, so Vietnamese, Thai or CJK
// letters count, and emoji or punctuation do not). Ranges are UTF-16 offsets into the text as given, never inside a
// surrogate pair or between a letter and its marks.

export const BANNED_WORD_LEVELS = ['warn', 'block'] as const;
export type BannedWordLevel = (typeof BANNED_WORD_LEVELS)[number];
// The longest phrase and reason the table takes, and how many words an org may list.
export const BANNED_PHRASE_MAX = 100;
export const BANNED_REASON_MAX = 200;
export const BANNED_WORDS_MAX = 500;
// The most channels one word may be limited to.
export const BANNED_WORD_CHANNELS_MAX = 50;

export interface BannedWord {
  id: string;
  phrase: string;
  level: BannedWordLevel;
  reason: string | null;
  // The channels (connection ids) it applies to; every channel when empty.
  connectionIds: readonly string[];
}

export interface BannedMatch {
  wordId: string;
  phrase: string;
  level: BannedWordLevel;
  reason: string | null;
  // UTF-16 offsets of the match in the text as given, end exclusive.
  start: number;
  end: number;
}

// A match in one of a variant's texts: 'body', 'title', 'settings.firstComment', 'settings.threadParts.<index>',
// 'settings.autoReply.text' or 'settings.poll.<index>'.
export interface BannedFieldMatch extends BannedMatch {
  field: string;
}

const MARK = /^\p{M}$/u;
const WORD = /^[\p{L}\p{N}]$/u;
const SPACE = /^\s$/u;
const FORMAT = /^\p{Cf}$/u;
const FORMATS = /\p{Cf}/gu;
const MARKS = /\p{M}/gu;

interface Unit {
  start: number;
  end: number;
  // The unit in NFC, lower case.
  exact: string;
  // Its base letter, lower case, without marks; đ as d.
  base: string;
  marked: boolean;
  space: boolean;
  word: boolean;
  format: boolean;
}

function units(text: string): Unit[] {
  const out: Unit[] = [];
  let i = 0;
  while (i < text.length) {
    const start = i;
    const cp = text.codePointAt(i) as number;
    i += cp > 0xffff ? 2 : 1;
    while (i < text.length) {
      const next = text.codePointAt(i) as number;
      if (!MARK.test(String.fromCodePoint(next))) break;
      i += next > 0xffff ? 2 : 1;
    }
    const first = String.fromCodePoint(cp);
    const raw = text.slice(start, i);
    const exact = raw.normalize('NFC').toLowerCase();
    const stripped = raw.normalize('NFD').replace(MARKS, '').toLowerCase();
    const base = stripped === 'đ' ? 'd' : stripped === '' ? exact : stripped;
    out.push({ start, end: i, exact, base, marked: base !== exact, space: SPACE.test(first), word: WORD.test(first), format: FORMAT.test(first) });
  }
  return out;
}

/** The phrase as the matcher compares it, and as the table keeps it unique: NFC, format characters dropped, white space collapsed to one space, trimmed, lower case. */
export function normalizePhrase(phrase: string): string {
  return phrase.normalize('NFC').replace(FORMATS, '').replace(/\s+/gu, ' ').trim().toLowerCase();
}

// A unit of the text against one of the phrase: the same letter, or the same base letter where one side has no mark.
const same = (t: Unit, p: Unit): boolean => t.base === p.base && (t.exact === p.exact || !t.marked || !p.marked);

// Where the phrase's units end when they match from text unit i, or null.
function matchAt(text: readonly Unit[], i: number, phrase: readonly Unit[]): number | null {
  let j = i;
  for (const [k, p] of phrase.entries()) {
    if (k > 0) while (j < text.length && (text[j] as Unit).format) j += 1;
    const t = text[j];
    if (!t) return null;
    if (p.space) {
      if (!t.space) return null;
      while (j < text.length && ((text[j] as Unit).space || (text[j] as Unit).format)) j += 1;
      continue;
    }
    if (!same(t, p)) return null;
    j += 1;
  }
  return j;
}

// Whether the nearest unit before i (or from i on), format characters skipped, is a letter or digit.
function wordBefore(text: readonly Unit[], i: number): boolean {
  for (let k = i - 1; k >= 0; k -= 1) if (!(text[k] as Unit).format) return (text[k] as Unit).word;
  return false;
}
function wordFrom(text: readonly Unit[], i: number): boolean {
  for (let k = i; k < text.length; k += 1) if (!(text[k] as Unit).format) return (text[k] as Unit).word;
  return false;
}

interface Compiled {
  word: BannedWord;
  units: Unit[];
}

/** The words, ready to match many texts: indexed by the base of their first letter. */
export interface BannedMatcher {
  readonly byFirst: ReadonlyMap<string, readonly Compiled[]>;
}

export function compileBannedWords(words: readonly BannedWord[]): BannedMatcher {
  const byFirst = new Map<string, Compiled[]>();
  for (const word of words) {
    const list = units(normalizePhrase(word.phrase));
    const first = list[0];
    if (!first) continue;
    const bucket = byFirst.get(first.base) ?? [];
    bucket.push({ word, units: list });
    byFirst.set(first.base, bucket);
  }
  return { byFirst };
}

const isMatcher = (x: readonly BannedWord[] | BannedMatcher): x is BannedMatcher => !Array.isArray(x);

/** Every match of the words in the text, by position (a longer match first where two start together). */
export function findBannedWords(text: string, words: readonly BannedWord[] | BannedMatcher): BannedMatch[] {
  const matcher = isMatcher(words) ? words : compileBannedWords(words);
  if (matcher.byFirst.size === 0 || text === '') return [];
  const list = units(text);
  const matches: BannedMatch[] = [];
  for (const [i, unit] of list.entries()) {
    const candidates = matcher.byFirst.get(unit.base);
    if (!candidates || unit.format) continue;
    for (const c of candidates) {
      const end = matchAt(list, i, c.units);
      if (end === null) continue;
      if ((c.units[0] as Unit).word && wordBefore(list, i)) continue;
      if ((c.units[c.units.length - 1] as Unit).word && wordFrom(list, end)) continue;
      const { id, phrase, level, reason } = c.word;
      matches.push({ wordId: id, phrase, level, reason, start: unit.start, end: (list[end - 1] as Unit).end });
    }
  }
  return matches.sort((a, b) => a.start - b.start || b.end - a.end);
}

/** The words that apply to a channel: those for every channel, and those limited to it. */
export function wordsForChannel(words: readonly BannedWord[], connectionId: string): BannedWord[] {
  return words.filter((w) => w.connectionIds.length === 0 || w.connectionIds.includes(connectionId));
}

/** The words that apply to any of these channels (the shared text of a post goes to all of them); all words when none is given. */
export function wordsForChannels(words: readonly BannedWord[], connectionIds: readonly string[]): BannedWord[] {
  if (connectionIds.length === 0) return [...words];
  return words.filter((w) => w.connectionIds.length === 0 || w.connectionIds.some((id) => connectionIds.includes(id)));
}

/** The texts of a variant a person wrote and the channel publishes: its text and title, and the texts in its settings. */
export function variantTexts(content: { body: string; title: string | null }, settings: Readonly<Record<string, unknown>> | undefined): Array<{ field: string; text: string }> {
  const out: Array<{ field: string; text: string }> = [{ field: 'body', text: content.body }];
  if (content.title) out.push({ field: 'title', text: content.title });
  const s = settings ?? {};
  if (typeof s.firstComment === 'string') out.push({ field: 'settings.firstComment', text: s.firstComment });
  if (Array.isArray(s.threadParts)) s.threadParts.forEach((part, i) => typeof part === 'string' && out.push({ field: `settings.threadParts.${i}`, text: part }));
  const reply = s.autoReply;
  if (reply !== null && typeof reply === 'object' && typeof (reply as { text?: unknown }).text === 'string') out.push({ field: 'settings.autoReply.text', text: (reply as { text: string }).text });
  const poll = s.poll;
  const options = poll !== null && typeof poll === 'object' ? (poll as { options?: unknown }).options : undefined;
  if (Array.isArray(options)) options.forEach((o, i) => typeof o === 'string' && out.push({ field: `settings.poll.${i}`, text: o }));
  return out;
}

/** The matches in each of the texts. */
export function findBannedInTexts(texts: ReadonlyArray<{ field: string; text: string }>, words: readonly BannedWord[] | BannedMatcher): BannedFieldMatch[] {
  const matcher = isMatcher(words) ? words : compileBannedWords(words);
  return texts.flatMap(({ field, text }) => findBannedWords(text, matcher).map((m) => ({ ...m, field })));
}
