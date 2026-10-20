import { describe, expect, it } from 'vitest';
import { gridItems, swapTimes } from '../src/lib/social-grid.ts';

type Post = Parameters<typeof gridItems>[0][number];
type Variant = Post['variants'][number];

const IG = 'conn-ig';
const image = [{ fileId: 'f', mime: 'image/jpeg' }];
const variant = (id: string, status: string, at: string | null, over: Partial<Record<string, unknown>> = {}) =>
  ({ id, connectionId: IG, status, effectiveAt: status === 'published' ? null : at, publishedAt: status === 'published' ? at : null, media: image, settings: {}, queuePaused: false, ...over }) as unknown as Variant;
const post = (id: string, variants: Variant[], scheduledAt: string | null = null) => ({ id, scheduledAt, variants }) as unknown as Post;

describe('Instagram grid preview (#795)', () => {
  it('puts posts to come ahead of the ones out, newest first, and leaves out Stories, other channels and text', () => {
    const items = gridItems(
      [
        post('p1', [variant('out-old', 'published', '2026-10-01T02:00:00.000Z')]),
        post('p2', [variant('out-new', 'published', '2026-10-20T02:00:00.000Z')]),
        post('p3', [variant('next', 'scheduled', '2026-10-25T02:00:00.000Z')]),
        post('p4', [variant('draft', 'draft', null)], '2026-11-02T02:00:00.000Z'),
        post('p5', [variant('story', 'scheduled', '2026-10-26T02:00:00.000Z', { settings: { postType: 'story' } })]),
        post('p6', [variant('other', 'scheduled', '2026-10-27T02:00:00.000Z', { connectionId: 'conn-fb' })]),
        post('p7', [variant('text', 'scheduled', '2026-10-28T02:00:00.000Z', { media: [] })]),
        post('p8', [variant('gone', 'failed', '2026-10-29T02:00:00.000Z')]),
      ],
      IG,
    );
    expect(items.map((i) => [i.v.id, i.upcoming])).toEqual([
      ['draft', true],
      ['next', true],
      ['out-new', false],
      ['out-old', false],
    ]);
  });

  it('swaps the times of two scheduled posts only', () => {
    const [a, b, draft, out] = gridItems(
      [
        post('p1', [variant('a', 'scheduled', '2026-10-25T02:00:00.000Z')]),
        post('p2', [variant('b', 'scheduled', '2026-10-27T02:00:00.000Z')]),
        post('p3', [variant('d', 'draft', '2026-10-28T02:00:00.000Z')]),
        post('p4', [variant('o', 'published', '2026-10-20T02:00:00.000Z')]),
      ],
      IG,
    ).sort((x, y) => x.v.id.localeCompare(y.v.id));
    if (!a || !b || !draft || !out) throw new Error('missing items');
    expect(swapTimes(a, b)?.map((m) => [m.variantId, m.at.toISOString()])).toEqual([
      ['a', '2026-10-27T02:00:00.000Z'],
      ['b', '2026-10-25T02:00:00.000Z'],
    ]);
    expect(swapTimes(a, a)).toBeNull();
    expect(swapTimes(a, draft)).toBeNull();
    expect(swapTimes(out, a)).toBeNull();
  });
});
