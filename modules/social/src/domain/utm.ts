// UTM tags on a post's link (#585): each channel sends the link with its own utm_source, so the business sees in its
// analytics which channel brought a visit. The tags live in the variant's settings (settings.utm), so they are part of
// its content hash and its approval. Links written inside the text are left as they are.
import type { Provider } from './channels.ts';

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
};

const TAG = /^[\p{L}\p{N}_.\-+ ]{1,100}$/u;
const clean = (value: unknown): string | null => (typeof value === 'string' && TAG.test(value.trim()) ? value.trim() : null);

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
export function tagLink(link: string | null, provider: Provider, utm: Utm | null): string | null {
  if (!link || !utm) return link;
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return link;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return link;
  const set = (name: string, value: string | undefined) => {
    if (value && !url.searchParams.has(name)) url.searchParams.set(name, value);
  };
  set('utm_source', UTM_SOURCE[provider]);
  set('utm_medium', utm.medium ?? 'social');
  set('utm_campaign', utm.campaign);
  set('utm_content', utm.content);
  return url.toString();
}

// The link a variant sends, from its settings.
export const sentLink = (provider: Provider, link: string | null, settings: Readonly<Record<string, unknown>> | undefined) => tagLink(link, provider, utmOf(settings));