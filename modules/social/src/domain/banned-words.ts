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
//
// What it does not catch: look-alike letters from other scripts (a Cyrillic "о" for "o"), punctuation or symbols put
// inside a word ("t.ố.t"), letters spaced out ("t ố t"), and misspellings. It is a help for honest writers and their
// reviewers, not a filter against someone set on getting a word through.
//
// Cost: the words are compiled into a trie over base letters, so a text is scanned in at most (text units) x (longest
// phrase) steps whatever the number of words, and the marks are checked only on a phrase that matched by its base
// letters. Every step counts against a budget (BANNED_OPS_MAX by default), and preparing text against its own cap in
// characters (BANNED_PREPARE_MAX, what a valid post may hold); past either the scan throws
// BannedWordsTooComplex, which a command turns into a refusal and a view into "not checked".

// The level of a word; the table's CHECK and SOCIAL_BANNED_WORD_LEVELS in @crove/db hold the same two (this module
// stays free of the database package, as the app imports it; banned-words.ts checks the two agree at compile time).
export const BANNED_WORD_LEVELS = ['warn', 'block'] as const;
export type BannedWordLevel = (typeof BANNED_WORD_LEVELS)[number];
// The longest phrase and reason the table takes, and how many words an org may list.
export const BANNED_PHRASE_MAX = 100;
export const BANNED_REASON_MAX = 200;
export const BANNED_WORDS_MAX = 500;
// The most channels one word may be limited to.
export const BANNED_WORD_CHANNELS_MAX = 50;
// The scan steps one check (one view, one composer field, one command on one post) may take: the part a crafted word
// list can amplify. A step costs about 12 ns, so the worst case stops within about 25 ms.
export const BANNED_OPS_MAX = 2_000_000;
// Cutting text into units is linear in its length, so it has its own cap in characters instead of sharing the scan's
// steps: what one post may hold once validated (the post's text, and on each of its 20 channels its own text, title
// and settings), so no valid post is refused for its length. About 0.25 us a character, the cap is about 0.6 s of
// work, which only the largest valid post reaches.
const POST_TEXT_MAX = 100_000;
const TITLE_MAX = 500;
const SETTINGS_BYTES_MAX = 16_384;
const CHANNELS_MAX = 20;
export const BANNED_PREPARE_MAX = POST_TEXT_MAX + TITLE_MAX + CHANNELS_MAX * (POST_TEXT_MAX + TITLE_MAX + SETTINGS_BYTES_MAX);
// A command that checks many posts (an import, a policy change over a channel's posts, the client step turned off)
// shares one budget across all of them, so the rows or posts do not multiply it: twice the scan steps, and text to
// prepare for a few posts at their longest (about 0.1 s). Past it, the rest fail closed: an import row stays a draft,
// a post stays in review.
export const BANNED_COMMAND_OPS_MAX = 2 * BANNED_OPS_MAX;
export const BANNED_COMMAND_PREPARE_MAX = 500_000;
// What reporting a match (once per word and text) costs, in scan steps.
export const MATCH_STEPS = 20;

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

/** The scan ran out of its budget: the text or the list is too large to check. */
export class BannedWordsTooComplex extends Error {
  constructor() {
    super('banned words check over budget');
    this.name = 'BannedWordsTooComplex';
  }
}

/** The scan steps and the characters to prepare a check may still use, shared by every text one command or view checks. */
export interface BannedBudget {
  left: number;
  prepareLeft: number;
}
export const bannedBudget = (ops: number = BANNED_OPS_MAX, prepare: number = BANNED_PREPARE_MAX): BannedBudget => ({ left: ops, prepareLeft: prepare });

function spend(budget: BannedBudget, n: number): void {
  budget.left -= n;
  if (budget.left < 0) throw new BannedWordsTooComplex();
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

/** A text cut into units once, with the lookups a scan needs, to check it against several word lists. */
export interface BannedText {
  readonly text: string;
  readonly units: readonly Unit[];
  // The first unit at or after i that is not a format character (units.length when none).
  readonly solid: Int32Array;
  // The first unit after the run of white space and format characters that starts at i.
  readonly afterSpace: Int32Array;
  // Whether the nearest unit before i, format characters skipped, is a letter or digit.
  readonly wordBefore: Uint8Array;
}

/** Cuts a text into units; with a budget, its length is charged to the budget's preparation cap first. */
export function prepareBannedText(text: string, budget?: BannedBudget): BannedText {
  if (budget) {
    budget.prepareLeft -= text.length;
    if (budget.prepareLeft < 0) throw new BannedWordsTooComplex();
  }
  const list = units(text);
  const n = list.length;
  const solid = new Int32Array(n + 1);
  const afterSpace = new Int32Array(n + 1);
  solid[n] = n;
  afterSpace[n] = n;
  for (let i = n - 1; i >= 0; i -= 1) {
    const u = list[i] as Unit;
    solid[i] = u.format ? (solid[i + 1] as number) : i;
    afterSpace[i] = u.space || u.format ? (afterSpace[i + 1] as number) : i;
  }
  const wordBefore = new Uint8Array(n + 1);
  let last = 0;
  for (let i = 0; i <= n; i += 1) {
    wordBefore[i] = last;
    const u = list[i];
    if (u && !u.format) last = u.word ? 1 : 0;
  }
  return { text, units: list, solid, afterSpace, wordBefore };
}

/** The phrase as the matcher compares it, and as the table keeps it unique: NFC, format characters dropped, white space collapsed to one space, trimmed, lower case. */
export function normalizePhrase(phrase: string): string {
  return phrase.normalize('NFC').replace(FORMATS, '').replace(/\s+/gu, ' ').trim().toLowerCase();
}

// A unit of the text against one of the phrase: the same letter, or the same base letter where one side has no mark.
const same = (t: Unit, p: Unit): boolean => t.base === p.base && (t.exact === p.exact || !t.marked || !p.marked);

interface Compiled {
  word: BannedWord;
  units: Unit[];
  // Its last unit is a letter or digit, so the match must end at a word boundary.
  wordEnd: boolean;
}

interface TrieNode {
  next: Map<string, TrieNode>;
  space: TrieNode | null;
  ends: Compiled[];
}

const node = (): TrieNode => ({ next: new Map(), space: null, ends: [] });

/** The words, ready to match many texts: a trie of their base letters, one for phrases that start with a letter or digit (which need a word boundary there) and one for the others. */
export interface BannedMatcher {
  readonly wordStart: TrieNode;
  readonly otherStart: TrieNode;
  readonly size: number;
}

export function compileBannedWords(words: readonly BannedWord[]): BannedMatcher {
  const wordStart = node();
  const otherStart = node();
  let size = 0;
  for (const word of words) {
    const list = units(normalizePhrase(word.phrase));
    const first = list[0];
    const last = list[list.length - 1];
    if (!first || !last) continue;
    let at = first.word ? wordStart : otherStart;
    for (const u of list) {
      if (u.space) {
        at.space ??= node();
        at = at.space;
      } else {
        let child = at.next.get(u.base);
        if (!child) {
          child = node();
          at.next.set(u.base, child);
        }
        at = child;
      }
    }
    at.ends.push({ word, units: list, wordEnd: last.word });
    size += 1;
  }
  return { wordStart, otherStart, size };
}

const isMatcher = (x: readonly BannedWord[] | BannedMatcher): x is BannedMatcher => !Array.isArray(x);

// Walks the trie from text unit i, recording the text unit each phrase unit matched (-1 for a space), and checks the
// marks of every phrase that ends on the way.
function walk(t: BannedText, i: number, root: TrieNode, budget: BannedBudget, path: number[], out: BannedMatch[], seen: Set<Compiled>): void {
  const list = t.units;
  const n = list.length;
  let at = root;
  let j = i;
  path.length = 0;
  for (;;) {
    for (const c of at.ends) {
      // A word is reported once per text, at its first place: what every caller needs, and bounded by the list.
      spend(budget, 1);
      if (seen.has(c)) continue;
      spend(budget, c.units.length);
      let ok = true;
      for (const [k, p] of c.units.entries()) {
        if (p.space) continue;
        if (!same(list[path[k] as number] as Unit, p)) {
          ok = false;
          break;
        }
      }
      // The unit after the match, format characters skipped, must not be a letter or digit when the phrase ends with one.
      const next = list[t.solid[j] as number];
      if (!ok || (c.wordEnd && next !== undefined && next.word)) continue;
      const { id, phrase, level, reason } = c.word;
      spend(budget, MATCH_STEPS);
      seen.add(c);
      out.push({ wordId: id, phrase, level, reason, start: (list[i] as Unit).start, end: (list[path[path.length - 1] as number] as Unit).end });
    }
    if (j > i) j = t.solid[j] as number;
    if (j >= n) return;
    const u = list[j] as Unit;
    spend(budget, 1);
    if (u.space) {
      if (!at.space) return;
      at = at.space;
      path.push(-1);
      j = t.afterSpace[j] as number;
      continue;
    }
    const child = at.next.get(u.base);
    if (!child) return;
    at = child;
    path.push(j);
    j += 1;
  }
}

/**
 * The first place of each word in the text, by position (a longer match first where two start together): a word found
 * once is not looked for again, so the answer holds at most one match per word. Throws BannedWordsTooComplex past the
 * budget.
 */
export function findBannedWords(text: string | BannedText, words: readonly BannedWord[] | BannedMatcher, budget: BannedBudget = bannedBudget()): BannedMatch[] {
  const matcher = isMatcher(words) ? words : compileBannedWords(words);
  if (matcher.size === 0) return [];
  const t = typeof text === 'string' ? prepareBannedText(text, budget) : text;
  const matches: BannedMatch[] = [];
  const path: number[] = [];
  const seen = new Set<Compiled>();
  for (const [i, unit] of t.units.entries()) {
    // Every word found: nothing is left to look for.
    if (seen.size === matcher.size) break;
    if (unit.format || unit.space) continue;
    if (matcher.otherStart.next.size > 0) walk(t, i, matcher.otherStart, budget, path, matches, seen);
    if (!t.wordBefore[i] && matcher.wordStart.next.size > 0) walk(t, i, matcher.wordStart, budget, path, matches, seen);
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

/** The matches in each of the texts, within one budget. */
export function findBannedInTexts(texts: ReadonlyArray<{ field: string; text: string }>, words: readonly BannedWord[] | BannedMatcher, budget: BannedBudget = bannedBudget()): BannedFieldMatch[] {
  const matcher = isMatcher(words) ? words : compileBannedWords(words);
  return texts.flatMap(({ field, text }) => findBannedWords(text, matcher, budget).map((m) => ({ ...m, field })));
}
