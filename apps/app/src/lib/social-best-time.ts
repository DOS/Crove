// "Giờ đẹp" next to a channel's time picker (#980): the channel's best weekday-and-hour slots from its history
// (bestTimes, the same ranking as the Metrics tab's card), each turned into the next time it comes round in the post's
// time zone, so a click sets the picker to it. Pure: callers pass `now` and the times already taken.
import { bestTimes, localTime, zonedToEpoch, type BestTime, type PublishedSample } from '@crove/mod-social/contract';

// Posts with metrics a channel needs before it gets suggestions: bestTimes' own default, passed explicitly so the
// button's rule and the ranking cannot drift apart.
export const BEST_TIME_MIN_POSTS = 5;
// The history the suggestions read: the Metrics tab's widest window.
export const BEST_TIME_DAYS = 90;
// A suggestion this close to now would be gone before the post is scheduled.
export const BEST_TIME_LEAD_MS = 15 * 60_000;
export const BEST_TIME_MAX = 3;
// Weeks a slot is looked at ahead before it is given up because every one of them is taken.
const WEEKS_AHEAD = 8;
const HOUR = 3_600_000;
const DAY = 86_400_000;
// Variants that go out at their effective time: another post of the channel is there already.
const GOING_OUT: ReadonlySet<string> = new Set(['scheduled', 'publishing', 'processing']);

// The zone if the runtime knows it, else the fallback (a post saved with a zone this browser lacks).
export function knownZone(timeZone: string | null | undefined, fallback = 'UTC'): string {
  if (timeZone) {
    try {
      localTime(0, timeZone);
      return timeZone;
    } catch {
      // Unknown here: the fallback.
    }
  }
  return fallback;
}

// The first instant at or after fromMs whose local time in the zone is that weekday (1 Monday ... 7 Sunday) at
// hour:00. Days are walked as local calendar days and each candidate goes through zonedToEpoch, so a slot keeps its
// clock time across a DST change; an hour a forward change skips lands just after the change, as queue slots do.
export function nextOccurrence(weekday: number, hour: number, timeZone: string, fromMs: number): number {
  const start = localTime(fromMs, timeZone);
  const first = Date.UTC(start.year, start.month - 1, start.day);
  // Day 7 is the same weekday as day 0 a week later, so the loop always finds one.
  for (let i = 0; i <= 7; i++) {
    const d = new Date(first + i * DAY);
    if ((d.getUTCDay() === 0 ? 7 : d.getUTCDay()) !== weekday) continue;
    const at = zonedToEpoch({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour, minute: 0 }, timeZone);
    if (at >= fromMs) return at;
  }
  throw new Error(`no weekday ${weekday} within a week`);
}

export interface BestTimeSuggestion extends BestTime {
  // The instant to set, epoch milliseconds.
  at: number;
}

export interface SuggestOptions {
  timeZone: string;
  nowMs: number;
  // Instants other posts of the channel go out at: a slot hour holding one is skipped for the week after.
  taken?: readonly number[];
  leadMs?: number;
  max?: number;
}

// Up to `max` suggestions, best slot first: each slot's next occurrence at least leadMs from now whose hour no other
// post of the channel takes, else the same slot a week later (up to WEEKS_AHEAD weeks).
export function suggestBestTimes(slots: readonly BestTime[], options: SuggestOptions): BestTimeSuggestion[] {
  const taken = options.taken ?? [];
  const max = options.max ?? BEST_TIME_MAX;
  const from = options.nowMs + (options.leadMs ?? BEST_TIME_LEAD_MS);
  const chosen = new Set<number>();
  const busy = (at: number) => chosen.has(at) || taken.some((t) => t >= at && t < at + HOUR);
  const out: BestTimeSuggestion[] = [];
  for (const slot of slots) {
    if (out.length >= max) break;
    let at = nextOccurrence(slot.weekday, slot.hour, options.timeZone, from);
    for (let week = 1; week < WEEKS_AHEAD && busy(at); week++) at = nextOccurrence(slot.weekday, slot.hour, options.timeZone, at + 1);
    if (busy(at)) continue;
    chosen.add(at);
    out.push({ ...slot, at });
  }
  return out;
}

export type ChannelBestTimes = { state: 'few'; posts: number } | { state: 'none' } | { state: 'ready'; slots: BestTime[] };

// One channel's ranked slots from the org's published samples, or why there are none: too few posts with metrics
// (the button says so), or enough posts but no slot that stands out.
export function channelBestTimes(samples: readonly PublishedSample[], connectionId: string, timeZone: string): ChannelBestTimes {
  const own = samples.filter((s) => s.connectionId === connectionId);
  const posts = own.filter((s) => s.publishedAt && Object.keys(s.metrics).length > 0).length;
  if (posts < BEST_TIME_MIN_POSTS) return { state: 'few', posts };
  const slots = bestTimes(own, timeZone, { minPostsPerChannel: BEST_TIME_MIN_POSTS, top: BEST_TIME_MAX }).get(connectionId) ?? [];
  return slots.length > 0 ? { state: 'ready', slots } : { state: 'none' };
}

interface ListedVariant {
  id: string;
  connectionId: string;
  status: string;
  effectiveAt: string | null;
}

// The posts in cached list answers (plain lists and infinite pages), read defensively: the cache holds whatever the
// screens loaded, so this adds no request.
export function listedPosts(cached: readonly unknown[]): { variants: ListedVariant[] }[] {
  const out: { variants: ListedVariant[] }[] = [];
  const take = (list: unknown) => {
    if (!Array.isArray(list)) return;
    for (const p of list) if (p && typeof p === 'object' && Array.isArray((p as { variants?: unknown }).variants)) out.push(p as { variants: ListedVariant[] });
  };
  for (const data of cached) {
    if (Array.isArray(data)) take(data);
    else if (data && typeof data === 'object' && Array.isArray((data as { pages?: unknown }).pages)) for (const page of (data as { pages: unknown[] }).pages) take(page);
  }
  return out;
}

// When the channel's other posts go out, from what is at hand, leaving out the variant being scheduled.
export function takenTimes(posts: readonly { variants: readonly ListedVariant[] }[], connectionId: string, exceptVariantId?: string | null): number[] {
  const seen = new Map<string, number>();
  for (const p of posts) {
    for (const v of p.variants) {
      if (v.connectionId !== connectionId || v.id === exceptVariantId || !GOING_OUT.has(v.status) || !v.effectiveAt) continue;
      const at = Date.parse(v.effectiveAt);
      if (!Number.isNaN(at)) seen.set(v.id, at);
    }
  }
  return [...seen.values()];
}
