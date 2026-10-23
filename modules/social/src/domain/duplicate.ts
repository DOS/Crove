// The same text going out again on a channel (#1156). X and LinkedIn refuse a post whose text matches a recent one of
// the account, and recurring copies (#979) and evergreen reposts (#393) send exactly the text that went out before, so
// social.post.get tells each open channel when the same text was published there in the last 30 days or is scheduled
// or queued there, and the composer, the review panel and the post page warn before it fails. Elsewhere the same text
// goes out and followers see it twice: the warning is advice there. Pure and isomorphic: the app compares as the
// member types with the same rules the server applies.

import { foldMathAlphanumerics } from './text-styles.ts';

// What social.publish.record keeps as the error code when X or LinkedIn refused a text identical to a recent post: the
// adapters' DUPLICATE_CONTENT in @crove/channel, which the browser cannot import.
export const DUPLICATE_CONTENT = 'DUPLICATE_CONTENT';
// Facebook's 506 ("duplicate status message"): unclear, since the post it matched may be Crove's own earlier attempt.
export const POSSIBLE_DUPLICATE = 'POSSIBLE_DUPLICATE';

// How far back a published post counts, and how many posts of a channel one read compares at most.
export const DUPLICATE_WINDOW_DAYS = 30;
export const DUPLICATE_SCAN_MAX = 500;

// The platforms that refuse the same text outright; elsewhere it is advice.
const REFUSING: ReadonlySet<string> = new Set(['x', 'linkedin', 'linkedin_page']);
export const refusesDuplicates = (provider: string): boolean => REFUSING.has(provider);

export type DuplicateStatus = 'published' | 'scheduled' | 'queued';
// The newest post of the same channel with the same text: when it went out or goes out, and how it stands.
export interface DuplicateOf {
  at: string | null;
  status: DuplicateStatus;
}

// Links X finds without a scheme, on the common TLDs (comparableText in @crove/channel uses the same list).
const BARE_LINK = /(?<![@\w.-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|net|org|vn|io|co|ai|app|dev|me|info|biz|xyz|shop|store|online|site|tech|asia|edu|gov|us|uk|jp|sg|tv|ly|gg|link)\b(?:\/\S*)?/giu;
const ENTITIES: Readonly<Record<string, string>> = { lt: '<', gt: '>', amp: '&' };

// A text as the duplicate check compares it, the way X's adapter compares a post with what it sent (comparableText):
// links dropped (X rewrites them to t.co links), the three entities X writes decoded in one pass, NFC, white space
// collapsed. Case and punctuation count, so changing one word clears the match. Styled letters (#1179) are compared as
// their plain ones, first, so the same words in bold, italic or plain are the same text, and a styled link is dropped
// like a plain one. Only compared, never shown.
export function duplicateText(text: string): string {
  return foldMathAlphanumerics(text)
    .replace(/&(lt|gt|amp);/g, (_, name: string) => ENTITIES[name] ?? '')
    .replace(/\bhttps?:\/\/\S+/g, ' ')
    .replace(BARE_LINK, ' ')
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface DuplicateCandidate {
  text: string;
  at: Date | null;
  status: DuplicateStatus;
}

// The newest candidate whose text matches, or null. A text with nothing left to compare (only links, or empty) matches
// nothing: a post of images alone is not a duplicate of another.
export function newestDuplicate(text: string, candidates: readonly DuplicateCandidate[]): DuplicateOf | null {
  const wanted = duplicateText(text);
  if (wanted === '') return null;
  let best: DuplicateCandidate | null = null;
  for (const c of candidates) {
    if (duplicateText(c.text) !== wanted) continue;
    if (best === null || (c.at !== null && (best.at === null || c.at.getTime() > best.at.getTime()))) best = c;
  }
  return best ? { at: best.at ? best.at.toISOString() : null, status: best.status } : null;
}
