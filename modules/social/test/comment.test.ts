import { describe, expect, it } from 'vitest';
import { COMMENT_STALE_MS, commentStatus, type CommentCall } from '../src/comments.ts';
import { pinStatus, wantsPin } from '../src/pin.ts';
import { threadStatus } from '../src/thread.ts';
import { autoReplyOf, repostRuleOf, type Provider } from '../src/domain/channels.ts';
import { validateVariant } from '../src/domain/validate.ts';

describe('thread parts (#742)', () => {
  const base = { body: 'Phần một', title: null, media: [] };
  const codes = (provider: Provider, settings: Record<string, unknown>) => validateVariant({ ...base, provider, settings }).map((i) => [i.code, i.field, i.limit, i.actual]);
  it('takes up to 9 more parts on Threads, X and Bluesky, each within the length of the channel', () => {
    expect(codes('threads', { threadParts: ['Phần hai', 'Phần ba'] })).toEqual([]);
    expect(codes('x', { threadParts: Array.from({ length: 9 }, (_, i) => `Phần ${i + 2}`) })).toEqual([]);
    expect(codes('x', { threadParts: Array.from({ length: 10 }, () => 'p') })).toEqual([['THREAD_TOO_MANY_PARTS', 'settings.threadParts', 9, 10]]);
    expect(codes('x', { threadParts: ['ok', 'ệ'.repeat(141)] })).toEqual([['THREAD_PART_TOO_LONG', 'settings.threadParts.1', 280, 282]]);
    expect(codes('bluesky', { threadParts: ['  ', 'ok'] })).toEqual([['THREAD_PART_EMPTY', 'settings.threadParts.0', null, null]]);
    expect(codes('threads', { threadParts: 'not a list' })).toEqual([['THREAD_PART_EMPTY', 'settings.threadParts', null, null]]);
    expect(codes('threads', { threadParts: [] })).toEqual([]);
  });
  it('refuses a thread on other channels, and a first comment beside a thread', () => {
    expect(codes('linkedin', { threadParts: ['Phần hai'] })).toEqual([['THREAD_NOT_SUPPORTED', 'settings.threadParts', null, null]]);
    expect(codes('threads', { threadParts: ['Phần hai'], firstComment: '#a' })).toEqual([['THREAD_WITH_COMMENT', 'settings.firstComment', null, null]]);
  });
  const call = (step: string, state: CommentCall['state'], minutesAgo = 0, ref: string | null = null): CommentCall => ({ key: `social.publish:v:1:1:${step}`, state, external_ref: ref, error_code: null, started_at: new Date(NOW.getTime() - minutesAgo * 60_000) });
  const NOW = new Date('2026-10-20T10:00:00Z');
  it('tells where a thread stands from its calls', () => {
    const published = new Date(NOW.getTime() - 60_000);
    expect(threadStatus(2, [], NOW, published)).toMatchObject({ state: 'pending', posted: 1, total: 3, next: 2, lastKey: null });
    expect(threadStatus(2, [], NOW, new Date(NOW.getTime() - COMMENT_STALE_MS - 1))).toMatchObject({ state: 'failed', posted: 1 });
    expect(threadStatus(2, [call('part_2', 'succeeded', 1, 'r2')], NOW, published)).toMatchObject({ state: 'pending', posted: 2, next: 3, lastKey: 'social.publish:v:1:1:part_2' });
    expect(threadStatus(2, [call('part_2', 'succeeded', 11, 'r2')], NOW, published)).toMatchObject({ state: 'failed', posted: 2, next: 3 });
    expect(threadStatus(2, [call('part_2', 'succeeded', 2, 'r2'), call('part_3', 'failed', 1)], NOW, published)).toMatchObject({ state: 'failed', posted: 2 });
    expect(threadStatus(2, [call('part_2', 'succeeded', 2, 'r2'), call('part_3', 'ambiguous', 1)], NOW, published)).toMatchObject({ state: 'unknown', posted: 2 });
    expect(threadStatus(2, [call('part_2', 'succeeded', 20, 'r2'), call('part_3', 'started', 11)], NOW, published)).toMatchObject({ state: 'unknown', posted: 2 });
    expect(threadStatus(2, [call('part_2', 'succeeded', 3, 'r2'), call('part_3', 'failed', 2), call('part_3_2', 'succeeded', 1, 'r3')], NOW, published)).toEqual({ state: 'posted', posted: 3, total: 3, next: null, lastKey: 'social.publish:v:1:1:part_3_2' });
  });
});

describe('reposts when a post takes off (#773)', () => {
  const base = { body: 'Khai trương', title: null, media: [] };
  const codes = (provider: Provider, repost: unknown) => validateVariant({ ...base, provider, settings: { repost } }).map((i) => i.code);
  it('takes a like count, hours, or both, on the channels that repost', () => {
    for (const provider of ['threads', 'bluesky', 'mastodon'] as const) expect(codes(provider, { likes: 100 })).toEqual([]);
    expect(codes('threads', { afterHours: 24 })).toEqual([]);
    expect(repostRuleOf({ repost: { likes: 50, afterHours: 12 } })).toEqual({ likes: 50, afterHours: 12 });
    expect(repostRuleOf({})).toBeNull();
  });
  it('refuses an empty rule, numbers out of range, and other channels', () => {
    for (const bad of [{}, { likes: 0 }, { afterHours: 721 }, { likes: 2.5 }, 'soon']) expect(codes('threads', bad)).toEqual(['REPOST_INVALID']);
    expect(codes('x', { likes: 5 })).toEqual(['REPOST_NOT_SUPPORTED']);
    expect(codes('facebook_page', { likes: 5 })).toEqual(['REPOST_NOT_SUPPORTED']);
  });
});

describe('auto-replies on likes (#746)', () => {
  const base = { body: 'Khai trương', title: null, media: [] };
  const codes = (provider: Provider, autoReply: unknown) => validateVariant({ ...base, provider, settings: { autoReply } }).map((i) => [i.code, i.field, i.limit, i.actual]);
  it('takes a text and a like count on the channels that reply and count likes', () => {
    for (const provider of ['facebook_page', 'threads', 'bluesky'] as const) expect(codes(provider, { text: 'Cảm ơn!', likes: 100 })).toEqual([]);
    expect(autoReplyOf({ autoReply: { text: '  Cảm ơn!  ', likes: 5 } })).toEqual({ text: 'Cảm ơn!', likes: 5 });
    expect(autoReplyOf({})).toBeNull();
  });
  it('refuses a reply without both parts, a count out of range, a long text and other channels', () => {
    expect(codes('threads', { text: '', likes: 5 })).toEqual([['AUTO_REPLY_INVALID', 'settings.autoReply', 1_000_000, null]]);
    expect(codes('threads', { text: 'a', likes: 0 })).toEqual([['AUTO_REPLY_INVALID', 'settings.autoReply', 1_000_000, null]]);
    expect(codes('threads', { text: 'a', likes: null })).toEqual([['AUTO_REPLY_INVALID', 'settings.autoReply', 1_000_000, null]]);
    expect(codes('threads', { text: 'a', likes: 2.5 })).toEqual([['AUTO_REPLY_INVALID', 'settings.autoReply', 1_000_000, null]]);
    expect(codes('threads', 'Cảm ơn')).toEqual([['AUTO_REPLY_INVALID', 'settings.autoReply', 1_000_000, null]]);
    expect(codes('threads', { text: '😀'.repeat(501), likes: 5 })).toEqual([['AUTO_REPLY_TOO_LONG', 'settings.autoReply.text', 500, 501]]);
    // X and LinkedIn report no like counts to Crove yet.
    expect(codes('x', { text: 'a', likes: 5 })).toEqual([['AUTO_REPLY_NOT_SUPPORTED', 'settings.autoReply', null, null]]);
    expect(codes('linkedin', { text: 'a', likes: 5 })).toEqual([['AUTO_REPLY_NOT_SUPPORTED', 'settings.autoReply', null, null]]);
    expect(codes('instagram', { text: 'a', likes: 5 })).toContainEqual(['AUTO_REPLY_NOT_SUPPORTED', 'settings.autoReply', null, null]);
    expect(codes('youtube', { text: 'a', likes: 5 })).toContainEqual(['AUTO_REPLY_NOT_SUPPORTED', 'settings.autoReply', null, null]);
  });
});

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

  it('takes a first comment on YouTube up to 10000 characters (#791)', () => {
    expect(commentIssues('youtube', 'Chương 1 00:00')).toEqual([]);
    expect(commentIssues('youtube', 'a'.repeat(10_001))).toEqual([{ code: 'COMMENT_TOO_LONG', field: 'settings.firstComment', limit: 10_000, actual: 10_001 }]);
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
    // A channel connected without the comment permission (#791) says to reconnect; only the last call counts.
    expect(commentStatus([{ ...call('failed', fresh), error_code: 'RECONNECT_FOR_COMMENTS' }], now, ago(fresh))).toBe('reconnect');
    expect(commentStatus([{ ...call('failed', old, 'a'), error_code: 'RECONNECT_FOR_COMMENTS' }, call('failed', fresh, 'b')], now, ago(old))).toBe('failed');
    // An older call answered after a newer one began still counts as posted.
    expect(commentStatus([call('succeeded', old, 'a'), call('started', fresh, 'b')], now, ago(old))).toBe('posted');
  });

  it('shows a Telegram pin like a first comment, and a bot without the right as its own warning (#982)', () => {
    const now = new Date('2026-10-20T10:00:00Z');
    const ago = (ms: number) => new Date(now.getTime() - ms);
    const call = (state: CommentCall['state'], startedMs: number, error_code: string | null = null): CommentCall => ({ key: 'k', state, external_ref: null, error_code, started_at: ago(startedMs) });
    const old = COMMENT_STALE_MS + 1;
    expect(pinStatus(undefined, now, ago(60_000))).toBe('pending');
    expect(pinStatus(undefined, now, ago(old))).toBe('failed');
    expect(pinStatus(call('started', 60_000), now, ago(old))).toBe('pending');
    expect(pinStatus(call('started', old), now, ago(old))).toBe('unknown');
    expect(pinStatus(call('succeeded', 60_000), now, ago(old))).toBe('pinned');
    expect(pinStatus(call('failed', 60_000, 'TELEGRAM_CANNOT_PIN'), now, ago(old))).toBe('not_allowed');
    expect(pinStatus(call('failed', 60_000, 'TELEGRAM_400'), now, ago(old))).toBe('failed');
    expect(pinStatus(call('ambiguous', 60_000), now, ago(old))).toBe('unknown');
    // Only a Telegram variant that asks for it is pinned.
    expect(wantsPin({ provider: 'telegram', settings: { telegram: { pin: true } } })).toBe(true);
    expect(wantsPin({ provider: 'telegram', settings: { telegram: { silent: true } } })).toBe(false);
    expect(wantsPin({ provider: 'telegram', settings: { telegram: { pin: 'yes' } } })).toBe(false);
    expect(wantsPin({ provider: 'mastodon', settings: { telegram: { pin: true } } })).toBe(false);
  });
});