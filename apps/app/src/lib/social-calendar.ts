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

// The same time of day on another day, for a drop.
export function onDay(at: Date, day: Date): Date {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), at.getHours(), at.getMinutes());
}

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

