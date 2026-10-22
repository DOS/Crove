// Shared pieces of the Social screens: status tones, provider names, the effective text of a variant as the composer
// shows it, and grouping by day for the agenda.
import { CAPABILITIES, SENT_TO_APP, WORDPRESS_DRAFT, WORDPRESS_PENDING, countText, isProvider, needsPublicUrls, sentText, validateVariant, type Issue, type Provider } from '@crove/mod-social/contract';
import { getConfig } from './auth.ts';

export type VariantStatus =
  | 'draft'
  | 'in_review'
  | 'changes_requested'
  | 'rejected'
  | 'approved'
  | 'scheduled'
  | 'publishing'
  | 'processing'
  | 'published'
  | 'failed'
  | 'ambiguous'
  | 'needs_attention'
  | 'paused'
  | 'cancelled'
  | 'removed';

type Tone = 'secondary' | 'brand' | 'success' | 'warning' | 'destructive' | 'outline';

export const VARIANT_TONE: Record<VariantStatus, Tone> = {
  draft: 'secondary',
  in_review: 'warning',
  changes_requested: 'warning',
  rejected: 'destructive',
  approved: 'brand',
  scheduled: 'brand',
  publishing: 'brand',
  processing: 'brand',
  published: 'success',
  failed: 'destructive',
  ambiguous: 'warning',
  needs_attention: 'destructive',
  paused: 'warning',
  cancelled: 'outline',
  removed: 'outline',
};

// A published variant that is not public yet, by its note: a draft sent to the platform's app (#903, TikTok's inbox),
// or a post the WordPress site keeps as a draft or pending review (#981).
export type NotPublicKey = 'sent_to_app' | 'wordpress_draft' | 'wordpress_pending';
const NOT_PUBLIC: Readonly<Record<string, NotPublicKey>> = { [SENT_TO_APP]: 'sent_to_app', [WORDPRESS_DRAFT]: 'wordpress_draft', [WORDPRESS_PENDING]: 'wordpress_pending' };

export function notPublicKey(v: { status: VariantStatus; error?: { code: string | null } | null }): NotPublicKey | null {
  const code = v.error?.code;
  return v.status === 'published' && code ? (NOT_PUBLIC[code] ?? null) : null;
}

// The key of a variant's status label (social.status.*): a published variant that is not out yet says so instead of
// "Published".
export function variantStatusKey(v: { status: VariantStatus; error?: { code: string | null } | null }): VariantStatus | NotPublicKey {
  return notPublicKey(v) ?? v.status;
}

// Its tone: a draft waiting in the platform's app or on the site still needs a person, so it is not shown as done.
export function variantTone(v: { status: VariantStatus; error?: { code: string | null } | null }): Tone {
  return notPublicKey(v) ? 'warning' : VARIANT_TONE[v.status];
}

// Short names of the providers, the same in every language.
export const PROVIDER_NAMES: Record<Provider, string> = {
  sandbox: 'Sandbox',
  facebook_page: 'Facebook',
  instagram: 'Instagram',
  zalo_oa: 'Zalo OA',
  tiktok: 'TikTok',
  youtube: 'YouTube',
  threads: 'Threads',
  linkedin: 'LinkedIn',
  x: 'X',
  bluesky: 'Bluesky',
  google_business: 'Google Business',
  telegram: 'Telegram',
  mastodon: 'Mastodon',
  pinterest: 'Pinterest',
  discord: 'Discord',
  wordpress: 'WordPress',
  linkedin_page: 'LinkedIn Page',
};

export function providerName(provider: string): string {
  return isProvider(provider) ? PROVIDER_NAMES[provider] : provider;
}

// The platforms the channels screen lists to connect, in the order Crove adds them (Social plan §6). A platform the
// deployment has not set up shows as not configured, except LinkedIn Company Pages, which wait on LinkedIn approving
// the app for the Community Management API (#1077) and are listed only where the deployment offers them.
const CONNECT_PLATFORMS = ['facebook_page', 'instagram', 'zalo_oa', 'threads', 'linkedin', 'linkedin_page', 'youtube', 'tiktok', 'x', 'google_business', 'pinterest'] as const;
const LISTED_WHEN_OFFERED: readonly string[] = ['linkedin_page'];
export function connectPlatforms(offered: readonly string[]): (typeof CONNECT_PLATFORMS)[number][] {
  return CONNECT_PLATFORMS.filter((p) => !LISTED_WHEN_OFFERED.includes(p) || offered.includes(p));
}

// A variant's text against its channel's limit, the way the platform counts, with the link the channel's adapter adds.
export function textBudget(provider: string, body: string, link: { linkUrl?: string | null; mediaCount?: number } = {}): { used: number; max: number | null } {
  if (!isProvider(provider)) return { used: body.length, max: null };
  const rule = CAPABILITIES[provider].body;
  return { used: countText(sentText(provider, body, link.linkUrl, link.mediaCount ?? 0), rule.count), max: rule.max };
}

export function hasTitle(provider: string): boolean {
  return isProvider(provider) && CAPABILITIES[provider].title !== null;
}

// The issues a draft would have at submit, checked as it is typed (the server checks again).
// Whether this deployment keeps files where no public link reaches them (local disk); unknown before the config loads.
function uploadsDirect(): boolean {
  try {
    return getConfig().uploads === 'direct';
  } catch {
    return false;
  }
}

export function draftIssues(provider: string, content: { body: string; title: string | null; linkUrl?: string | null; media?: readonly { mime: string; sizeBytes: number; durationMs?: number | null | undefined; width?: number | null | undefined; height?: number | null | undefined }[]; settings?: Record<string, unknown> }): Issue[] {
  if (!isProvider(provider)) return [];
  const media = (content.media ?? []).map((m) => ({ kind: m.mime.startsWith('video/') ? ('video' as const) : ('image' as const), mime: m.mime, sizeBytes: m.sizeBytes, // Absent: an upload the server has not read yet (the post is not saved); it reads and checks the length on save.
    durationSeconds: m.durationMs === undefined ? 0 : m.durationMs === null ? null : m.durationMs / 1000, width: m.width ?? null, height: m.height ?? null }));
  const issues = validateVariant({ provider, body: content.body, title: content.title, linkUrl: content.linkUrl ?? null, media, ...(content.settings ? { settings: content.settings } : {}) });
  // Files that channel fetches by URL, on a deployment that hands out none (#772): said before the post is submitted.
  if (uploadsDirect() && needsPublicUrls(provider, media, content.settings)) issues.push({ code: 'MEDIA_NEEDS_PUBLIC_STORAGE', field: 'media', limit: null, actual: null });
  return issues;
}

// Local calendar day (yyyy-mm-dd) of an instant, in the viewer's time zone.
export function dayKey(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// A value for <input type="datetime-local"> from an instant, in the viewer's time zone, and back.
export function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromLocalInput(value: string): string | null {
  if (!value) return null;
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

// Minutes of the day as HH:MM, and back.
export function minuteLabel(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
}

export function parseMinute(value: string): number | null {
  // <input type="time"> may add seconds.
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(value);
  if (!m) return null;
  const minute = Number(m[1]) * 60 + Number(m[2]);
  return minute >= 0 && minute < 1440 ? minute : null;
}

export const REVIEWABLE: readonly VariantStatus[] = ['in_review'];
export const SUBMITTABLE: readonly VariantStatus[] = ['draft', 'changes_requested', 'rejected'];
export const EDITABLE: readonly VariantStatus[] = ['draft', 'in_review', 'changes_requested', 'rejected', 'approved', 'scheduled', 'paused', 'failed'];
export const CANCELLABLE: readonly VariantStatus[] = EDITABLE;

// A message for the next post page this tab opens (a submit that failed right after the draft was created).
let flash: string | null = null;

export function setFlash(message: string): void {
  flash = message;
}

export function takeFlash(): string | null {
  const message = flash;
  flash = null;
  return message;
}

// The Social home's tab and filters, kept in the address (#574) so a reload or a shared link shows the same list.
export const SOCIAL_TABS = ['upcoming', 'calendar', 'board', 'review', 'attention', 'drafts', 'done', 'metrics', 'library'] as const;
export type SocialTab = (typeof SOCIAL_TABS)[number];
export interface SocialSearch {
  tab?: SocialTab;
  channel?: string;
  // A label's id (#639): the lists, the board, the calendar and the metrics show only posts with it.
  label?: string;
  q?: string;
  // Local calendar days, YYYY-MM-DD, both included.
  from?: string;
  to?: string;
  // Only posts assigned to the viewer (#640).
  mine?: true;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseSocialSearch(search: Record<string, unknown>): SocialSearch {
  const out: SocialSearch = {};
  if (typeof search.tab === 'string' && (SOCIAL_TABS as readonly string[]).includes(search.tab)) out.tab = search.tab as SocialTab;
  if (typeof search.channel === 'string' && UUID_RE.test(search.channel)) out.channel = search.channel;
  if (typeof search.label === 'string' && UUID_RE.test(search.label)) out.label = search.label;
  if (typeof search.q === 'string' && search.q.trim()) out.q = search.q.trim().slice(0, 200);
  if (typeof search.from === 'string' && DAY_RE.test(search.from)) out.from = search.from;
  if (typeof search.to === 'string' && DAY_RE.test(search.to)) out.to = search.to;
  if (search.mine === true || search.mine === '1' || search.mine === 'true') out.mine = true;
  return out;
}

// The list query's range for local days: from the start of `from` to the end of `to`.
export function dayRange(from: string | undefined, to: string | undefined): { from?: string; to?: string } {
  const start = (day: string) => new Date(`${day}T00:00:00`);
  const out: { from?: string; to?: string } = {};
  if (from && !Number.isNaN(start(from).getTime())) out.from = start(from).toISOString();
  if (to && !Number.isNaN(start(to).getTime())) {
    const end = start(to);
    end.setDate(end.getDate() + 1);
    out.to = end.toISOString();
  }
  return out;
}