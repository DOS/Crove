// The version history of a post (#1021): what a version keeps, when a save makes one, which versions the prune drops,
// and what a version shows per channel. Pure functions; versions.ts reads and writes the rows.
import { effectiveContent } from './approval.ts';

// The newest versions a post keeps; the save that makes the 51st deletes the oldest.
export const MAX_VERSIONS_PER_POST = 50;

export interface VersionMedia {
  fileId: string;
  altText: string | null;
}

// A channel's own content as stored: null overrides inherit the post's, media null shows the post's images.
export interface VersionVariant {
  variantId: string;
  connectionId: string;
  provider: string;
  body: string | null;
  title: string | null;
  linkUrl: string | null;
  settings: Record<string, unknown>;
  media: VersionMedia[] | null;
  // History (published, cancelled, removed): its columns hold its whole content and nothing is inherited.
  contentFrozen: boolean;
}

export interface VersionSnapshot {
  body: string;
  title: string | null;
  linkUrl: string | null;
  media: VersionMedia[];
  variants: VersionVariant[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const textOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);

// JSON with sorted keys, so the order jsonb returns an object in is not a change.
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    isRecord(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v,
  );
}

// Whether two snapshots hold the same content: a save that leaves it as it was makes no version.
export const sameSnapshot = (a: VersionSnapshot, b: VersionSnapshot): boolean => canonical(a) === canonical(b);

// A media list as a version stores it. Read defensively: an entry without a file id is dropped.
export function versionMedia(raw: unknown): VersionMedia[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isRecord).flatMap((m) => (typeof m.fileId === 'string' ? [{ fileId: m.fileId, altText: textOrNull(m.altText) }] : []));
}

// The channels of a version as it stores them. Read defensively: an entry without its ids is dropped.
export function versionVariants(raw: unknown): VersionVariant[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isRecord).flatMap((v) =>
    typeof v.variantId === 'string' && typeof v.connectionId === 'string' && typeof v.provider === 'string'
      ? [
          {
            variantId: v.variantId,
            connectionId: v.connectionId,
            provider: v.provider,
            body: textOrNull(v.body),
            title: textOrNull(v.title),
            linkUrl: textOrNull(v.linkUrl),
            settings: isRecord(v.settings) ? v.settings : {},
            media: Array.isArray(v.media) ? versionMedia(v.media) : null,
            contentFrozen: v.contentFrozen === true,
          },
        ]
      : [],
  );
}

// The numbers a save writes: the content before it first when the post has no version yet (latest null), then the new
// content; and the highest number the prune deletes up to (0: none), so the newest MAX_VERSIONS_PER_POST stay.
export function versionNumbers(latest: number | null): { baseline: number | null; next: number; pruneUpTo: number } {
  const baseline = latest === null ? 1 : null;
  const next = (latest ?? 1) + 1;
  return { baseline, next, pruneUpTo: Math.max(0, next - MAX_VERSIONS_PER_POST) };
}

// What a channel showed in a version: its effective text, link and images, and its settings.
export interface VersionContent {
  body: string;
  title: string | null;
  linkUrl: string | null;
  media: VersionMedia[];
  settings: Record<string, unknown>;
}

export function variantContent(version: Pick<VersionSnapshot, 'body' | 'title' | 'linkUrl' | 'media'>, v: VersionVariant): VersionContent {
  const content = effectiveContent({ body: version.body, title: version.title, linkUrl: version.linkUrl }, { body: v.body, title: v.title, linkUrl: v.linkUrl }, v.contentFrozen);
  const media = v.contentFrozen ? (v.media ?? []) : (v.media ?? version.media);
  return { body: content.body, title: content.title, linkUrl: content.linkUrl, media, settings: v.settings };
}
