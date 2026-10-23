// Day arithmetic of the Social calendar (#580), in the browser's time zone, kept apart from the screen so it can be
// tested without one.
import type { client } from './api.ts';
import type { VariantStatus } from './social.ts';

export type CalendarPost = Awaited<ReturnType<typeof client.social.posts.list>>[number];
type Post = CalendarPost;
type Variant = Post['variants'][number];
export type View = 'month' | 'week';
export interface CalendarItem {
  post: Post;
  v: Variant;
  at: Date;
  // A draft's planned time, not yet a schedule.
  planned: boolean;
}

export const DAY_MS = 86_400_000;
// What the calendar shows a channel at: its schedule, its publish time, or the post's planned time while it is not
// scheduled yet. Cancelled channels are left out; a channel removed from its platform (#860) stays at its publish time.
const SHOWN: readonly VariantStatus[] = ['draft', 'in_review', 'changes_requested', 'approved', 'scheduled', 'paused', 'publishing', 'processing', 'published', 'failed', 'ambiguous', 'needs_attention', 'removed'];
const PLANNED: readonly VariantStatus[] = ['draft', 'in_review', 'changes_requested', 'approved'];

export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds());
}

// Monday of the week the day is in (weeks start on Monday, as in Vietnam).
export function startOfWeek(d: Date): Date {
  const day = startOfDay(d);
  return addDays(day, -((day.getDay() + 6) % 7));
}

// The days a view shows: six weeks from the Monday on or before the 1st, or the seven days of the week.
export function viewDays(view: View, anchor: Date): Date[] {
  const first = view === 'month' ? startOfWeek(new Date(anchor.getFullYear(), anchor.getMonth(), 1)) : startOfWeek(anchor);
  return Array.from({ length: view === 'month' ? 42 : 7 }, (_, i) => addDays(first, i));
}

export const dayId = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// The same time of day on another day, for a drop; with an hour (a drop on the week view's hours), at that hour and
// the same minutes.
export function onDay(at: Date, day: Date, hour?: number): Date {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour ?? at.getHours(), at.getMinutes());
}

// When a post with no time yet is planned on a day (a new post from the day's +, an undated draft dropped there,
// #1145): at the hour given, else 09:00, and today after 09:00 at the next full hour. null when that time is gone: a
// past day, an hour already gone, or today after 23:00.
export function plannedAt(day: Date, now: Date, hour?: number): Date | null {
  const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour ?? 9, 0);
  if (at.getTime() > now.getTime()) return at;
  if (hour !== undefined) return null;
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours() + 1, 0);
  return dayId(next) === dayId(day) ? next : null;
}

// The hours the week view offers as drop targets while something is dragged (#1145); other hours are set from the
// chip's menu.
export const DROP_HOURS: readonly number[] = Array.from({ length: 18 }, (_, i) => i + 6);

// Whether a draft sits on the calendar at its post's planned time, so moving it moves that time (social.post.update,
// #1145). A channel sent back to review with a time of its own keeps that time and does not move this way.
// A draft being planned (#1145): its post, with the revision the viewer saw, and its planned time (null: undated).
export interface PlanTarget {
  post: { id: string; revision: number };
  at: Date | null;
}
export interface PlanRequest {
  postId: string;
  revision: number;
  scheduledAt: string;
}

// What dropping a draft on a day asks of social.post.update: an undated draft at plannedAt, a planned one at the same
// time of day (or the hour dropped on). 'past' when that time is gone, refused here with nothing sent; null when the
// time would not change.
export function planDrop(target: PlanTarget, day: Date, now: Date, hour?: number): PlanRequest | 'past' | null {
  const at = target.at ? onDay(target.at, day, hour) : plannedAt(day, now, hour);
  if (at === null || at.getTime() <= now.getTime()) return 'past';
  if (target.at && at.getTime() === target.at.getTime()) return null;
  return { postId: target.post.id, revision: target.post.revision, scheduledAt: at.toISOString() };
}

// A local date (YYYY-MM-DD) and time (HH:mm) from the date and time inputs, as a moment; null when either is missing.
export function localMoment(date: string, time: string): Date | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const t = /^(\d{2}):(\d{2})$/.exec(time);
  if (!d || !t) return null;
  return new Date(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2]));
}

export const followsPlan = (item: CalendarItem): boolean =>
  item.planned && item.post.scheduledAt !== null && item.v.effectiveAt !== null && Date.parse(item.v.effectiveAt) === Date.parse(item.post.scheduledAt);

// The notes (#794) on each day a view shows: a note covers every day from its start to its end, both included.
export function notesByDay<N extends { startsOn: string; endsOn: string }>(notes: readonly N[], days: readonly Date[]): Map<string, N[]> {
  const map = new Map<string, N[]>();
  for (const d of days) {
    const id = dayId(d);
    const on = notes.filter((n) => n.startsOn <= id && id <= n.endsOn);
    if (on.length > 0) map.set(id, on);
  }
  return map;
}

export function calendarItems(posts: readonly Post[]): CalendarItem[] {
  return posts
    .flatMap((post) =>
      post.variants
        .filter((v) => SHOWN.includes(v.status))
        .flatMap((v) => {
          // effectiveAt falls back to the post's planned time for a channel with none of its own (a draft); a channel
          // sent back to review keeps its own time.
          const planned = PLANNED.includes(v.status);
          const when = v.effectiveAt ?? (planned ? post.scheduledAt : null);
          return when ? [{ post, v, at: new Date(when), planned }] : [];
        }),
    )
    .sort((a, b) => a.at.getTime() - b.at.getTime());
}

