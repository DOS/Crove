// The queue editor's helpers (#1172): "Thêm", "Thêm cho mọi ngày" and the best-time suggestions add slots only while the
// queue has room, up to the limit social.queue.set takes (SOCIAL_QUEUE_SLOTS_MAX), so a draft never fails on save for it.
import { SOCIAL_QUEUE_SLOTS_MAX } from '@crove/kernel-contract';

type At = { weekday: number; minute: number };

// The room left in a queue of this many slots; 0 when it is full.
export function queueRoom(count: number): number {
  return Math.max(0, SOCIAL_QUEUE_SLOTS_MAX - count);
}

// The slots of `extra` the queue does not have yet (each once), in order, as many as it has room for.
export function slotsToAdd<T extends At>(current: readonly At[], extra: readonly T[]): T[] {
  const taken = new Set(current.map((s) => `${s.weekday}:${s.minute}`));
  const fresh: T[] = [];
  for (const slot of extra) {
    const key = `${slot.weekday}:${slot.minute}`;
    if (taken.has(key)) continue;
    taken.add(key);
    fresh.push(slot);
  }
  return fresh.slice(0, queueRoom(current.length));
}
