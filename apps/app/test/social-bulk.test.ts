import { describe, expect, it } from 'vitest';
import { bulkRequest, runBulk, type BulkPost } from '../src/lib/social-bulk.ts';

const v = (id: string, status: string) => ({ id, status, revision: 2, contentHash: `sha256:${'a'.repeat(64)}` });
const post = (id: string, ...variants: ReturnType<typeof v>[]): BulkPost => ({ id, variants });

describe('bulk actions on the Social lists (#635)', () => {
  it('builds each post\'s request from what the list shows, for who may do it', () => {
    const p = post('p1', v('a', 'in_review'), v('b', 'approved'), v('c', 'published'), v('d', 'draft'));
    expect(bulkRequest(p, 'approve', true)).toEqual({ action: 'approve', postId: 'p1', variants: [{ variantId: 'a', revision: 2, contentHash: `sha256:${'a'.repeat(64)}` }] });
    expect(bulkRequest(p, 'approve', false)).toBeNull();
    expect(bulkRequest(p, 'queue', true)).toEqual({ action: 'queue', postId: 'p1', variantIds: ['b'] });
    // Owners and admins cancel what is still to go out; members only what nobody approved yet.
    expect(bulkRequest(p, 'cancel', true)).toEqual({ action: 'cancel', postId: 'p1', variantIds: ['a', 'b', 'd'] });
    expect(bulkRequest(p, 'cancel', false)).toEqual({ action: 'cancel', postId: 'p1', variantIds: ['a', 'd'] });
    expect(bulkRequest(post('p2', v('x', 'published')), 'cancel', true)).toBeNull();
  });

  it('runs every post, and a refusal does not stop the others', async () => {
    const posts = [post('ok', v('a', 'in_review')), post('no', v('b', 'in_review')), post('none', v('c', 'published')), post('ok2', v('d', 'in_review'))];
    const sent: string[] = [];
    const result = await runBulk(posts, 'approve', true, async (r) => {
      sent.push(r.postId);
      if (r.postId === 'no') throw new Error('STALE_REVISION');
    });
    expect(sent).toEqual(['ok', 'no', 'ok2']);
    expect(result.done).toEqual(['ok', 'ok2']);
    expect(result.skipped).toEqual(['none']);
    expect(result.refused.map((r) => [r.postId, (r.error as Error).message])).toEqual([['no', 'STALE_REVISION']]);
  });
});