// Team chat alerts (#863): the line each alert posts (wording, length, escaping), the per-org limits and what a failed
// call means. The database and the worker path are in social-chat-alerts.db.test.ts.
import { describe, expect, it } from 'vitest';
import { DiscordError, TelegramError } from '@crove/channel';
import type { ChatAlertFacts } from '@crove/mod-social';
import { ChatAlertSaveBudget, ChatAlertTestBudget } from '../src/chat-alert-save.ts';
import { ChatAlertLimiter, chatAlertFailure, chatAlertText, CHAT_ALERT_TITLE_MAX, clip, discordEscape, telegramEscape } from '../src/chat-alerts.ts';

const POST = '0192f000-0000-7000-8000-000000000001';
const facts = (over: Partial<ChatAlertFacts> = {}): ChatAlertFacts => ({
  kind: 'needs_approval',
  event: 'social.post.submitted',
  slug: 'quan-pho',
  postId: POST,
  postText: 'Khai trương chi nhánh mới',
  channels: ['Facebook Quán Phở'],
  channelCount: 1,
  verdict: null,
  reviewer: null,
  ...over,
});
const telegram = { publicUrl: 'https://crove.example/', target: 'telegram' as const };
const discord = { publicUrl: 'https://crove.example', target: 'discord' as const };
const link = `https://crove.example/o/quan-pho/social/${POST}`;
// U+FF20, the fullwidth at sign.
const AT = '\uFF20';

describe('team chat alert line (#863)', () => {
  it('says what happened, to which post and where, with the link to the post', () => {
    expect(chatAlertText(facts(), telegram)).toBe(`Bài «Khai trương chi nhánh mới» trên Facebook Quán Phở đang chờ duyệt: ${link}`);
    expect(chatAlertText(facts({ channels: ['Facebook', 'Zalo', 'TikTok'], channelCount: 5 }), telegram)).toBe(`Bài «Khai trương chi nhánh mới» trên Facebook, Zalo, TikTok và 2 kênh khác đang chờ duyệt: ${link}`);
    expect(chatAlertText(facts({ kind: 'failed', event: 'social.variant.failed' }), telegram)).toBe(`Bài «Khai trương chi nhánh mới» không đăng được lên Facebook Quán Phở: ${link}`);
    expect(chatAlertText(facts({ kind: 'failed', event: 'social.variant.needs_attention' }), telegram)).toBe(`Bài «Khai trương chi nhánh mới» trên Facebook Quán Phở cần bạn kiểm tra: ${link}`);
    expect(chatAlertText(facts({ kind: 'published', event: 'social.variant.published' }), telegram)).toBe(`Bài «Khai trương chi nhánh mới» đã đăng lên Facebook Quán Phở: ${link}`);
    const answer = facts({ kind: 'client_answered', event: 'social.review.answered', channels: [], channelCount: 0, verdict: 'approved', reviewer: 'Chị Lan' });
    expect(chatAlertText(answer, telegram)).toBe(`Khách hàng Chị Lan đã duyệt bài «Khai trương chi nhánh mới»: ${link}`);
    expect(chatAlertText({ ...answer, verdict: 'changes_requested', reviewer: null }, telegram)).toBe(`Khách hàng yêu cầu sửa bài «Khai trương chi nhánh mới»: ${link}`);
  });

  it('names a post without text as one post, and ends without a link when the deployment has no public address', () => {
    expect(chatAlertText(facts({ postText: null, channels: [], channelCount: 0 }), { publicUrl: '', target: 'telegram' })).toBe('Một bài đang chờ duyệt.');
  });

  it('keeps the title to one line of at most 80 characters, counted as characters, without control or format characters', () => {
    const long = `${'Phở bò tái nạm '.repeat(10)}\n\nGiá 45.000đ`;
    const line = chatAlertText(facts({ postText: long }), telegram);
    const title = /«(.*)»/.exec(line)?.[1] ?? '';
    expect([...title].length).toBeLessThanOrEqual(CHAT_ALERT_TITLE_MAX);
    expect(title.endsWith('…')).toBe(true);
    expect(line).not.toMatch(/\n/);
    // Controls and line breaks are spaces; format characters (a right-to-left override here) go.
    expect(clip('a\u0000b\u202Ec\r\n  d', 80)).toBe('a bc d');
    // Bidirectional isolates, zero-width spaces and joiners and soft hyphens go too, not the text around them.
    expect(clip('\u2066Phở\u2069 bò\u200B\u00AD tái\u200D', 80)).toBe('Phở bò tái');
    expect(clip('x\u2028y\u2029z', 80)).toBe('x y z');
    // Emoji and Vietnamese letters count as one each.
    expect([...clip('😀'.repeat(100), 80)].length).toBe(80);
  });

  it('escapes markdown and mentions for Discord, and keeps Telegram plain text with no mention in it', () => {
    const tricky = facts({ postText: '**Sale** @everyone [link](https://evil.example) <@123> `x`', channels: ['Kênh_1'] });
    expect(chatAlertText(tricky, telegram)).toBe(`Bài «**Sale** ${AT}everyone [link](https://evil.example) <${AT}123> \`x\`» trên Kênh_1 đang chờ duyệt: ${link}`);
    expect(chatAlertText(tricky, discord)).toBe(`Bài «\\*\\*Sale\\*\\* \\@everyone \\[link\\]\\(https://evil.example\\) \\<\\@123\\> \\\`x\\\`» trên Kênh\\_1 đang chờ duyệt: ${link}`);
    expect(discordEscape('a\\b')).toBe('a\\\\b');
  });

  it('names nobody in a Telegram chat: an at sign in a title, a channel or a reviewer name is the fullwidth one', () => {
    const answer = facts({ kind: 'client_answered', event: 'social.review.answered', postText: 'Hỏi @shop_admin', channels: [], channelCount: 0, verdict: 'approved', reviewer: '@lan' });
    expect(chatAlertText(answer, telegram)).toBe(`Khách hàng ${AT}lan đã duyệt bài «Hỏi ${AT}shop_admin»: ${link}`);
    expect(chatAlertText(facts({ channels: ['@kenhshop'] }), telegram)).toContain(`trên ${AT}kenhshop đang chờ duyệt`);
    expect(telegramEscape('a@b@c')).toBe(`a${AT}b${AT}c`);
    // The post's link keeps its own characters.
    expect(chatAlertText(facts(), { publicUrl: 'https://u@crove.example', target: 'telegram' })).toContain('https://u@crove.example/o/');
  });

  it('stays well under both platforms limits', () => {
    const big = facts({ postText: 'x'.repeat(5000), channels: ['y'.repeat(500), 'z'.repeat(500), 'w'.repeat(500)], channelCount: 40 });
    expect(chatAlertText(big, discord).length).toBeLessThan(600);
  });
});

describe('team chat alert limits and failures (#863)', () => {
  it('lets at most the limit through in any minute per org', () => {
    let now = 0;
    const limiter = new ChatAlertLimiter(3, () => now);
    expect([limiter.take('a'), limiter.take('a'), limiter.take('a'), limiter.take('a')]).toEqual([true, true, true, false]);
    // Another org has its own count.
    expect(limiter.take('b')).toBe(true);
    now = 59_999;
    expect(limiter.take('a')).toBe(false);
    now = 60_000;
    expect(limiter.take('a')).toBe(true);
  });

  it('lets an org save its chat ten times a minute and test it five times', () => {
    let now = 0;
    const saves = new ChatAlertSaveBudget(undefined, () => now);
    for (let i = 0; i < 10; i += 1) saves.take('org-a');
    expect(() => saves.take('org-a')).toThrow(expect.objectContaining({ code: 'CHAT_ALERT_SAVE_LIMIT', status: 429 }));
    // Another org has its own budget, and it comes back with time.
    saves.take('org-b');
    now = 6_000;
    saves.take('org-a');
    const tests = new ChatAlertTestBudget(undefined, () => 0);
    for (let i = 0; i < 5; i += 1) tests.take('org-a');
    expect(() => tests.take('org-a')).toThrow(expect.objectContaining({ code: 'CHAT_ALERT_TEST_LIMIT', status: 429 }));
  });

  it('tells a refusal from a limit and from no answer', () => {
    expect(chatAlertFailure(new TelegramError(403, { description: 'Forbidden: bot was kicked' }))).toBe('refused');
    expect(chatAlertFailure(new DiscordError(404, { code: 10015, message: 'Unknown Webhook' }))).toBe('refused');
    expect(chatAlertFailure(new TelegramError(429, { description: 'Too Many Requests' }))).toBe('rate_limited');
    expect(chatAlertFailure(new DiscordError(502, null))).toBe('unreachable');
    expect(chatAlertFailure(new TypeError('fetch failed'))).toBe('unreachable');
  });
});
