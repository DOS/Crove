// Posting queues: weekly slots in an IANA time zone (Social plan §3.2). Instants are epoch milliseconds; nothing
// here reads the clock, callers pass `now`. Rules (after TryPost's written rules):
// - a queued post keeps its slot while the slot still exists, and the queue is never repacked;
// - adding a post takes the first free slot after `now`;
// - posts waiting for approval hold their slots, so the caller counts them as taken;
// - after a time-zone change a post keeps the same local clock time (retime).

export interface Slot {
  // ISO weekday: 1 = Monday ... 7 = Sunday.
  weekday: number;
  // Minutes after local midnight, 0..1439.
  minute: number;
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

export function isValidTimeZone(timeZone: string): boolean {
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
  const slots = queue.slots.filter(validSlot);
  if (slots.length === 0 || toMs <= fromMs) return [];
  const out = new Set<number>();
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
      if (at > fromMs && at <= toMs) out.add(at);
    }
  }
  return [...out].sort((a, b) => a - b);
}

// Whether an instant is one of the queue's slot instants, with the same mapping as slotsBetween: a slot inside a
// forward DST gap is the instant after the gap, so a post placed there keeps its slot on the next placement.
export function isSlot(queue: QueueSpec, epochMs: number): boolean {
  if (epochMs % MINUTE !== 0) return false;
  return slotsBetween(queue, epochMs - MINUTE, epochMs).includes(epochMs);
}

// The first slot after `afterMs` that is not taken, within the horizon; null when the queue has no slot there.
export function nextFreeSlot(queue: QueueSpec, afterMs: number, taken: ReadonlySet<number>, horizonDays = 366): number | null {
  const chunk = 14 * DAY;
  const end = afterMs + horizonDays * DAY;
  for (let from = afterMs; from < end; from += chunk) {
    for (const at of slotsBetween(queue, from, Math.min(from + chunk, end))) {
      if (!taken.has(at)) return at;
    }
  }
  return null;
}

export interface QueuedPost {
  id: string;
  slotAt: number | null;
}

// Places a queue's posts after a change to the queue (slots edited, time zone changed) or when posts are added
// (slotAt null). A post keeps its slot when that slot still exists and is after `now`; the others take the first
// free slots, in their previous order. Nothing else moves. When two posts share a slot, the lower id keeps it.
// Posts that find no slot within the horizon get slotAt null. Callers pass only posts not yet handed to the
// publisher: a due post (slotAt <= now) passed here is moved like any other.
export function placeQueued(queue: QueueSpec, posts: readonly QueuedPost[], nowMs: number): QueuedPost[] {
  const kept = new Map<string, number>();
  const taken = new Set<number>();
  const byId = [...posts].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const p of byId) {
    if (p.slotAt !== null && p.slotAt > nowMs && isSlot(queue, p.slotAt) && !taken.has(p.slotAt)) {
      kept.set(p.id, p.slotAt);
      taken.add(p.slotAt);
    }
  }
  const moving = posts
    .filter((p) => !kept.has(p.id))
    .sort((a, b) => (a.slotAt ?? Infinity) - (b.slotAt ?? Infinity) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const placed = new Map<string, number | null>();
  for (const p of moving) {
    const at = nextFreeSlot(queue, nowMs, taken);
    if (at !== null) taken.add(at);
    placed.set(p.id, at);
  }
  return posts.map((p) => ({ id: p.id, slotAt: kept.get(p.id) ?? placed.get(p.id) ?? null }));
}

// The same local clock time in another zone, for a post when its queue's time zone changes.
export function retime(epochMs: number, fromZone: string, toZone: string): number {
  return zonedToEpoch(localTime(epochMs, fromZone), toZone);
}
