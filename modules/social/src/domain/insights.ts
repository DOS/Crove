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

const WEEKDAYS: Readonly<Record<string, number>> = { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 7 };

function slotFormat(timeZone: string): Intl.DateTimeFormat {
  const options = { weekday: 'short', hour: 'numeric', hourCycle: 'h23' } as const;
  try {
    return new Intl.DateTimeFormat('en-US', { ...options, timeZone });
  } catch {
    // A zone this runtime does not know: UTC rather than no suggestions.
    return new Intl.DateTimeFormat('en-US', { ...options, timeZone: 'UTC' });
  }
}

export function bestTimes(samples: readonly PublishedSample[], timeZone: string, options: BestTimesOptions = {}): Map<string, BestTime[]> {
  const minSlot = options.minPostsPerSlot ?? 2;
  const minChannel = options.minPostsPerChannel ?? 5;
  const top = options.top ?? 3;
  const format = slotFormat(timeZone);
  const byChannel = new Map<string, { counted: number; slots: Map<string, { weekday: number; hour: number; posts: number; total: number }> }>();
  for (const s of samples) {
    // A post without a capture yet tells nothing about its time.
    if (!s.publishedAt || Object.keys(s.metrics).length === 0) continue;
    const at = new Date(s.publishedAt);
    if (Number.isNaN(at.getTime())) continue;
    const parts = format.formatToParts(at);
    // Runtimes differ in case and trailing dots ('Mon', 'Mon.').
    const weekday = WEEKDAYS[(parts.find((p) => p.type === 'weekday')?.value ?? '').toLowerCase().replace(/[^a-z]/g, '').slice(0, 3)];
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

// What works (#705): for each channel, the posts' engagement against the channel's own median, broken down by label,
// format, weekday, hour and hashtag, plus its best and worst posts. Engagement is engagementOf (reactions, comments,
// shares and saves), which every platform reports; a rate over reach would leave out the channels that report none.
// Medians, so one viral post does not tilt a group. A post without a capture yet is left out. A format group also
// carries the median average watch time of its posts that report one (#1147, Reels): how long the format holds viewers.
export type PostFormat = 'text' | 'image' | 'carousel' | 'video' | 'document' | 'story' | 'reel';
export const POST_FORMATS: readonly PostFormat[] = ['text', 'image', 'carousel', 'video', 'document', 'story', 'reel'];

export interface InsightSample {
  variantId: string;
  connectionId: string;
  publishedAt: string | null;
  metrics: Readonly<Record<string, number>>;
  // The text as sent, for its hashtags.
  text: string;
  labelIds: readonly string[];
  format: PostFormat;
}

export interface InsightGroup {
  key: string;
  posts: number;
  median: number;
  // median / the channel's median; null when the channel's median is 0.
  ratio: number | null;
  // By format only (#1147): the median of the average watch time (milliseconds) of the group's posts that report one,
  // Reels on Instagram; absent when none does.
  avgWatchTimeMs?: number | undefined;
}

export interface ChannelInsights {
  connectionId: string;
  posts: number;
  median: number;
  best: { variantId: string; engagement: number }[];
  worst: { variantId: string; engagement: number }[];
  byLabel: InsightGroup[];
  byFormat: InsightGroup[];
  byWeekday: InsightGroup[];
  byHour: InsightGroup[];
  byHashtag: InsightGroup[];
}

export interface WhatWorksOptions {
  // Uses a hashtag needs before it is shown (default 3).
  minHashtagPosts?: number;
  // Best and worst posts shown (default 5).
  top?: number;
}

// The format a variant goes out as: its post type, or what its media make it.
export function formatOf(postType: string | null | undefined, mediaTypes: readonly string[]): PostFormat {
  if (postType === 'story') return 'story';
  if (postType === 'reel') return 'reel';
  if (mediaTypes.length === 0) return 'text';
  if (mediaTypes.length > 1) return 'carousel';
  // A PDF is a document post (#1119, LinkedIn).
  return mediaTypes[0]?.startsWith('video/') ? 'video' : mediaTypes[0] === 'application/pdf' ? 'document' : 'image';
}

// A post's hashtags, each once, lower-cased the Vietnamese way (letters with their marks, digits and _).
export function hashtagsOf(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.normalize('NFC').matchAll(/(?:^|[^\p{L}\p{N}_&])#([\p{L}\p{M}\p{N}_]{1,100})/gu)) {
    const tag = (m[1] ?? '').toLocaleLowerCase('vi');
    if (/\p{L}/u.test(tag)) out.add(tag);
  }
  return [...out];
}

// Hashtags to suggest while writing (#818): the org's hashtags whose posts did better than their channel's median,
// best first (the strongest channel's ratio, then the most posts), leaving out the ones the text holds already. With
// connectionId, that channel's alone. Deterministic, from the What works groups.
export function hashtagSuggestions(
  channels: readonly Pick<ChannelInsights, 'connectionId' | 'byHashtag'>[],
  text: string,
  options: { connectionId?: string | null; max?: number } = {},
): string[] {
  const used = new Set(hashtagsOf(text));
  const best = new Map<string, { ratio: number; posts: number }>();
  for (const c of channels) {
    if (options.connectionId && c.connectionId !== options.connectionId) continue;
    for (const g of c.byHashtag) {
      if (g.ratio === null || g.ratio <= 1 || used.has(g.key)) continue;
      const seen = best.get(g.key);
      if (!seen || g.ratio > seen.ratio || (g.ratio === seen.ratio && g.posts > seen.posts)) best.set(g.key, { ratio: g.ratio, posts: g.posts });
    }
  }
  return [...best.entries()]
    .sort((a, b) => b[1].ratio - a[1].ratio || b[1].posts - a[1].posts || (a[0] < b[0] ? -1 : 1))
    .slice(0, options.max ?? 8)
    .map(([tag]) => tag);
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

export function whatWorks(samples: readonly InsightSample[], timeZone: string, options: WhatWorksOptions = {}): ChannelInsights[] {
  const minTag = options.minHashtagPosts ?? 3;
  const top = options.top ?? 5;
  const format = slotFormat(timeZone);
  const byChannel = new Map<string, { variantId: string; engagement: number; s: InsightSample; weekday: number | null; hour: number | null }[]>();
  for (const s of samples) {
    if (Object.keys(s.metrics).length === 0) continue;
    let weekday: number | null = null;
    let hour: number | null = null;
    const at = s.publishedAt ? new Date(s.publishedAt) : null;
    if (at && !Number.isNaN(at.getTime())) {
      const parts = format.formatToParts(at);
      weekday = WEEKDAYS[(parts.find((p) => p.type === 'weekday')?.value ?? '').toLowerCase().replace(/[^a-z]/g, '').slice(0, 3)] ?? null;
      const h = Number(parts.find((p) => p.type === 'hour')?.value);
      hour = Number.isInteger(h) ? h : null;
    }
    const list = byChannel.get(s.connectionId) ?? [];
    list.push({ variantId: s.variantId, engagement: engagementOf(s.metrics), s, weekday, hour });
    byChannel.set(s.connectionId, list);
  }
  const out: ChannelInsights[] = [];
  for (const [connectionId, posts] of byChannel) {
    const all = median(posts.map((p) => p.engagement));
    const group = (keyOf: (p: (typeof posts)[number]) => readonly string[], min = 1): InsightGroup[] => {
      const groups = new Map<string, number[]>();
      for (const p of posts) {
        for (const key of keyOf(p)) {
          const list = groups.get(key);
          if (list) list.push(p.engagement);
          else groups.set(key, [p.engagement]);
        }
      }
      return [...groups.entries()]
        .filter(([, values]) => values.length >= min)
        .map(([key, values]) => {
          const m = median(values);
          return { key, posts: values.length, median: m, ratio: all > 0 ? m / all : null };
        })
        .sort((a, b) => b.median - a.median || b.posts - a.posts || a.key.localeCompare(b.key));
    };
    const ranked = [...posts].sort((a, b) => b.engagement - a.engagement || a.variantId.localeCompare(b.variantId));
    out.push({
      connectionId,
      posts: posts.length,
      median: all,
      best: ranked.slice(0, top).map((p) => ({ variantId: p.variantId, engagement: p.engagement })),
      worst: ranked.length > top ? ranked.slice(-top).reverse().map((p) => ({ variantId: p.variantId, engagement: p.engagement })) : [],
      byLabel: group((p) => p.s.labelIds),
      byFormat: group((p) => [p.s.format]).map((g) => {
        const watched = posts.filter((p) => p.s.format === g.key && Number.isFinite(p.s.metrics.avgWatchTimeMs)).map((p) => p.s.metrics.avgWatchTimeMs as number);
        return watched.length === 0 ? g : { ...g, avgWatchTimeMs: median(watched) };
      }),
      byWeekday: group((p) => (p.weekday === null ? [] : [String(p.weekday)])),
      byHour: group((p) => (p.hour === null ? [] : [String(p.hour)])),
      byHashtag: group((p) => hashtagsOf(p.s.text), minTag),
    });
  }
  return out.sort((a, b) => b.posts - a.posts || a.connectionId.localeCompare(b.connectionId));
}
