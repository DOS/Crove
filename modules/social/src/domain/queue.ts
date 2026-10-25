// Posting queues: weekly slots in an IANA time zone (Social plan §3.2). Instants are epoch milliseconds; nothing
// here reads the clock, callers pass `now`. Rules (after TryPost's written rules):
// - a queued post keeps its slot while the slot still exists, and the queue is never repacked;
// - adding a post takes the first free slot after `now`;
// - posts waiting for approval hold their slots, so the caller counts them as taken;
// - after a time-zone change a post keeps the same local clock time (retime);
// - a slot may belong to a content category, a post label (#745): it is kept for posts with that label, which take
//   the next free slot of their labels first and then an open one (no label); other posts take open slots only;
// - reordering a queue (shuffle, move to the front, #1020) only trades the times posts already hold: no slot is made or
//   dropped, and a post takes another's time only when it may use that slot.

export interface Slot {
  // ISO weekday: 1 = Monday ... 7 = Sunday.
  weekday: number;
  // Minutes after local midnight, 0..1439.
  minute: number;
  // The post label this slot is kept for (#745); none: open to every post.
  labelId?: string | null;
}

export interface QueueSpec {
  timeZone: string;
  slots: readonly Slot[];
}

export interface LocalTime {
  year: number;
  month: number; // 1..12
  day: number;
  hour: number;
  minute: number;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * 60 * MINUTE;
const WEEKDAYS: Readonly<Record<string, number>> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    // Throws RangeError for an unknown zone, which is the check isValidTimeZone relies on.
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      weekday: 'short',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

// An IANA zone name the runtime knows (UTC, or Area/Location), never an offset like +07:00: an offset has no
// daylight-saving rules, so a schedule in it would drift for half the year in a zone that has them (#850). The name is
// kept as given: the runtime spells some zones by their old names (Asia/Saigon for Asia/Ho_Chi_Minh), which the app's
// lists do not show.
const ZONE_NAME = /^(?:UTC|[A-Za-z][A-Za-z_]*(?:\/[A-Za-z0-9_+-]+)+)$/;
export function isValidTimeZone(timeZone: string): boolean {
  if (timeZone.length > 64 || !ZONE_NAME.test(timeZone)) return false;
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

export function validSlot(slot: Slot): boolean {
  return Number.isInteger(slot.weekday) && slot.weekday >= 1 && slot.weekday <= 7 && Number.isInteger(slot.minute) && slot.minute >= 0 && slot.minute < 1440;
}

export function localTime(epochMs: number, timeZone: string): LocalTime & { weekday: number } {
  const parts: Record<string, string> = {};
  for (const p of formatter(timeZone).formatToParts(epochMs)) parts[p.type] = p.value;
  const weekday = WEEKDAYS[parts.weekday ?? ''];
  if (weekday === undefined) throw new Error(`unexpected weekday from Intl: ${parts.weekday}`);
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    weekday,
  };
}

// The zone's offset from UTC at an instant, in milliseconds (local = utc + offset), to the minute.
function offsetAt(epochMs: number, timeZone: string): number {
  const l = localTime(epochMs, timeZone);
  const asUtc = Date.UTC(l.year, l.month - 1, l.day, l.hour, l.minute);
  return asUtc - Math.floor(epochMs / MINUTE) * MINUTE;
}

// The instant a local wall-clock time names in a zone. A time skipped by a forward DST change maps to the instant
// the same distance after the change; a repeated time (backward change) maps to its first occurrence.
export function zonedToEpoch(local: LocalTime, timeZone: string): number {
  const guess = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
  // The zone's offsets on either side of this local time; zones change offset at most once in such a window.
  const candidates = [...new Set([offsetAt(guess - 14 * HOUR, timeZone), offsetAt(guess + 14 * HOUR, timeZone)])].map((o) => guess - o);
  const valid = candidates.filter((t) => sameLocal(localTime(t, timeZone), local));
  if (valid.length > 0) return Math.min(...valid);
  // Skipped time: reading it with the offset from before the change lands the same distance after the change.
  return Math.max(...candidates);
}

function sameLocal(a: LocalTime, b: LocalTime): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day && a.hour === b.hour && a.minute === b.minute;
}

// Slot instants in (fromMs, toMs], ascending, without duplicates.
export function slotsBetween(queue: QueueSpec, fromMs: number, toMs: number): number[] {
  return slotEntriesBetween(queue, fromMs, toMs).map((e) => e.at);
}

// The same instants, each with the label its slot is kept for (an instant two slots map to is open if either is).
export function slotEntriesBetween(queue: QueueSpec, fromMs: number, toMs: number): { at: number; labelId: string | null }[] {
  const slots = queue.slots.filter(validSlot);
  if (slots.length === 0 || toMs <= fromMs) return [];
  const out = new Map<number, string | null>();
  const start = localTime(fromMs, queue.timeZone);
  // Walk local calendar days with UTC date arithmetic (day numbers only, no zone involved).
  let day = Date.UTC(start.year, start.month - 1, start.day);
  const lastDay = toMs + 2 * DAY;
  for (; day <= lastDay; day += DAY) {
    const d = new Date(day);
    const weekday = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
    for (const slot of slots) {
      if (slot.weekday !== weekday) continue;
      const at = zonedToEpoch(
        { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: Math.floor(slot.minute / 60), minute: slot.minute % 60 },
        queue.timeZone,
      );
      if (at > fromMs && at <= toMs) {
        const label = slot.labelId ?? null;
        out.set(at, out.has(at) && (out.get(at) === null || label === null) ? null : label);
      }
    }
  }
  return [...out].map(([at, labelId]) => ({ at, labelId })).sort((a, b) => a.at - b.at);
}

// Whether a post with these labels may take a slot kept for this label.
const fits = (slotLabel: string | null, labels: ReadonlySet<string>) => slotLabel === null || labels.has(slotLabel);

// Whether an instant is one of the queue's slot instants, with the same mapping as slotsBetween: a slot inside a
// forward DST gap is the instant after the gap, so a post placed there keeps its slot on the next placement.
export function isSlot(queue: QueueSpec, epochMs: number): boolean {
  if (epochMs % MINUTE !== 0) return false;
  return slotsBetween(queue, epochMs - MINUTE, epochMs).includes(epochMs);
}

// The first slot after `afterMs` that is not taken, within the horizon, for a post with these labels: the first free
// slot kept for one of its labels, else the first free open slot; null when the queue has none there.
export function nextFreeSlot(queue: QueueSpec, afterMs: number, taken: ReadonlySet<number>, horizonDays = 366, labels: ReadonlySet<string> = new Set()): number | null {
  const chunk = 14 * DAY;
  const end = afterMs + horizonDays * DAY;
  const pass = (want: (label: string | null) => boolean) => {
    for (let from = afterMs; from < end; from += chunk) {
      for (const e of slotEntriesBetween(queue, from, Math.min(from + chunk, end))) {
        if (!taken.has(e.at) && want(e.labelId)) return e.at;
      }
    }
    return null;
  };
  if (labels.size > 0 && queue.slots.some((s) => s.labelId && labels.has(s.labelId))) {
    const own = pass((label) => label !== null && labels.has(label));
    if (own !== null) return own;
  }
  return pass((label) => label === null);
}

// The label of the slot an instant is (null: open, undefined: not a slot).
export function slotLabel(queue: QueueSpec, epochMs: number): string | null | undefined {
  if (epochMs % MINUTE !== 0) return undefined;
  const e = slotEntriesBetween(queue, epochMs - MINUTE, epochMs).find((x) => x.at === epochMs);
  return e ? e.labelId : undefined;
}

// The open slots of a queue in (fromMs, toMs] (#1158): its slot instants no post holds, each with the label it is kept
// for, in time order, at most `limit` of them.
export function openSlots(queue: QueueSpec, fromMs: number, toMs: number, taken: ReadonlySet<number>, limit: number): { at: number; labelId: string | null }[] {
  const out: { at: number; labelId: string | null }[] = [];
  for (const e of slotEntriesBetween(queue, fromMs, toMs)) {
    if (out.length >= limit) break;
    if (!taken.has(e.at)) out.push(e);
  }
  return out;
}

// Why a post with these labels may not take one exact slot of the queue (#1158), the calendar's drop on an open slot;
// null when it may. The slot must be one of the queue's instants after now within the horizon nextFreeSlot looks at,
// held by no other post, and open or kept for one of the post's labels (#745).
export type SlotRefusal = 'not_in_queue' | 'past' | 'taken' | 'label';
export function slotRefusal(queue: QueueSpec, atMs: number, nowMs: number, taken: ReadonlySet<number>, labels: ReadonlySet<string>, horizonDays = 366): SlotRefusal | null {
  const label = slotLabel(queue, atMs);
  if (label === undefined || atMs > nowMs + horizonDays * DAY) return 'not_in_queue';
  if (atMs <= nowMs) return 'past';
  if (taken.has(atMs)) return 'taken';
  if (!fits(label, labels)) return 'label';
  return null;
}

export interface QueuedPost {
  id: string;
  slotAt: number | null;
  // The post's labels (#745), for slots kept for a label.
  labelIds?: readonly string[];
}

// Places a queue's posts after a change to the queue (slots edited, time zone changed) or when posts are added
// (slotAt null). A post keeps its slot when that slot still exists and is after `now`; the others take the first
// free slots, in their previous order. Nothing else moves. When two posts share a slot, the lower id keeps it.
// Posts that find no slot within the horizon get slotAt null. Callers pass only posts not yet handed to the
// publisher: a due post (slotAt <= now) passed here is moved like any other. `reserved` are slots held by posts that
// are not placed here (in flight): nobody keeps or takes them.
export function placeQueued(queue: QueueSpec, posts: readonly QueuedPost[], nowMs: number, reserved: ReadonlySet<number> = new Set()): QueuedPost[] {
  const kept = new Map<string, number>();
  const taken = new Set<number>(reserved);
  const byId = [...posts].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const p of byId) {
    const label = p.slotAt === null ? undefined : slotLabel(queue, p.slotAt);
    if (p.slotAt !== null && p.slotAt > nowMs && label !== undefined && fits(label, new Set(p.labelIds ?? [])) && !taken.has(p.slotAt)) {
      kept.set(p.id, p.slotAt);
      taken.add(p.slotAt);
    }
  }
  const moving = posts
    .filter((p) => !kept.has(p.id))
    .sort((a, b) => (a.slotAt ?? Infinity) - (b.slotAt ?? Infinity) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const placed = new Map<string, number | null>();
  for (const p of moving) {
    const at = nextFreeSlot(queue, nowMs, taken, 366, new Set(p.labelIds ?? []));
    if (at !== null) taken.add(at);
    placed.set(p.id, at);
  }
  return posts.map((p) => ({ id: p.id, slotAt: kept.get(p.id) ?? placed.get(p.id) ?? null }));
}

// Reordering (#1020). A holder is a post that may move, at the slot time it holds now; `fits` says whether it may take
// a time (the slot's label, the post's planned takedown). Both functions return each holder's new time; the times
// handed out are exactly the times the holders held, each once.
export interface Holder {
  id: string;
  at: number;
}

const inTimeOrder = <T extends Holder>(holders: readonly T[]) => [...holders].sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

// Shuffles the holders' times (Sattolo's algorithm over the holders in time order): each holder in turn trades times with
// one before it, picked by `random` (in [0, 1), as Math.random; tests pass their own), when both may take the other's
// time. With no kept slots in the way every post ends at another time; a post nobody may trade with keeps its own.
// Kept slots can refuse every trade a pass picks (posts with a label between posts without, #1412), so a pass that moved
// nothing is drawn again, up to SHUFFLE_PASSES times: a shuffle the member asked for moves something whenever a trade is
// possible at all, and the order stays as it was only when none is.
const SHUFFLE_PASSES = 20;

export function shuffleTimes<T extends Holder>(holders: readonly T[], fits: (holder: T, at: number) => boolean, random: () => number = Math.random): Map<string, number> {
  const order = inTimeOrder(holders);
  for (let pass = 1; ; pass++) {
    const times = order.map((h) => h.at);
    let traded = false;
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.min(i - 1, Math.floor(random() * i));
      const a = order[i] as T;
      const b = order[j] as T;
      const [ta, tb] = [times[i] as number, times[j] as number];
      if (fits(a, tb) && fits(b, ta)) {
        times[i] = tb;
        times[j] = ta;
        traded = true;
      }
    }
    if (traded || pass >= SHUFFLE_PASSES) return new Map(order.map((h, k) => [h.id, times[k] as number]));
  }
}

// Moves one holder to the front: it takes the earliest time it can reach, and each holder it passes moves one place
// later, to the time the moving post had just left. A holder that may not take that time stays where it is and the
// moving post passes it by; so with no kept slots in the way the post takes the first time and the others shift by one.
export function moveToFront<T extends Holder>(holders: readonly T[], targetId: string, fits: (holder: T, at: number) => boolean): Map<string, number> {
  const order = inTimeOrder(holders);
  const result = new Map(order.map((h) => [h.id, h.at]));
  let cur = order.findIndex((h) => h.id === targetId);
  const target = order[cur];
  if (!target) return result;
  for (let i = cur - 1; i >= 0; i--) {
    const other = order[i] as T;
    if (fits(target, other.at) && fits(other, (order[cur] as T).at)) {
      result.set(other.id, (order[cur] as T).at);
      cur = i;
    }
  }
  result.set(target.id, (order[cur] as T).at);
  return result;
}

// How far ahead a queue is filled (#1079), for the warning when it runs low. Its posting days are the local calendar
// days (in the queue's zone) that have one of its slots in (now, now + days * 24h]; a posting day is filled when a post
// holds one of its slots there. Days without a slot (a queue that posts on weekdays only) are never counted against it.
// The queue is low when a posting day ahead is not filled; a queue with no slot in the window is never low.
export interface QueueRunway {
  postingDays: number;
  filledDays: number;
  low: boolean;
}

export function queueRunway(queue: QueueSpec, taken: Iterable<number>, nowMs: number, days: number): QueueRunway {
  const end = nowMs + days * DAY;
  const dayOf = (at: number) => {
    const l = localTime(at, queue.timeZone);
    return `${l.year}-${l.month}-${l.day}`;
  };
  const posting = new Set(slotsBetween(queue, nowMs, end).map(dayOf));
  const filled = new Set<string>();
  for (const at of taken) {
    if (at <= nowMs || at > end) continue;
    const day = dayOf(at);
    if (posting.has(day)) filled.add(day);
  }
  return { postingDays: posting.size, filledDays: filled.size, low: filled.size < posting.size };
}

// The same local clock time in another zone, for a post when its queue's time zone changes.
export function retime(epochMs: number, fromZone: string, toZone: string): number {
  return zonedToEpoch(localTime(epochMs, fromZone), toZone);
}
