import { describe, expect, it } from 'vitest';
import { en } from '../src/i18n/messages/en.ts';
import { vi } from '../src/i18n/messages/vi.ts';
import { draftIssues, takesTitle, variantStatusKey, variantTone } from '../src/lib/social.ts';

describe('A TikTok draft sent to the app (#903)', () => {
  it('reads as sent to the TikTok app, never as published', () => {
    const sent = { status: 'published' as const, error: { code: 'SENT_TO_APP' } };
    expect(variantStatusKey(sent)).toBe('sent_to_app');
    expect(variantTone(sent)).toBe('warning');
    expect(variantStatusKey({ status: 'published', error: null })).toBe('published');
    expect(variantTone({ status: 'published', error: null })).toBe('success');
    expect(variantStatusKey({ status: 'failed', error: { code: 'SENT_TO_APP' } })).toBe('failed');
    expect(en.social.status.sent_to_app).toBeTruthy();
    expect(vi.social.status.sent_to_app).toBe('Đã gửi vào TikTok');
  });

  it('asks the composer for a privacy level only when posting at once', () => {
    const video = [{ mime: 'video/mp4', sizeBytes: 1000, durationMs: 30_000 }];
    const codes = (settings: Record<string, unknown>) => draftIssues('tiktok', { body: 'Khai trương', title: null, media: video, settings }).map((i) => i.code);
    expect(codes({})).toEqual(['PRIVACY_REQUIRED']);
    expect(codes({ tiktokMode: 'inbox' })).toEqual([]);
  });
});

describe('A WordPress draft or post pending review (#981)', () => {
  it('reads as a draft or pending on WordPress, never as published', () => {
    for (const [code, key] of [['WORDPRESS_DRAFT', 'wordpress_draft'], ['WORDPRESS_PENDING', 'wordpress_pending']] as const) {
      const held = { status: 'published' as const, error: { code } };
      expect(variantStatusKey(held)).toBe(key);
      expect(variantTone(held)).toBe('warning');
      expect(variantStatusKey({ status: 'failed', error: { code } })).toBe('failed');
      expect(en.social.status[key]).toBeTruthy();
    }
    expect(vi.social.status.wordpress_draft).toBe('Nháp trên WordPress');
    expect(vi.social.outcome.wordpressDraft).toMatch(/^Đã lưu nháp trên WordPress, hãy mở trang quản trị để đăng/);
  });

  it('flags category, tag and excerpt limits in the composer', () => {
    const codes = (wordpress: Record<string, unknown>) => draftIssues('wordpress', { body: 'Khai trương', title: 'Thực đơn', media: [], settings: { wordpress } }).map((i) => i.code);
    expect(codes({ categories: ['Tin tức'], tags: ['bánh mì'], excerpt: 'Món mới', status: 'pending' })).toEqual([]);
    expect(codes({ excerpt: 'x'.repeat(501) })).toEqual(['WORDPRESS_EXCERPT_TOO_LONG']);
  });
});

describe('A Discord forum post or thread (#1103)', () => {
  it('takes the post title only on a forum post, and flags a forum post with nothing to name it', () => {
    expect(takesTitle('discord', {})).toBe(false);
    expect(takesTitle('discord', { discord: { forum: true } })).toBe(true);
    expect(takesTitle('discord', { discord: { threadId: '1200000000000000001' } })).toBe(false);
    expect(takesTitle('wordpress', {})).toBe(true);
    const codes = (body: string, discord: Record<string, unknown>) => draftIssues('discord', { body, title: null, media: [], settings: { discord } }).map((i) => i.code);
    expect(codes('Khai trương', { forum: true, tags: ['1210000000000000001'] })).toEqual([]);
    expect(codes(' ', { forum: true })).toEqual(['CONTENT_REQUIRED', 'DISCORD_THREAD_NAME_REQUIRED']);
    expect(codes('Khai trương', { tags: ['1210000000000000001'] })).toEqual(['DISCORD_FORUM_ONLY']);
  });

  it('says what to change when Discord refuses a forum post, in both languages', () => {
    for (const key of ['discordThreadNameRequired', 'discordNotForum', 'discordTagRequired', 'discordTagUnknown', 'discordThreadUnknown'] as const) {
      expect(en.social.outcome[key]).toMatch(/nothing was posted/);
      expect(vi.social.outcome[key]).toMatch(/chưa đăng gì/);
    }
  });
});
