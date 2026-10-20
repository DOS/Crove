import { describe, expect, it } from 'vitest';
import { COMMENT_STALE_MS, commentStatus, type CommentCall } from '../src/comments.ts';
import type { Provider } from '../src/domain/channels.ts';
import { validateVariant } from '../src/domain/validate.ts';

describe('first comments (#587)', () => {
  const base = { body: 'Khai trương', title: null, media: [] };
  // Only the comment's own issues: a Zalo OA or Instagram post here also lacks its required media.
  const commentIssues = (provider: Provider, firstComment: string) => validateVariant({ ...base, provider, settings: { firstComment } }).filter((i) => i.field === 'settings.firstComment');
  it('checks the comment against the channel limit, and refuses it where Crove posts none', () => {
    expect(validateVariant({ ...base, provider: 'x', settings: { firstComment: '#a #b' } })).toEqual([]);
    expect(validateVariant({ ...base, provider: 'x', settings: { firstComment: 'ệ'.repeat(141) } })).toEqual([{ code: 'COMMENT_TOO_LONG', field: 'settings.firstComment', limit: 280, actual: 282 }]);
    expect(commentIssues('zalo_oa', '#a').map((i) => i.code)).toEqual(['COMMENT_NOT_SUPPORTED']);
    // A blank comment is no comment.
    expect(commentIssues('zalo_oa', '   ')).toEqual([]);
  });

  it('takes a first comment on Facebook Pages, Instagram and Threads, within each limit (#609)', () => {
    for (const provider of ['facebook_page', 'instagram', 'threads'] as const) expect(commentIssues(provider, '#khaitruong #quan3')).toEqual([]);
    expect(commentIssues('facebook_page', 'a'.repeat(8001))).toEqual([{ code: 'COMMENT_TOO_LONG', field: 'settings.firstComment', limit: 8000, actual: 8001 }]);
    expect(commentIssues('instagram', 'a'.repeat(2201))).toEqual([{ code: 'COMMENT_TOO_LONG', field: 'settings.firstComment', limit: 2200, actual: 2201 }]);
    // Threads counts code points, as its post text: 500 Vietnamese letters typed with combining marks still fit.
    expect(commentIssues('threads', 'ệ'.normalize('NFD').repeat(500))).toEqual([]);
    expect(commentIssues('threads', '😀'.repeat(501))).toEqual([{ code: 'COMMENT_TOO_LONG', field: 'settings.firstComment', limit: 500, actual: 501 }]);
  });

  it('turns a call or a job that went quiet into something a person can retry', () => {
    const now = new Date('2026-10-20T10:00:00Z');
    const ago = (ms: number) => new Date(now.getTime() - ms);
    const call = (state: CommentCall['state'], startedMs: number, key = 'k'): CommentCall => ({ key, state, external_ref: null, error_code: null, started_at: ago(startedMs) });
    const fresh = 60_000;
    const old = COMMENT_STALE_MS + 1;
    expect(commentStatus([], now, ago(fresh))).toBe('pending');
    expect(commentStatus([], now, ago(old))).toBe('failed');
    expect(commentStatus([call('started', fresh)], now, ago(old))).toBe('pending');
    expect(commentStatus([call('started', old)], now, ago(old))).toBe('unknown');
    expect(commentStatus([call('failed', fresh)], now, ago(fresh))).toBe('failed');
    expect(commentStatus([call('ambiguous', fresh)], now, ago(fresh))).toBe('unknown');
    // An older call answered after a newer one began still counts as posted.
    expect(commentStatus([call('succeeded', old, 'a'), call('started', fresh, 'b')], now, ago(old))).toBe('posted');
  });
});