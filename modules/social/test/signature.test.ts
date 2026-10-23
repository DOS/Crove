// A channel's signature (#1190) in the one content resolver, the content hash and the channel checks, and Instagram's
// hashtag and @ tag caps.
import { describe, expect, it } from 'vitest';
import {
  captionHashtags,
  captionMentions,
  contentHash,
  effectiveContent,
  IG_HASHTAGS_MAX,
  IG_MENTIONS_MAX,
  inheritedContent,
  SIGNATURE_MAX,
  sentText,
  signatureOf,
  signatureText,
  validateVariant,
  withChannelSignature,
  withSignature,
  withoutSignature,
} from '../src/index.ts';
import { freezeValues, hashOf, issuesOf, type PostRow, type VariantRow } from '../src/variants.ts';

const SIGNATURE = 'Hotline 0901 234 567\n12 Lê Lợi, Q.1\n#TiemBanhAnNhien';

describe('signatureOf', () => {
  it('reads a text, false (left off) or nothing, and flags anything else', () => {
    expect(signatureOf(undefined)).toBeNull();
    expect(signatureOf({})).toBeNull();
    expect(signatureOf({ signature: null })).toBeNull();
    expect(signatureOf({ signature: false })).toBe('off');
    expect(signatureOf({ signature: `  ${SIGNATURE}\n` })).toEqual({ text: SIGNATURE });
    for (const bad of [true, 1, '', '   ', ['a'], { text: 'a' }, 'x'.repeat(SIGNATURE_MAX + 1)]) expect(signatureOf({ signature: bad })).toBe('invalid');
    expect(signatureOf({ signature: 'ầ'.repeat(SIGNATURE_MAX) })).toEqual({ text: 'ầ'.repeat(SIGNATURE_MAX) });
    // A signature that reads like a marker is still a signature.
    expect(signatureText({ signature: 'invalid' })).toBe('invalid');
    expect(signatureText({ signature: 'off' })).toBe('off');
    expect(signatureText({ signature: false })).toBeNull();
    expect(signatureText({ signature: 3 })).toBeNull();
  });
});

describe('withSignature', () => {
  it('appends the signature after a blank line', () => {
    expect(withSignature('Bánh mới ra lò', { signature: SIGNATURE })).toBe(`Bánh mới ra lò\n\n${SIGNATURE}`);
    expect(withSignature('Bánh mới ra lò \n\n', { signature: SIGNATURE })).toBe(`Bánh mới ra lò\n\n${SIGNATURE}`);
    // A post with images only: the signature is its text.
    expect(withSignature('', { signature: SIGNATURE })).toBe(SIGNATURE);
  });

  it('leaves a text that already ends with it as it is, so applying it twice changes nothing', () => {
    const once = withSignature('Bánh mới', { signature: SIGNATURE });
    expect(withSignature(once, { signature: SIGNATURE })).toBe(once);
    expect(withSignature(`Bánh mới\n${SIGNATURE}\n`, { signature: SIGNATURE })).toBe(`Bánh mới\n${SIGNATURE}\n`);
    // Compared in NFC: a pasted signature in another Unicode form is the same signature.
    expect(withSignature(`Bánh\n\n${SIGNATURE.normalize('NFD')}`, { signature: SIGNATURE })).toBe(`Bánh\n\n${SIGNATURE.normalize('NFD')}`);
  });

  it('leaves the text exactly as it is without a signature, with one left off, or with an invalid one', () => {
    for (const settings of [undefined, {}, { signature: false }, { signature: null }, { signature: 3 }]) expect(withSignature('Bánh mới \n', settings)).toBe('Bánh mới \n');
  });
});

describe('withChannelSignature', () => {
  it('copies the channel signature into settings that say nothing of one', () => {
    expect(withChannelSignature({}, SIGNATURE)).toEqual({ signature: SIGNATURE });
    expect(withChannelSignature({ firstComment: 'a' }, SIGNATURE)).toEqual({ firstComment: 'a', signature: SIGNATURE });
  });

  it('keeps settings that chose already, and adds nothing for a channel without one', () => {
    expect(withChannelSignature({ signature: false }, SIGNATURE)).toEqual({ signature: false });
    expect(withChannelSignature({ signature: 'Riêng' }, SIGNATURE)).toEqual({ signature: 'Riêng' });
    const none = { firstComment: 'a' };
    expect(withChannelSignature(none, null)).toBe(none);
    expect(withChannelSignature(none, undefined)).toBe(none);
  });
});

describe('effectiveContent with a signature', () => {
  const base = { body: 'Gốc', title: 'Tiêu đề', linkUrl: 'https://a.vn' };
  const own = { body: null, title: null, linkUrl: null };

  it('is the inherited content when the settings hold no signature (every post from before signatures)', () => {
    for (const settings of [undefined, null, {}, { firstComment: 'x' }, { signature: false }]) {
      expect(effectiveContent(base, own, false, settings)).toEqual(inheritedContent(base, own));
      expect(effectiveContent(base, { body: 'Đã đăng', title: null, linkUrl: null }, true, settings)).toEqual(inheritedContent(base, { body: 'Đã đăng', title: null, linkUrl: null }, true));
    }
  });

  it('appends it to the text only, the inherited text or the channel own', () => {
    expect(effectiveContent(base, own, false, { signature: SIGNATURE })).toEqual({ body: `Gốc\n\n${SIGNATURE}`, title: 'Tiêu đề', linkUrl: 'https://a.vn' });
    expect(effectiveContent(base, { body: 'Riêng', title: null, linkUrl: null }, false, { signature: SIGNATURE }).body).toBe(`Riêng\n\n${SIGNATURE}`);
  });

  it('puts the link an adapter appends after the signature', () => {
    const body = effectiveContent(base, own, false, { signature: SIGNATURE }).body;
    expect(sentText('x', body, 'https://a.vn', 0)).toBe(`Gốc\n\n${SIGNATURE}\n\nhttps://a.vn`);
  });
});

describe('the content hash with a signature', () => {
  const post = { body: 'Bánh mới ra lò', title: null, linkUrl: null, media: [] };
  const variant = (settings: Record<string, unknown>) => ({ channel_connection_id: '0190a000-0000-7000-8000-000000000001', provider: 'facebook_page', body: null, title: null, link_url: null, settings, media: null, content_frozen: false });

  it('hashes a variant without a signature exactly as before signatures, so no approval is lost', () => {
    // The hash as it was computed before #1190: the inherited content and the settings, nothing appended.
    for (const settings of [{}, { firstComment: 'Xem thêm' }]) {
      const before = contentHash([{ channelConnectionId: variant(settings).channel_connection_id, provider: 'facebook_page', body: post.body, title: null, linkUrl: null, media: [], settings }]);
      expect(hashOf(post, variant(settings))).toBe(before);
    }
    // And a fixed value, so a change of the canonical form or the resolver shows here.
    expect(hashOf(post, variant({}))).toBe(contentHash([{ channelConnectionId: '0190a000-0000-7000-8000-000000000001', provider: 'facebook_page', body: 'Bánh mới ra lò', title: null, linkUrl: null, media: [], settings: {} }]));
  });

  it('covers the signature: on, off and another text are three different contents', () => {
    const on = hashOf(post, variant({ signature: SIGNATURE }));
    const off = hashOf(post, variant({ signature: false }));
    const other = hashOf(post, variant({ signature: 'Hotline 0999' }));
    const none = hashOf(post, variant({}));
    expect(new Set([on, off, other, none]).size).toBe(4);
    // The text sent is in the hash too, not only the setting.
    expect(on).toBe(contentHash([{ channelConnectionId: variant({}).channel_connection_id, provider: 'facebook_page', body: `Bánh mới ra lò\n\n${SIGNATURE}`, title: null, linkUrl: null, media: [], settings: { signature: SIGNATURE } }]));
  });

  it('hashes a variant the same once it is history: its own text is kept, the signature stays in its settings', () => {
    const row = { ...variant({ signature: SIGNATURE }), id: 'v', post_id: 'p', position: 0, revision: 1, content_hash: '', status: 'published' } as unknown as VariantRow;
    const postRow = { id: 'p', body: post.body, title: null, link_url: null, time_zone: 'Asia/Ho_Chi_Minh', scheduled_at: null, revision: 1, media: [] } as PostRow;
    const frozen = { ...row, ...freezeValues(postRow, row), media: [] } as VariantRow;
    expect(frozen.body).toBe(post.body);
    expect(hashOf(post, frozen)).toBe(hashOf(post, row));
  });

  it('checks the text with its signature: an X post pushed over 280 by it is too long', () => {
    const x = (settings: Record<string, unknown>) => ({ ...variant(settings), provider: 'x', id: 'v', post_id: 'p', position: 0, revision: 1, content_hash: '', status: 'draft' }) as unknown as VariantRow;
    const xPost = { ...post, body: 'a'.repeat(250) };
    expect(issuesOf(xPost, x({}))).toEqual([]);
    expect(issuesOf(xPost, x({ signature: 'Hotline 0901 234 567 · Ghé tiệm nhé!' })).map((i) => i.code)).toContain('TEXT_TOO_LONG');
    expect(issuesOf(xPost, x({ signature: false }))).toEqual([]);
  });
});

describe('the signature in validateVariant', () => {
  it('counts the signature even when the caller passes the text without it, and flags an invalid one', () => {
    const issues = validateVariant({ provider: 'x', body: 'a'.repeat(270), title: null, media: [], settings: { signature: 'b'.repeat(20) } });
    expect(issues).toContainEqual({ code: 'TEXT_TOO_LONG', field: 'body', limit: 280, actual: 292 });
    expect(validateVariant({ provider: 'x', body: 'a', title: null, media: [], settings: { signature: 7 } })).toContainEqual({ code: 'SIGNATURE_INVALID', field: 'settings.signature', limit: SIGNATURE_MAX, actual: null });
  });

  it('never lets a post with no text and no media go out as its signature alone', () => {
    const codes = (body: string, media: { kind: 'image'; mime: string; sizeBytes: number; durationSeconds: null }[] = []) =>
      validateVariant({ provider: 'x', body, title: null, media, settings: { signature: SIGNATURE } }).map((i) => i.code);
    // The text without the signature (a caller that passes the member's own text) and with it (effectiveContent's).
    expect(codes('')).toContain('CONTENT_REQUIRED');
    expect(codes(' \n ')).toContain('CONTENT_REQUIRED');
    expect(codes(withSignature('', { signature: SIGNATURE }))).toContain('CONTENT_REQUIRED');
    expect(codes(`\n${SIGNATURE.normalize('NFD')}\n`)).toContain('CONTENT_REQUIRED');
    // Text of the member's own, or media, is a post: the signature goes after it, or is the images' caption.
    expect(codes('Bánh mới')).not.toContain('CONTENT_REQUIRED');
    expect(codes(withSignature('Bánh mới', { signature: SIGNATURE }))).not.toContain('CONTENT_REQUIRED');
    expect(codes('', [{ kind: 'image', mime: 'image/jpeg', sizeBytes: 1000, durationSeconds: null }])).not.toContain('CONTENT_REQUIRED');
  });

  it('takes the text before the signature as the member wrote it', () => {
    expect(withoutSignature(`Bánh mới\n\n${SIGNATURE}\n`, { signature: SIGNATURE })).toBe('Bánh mới\n\n');
    expect(withoutSignature(SIGNATURE, { signature: SIGNATURE })).toBe('');
    expect(withoutSignature('Bánh mới ', { signature: SIGNATURE })).toBe('Bánh mới ');
    for (const settings of [undefined, {}, { signature: false }, { signature: 3 }]) expect(withoutSignature(SIGNATURE, settings)).toBe(SIGNATURE);
  });
});

describe("Instagram's hashtag and @ tag caps", () => {
  const image = { kind: 'image' as const, mime: 'image/jpeg', sizeBytes: 1000, durationSeconds: null };
  const ig = (body: string, settings: Record<string, unknown> = {}) => validateVariant({ provider: 'instagram', body, title: null, media: [image], settings }).map((i) => i.code);
  const tags = (n: number) => Array.from({ length: n }, (_, i) => `#banh${i}`).join(' ');
  const mentions = (n: number) => Array.from({ length: n }, (_, i) => `@tiem.banh_${i}`).join(' ');

  it('counts hashtags and @ tags where they are, each place once', () => {
    expect(captionHashtags('#a #b #a')).toBe(3);
    expect(captionHashtags('Bánh #ngon, #bánhmì! #1')).toBe(3);
    // Not a hashtag: inside a word, an HTML entity, a lone # or a double one.
    expect(captionHashtags('C# a#b &#39; # ##x')).toBe(0);
    expect(captionMentions('@lan @an.nhien @lan')).toBe(3);
    // Not an @ tag: an email address or a lone @.
    expect(captionMentions('lan@tiem.vn @ hỏi @@x')).toBe(0);
  });

  it(`takes up to ${IG_HASHTAGS_MAX} hashtags and ${IG_MENTIONS_MAX} @ tags, and refuses one more`, () => {
    expect(ig(tags(IG_HASHTAGS_MAX))).toEqual([]);
    expect(ig(tags(IG_HASHTAGS_MAX + 1))).toEqual(['IG_TOO_MANY_HASHTAGS']);
    expect(ig(mentions(IG_MENTIONS_MAX))).toEqual([]);
    expect(ig(mentions(IG_MENTIONS_MAX + 1))).toEqual(['IG_TOO_MANY_MENTIONS']);
    expect(validateVariant({ provider: 'instagram', body: tags(31), title: null, media: [image] })).toContainEqual({ code: 'IG_TOO_MANY_HASHTAGS', field: 'body', limit: 30, actual: 31 });
  });

  it('counts the ones the signature adds, and none on a Story, which sends no caption', () => {
    expect(ig(tags(29), { signature: '#TiemBanh #AnNhien' })).toEqual(['IG_TOO_MANY_HASHTAGS']);
    expect(ig(tags(29), { signature: false })).toEqual([]);
    expect(ig(tags(40), { postType: 'story' })).toEqual([]);
  });

  it('leaves the other channels alone', () => {
    expect(validateVariant({ provider: 'facebook_page', body: tags(40), title: null, media: [] }).map((i) => i.code)).toEqual([]);
  });
});
