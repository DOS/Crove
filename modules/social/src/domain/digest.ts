// The weekly digest (#1104), the parts that need no database: which posting days of a queue are still empty, and what
// one member's mail says, from the org's week as the command read it and the channels the member may use (#1081).
// Nothing here reads the clock; callers pass the instants.
import { localTime, slotsBetween, type QueueSpec } from './queue.ts';
import { engagementOf } from './insights.ts';

// The most lines of each list one mail carries, so its merge data stays small.
export const DIGEST_TOP = 3;
export const DIGEST_LIST_MAX = 5;
export const DIGEST_CHANNELS_MAX = 20;

const pad = (n: number) => String(n).padStart(2, '0');

// The local calendar days (YYYY-MM-DD, in the queue's zone) that have one of the queue's slots in (fromMs, toMs] and no
// post holding a slot that day, ascending. A queue whose zone the runtime does not know has none.
export function emptyQueueDays(queue: QueueSpec, taken: Iterable<number>, fromMs: number, toMs: number): string[] {
  try {
    const dayOf = (at: number) => {
      const l = localTime(at, queue.timeZone);
      return `${l.year}-${pad(l.month)}-${pad(l.day)}`;
    };
    const posting = new Set(slotsBetween(queue, fromMs, toMs).map(dayOf));
    for (const at of taken) {
      if (at > fromMs && at <= toMs) posting.delete(dayOf(at));
    }
    return [...posting].sort();
  } catch {
    return [];
  }
}

// What the command read of the org's week, for every recipient at once.
export interface DigestWeekData {
  // Every channel of the org, by id.
  channels: ReadonlyMap<string, { name: string; provider: string }>;
  // Last week's published channel posts (a channel taken down since still went out).
  published: readonly { variantId: string; postId: string; connectionId: string; text: string; removed: boolean; metrics: Readonly<Record<string, number>> | null }[];
  // Last week's failed or stuck channel posts.
  failures: readonly { variantId: string; postId: string; connectionId: string; text: string }[];
  // This week's planned channel posts, by the org's local day (YYYY-MM-DD).
  planned: readonly { connectionId: string; day: string }[];
  // The org's local days of this week, Monday first.
  days: readonly string[];
  // Each queue's empty posting days left this week.
  emptyDays: readonly { connectionId: string; days: readonly string[] }[];
}

export interface DigestReviewItem {
  postId: string;
  text: string;
}

export interface DigestLine {
  text: string;
  channel: string;
  postId: string;
}

// One member's digest, before the paths are added.
export interface DigestContent {
  last: {
    published: number;
    channels: { name: string; provider: string; published: number; failed: number }[];
    top: (DigestLine & { engagement: number })[];
    failures: { total: number; items: DigestLine[] };
  };
  next: {
    days: { date: string; planned: number }[];
    emptyQueueDays: { channel: string; dates: string[] }[];
  };
  // Only for those who may approve (owners and admins); null for the others.
  review: { total: number; items: DigestReviewItem[] } | null;
}

// A member's view of the week: only the channels they may use (null: every channel), and the posts waiting for their
// review when they may approve. Null when nothing in it is worth a mail.
export function digestFor(data: DigestWeekData, scope: ReadonlySet<string> | null, review: readonly DigestReviewItem[] | null): DigestContent | null {
  const may = (connectionId: string) => scope === null || scope.has(connectionId);
  const name = (connectionId: string) => data.channels.get(connectionId)?.name ?? '';
  const published = data.published.filter((p) => may(p.connectionId));
  const failures = data.failures.filter((f) => may(f.connectionId));
  const perChannel = new Map<string, { published: number; failed: number }>();
  for (const p of published) {
    const c = perChannel.get(p.connectionId) ?? { published: 0, failed: 0 };
    c.published += 1;
    perChannel.set(p.connectionId, c);
  }
  for (const f of failures) {
    const c = perChannel.get(f.connectionId) ?? { published: 0, failed: 0 };
    c.failed += 1;
    perChannel.set(f.connectionId, c);
  }
  const channels = [...perChannel]
    .map(([id, c]) => ({ name: name(id), provider: data.channels.get(id)?.provider ?? '', ...c }))
    .sort((a, b) => b.published - a.published || b.failed - a.failed || a.name.localeCompare(b.name, 'vi'))
    .slice(0, DIGEST_CHANNELS_MAX);
  // Posts still up, by engagement; a post with no engagement is no top post.
  const top = published
    .filter((p) => !p.removed && p.metrics)
    .map((p) => ({ text: p.text, channel: name(p.connectionId), postId: p.postId, engagement: engagementOf(p.metrics ?? {}), variantId: p.variantId }))
    .filter((p) => p.engagement > 0)
    .sort((a, b) => b.engagement - a.engagement || a.variantId.localeCompare(b.variantId))
    .slice(0, DIGEST_TOP)
    .map((p) => ({ text: p.text, channel: p.channel, postId: p.postId, engagement: p.engagement }));
  const plannedByDay = new Map<string, number>();
  for (const p of data.planned) if (may(p.connectionId)) plannedByDay.set(p.day, (plannedByDay.get(p.day) ?? 0) + 1);
  const days = data.days.map((date) => ({ date, planned: plannedByDay.get(date) ?? 0 }));
  const emptyQueueDays = data.emptyDays
    .filter((q) => may(q.connectionId) && q.days.length > 0)
    .map((q) => ({ channel: name(q.connectionId), dates: [...q.days] }))
    .sort((a, b) => a.channel.localeCompare(b.channel, 'vi'))
    .slice(0, DIGEST_CHANNELS_MAX);
  const reviews = review === null ? null : { total: review.length, items: review.slice(0, DIGEST_LIST_MAX).map((r) => ({ ...r })) };
  const planned = days.reduce((n, d) => n + d.planned, 0);
  if (published.length === 0 && failures.length === 0 && planned === 0 && emptyQueueDays.length === 0 && (reviews?.total ?? 0) === 0) return null;
  return {
    last: {
      published: published.length,
      channels,
      top,
      failures: { total: failures.length, items: failures.slice(0, DIGEST_LIST_MAX).map((f) => ({ text: f.text, channel: name(f.connectionId), postId: f.postId })) },
    },
    next: { days, emptyQueueDays },
    review: reviews,
  };
}
