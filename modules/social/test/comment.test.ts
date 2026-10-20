import { describe, expect, it } from 'vitest';
import { COMMENT_STALE_MS, commentStatus, type CommentCall } from '../src/comments.ts';
import { validateVariant } from '../src/domain/validate.ts';

describe('first comments (#587)', () => {
  const base = { body: 'Khai trương', title: null, media: [] };
  it('checks the comment against the channel limit, and refuses it where Crove posts none', () => {
    expect(validateVariant({ ...base, provider: 'x', settings: { firstComment: '#a #b' } })).toEqual([]);
    expect(validateVariant({ ...base, provider: 'x', settings: { firstComment: 'ệ'.repeat(141) } })).toEqual([{ code: 'COMMENT_TOO_LONG', field: 'settings.firstComment', limit: 280, actual: 282 }]);
    expect(validateVariant({ ...base, provider: 'facebook_page', settings: { firstComment: '#a' } }).map((i) => i.code)).toEqual(['COMMENT_NOT_SUPPORTED']);
    // A blank comment is no comment.
    expect(validateVariant({ ...base, provider: 'facebook_page', settings: { firstComment: '   ' } })).toEqual([]);
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