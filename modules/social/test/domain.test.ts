// Social domain layer (issue #231): channel rules, lifecycles, approval hash, publish decisions.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import * as channel from '@crove/channel';
import {
  approvalCovers,
  approvalsInRound,
  CAPABILITIES,
  contentHash,
  countLinks,
  countText,
  DISCORD_TAGS_MAX,
  DISCORD_THREAD_NAME_MAX,
  discordOptionsOf,
  discordThreadName,
  IG_REEL_FEEDS,
  IG_TRIAL_GRADUATIONS,
  instagramReelOf,
  instagramReelOffGrid,
  LINKEDIN_VISIBILITY,
  replySettingOf,
  THREADS_REPLY_SETTINGS,
  BLUESKY_REPLY_RULES,
  BLUESKY_REPLY_SETTINGS,
  blueskyRepliesOf,
  wantsBlueskyGate,
  sentText,
  effectiveContent,
  needsPublicUrls,
  limitWait,
  PUBLISH_LIMITS,
  nextAction,
  POST_STATUSES,
  postStatus,
  PROVIDERS,
  REMOVE_READY,
  VIDEO_READY,
  publishCallKey,
  publishJobKey,
  scopeNeeded,
  startsNewAttempt,
  TELEGRAM_BUTTON_ROWS_MAX,
  TELEGRAM_BUTTON_TEXT_MAX,
  TELEGRAM_BUTTONS_PER_ROW_MAX,
  TELEGRAM_PIN_SCOPE,
  telegramButtonsOf,
  telegramOptionsOf,
  tiktokDisclosureOf,
  transitionVariant,
  validateVariant,
  VARIANT_STATUSES,
  YOUTUBE_CATEGORIES,
  YOUTUBE_PLAYLIST_ID,
  youtubePlaylistIdFrom,
  youtubePlaylistsOf,
  pinterestSectionOf,
  PINTEREST_SECTION_ID,
  youtubeTagsLength,
  type CallState,
  type HashedVariant,
  type MediaItem,
  type Provider,
  type RetrySafety,
  type VariantEvent,
  type VariantStatus,
} from '../src/index.ts';

const jpeg = (sizeBytes = 100_000): MediaItem => ({ kind: 'image', mime: 'image/jpeg', sizeBytes, durationSeconds: null });
const png = (): MediaItem => ({ kind: 'image', mime: 'image/png', sizeBytes: 100_000, durationSeconds: null });
const mp4 = (durationSeconds = 30, sizeBytes = 10_000_000): MediaItem => ({ kind: 'video', mime: 'video/mp4', sizeBytes, durationSeconds });

describe('video length (#850)', () => {
  it('flags a video whose length could not be read on a channel with a length limit', () => {
    const codes = (provider: 'tiktok' | 'sandbox', durationSeconds: number | null) => validateVariant({ provider, body: 'x', title: null, media: [mp4(durationSeconds as number)] }).map((i) => i.code);
    expect(codes('tiktok', null)).toContain('VIDEO_LENGTH_UNKNOWN');
    expect(codes('tiktok', 30)).not.toContain('VIDEO_LENGTH_UNKNOWN');
  });
});

describe('countText', () => {
  it('counts Vietnamese the same whether typed precomposed or with combining marks', () => {
    const nfc = 'Tiếng Việt';
    const nfd = nfc.normalize('NFD');
    expect(nfd.length).toBeGreaterThan(nfc.length);
    for (const mode of ['utf16', 'codepoints', 'graphemes', 'bytes', 'weighted'] as const) {
      expect(countText(nfd, mode)).toBe(countText(nfc, mode));
    }
    expect(countText(nfc, 'codepoints')).toBe(10);
  });

  it('counts an emoji family as one grapheme but several code points', () => {
    const family = '👨‍👩‍👧';
    expect(countText(family, 'graphemes')).toBe(1);
    expect(countText(family, 'codepoints')).toBe(5);
    expect(countText(family, 'utf16')).toBe(8);
  });

  it('counts the link an adapter adds to the text', () => {
    const link = 'https://example.com/khuyen-mai';
    // Threads appends the link after a blank line: 490 + 2 + 30 is over 500.
    expect(validateVariant({ provider: 'threads', body: 'a'.repeat(490), title: null, media: [], linkUrl: link })).toEqual([{ code: 'TEXT_TOO_LONG', field: 'body', limit: 500, actual: 522 }]);
    expect(validateVariant({ provider: 'threads', body: 'a'.repeat(490), title: null, media: [] })).toEqual([]);
    // A text that already holds the link gets nothing more.
    expect(sentText('threads', `xem ${link}`, link, 0)).toBe(`xem ${link}`);
    // Facebook adds it to the text only with media; Instagram and the sandbox never.
    expect(sentText('facebook_page', 'Bài', link, 0)).toBe('Bài');
    expect(sentText('facebook_page', 'Bài', link, 1)).toBe(`Bài\n\n${link}`);
    expect(sentText('facebook_page', `Bài ${link}`, link, 1)).toBe(`Bài ${link}`);
    // Only the whole link counts as held: a longer URL that starts with it does not, punctuation after it does.
    expect(sentText('threads', `xem ${link}-2`, link, 0)).toBe(`xem ${link}-2\n\n${link}`);
    expect(sentText('threads', `xem ${link}.`, link, 0)).toBe(`xem ${link}.`);
    expect(sentText('instagram', 'Bài', link, 1)).toBe('Bài');
    expect(sentText('linkedin', '  ', link, 0)).toBe(link);
    expect(sentText('linkedin', 'Bài', '', 0)).toBe('Bài');
  });

  it('counts the appended link toward the link limit', () => {
    const body = Array.from({ length: 5 }, (_, i) => `https://a.vn/${i}`).join(' ');
    expect(validateVariant({ provider: 'threads', body, title: null, media: [] }).some((i) => i.code === 'TOO_MANY_LINKS')).toBe(false);
    expect(validateVariant({ provider: 'threads', body, title: null, media: [], linkUrl: 'https://b.vn' }).some((i) => i.code === 'TOO_MANY_LINKS')).toBe(true);
  });

  it("counts as X does: tone-marked letters, CJK and emoji count two, every link 23", () => {
    // ế and ệ are in U+1EA0..U+1EF9 and count two; đ, ơ, à are below U+10FF and count one.
    expect(countText('Tiếng Việt', 'weighted')).toBe(12);
    expect(countText('đơn giá', 'weighted')).toBe(7);
    expect(countText('日本', 'weighted')).toBe(4);
    expect(countText('👨‍👩‍👧', 'weighted')).toBe(2);
    expect(countText('🇻🇳', 'weighted')).toBe(2);
    // Curly quotes are in the ranges that count one; the ellipsis (U+2026) is not.
    expect(countText('“a”…', 'weighted')).toBe(5);
    expect(countText(`xem https://example.com/${'a'.repeat(200)}`, 'weighted')).toBe(4 + 23);
    expect(countText('ghé crove.vn/gia nhé', 'weighted')).toBe(4 + 23 + 4);
    // A full stop after a link is text; © and ® count one; a keycap is one emoji.
    expect(countText('xem https://a.com/x.', 'weighted')).toBe(4 + 23 + 1);
    expect(countText('© ®', 'weighted')).toBe(3);
    expect(countText('1️⃣', 'weighted')).toBe(2);
    expect(countText('giao tại TP.HCM, file.txt, ban@vi-du.vn', 'weighted')).toBe(countText('giao tại TP.HCM, file.txt, ban@vi-du.vn', 'codepoints') + 1);
  });

  it('flags an X post over 280 by X count, not by code points', () => {
    const body = 'ệ'.repeat(141);
    expect(countText(body, 'codepoints')).toBeLessThan(280);
    expect(validateVariant({ provider: 'x', body, title: null, media: [] })).toEqual([{ code: 'TEXT_TOO_LONG', field: 'body', limit: 280, actual: 282 }]);
    expect(validateVariant({ provider: 'x', body: `${'a'.repeat(250)} https://example.com/${'b'.repeat(100)}`, title: null, media: [] })).toEqual([]);
  });

  it('counts UTF-8 bytes', () => {
    expect(countText('đ', 'bytes')).toBe(2);
  });

  it('counts links', () => {
    expect(countLinks('see https://a.vn and http://b.com/x?y=1, not ftp://c')).toBe(2);
    expect(countLinks('no links')).toBe(0);
  });
});

describe('validateVariant', () => {
  it('accepts a plain text post on a Facebook Page', () => {
    expect(validateVariant({ provider: 'facebook_page', body: 'Xin chào', title: null, media: [] })).toEqual([]);
  });

  it('refuses an empty post on every channel', () => {
    for (const provider of PROVIDERS) {
      const codes = validateVariant({ provider, body: '  ', title: null, media: [] }).map((i) => i.code);
      expect(codes).toContain('CONTENT_REQUIRED');
    }
  });

  it('accepts a media-only post on X', () => {
    expect(validateVariant({ provider: 'x', body: '', title: null, media: [jpeg()] })).toEqual([]);
  });

  it('reports a disallowed media kind once, not also as a mix', () => {
    const codes = validateVariant({ provider: 'zalo_oa', body: 'x', title: 'T', media: [jpeg(), mp4()] }).map((i) => i.code);
    expect(codes).toEqual(['MEDIA_KIND_NOT_ALLOWED']);
  });

  it('takes up to 10 images of 1 MB each on a Zalo OA article, and comments on or off (#943)', () => {
    const zalo = (media: MediaItem[], settings: Record<string, unknown> = {}) => validateVariant({ provider: 'zalo_oa', body: 'x', title: 'T', media, settings });
    expect(zalo(Array.from({ length: 4 }, () => jpeg()))).toEqual([]);
    expect(zalo(Array.from({ length: 10 }, () => jpeg()))).toEqual([]);
    expect(zalo(Array.from({ length: 11 }, () => jpeg()))).toEqual([{ code: 'TOO_MANY_MEDIA', field: 'media', limit: 10, actual: 11 }]);
    expect(zalo([jpeg(), jpeg(1024 * 1024 + 1)])).toEqual([{ code: 'IMAGE_TOO_LARGE', field: 'media.1', limit: 1024 * 1024, actual: 1024 * 1024 + 1 }]);
    expect(zalo([jpeg()], { comments: false })).toEqual([]);
    expect(zalo([jpeg()], { comments: true })).toEqual([]);
    expect(zalo([jpeg()], { comments: 'hide' })).toEqual([{ code: 'ZALO_COMMENTS_INVALID', field: 'settings.comments', limit: null, actual: null }]);
  });

  it('takes a silent post and a pin on Telegram only, each true or false (#982)', () => {
    const on = (provider: 'telegram' | 'mastodon', settings: Record<string, unknown>) => validateVariant({ provider, body: 'Khai trương', title: null, media: [], settings });
    expect(on('telegram', {})).toEqual([]);
    expect(on('telegram', { telegram: { silent: true, pin: true } })).toEqual([]);
    expect(on('telegram', { telegram: { pin: false } })).toEqual([]);
    const invalid = [{ code: 'TELEGRAM_INVALID', field: 'settings.telegram', limit: null, actual: null }];
    expect(on('telegram', { telegram: { silent: 'yes' } })).toEqual(invalid);
    expect(on('telegram', { telegram: { pin: true, notify: true } })).toEqual(invalid);
    expect(on('telegram', { telegram: true })).toEqual(invalid);
    expect(on('telegram', { telegram: null })).toEqual(invalid);
    expect(on('mastodon', { telegram: { pin: true } })).toEqual([{ code: 'TELEGRAM_NOT_SUPPORTED', field: 'settings.telegram', limit: null, actual: null }]);
    expect(telegramOptionsOf({ telegram: { pin: true } })).toEqual({ silent: false, pin: true });
    expect(telegramOptionsOf({})).toBeNull();
  });

  it('names the pin right with the scope the Telegram adapter stores at connect (#982)', () => {
    expect(TELEGRAM_PIN_SCOPE).toBe(channel.TELEGRAM_PIN_SCOPE);
  });

  describe('Discord forum posts and threads (#1103)', () => {
    const TAG = '1210000000000000001';
    const THREAD = '1200000000000000001';
    const discord = (settings: Record<string, unknown>, over: { body?: string; title?: string | null; media?: MediaItem[] } = {}) =>
      validateVariant({ provider: 'discord', body: over.body ?? 'Khai trương chi nhánh mới', title: over.title ?? null, media: over.media ?? [], settings });
    const issue = (code: string, field: string, limit: number | null = null, actual: number | null = null) => ({ code, field, limit, actual });

    it('takes a forum post with a name and tags, or a thread id, and leaves a text channel post as it was', () => {
      expect(discord({})).toEqual([]);
      expect(discord({ discord: { forum: true } })).toEqual([]);
      expect(discord({ discord: { forum: true, threadName: 'Thông báo', tags: [TAG, '1210000000000000002'] } })).toEqual([]);
      expect(discord({ discord: { threadId: THREAD } })).toEqual([]);
      // A forum post takes the post title as its name; a text channel post still refuses one.
      expect(discord({ discord: { forum: true } }, { title: 'x'.repeat(300) })).toEqual([]);
      expect(discord({}, { title: 'Tiêu đề' })).toEqual([issue('TITLE_NOT_SUPPORTED', 'title')]);
      expect(discord({ discord: { threadId: THREAD } }, { title: 'Tiêu đề' })).toEqual([issue('TITLE_NOT_SUPPORTED', 'title')]);
    });

    it('refuses a forum post with nothing to name it, and settings Discord would refuse', () => {
      expect(discord({ discord: { forum: true } }, { body: '', media: [jpeg()] })).toEqual([issue('DISCORD_THREAD_NAME_REQUIRED', 'settings.discord.threadName')]);
      expect(discord({ discord: { forum: true } }, { body: '', title: 'Ảnh khai trương', media: [jpeg()] })).toEqual([]);
      expect(discord({ discord: { forum: true, threadName: 'x'.repeat(101) } })).toEqual([issue('DISCORD_THREAD_NAME_TOO_LONG', 'settings.discord.threadName', 100, 101)]);
      expect(discord({ discord: { tags: [TAG] } })).toEqual([issue('DISCORD_FORUM_ONLY', 'settings.discord.forum')]);
      expect(discord({ discord: { threadName: 'Tên' } })).toEqual([issue('DISCORD_FORUM_ONLY', 'settings.discord.forum')]);
      expect(discord({ discord: { forum: true, threadId: THREAD } })).toEqual([issue('DISCORD_THREAD_CONFLICT', 'settings.discord.threadId')]);
      expect(discord({ discord: { forum: true, tags: ['abc', TAG, TAG] } })).toEqual([issue('DISCORD_TAG_INVALID', 'settings.discord.tags.0'), issue('DISCORD_TAG_INVALID', 'settings.discord.tags.2')]);
      const six = Array.from({ length: 6 }, (_, i) => `121000000000000001${i}`);
      expect(discord({ discord: { forum: true, tags: six } })).toEqual([issue('DISCORD_TOO_MANY_TAGS', 'settings.discord.tags', 5, 6)]);
      expect(discord({ discord: { threadId: '12' } })).toEqual([issue('DISCORD_THREAD_ID_INVALID', 'settings.discord.threadId')]);
      for (const raw of [true, null, [], { forum: 'yes' }, { tags: TAG }, { threadId: 12 }, { forum: true, extra: 1 }]) {
        expect(discord({ discord: raw }), JSON.stringify(raw)).toEqual([issue('DISCORD_INVALID', 'settings.discord')]);
      }
      expect(validateVariant({ provider: 'telegram', body: 'x', title: null, media: [], settings: { discord: { forum: true } } })).toEqual([issue('DISCORD_NOT_SUPPORTED', 'settings.discord')]);
    });

    it('names a forum post as the adapter does, with the same limits', () => {
      expect(DISCORD_THREAD_NAME_MAX).toBe(channel.DISCORD_THREAD_NAME_MAX);
      expect(DISCORD_TAGS_MAX).toBe(channel.DISCORD_TAGS_MAX);
      expect(discordThreadName(null, null, '\n  Khai   trương  \nchi tiết')).toBe('Khai trương');
      expect(discordThreadName(' Tên ', 'Tiêu đề', 'x')).toBe('Tên');
      expect(discordThreadName(null, 'Tiêu đề', 'x')).toBe('Tiêu đề');
      expect(discordThreadName(null, null, `${'a'.repeat(99)}\u{1F600}`)).toBe('a'.repeat(99));
      expect(discordThreadName(null, '  ', '')).toBe('');
      fc.assert(
        fc.property(fc.option(fc.string({ unit: 'grapheme', maxLength: 120 })), fc.option(fc.string({ unit: 'grapheme', maxLength: 200 })), fc.string({ unit: 'grapheme', maxLength: 300 }), (own, title, text) => {
          const name = discordThreadName(own, title, text);
          expect(name).toBe(channel.discordThreadName(own, title, text));
          expect(name.length).toBeLessThanOrEqual(DISCORD_THREAD_NAME_MAX);
          // Never half of a surrogate pair at the end.
          expect(/[\uD800-\uDBFF]$/.test(name)).toBe(false);
        }),
      );
      expect(discordOptionsOf({ discord: { forum: true, tags: [TAG] } })).toEqual({ forum: true, threadName: null, tags: [TAG], threadId: null });
      expect(discordOptionsOf({})).toBeNull();
    });
  });

  describe('Telegram link buttons (#1017)', () => {
    const button =(over: Record<string, unknown> = {}) => ({ text: 'Mua ngay', url: 'https://shop.example/pho', ...over });
    const on = (buttons: unknown, media: MediaItem[] = [], provider: 'telegram' | 'mastodon' = 'telegram') => validateVariant({ provider, body: 'Khai trương', title: null, media, settings: { telegram: { buttons } } });
    const issue = (code: string, field: string, limit: number | null = null, actual: number | null = null) => ({ code, field, limit, actual });

    it('takes up to 3 rows of 3 labelled https links on a text, a photo or a video', () => {
      expect(on([[button(), button({ text: 'Zalo', url: 'https://zalo.me/0901234567' })], [button({ text: 'Bản đồ' })]])).toEqual([]);
      expect(on([0, 1, 2].map(() => [button(), button(), button()]))).toEqual([]);
      expect(on([[button()]], [jpeg()])).toEqual([]);
      expect(on([[button()]], [mp4()])).toEqual([]);
      // 64 letters with their marks, typed either way.
      expect(on([[button({ text: 'ắ'.repeat(64).normalize('NFD') })]])).toEqual([]);
      expect(validateVariant({ provider: 'telegram', body: 'x', title: null, media: [], settings: { telegram: { silent: true, pin: true, buttons: [[button()]] } } })).toEqual([]);
    });

    it('refuses javascript:, plain http and other links that are not a web page over https', () => {
      for (const url of ['javascript:alert(1)', 'JavaScript://shop.example/%0aalert(1)', 'http://shop.example/', 'tg://resolve?domain=quanpho', 'https://', 'https://shop.example/a b', ' https://shop.example/', `https://shop.example/${'a'.repeat(2048)}`, 'https://user:pass@shop.example/', 'https://admin@shop.example/', `https://shop.example/a${String.fromCodePoint(0x200b)}b`, `https://shop.example/${String.fromCodePoint(0x7f)}`, `https://shop.example/${String.fromCodePoint(0x2028)}`]) {
        expect(on([[button({ url })]])).toEqual([issue('TELEGRAM_BUTTON_URL_INVALID', 'settings.telegram.buttons.0.0.url')]);
      }
    });

    it('refuses an empty or long label, too many buttons, and buttons on an album', () => {
      expect(on([[button(), button({ text: 'x'.repeat(65) })]])).toEqual([issue('TELEGRAM_BUTTON_TEXT_LENGTH', 'settings.telegram.buttons.0.1.text', 64, 65)]);
      expect(on([[button({ text: '  ' })]])).toEqual([issue('TELEGRAM_BUTTON_TEXT_LENGTH', 'settings.telegram.buttons.0.0.text', 64, 0)]);
      expect(on([[button()], [button(), button(), button(), button()]])).toEqual([issue('TELEGRAM_TOO_MANY_BUTTONS', 'settings.telegram.buttons.1', 3, 4)]);
      expect(on([[button()], [button()], [button()], [button()]])).toEqual([issue('TELEGRAM_TOO_MANY_BUTTONS', 'settings.telegram.buttons', 3, 4)]);
      expect(on([[button()]], [jpeg(), mp4()])).toEqual([issue('TELEGRAM_BUTTONS_ON_ALBUM', 'settings.telegram.buttons', null, 2)]);
    });

    it('refuses buttons that are not rows of { text, url }, and buttons on another channel', () => {
      for (const buttons of [[], [[]], 'Mua ngay', [button()], [[{ text: 'Mua ngay' }]], [[{ ...button(), callback_data: 'x' }]], [[null]]]) {
        expect(on(buttons)).toEqual([issue('TELEGRAM_BUTTONS_INVALID', 'settings.telegram.buttons')]);
      }
      expect(on([[button()]], [], 'mastodon')).toEqual([issue('TELEGRAM_NOT_SUPPORTED', 'settings.telegram')]);
      expect(telegramButtonsOf({ telegram: { buttons: [[button()]] } })).toEqual([[button()]]);
      expect(telegramButtonsOf({ telegram: { pin: true } })).toBeNull();
      expect(telegramButtonsOf({})).toBeNull();
      expect(telegramOptionsOf({ telegram: { buttons: [[button()]] } })).toEqual({ silent: false, pin: false });
    });

    it('names the limits the Telegram adapter sends within', () => {
      expect([TELEGRAM_BUTTON_ROWS_MAX, TELEGRAM_BUTTONS_PER_ROW_MAX, TELEGRAM_BUTTON_TEXT_MAX]).toEqual([channel.TELEGRAM_BUTTON_ROWS_MAX, channel.TELEGRAM_BUTTONS_PER_ROW_MAX, channel.TELEGRAM_BUTTON_TEXT_MAX]);
    });
  });

  it('takes up to 5 distinct playlists on YouTube only, in settings.youtube (#1018)', () => {
    const SALE = 'PLabcdefghijklmnopqrstuvwxyz012345';
    const on = (provider: 'youtube' | 'tiktok', settings: Record<string, unknown>) =>
      validateVariant({ provider, body: '', title: 'Khai trương', media: [{ kind: 'video', mime: 'video/mp4', sizeBytes: 1_000_000, durationSeconds: 30 }], settings }).filter((i) => i.field.startsWith('settings.youtube'));
    const five = Array.from({ length: 5 }, (_, i) => `PL${String(i).repeat(16)}`);
    expect(on('youtube', {})).toEqual([]);
    expect(on('youtube', { youtube: { playlistIds: [SALE] } })).toEqual([]);
    expect(on('youtube', { youtube: { playlistIds: five } })).toEqual([]);
    expect(on('youtube', { youtube: { playlistIds: [...five, SALE] } })).toEqual([{ code: 'YT_PLAYLISTS_TOO_MANY', field: 'settings.youtube.playlistIds', limit: 5, actual: 6 }]);
    const invalid = [{ code: 'YT_PLAYLISTS_INVALID', field: 'settings.youtube.playlistIds', limit: null, actual: null }];
    expect(on('youtube', { youtube: { playlistIds: [SALE, SALE] } })).toEqual(invalid);
    // The uploads playlist (UU...) and liked videos are YouTube's own, never one a video is added to.
    expect(on('youtube', { youtube: { playlistIds: ['UUabcdefghijklmnopqrstuv'] } })).toEqual(invalid);
    expect(on('youtube', { youtube: { playlistIds: SALE } })).toEqual(invalid);
    expect(on('youtube', { youtube: { playlistIds: [SALE], notify: true } })).toEqual(invalid);
    expect(on('youtube', { youtube: [SALE] })).toEqual(invalid);
    expect(on('youtube', { youtube: null })).toEqual(invalid);
    expect(on('tiktok', { youtube: { playlistIds: [SALE] } })).toEqual([{ code: 'YOUTUBE_NOT_SUPPORTED', field: 'settings.youtube', limit: null, actual: null }]);
    expect(youtubePlaylistsOf({ youtube: { playlistIds: [] } })).toBeNull();
    expect(youtubePlaylistsOf({})).toBeNull();
    // The same shape the adapter sends.
    expect(YOUTUBE_PLAYLIST_ID.source).toBe(channel.YOUTUBE_PLAYLIST_ID.source);
  });

  it('takes one board section on Pinterest only, in settings.pinterest (#1120)', () => {
    const SALE = '5027630990032166911';
    const on = (provider: 'pinterest' | 'instagram', settings: Record<string, unknown>) =>
      validateVariant({ provider, body: 'Bánh mì', title: 'Thực đơn', media: [{ kind: 'image', mime: 'image/jpeg', sizeBytes: 100_000, durationSeconds: null }], settings }).filter((i) => i.field.startsWith('settings.pinterest'));
    expect(on('pinterest', {})).toEqual([]);
    expect(on('pinterest', { pinterest: { sectionId: SALE } })).toEqual([]);
    expect(on('pinterest', { pinterest: {} })).toEqual([]);
    const invalid = [{ code: 'PINTEREST_SECTION_INVALID', field: 'settings.pinterest.sectionId', limit: null, actual: null }];
    for (const pinterest of [{ sectionId: 'Khuyến mãi' }, { sectionId: 12345 }, { sectionId: SALE, boardId: '1' }, [SALE], null, SALE]) expect(on('pinterest', { pinterest })).toEqual(invalid);
    expect(on('instagram', { pinterest: { sectionId: SALE } })).toEqual([{ code: 'PINTEREST_NOT_SUPPORTED', field: 'settings.pinterest', limit: null, actual: null }]);
    expect(pinterestSectionOf({ pinterest: { sectionId: SALE } })).toBe(SALE);
    expect(pinterestSectionOf({})).toBeNull();
    // The same shape, and the same reading, as the adapter's.
    expect(PINTEREST_SECTION_ID.source).toBe(channel.PINTEREST_SECTION_ID.source);
    for (const settings of [{}, { pinterest: { sectionId: SALE } }, { pinterest: { sectionId: 'x' } }, { pinterest: {} }]) expect(pinterestSectionOf(settings)).toBe(channel.pinterestSectionOf(settings));
  });

  it('reads the playlist id from what a person pastes (#1018)', () => {
    const SALE = 'PLabcdefghijklmnopqrstuvwxyz012345';
    expect(youtubePlaylistIdFrom(` ${SALE} `)).toBe(SALE);
    expect(youtubePlaylistIdFrom(`https://www.youtube.com/playlist?list=${SALE}`)).toBe(SALE);
    expect(youtubePlaylistIdFrom(`youtube.com/playlist?list=${SALE}&si=abc`)).toBe(SALE);
    expect(youtubePlaylistIdFrom(`https://m.youtube.com/watch?v=dQw4w9WgXcQ&list=${SALE}&index=2`)).toBe(SALE);
    expect(youtubePlaylistIdFrom(`https://youtu.be/dQw4w9WgXcQ?list=${SALE}`)).toBe(SALE);
    expect(youtubePlaylistIdFrom('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBeNull();
    expect(youtubePlaylistIdFrom(`https://example.com/playlist?list=${SALE}`)).toBeNull();
    expect(youtubePlaylistIdFrom('https://www.youtube.com/playlist?list=UUabcdefghijklmnopqrstuv')).toBeNull();
    expect(youtubePlaylistIdFrom('khuyến mãi')).toBeNull();
  });

  it('requires media on Instagram and accepts only JPEG images', () => {
    const codes = (media: MediaItem[]) => validateVariant({ provider: 'instagram', body: 'caption', title: null, media }).map((i) => i.code);
    expect(codes([])).toEqual(['MEDIA_REQUIRED']);
    expect(codes([png()])).toEqual(['IMAGE_TYPE_NOT_ALLOWED']);
    expect(codes([jpeg(), mp4()])).toEqual([]);
    expect(codes([mp4(901)])).toEqual(['VIDEO_TOO_LONG']);
    expect(codes([mp4(60)])).toEqual([]);
    expect(codes(Array.from({ length: 11 }, () => jpeg()))).toEqual(['TOO_MANY_MEDIA']);
  });

  it('flags text over the limit with the limit and the count', () => {
    const body = 'a'.repeat(301);
    expect(validateVariant({ provider: 'bluesky', body, title: null, media: [] })).toEqual([
      { code: 'TEXT_TOO_LONG', field: 'body', limit: 300, actual: 301 },
    ]);
  });

  it('flags Bluesky text within 300 graphemes but over 3000 UTF-8 bytes (#250)', () => {
    // A family emoji is one grapheme of 25 bytes: 200 of them are 5000 bytes.
    const family = '\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}';
    expect(validateVariant({ provider: 'bluesky', body: family.repeat(200), title: null, media: [] })).toEqual([{ code: 'TEXT_TOO_MANY_BYTES', field: 'body', limit: 3000, actual: 5000 }]);
    expect(validateVariant({ provider: 'bluesky', body: family.repeat(120), title: null, media: [] })).toEqual([]);
  });

  it('requires a title where the channel has one and refuses one where it has none', () => {
    const zalo = validateVariant({ provider: 'zalo_oa', body: 'nội dung', title: '', media: [jpeg()] }).map((i) => i.code);
    expect(zalo).toEqual(['TITLE_REQUIRED']);
    const long = validateVariant({ provider: 'zalo_oa', body: 'x', title: 'a'.repeat(151), media: [jpeg()] });
    expect(long).toEqual([{ code: 'TITLE_TOO_LONG', field: 'title', limit: 150, actual: 151 }]);
    const fb = validateVariant({ provider: 'facebook_page', body: 'x', title: 'Tiêu đề', media: [] }).map((i) => i.code);
    expect(fb).toEqual(['TITLE_NOT_SUPPORTED']);
  });

  it("holds Facebook photos to Meta's types and 4 MB", () => {
    const codes = (media: MediaItem[]) => validateVariant({ provider: 'facebook_page', body: 'x', title: null, media }).map((i) => i.code);
    expect(codes([jpeg(), png()])).toEqual([]);
    expect(codes([{ kind: 'image', mime: 'image/webp', sizeBytes: 1000, durationSeconds: null }])).toEqual(['IMAGE_TYPE_NOT_ALLOWED']);
    expect(codes([jpeg(5 * 1024 * 1024)])).toEqual(['IMAGE_TOO_LARGE']);
  });

  it('checks Stories and Reels on the channels that post them (#644)', () => {
    const img = (): MediaItem => ({ kind: 'image', mime: 'image/jpeg', sizeBytes: 1000, durationSeconds: null });
    const vid = (seconds: number): MediaItem => ({ kind: 'video', mime: 'video/mp4', sizeBytes: 1_000_000, durationSeconds: seconds });
    const codes = (provider: 'instagram' | 'facebook_page' | 'x', postType: unknown, media: MediaItem[], extra: Record<string, unknown> = {}, body = 'Chữ không gửi') =>
      validateVariant({ provider, body, title: null, linkUrl: 'https://shop.example/', media, settings: { postType, ...extra } }).map((i) => i.code);
    // A Story: one image or a video of up to a minute; its text and link are not checked, since they are not sent.
    expect(codes('instagram', 'story', [img()], {}, 'x'.repeat(5000))).toEqual([]);
    expect(codes('facebook_page', 'story', [vid(45)])).toEqual([]);
    expect(codes('instagram', 'story', [img(), img()])).toEqual(['STORY_ONE_MEDIA']);
    expect(codes('instagram', 'story', [])).toEqual(['STORY_ONE_MEDIA']);
    expect(codes('instagram', 'story', [vid(61)])).toEqual(['VIDEO_TOO_LONG']);
    expect(codes('instagram', 'story', [img()], { firstComment: 'Mua ngay' })).toEqual(['COMMENT_NOT_SUPPORTED']);
    expect(codes('instagram', 'story', [vid(10)], { cover: { atMs: 1000 } })).toEqual(['COVER_NOT_SUPPORTED']);
    // A Reel: one video, as long as the platform takes; Facebook Reels last at most 90 s.
    expect(codes('facebook_page', 'reel', [vid(60)])).toEqual([]);
    expect(codes('facebook_page', 'reel', [vid(91)])).toEqual(['VIDEO_TOO_LONG']);
    expect(codes('instagram', 'reel', [img()])).toEqual(['REEL_ONE_VIDEO']);
    // Other channels, and unknown types, are refused; a feed post is checked as before.
    expect(codes('x', 'story', [img()])).toEqual(['POST_TYPE_NOT_SUPPORTED']);
    expect(codes('instagram', 'carousel', [img()])).toEqual(['POST_TYPE_NOT_SUPPORTED']);
    expect(codes('instagram', 'feed', [img()])).toEqual([]);
    // A Story image is upright (9:16 passes, the feed's 4:5 and wider do not), whatever the feed takes; an unknown size is not checked.
    const sized = (width: number, height: number): MediaItem => ({ ...img(), width, height });
    expect(codes('instagram', 'story', [sized(1080, 1920)])).toEqual([]);
    expect(codes('facebook_page', 'story', [sized(1080, 2340)])).toEqual([]);
    expect(codes('instagram', 'story', [sized(1080, 1350)])).toEqual(['IMAGE_RATIO_NOT_ALLOWED']);
    expect(codes('facebook_page', 'story', [sized(1920, 1080)])).toEqual(['IMAGE_RATIO_NOT_ALLOWED']);
    expect(codes('instagram', 'story', [sized(180, 320)])).toEqual(['IMAGE_TOO_SMALL']);
  });

  it("holds Instagram and Threads images to their shapes and widths, when the size is known (#636)", () => {
    const img = (width: number | null, height: number | null): MediaItem => ({ kind: 'image', mime: 'image/jpeg', sizeBytes: 1000, durationSeconds: null, width, height });
    const codes = (provider: 'instagram' | 'threads' | 'facebook_page', media: MediaItem[]) => validateVariant({ provider, body: 'x', title: null, media }).map((i) => i.code);
    // 4:5, square and 1.91:1 are Instagram's feed; a pixel off 4:5 still counts.
    expect(codes('instagram', [img(1080, 1350), img(1080, 1080), img(1080, 566), img(1080, 1351)])).toEqual([]);
    const tall = validateVariant({ provider: 'instagram', body: 'x', title: null, media: [img(1080, 1920)] });
    expect(tall).toEqual([{ code: 'IMAGE_RATIO_NOT_ALLOWED', field: 'media.0', limit: null, actual: 563 }]);
    expect(codes('instagram', [img(2000, 800)])).toEqual(['IMAGE_RATIO_NOT_ALLOWED']);
    expect(validateVariant({ provider: 'instagram', body: 'x', title: null, media: [img(200, 200)] })).toEqual([{ code: 'IMAGE_TOO_SMALL', field: 'media.0', limit: 320, actual: 200 }]);
    // Threads takes a 9:16 photo; Facebook any shape; an unknown size is not checked.
    expect(codes('threads', [img(1080, 1920)])).toEqual([]);
    expect(codes('facebook_page', [img(1080, 5000)])).toEqual([]);
    expect(codes('instagram', [img(null, null), { kind: 'image', mime: 'image/jpeg', sizeBytes: 1000, durationSeconds: null }])).toEqual([]);
  });

  it('checks Threads polls and topic tags, and refuses them elsewhere (#711)', () => {
    const codes = (provider: 'threads' | 'facebook_page', settings: Record<string, unknown>, media: MediaItem[] = []) =>
      validateVariant({ provider, body: 'Bạn thích món nào?', title: null, media, settings }).map((i) => i.code);
    const img: MediaItem = { kind: 'image', mime: 'image/jpeg', sizeBytes: 1000, durationSeconds: null };
    expect(codes('threads', { poll: { options: ['Cà phê', 'Trà sữa'] }, topicTag: '#Ăn uống' })).toEqual([]);
    expect(codes('threads', { poll: { options: ['Một'] } })).toEqual(['POLL_OPTIONS']);
    expect(codes('threads', { poll: { options: ['a', 'b', 'c', 'd', 'e'] } })).toEqual(['POLL_OPTIONS']);
    expect(codes('threads', { poll: 'có' })).toEqual(['POLL_OPTIONS']);
    expect(validateVariant({ provider: 'threads', body: 'x', title: null, media: [], settings: { poll: { options: ['a', ' ', 'x'.repeat(26)] } } })).toEqual([
      { code: 'POLL_OPTION_LENGTH', field: 'settings.poll.1', limit: 25, actual: 0 },
      { code: 'POLL_OPTION_LENGTH', field: 'settings.poll.2', limit: 25, actual: 26 },
    ]);
    expect(codes('threads', { poll: { options: ['a', 'b'] } }, [img])).toEqual(['POLL_WITH_MEDIA']);
    expect(codes('threads', { topicTag: 'a.b' })).toEqual(['TOPIC_TAG_INVALID']);
    expect(codes('threads', { topicTag: 'x'.repeat(51) })).toEqual(['TOPIC_TAG_INVALID']);
    expect(codes('threads', { topicTag: '#' })).toEqual(['TOPIC_TAG_INVALID']);
    expect(codes('threads', { topicTag: 7 })).toEqual(['TOPIC_TAG_INVALID']);
    // Any word is a tag, this one too.
    expect(codes('threads', { topicTag: 'invalid' })).toEqual([]);
    expect(codes('facebook_page', { poll: { options: ['a', 'b'] }, topicTag: 'Ăn uống' })).toEqual(['POLL_NOT_SUPPORTED', 'TOPIC_TAG_NOT_SUPPORTED']);
  });

  it('checks X polls with their length and who may reply (#948)', () => {
    const check = (settings: Record<string, unknown>, media: MediaItem[] = []) => validateVariant({ provider: 'x', body: 'Bạn thích bánh nào?', title: null, media, settings });
    const codes = (settings: Record<string, unknown>, media: MediaItem[] = []) => check(settings, media).map((i) => i.code);
    const img: MediaItem = { kind: 'image', mime: 'image/jpeg', sizeBytes: 1000, durationSeconds: null };
    expect(codes({ poll: { options: ['Bánh mì', 'Bánh bao'] } })).toEqual([]);
    expect(codes({ poll: { options: ['Bánh mì', 'Bánh bao', 'Bánh cuốn', 'Bánh xèo'], durationMinutes: 10_080 }, replySettings: 'following' })).toEqual([]);
    expect(codes({ poll: { options: ['a', 'b'], durationMinutes: 5 }, replySettings: 'mentionedUsers' })).toEqual([]);
    expect(codes({ replySettings: 'everyone' })).toEqual([]);
    // 25 Vietnamese letters with tone marks fit: an option counts characters, not X's weighted text count.
    expect(codes({ poll: { options: ['ệ'.repeat(25), 'b'] } })).toEqual([]);
    expect(codes({ poll: { options: ['a', 'b', 'c', 'd', 'e'] } })).toEqual(['POLL_OPTIONS']);
    expect(check({ poll: { options: ['a', 'x'.repeat(26)] } })).toEqual([{ code: 'POLL_OPTION_LENGTH', field: 'settings.poll.1', limit: 25, actual: 26 }]);
    expect(check({ poll: { options: ['a', 'b'], durationMinutes: 4 } })).toEqual([{ code: 'POLL_DURATION', field: 'settings.poll.durationMinutes', limit: 10_080, actual: 4 }]);
    expect(codes({ poll: { options: ['a', 'b'], durationMinutes: 10_081 } })).toEqual(['POLL_DURATION']);
    expect(check({ poll: { options: ['a', 'b'], durationMinutes: '60' } })).toEqual([{ code: 'POLL_DURATION', field: 'settings.poll.durationMinutes', limit: 10_080, actual: null }]);
    expect(codes({ poll: { options: ['a', 'b'] } }, [img])).toEqual(['POLL_WITH_MEDIA']);
    expect(codes({ replySettings: 'verified' })).toEqual(['REPLY_SETTINGS_INVALID']);
    // A Threads poll has no length of its own, so none is checked there.
    expect(validateVariant({ provider: 'threads', body: 'x', title: null, media: [], settings: { poll: { options: ['a', 'b'], durationMinutes: 1 } } })).toEqual([]);
    // Followers is a Threads choice, not an X one.
    expect(codes({ replySettings: 'followers' })).toEqual(['REPLY_SETTINGS_INVALID']);
  });

  it('checks Mastodon polls: up to 4 options of 50 characters, 5 minutes to a month, several answers and hidden counts (#1118)', () => {
    const check = (settings: Record<string, unknown>, media: MediaItem[] = []) => validateVariant({ provider: 'mastodon', body: 'Bạn thích món nào?', title: null, media, settings });
    const codes = (settings: Record<string, unknown>, media: MediaItem[] = []) => check(settings, media).map((i) => i.code);
    const img: MediaItem = { kind: 'image', mime: 'image/jpeg', sizeBytes: 1000, durationSeconds: null };
    expect(codes({ poll: { options: ['Phở', 'Bún chả'] } })).toEqual([]);
    expect(codes({ poll: { options: ['Phở', 'Bún chả', 'Cơm tấm', 'x'.repeat(50)], durationMinutes: 43_829, multiple: true, hideTotals: true } })).toEqual([]);
    expect(check({ poll: { options: ['a', 'b', 'c', 'd', 'e'] } })).toEqual([{ code: 'POLL_OPTIONS', field: 'settings.poll', limit: 4, actual: 5 }]);
    expect(check({ poll: { options: ['a', 'x'.repeat(51)] } })).toEqual([{ code: 'POLL_OPTION_LENGTH', field: 'settings.poll.1', limit: 50, actual: 51 }]);
    expect(check({ poll: { options: ['a', 'b'], durationMinutes: 4 } })).toEqual([{ code: 'POLL_DURATION', field: 'settings.poll.durationMinutes', limit: 43_829, actual: 4 }]);
    expect(codes({ poll: { options: ['a', 'b'], durationMinutes: 43_830 } })).toEqual(['POLL_DURATION']);
    expect(check({ poll: { options: ['a', 'b'], multiple: 'có' } })).toEqual([{ code: 'POLL_SETTING_INVALID', field: 'settings.poll.multiple', limit: null, actual: null }]);
    expect(check({ poll: { options: ['a', 'b'], question: 'Món nào?' } })).toEqual([{ code: 'POLL_SETTING_NOT_SUPPORTED', field: 'settings.poll.question', limit: null, actual: null }]);
    expect(codes({ poll: { options: ['a', 'b'] } }, [img])).toEqual(['POLL_WITH_MEDIA']);
  });

  it('checks Telegram polls: the text with its link as the question, up to 12 options of 100 characters, open until stopped (#1118)', () => {
    const check = (settings: Record<string, unknown>, body = 'Bạn thích món nào?', linkUrl: string | null = null, media: MediaItem[] = []) => validateVariant({ provider: 'telegram', body, title: null, media, linkUrl, settings });
    const codes = (...args: Parameters<typeof check>) => check(...args).map((i) => i.code);
    const img: MediaItem = { kind: 'image', mime: 'image/jpeg', sizeBytes: 1000, durationSeconds: null };
    const twelve = Array.from({ length: 12 }, (_, i) => `Món ${i + 1}`);
    expect(codes({ poll: { options: ['Phở', 'Bún chả'] } })).toEqual([]);
    expect(codes({ poll: { options: twelve, durationMinutes: 43_800, multiple: true, hideTotals: false }, telegram: { silent: true, pin: true } })).toEqual([]);
    expect(codes({ poll: { options: ['a', 'b'], durationMinutes: 1 } }, 'x'.repeat(300))).toEqual([]);
    expect(check({ poll: { options: [...twelve, 'Món 13'] } })).toEqual([{ code: 'POLL_OPTIONS', field: 'settings.poll', limit: 12, actual: 13 }]);
    expect(check({ poll: { options: ['a', 'x'.repeat(101)] } })).toEqual([{ code: 'POLL_OPTION_LENGTH', field: 'settings.poll.1', limit: 100, actual: 101 }]);
    expect(check({ poll: { options: ['a', 'b'], durationMinutes: 43_801 } })).toEqual([{ code: 'POLL_DURATION', field: 'settings.poll.durationMinutes', limit: 43_800, actual: 43_801 }]);
    // The question is the text as sent, its link included.
    expect(check({ poll: { options: ['a', 'b'] } }, 'x'.repeat(301))).toEqual([{ code: 'POLL_TEXT_LENGTH', field: 'body', limit: 300, actual: 301 }]);
    expect(check({ poll: { options: ['a', 'b'] } }, 'x'.repeat(290), 'https://example.com/menu')).toEqual([{ code: 'POLL_TEXT_LENGTH', field: 'body', limit: 300, actual: 316 }]);
    expect(codes({ poll: { options: ['a', 'b'] } }, 'Món mới', null, [img])).toEqual(['POLL_WITH_MEDIA']);
    expect(codes({ poll: { options: ['a', 'b'], question: 'Món nào?' } })).toEqual(['POLL_SETTING_NOT_SUPPORTED']);
  });

  it('checks LinkedIn polls for members and pages: a question of its own, 2 to 4 options of 30 characters, 1, 3, 7 or 14 days (#1118)', () => {
    for (const provider of ['linkedin', 'linkedin_page'] as const) {
      const check = (settings: Record<string, unknown>, media: MediaItem[] = []) => validateVariant({ provider, body: 'Chúng tôi sắp mở chi nhánh mới.', title: null, media, settings });
      const codes = (settings: Record<string, unknown>, media: MediaItem[] = []) => check(settings, media).map((i) => i.code);
      const poll = { question: 'Chi nhánh tiếp theo ở đâu?', options: ['Quận 1', 'Thủ Đức'] };
      expect(codes({ poll })).toEqual([]);
      for (const durationMinutes of [1440, 4320, 10_080, 20_160]) expect(codes({ poll: { ...poll, durationMinutes } })).toEqual([]);
      expect(codes({ poll: { ...poll, question: 'ệ'.repeat(140), options: ['a', 'b', 'c', 'x'.repeat(30)] } })).toEqual([]);
      expect(check({ poll: { ...poll, durationMinutes: 2880 } })).toEqual([{ code: 'POLL_DURATION', field: 'settings.poll.durationMinutes', limit: 20_160, actual: 2880 }]);
      expect(check({ poll: { options: poll.options } })).toEqual([{ code: 'POLL_QUESTION_LENGTH', field: 'settings.poll.question', limit: 140, actual: 0 }]);
      expect(check({ poll: { ...poll, question: '  ' } })).toEqual([{ code: 'POLL_QUESTION_LENGTH', field: 'settings.poll.question', limit: 140, actual: 0 }]);
      expect(check({ poll: { ...poll, question: 'x'.repeat(141) } })).toEqual([{ code: 'POLL_QUESTION_LENGTH', field: 'settings.poll.question', limit: 140, actual: 141 }]);
      expect(check({ poll: { ...poll, question: 7 } })).toEqual([{ code: 'POLL_SETTING_INVALID', field: 'settings.poll.question', limit: null, actual: null }]);
      expect(check({ poll: { ...poll, options: ['a', 'x'.repeat(31)] } })).toEqual([{ code: 'POLL_OPTION_LENGTH', field: 'settings.poll.1', limit: 30, actual: 31 }]);
      expect(codes({ poll: { ...poll, options: ['a', 'b', 'c', 'd', 'e'] } })).toEqual(['POLL_OPTIONS']);
      // One answer per voter, counts always shown: false is LinkedIn's way, true is refused.
      expect(codes({ poll: { ...poll, multiple: false, hideTotals: false } })).toEqual([]);
      expect(check({ poll: { ...poll, multiple: true, hideTotals: true } })).toEqual([
        { code: 'POLL_SETTING_NOT_SUPPORTED', field: 'settings.poll.multiple', limit: null, actual: null },
        { code: 'POLL_SETTING_NOT_SUPPORTED', field: 'settings.poll.hideTotals', limit: null, actual: null },
      ]);
      expect(codes({ poll }, [{ kind: 'image', mime: 'image/jpeg', sizeBytes: 1000, durationSeconds: null }])).toEqual(['POLL_WITH_MEDIA']);
    }
    // X keeps to its own: no question of its own, one answer per voter.
    expect(validateVariant({ provider: 'x', body: 'x', title: null, media: [], settings: { poll: { options: ['a', 'b'], multiple: true } } }).map((i) => i.code)).toEqual(['POLL_SETTING_NOT_SUPPORTED']);
  });

  it('takes where a Reel shows on Instagram Reels only, and refuses it on other posts and channels (#1019)', () => {
    const check = (provider: 'instagram' | 'facebook_page', media: MediaItem[], settings: Record<string, unknown>) =>
      validateVariant({ provider, body: 'Khai trương', title: null, media, settings }).filter((i) => i.field.startsWith('settings.instagram'));
    for (const reelFeed of IG_REEL_FEEDS) expect(check('instagram', [mp4()], { instagram: { reelFeed } })).toEqual([]);
    for (const trialGraduation of IG_TRIAL_GRADUATIONS) expect(check('instagram', [mp4()], { instagram: { reelFeed: 'trial', trialGraduation } })).toEqual([]);
    expect(check('instagram', [mp4()], { postType: 'reel', instagram: { reelFeed: 'reels_only' } })).toEqual([]);
    expect(check('instagram', [mp4()], {})).toEqual([]);
    const notReel = [{ code: 'IG_REEL_FEED_NOT_REEL', field: 'settings.instagram.reelFeed', limit: null, actual: null }];
    expect(check('instagram', [jpeg()], { instagram: { reelFeed: 'reels_only' } })).toEqual(notReel);
    expect(check('instagram', [mp4(), jpeg()], { instagram: { reelFeed: 'trial' } })).toEqual(notReel);
    expect(check('instagram', [mp4()], { postType: 'story', instagram: { reelFeed: 'reels_only' } })).toEqual(notReel);
    expect(check('instagram', [], { instagram: { reelFeed: 'trial' } })).toEqual(notReel);
    const invalid = [{ code: 'IG_REEL_FEED_INVALID', field: 'settings.instagram', limit: null, actual: null }];
    for (const instagram of [{ reelFeed: 'grid' }, { reelFeed: null }, { reelFeed: 'reels_only', trialGraduation: 'manual' }, { reelFeed: 'trial', trialGraduation: 'SS_PERFORMANCE' }, { reelFeed: 'trial', notify: true }, 'trial', null, ['trial']]) {
      expect(check('instagram', [mp4()], { instagram })).toEqual(invalid);
    }
    expect(check('facebook_page', [mp4()], { instagram: { reelFeed: 'reels_only' } })).toEqual([{ code: 'INSTAGRAM_NOT_SUPPORTED', field: 'settings.instagram', limit: null, actual: null }]);
    expect(instagramReelOf({})).toBeNull();
    expect(instagramReelOf({ instagram: { reelFeed: 'trial' } })).toEqual({ reelFeed: 'trial', trialGraduation: 'manual' });
    expect(instagramReelOf({ instagram: {} })).toEqual({ reelFeed: 'feed', trialGraduation: null });
    expect(instagramReelOffGrid({ instagram: { reelFeed: 'reels_only' } })).toBe(true);
    expect(instagramReelOffGrid({ instagram: { reelFeed: 'trial' } })).toBe(true);
    expect(instagramReelOffGrid({ instagram: { reelFeed: 'feed' } })).toBe(false);
    expect(instagramReelOffGrid({ instagram: 'trial' })).toBe(false);
    expect(instagramReelOffGrid({})).toBe(false);
    // The adapter sends every value the composer offers, and refuses what validation refuses.
    for (const reelFeed of IG_REEL_FEEDS) expect(channel.instagramReelFormOf({ instagram: { reelFeed } })).not.toBe('invalid');
    for (const trialGraduation of IG_TRIAL_GRADUATIONS) expect(channel.instagramReelFormOf({ instagram: { reelFeed: 'trial', trialGraduation } })).not.toBe('invalid');
    expect(channel.instagramReelFormOf({ instagram: { reelFeed: 'reels_only', trialGraduation: 'manual' } })).toBe('invalid');
  });

  it('checks who may reply to a Threads post and who sees a LinkedIn post (#983)', () => {
    const check = (provider: 'threads' | 'linkedin' | 'facebook_page', settings: Record<string, unknown>) => validateVariant({ provider, body: 'Khai trương', title: null, media: [], settings });
    for (const replySettings of ['everyone', 'following', 'mentionedUsers', 'followers']) expect(check('threads', { replySettings })).toEqual([]);
    expect(check('threads', { replySettings: 'accounts_you_follow' })).toEqual([{ code: 'REPLY_SETTINGS_INVALID', field: 'settings.replySettings', limit: null, actual: null }]);
    expect(check('threads', { replySettings: 7 }).map((i) => i.code)).toEqual(['REPLY_SETTINGS_INVALID']);
    for (const visibility of ['public', 'connections', 'loggedIn']) expect(check('linkedin', { visibility })).toEqual([]);
    expect(check('linkedin', {})).toEqual([]);
    expect(check('linkedin', { visibility: 'CONNECTIONS' })).toEqual([{ code: 'VISIBILITY_INVALID', field: 'settings.visibility', limit: null, actual: null }]);
    expect(check('linkedin', { visibility: 'unlisted' }).map((i) => i.code)).toEqual(['VISIBILITY_INVALID']);
    // A channel without these settings ignores them, as before.
    expect(check('facebook_page', { replySettings: 'followers', visibility: 'connections' })).toEqual([]);
    expect(replySettingOf('threads', { replySettings: 'followers' })).toBe('followers');
    expect(replySettingOf('x', { replySettings: 'followers' })).toBeNull();
    expect(replySettingOf('threads', { replySettings: 'everyone' })).toBeNull();
    expect(replySettingOf('linkedin', { replySettings: 'following' })).toBeNull();
    // The adapters take every value the composer offers.
    for (const replySettings of THREADS_REPLY_SETTINGS) expect(channel.threadsReplyControlOf({ replySettings })).not.toBe('invalid');
    for (const visibility of LINKEDIN_VISIBILITY) expect(channel.linkedinVisibilityOf({ visibility })).not.toBe('invalid');
  });

  it('checks who may reply to and quote a Bluesky post, several groups together, and refuses quotes elsewhere (#1102)', () => {
    const check = (provider: 'bluesky' | 'threads' | 'x', settings: Record<string, unknown>) => validateVariant({ provider, body: 'Khai trương', title: null, media: [], settings });
    for (const replySettings of [...BLUESKY_REPLY_SETTINGS, ['followers', 'mentionedUsers'], [...BLUESKY_REPLY_RULES]]) expect(check('bluesky', { replySettings })).toEqual([]);
    expect(check('bluesky', { quotes: false })).toEqual([]);
    expect(check('bluesky', { replySettings: 'nobody', quotes: true })).toEqual([]);
    expect(check('bluesky', {})).toEqual([]);
    for (const replySettings of ['mentioned_only', [], ['following', 'following'], ['nobody'], 'everyone,following', 3]) {
      expect(check('bluesky', { replySettings })).toEqual([{ code: 'REPLY_SETTINGS_INVALID', field: 'settings.replySettings', limit: null, actual: null }]);
    }
    expect(check('bluesky', { quotes: 'no' })).toEqual([{ code: 'QUOTES_INVALID', field: 'settings.quotes', limit: null, actual: null }]);
    expect(check('threads', { quotes: false })).toEqual([{ code: 'QUOTES_NOT_SUPPORTED', field: 'settings.quotes', limit: null, actual: null }]);
    // Nobody and a list are Bluesky's alone.
    expect(check('threads', { replySettings: 'nobody' }).map((i) => i.code)).toEqual(['REPLY_SETTINGS_INVALID']);
    expect(check('x', { replySettings: ['following'] }).map((i) => i.code)).toEqual(['REPLY_SETTINGS_INVALID']);
    expect(blueskyRepliesOf({ replySettings: ['followers', 'mentionedUsers'] })).toEqual(['mentionedUsers', 'followers']);
    expect(blueskyRepliesOf({ replySettings: 'following' })).toEqual(['following']);
    expect(blueskyRepliesOf({ replySettings: 'everyone' })).toBeNull();
    expect(blueskyRepliesOf({ replySettings: 'nobody' })).toBe('nobody');
    // A gate is asked for only when something is limited, on Bluesky, with readable settings.
    expect(wantsBlueskyGate('bluesky', {})).toBe(false);
    expect(wantsBlueskyGate('bluesky', { replySettings: 'everyone', quotes: true })).toBe(false);
    expect(wantsBlueskyGate('bluesky', { quotes: false })).toBe(true);
    expect(wantsBlueskyGate('bluesky', { replySettings: 'nobody' })).toBe(true);
    expect(wantsBlueskyGate('bluesky', { replySettings: 'nobody', quotes: 'no' })).toBe(false);
    expect(wantsBlueskyGate('threads', { replySettings: 'following' })).toBe(false);
    // The adapter reads every value the composer offers the same way, and refuses what validation refuses.
    for (const replySettings of [...BLUESKY_REPLY_SETTINGS, ['followers', 'mentionedUsers']]) {
      const replies = blueskyRepliesOf({ replySettings });
      const gates = channel.blueskyGatesOf({ replySettings });
      expect(gates === null ? null : gates === 'invalid' ? 'invalid' : gates.allow?.length === 0 ? 'nobody' : gates.allow).toEqual(replies);
    }
    for (const replySettings of ['mentioned_only', [], ['following', 'following']]) expect(channel.blueskyGatesOf({ replySettings })).toBe('invalid');
    expect(channel.blueskyGatesOf({ quotes: 'no' })).toBe('invalid');
    expect([...channel.BLUESKY_REPLY_RULES]).toEqual([...BLUESKY_REPLY_RULES]);
  });

  it('checks Google Business Profile posts, and refuses their settings elsewhere (#709)', () => {
    const codes = (provider: 'google_business' | 'facebook_page', gbp: unknown, linkUrl: string | null = 'https://tiembanh.example/') =>
      validateVariant({ provider, body: 'Bánh mới', title: null, media: [], linkUrl, settings: { gbp } }).map((i) => i.code);
    const day = { startDate: '2026-09-25', endDate: '2026-09-26' };
    expect(codes('google_business', { topic: 'STANDARD', cta: 'ORDER' })).toEqual([]);
    expect(codes('google_business', { topic: 'EVENT', event: { title: 'Trung thu', ...day, startTime: '18:30' } })).toEqual([]);
    expect(codes('google_business', { topic: 'OFFER', event: day, offer: { couponCode: 'SALE' } })).toEqual([]);
    expect(codes('google_business', { topic: 'EVENT', event: day })).toEqual(['GBP_INVALID']);
    expect(codes('google_business', { topic: 'OFFER', event: { startDate: '2026-09-26', endDate: '2026-09-25' } })).toEqual(['GBP_INVALID']);
    expect(codes('google_business', { topic: 'EVENT', event: { title: 'x', ...day, startTime: '25:00' } })).toEqual(['GBP_INVALID']);
    expect(codes('google_business', { topic: 'PRODUCT' })).toEqual(['GBP_INVALID']);
    // The post's language (#730): one Google takes, Vietnamese when unsaid.
    expect(codes('google_business', { language: 'en' })).toEqual([]);
    expect(codes('google_business', { language: 'english' })).toEqual(['GBP_INVALID']);
    expect(codes('google_business', { cta: 'SHOP' }, null)).toEqual(['GBP_CTA_NEEDS_LINK']);
    expect(codes('google_business', { cta: 'CALL' }, null)).toEqual([]);
    expect(codes('facebook_page', { topic: 'STANDARD' })).toEqual(['GBP_NOT_SUPPORTED']);
    // One photo at most, JPEG or PNG; no video.
    const photo = (mime: string): MediaItem => ({ kind: 'image', mime, sizeBytes: 1000, durationSeconds: null });
    expect(validateVariant({ provider: 'google_business', body: 'x', title: null, media: [photo('image/jpeg'), photo('image/png')] }).map((i) => i.code)).toEqual(['TOO_MANY_MEDIA']);
    expect(validateVariant({ provider: 'google_business', body: 'x', title: null, media: [photo('image/webp')] }).map((i) => i.code)).toEqual(['IMAGE_TYPE_NOT_ALLOWED']);
    expect(validateVariant({ provider: 'google_business', body: 'x'.repeat(1501), title: null, media: [] }).map((i) => i.code)).toEqual(['TEXT_TOO_LONG']);
  });
  it('refuses images mixed with video where the channel does not mix them', () => {
    const codes = validateVariant({ provider: 'facebook_page', body: '', title: null, media: [jpeg(), mp4()] }).map((i) => i.code);
    expect(codes).toEqual(['MEDIA_MIX_NOT_ALLOWED']);
  });

  it('checks media kinds, sizes and durations', () => {
    const yt = validateVariant({ provider: 'youtube', body: '', title: 'Video', media: [jpeg()] }).map((i) => i.code);
    expect(yt).toEqual(['MEDIA_KIND_NOT_ALLOWED']);
    const zaloBig = validateVariant({ provider: 'zalo_oa', body: 'x', title: 'T', media: [jpeg(2 * 1024 * 1024)] }).map((i) => i.code);
    expect(zaloBig).toEqual(['IMAGE_TOO_LARGE']);
    const tiktokLong = validateVariant({ provider: 'tiktok', body: '', title: null, media: [mp4(601)] }).map((i) => i.code);
    expect(tiktokLong).toEqual(['VIDEO_TOO_LONG', 'PRIVACY_REQUIRED']);
    const tiktokOk = validateVariant({ provider: 'tiktok', body: '', title: null, media: [mp4(30)], settings: { privacyLevel: 'SELF_ONLY' } });
    expect(tiktokOk).toEqual([]);
    // TikTok photo posts (#710): JPEG or WebP, up to 35, never with a video.
    const tiktok = (media: MediaItem[]) => validateVariant({ provider: 'tiktok', body: '', title: null, media, settings: { privacyLevel: 'SELF_ONLY' } }).map((i) => i.code);
    expect(tiktok([jpeg(), jpeg()])).toEqual([]);
    expect(tiktok([{ ...jpeg(), mime: 'image/png' }])).toEqual(['IMAGE_TYPE_NOT_ALLOWED']);
    expect(tiktok(Array.from({ length: 36 }, () => jpeg()))).toEqual(['TOO_MANY_MEDIA']);
    // A photo post's description takes 4,000 characters; a video's caption keeps 2,200.
    const long = (media: MediaItem[], n: number) => validateVariant({ provider: 'tiktok', body: 'x'.repeat(n), title: null, media, settings: { privacyLevel: 'SELF_ONLY' } }).map((i) => i.code);
    expect(long([jpeg()], 4000)).toEqual([]);
    expect(long([jpeg()], 4001)).toEqual(['TEXT_TOO_LONG']);
    expect(long([{ kind: 'video', mime: 'video/mp4', sizeBytes: 1000, durationSeconds: 10 }], 2201)).toEqual(['TEXT_TOO_LONG']);
  });

  it('asks no privacy level of a TikTok draft sent to the inbox, and no cover (#903)', () => {
    const tt = (settings: Record<string, unknown>, media: MediaItem[] = [mp4(30)]) => validateVariant({ provider: 'tiktok', body: 'Khai trương', title: null, media, settings }).map((i) => i.code);
    expect(tt({ tiktokMode: 'inbox' })).toEqual([]);
    expect(tt({ tiktokMode: 'inbox' }, [jpeg(), jpeg()])).toEqual([]);
    // Direct, stored or by default, still needs it, as variants saved before #903 did.
    expect(tt({})).toEqual(['PRIVACY_REQUIRED']);
    expect(tt({ tiktokMode: 'direct' })).toEqual(['PRIVACY_REQUIRED']);
    expect(tt({ tiktokMode: 'direct', privacyLevel: 'SELF_ONLY' })).toEqual([]);
    expect(tt({ tiktokMode: 'draft', privacyLevel: 'SELF_ONLY' })).toEqual(['TIKTOK_MODE_INVALID']);
    expect(tt({ tiktokMode: 'inbox', cover: { atMs: 1000 } })).toEqual(['COVER_NOT_SUPPORTED']);
    expect(tt({ privacyLevel: 'SELF_ONLY', cover: { atMs: 1000 } })).toEqual([]);
    // Only an inbox draft needs video.upload on its connection.
    expect(scopeNeeded('tiktok', { tiktokMode: 'inbox' })).toBe('video.upload');
    expect(scopeNeeded('tiktok', {})).toBeNull();
    expect(scopeNeeded('youtube', { tiktokMode: 'inbox' })).toBeNull();
  });

  it('checks a Mastodon post: 500 characters by default, its visibility and content warning (#748)', () => {
    const md = (body: string, settings: Record<string, unknown> = {}) => validateVariant({ provider: 'mastodon', body, title: null, media: [], settings }).map((i) => i.code);
    expect(md('x'.repeat(500))).toEqual([]);
    expect(md('x'.repeat(501))).toEqual(['TEXT_TOO_LONG']);
    expect(md('Khai trương', { visibility: 'unlisted', contentWarning: 'Đồ ăn' })).toEqual([]);
    expect(md('Khai trương', { visibility: 'direct' })).toEqual(['VISIBILITY_INVALID']);
    expect(md('Khai trương', { contentWarning: 'x'.repeat(501) })).toEqual(['CONTENT_WARNING_TOO_LONG']);
    expect(md('Khai trương', { contentWarning: 7 })).toEqual(['CONTENT_WARNING_TOO_LONG']);
  });

  it('checks a YouTube video: its audience, a category from the assignable list and tags as YouTube counts them (#905)', () => {
    const yt = (settings: Record<string, unknown>) => validateVariant({ provider: 'youtube', body: '', title: 'Khai trương', media: [mp4()], settings });
    const codes = (settings: Record<string, unknown>) => yt(settings).map((i) => i.code);
    // A variant saved before these settings existed is fine as it is.
    expect(codes({})).toEqual([]);
    expect(codes({ madeForKids: true, categoryId: '27', tags: ['bánh mì', 'Sài Gòn', 'ẩm-thực'] })).toEqual([]);
    expect(codes({ madeForKids: false, categoryId: '22' })).toEqual([]);
    expect(codes({ madeForKids: 'yes' })).toEqual(['YT_AUDIENCE_INVALID']);
    // 18 (Short Movies) is listed by YouTube but not assignable; a number is not a category id.
    expect(codes({ categoryId: '18' })).toEqual(['YT_CATEGORY_INVALID']);
    expect(codes({ categoryId: 22 })).toEqual(['YT_CATEGORY_INVALID']);
    expect(yt({ tags: 'bánh mì' })).toEqual([{ code: 'YT_TAG_INVALID', field: 'settings.tags', limit: null, actual: null }]);
    expect(yt({ tags: ['phở', ' ', 'a<b>'] }).map((i) => i.field)).toEqual(['settings.tags.1', 'settings.tags.2']);
    // 500 characters in all: a Vietnamese letter with its marks is one, composed or not.
    expect(codes({ tags: ['ệ'.repeat(500)] })).toEqual([]);
    expect(codes({ tags: ['ệ'.normalize('NFD').repeat(500)] })).toEqual([]);
    expect(yt({ tags: ['ệ'.repeat(501)] })).toEqual([{ code: 'YT_TAGS_TOO_LONG', field: 'settings.tags', limit: 500, actual: 501 }]);
    // A tag with a space counts its two quotes, and every comma between tags counts.
    expect(codes({ tags: [`${'ệ'.repeat(248)} ${'ệ'.repeat(249)}`] })).toEqual([]);
    expect(yt({ tags: [`${'ệ'.repeat(249)} ${'ệ'.repeat(249)}`] })[0]).toMatchObject({ code: 'YT_TAGS_TOO_LONG', actual: 501 });
    expect(yt({ tags: Array.from({ length: 100 }, () => 'ẩmthực') })[0]).toMatchObject({ code: 'YT_TAGS_TOO_LONG', actual: 100 * 6 + 99 });
  });

  it('takes the altered or synthetic content disclosure on a YouTube video as true or false (#1078)', () => {
    const codes = (settings: Record<string, unknown>) => validateVariant({ provider: 'youtube', body: '', title: 'Khai trương', media: [mp4()], settings }).map((i) => i.code);
    expect(codes({ syntheticMedia: true })).toEqual([]);
    expect(codes({ syntheticMedia: false })).toEqual([]);
    expect(codes({ syntheticMedia: 'yes' })).toEqual(['YT_SYNTHETIC_INVALID']);
  });

  it("checks TikTok's commercial content and AI labels: a choice when on, never branded and private, none on a draft (#1078)", () => {
    const tt = (settings: Record<string, unknown>, provider: Provider = 'tiktok') =>
      validateVariant({ provider, body: 'Khai trương', title: null, media: [mp4()], settings }).filter((i) => i.field.startsWith('settings.tiktok'));
    const pub = { privacyLevel: 'PUBLIC_TO_EVERYONE' };
    // A variant saved before #1078 has none and is fine as it is.
    expect(tt(pub)).toEqual([]);
    expect(tt({ ...pub, tiktok: { commercial: true, yourBrand: true } })).toEqual([]);
    expect(tt({ ...pub, tiktok: { commercial: true, brandedContent: true, yourBrand: true, aiGenerated: true } })).toEqual([]);
    expect(tt({ privacyLevel: 'SELF_ONLY', tiktok: { aiGenerated: true, commercial: true, yourBrand: true } })).toEqual([]);
    expect(tt({ ...pub, tiktok: { commercial: true } })).toEqual([{ code: 'TIKTOK_COMMERCIAL_CHOOSE', field: 'settings.tiktok.commercial', limit: null, actual: null }]);
    expect(tt({ privacyLevel: 'SELF_ONLY', tiktok: { commercial: true, brandedContent: true } })).toEqual([{ code: 'TIKTOK_BRANDED_PRIVATE', field: 'settings.tiktok.brandedContent', limit: null, actual: null }]);
    const invalid = [{ code: 'TIKTOK_DISCLOSURE_INVALID', field: 'settings.tiktok', limit: null, actual: null }];
    expect(tt({ ...pub, tiktok: { brandedContent: 'yes' } })).toEqual(invalid);
    expect(tt({ ...pub, tiktok: { paidPartnership: true } })).toEqual(invalid);
    expect(tt({ ...pub, tiktok: null })).toEqual(invalid);
    expect(tt({ tiktokMode: 'inbox', tiktok: { aiGenerated: true } })).toEqual([{ code: 'TIKTOK_DISCLOSURE_INBOX', field: 'settings.tiktok', limit: null, actual: null }]);
    expect(tt({ tiktok: { aiGenerated: true } }, 'youtube')).toEqual([{ code: 'TIKTOK_NOT_SUPPORTED', field: 'settings.tiktok', limit: null, actual: null }]);
    expect(tiktokDisclosureOf({ tiktok: { brandedContent: true } })).toEqual({ commercial: true, yourBrand: false, brandedContent: true, aiGenerated: false });
    expect(tiktokDisclosureOf({})).toBeNull();
    // The adapter reads the same shapes the same way.
    for (const tiktok of [{ commercial: true }, { yourBrand: true }, { brandedContent: true, aiGenerated: true }, { aiGenerated: false }, { paid: true }, { yourBrand: 1 }, [], null]) {
      expect(channel.tiktokDisclosureOf({ tiktok })).toEqual(tiktokDisclosureOf({ tiktok }));
    }
  });

  it('counts YouTube tags as YouTube does: quotes around a tag with a space, commas between tags (#905)', () => {
    expect(youtubeTagsLength([])).toBe(0);
    expect(youtubeTagsLength(['Foo-Baz'])).toBe(7);
    expect(youtubeTagsLength(['Foo Baz'])).toBe(9);
    expect(youtubeTagsLength(['bánh mì', 'cà-phê'])).toBe(9 + 1 + 6);
    // Counted trimmed, as the adapter sends it.
    expect(youtubeTagsLength(['  phở  '])).toBe(3);
    expect(YOUTUBE_CATEGORIES).toContain('22');
    expect(YOUTUBE_CATEGORIES).not.toContain('18');
  });

  it('checks a WordPress post: text required, an optional title, up to 10 images and no video (#833)', () => {
    const wp = (body: string, title: string | null, media: MediaItem[] = []) => validateVariant({ provider: 'wordpress', body, title, media, settings: {} }).map((i) => i.code);
    expect(wp('x'.repeat(100_000), null)).toEqual([]);
    expect(wp('x'.repeat(100_001), null)).toEqual(['TEXT_TOO_LONG']);
    expect(wp('Khai trương', 'Thực đơn', Array.from({ length: 10 }, () => jpeg()))).toEqual([]);
    expect(wp('Khai trương', 'x'.repeat(201))).toEqual(['TITLE_TOO_LONG']);
    expect(wp('', 'Thực đơn', [jpeg()])).toEqual(['TEXT_REQUIRED']);
    expect(wp('Khai trương', null, Array.from({ length: 11 }, () => jpeg()))).toEqual(['TOO_MANY_MEDIA']);
    expect(wp('Khai trương', null, [mp4()])).toEqual(['MEDIA_KIND_NOT_ALLOWED']);
  });

  it('checks WordPress categories, tags, excerpt and status (#981)', () => {
    const wp = (wordpress: unknown, provider: 'wordpress' | 'mastodon' = 'wordpress') => validateVariant({ provider, body: 'Khai trương', title: provider === 'wordpress' ? 'Thực đơn' : null, media: [], settings: { wordpress } });
    expect(wp({ categories: ['Tin tức', 'Khuyến mãi & Quà'], tags: ['bánh mì'], excerpt: 'Món mới tháng 10', status: 'draft' })).toEqual([]);
    expect(wp({ status: 'pending' })).toEqual([]);
    expect(wp({ status: 'publish', excerpt: 'ư'.repeat(500) })).toEqual([]);
    expect(wp({ categories: ['Tin tức'] }, 'mastodon')).toEqual([{ code: 'WORDPRESS_NOT_SUPPORTED', field: 'settings.wordpress', limit: null, actual: null }]);
    expect(wp(['Tin tức'])).toEqual([{ code: 'WORDPRESS_INVALID', field: 'settings.wordpress', limit: null, actual: null }]);
    expect(wp({ categories: Array.from({ length: 11 }, (_, i) => `c${i}`) })).toEqual([{ code: 'WORDPRESS_TOO_MANY_CATEGORIES', field: 'settings.wordpress.categories', limit: 10, actual: 11 }]);
    expect(wp({ tags: Array.from({ length: 21 }, (_, i) => `t${i}`) })).toEqual([{ code: 'WORDPRESS_TOO_MANY_TAGS', field: 'settings.wordpress.tags', limit: 20, actual: 21 }]);
    expect(wp({ tags: ['bánh mì', ' ', '<b>', 'x'.repeat(201)] }).map((i) => i.field)).toEqual(['settings.wordpress.tags.1', 'settings.wordpress.tags.2', 'settings.wordpress.tags.3']);
    expect(wp({ categories: 'Tin tức' })).toEqual([{ code: 'WORDPRESS_TERM_INVALID', field: 'settings.wordpress.categories', limit: 200, actual: null }]);
    expect(wp({ excerpt: 'ư'.repeat(501) })).toEqual([{ code: 'WORDPRESS_EXCERPT_TOO_LONG', field: 'settings.wordpress.excerpt', limit: 500, actual: 501 }]);
    expect(wp({ status: 'private' })).toEqual([{ code: 'WORDPRESS_STATUS_INVALID', field: 'settings.wordpress.status', limit: null, actual: null }]);
  });

  it('gives a Telegram post with media the caption limit of 1,024, and text alone 4,096 (#747)', () => {
    const tg = (media: MediaItem[], n: number) => validateVariant({ provider: 'telegram', body: 'x'.repeat(n), title: null, media, settings: {} }).map((i) => i.code);
    expect(tg([], 4096)).toEqual([]);
    expect(tg([], 4097)).toEqual(['TEXT_TOO_LONG']);
    expect(tg([jpeg()], 1024)).toEqual([]);
    expect(tg([jpeg()], 1025)).toEqual(['TEXT_TOO_LONG']);
    expect(tg([jpeg(), { kind: 'video', mime: 'video/mp4', sizeBytes: 1000, durationSeconds: 10 }], 10)).toEqual([]);
    expect(tg(Array.from({ length: 11 }, () => jpeg()), 10)).toEqual(['TOO_MANY_MEDIA']);
  });

  it('checks a Discord post: 2,000 characters, up to 10 images and videos of 10 MB each (#832)', () => {
    const dc = (media: MediaItem[], n: number) => validateVariant({ provider: 'discord', body: 'x'.repeat(n), title: null, media, settings: {} }).map((i) => i.code);
    expect(dc([], 2000)).toEqual([]);
    expect(dc([], 2001)).toEqual(['TEXT_TOO_LONG']);
    expect(dc([jpeg(), mp4(30, 5_000_000)], 2000)).toEqual([]);
    expect(dc(Array.from({ length: 11 }, () => jpeg()), 10)).toEqual(['TOO_MANY_MEDIA']);
    expect(dc([jpeg(10 * 1024 * 1024 + 1)], 10)).toEqual(['IMAGE_TOO_LARGE']);
    expect(dc([mp4(30, 10 * 1024 * 1024 + 1)], 10)).toEqual(['VIDEO_TOO_LARGE']);
  });

  it('posts video on every channel that takes it', () => {
    expect(validateVariant({ provider: 'facebook_page', body: '', title: null, media: [mp4()] }).map((i) => i.code)).toEqual([]);
    expect(validateVariant({ provider: 'linkedin', body: '', title: null, media: [mp4()] }).map((i) => i.code)).toEqual([]);
    expect(validateVariant({ provider: 'pinterest', body: '', title: null, media: [mp4()] }).map((i) => i.code)).toEqual([]);
    // VIDEO_NOT_SUPPORTED_YET stays for a platform added before its adapter learns video; none is left today.
    for (const p of PROVIDERS) if (CAPABILITIES[p].media.kinds.includes('video')) expect(VIDEO_READY.has(p), p).toBe(true);
    expect(validateVariant({ provider: 'sandbox', body: '', title: null, media: [mp4()] })).toEqual([]);
  });

  it('limits links on Threads', () => {
    const body = Array.from({ length: 6 }, (_, i) => `https://e${i}.vn`).join(' ');
    expect(validateVariant({ provider: 'threads', body, title: null, media: [] })).toEqual([
      { code: 'TOO_MANY_LINKS', field: 'body', limit: 5, actual: 6 },
    ]);
  });

  it('has capabilities for every provider, keyed by provider', () => {
    for (const p of PROVIDERS) expect(CAPABILITIES[p].provider).toBe(p);
  });

  it('flags text exactly one past the limit and accepts text at the limit', () => {
    // Lengths around each limit, in characters that count differently per mode (ASCII, Vietnamese, emoji).
    const limited = PROVIDERS.filter((p) => CAPABILITIES[p].body.max !== null);
    fc.assert(
      fc.property(fc.constantFrom(...limited), fc.constantFrom('a', 'ệ', '😀'), fc.integer({ min: -2, max: 2 }), (provider, unit, delta) => {
        const rule = CAPABILITIES[provider].body;
        const max = rule.max ?? 0;
        // Each unit counts the same in every mode on its own and when repeated (no unit joins its neighbor).
        const body = unit.repeat(Math.max(0, Math.floor((max + delta) / countText(unit, rule.count))));
        const tooLong = validateVariant({ provider, body, title: null, media: [] }).some((i) => i.code === 'TEXT_TOO_LONG');
        expect(tooLong).toBe(countText(body, rule.count) > max);
        if (delta >= 1 && countText(unit, rule.count) === 1) expect(tooLong).toBe(true);
        if (delta <= 0) expect(tooLong).toBe(false);
      }),
      { numRuns: 60 },
    );
  });
});

describe('variant lifecycle', () => {
  const events: VariantEvent[] = [
    { type: 'edit' },
    { type: 'submit' },
    { type: 'approve' },
    { type: 'request_changes' },
    { type: 'reject' },
    { type: 'schedule' },
    { type: 'unschedule' },
    { type: 'cancel' },
    { type: 'pause' },
    { type: 'resume' },
    { type: 'start' },
    { type: 'accepted' },
    { type: 'pending' },
    { type: 'failed' },
    { type: 'rate_limited' },
    { type: 'unknown' },
    { type: 'needs_human' },
    { type: 'held_too_long' },
    { type: 'reconciled', found: true },
    { type: 'reconciled', found: false },
    { type: 'retry' },
    { type: 'drop' },
    { type: 'confirm_published' },
    { type: 'removed' },
  ];

  function run(from: VariantStatus, path: VariantEvent[]): VariantStatus {
    let s = from;
    for (const e of path) {
      const t = transitionVariant(s, e);
      if (!t.ok) throw new Error(`${s} --${e.type}--> refused`);
      s = t.status;
    }
    return s;
  }

  it('walks review, schedule and publish', () => {
    expect(run('draft', [{ type: 'submit' }, { type: 'approve' }, { type: 'schedule' }, { type: 'start' }, { type: 'accepted' }])).toBe('published');
    expect(run('draft', [{ type: 'submit' }, { type: 'request_changes' }, { type: 'edit' }, { type: 'submit' }, { type: 'approve' }])).toBe('approved');
    expect(run('draft', [{ type: 'submit' }, { type: 'reject' }, { type: 'submit' }])).toBe('in_review');
  });

  it('sends an edited reviewed, approved or scheduled variant back to draft', () => {
    for (const from of ['in_review', 'approved', 'scheduled', 'paused', 'failed'] as const) expect(run(from, [{ type: 'edit' }])).toBe('draft');
  });

  it('sends an approved, scheduled or paused variant back to review when its channel asks for more approvals, and nothing else', () => {
    for (const from of ['approved', 'scheduled', 'paused'] as const) expect(run(from, [{ type: 'regate' }])).toBe('in_review');
    for (const s of VARIANT_STATUSES) expect(transitionVariant(s, { type: 'regate' }).ok).toBe(['approved', 'scheduled', 'paused'].includes(s));
  });

  it('never edits or cancels a variant in flight, waiting on a human, or history', () => {
    for (const s of ['publishing', 'processing', 'ambiguous', 'needs_attention', 'published', 'cancelled', 'removed'] as const) {
      expect(transitionVariant(s, { type: 'edit' }).ok).toBe(false);
      expect(transitionVariant(s, { type: 'cancel' }).ok).toBe(false);
    }
  });

  it('reaches publishing only through an approval since the last edit', () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...events), { maxLength: 40 }), (path) => {
        let s: VariantStatus = 'draft';
        let approved = false;
        for (const e of path) {
          const t = transitionVariant(s, e);
          if (!t.ok) continue;
          if (e.type === 'approve') approved = true;
          if (t.status === 'draft' || t.status === 'in_review' || t.status === 'changes_requested' || t.status === 'rejected') approved = false;
          if (t.status === 'publishing') expect(approved).toBe(true);
          s = t.status;
        }
      }),
    );
  });

  it('fails only a scheduled variant a publishing hold kept too long, which a person may then retry or edit (#946)', () => {
    for (const s of VARIANT_STATUSES) expect(transitionVariant(s, { type: 'held_too_long' }).ok).toBe(s === 'scheduled');
    expect(run('scheduled', [{ type: 'held_too_long' }, { type: 'retry' }])).toBe('scheduled');
    expect(run('scheduled', [{ type: 'held_too_long' }, { type: 'edit' }])).toBe('draft');
  });

  it('resolves an unknown outcome by reconciliation or a human, never by a direct restart', () => {
    expect(transitionVariant('publishing', { type: 'unknown' })).toEqual({ ok: true, status: 'ambiguous' });
    expect(transitionVariant('ambiguous', { type: 'reconciled', found: true })).toEqual({ ok: true, status: 'published' });
    expect(transitionVariant('ambiguous', { type: 'reconciled', found: false })).toEqual({ ok: true, status: 'needs_attention' });
    expect(transitionVariant('ambiguous', { type: 'start' }).ok).toBe(false);
    expect(transitionVariant('ambiguous', { type: 'retry' }).ok).toBe(false);
    expect(transitionVariant('publishing', { type: 'needs_human' })).toEqual({ ok: true, status: 'needs_attention' });
    expect(transitionVariant('needs_attention', { type: 'retry' })).toEqual({ ok: true, status: 'scheduled' });
    expect(transitionVariant('needs_attention', { type: 'drop' })).toEqual({ ok: true, status: 'cancelled' });
    // A person who found the post on the platform records it; nothing else is confirmed by hand.
    expect(transitionVariant('needs_attention', { type: 'confirm_published' })).toEqual({ ok: true, status: 'published' });
    for (const s of ['failed', 'ambiguous', 'publishing', 'scheduled'] as const) expect(transitionVariant(s, { type: 'confirm_published' }).ok).toBe(false);
  });

  it('reschedules a rate-limited call and pauses on an expired token, but never once the provider accepted it', () => {
    expect(transitionVariant('publishing', { type: 'rate_limited' })).toEqual({ ok: true, status: 'scheduled' });
    expect(transitionVariant('publishing', { type: 'pause' })).toEqual({ ok: true, status: 'paused' });
    expect(transitionVariant('processing', { type: 'rate_limited' }).ok).toBe(false);
    expect(transitionVariant('processing', { type: 'pause' }).ok).toBe(false);
  });

  it('starts a new attempt on every return to scheduled after a publish began', () => {
    // A same-attempt return to scheduled would meet its own failed call in the ledger and never call again.
    for (const from of VARIANT_STATUSES) {
      if (from === 'approved') continue;
      for (const e of events) {
        const t = transitionVariant(from, e);
        if (t.ok && t.status === 'scheduled') expect(startsNewAttempt(e), `${from} --${e.type}-->`).toBe(true);
      }
    }
    expect(startsNewAttempt({ type: 'schedule' })).toBe(false);
  });

  it('never leaves published but by a confirmed removal, and never leaves removed (#860)', () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...events), { maxLength: 40 }), (path) => {
        let s: VariantStatus = path.length % 2 === 0 ? 'scheduled' : 'publishing';
        for (const e of path) {
          const t = transitionVariant(s, e);
          if (!t.ok) continue;
          if (s === 'removed') throw new Error(`left removed via ${e.type}`);
          if (s === 'published' && !(e.type === 'removed' && t.status === 'removed')) throw new Error(`left published via ${e.type}`);
          s = t.status;
        }
      }),
    );
  });

  it('removes only a published variant, and keeps a removed one as history (#860)', () => {
    for (const s of VARIANT_STATUSES) expect(transitionVariant(s, { type: 'removed' }).ok).toBe(s === 'published');
    expect(transitionVariant('removed', { type: 'edit' }).ok).toBe(false);
    expect(transitionVariant('removed', { type: 'cancel' }).ok).toBe(false);
    expect(transitionVariant('removed', { type: 'retry' }).ok).toBe(false);
  });

  it('starts a publish only from scheduled', () => {
    for (const s of VARIANT_STATUSES) expect(transitionVariant(s, { type: 'start' }).ok).toBe(s === 'scheduled');
  });
});

describe('REMOVE_READY (#860)', () => {
  it('names exactly the providers whose adapter takes a post down', () => {
    const exported: unknown[] = Object.values(channel);
    const adapters = exported.filter((x): x is { name: string; prototype: { remove?: unknown } } => typeof x === 'function' && x.name.endsWith('Publisher'));
    const removers = adapters.filter((a) => typeof a.prototype.remove === 'function').map((a) => a.name);
    expect(removers.sort()).toEqual(['BlueskyPublisher', 'DiscordPublisher', 'MastodonPublisher', 'SandboxPublisher', 'TelegramPublisher', 'XPublisher']);
    expect([...REMOVE_READY].sort()).toEqual(['bluesky', 'discord', 'mastodon', 'sandbox', 'telegram', 'x']);
  });
});

describe('postStatus', () => {
  it('summarizes the variants', () => {
    expect(postStatus([])).toBe('draft');
    expect(postStatus(['draft', 'approved'])).toBe('draft');
    expect(postStatus(['scheduled', 'paused'])).toBe('scheduled');
    expect(postStatus(['scheduled', 'publishing'])).toBe('publishing');
    expect(postStatus(['published', 'needs_attention'])).toBe('publishing');
    expect(postStatus(['published', 'scheduled'])).toBe('partially_published');
    expect(postStatus(['published', 'failed'])).toBe('partially_published');
    expect(postStatus(['published', 'cancelled'])).toBe('published');
    expect(postStatus(['failed', 'cancelled'])).toBe('failed');
    expect(postStatus(['cancelled', 'cancelled'])).toBe('cancelled');
    // A removed channel counts like a cancelled one (#860): the post says what is still live.
    expect(postStatus(['published', 'removed'])).toBe('published');
    expect(postStatus(['failed', 'removed'])).toBe('failed');
    expect(postStatus(['removed', 'cancelled'])).toBe('cancelled');
    expect(postStatus(['removed'])).toBe('cancelled');
  });

  it('always answers a known status', () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...VARIANT_STATUSES), { maxLength: 8 }), (vs) => {
        expect(POST_STATUSES).toContain(postStatus(vs));
        if (vs.some((v) => ['publishing', 'processing', 'ambiguous', 'needs_attention'].includes(v))) expect(postStatus(vs)).toBe('publishing');
      }),
    );
  });
});

describe('effectiveContent', () => {
  it('inherits the base where the variant has no override, and keeps an empty override', () => {
    const base = { body: 'Gốc', title: 'Tiêu đề', linkUrl: 'https://a.vn' };
    expect(effectiveContent(base, { body: null, title: null, linkUrl: null })).toEqual(base);
    expect(effectiveContent(base, { body: 'Riêng', title: '', linkUrl: null })).toEqual({ body: 'Riêng', title: '', linkUrl: 'https://a.vn' });
  });

  it('keeps a frozen variant’s own content, where null means none', () => {
    const base = { body: 'Gốc', title: 'Tiêu đề', linkUrl: 'https://a.vn' };
    expect(effectiveContent(base, { body: 'Đã đăng', title: null, linkUrl: null }, true)).toEqual({ body: 'Đã đăng', title: null, linkUrl: null });
  });
});

describe('contentHash and approvalCovers', () => {
  const base: HashedVariant = {
    channelConnectionId: 'c-1',
    provider: 'facebook_page',
    body: 'Khuyến mãi tháng 10',
    title: null,
    linkUrl: 'https://crove.example/sale',
    media: [{ fileId: 'f-1', generation: 's3:v1', altText: null }],
    settings: { a: 1, b: { c: true } },
  };
  const other: HashedVariant = { ...base, channelConnectionId: 'c-2', provider: 'instagram', settings: {} };

  it('ignores variant order, key order and Unicode normalization', () => {
    const h = contentHash([base, other]);
    expect(contentHash([other, base])).toBe(h);
    expect(contentHash([{ ...base, settings: { b: { c: true }, a: 1 } }, other])).toBe(h);
    expect(contentHash([{ ...base, body: base.body.normalize('NFD') }, other])).toBe(h);
    expect(h).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('changes with anything a reader could see', () => {
    const h = contentHash([base]);
    expect(contentHash([{ ...base, body: base.body + '!' }])).not.toBe(h);
    expect(contentHash([{ ...base, linkUrl: null }])).not.toBe(h);
    expect(contentHash([{ ...base, media: [{ fileId: 'f-1', generation: 's3:v2', altText: null }] }])).not.toBe(h);
    expect(contentHash([{ ...base, settings: { a: 2, b: { c: true } } }])).not.toBe(h);
  });

  it('covers only the exact revision and content', () => {
    const post = { revision: 3, contentHash: contentHash([base]) };
    expect(approvalCovers({ revision: 3, contentHash: post.contentHash }, post)).toBe(true);
    expect(approvalCovers({ revision: 2, contentHash: post.contentHash }, post)).toBe(false);
    expect(approvalCovers({ revision: 3, contentHash: contentHash([other]) }, post)).toBe(false);
    expect(approvalCovers(null, post)).toBe(false);
  });

  it('counts the approvals of the current content in the open review round, each person once', () => {
    const cur = { revision: 4, contentHash: contentHash([base]) };
    const old = contentHash([other]);
    const d = (decision: string, decidedBy: string, revision = 4, hash = cur.contentHash) => ({ decision, decidedBy, revision, contentHash: hash });
    // Newest first.
    expect(approvalsInRound([d('approved', 'b'), d('approved', 'a'), d('approved', 'a')], cur)).toEqual(['b', 'a']);
    // An approval of another revision or other content never counts.
    expect(approvalsInRound([d('approved', 'b'), d('approved', 'a', 3), d('approved', 'c', 4, old)], cur)).toEqual(['b']);
    // A request for changes or a rejection ends the round before it.
    expect(approvalsInRound([d('approved', 'b'), d('changes_requested', 'c'), d('approved', 'a')], cur)).toEqual(['b']);
    expect(approvalsInRound([d('rejected', 'c'), d('approved', 'a')], cur)).toEqual([]);
    expect(approvalsInRound([], cur)).toEqual([]);
  });

  it('refuses values JSON would change silently', () => {
    const withSettings = (settings: Record<string, unknown>) => () => contentHash([{ ...base, settings }]);
    expect(withSettings({ a: Number.NaN })).toThrow(/unsupported number/);
    expect(withSettings({ a: -0 })).toThrow(/unsupported number/);
    expect(withSettings({ a: [undefined] })).toThrow(/undefined/);
    expect(withSettings({ a: new Date(1) })).toThrow(/plain object/);
    expect(withSettings({ a: new Map() })).toThrow(/plain object/);
    expect(withSettings({ a: 1n })).toThrow(/unsupported bigint/);
    expect(() => contentHash([base, base])).toThrow(/two variants/);
  });

  it('keeps a __proto__ key from parsed JSON in the hash', () => {
    const parsed = JSON.parse('{"__proto__":{"x":1}}') as Record<string, unknown>;
    expect(contentHash([{ ...base, settings: parsed }])).not.toBe(contentHash([{ ...base, settings: {} }]));
  });

  it('treats an undefined property as missing', () => {
    expect(contentHash([{ ...base, settings: { a: 1, b: { c: true }, d: undefined } }])).toBe(contentHash([base]));
  });
});

describe('nextAction', () => {
  const states: CallState[] = ['none', 'started', 'succeeded', 'failed', 'ambiguous'];
  const safeties: RetrySafety[] = ['safe', 'idempotent', 'reconcile_only', 'never'];

  it('matches the plan: one visible call per attempt unless the step is safe to repeat', () => {
    const table: Record<CallState, Record<RetrySafety, string>> = {
      none: { safe: 'call', idempotent: 'call', reconcile_only: 'call', never: 'call' },
      started: { safe: 'call', idempotent: 'call', reconcile_only: 'reconcile', never: 'manual' },
      ambiguous: { safe: 'call', idempotent: 'call', reconcile_only: 'reconcile', never: 'manual' },
      succeeded: { safe: 'done', idempotent: 'done', reconcile_only: 'done', never: 'done' },
      failed: { safe: 'done', idempotent: 'done', reconcile_only: 'done', never: 'done' },
    };
    for (const state of states) for (const safety of safeties) expect(nextAction(state, safety)).toBe(table[state][safety]);
  });

  it('builds deterministic keys, fresh for a new attempt, and refuses malformed parts', () => {
    expect(publishCallKey('v-1', 2, 1, 'create_container')).toBe('social.publish:v-1:2:1:create_container');
    expect(publishCallKey('v-1', 2, 2, 'create_container')).not.toBe(publishCallKey('v-1', 2, 1, 'create_container'));
    expect(publishJobKey('o-1', 'v-1', 2, 1)).toBe('o-1:v-1:2:1');
    expect(() => publishCallKey('v-1', 0, 1, 'publish')).toThrow();
    expect(() => publishCallKey('v-1', 1, 0, 'publish')).toThrow();
    expect(() => publishCallKey('v-1', 1, 1, 'Publish:x')).toThrow();
    expect(() => publishCallKey('v:1', 1, 1, 'publish')).toThrow();
    expect(() => publishJobKey('o:1', 'v-1', 1, 1)).toThrow();
  });
});

describe('counted publishing limits (#775)', () => {
  const now = new Date('2026-10-21T10:00:00Z');
  const ago = (ms: number) => new Date(now.getTime() - ms);
  it('lets a post go while the window has room, and says when the oldest counted post leaves it', () => {
    const limit = { count: 3, windowMs: 60 * 60_000 };
    expect(limitWait([], limit, now)).toBeNull();
    expect(limitWait([ago(10 * 60_000), ago(20 * 60_000)], limit, now)).toBeNull();
    // Three in the hour, the oldest 50 minutes ago: room again in 10 minutes (and a second).
    expect(limitWait([ago(10 * 60_000), ago(30 * 60_000), ago(50 * 60_000)], limit, now)).toEqual(new Date(now.getTime() + 10 * 60_000 + 1000));
    // Posts older than the window do not count.
    expect(limitWait([ago(10 * 60_000), ago(30 * 60_000), ago(70 * 60_000)], limit, now)).toBeNull();
    // With more than the limit in the window, the one that must leave is the count-th newest.
    expect(limitWait([ago(5 * 60_000), ago(10 * 60_000), ago(30 * 60_000), ago(50 * 60_000)], limit, now)).toEqual(new Date(now.getTime() + 30 * 60_000 + 1000));
  });
  it('counts the platforms without a quota endpoint', () => {
    expect(Object.keys(PUBLISH_LIMITS).sort()).toEqual(['linkedin', 'tiktok', 'x', 'youtube']);
    expect(PUBLISH_LIMITS.youtube).toEqual({ count: 100, windowMs: 24 * 3_600_000 });
  });
});

describe('media fetched by URL (#772)', () => {
  const image = { kind: 'image' as const };
  const video = { kind: 'video' as const };
  it('names what a deployment without public file URLs cannot post', () => {
    expect(needsPublicUrls('instagram', [video])).toBe(false);
    expect(needsPublicUrls('instagram', [image])).toBe(true);
    expect(needsPublicUrls('instagram', [video, video])).toBe(true);
    expect(needsPublicUrls('instagram', [video], { cover: { fileId: 'c' } })).toBe(true);
    expect(needsPublicUrls('instagram', [video], { cover: { atMs: 1000 } })).toBe(false);
    for (const p of ['threads', 'google_business', 'zalo_oa'] as const) expect(needsPublicUrls(p, [image])).toBe(true);
    expect(needsPublicUrls('tiktok', [video])).toBe(false);
    expect(needsPublicUrls('tiktok', [image])).toBe(true);
    for (const p of ['facebook_page', 'x', 'linkedin', 'bluesky', 'telegram', 'mastodon', 'youtube'] as const) expect(needsPublicUrls(p, [image, video])).toBe(false);
    expect(needsPublicUrls('threads', [])).toBe(false);
  });
});
