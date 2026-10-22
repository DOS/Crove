// Listing an account's own recent posts (#1054): the bounds every adapter keeps and the checks on what a platform
// answers, so a post published outside Crove comes in with a real date, an id of a known shape and a link that can be
// shown to a client.

// How far back an account's posts are listed, at most.
export const RECENT_POSTS_MAX_DAYS = 30;
// At most this many posts per answer, newest first (an account posting more than this in 30 days is cut).
export const RECENT_POSTS_MAX = 500;
// Pages of a listing read at most (100 posts a page).
export const RECENT_PAGES_MAX = 10;

// The start of the listing: the caller's since, never earlier than RECENT_POSTS_MAX_DAYS before now.
export function recentSince(since: Date, now: Date = new Date()): Date {
  const floor = now.getTime() - RECENT_POSTS_MAX_DAYS * 86_400_000;
  const at = since.getTime();
  return new Date(Number.isFinite(at) && at > floor ? Math.min(at, now.getTime()) : floor);
}

// A time as Graph gives it (2026-10-20T08:00:00+0000, or with a colon in the offset); null when it is not one.
export function graphTime(value: unknown): Date | null {
  if (typeof value !== 'string' || value.length > 40) return null;
  const at = Date.parse(value.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  return Number.isFinite(at) ? new Date(at) : null;
}

// The post's page when it is an https address on one of the platform's hosts (or a subdomain of one), with no
// credentials in it; anything else is null, so a client report never links elsewhere.
export function platformLink(value: unknown, hosts: readonly string[]): string | null {
  if (typeof value !== 'string' || value.length > 2000) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase();
  return hosts.some((h) => host === h || host.endsWith(`.${h}`)) ? url.toString() : null;
}

// A paging cursor as Graph gives it: opaque, bounded, sent back as a query parameter.
export function pagingCursor(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9_=%.-]{1,1024}$/.test(value) ? value : null;
}
