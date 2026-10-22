import { describe, expect, it } from 'vitest';
import { en } from '../src/i18n/messages/en.ts';
import { vi } from '../src/i18n/messages/vi.ts';
import { translatorFor } from '../src/i18n/runtime.ts';
import { describeError } from '../src/lib/errors.ts';
import { SOCIAL_TABS } from '../src/lib/social.ts';
import {
  adjacentColumn,
  BOARD_COLUMNS,
  boardRequest,
  checkMove,
  MOVE_COMMAND,
  movesFrom,
  postColumn,
  sendBoardRequest,
  variantColumn,
  type BoardApi,
  type BoardColumn,
  type BoardPost,
  type BoardRefusal,
} from '../src/lib/social-board.ts';

const HASH = `sha256:${'b'.repeat(64)}`;
const v = (id: string, status: string) => ({ id, status, revision: 3, contentHash: HASH });
const post = (variants: ReturnType<typeof v>[], scheduledAt: string | null = null): BoardPost => ({ id: 'p1', scheduledAt, variants });
const ADMIN = { canWrite: true, canDecide: true };
const MEMBER = { canWrite: true, canDecide: false };
const VIEWER = { canWrite: false, canDecide: false };
const NOW = Date.parse('2026-10-22T03:00:00.000Z');

describe('board columns (#1022)', () => {
  it('has a column per status, in the order a post moves', () => {
    expect(BOARD_COLUMNS).toEqual(['draft', 'in_review', 'approved', 'scheduled', 'published', 'failed']);
    expect(SOCIAL_TABS).toContain('board');
    expect(vi.social.tabs.board).toBe('Bảng');
    expect(en.social.tabs.board).toBe('Board');
  });

  it('puts each channel status in a column, history in none', () => {
    expect(['draft', 'changes_requested', 'rejected'].map(variantColumn)).toEqual(['draft', 'draft', 'draft']);
    expect(variantColumn('in_review')).toBe('in_review');
    expect(variantColumn('approved')).toBe('approved');
    expect(['scheduled', 'paused', 'publishing', 'processing', 'ambiguous'].map(variantColumn)).toEqual(Array(5).fill('scheduled'));
    expect(variantColumn('published')).toBe('published');
    expect(['failed', 'needs_attention'].map(variantColumn)).toEqual(['failed', 'failed']);
    expect(['cancelled', 'removed', 'unknown', 'constructor'].map(variantColumn)).toEqual([null, null, null, null]);
  });

  it('places a post by its channels: failed first, then review, then the least advanced', () => {
    expect(postColumn([])).toBe('draft');
    expect(postColumn([{ status: 'draft' }])).toBe('draft');
    expect(postColumn([{ status: 'published' }, { status: 'failed' }])).toBe('failed');
    expect(postColumn([{ status: 'draft' }, { status: 'in_review' }])).toBe('in_review');
    expect(postColumn([{ status: 'approved' }, { status: 'scheduled' }])).toBe('approved');
    // Half published: it stays with the channel still to go.
    expect(postColumn([{ status: 'published' }, { status: 'scheduled' }])).toBe('scheduled');
    expect(postColumn([{ status: 'published' }, { status: 'cancelled' }])).toBe('published');
    // Every channel cancelled or taken down: not on the board.
    expect(postColumn([{ status: 'cancelled' }, { status: 'removed' }])).toBeNull();
  });
});

describe('moves between columns (#1022)', () => {
  // Every pair of columns, for an owner or admin: the move, or why not.
  const table: Record<BoardColumn, Record<BoardColumn, string | null>> = {
    draft: { draft: null, in_review: 'submit', approved: 'notReviewed', scheduled: 'notReviewed', published: 'toPublished', failed: 'toFailed' },
    in_review: { draft: 'request_changes', in_review: null, approved: 'approve', scheduled: 'notApproved', published: 'toPublished', failed: 'toFailed' },
    approved: { draft: 'editToDraft', in_review: 'alreadyApproved', approved: null, scheduled: 'schedule', published: 'toPublished', failed: 'toFailed' },
    scheduled: { draft: 'editToDraft', in_review: 'alreadyApproved', approved: 'unschedule', scheduled: null, published: 'toPublished', failed: 'toFailed' },
    published: { draft: 'fromPublished', in_review: 'fromPublished', approved: 'fromPublished', scheduled: 'fromPublished', published: null, failed: 'fromPublished' },
    failed: { draft: 'fromFailed', in_review: 'fromFailed', approved: 'fromFailed', scheduled: 'fromFailed', published: 'fromFailed', failed: null },
  };

  it('allows only the legal steps, each with its reason otherwise', () => {
    for (const from of BOARD_COLUMNS) {
      for (const to of BOARD_COLUMNS) {
        const check = checkMove(from, to, ADMIN);
        const got = check === null ? null : check.ok ? check.move : check.reason;
        expect(got, `${from} -> ${to}`).toBe(table[from][to]);
      }
    }
  });

  it('names the existing command each move calls', () => {
    expect(MOVE_COMMAND).toEqual({
      submit: 'social.post.submit',
      approve: 'social.variant.decide',
      request_changes: 'social.variant.decide',
      schedule: 'social.variant.schedule',
      unschedule: 'social.variant.unschedule',
    });
  });

  it('lets members send for review only, and viewers nothing', () => {
    expect(checkMove('draft', 'in_review', MEMBER)).toEqual({ ok: true, move: 'submit' });
    expect(checkMove('in_review', 'approved', MEMBER)).toEqual({ ok: false, reason: 'admins' });
    expect(checkMove('in_review', 'draft', MEMBER)).toEqual({ ok: false, reason: 'admins' });
    expect(checkMove('approved', 'scheduled', MEMBER)).toEqual({ ok: false, reason: 'admins' });
    expect(checkMove('scheduled', 'approved', MEMBER)).toEqual({ ok: false, reason: 'admins' });
    // A refusal the step itself has comes before the role.
    expect(checkMove('draft', 'published', MEMBER)).toEqual({ ok: false, reason: 'toPublished' });
    for (const to of BOARD_COLUMNS.filter((c) => c !== 'draft')) expect(checkMove('draft', to, VIEWER)).toEqual({ ok: false, reason: 'readonly' });
  });

  it('offers the legal moves of a column as buttons', () => {
    expect(movesFrom('draft', ADMIN)).toEqual([{ move: 'submit', to: 'in_review' }]);
    expect(movesFrom('in_review', ADMIN)).toEqual([
      { move: 'request_changes', to: 'draft' },
      { move: 'approve', to: 'approved' },
    ]);
    expect(movesFrom('in_review', MEMBER)).toEqual([]);
    expect(movesFrom('published', ADMIN)).toEqual([]);
    expect(movesFrom('draft', VIEWER)).toEqual([]);
  });

  it('moves one column at a time by keyboard, and every legal move is one column away', () => {
    expect(adjacentColumn('draft', 1)).toBe('in_review');
    expect(adjacentColumn('draft', -1)).toBeNull();
    expect(adjacentColumn('failed', 1)).toBeNull();
    for (const from of BOARD_COLUMNS) {
      for (const { to } of movesFrom(from, ADMIN)) expect(Math.abs(BOARD_COLUMNS.indexOf(to) - BOARD_COLUMNS.indexOf(from))).toBe(1);
    }
  });

  it('has a message for every refusal and move, in both languages', () => {
    const reasons = new Set<BoardRefusal>(['readonly', 'admins', 'nothing']);
    for (const row of Object.values(table)) for (const x of Object.values(row)) if (x && !(x in MOVE_COMMAND)) reasons.add(x as BoardRefusal);
    for (const reason of reasons) {
      expect(vi.social.board.refused[reason], reason).toBeTruthy();
      expect(en.social.board.refused[reason], reason).toBeTruthy();
    }
    for (const move of Object.keys(MOVE_COMMAND) as (keyof typeof MOVE_COMMAND)[]) {
      expect(vi.social.board.move[move]).toBeTruthy();
      expect(vi.social.board.done[move]).toBeTruthy();
    }
  });
});

describe('the request a move sends (#1022)', () => {
  it('sends for review the post whose channels can go', () => {
    expect(boardRequest(post([v('a', 'draft'), v('b', 'rejected')]), 'submit', NOW)).toEqual({ move: 'submit', postId: 'p1' });
    expect(boardRequest(post([v('a', 'in_review')]), 'submit', NOW)).toBeNull();
  });

  it('approves or sends back the channels in review, with the revision and content seen', () => {
    const p = post([v('a', 'in_review'), v('b', 'draft'), v('c', 'in_review')]);
    const seen = [
      { variantId: 'a', revision: 3, contentHash: HASH },
      { variantId: 'c', revision: 3, contentHash: HASH },
    ];
    expect(boardRequest(p, 'approve', NOW)).toEqual({ move: 'approve', postId: 'p1', variants: seen });
    expect(boardRequest(p, 'request_changes', NOW)).toEqual({ move: 'request_changes', postId: 'p1', variants: seen });
    expect(boardRequest(post([v('a', 'approved')]), 'approve', NOW)).toBeNull();
  });

  it('schedules the approved channels at the planned time while it is ahead, else in the queues', () => {
    const channels = [v('a', 'approved'), v('b', 'scheduled')];
    expect(boardRequest(post(channels, '2026-10-23T02:00:00.000Z'), 'schedule', NOW)).toEqual({ move: 'schedule', postId: 'p1', variantIds: ['a'], queue: false });
    expect(boardRequest(post(channels, '2026-10-21T02:00:00.000Z'), 'schedule', NOW)).toEqual({ move: 'schedule', postId: 'p1', variantIds: ['a'], queue: true });
    expect(boardRequest(post(channels), 'schedule', NOW)).toEqual({ move: 'schedule', postId: 'p1', variantIds: ['a'], queue: true });
  });

  it('unschedules the scheduled and paused channels, never one on its way out', () => {
    expect(boardRequest(post([v('a', 'scheduled'), v('b', 'paused'), v('c', 'publishing')]), 'unschedule', NOW)).toEqual({ move: 'unschedule', variantIds: ['a', 'b'] });
    expect(boardRequest(post([v('c', 'publishing')]), 'unschedule', NOW)).toBeNull();
  });

  it('calls the existing client call of each move, and only that one', async () => {
    const calls: [string, unknown][] = [];
    const api: BoardApi = {
      submit: async (input) => void calls.push(['submit', input]),
      decide: async (input) => (calls.push(['decide', input]), { waiting: input.decision === 'approved' ? ['a'] : [] }),
      schedule: async (input) => void calls.push(['schedule', input]),
      unschedule: async (input) => void calls.push(['unschedule', input]),
    };
    const variants = [{ variantId: 'a', revision: 3, contentHash: HASH }];
    expect(await sendBoardRequest({ move: 'submit', postId: 'p1' }, api)).toEqual({ move: 'submit', waiting: 0 });
    expect(await sendBoardRequest({ move: 'approve', postId: 'p1', variants }, api)).toEqual({ move: 'approve', waiting: 1 });
    expect(await sendBoardRequest({ move: 'request_changes', postId: 'p1', variants }, api)).toEqual({ move: 'request_changes', waiting: 0 });
    await sendBoardRequest({ move: 'schedule', postId: 'p1', variantIds: ['a'], queue: true }, api);
    await sendBoardRequest({ move: 'schedule', postId: 'p1', variantIds: ['a'], queue: false }, api);
    await sendBoardRequest({ move: 'unschedule', variantIds: ['a'] }, api);
    expect(calls).toEqual([
      ['submit', { postId: 'p1' }],
      ['decide', { postId: 'p1', decision: 'approved', variants }],
      ['decide', { postId: 'p1', decision: 'changes_requested', variants }],
      ['schedule', { postId: 'p1', variantIds: ['a'], queue: true }],
      ['schedule', { postId: 'p1', variantIds: ['a'] }],
      ['unschedule', { variantIds: ['a'] }],
    ]);
  });

  it('passes the server\'s refusal through, such as an author approving their own post on a four-eyes channel', async () => {
    const refusal = Object.assign(new Error('Kênh này cần người khác duyệt bài của bạn'), { code: 'SOCIAL_SELF_APPROVAL', data: { variantId: 'a' } });
    const api: BoardApi = {
      submit: async () => undefined,
      decide: async () => {
        throw refusal;
      },
      schedule: async () => undefined,
      unschedule: async () => undefined,
    };
    await expect(sendBoardRequest({ move: 'approve', postId: 'p1', variants: [{ variantId: 'a', revision: 3, contentHash: HASH }] }, api)).rejects.toBe(refusal);
    // The board shows it with the kernel error's message: the server's own in Vietnamese, the catalog's in English.
    expect(describeError(refusal, translatorFor('vi'), 'vi')).toBe('Kênh này cần người khác duyệt bài của bạn');
    expect(describeError(refusal, translatorFor('en'), 'en')).toBe(en.kernelErrors.codes.SOCIAL_SELF_APPROVAL);
  });
});
