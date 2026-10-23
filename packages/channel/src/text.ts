// Text helpers the adapters share.

// Whether a text already holds a link as a whole: followed by the end, a space, or sentence punctuation and then the
// end or a space, so "https://a.vn/x" is not taken as held by a text with "https://a.vn/xyz". The Social checks build
// the sent text the same way (`sentText` in @crove/mod-social).
export function holdsLink(text: string, link: string): boolean {
  for (let i = text.indexOf(link); i !== -1; i = text.indexOf(link, i + 1)) {
    if (/^[.,!?;:)\]]*(?:\s|$)/.test(text.slice(i + link.length))) return true;
  }
  return false;
}

// The platform refused a text identical to a recent post of the account (X's 403, LinkedIn's 422; #1156): nothing was
// posted, and the same text fails again until it changes.
export const DUPLICATE_CONTENT = 'DUPLICATE_CONTENT';
// The platform called the post a duplicate, but the post it matched may be Crove's own earlier attempt (Facebook's 506;
// #1156): the outcome stays unclear, and this code lets the needs-attention view say it may be a duplicate.
export const POSSIBLE_DUPLICATE = 'POSSIBLE_DUPLICATE';
