// Team chat alerts (#863): the line each alert posts (wording, length, escaping), the per-org limit and what a failed
// call means. The database and the worker path are in social-chat-alerts.db.test.ts.
import { describe, expect, it } from 'vitest';
import { DiscordError, TelegramError } from '@crove/channel';
import type { ChatAlertFacts } from '@crove/mod-social';
import { ChatAlertLimiter, chatAlertFailure, chatAlertText, CHAT_ALERT_TITLE_MAX, clip, discordEscape } from '../src/chat-alerts.ts';

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

  it('keeps the title to one line of at most 80 characters, counted as characters, without control characters', () => {
    const long = `${'Phở bò tái nạm '.repeat(10)}\n\nGiá 45.000đ`;
    const line = chatAlertText(facts({ postText: long }), telegram);
    const title = /«(.*)»/.exec(line)?.[1] ?? '';
    expect([...title].length).toBeLessThanOrEqual(CHAT_ALERT_TITLE_MAX);
    expect(title.endsWith('…')).toBe(true);
    expect(line).not.toMatch(/\n/);
    expect(clip('a\u0000b‮c\r\n  d', 80)).toBe('a b c d');
    // Emoji and Vietnamese letters count as one each.
    expect([...clip('😀'.repeat(100), 80)].length).toBe(80);
  });

  it('escapes markdown and mentions for Discord, and leaves Telegram plain text as it is', () => {
    const tricky = facts({ postText: '**Sale** @everyone [link](https://evil.example) <@123> `x`', channels: ['Kênh_1'] });
    expect(chatAlertText(tricky, telegram)).toBe(`Bài «**Sale** @everyone [link](https://evil.example) <@123> \`x\`» trên Kênh_1 đang chờ duyệt: ${link}`);
    expect(chatAlertText(tricky, discord)).toBe(`Bài «\\*\\*Sale\\*\\* \\@everyone \\[link\\]\\(https://evil.example\\) \\<\\@123\\> \\\`x\\\`» trên Kênh\\_1 đang chờ duyệt: ${link}`);
    expect(discordEscape('a\\b')).toBe('a\\\\b');
  });

  it('stays well under both platforms limits', () => {
    const big = facts({ postText: 'x'.repeat(5000), channels: ['y'.repeat(500), 'z'.repeat(500), 'w'.repeat(500)], channelCount: 40 });
    expect(chatAlertText(big, discord).length).toBeLessThan(600);
  });
});

describe('team chat alert limit and failures (#863)', () => {
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

  it('tells a refusal from a limit and from no answer', () => {
    expect(chatAlertFailure(new TelegramError(403, { description: 'Forbidden: bot was kicked' }))).toBe('refused');
    expect(chatAlertFailure(new DiscordError(404, { code: 10015, message: 'Unknown Webhook' }))).toBe('refused');
    expect(chatAlertFailure(new TelegramError(429, { description: 'Too Many Requests' }))).toBe('rate_limited');
    expect(chatAlertFailure(new DiscordError(502, null))).toBe('unreachable');
    expect(chatAlertFailure(new TypeError('fetch failed'))).toBe('unreachable');
  });
});
