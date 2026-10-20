// Checks a variant against its channel's capabilities (Social plan §3.6). Returns every issue rather than the first,
// so the composer can show them all; an empty list means the variant fits the channel. A variant that breaks a
// rule is flagged, never silently cut.
import { CAPABILITIES, VIDEO_ONLY_ADAPTERS, VIDEO_READY, countLinks, countText, sentText, type ChannelCapabilities, type MediaKind, type Provider, type TextRule } from './channels.ts';
import { sentLink } from './utm.ts';

// TikTok's privacy levels; which ones an account may use is checked with TikTok when the video goes out.
export const TIKTOK_PRIVACY: readonly string[] = ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY'];

export interface MediaItem {
  kind: MediaKind;
  mime: string;
  sizeBytes: number;
  durationSeconds: number | null;
}

export interface VariantDraft {
  provider: Provider;
  body: string;
  title: string | null;
  media: readonly MediaItem[];
  // The post's link: the adapters of some channels add it to the text, which then counts against the limit.
  linkUrl?: string | null;
  // The variant's provider settings (privacy level and the like); absent is none.
  settings?: Readonly<Record<string, unknown>>;
}

export type IssueCode =
  | 'CONTENT_REQUIRED'
  | 'TEXT_REQUIRED'
  | 'TEXT_TOO_LONG'
  // Within the count, over the channel's cap in UTF-8 bytes.
  | 'TEXT_TOO_MANY_BYTES'
  | 'TITLE_REQUIRED'
  | 'TITLE_TOO_LONG'
  | 'TITLE_NOT_SUPPORTED'
  | 'MEDIA_REQUIRED'
  | 'TOO_MANY_MEDIA'
  | 'MEDIA_KIND_NOT_ALLOWED'
  | 'MEDIA_MIX_NOT_ALLOWED'
  | 'TOO_MANY_VIDEOS'
  | 'IMAGE_TYPE_NOT_ALLOWED'
  | 'IMAGE_TOO_LARGE'
  | 'VIDEO_TOO_LARGE'
  | 'VIDEO_TOO_LONG'
  // The platform takes video, Crove's adapter for it does not yet.
  | 'VIDEO_NOT_SUPPORTED_YET'
  // TikTok: the person posting picks who sees the video; there is no default.
  | 'PRIVACY_REQUIRED'
  // The platform takes photos, Crove's adapter for it posts only video.
  | 'IMAGES_NOT_SUPPORTED_YET'
  | 'TOO_MANY_LINKS';

export interface Issue {
  code: IssueCode;
  // 'body', 'title', 'media' or 'media.<index>'.
  field: string;
  limit: number | null;
  actual: number | null;
}

function checkText(issues: Issue[], field: 'body' | 'title', text: string, rule: TextRule): void {
  const required: IssueCode = field === 'body' ? 'TEXT_REQUIRED' : 'TITLE_REQUIRED';
  const tooLong: IssueCode = field === 'body' ? 'TEXT_TOO_LONG' : 'TITLE_TOO_LONG';
  if (rule.required && text.trim() === '') issues.push({ code: required, field, limit: null, actual: null });
  if (rule.max !== null) {
    const n = countText(text, rule.count);
    if (n > rule.max) {
      issues.push({ code: tooLong, field, limit: rule.max, actual: n });
      return;
    }
  }
  if (rule.maxBytes !== undefined) {
    const bytes = countText(text, 'bytes');
    if (bytes > rule.maxBytes) issues.push({ code: 'TEXT_TOO_MANY_BYTES', field, limit: rule.maxBytes, actual: bytes });
  }
}

export function validateVariant(variant: VariantDraft, caps: ChannelCapabilities = CAPABILITIES[variant.provider]): Issue[] {
  const issues: Issue[] = [];
  // No channel takes an empty post: it needs text or media.
  if (variant.body.trim() === '' && variant.media.length === 0) issues.push({ code: 'CONTENT_REQUIRED', field: 'body', limit: null, actual: null });
  // The text as the adapter sends it, with the link it appends.
  // The link as the channel sends it, with its UTM tags (#585), counted where the channel counts it.
  const sent = sentText(variant.provider, variant.body, sentLink(variant.provider, variant.linkUrl ?? null, variant.settings, variant.body), variant.media.length);
  checkText(issues, 'body', sent, caps.body);
  if (caps.title) checkText(issues, 'title', variant.title ?? '', caps.title);
  else if (variant.title !== null && variant.title.trim() !== '') issues.push({ code: 'TITLE_NOT_SUPPORTED', field: 'title', limit: null, actual: null });

  const { media } = variant;
  const rule = caps.media;
  if (media.length < rule.min) issues.push({ code: 'MEDIA_REQUIRED', field: 'media', limit: rule.min, actual: media.length });
  if (media.length > rule.max) issues.push({ code: 'TOO_MANY_MEDIA', field: 'media', limit: rule.max, actual: media.length });
  const videos = media.filter((m) => m.kind === 'video').length;
  if (videos > rule.maxVideos && rule.kinds.includes('video')) {
    issues.push({ code: 'TOO_MANY_VIDEOS', field: 'media', limit: rule.maxVideos, actual: videos });
  }
  const allowedKinds = media.every((m) => rule.kinds.includes(m.kind));
  if (!rule.mixed && allowedKinds && videos > 0 && videos < media.length) issues.push({ code: 'MEDIA_MIX_NOT_ALLOWED', field: 'media', limit: null, actual: null });

  media.forEach((m, i) => {
    const field = `media.${i}`;
    if (!rule.kinds.includes(m.kind)) {
      issues.push({ code: 'MEDIA_KIND_NOT_ALLOWED', field, limit: null, actual: null });
      return;
    }
    if (m.kind === 'image') {
      if (VIDEO_ONLY_ADAPTERS.has(variant.provider)) issues.push({ code: 'IMAGES_NOT_SUPPORTED_YET', field, limit: null, actual: null });
      if (rule.imageTypes.length > 0 && !rule.imageTypes.includes(m.mime.toLowerCase())) {
        issues.push({ code: 'IMAGE_TYPE_NOT_ALLOWED', field, limit: null, actual: null });
      }
      if (rule.maxImageBytes !== null && m.sizeBytes > rule.maxImageBytes) {
        issues.push({ code: 'IMAGE_TOO_LARGE', field, limit: rule.maxImageBytes, actual: m.sizeBytes });
      }
    } else {
      if (!VIDEO_READY.has(variant.provider)) issues.push({ code: 'VIDEO_NOT_SUPPORTED_YET', field, limit: null, actual: null });
      if (rule.maxVideoBytes !== null && m.sizeBytes > rule.maxVideoBytes) {
        issues.push({ code: 'VIDEO_TOO_LARGE', field, limit: rule.maxVideoBytes, actual: m.sizeBytes });
      }
      if (rule.maxVideoSeconds !== null && m.durationSeconds !== null && m.durationSeconds > rule.maxVideoSeconds) {
        issues.push({ code: 'VIDEO_TOO_LONG', field, limit: rule.maxVideoSeconds, actual: m.durationSeconds });
      }
    }
  });

  if (variant.provider === 'tiktok' && !TIKTOK_PRIVACY.includes(String(variant.settings?.privacyLevel ?? ''))) {
    issues.push({ code: 'PRIVACY_REQUIRED', field: 'settings.privacyLevel', limit: null, actual: null });
  }
  if (caps.maxLinks !== null) {
    const links = countLinks(sent);
    if (links > caps.maxLinks) issues.push({ code: 'TOO_MANY_LINKS', field: 'body', limit: caps.maxLinks, actual: links });
  }
  return issues;
}
