// Checks a variant against its channel's capabilities (Social plan §3.6). Returns every issue rather than the first,
// so the composer can show them all; an empty list means the variant fits the channel. A variant that breaks a
// rule is flagged, never silently cut.
import { CAPABILITIES, countLinks, countText, type ChannelCapabilities, type MediaKind, type Provider, type TextRule } from './channels.ts';

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
}

export type IssueCode =
  | 'TEXT_REQUIRED'
  | 'TEXT_TOO_LONG'
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
  if (rule.max === null) return;
  const n = countText(text, rule.count);
  if (n > rule.max) issues.push({ code: tooLong, field, limit: rule.max, actual: n });
}

export function validateVariant(variant: VariantDraft, caps: ChannelCapabilities = CAPABILITIES[variant.provider]): Issue[] {
  const issues: Issue[] = [];
  checkText(issues, 'body', variant.body, caps.body);
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
  if (!rule.mixed && videos > 0 && videos < media.length) issues.push({ code: 'MEDIA_MIX_NOT_ALLOWED', field: 'media', limit: null, actual: null });

  media.forEach((m, i) => {
    const field = `media.${i}`;
    if (!rule.kinds.includes(m.kind)) {
      issues.push({ code: 'MEDIA_KIND_NOT_ALLOWED', field, limit: null, actual: null });
      return;
    }
    if (m.kind === 'image') {
      if (rule.imageTypes.length > 0 && !rule.imageTypes.includes(m.mime.toLowerCase())) {
        issues.push({ code: 'IMAGE_TYPE_NOT_ALLOWED', field, limit: null, actual: null });
      }
      if (rule.maxImageBytes !== null && m.sizeBytes > rule.maxImageBytes) {
        issues.push({ code: 'IMAGE_TOO_LARGE', field, limit: rule.maxImageBytes, actual: m.sizeBytes });
      }
    } else {
      if (rule.maxVideoBytes !== null && m.sizeBytes > rule.maxVideoBytes) {
        issues.push({ code: 'VIDEO_TOO_LARGE', field, limit: rule.maxVideoBytes, actual: m.sizeBytes });
      }
      if (rule.maxVideoSeconds !== null && m.durationSeconds !== null && m.durationSeconds > rule.maxVideoSeconds) {
        issues.push({ code: 'VIDEO_TOO_LONG', field, limit: rule.maxVideoSeconds, actual: m.durationSeconds });
      }
    }
  });

  if (caps.maxLinks !== null) {
    const links = countLinks(variant.body);
    if (links > caps.maxLinks) issues.push({ code: 'TOO_MANY_LINKS', field: 'body', limit: caps.maxLinks, actual: links });
  }
  return issues;
}
