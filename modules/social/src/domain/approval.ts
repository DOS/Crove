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

function canonical(value: unknown): unknown {
  if (typeof value === 'string') return value.normalize('NFC');
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = canonical(v);
    }
    return out;
  }
  return value;
}

// sha256 over the variants sorted by channel connection, so the order they were added in does not matter.
export function contentHash(variants: readonly HashedVariant[]): string {
  const sorted = [...variants].sort((a, b) => (a.channelConnectionId < b.channelConnectionId ? -1 : a.channelConnectionId > b.channelConnectionId ? 1 : 0));
  return 'sha256:' + createHash('sha256').update(JSON.stringify(canonical(sorted))).digest('hex');
}

export interface ApprovalRecord {
  revision: number;
  contentHash: string;
}

// A publish may go ahead only under an approval of the post exactly as it is now.
export function approvalCovers(approval: ApprovalRecord | null, post: { revision: number; contentHash: string }): boolean {
  return approval !== null && approval.revision === post.revision && approval.contentHash === post.contentHash;
}
