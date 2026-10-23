// A long text split into a thread (#1222), as Typefully and Hypefury split a long draft: on X, Threads and Bluesky a
// text over the channel's limit goes out as the post and its thread parts (#742), each counted the way the channel
// counts it (X's weighted count, where a Vietnamese letter with a tone mark is 2, Bluesky's graphemes and bytes,
// Threads' code points). Pure and isomorphic: the composer splits as the person looks, with the rules the commands
// check.
//
// Where it cuts: at a blank line first, then at a sentence end or a line break, then between words; the cut's white
// space goes. A cut of a better kind is taken while it keeps at least a third of what fits, so a short heading line is
// not a post of its own. Only a single word longer than a post is cut inside, at a grapheme boundary, as a last resort.
// No cut ever falls inside a link, a hashtag, an @mention or an emoji (the text-style token rules, which are the AI
// proofread's, domain/text-styles.ts) or inside a run of styled letters (#1179); none of those holds white space, so
// only the last-resort cut has to look. A token or styled run longer than a whole post stays whole, in a post of its
// own, which validation then flags.
//
// Room for what the first post carries: its signature (#1190, which effectiveContent appends to the text only, so the
// thread parts carry none) and the link the adapter appends (#422, with its UTM tags), counted in the text as sent.
// Optionally " 1/n" at the end of each post, its room counted too. At most 1 + THREAD_PARTS_MAX posts: what does not fit
// in them is returned as left over, with its length, never dropped.
import { CAPABILITIES, THREAD_PARTS_MAX, THREAD_RULES, countText, sentText, type Provider, type TextRule } from './channels.ts';
import { withSignature, withoutSignature } from './signature.ts';
import { isFoldable, styleTokens } from './text-styles.ts';
import { sentLink } from './utm.ts';

// The channels whose composer offers the split: X, Threads and Bluesky, and the offline test channel, so the flow can
// be tried end to end. Each takes thread parts (THREAD_RULES).
export const THREAD_SPLIT_PROVIDERS: ReadonlySet<Provider> = new Set<Provider>(['sandbox', 'x', 'threads', 'bluesky']);

export interface ThreadSplitOptions {
  // The variant's settings: its signature and UTM tags.
  settings?: Readonly<Record<string, unknown>> | undefined;
  // The post's link, as written (sentLink adds the tags).
  linkUrl?: string | null | undefined;
  mediaCount?: number | undefined;
  // " 1/n" at the end of each post.
  numbered?: boolean | undefined;
  // The most posts, the variant's text included; 1 + THREAD_PARTS_MAX when unsaid.
  maxPosts?: number | undefined;
}

export interface ThreadSplit {
  // The text split: the one given, without a signature it already ended with (the first post carries it).
  source: string;
  // The posts: the variant's text first, then its thread parts, numbered when asked.
  posts: string[];
  // Each post's text in source, UTF-16 [start, end), before its number. Only white space lies between them.
  ranges: Array<[number, number]>;
  // What each post sends: the first with its signature and link.
  sent: string[];
  // Each post's length in the channel's count, against its limit.
  counts: number[];
  limits: { first: number | null; part: number | null };
  // The text that did not fit in maxPosts posts, trimmed ('' when none), and its length in the parts' count.
  leftover: string;
  leftoverCount: number;
}

const fits = (text: string, rule: TextRule) => (rule.max === null || countText(text, rule.count) <= rule.max) && (rule.maxBytes === undefined || countText(text, 'bytes') <= rule.maxBytes);

// A white space run, and how good a cut it makes: 3 a blank line, 2 a line break or a sentence end, 1 between words.
interface Gap {
  start: number;
  end: number;
  rank: number;
}
const SENTENCE_END = /[.!?…。！？][)"'”’»\]]*$/u;

function gapsOf(text: string): Gap[] {
  const gaps: Gap[] = [];
  for (const m of text.matchAll(/\s+/gu)) {
    const run = m[0];
    const rank = /\n[^\S\n]*\n/u.test(run) ? 3 : run.includes('\n') || SENTENCE_END.test(text.slice(Math.max(0, m.index - 4), m.index)) ? 2 : 1;
    gaps.push({ start: m.index, end: m.index + run.length, rank });
  }
  return gaps;
}

let graphemes: Intl.Segmenter | null = null;

// The places inside [from, to) a word may be cut as a last resort: grapheme boundaries outside every token and not
// between two styled letters.
function wordCuts(text: string, from: number, to: number, tokens: ReadonlyArray<[number, number]>): number[] {
  graphemes ??= new Intl.Segmenter('en', { granularity: 'grapheme' });
  const styled = (segment: string) => isFoldable(segment.codePointAt(0) as number);
  const out: number[] = [];
  let previous: string | null = null;
  for (const { segment, index } of graphemes.segment(text.slice(from, to))) {
    const at = from + index;
    if (previous !== null && !(styled(previous) && styled(segment)) && !tokens.some(([a, b]) => a < at && at < b)) out.push(at);
    previous = segment;
  }
  return out;
}

/**
 * The text split into posts for the provider's thread, or null on a channel that takes no thread parts. A text that
 * fits one post comes back as that one post.
 */
export function splitThread(provider: Provider, text: string, options: ThreadSplitOptions = {}): ThreadSplit | null {
  const partRule = THREAD_RULES[provider];
  if (!partRule) return null;
  const firstRule = CAPABILITIES[provider].body;
  const { settings, linkUrl = null, mediaCount = 0 } = options;
  const maxPosts = Math.max(1, Math.floor(options.maxPosts ?? 1 + THREAD_PARTS_MAX));
  const source = withoutSignature(text, settings);
  const sentFirst = (piece: string) => {
    const body = withSignature(piece, settings);
    return sentText(provider, body, sentLink(provider, linkUrl, settings, body), mediaCount);
  };
  const suffix = (i: number, n: number | null) => (n === null ? '' : ` ${i + 1}/${n}`);
  const gaps = gapsOf(source);
  const tokens = styleTokens(source);
  const end = source.trimEnd().length;

  // The ranges the text is cut into with numbers out of n (none with null), and where the text left over starts.
  const cut = (n: number | null): { ranges: Array<[number, number]>; rest: number } => {
    const ranges: Array<[number, number]> = [];
    let s = source.length - source.trimStart().length;
    let g = 0;
    while (s < end && ranges.length < maxPosts) {
      const i = ranges.length;
      const rule = i === 0 ? firstRule : partRule;
      const ok = (e: number) => fits(i === 0 ? sentFirst(source.slice(s, e) + suffix(i, n)) : (source.slice(s, e) + suffix(i, n)).trim(), rule);
      if (ok(end)) {
        ranges.push([s, end]);
        s = end;
        break;
      }
      while (g < gaps.length && (gaps[g] as Gap).start <= s) g += 1;
      // The cuts between words that fit, read while the words alone still fit (adding words never shortens them; the
      // first post's appended link may go once the post holds it, so a later cut can fit where an earlier one did not).
      const fitting: Gap[] = [];
      for (let k = g; k < gaps.length; k += 1) {
        const gap = gaps[k] as Gap;
        if (!fits(source.slice(s, gap.start), rule)) break;
        if (ok(gap.start)) fitting.push(gap);
      }
      const far = fitting.at(-1);
      if (far) {
        const floor = s + (far.start - s) / 3;
        const best = [3, 2].map((rank) => fitting.findLast((gap) => gap.rank === rank && gap.start >= floor)).find(Boolean) ?? far;
        ranges.push([s, best.start]);
        s = best.end;
        continue;
      }
      // Not even one word fits: the word is cut inside, as far as it fits, or after its smallest whole unit.
      const wordEnd = g < gaps.length ? (gaps[g] as Gap).start : end;
      const cuts = wordCuts(source, s, wordEnd, tokens);
      let at = -1;
      for (const c of cuts) {
        if (!fits(source.slice(s, c), rule)) break;
        if (ok(c)) at = c;
      }
      if (at === -1) at = cuts[0] ?? wordEnd;
      ranges.push([s, at]);
      s = at === wordEnd && g < gaps.length ? (gaps[g] as Gap).end : at;
    }
    return { ranges, rest: s };
  };

  // Numbered: the number's room depends on how many posts there are, so cut again until the count holds still. More
  // posts only ever come from a longer number, and fewer posts get a number no longer than the one counted. One post
  // alone takes no number.
  let result = cut(null);
  let n: number | null = null;
  if (options.numbered && result.ranges.length > 1) {
    n = result.ranges.length;
    for (;;) {
      result = cut(n);
      if (result.ranges.length <= n) break;
      n = result.ranges.length;
    }
    n = result.ranges.length > 1 ? result.ranges.length : null;
  }
  const { ranges, rest } = result;
  const posts = ranges.map(([a, b], i) => source.slice(a, b) + suffix(i, n));
  const sent = posts.map((post, i) => (i === 0 ? sentFirst(post) : post));
  const leftover = source.slice(rest).trim();
  return {
    source,
    posts,
    ranges,
    sent,
    counts: sent.map((s, i) => countText(s, (i === 0 ? firstRule : partRule).count)),
    limits: { first: firstRule.max, part: partRule.max },
    leftover,
    leftoverCount: leftover === '' ? 0 : countText(leftover, partRule.count),
  };
}

const NUMBER = /\s(\d{1,3})\/(\d{1,3})$/u;

/**
 * The posts of a thread as one text again, a blank line between them: the reverse of a split. " 1/n" numbers are taken
 * off when every post ends with its own.
 */
export function joinThread(posts: readonly string[]): string {
  const texts = posts.map((p) => p.trim()).filter((p) => p !== '');
  const numbered = texts.length > 1 && texts.every((p, i) => {
    const m = NUMBER.exec(p);
    return m !== null && Number(m[1]) === i + 1 && Number(m[2]) === texts.length;
  });
  return (numbered ? texts.map((p) => p.replace(NUMBER, '').trimEnd()) : texts).join('\n\n');
}
