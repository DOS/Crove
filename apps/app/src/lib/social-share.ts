// Sharing a page or a selection into a new Social draft (#1235). The installed app's share target (the web app
// manifest's GET share_target, /-/share?title=&text=&url=) and the bookmarklet (/-/share#org=&link=&text=) both reach
// the share page, which picks the org and opens its composer with the page's link and text in the URL fragment,
// #link=<url>&text=<text>. A fragment never reaches a server: the browser leaves it out of every request, so the
// shared page stays out of access logs (and the kernel's Referrer-Policy: no-referrer keeps the address out of the
// app's own requests). The share target's first GET does carry its query: the kernel answers it with the SPA and
// logs no request paths, and the boot step below moves it into the fragment before the app starts, so no later
// request and no history entry keeps it.

export const SHARE_PATH = '/-/share';
// The text kept from a share: a title and a selection, never a whole page.
export const SHARE_TEXT_MAX = 4000;
// As the post's link field takes it (zSocialLink).
export const SHARE_LINK_MAX = 2000;

export interface Shared {
  link: string | null;
  text: string;
}

// http(s), with no user name or password in it, as the composer's AI source field takes it.
const WEB_LINK = /^https?:\/\/[^\s@/?#]+(?:[/?#]\S*)?$/;
const LINK_IN_TEXT = /https?:\/\/[^\s<>"']+/;

export function isWebLink(value: string): boolean {
  return value.length <= SHARE_LINK_MAX && WEB_LINK.test(value);
}

// At most max UTF-16 units, never ending inside a surrogate pair.
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const end = text.charCodeAt(max - 1);
  return text.slice(0, end >= 0xd800 && end <= 0xdbff ? max - 1 : max);
}

function normalize(link: string | null, text: string): Shared | null {
  const kept = cut(text.replace(/\r\n?/g, '\n').trim(), SHARE_TEXT_MAX).trim();
  if (!link && !kept) return null;
  return { link, text: kept };
}

// What a share target receives (title, text, url), as a draft's link and text. Android apps often send the link in the
// text and leave url empty: the link is url when it is a web link, else the first web link in the text, which is then
// taken out of it. The text is the title and what is left of the text, a blank line between them.
export function fromShareParams(params: { title?: string | null; text?: string | null; url?: string | null }): Shared | null {
  const title = (params.title ?? '').trim();
  let text = (params.text ?? '').trim();
  const url = (params.url ?? '').trim();
  let link = isWebLink(url) ? url : null;
  if (!link) {
    // A sentence's last mark after the link is not part of it; it goes with the link.
    const raw = LINK_IN_TEXT.exec(text)?.[0];
    const found = raw?.replace(/[.,;:!?)\]]+$/, '');
    if (raw && found && isWebLink(found)) {
      link = found;
      text = text.replace(raw, '').trim();
    }
  }
  // A title the text starts with (or a text the title starts with) is said once.
  const parts = title && text && (text.startsWith(title) || title.startsWith(text)) ? [title.length >= text.length ? title : text] : [title, text];
  return normalize(link, parts.filter((p) => p !== '').join('\n\n'));
}

// The fragment (without its #) that carries a share into the composer.
export function shareFragment(shared: Shared): string {
  const params = new URLSearchParams();
  if (shared.link) params.set('link', shared.link);
  if (shared.text) params.set('text', shared.text);
  return params.toString();
}

// A share in a fragment (with or without its #); null when it carries none. A link that is not a web link is dropped.
export function readShareFragment(hash: string): Shared | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  if (!params.has('link') && !params.has('text')) return null;
  const link = (params.get('link') ?? '').trim();
  return normalize(isWebLink(link) ? link : null, params.get('text') ?? '');
}

// The org a bookmarklet names in its fragment (#org=<slug>), when it reads as a slug; null otherwise.
const SLUG = /^[A-Za-z0-9_-]{1,100}$/;
export function readShareOrg(hash: string): string | null {
  const org = new URLSearchParams(hash.replace(/^#/, '')).get('org');
  return org !== null && SLUG.test(org) ? org : null;
}

interface BootWindow {
  location: { pathname: string; search: string };
  history: { state: unknown; replaceState: (state: unknown, unused: string, url: string) => void };
}

// The first thing the app does on load: on the share target's route, its query becomes the fragment, in place in
// history (the query stays in no history entry, and the app's later requests run from a URL without it).
export function moveShareQueryToFragment(win: BootWindow): void {
  if (win.location.pathname !== SHARE_PATH || win.location.search === '') return;
  const query = new URLSearchParams(win.location.search);
  const shared = fromShareParams({ title: query.get('title'), text: query.get('text'), url: query.get('url') });
  win.history.replaceState(win.history.state, '', shared ? `${SHARE_PATH}#${shareFragment(shared)}` : SHARE_PATH);
}

// A share on its way to the composer: kept in this tab only (sessionStorage) while the person signs in, for an hour at
// most, and taken once by the share page.
export interface PendingShare extends Shared {
  org: string | null;
}
const PENDING_KEY = 'crove-pending-share';
export const PENDING_SHARE_TTL_MS = 60 * 60 * 1000;

export function rememberShare(shared: PendingShare, now: number = Date.now()): void {
  try {
    sessionStorage.setItem(PENDING_KEY, JSON.stringify({ link: shared.link, text: shared.text, org: shared.org, savedAt: now }));
  } catch {
    // Storage blocked: the share is lost, and sharing again works once signed in.
  }
}

// The waiting share while it is fresh, without taking it. Anything else stored is removed.
export function pendingShare(now: number = Date.now()): PendingShare | null {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY);
    if (raw === null) return null;
    const value = JSON.parse(raw) as { link?: unknown; text?: unknown; org?: unknown; savedAt?: unknown } | null;
    const savedAt = typeof value?.savedAt === 'number' ? value.savedAt : Number.NaN;
    const link = typeof value?.link === 'string' && isWebLink(value.link) ? value.link : null;
    const fresh = Number.isFinite(savedAt) && savedAt <= now && now - savedAt < PENDING_SHARE_TTL_MS;
    const shared = fresh ? normalize(link, typeof value?.text === 'string' ? value.text : '') : null;
    if (!shared) {
      sessionStorage.removeItem(PENDING_KEY);
      return null;
    }
    return { ...shared, org: typeof value?.org === 'string' && SLUG.test(value.org) ? value.org : null };
  } catch {
    return null;
  }
}

export function forgetShare(): void {
  try {
    sessionStorage.removeItem(PENDING_KEY);
  } catch {
    // Nothing stored.
  }
}

// The bookmarklet of one org: run on any page, it opens the share page in a new tab with the org, the page's address,
// its title and the selected text in the fragment. It holds no token or session: the new tab signs in as the app
// always does. The tab is opened without an opener, so the page cannot reach or redirect it.
export function bookmarklet(origin: string, slug: string): string {
  const target = `${new URL(origin).origin}${SHARE_PATH}#org=${encodeURIComponent(slug)}&`;
  // c cuts a text without leaving half of a surrogate pair at its end (encodeURIComponent throws on one).
  const code = [
    '(function(){',
    "function c(v,n){return String(v||'').trim().slice(0,n).replace(/[\\ud800-\\udbff]$/,'');}",
    `var s=c(window.getSelection&&window.getSelection(),${SHARE_TEXT_MAX});`,
    'var t=c(document.title,300);',
    "var x=t&&s?t+'\\n\\n'+s:t||s;",
    `window.open(${JSON.stringify(target)}+'link='+encodeURIComponent(location.href)+'&text='+encodeURIComponent(x),'_blank','noopener');`,
    '})()',
  ].join('');
  // A javascript: address is percent-decoded before it runs, and a # would start its fragment: both are escaped.
  return `javascript:${code.replaceAll('%', '%25').replaceAll('#', '%23')}`;
}
