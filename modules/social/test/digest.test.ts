// The weekly digest's pure parts (#1104): a queue's empty posting days, and one member's view of the week.
import { describe, expect, it } from 'vitest';
import { digestFor, emptyQueueDays, zonedToEpoch, type DigestWeekData } from '../src/index.ts';

const HCM = 'Asia/Ho_Chi_Minh';
const at = (day: number, hour: number) => zonedToEpoch({ year: 2026, month: 10, day, hour, minute: 0 }, HCM);

describe('empty queue days (#1104)', () => {
  // Mondays, Wednesdays and Fridays at 09:00; the week of Monday 26 October 2026.
  const queue = { timeZone: HCM, slots: [1, 3, 5].map((weekday) => ({ weekday, minute: 9 * 60 })) };

  it('lists the posting days left with no post, in the queue zone', () => {
    expect(emptyQueueDays(queue, [], at(26, 8), at(26, 8) + 7 * 86_400_000 - 1)).toEqual(['2026-10-26', '2026-10-28', '2026-10-30']);
    expect(emptyQueueDays(queue, [at(28, 9)], at(26, 8), at(26, 8) + 7 * 86_400_000 - 1)).toEqual(['2026-10-26', '2026-10-30']);
    // Past slots are not counted, nor posts outside the window.
    expect(emptyQueueDays(queue, [at(23, 9)], at(26, 10), at(29, 0))).toEqual(['2026-10-28']);
  });

  it('has none for a queue whose zone is unknown', () => {
    expect(emptyQueueDays({ ...queue, timeZone: 'Mars/Olympus' }, [], at(26, 8), at(30, 0))).toEqual([]);
  });
});

describe("a member's digest (#1104)", () => {
  const A = 'a0000000-0000-7000-8000-000000000001';
  const B = 'b0000000-0000-7000-8000-000000000002';
  const data: DigestWeekData = {
    channels: new Map([
      [A, { name: 'Kênh A', provider: 'facebook' }],
      [B, { name: 'Kênh B', provider: 'threads' }],
    ]),
    published: [
      { variantId: 'v1', postId: 'p1', connectionId: A, text: 'A ít', removed: false, metrics: { reactions: 1 } },
      { variantId: 'v2', postId: 'p2', connectionId: B, text: 'B nhiều', removed: false, metrics: { reactions: 90, comments: 10, impressions: 100000 } },
      { variantId: 'v3', postId: 'p3', connectionId: A, text: 'A vừa', removed: false, metrics: { shares: 5 } },
      { variantId: 'v4', postId: 'p4', connectionId: A, text: 'A đã gỡ', removed: true, metrics: { reactions: 500 } },
      { variantId: 'v5', postId: 'p5', connectionId: A, text: 'A chưa có số', removed: false, metrics: null },
      { variantId: 'v6', postId: 'p6', connectionId: B, text: 'B khá', removed: false, metrics: { saves: 20 } },
    ],
    failures: [{ variantId: 'f1', postId: 'p7', connectionId: B, text: 'B lỗi' }],
    planned: [
      { connectionId: A, day: '2026-10-27' },
      { connectionId: B, day: '2026-10-27' },
      { connectionId: B, day: '2026-10-29' },
    ],
    days: ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01'],
    emptyDays: [{ connectionId: B, days: ['2026-10-28'] }],
  };

  it('ranks the top three still up by engagement, and counts every channel for an unlimited member', () => {
    const d = digestFor(data, null, null);
    expect(d?.last.published).toBe(6);
    expect(d?.last.top.map((t) => [t.text, t.engagement])).toEqual([
      ['B nhiều', 100],
      ['B khá', 20],
      ['A vừa', 5],
    ]);
    expect(d?.last.channels).toEqual([
      { name: 'Kênh A', provider: 'facebook', published: 4, failed: 0 },
      { name: 'Kênh B', provider: 'threads', published: 2, failed: 1 },
    ]);
    expect(d?.next.days.filter((x) => x.planned > 0)).toEqual([
      { date: '2026-10-27', planned: 2 },
      { date: '2026-10-29', planned: 1 },
    ]);
    expect(d?.next.emptyQueueDays).toEqual([{ channel: 'Kênh B', dates: ['2026-10-28'] }]);
    expect(d?.review).toBeNull();
  });

  it('leaves other channels out for a limited member', () => {
    const d = digestFor(data, new Set([A]), null);
    expect(d?.last.published).toBe(4);
    expect(d?.last.top.map((t) => t.text)).toEqual(['A vừa', 'A ít']);
    expect(d?.last.failures).toEqual({ total: 0, items: [] });
    expect(d?.next.days.reduce((n, x) => n + x.planned, 0)).toBe(1);
    expect(d?.next.emptyQueueDays).toEqual([]);
    expect(JSON.stringify(d)).not.toContain('Kênh B');
  });

  it('carries the reviews of an approver, and nothing when the member has nothing to read', () => {
    expect(digestFor(data, null, [{ postId: 'p9', text: 'Chờ duyệt' }])?.review).toEqual({ total: 1, items: [{ postId: 'p9', text: 'Chờ duyệt' }] });
    const empty: DigestWeekData = { ...data, published: [], failures: [], planned: [], emptyDays: [] };
    expect(digestFor(empty, null, null)).toBeNull();
    expect(digestFor(empty, null, [])).toBeNull();
    expect(digestFor(empty, null, [{ postId: 'p9', text: 'Chờ duyệt' }])).not.toBeNull();
    expect(digestFor(data, new Set(['c0000000-0000-7000-8000-000000000003']), null)).toBeNull();
  });
});
