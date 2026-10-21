// UTM tags on a post's link (#585): each channel sends the link with its own utm_source, so the business sees in its
// analytics which channel brought a visit. The tags live in the variant's settings (settings.utm), so they are part of
// its content hash and its approval. Links written inside the text are left as they are.
import { holdsLink, type Provider } from './channels.ts';

export interface Utm {
  campaign: string;
  // Defaults to 'social'.
  medium?: string;
  content?: string;
}

// The utm_source each channel sends.
export const UTM_SOURCE: Readonly<Record<Provider, string>> = {
  sandbox: 'crove',
  facebook_page: 'facebook',
  instagram: 'instagram',
  zalo_oa: 'zalo',
  threads: 'threads',
  linkedin: 'linkedin',
  youtube: 'youtube',
  tiktok: 'tiktok',
  x: 'x',
  bluesky: 'bluesky',
  google_business: 'google',
  telegram: 'telegram',
  mastodon: 'mastodon',
  pinterest: 'pinterest',
  wordpress: 'wordpress',
};

// Letters with their marks, digits, spaces and common punctuation; the value is percent-encoded in the link anyway.
const TAG = /^[\p{L}\p{M}\p{N}\p{Zs}_.,:;!?'()/+&%@#-]{1,100}$/u;
const clean = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const s = value.normalize('NFC').trim();
  return TAG.test(s) ? s : null;
};

// The tags in a variant's settings, or null when there are none (a campaign is what turns them on).
export function utmOf(settings: Readonly<Record<string, unknown>> | undefined): Utm | null {
  const raw = settings?.utm;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const campaign = clean(r.campaign);
  if (!campaign) return null;
  const medium = clean(r.medium);
  const content = clean(r.content);
  return { campaign, ...(medium ? { medium } : {}), ...(content ? { content } : {}) };
}

// The link as the channel sends it: tagged when the variant has tags and the link is http(s). Parameters the link
// already has are kept, utm_* ones included, so a link tagged by hand is never overwritten.
// The rest of the link is kept exactly as written (host, path, its own parameters, a #fragment): the tags are added at
// the end of the query, before any fragment.
export function tagLink(link: string | null, provider: Provider, utm: Utm | null): string | null {
  if (!link || !utm) return link;
  const trimmed = link.trim();
  if (!/^https?:\/\/[^\s]+$/i.test(trimmed)) return link;
  const hash = trimmed.indexOf('#');
  const [head, fragment] = hash === -1 ? [trimmed, ''] : [trimmed.slice(0, hash), trimmed.slice(hash)];
  const query = head.includes('?') ? head.slice(head.indexOf('?') + 1) : '';
  const has = (name: string) => query.split('&').some((part) => part.split('=')[0]?.toLowerCase() === name);
  const tags = (
    [
      ['utm_source', UTM_SOURCE[provider]],
      ['utm_medium', utm.medium ?? 'social'],
      ['utm_campaign', utm.campaign],
      ['utm_content', utm.content],
    ] as const
  )
    .filter(([name, value]) => value && !has(name))
    .map(([name, value]) => `${name}=${encodeURIComponent(value as string)}`);
  if (tags.length === 0) return link;
  const joiner = !head.includes('?') ? '?' : head.endsWith('?') || head.endsWith('&') ? '' : '&';
  return `${head}${joiner}${tags.join('&')}${fragment}`;
}

// The link a variant sends, from its settings. A text that already holds the plain link sends it as written (the
// adapters append the link only when the text does not hold it, so a tagged copy would show it twice).
export function sentLink(provider: Provider, link: string | null, settings: Readonly<Record<string, unknown>> | undefined, body?: string): string | null {
  if (link && body && holdsLink(body.trim(), link.trim())) return link;
  return tagLink(link, provider, utmOf(settings));
}