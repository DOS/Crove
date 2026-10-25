// The queue editor's helpers stop at the server's 100-slot limit (#1172).
import { describe, expect, it } from 'vitest';
import { SOCIAL_QUEUE_SLOTS_MAX } from '@crove/kernel-contract';
import { queueRoom, slotsToAdd } from '../src/lib/social-queue-slots.ts';

// n distinct slots: every day of the week, a minute apart.
const slots = (n: number) => Array.from({ length: n }, (_, i) => ({ weekday: (i % 7) + 1, minute: 600 + Math.floor(i / 7) }));
const everyDayAt = (minute: number) => [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, minute }));

describe('queue slots (#1172)', () => {
  it('is the limit social.queue.set takes', () => {
    expect(SOCIAL_QUEUE_SLOTS_MAX).toBe(100);
    expect(queueRoom(96)).toBe(4);
    expect(queueRoom(100)).toBe(0);
    expect(queueRoom(120)).toBe(0);
  });

  it('adds every day, or the suggestions, only up to 100 slots', () => {
    const queue = slots(96);
    const added = slotsToAdd(queue, everyDayAt(1200));
    expect(added).toEqual(everyDayAt(1200).slice(0, 4));
    const full = [...queue, ...added];
    expect(full).toHaveLength(100);
    expect(slotsToAdd(full, everyDayAt(1260))).toEqual([]);
    expect(slotsToAdd(full, [{ weekday: 1, minute: 0 }])).toEqual([]);
    // Five suggestions with room for two.
    const suggestions = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, minute: 1140, engagement: 3, posts: 6 }));
    expect(slotsToAdd(slots(98), suggestions)).toEqual(suggestions.slice(0, 2));
  });

  it('skips the slots the queue has and repeats, before counting the room', () => {
    const queue = slots(97);
    const extra = [queue[0] as { weekday: number; minute: number }, { weekday: 1, minute: 0 }, { weekday: 1, minute: 0 }, { weekday: 2, minute: 0 }, { weekday: 3, minute: 0 }, { weekday: 4, minute: 0 }];
    expect(slotsToAdd(queue, extra)).toEqual([
      { weekday: 1, minute: 0 },
      { weekday: 2, minute: 0 },
      { weekday: 3, minute: 0 },
    ]);
    expect(slotsToAdd([], everyDayAt(540))).toEqual(everyDayAt(540));
  });
});
