// The excerpt the composer and the review panel show around a banned or sensitive word (#1055): a few words before and
// after the match, cut at white space and never inside a surrogate pair, with an ellipsis where the text goes on.
export interface BannedHit {
  wordId: string;
  phrase: string;
  level: 'warn' | 'block';
  reason: string | null;
  field: string;
  start: number;
  before: string;
  match: string;
  after: string;
}

export const SNIPPET_CONTEXT = 24;

// A cut point at or after `at` (going right) or at or before it (going left) that is not inside a surrogate pair.
function safe(text: string, at: number, left: boolean): number {
  let i = Math.max(0, Math.min(text.length, at));
  const low = (k: number) => {
    const c = text.charCodeAt(k);
    return c >= 0xdc00 && c <= 0xdfff;
  };
  while (i > 0 && i < text.length && low(i)) i += left ? -1 : 1;
  return i;
}

export function bannedSnippet(
  text: string,
  m: { wordId: string; phrase: string; level: 'warn' | 'block'; reason: string | null; field: string; start: number; end: number },
): BannedHit {
  // A view of content that changed since the server read it may name a range past the text: show the phrase alone.
  const inRange = m.start >= 0 && m.end <= text.length && m.start < m.end;
  if (!inRange) return { wordId: m.wordId, phrase: m.phrase, level: m.level, reason: m.reason, field: m.field, start: m.start, before: '', match: m.phrase, after: '' };
  let from = safe(text, m.start - SNIPPET_CONTEXT, true);
  let to = safe(text, m.end + SNIPPET_CONTEXT, false);
  // Whole words at the edges where the text has a space near them.
  const space = text.slice(from, m.start).search(/\s/u);
  if (from > 0 && space >= 0) from += space + 1;
  const tail = text.slice(m.end, to);
  const lastSpace = Math.max(tail.lastIndexOf(' '), tail.lastIndexOf('\n'));
  if (to < text.length && lastSpace >= 0) to = m.end + lastSpace;
  const flat = (s: string) => s.replace(/\s+/gu, ' ');
  return {
    wordId: m.wordId,
    phrase: m.phrase,
    level: m.level,
    reason: m.reason,
    field: m.field,
    start: m.start,
    before: `${from > 0 ? '…' : ''}${flat(text.slice(from, m.start))}`,
    match: flat(text.slice(m.start, m.end)),
    after: `${flat(text.slice(m.end, to))}${to < text.length ? '…' : ''}`,
  };
}
