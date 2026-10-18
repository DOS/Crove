// Shared pieces of the Social screens: status tones, provider names, the effective text of a variant as the composer
// shows it, and grouping by day for the agenda.
import { CAPABILITIES, countText, isProvider, validateVariant, type Issue, type Provider } from '@crove/mod-social/contract';

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
  | 'cancelled';

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
};

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
};

export function providerName(provider: string): string {
  return isProvider(provider) ? PROVIDER_NAMES[provider] : provider;
}

// A variant's text against its channel's limit, the way the platform counts.
export function textBudget(provider: string, body: string): { used: number; max: number | null } {
  if (!isProvider(provider)) return { used: body.length, max: null };
  const rule = CAPABILITIES[provider].body;
  return { used: countText(body, rule.count), max: rule.max };
}

export function hasTitle(provider: string): boolean {
  return isProvider(provider) && CAPABILITIES[provider].title !== null;
}

// The issues a draft would have at submit, checked as it is typed (the server checks again).
export function draftIssues(provider: string, content: { body: string; title: string | null; media?: readonly { mime: string; sizeBytes: number; durationMs?: number | null | undefined }[] }): Issue[] {
  if (!isProvider(provider)) return [];
  const media = (content.media ?? []).map((m) => ({ kind: m.mime.startsWith('video/') ? ('video' as const) : ('image' as const), mime: m.mime, sizeBytes: m.sizeBytes, durationSeconds: m.durationMs == null ? null : m.durationMs / 1000 }));
  return validateVariant({ provider, body: content.body, title: content.title, media });
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
