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
