// The deterministic check after an AI proofread (#1167): a proofread fixes spelling, diacritics, spacing and
// punctuation only, so every link, hashtag, @mention, number or price and emoji of the text must come back exactly as
// it was, in the same order. The model is never trusted to have kept them: a proposal that changed any is refused
// before the member sees it. Pure functions, no model.

export const PROTECTED_KINDS = ['link', 'hashtag', 'mention', 'number', 'emoji'] as const;
// wording: the text grew or shrank more than fixing spelling, marks and spacing can (a sentence added or dropped).
export type ProtectedKind = (typeof PROTECTED_KINDS)[number] | 'wording';
export type ProtectedTokens = Record<(typeof PROTECTED_KINDS)[number], string[]>;

// A proofread changed what it must keep; kinds says which, in PROTECTED_KINDS order.
export class ProofreadChangedError extends Error {
  readonly kinds: readonly ProtectedKind[];
  constructor(kinds: readonly ProtectedKind[]) {
    super(`proofread changed ${kinds.join(', ')}`);
    this.name = 'ProofreadChangedError';
    this.kinds = kinds;
  }
}

// Top-level domains a bare address ("tiemcuaban.vn/khuyen-mai") is read as a link with. A short list on purpose: a
// missing space after a full stop ("xong.Mai") is a typo the proofread should fix, not a link.
const TLDS = 'com|net|org|vn|io|co|me|app|shop|store|info|biz|asia|online|site|xyz|dev|ai|edu|gov|link|page|cc|tv';
const LINK = new RegExp(
  [
    // A link with its scheme, or starting with www.
    String.raw`(?:https?:\/\/|www\.)[^\s<>"'“”‘’]+`,
    // An email address, so its @ is not read as a mention.
    String.raw`[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+`,
    // A bare address on a known top-level domain, with its path.
    String.raw`(?<![\p{L}\p{N}_.@-])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:${TLDS})(?:\.vn)?(?![\p{L}\p{N}_-])(?:\/[^\s<>"'“”‘’]*)?`,
  ].join('|'),
  'giu',
);
// Punctuation that ends the sentence around a link rather than the link itself.
const LINK_TAIL = /[.,;:!?…)\]}>»"'“”‘’]+$/u;
const HASHTAG = /(?<![\p{L}\p{M}\p{N}_&#])#[\p{L}\p{M}\p{N}_]+/gu;
const MENTION = /(?<![\p{L}\p{M}\p{N}_.@])@[\p{L}\p{M}\p{N}_.]+/gu;
// Units a number or price carries, longest first: Vietnamese prices (1.200.000đ, 99k, 2tr, 150 nghìn), percentages
// and a few currencies. A space between the number and its unit may come or go: that is a spacing fix.
const UNITS = ['vnđ', 'vnd', 'usd', 'đồng', 'dong', 'triệu', 'trieu', 'nghìn', 'nghin', 'ngàn', 'ngan', 'tr', 'đ', '₫', 'k', '%', '$'];
const NUMBER = new RegExp(String.raw`(\d+(?:[.,:\/-]\d+)*)(?:[^\S\r\n]?(${UNITS.map((u) => u.replace(/[$]/g, '\\$')).join('|')})(?![\p{L}\p{M}\p{N}]))?`, 'giu');
// A grapheme that is an emoji: a pictograph (with its skin tone, variation selector or joined parts), a flag, a keycap.
const EMOJI = /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20E3/u;
const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });

// A unit as compared: the same unit with or without its diacritics or capitals ("99K", "100 dong" and "100 đồng"),
// since restoring those is what a proofread does.
function unitKey(unit: string): string {
  return unit
    .toLowerCase()
    .replace(/₫/g, 'đ')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/đ/g, 'd');
}

// Takes every match of pattern out of text (each replaced by a space, so what is left cannot join across it).
function takeOut(text: string, pattern: RegExp, keep: (match: RegExpExecArray) => string): { found: string[]; rest: string } {
  const found: string[] = [];
  const rest = text.replace(pattern, (...args) => {
    const match = args as unknown as RegExpExecArray;
    found.push(keep(match));
    return ' ';
  });
  return { found, rest };
}

// What a proofread must keep, in the order the text holds it. Links are taken out first, so a hashtag, mention or
// number inside one counts as part of the link only.
export function protectedTokens(text: string): ProtectedTokens {
  const links = takeOut(text.normalize('NFC'), LINK, (m) => m[0].replace(LINK_TAIL, ''));
  const hashtags = takeOut(links.rest, HASHTAG, (m) => m[0]);
  const mentions = takeOut(hashtags.rest, MENTION, (m) => m[0].replace(/\.+$/, ''));
  const emoji: string[] = [];
  let rest = '';
  for (const { segment } of graphemes.segment(mentions.rest)) {
    if (EMOJI.test(segment)) {
      emoji.push(segment);
      rest += ' ';
    } else rest += segment;
  }
  const numbers = takeOut(rest, NUMBER, (m) => (m[2] ? `${m[1]} ${unitKey(m[2])}` : (m[1] as string)));
  return { link: links.found, hashtag: hashtags.found, mention: mentions.found, number: numbers.found, emoji };
}

// How far a proofread may change a text's length: a few characters of spacing and punctuation, or a tenth of a long text.
const WORDING_SLACK = 12;
const WORDING_RATIO = 0.1;

const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((v, i) => v === b[i]);

// The kinds a proofread changed between these texts (a title and a body are compared each on its own); empty when it
// kept them all.
export function proofreadChanges(before: readonly string[], after: readonly string[]): ProtectedKind[] {
  const changed = new Set<ProtectedKind>();
  for (let i = 0; i < Math.max(before.length, after.length); i++) {
    const a = protectedTokens(before[i] ?? '');
    const b = protectedTokens(after[i] ?? '');
    for (const kind of PROTECTED_KINDS) if (!same(a[kind], b[kind])) changed.add(kind);
    const was = [...(before[i] ?? '').normalize('NFC')].length;
    const now = [...(after[i] ?? '').normalize('NFC')].length;
    if (Math.abs(now - was) > Math.max(WORDING_SLACK, Math.ceil(was * WORDING_RATIO))) changed.add('wording');
  }
  return [...PROTECTED_KINDS, 'wording' as const].filter((k) => changed.has(k));
}
