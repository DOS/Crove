// An approval covers one revision of a post and the exact content of its variants (Social plan §3.2,
// post_approval). The content hash is computed over a canonical form, so key order and Unicode normalization do
// not change it, while any change a reader could see does.
import { createHash } from 'node:crypto';
import type { Provider } from './channels.ts';

export interface HashedMedia {
  // Kernel file id and its storage generation, so replacing a file's bytes changes the hash.
  fileId: string;
  generation: number;
  altText: string | null;
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

// A frozen variant (history) keeps its own content: its columns hold it, and null there means "none".
export function effectiveContent(base: BaseContent, overrides: ContentOverrides, frozen = false): BaseContent {
  if (frozen) return { body: overrides.body ?? '', title: overrides.title, linkUrl: overrides.linkUrl };
  return { body: overrides.body ?? base.body, title: overrides.title ?? base.title, linkUrl: overrides.linkUrl ?? base.linkUrl };
}
