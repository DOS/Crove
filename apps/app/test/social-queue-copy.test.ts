// Copying a queue to other channels (#1166): the slots copied, the count of queued posts each target places again
// (the placement `social.queue.set` runs), and one set per target with each outcome kept.
import { describe, expect, it } from 'vitest';
import { copyQueue, copySlots, replacedCount } from '../src/lib/social-queue-copy.ts';

const HCM = 'Asia/Ho_Chi_Minh';
const BKK = 'Asia/Bangkok';
const TOKYO = 'Asia/Tokyo';
const LABEL = '00000000-0000-4000-8000-00000000000a';
// Wednesday 2026-10-21 10:00 in Ho Chi Minh City.
const NOW = Date.parse('2026-10-21T03:00:00Z');
// Monday 09:00 and Wednesday 20:00, Ho Chi Minh City.
const MON_9 = '2026-10-26T02:00:00.000Z';
const WED_20 = '2026-10-21T13:00:00.000Z';
const v = (id: string, queueSlotAt: string | null, status = 'scheduled', connectionId = 'c1') => ({ id, connectionId, status, queueSlotAt });
const spec = (timeZone: string, slots: { weekday: number; minute: number; labelId?: string | null }[]) => ({ timeZone, slots });

describe('the slots a copy sends', () => {
  it('keeps each slot\'s label and content category, and only the slots the queue uses', () => {
    expect(
      copySlots([
        { weekday: 1, minute: 540, label: null, labelId: LABEL, active: true },
        { weekday: 3, minute: 1200, label: 'Tối', labelId: null, active: true },
        { weekday: 5, minute: 600, label: null, labelId: null, active: false },
      ]),
    ).toEqual([
      { weekday: 1, minute: 540, labelId: LABEL },
      { weekday: 3, minute: 1200, label: 'Tối' },
    ]);
  });
});

describe('queued posts a copy places again', () => {
  const before = spec(HCM, [
    { weekday: 1, minute: 540 },
    { weekday: 3, minute: 1200 },
  ]);

  it('counts the posts whose slot the new queue lacks', () => {
    const posts = [{ variants: [v('v1', MON_9), v('v2', WED_20)] }];
    expect(replacedCount(posts, 'c1', before, spec(HCM, [{ weekday: 1, minute: 540 }]), NOW).moved).toBe(1);
    expect(replacedCount(posts, 'c1', before, spec(HCM, [{ weekday: 1, minute: 540 }, { weekday: 3, minute: 1200 }, { weekday: 5, minute: 480 }]), NOW).moved).toBe(0);
    expect(replacedCount(posts, 'c1', before, spec(HCM, [{ weekday: 2, minute: 480 }]), NOW).moved).toBe(2);
  });

  it('leaves out other channels, freed slots, posts in flight and ones already due', () => {
    const posts = [
      { variants: [v('v1', MON_9, 'scheduled', 'c2'), v('v2', MON_9, 'published'), v('v3', WED_20, 'publishing'), v('v4', '2026-10-19T02:00:00.000Z'), v('v5', null)] },
      { variants: [v('v6', WED_20, 'in_review')] },
    ];
    // v6 waits for review in a slot the new queue lacks; v3 holds the same time in flight, so it is not v6's to keep.
    expect(replacedCount(posts, 'c1', before, spec(HCM, [{ weekday: 1, minute: 540 }]), NOW).moved).toBe(1);
  });

  it('moves a post out of a slot kept for a label it lacks', () => {
    const posts = [{ labelIds: [], variants: [v('v1', MON_9)] }, { labelIds: [LABEL], variants: [v('v2', WED_20)] }];
    const next = spec(HCM, [
      { weekday: 1, minute: 540, labelId: LABEL },
      { weekday: 3, minute: 1200, labelId: LABEL },
    ]);
    expect(replacedCount(posts, 'c1', before, next, NOW).moved).toBe(1);
  });

  it('counts the posts a time zone change moves to the same local clock time, as the set reports them', () => {
    const posts = [{ variants: [v('v1', MON_9), v('v2', WED_20)] }];
    // Bangkok has the same offset as Ho Chi Minh City: the instants stay.
    expect(replacedCount(posts, 'c1', before, spec(BKK, before.slots), NOW).moved).toBe(0);
    // Tokyo is two hours ahead: 09:00 and 20:00 there are other instants.
    expect(replacedCount(posts, 'c1', before, spec(TOKYO, before.slots), NOW).moved).toBe(2);
  });

  it('is nothing on a channel without a queue', () => {
    expect(replacedCount([{ variants: [v('v1', MON_9)] }], 'c1', null, spec(HCM, []), NOW).moved).toBe(0);
  });
});

describe('copying to the targets', () => {
  it('sets each target in turn and keeps every outcome', async () => {
    const calls: unknown[] = [];
    const results = await copyQueue(
      ['t1', 't2', 't3'],
      { timeZone: HCM, slots: [{ weekday: 1, minute: 540, labelId: LABEL }] },
      async (input) => {
        calls.push(input);
        if (input.connectionId === 't2') throw new Error('CHANNEL_NOT_FOUND');
        return { moved: input.connectionId === 't3' ? [{ at: MON_9 }, { at: null }, { at: WED_20 }] : [] };
      },
      (e) => (e as Error).message,
    );
    expect(calls).toEqual(['t1', 't2', 't3'].map((connectionId) => ({ connectionId, timeZone: HCM, slots: [{ weekday: 1, minute: 540, labelId: LABEL }] })));
    expect(results).toEqual([
      { connectionId: 't1', ok: true, moved: 0, unqueued: 0 },
      { connectionId: 't2', ok: false, message: 'CHANNEL_NOT_FOUND' },
      { connectionId: 't3', ok: true, moved: 2, unqueued: 1 },
    ]);
  });
});
