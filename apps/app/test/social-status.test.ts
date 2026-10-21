import { describe, expect, it } from 'vitest';
import { en } from '../src/i18n/messages/en.ts';
import { vi } from '../src/i18n/messages/vi.ts';
import { draftIssues, variantStatusKey, variantTone } from '../src/lib/social.ts';

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
