// An approval covers one revision of a post and the exact content of its variants (Social plan §3.2,
// post_approval). The content hash is computed over a canonical form, so key order and Unicode normalization do
// not change it, while any change a reader could see does.
import { createHash } from 'node:crypto';
import type { Provider } from './channels.ts';

export interface HashedMedia {
  // Kernel file id and the object version its bytes were written as (ADR-0013; null on files from before it), so
  // another file or other bytes change the hash. With null, the file id alone binds the bytes: a file row never changes
  // (file_guard) and every read is checked against its sha256.
  fileId: string;
  generation: string | null;
  altText: string | null;
}

// An image of a post or variant as the commands keep it: what the hash binds to, plus what the channel rules check.
export interface PostMedia extends HashedMedia {
  mime: string;
  sizeBytes: number;
  // A video's duration as the server read it from the file (#409); null for images.
  durationMs?: number | null;
  // An image's size as shown, read from its header (#636); null when unknown (a video, an older upload).
  width?: number | null;
  height?: number | null;
}

export interface HashedVariant {
  channelConnectionId: string;
  provider: Provider;
  body: string;
  title: string | null;
  linkUrl: string | null;
  media: readonly HashedMedia[];
  // Provider settings (privacy level, post type...), already validated; plain JSON values only.
  settings: Readonly<Record<string, unknown>>;
}

// Plain JSON only: anything JSON would change silently (NaN, -0, undefined in an array, a Date or Map) is refused,
// so two different contents never share a hash. An undefined object property is the same as a missing one.
function canonical(value: unknown, path: string): unknown {
  if (typeof value === 'string') return value.normalize('NFC');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw new Error(`contentHash: unsupported number at ${path}`);
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((v: unknown, i) => {
      if (v === undefined) throw new Error(`contentHash: undefined at ${path}[${i}]`);
      return canonical(v, `${path}[${i}]`);
    });
  }
  if (typeof value === 'object') {
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw new Error(`contentHash: not a plain object at ${path}`);
    // A null-prototype target keeps a "__proto__" key as an ordinary key.
    const out = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = canonical(v, `${path}.${key}`);
    }
    return out;
  }
  throw new Error(`contentHash: unsupported ${typeof value} at ${path}`);
}

// Bumped if the canonical form ever changes, so old and new hashes never compare equal by accident.
const HASH_VERSION = 'crove.social.content.v1';

// sha256 over the variants sorted by channel connection, so the order they were added in does not matter. A post
// has at most one variant per channel connection.
export function contentHash(variants: readonly HashedVariant[]): string {
  const sorted = [...variants].sort((a, b) => (a.channelConnectionId < b.channelConnectionId ? -1 : a.channelConnectionId > b.channelConnectionId ? 1 : 0));
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]?.channelConnectionId === sorted[i - 1]?.channelConnectionId) throw new Error('contentHash: two variants for one channel connection');
  }
  const body = JSON.stringify(canonical(sorted, 'variants'));
  return 'sha256:' + createHash('sha256').update(`${HASH_VERSION}\n${body}`).digest('hex');
}

export interface ApprovalRecord {
  revision: number;
  contentHash: string;
}

// A publish may go ahead only under an approval of the post exactly as it is now.
export function approvalCovers(approval: ApprovalRecord | null, post: { revision: number; contentHash: string }): boolean {
  return approval !== null && approval.revision === post.revision && approval.contentHash === post.contentHash;
}

// A review decision as post_approval keeps it.
export interface DecisionRecord {
  decision: string;
  decidedBy: string;
  revision: number;
  contentHash: string;
}

// Who approved a variant's current content in the review round now open (S9 multi-step approval): decisions are
// newest first; a request for changes or a rejection ends the round before it, and an approval of other content
// (another revision or hash) never counts.
export function approvalsInRound(decisions: readonly DecisionRecord[], current: { revision: number; contentHash: string }): string[] {
  const by = new Set<string>();
  for (const d of decisions) {
    if (d.decision !== 'approved') break;
    if (d.revision === current.revision && d.contentHash === current.contentHash) by.add(d.decidedBy);
  }
  return [...by];
}

// Base content of a post, and a variant's overrides of it: null inherits, any string (also '') overrides.
export interface BaseContent {
  body: string;
  title: string | null;
  linkUrl: string | null;
}

export interface ContentOverrides {
  body: string | null;
  title: string | null;
  linkUrl: string | null;
}

// A variant's media: its own list when it has one (an override, or the list history kept), else the post's.
export function effectiveMedia(base: readonly PostMedia[], own: readonly PostMedia[] | null, frozen = false): readonly PostMedia[] {
  if (frozen) return own ?? [];
  return own ?? base;
}

// A frozen variant (history) keeps its own content: its columns hold it, and null there means "none".
export function effectiveContent(base: BaseContent, overrides: ContentOverrides, frozen = false): BaseContent {
  if (frozen) return { body: overrides.body ?? '', title: overrides.title, linkUrl: overrides.linkUrl };
  return { body: overrides.body ?? base.body, title: overrides.title ?? base.title, linkUrl: overrides.linkUrl ?? base.linkUrl };
}
