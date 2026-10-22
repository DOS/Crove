// The Instagram grid preview (#795): how a channel's profile grid will look, the posts still to come ahead of the ones
// already out, newest first as Instagram shows them. Stories never reach the grid, nor Reels kept to the Reels tab or
// posted as trial Reels (#1019). Kept apart from the screen so it can be tested without one.
import { instagramReelOffGrid, postTypeOf } from '@crove/mod-social/contract';
import type { CalendarPost } from './social-calendar.ts';
import type { VariantStatus } from './social.ts';

type Variant = CalendarPost['variants'][number];
export interface GridItem {
  post: CalendarPost;
  v: Variant;
  at: Date;
  // Not out yet: a schedule, or a draft's planned time.
  upcoming: boolean;
}

// The grid shows at most this many tiles: four months of daily posting.
export const GRID_MAX = 120;
const UPCOMING: readonly VariantStatus[] = ['draft', 'in_review', 'changes_requested', 'approved', 'scheduled', 'paused', 'publishing', 'processing'];

export function gridItems(posts: readonly CalendarPost[], connectionId: string): GridItem[] {
  const items: GridItem[] = [];
  for (const post of posts) {
    for (const v of post.variants) {
      if (v.connectionId !== connectionId || v.media.length === 0 || postTypeOf(v.settings) === 'story') continue;
      if (v.media.length === 1 && v.media[0]?.mime.startsWith('video/') && instagramReelOffGrid(v.settings)) continue;
      if (v.status === 'published' && v.publishedAt) {
        items.push({ post, v, at: new Date(v.publishedAt), upcoming: false });
        continue;
      }
      if (!UPCOMING.includes(v.status)) continue;
      const when = v.effectiveAt ?? post.scheduledAt;
      if (when) items.push({ post, v, at: new Date(when), upcoming: true });
    }
  }
  // Newest first, as the profile shows it: what goes out last sits at the top left.
  return items.sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, GRID_MAX);
}

// Only two scheduled posts can trade places: each takes the other's time.
export const swappable = (item: GridItem) => item.upcoming && item.v.status === 'scheduled' && !item.v.queuePaused;

export function swapTimes(a: GridItem, b: GridItem): [{ variantId: string; at: Date }, { variantId: string; at: Date }] | null {
  if (a.v.id === b.v.id || !swappable(a) || !swappable(b) || a.at.getTime() === b.at.getTime()) return null;
  return [
    { variantId: a.v.id, at: b.at },
    { variantId: b.v.id, at: a.at },
  ];
}
