// Social domain layer (issue #231): channel rules, lifecycles, approval hash, publish decisions.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  approvalCovers,
  CAPABILITIES,
  contentHash,
  countLinks,
  countText,
  nextAction,
  postOutcome,
  PROVIDERS,
  publishCallKey,
  publishJobKey,
  startsNewAttempt,
  transitionPost,
  transitionVariant,
  validateVariant,
  VARIANT_STATUSES,
  type CallState,
  type HashedVariant,
  type MediaItem,
  type PostEvent,
  type PostStatus,
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
    for (const mode of ['utf16', 'codepoints', 'graphemes', 'bytes'] as const) {
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
    expect(codes(Array.from({ length: 11 }, () => jpeg()))).toEqual(['TOO_MANY_MEDIA']);
  });

  it('flags text over the limit with the limit and the count', () => {
    const body = 'a'.repeat(301);
    expect(validateVariant({ provider: 'bluesky', body, title: null, media: [] })).toEqual([
      { code: 'TEXT_TOO_LONG', field: 'body', limit: 300, actual: 301 },
    ]);
  });

  it('requires a title where the channel has one and refuses one where it has none', () => {
    const zalo = validateVariant({ provider: 'zalo_oa', body: 'nội dung', title: '', media: [jpeg()] }).map((i) => i.code);
    expect(zalo).toEqual(['TITLE_REQUIRED']);
    const long = validateVariant({ provider: 'zalo_oa', body: 'x', title: 'a'.repeat(151), media: [jpeg()] });
    expect(long).toEqual([{ code: 'TITLE_TOO_LONG', field: 'title', limit: 150, actual: 151 }]);
    const fb = validateVariant({ provider: 'facebook_page', body: 'x', title: 'Tiêu đề', media: [] }).map((i) => i.code);
    expect(fb).toEqual(['TITLE_NOT_SUPPORTED']);
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
    expect(tiktokLong).toEqual(['VIDEO_TOO_LONG']);
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

describe('post lifecycle', () => {
  const events: PostEvent[] = [
    { type: 'edit' },
    { type: 'submit' },
    { type: 'approve' },
    { type: 'reject' },
    { type: 'schedule' },
    { type: 'unschedule' },
    { type: 'cancel' },
    { type: 'start_publishing' },
    { type: 'resume_publishing' },
    { type: 'finish', outcome: 'published' },
    { type: 'finish', outcome: 'partially_published' },
    { type: 'finish', outcome: 'failed' },
  ];

  function run(from: PostStatus, path: PostEvent[]): PostStatus {
    let s = from;
    for (const e of path) {
      const t = transitionPost(s, e);
      if (!t.ok) throw new Error(`${s} --${e.type}--> refused`);
      s = t.status;
    }
    return s;
  }

  it('walks the happy path', () => {
    expect(
      run('draft', [{ type: 'submit' }, { type: 'approve' }, { type: 'schedule' }, { type: 'start_publishing' }, { type: 'finish', outcome: 'published' }]),
    ).toBe('published');
  });

  it('sends an edited approved or scheduled post back to draft', () => {
    expect(run('approved', [{ type: 'edit' }])).toBe('draft');
    expect(run('scheduled', [{ type: 'edit' }])).toBe('draft');
  });

  it('resumes publishing when a human retries a variant of a failed or partly published post', () => {
    expect(transitionPost('failed', { type: 'resume_publishing' })).toEqual({ ok: true, status: 'publishing' });
    expect(transitionPost('partially_published', { type: 'resume_publishing' })).toEqual({ ok: true, status: 'publishing' });
    expect(transitionPost('published', { type: 'resume_publishing' }).ok).toBe(false);
  });

  it('never edits or cancels a post while it publishes or after it published', () => {
    for (const s of ['publishing', 'published', 'partially_published', 'cancelled'] as const) {
      expect(transitionPost(s, { type: 'edit' }).ok).toBe(false);
      expect(transitionPost(s, { type: 'cancel' }).ok).toBe(false);
    }
  });

  it('reaches publishing only through approved and scheduled', () => {
    // Property: in any sequence of accepted events from draft, start_publishing is accepted only right after the
    // post was scheduled, and scheduling only from approved, so no path publishes without an approval.
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...events), { maxLength: 30 }), (path) => {
        let s: PostStatus = 'draft';
        let approvedSinceEdit = false;
        for (const e of path) {
          const t = transitionPost(s, e);
          if (!t.ok) continue;
          if (e.type === 'approve') approvedSinceEdit = true;
          if (t.status === 'draft') approvedSinceEdit = false;
          if (t.status === 'publishing') expect(approvedSinceEdit).toBe(true);
          s = t.status;
        }
      }),
    );
  });
});

describe('variant lifecycle', () => {
  const events: VariantEvent[] = [
    { type: 'schedule' },
    { type: 'unschedule' },
    { type: 'cancel' },
    { type: 'pause' },
    { type: 'resume' },
    { type: 'start' },
    { type: 'accepted' },
    { type: 'pending' },
    { type: 'rejected' },
    { type: 'rate_limited' },
    { type: 'unknown' },
    { type: 'needs_human' },
    { type: 'reconciled', found: true },
    { type: 'reconciled', found: false },
    { type: 'retry' },
    { type: 'drop' },
  ];

  it('resolves an unknown outcome by reconciliation or a human', () => {
    const ambiguous = transitionVariant('publishing', { type: 'unknown' });
    expect(ambiguous).toEqual({ ok: true, status: 'ambiguous' });
    expect(transitionVariant('ambiguous', { type: 'reconciled', found: true })).toEqual({ ok: true, status: 'published' });
    expect(transitionVariant('ambiguous', { type: 'reconciled', found: false })).toEqual({ ok: true, status: 'needs_attention' });
    // An ambiguous variant is never started again directly.
    expect(transitionVariant('ambiguous', { type: 'start' }).ok).toBe(false);
    expect(transitionVariant('ambiguous', { type: 'retry' }).ok).toBe(false);
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
      if (from === 'pending') continue;
      for (const e of events) {
        const t = transitionVariant(from, e);
        if (t.ok && t.status === 'scheduled') expect(startsNewAttempt(e)).toBe(true);
      }
    }
    expect(startsNewAttempt({ type: 'schedule' })).toBe(false);
    expect(startsNewAttempt({ type: 'unknown' })).toBe(false);
  });

  it('hands an outcome nobody can find out to a human', () => {
    expect(transitionVariant('publishing', { type: 'needs_human' })).toEqual({ ok: true, status: 'needs_attention' });
    expect(transitionVariant('ambiguous', { type: 'needs_human' })).toEqual({ ok: true, status: 'needs_attention' });
    expect(transitionVariant('needs_attention', { type: 'retry' })).toEqual({ ok: true, status: 'scheduled' });
  });

  it('never leaves published', () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...events), { maxLength: 40 }), (path) => {
        // Start from pending or just before an outcome, so runs actually reach published.
        let s: VariantStatus = path.length % 2 === 0 ? 'pending' : 'publishing';
        let published = false;
        for (const e of path) {
          const t = transitionVariant(s, e);
          if (!t.ok) continue;
          if (published) throw new Error(`left published via ${e.type}`);
          s = t.status;
          if (s === 'published') published = true;
          expect(VARIANT_STATUSES).toContain(s);
        }
      }),
    );
  });

  it('starts a publish only from scheduled', () => {
    for (const s of VARIANT_STATUSES) expect(transitionVariant(s, { type: 'start' }).ok).toBe(s === 'scheduled');
  });
});

describe('postOutcome', () => {
  it('waits while any variant is in flight or waiting on a human', () => {
    expect(postOutcome(['published', 'publishing'])).toBeNull();
    expect(postOutcome(['published', 'needs_attention'])).toBeNull();
    expect(postOutcome(['published', 'paused'])).toBeNull();
  });

  it('ignores cancelled variants', () => {
    expect(postOutcome(['published', 'cancelled'])).toBe('published');
    expect(postOutcome(['published', 'failed'])).toBe('partially_published');
    expect(postOutcome(['failed', 'cancelled'])).toBe('failed');
    expect(postOutcome(['cancelled'])).toBe('failed');
  });
});

describe('contentHash and approvalCovers', () => {
  const base: HashedVariant = {
    channelConnectionId: 'c-1',
    provider: 'facebook_page',
    body: 'Khuyến mãi tháng 10',
    title: null,
    linkUrl: 'https://crove.example/sale',
    media: [{ fileId: 'f-1', generation: 1, altText: null }],
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
    expect(contentHash([{ ...base, media: [{ fileId: 'f-1', generation: 2, altText: null }] }])).not.toBe(h);
    expect(contentHash([{ ...base, settings: { a: 2, b: { c: true } } }])).not.toBe(h);
  });

  it('covers only the exact revision and content', () => {
    const post = { revision: 3, contentHash: contentHash([base]) };
    expect(approvalCovers({ revision: 3, contentHash: post.contentHash }, post)).toBe(true);
    expect(approvalCovers({ revision: 2, contentHash: post.contentHash }, post)).toBe(false);
    expect(approvalCovers({ revision: 3, contentHash: contentHash([other]) }, post)).toBe(false);
    expect(approvalCovers(null, post)).toBe(false);
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
