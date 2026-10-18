// Posting-time suggestions from history (Social plan v1.x): for each channel, the weekday and hour its published posts
// drew the most engagement, from the latest metrics of each post. A plain average per hour slot, in the viewer's time
// zone; a slot needs a few posts and a channel needs enough of them, or it suggests nothing rather than noise.

export interface PublishedSample {
  connectionId: string;
  publishedAt: string | null;
  metrics: Readonly<Record<string, number>>;
}

export interface BestTime {
  // 1 is Monday, 7 is Sunday, as the posting queue numbers them.
  weekday: number;
  hour: number;
  posts: number;
  // Average engagement of the posts in the slot.
  engagement: number;
}

export interface BestTimesOptions {
  // Posts a slot needs to be ranked (default 2).
  minPostsPerSlot?: number;
  // Posts with metrics a channel needs before it gets suggestions (default 5).
  minPostsPerChannel?: number;
  // Slots returned per channel (default 3).
  top?: number;
}

// Reactions, comments, shares and saves: the counts every platform reports on the same scale. Impressions, reach and
// views are of another order and some platforms do not report them, so they would rank channels by what they report.
export function engagementOf(metrics: Readonly<Record<string, number>>): number {
  return ['reactions', 'comments', 'shares', 'saves'].reduce((sum, name) => sum + (Number.isFinite(metrics[name]) ? (metrics[name] as number) : 0), 0);
}

const WEEKDAYS: Readonly<Record<string, number>> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

export function bestTimes(samples: readonly PublishedSample[], timeZone: string, options: BestTimesOptions = {}): Map<string, BestTime[]> {
  const minSlot = options.minPostsPerSlot ?? 2;
  const minChannel = options.minPostsPerChannel ?? 5;
  const top = options.top ?? 3;
  const format = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: 'numeric', hourCycle: 'h23' });
  const byChannel = new Map<string, { counted: number; slots: Map<string, { weekday: number; hour: number; posts: number; total: number }> }>();
  for (const s of samples) {
    // A post without a capture yet tells nothing about its time.
    if (!s.publishedAt || Object.keys(s.metrics).length === 0) continue;
    const at = new Date(s.publishedAt);
    if (Number.isNaN(at.getTime())) continue;
    const parts = format.formatToParts(at);
    const weekday = WEEKDAYS[parts.find((p) => p.type === 'weekday')?.value ?? ''];
    const hour = Number(parts.find((p) => p.type === 'hour')?.value);
    if (weekday === undefined || !Number.isInteger(hour)) continue;
    const channel = byChannel.get(s.connectionId) ?? { counted: 0, slots: new Map() };
    channel.counted++;
    const key = `${weekday}:${hour}`;
    const slot = channel.slots.get(key) ?? { weekday, hour, posts: 0, total: 0 };
    slot.posts++;
    slot.total += engagementOf(s.metrics);
    channel.slots.set(key, slot);
    byChannel.set(s.connectionId, channel);
  }
  const out = new Map<string, BestTime[]>();
  for (const [connectionId, channel] of byChannel) {
    if (channel.counted < minChannel) continue;
    const ranked = [...channel.slots.values()]
      .filter((s) => s.posts >= minSlot)
      .map((s) => ({ weekday: s.weekday, hour: s.hour, posts: s.posts, engagement: s.total / s.posts }))
      .filter((s) => s.engagement > 0)
      .sort((a, b) => b.engagement - a.engagement || b.posts - a.posts || a.weekday - b.weekday || a.hour - b.hour)
      .slice(0, top);
    if (ranked.length > 0) out.set(connectionId, ranked);
  }
  return out;
}
