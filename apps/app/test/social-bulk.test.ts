import { describe, expect, it } from 'vitest';
import { localTime } from '@crove/mod-social/contract';
import {
  BULK_EDIT_MAX,
  BULK_REPLACE_MAX,
  addedSummary,
  assignInput,
  bulkRequest,
  editBatches,
  moveSummary,
  previewSummary,
  replaceKey,
  planMove,
  runAddChannel,
  runBulk,
  runEdit,
  runMove,
  runReplacePreview,
  shiftTime,
  submitResult,
  toggleEditLabel,
  validLabelEdit,
  validMove,
  validReplace,
  type BulkPost,
  type BulkVariant,
  type EditAnswer,
  type ReplacePreviewPost,
} from '../src/lib/social-bulk.ts';

const v = (id: string, status: string, at: string | null = null, queueSlotAt: string | null = null): BulkVariant => ({
  id,
  connectionId: `c-${id}`,
  status,
  revision: 2,
  contentHash: `sha256:${'a'.repeat(64)}`,
  effectiveAt: queueSlotAt ?? at,
  queueSlotAt,
});
const post = (id: string, ...variants: BulkVariant[]): BulkPost => ({ id, timeZone: 'Asia/Ho_Chi_Minh', variants });
const zoned = (timeZone: string, id: string, ...variants: BulkVariant[]): BulkPost => ({ id, timeZone, variants });
const ms = (iso: string) => Date.parse(iso);
const iso = (n: number) => new Date(n).toISOString();

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

  it('publishes again only the failed and unaccounted channels, for owners and admins (#1456)', () => {
    const p = post('p1', v('a', 'failed'), v('b', 'published'), v('c', 'needs_attention'), v('d', 'scheduled'), v('e', 'paused'));
    expect(bulkRequest(p, 'retry', true)).toEqual({ action: 'retry', postId: 'p1', variantIds: ['a', 'c'] });
    expect(bulkRequest(p, 'retry', false)).toBeNull();
    // Nothing failed: the post is skipped, not sent.
    expect(bulkRequest(post('p2', v('x', 'published'), v('y', 'scheduled')), 'retry', true)).toBeNull();
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

describe('moving posts by days or hours (#945)', () => {
  it('keeps the local time of day across a daylight-saving change when moving by days', () => {
    // New York moves to daylight time on 2026-03-08: 09:00 EST is 14:00Z, 09:00 EDT is 13:00Z.
    expect(iso(shiftTime(ms('2026-03-05T14:00:00.000Z'), { amount: 7, unit: 'days' }, 'America/New_York'))).toBe('2026-03-12T13:00:00.000Z');
    // And back, earlier.
    expect(iso(shiftTime(ms('2026-03-12T13:00:00.000Z'), { amount: -7, unit: 'days' }, 'America/New_York'))).toBe('2026-03-05T14:00:00.000Z');
    // London leaves summer time on 2026-10-25: 09:00 BST is 08:00Z, 09:00 GMT is 09:00Z.
    expect(iso(shiftTime(ms('2026-10-24T08:00:00.000Z'), { amount: 1, unit: 'days' }, 'Europe/London'))).toBe('2026-10-25T09:00:00.000Z');
  });

  it('moves by calendar days in the post\'s zone, over month and year ends, keeping the seconds', () => {
    // 23:30 in Ho Chi Minh City on 31 December is 16:30Z; a day later is 23:30 on 1 January.
    expect(iso(shiftTime(ms('2026-12-31T16:30:15.000Z'), { amount: 1, unit: 'days' }, 'Asia/Ho_Chi_Minh'))).toBe('2027-01-01T16:30:15.000Z');
    expect(iso(shiftTime(ms('2026-03-01T02:00:00.000Z'), { amount: -1, unit: 'days' }, 'Asia/Ho_Chi_Minh'))).toBe('2026-02-28T02:00:00.000Z');
    // A local time the change skips (02:30 on 2026-03-08 in New York) lands just after it, as the queues place it.
    expect(iso(shiftTime(ms('2026-03-07T07:30:00.000Z'), { amount: 1, unit: 'days' }, 'America/New_York'))).toBe('2026-03-08T07:30:00.000Z');
  });

  it('moves by exact hours, whatever the zone does', () => {
    expect(iso(shiftTime(ms('2026-03-05T14:00:00.000Z'), { amount: 168, unit: 'hours' }, 'America/New_York'))).toBe('2026-03-12T14:00:00.000Z');
    expect(iso(shiftTime(ms('2026-10-21T02:00:00.000Z'), { amount: -3, unit: 'hours' }, 'Asia/Ho_Chi_Minh'))).toBe('2026-10-20T23:00:00.000Z');
  });

  it('accepts whole, non-zero moves within the limit', () => {
    expect(validMove({ amount: 7, unit: 'days' })).toBe(true);
    expect(validMove({ amount: -2, unit: 'hours' })).toBe(true);
    expect(validMove({ amount: 0, unit: 'days' })).toBe(false);
    expect(validMove({ amount: 1.5, unit: 'hours' })).toBe(false);
    expect(validMove({ amount: Number.NaN, unit: 'days' })).toBe(false);
    expect(validMove({ amount: 1000, unit: 'days' })).toBe(false);
  });

  it('plans a move for each channel scheduled at a time and names why the others stay', () => {
    const p = zoned(
      'Europe/London',
      'p1',
      v('time', 'scheduled', '2026-10-24T08:00:00.000Z'),
      v('slot', 'scheduled', null, '2026-10-24T10:00:00.000Z'),
      v('out', 'published', '2026-10-20T08:00:00.000Z'),
      v('going', 'publishing', '2026-10-21T08:00:00.000Z'),
      v('gone', 'cancelled'),
      v('draft', 'draft'),
      v('ok', 'approved', '2026-10-24T08:00:00.000Z'),
      v('held', 'paused', '2026-10-24T08:00:00.000Z'),
      v('none', 'scheduled'),
    );
    expect(planMove(p, { amount: 1, unit: 'days' })).toEqual({
      postId: 'p1',
      // Each move carries the time it starts from, for the server's stale check (#956).
      moves: [{ variantId: 'time', at: '2026-10-25T09:00:00.000Z', expectedAt: '2026-10-24T08:00:00.000Z' }],
      skipped: [
        { variantId: 'slot', reason: 'queue' },
        { variantId: 'out', reason: 'published' },
        { variantId: 'going', reason: 'published' },
        { variantId: 'gone', reason: 'cancelled' },
        { variantId: 'draft', reason: 'unscheduled' },
        { variantId: 'ok', reason: 'unscheduled' },
        { variantId: 'held', reason: 'unscheduled' },
        { variantId: 'none', reason: 'unscheduled' },
      ],
    });
  });

  it('keeps the times of day of a whole campaign moved by a week, across the clock change', () => {
    // Twelve London posts at 09:00 and 18:30 local time from 13 October, while summer time runs (UTC+1); a week later
    // some fall after 25 October, in winter time (UTC+0).
    const london = (day: number, hour: number, minute: number) => Date.UTC(2026, 9, day, hour - 1, minute);
    const posts = Array.from({ length: 12 }, (_, i) =>
      zoned('Europe/London', `p${i}`, v(`a${i}`, 'scheduled', iso(london(13 + i, 9, 0))), v(`b${i}`, 'scheduled', iso(london(13 + i, 18, 30)))),
    );
    const moves = posts.flatMap((p) => planMove(p, { amount: 7, unit: 'days' }).moves);
    expect(moves).toHaveLength(24);
    for (const m of moves) expect(localTime(Date.parse(m.at), 'Europe/London')).toMatchObject(m.variantId.startsWith('a') ? { hour: 9, minute: 0 } : { hour: 18, minute: 30 });
    expect(moves[0]).toEqual({ variantId: 'a0', at: '2026-10-20T08:00:00.000Z', expectedAt: '2026-10-13T08:00:00.000Z' });
    // 23 October, 09:00 BST, moves to 30 October, 09:00 GMT.
    expect(moves.find((m) => m.variantId === 'a10')).toEqual({ variantId: 'a10', at: '2026-10-30T09:00:00.000Z', expectedAt: '2026-10-23T08:00:00.000Z' });
  });

  it('sends one reschedule per channel, goes on after a refusal, and reports each post', async () => {
    const posts = [
      post('both', v('a', 'scheduled', '2026-11-02T02:00:00.000Z'), v('b', 'scheduled', '2026-11-02T03:00:00.000Z')),
      post('half', v('c', 'scheduled', '2026-11-02T02:00:00.000Z'), v('d', 'scheduled', null, '2026-11-02T04:00:00.000Z')),
      post('none', v('e', 'published', '2026-10-01T02:00:00.000Z')),
      post('refused', v('f', 'scheduled', '2026-11-02T02:00:00.000Z'), v('g', 'scheduled', '2026-11-02T05:00:00.000Z')),
    ];
    const sent: { variantId: string; at: string; expectedAt: string }[] = [];
    const progress: number[] = [];
    const results = await runMove(
      posts,
      { amount: -2, unit: 'hours' },
      async (r) => {
        sent.push(r);
        if (r.variantId === 'f') throw new Error('REMOVE_AT_BEFORE_PUBLISH');
      },
      (done, total) => progress.push(done * 10 + total),
    );
    expect(sent).toEqual([
      { variantId: 'a', at: '2026-11-02T00:00:00.000Z', expectedAt: '2026-11-02T02:00:00.000Z' },
      { variantId: 'b', at: '2026-11-02T01:00:00.000Z', expectedAt: '2026-11-02T03:00:00.000Z' },
      { variantId: 'c', at: '2026-11-02T00:00:00.000Z', expectedAt: '2026-11-02T02:00:00.000Z' },
      { variantId: 'f', at: '2026-11-02T00:00:00.000Z', expectedAt: '2026-11-02T02:00:00.000Z' },
      { variantId: 'g', at: '2026-11-02T03:00:00.000Z', expectedAt: '2026-11-02T05:00:00.000Z' },
    ]);
    expect(progress).toEqual([14, 24, 34, 44]);
    expect(results.map((r) => [r.postId, r.moved.map((m) => m.variantId), r.skipped.map((s) => `${s.variantId}:${s.reason}`), r.refused.map((x) => `${x.variantId}:${(x.error as Error).message}`)])).toEqual([
      ['both', ['a', 'b'], [], []],
      ['half', ['c'], ['d:queue'], []],
      ['none', [], ['e:published'], []],
      ['refused', ['g'], [], ['f:REMOVE_AT_BEFORE_PUBLISH']],
    ]);
    expect(moveSummary(results)).toEqual({ done: 3, skipped: 1, refused: 1, channels: 4 });
  });

  it('counts a post whose every channel was refused as refused, not as done', () => {
    expect(moveSummary([{ postId: 'p', moved: [], skipped: [], refused: [{ variantId: 'a', error: new Error('SCHEDULE_IN_PAST') }] }])).toEqual({ done: 0, skipped: 0, refused: 1, channels: 0 });
    expect(moveSummary([])).toEqual({ done: 0, skipped: 0, refused: 0, channels: 0 });
  });
});

describe('labels and the assignee on many posts (#1057)', () => {
  it('picks a label to add or to take off, never both, and unpicks it on a second click', () => {
    let edit = { add: [] as string[], remove: [] as string[] };
    edit = toggleEditLabel(edit, 'add', 'spring');
    expect(edit).toEqual({ add: ['spring'], remove: [] });
    edit = toggleEditLabel(edit, 'remove', 'spring');
    expect(edit).toEqual({ add: [], remove: ['spring'] });
    edit = toggleEditLabel(toggleEditLabel(edit, 'add', 'sale'), 'remove', 'spring');
    expect(edit).toEqual({ add: ['sale'], remove: [] });
  });

  it('sends a label edit only when it changes something, within the ten labels a post carries', () => {
    expect(validLabelEdit({ add: [], remove: [] })).toBe(false);
    expect(validLabelEdit({ add: ['a'], remove: [] })).toBe(true);
    expect(validLabelEdit({ add: [], remove: ['a'] })).toBe(true);
    expect(validLabelEdit({ add: ['a'], remove: ['a'] })).toBe(false);
    expect(validLabelEdit({ add: Array.from({ length: 11 }, (_, i) => `l${i}`), remove: [] })).toBe(false);
  });

  it('keeps, clears or sets the due date, and waits for a date to set', () => {
    expect(assignInput({ assigneeUserId: 'u', due: { mode: 'keep' } })).toEqual({ assigneeUserId: 'u' });
    expect(assignInput({ assigneeUserId: null, due: { mode: 'clear' } })).toEqual({ assigneeUserId: null, dueAt: null });
    expect(assignInput({ assigneeUserId: 'u', due: { mode: 'set', at: '2026-11-02T02:00:00.000Z' } })).toEqual({ assigneeUserId: 'u', dueAt: '2026-11-02T02:00:00.000Z' });
    expect(assignInput({ assigneeUserId: 'u', due: { mode: 'set', at: null } })).toBeNull();
  });

  it('sends the selection in batches the server takes, in the order shown', () => {
    const ids = Array.from({ length: 250 }, (_, i) => `p${i}`);
    const batches = editBatches(ids);
    expect(BULK_EDIT_MAX).toBe(100);
    expect(batches.map((b) => b.length)).toEqual([100, 100, 50]);
    expect(batches.flat()).toEqual(ids);
    expect(editBatches([])).toEqual([]);
  });

  it("merges each batch's answer, and a batch refused as a whole does not stop the next", async () => {
    const ids = Array.from({ length: 205 }, (_, i) => `p${i}`);
    const progress: number[] = [];
    const sent: number[] = [];
    const result = await runEdit(
      ids,
      async (batch): Promise<EditAnswer> => {
        sent.push(batch.length);
        if (batch[0] === 'p100') throw new Error('ASSIGNEE_NOT_MEMBER');
        return { done: batch.filter((id) => id !== 'p3'), skipped: batch.includes('p3') ? [{ postId: 'p3', reason: 'published' }] : [] };
      },
      (done) => progress.push(done),
    );
    expect(sent).toEqual([100, 100, 5]);
    expect(progress).toEqual([100, 200, 205]);
    expect(result.done).toHaveLength(104);
    expect(result.skipped).toEqual([{ postId: 'p3', reason: 'published' }]);
    expect(result.refused).toHaveLength(100);
    expect(result.refused[0]).toMatchObject({ postId: 'p100' });
    expect(result.refused.map((r) => (r.error as Error).message)[0]).toBe('ASSIGNEE_NOT_MEMBER');
  });
});

describe('find and replace across posts (#1144)', () => {
  const edit = { find: 'https://shop.example/spring', replace: 'https://shop.example/summer', caseSensitive: false, wholeWord: false };
  const match = { variantId: null, connectionId: null, field: 'body' as const, before: 'Mua tại ', match: edit.find, after: '' };

  it('takes something to find, within the bounds the server takes', () => {
    expect(validReplace(edit)).toBe(true);
    expect(validReplace({ ...edit, replace: '' })).toBe(true);
    expect(validReplace({ ...edit, find: '' })).toBe(false);
    expect(validReplace({ ...edit, find: 'x'.repeat(201) })).toBe(false);
    expect(validReplace({ ...edit, replace: 'x'.repeat(2001) })).toBe(false);
  });

  it('previews the selection in batches the server takes, in order', async () => {
    const ids = Array.from({ length: BULK_REPLACE_MAX + 3 }, (_, i) => `p${String(i).padStart(3, '0')}`);
    const batches: string[][] = [];
    const steps: number[] = [];
    const posts = await runReplacePreview(
      ids,
      async (batch) => {
        batches.push(batch);
        return { posts: batch.map((postId) => ({ postId, skip: null, matches: [] })) };
      },
      (done) => steps.push(done),
    );
    expect(batches.map((b) => b.length)).toEqual([BULK_REPLACE_MAX, 3]);
    expect(posts.map((p) => p.postId)).toEqual(ids);
    expect(steps).toEqual([BULK_REPLACE_MAX, BULK_REPLACE_MAX + 3]);
  });

  it('counts the posts and matches that would change, and the posts left as they are', () => {
    const posts: ReplacePreviewPost[] = [
      { postId: 'a', skip: null, matches: [{ ...match, count: 2 }, { ...match, variantId: 'v', connectionId: 'c', field: 'first_comment', count: 1 }] },
      { postId: 'b', skip: 'banned_words', matches: [{ ...match, count: 4 }] },
      { postId: 'c', skip: 'no_match', matches: [] },
    ];
    expect(previewSummary(posts)).toEqual({ changes: 1, matches: 3, skipped: 2 });
  });

  it('asks for a new preview when the search, the replacement, an option or the selection changes', () => {
    const key = replaceKey(edit, ['b', 'a']);
    expect(replaceKey(edit, ['a', 'b'])).toBe(key);
    expect(replaceKey({ ...edit, replace: 'x' }, ['a', 'b'])).not.toBe(key);
    expect(replaceKey({ ...edit, wholeWord: true }, ['a', 'b'])).not.toBe(key);
    expect(replaceKey(edit, ['a'])).not.toBe(key);
  });
});

describe('drafts sent to review and a channel added in bulk (#1178)', () => {
  it('sends a post with a draft or a channel sent back, and skips one with nothing to send', async () => {
    expect(bulkRequest(post('p', v('a', 'draft'), v('b', 'scheduled')), 'submit', false)).toEqual({ action: 'submit', postId: 'p' });
    expect(bulkRequest(post('p', v('a', 'changes_requested')), 'submit', false)).toEqual({ action: 'submit', postId: 'p' });
    expect(bulkRequest(post('p', v('a', 'rejected')), 'submit', true)).toEqual({ action: 'submit', postId: 'p' });
    expect(bulkRequest(post('p', v('a', 'in_review'), v('b', 'published')), 'submit', true)).toBeNull();
    const sent: string[] = [];
    const result = await runBulk([post('p1', v('a', 'draft')), post('p2', v('b', 'approved'))], 'submit', false, async (r) => void sent.push(r.postId));
    expect(sent).toEqual(['p1']);
    expect(result).toEqual({ done: ['p1'], skipped: ['p2'], refused: [] });
  });

  it('tells apart nothing to send, channels that do not fit and a blocked word from other refusals', () => {
    const refusal = (code: string, data?: unknown) => Object.assign(new Error(code), { code, data });
    const result = submitResult({
      done: ['ok'],
      skipped: ['none'],
      refused: [
        { postId: 'gone', error: refusal('NOTHING_TO_SUBMIT') },
        { postId: 'bad', error: refusal('VARIANT_INVALID', { variants: [{ variantId: 'v1', issues: [{ code: 'MEDIA_REQUIRED', field: 'media', limit: null, actual: null }] }] }) },
        {
          postId: 'word',
          error: refusal('BANNED_WORDS', {
            variants: [
              {
                variantId: 'v2',
                words: [
                  { wordId: 'w', phrase: 'cấm', field: 'body', reason: null },
                  { wordId: 'w', phrase: 'cấm', field: 'title', reason: null },
                ],
              },
            ],
          }),
        },
        { postId: 'other', error: refusal('CHANNEL_NOT_ALLOWED') },
      ],
    });
    expect(result.done).toEqual(['ok']);
    expect(result.skipped).toEqual(['none', 'gone']);
    expect(result.invalid).toEqual([{ postId: 'bad', variants: [{ variantId: 'v1', issues: [{ code: 'MEDIA_REQUIRED', field: 'media', limit: null, actual: null }] }] }]);
    expect(result.blocked).toEqual([{ postId: 'word', phrases: ['cấm'] }]);
    expect(result.refused.map((r) => r.postId)).toEqual(['other']);
  });

  it('adds the channel batch by batch, keeping what each added channel still lacks', async () => {
    const ids = Array.from({ length: BULK_EDIT_MAX + 1 }, (_, i) => 'p' + i);
    const batches: string[][] = [];
    const result = await runAddChannel(ids, async (batch) => {
      batches.push(batch);
      if (batches.length === 2) throw new Error('refused');
      return {
        done: batch.slice(0, 2),
        skipped: [{ postId: batch[2] as string, reason: 'already_on' as const }],
        added: [
          { postId: batch[0] as string, variantId: 'v0', issues: [] },
          { postId: batch[1] as string, variantId: 'v1', issues: [{ code: 'MEDIA_REQUIRED', field: 'media', limit: null, actual: null }] },
        ],
      };
    });
    expect(batches.map((b) => b.length)).toEqual([BULK_EDIT_MAX, 1]);
    expect(result.done).toEqual(['p0', 'p1']);
    expect(result.skipped).toEqual([{ postId: 'p2', reason: 'already_on' }]);
    expect(result.refused.map((r) => r.postId)).toEqual(['p' + BULK_EDIT_MAX]);
    expect(addedSummary(result.added)).toEqual({ fits: 1, needsEdits: 1 });
  });
});
