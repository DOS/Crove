// Stock photos from Pexels in the media library (#1106): the hosts a photo's links and image may be on, and the
// cleaning of the text Pexels gives with it. Everything in a Pexels answer comes from outside the org: a link is kept
// only on Pexels' own hosts, and a name or a description only as plain text.

// The photo pages and photographer pages: pexels.com and its subdomains (www.pexels.com).
const PAGE_HOST = /^(?:[a-z0-9-]+\.)*pexels\.com$/;
// The image files: only Pexels' image host.
export const PEXELS_IMAGE_HOST = 'images.pexels.com';
export const STOCK_URL_MAX = 2048;
export const STOCK_ALT_MAX = 1000;
export const STOCK_NAME_MAX = 200;

function httpsUrl(raw: unknown): URL | null {
  if (typeof raw !== 'string' || raw.length > STOCK_URL_MAX) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  return url;
}

// A photo's or a photographer's page on Pexels, as an https URL on pexels.com; null for anything else.
export function pexelsPageUrl(raw: unknown): string | null {
  const url = httpsUrl(raw);
  return url && PAGE_HOST.test(url.hostname) ? url.toString() : null;
}

// An image file on Pexels' image host, as an https URL; null for anything else.
export function pexelsImageUrl(raw: unknown): string | null {
  const url = httpsUrl(raw);
  return url && url.hostname === PEXELS_IMAGE_HOST ? url.toString() : null;
}

// Text from Pexels as one line of plain text: control and format characters dropped, white space collapsed, cut to
// max characters; null when nothing is left.
export function stockText(raw: unknown, max: number): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw
    .normalize('NFC')
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text === '') return null;
  const chars = [...text];
  return chars.length > max ? chars.slice(0, max).join('').trimEnd() : text;
}
