// Social domain layer (issue #231): channel rules, lifecycles, approval hash, publish decisions.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  approvalCovers,
  approvalsInRound,
  CAPABILITIES,
  contentHash,
  countLinks,
  countText,
  sentText,
  effectiveContent,
  nextAction,
  POST_STATUSES,
  postStatus,
  PROVIDERS,
  publishCallKey,
  publishJobKey,
  startsNewAttempt,
  transitionVariant,
  validateVariant,
  VARIANT_STATUSES,
  type CallState,
  type HashedVariant,
  type MediaItem,
  type RetrySafety,
  type VariantEvent,
  type VariantStatus,
} from '../src/index.ts';

const jpeg = (sizeBytes = 100_000): MediaItem => ({ kind: 'image', mime: 'image/jpeg', sizeBytes, durationSeconds: null });
const png = (): MediaItem => ({ kind: 'image', mime: 'image/png', sizeBytes: 100_000, durationSeconds: null });
const mp4 = (durationSeconds = 30, sizeBytes = 10_000_000): MediaItem => ({ kind: 'video', mime: 'video/mp4', sizeBytes, durationSeconds });

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
    expect(codes).toEqual(['TOO_MANY_MEDIA', 'MEDIA_KIND_NOT_ALLOWED']);
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
    // TikTok's photo mode is not built: images are flagged before they are approved.
    const tiktokPhoto = validateVariant({ provider: 'tiktok', body: '', title: null, media: [jpeg()], settings: { privacyLevel: 'SELF_ONLY' } }).map((i) => i.code);
    expect(tiktokPhoto).toEqual(['IMAGES_NOT_SUPPORTED_YET']);
  });

  it('says when a channel takes video but its Crove adapter does not post it yet', () => {
    expect(validateVariant({ provider: 'facebook_page', body: '', title: null, media: [mp4()] }).map((i) => i.code)).toEqual([]);
    expect(validateVariant({ provider: 'linkedin', body: '', title: null, media: [mp4()] }).map((i) => i.code)).toEqual([]);
    expect(validateVariant({ provider: 'bluesky', body: '', title: null, media: [mp4()] }).map((i) => i.code)).toEqual(['VIDEO_NOT_SUPPORTED_YET']);
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
    { type: 'reconciled', found: true },
    { type: 'reconciled', found: false },
    { type: 'retry' },
    { type: 'drop' },
    { type: 'confirm_published' },
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

  it('never edits or cancels a variant in flight, waiting on a human, or history', () => {
    for (const s of ['publishing', 'processing', 'ambiguous', 'needs_attention', 'published', 'cancelled'] as const) {
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

  it('never leaves published', () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...events), { maxLength: 40 }), (path) => {
        let s: VariantStatus = path.length % 2 === 0 ? 'scheduled' : 'publishing';
        let published = false;
        for (const e of path) {
          const t = transitionVariant(s, e);
          if (!t.ok) continue;
          if (published) throw new Error(`left published via ${e.type}`);
          s = t.status;
          if (s === 'published') published = true;
        }
      }),
    );
  });

  it('starts a publish only from scheduled', () => {
    for (const s of VARIANT_STATUSES) expect(transitionVariant(s, { type: 'start' }).ok).toBe(s === 'scheduled');
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
