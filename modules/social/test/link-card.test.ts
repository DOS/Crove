// LinkedIn and Bluesky link cards (#1498): the shape, the channel rules and the text the adapters send.
import { describe, expect, it } from 'vitest';
import { BLUESKY_LINK_CARD_THUMB_MAX_BYTES, LINK_CARD_DESCRIPTION_MAX as ADAPTER_DESCRIPTION_MAX, LINK_CARD_TITLE_MAX as ADAPTER_TITLE_MAX, linkCardOf as adapterLinkCardOf } from '@crove/channel';
import { carriesLinkCard, LINK_CARD_DESCRIPTION_MAX, LINK_CARD_PROVIDERS, LINK_CARD_THUMB_MAX_BYTES, LINK_CARD_TITLE_MAX, CAPABILITIES, linkCardOf, linkCardThumbOf, sentText, splitThread, validateVariant, type VariantDraft } from '../src/contract.ts';

const LINK = 'https://tiem.example/khai-truong';
const card = { title: 'Khai trương chi nhánh mới', description: 'Giảm 20% tuần đầu', thumbFileId: '0192F3A4-0000-7000-8000-000000000001' };
const draft = (over: Partial<VariantDraft> = {}): VariantDraft => ({ provider: 'linkedin', body: 'Mời bạn ghé', title: null, media: [], linkUrl: LINK, settings: { linkCard: card }, ...over });
const image = { kind: 'image' as const, mime: 'image/jpeg', sizeBytes: 1000, durationSeconds: null };
const codes = (variant: VariantDraft) => validateVariant(variant).map((i) => i.code);

describe('link cards (#1498)', () => {
  it('goes on the channels that build no preview from a link', () => {
    expect([...LINK_CARD_PROVIDERS].sort()).toEqual(['bluesky', 'linkedin', 'linkedin_page']);
    for (const provider of LINK_CARD_PROVIDERS) expect(CAPABILITIES[provider].scrapesLinkPreview).toBe(false);
  });

  it('reads the card trimmed, its file id in lower case, and refuses another shape or a text over the limits', () => {
    expect(linkCardOf({})).toBeNull();
    expect(linkCardOf({ linkCard: { title: '  Tiêu đề  ', description: '  ' } })).toEqual({ title: 'Tiêu đề', description: '', thumbFileId: null });
    expect(linkCardOf({ linkCard: card })).toEqual({ ...card, thumbFileId: card.thumbFileId.toLowerCase() });
    expect(linkCardThumbOf({ linkCard: card })).toBe(card.thumbFileId.toLowerCase());
    for (const bad of [[], 'x', { title: '   ' }, { title: 'x'.repeat(LINK_CARD_TITLE_MAX + 1) }, { title: 'x', description: 'y'.repeat(LINK_CARD_DESCRIPTION_MAX + 1) }, { title: 'x', thumbFileId: '' }, { title: 'x', thumbFileId: 3 }, { title: 'x', image: 'y' }]) {
      expect(linkCardOf({ linkCard: bad })).toBe('invalid');
      expect(linkCardThumbOf({ linkCard: bad })).toBeNull();
    }
    // A Vietnamese letter with its marks counts once, typed precomposed or not.
    expect(linkCardOf({ linkCard: { title: 'ệ'.normalize('NFD').repeat(LINK_CARD_TITLE_MAX) } })).not.toBe('invalid');
  });

  // The limits are copied from @crove/channel by hand (the contract runs in the browser); the two must agree.
  it('reads the same shape and limits as the adapters', () => {
    expect(LINK_CARD_TITLE_MAX).toBe(ADAPTER_TITLE_MAX);
    expect(LINK_CARD_DESCRIPTION_MAX).toBe(ADAPTER_DESCRIPTION_MAX);
    expect(LINK_CARD_THUMB_MAX_BYTES).toEqual({ bluesky: BLUESKY_LINK_CARD_THUMB_MAX_BYTES });
    for (const value of [card, { title: ' x ' }, { title: '' }, { title: 'x'.repeat(201) }, { title: 'x', description: 'ệ'.normalize('NFD').repeat(300) }, { title: 'x', extra: 1 }]) {
      expect(linkCardOf({ linkCard: value })).toEqual(adapterLinkCardOf({ linkCard: value }));
    }
  });

  it('keeps the link out of the text on a carded link post with no media, and in it otherwise', () => {
    expect(sentText('linkedin', 'Mời bạn ghé', LINK, 0, { linkCard: card })).toBe('Mời bạn ghé');
    expect(sentText('bluesky', 'Mời bạn ghé', LINK, 0, { linkCard: card })).toBe('Mời bạn ghé');
    expect(sentText('linkedin', 'Mời bạn ghé', LINK, 0)).toBe(`Mời bạn ghé\n\n${LINK}`);
    // With media the card does not go, so the link does.
    expect(sentText('linkedin', 'Mời bạn ghé', LINK, 1, { linkCard: card })).toBe(`Mời bạn ghé\n\n${LINK}`);
    // An invalid card, or a card on a channel that takes none, changes nothing.
    expect(sentText('linkedin_page', 'Mời bạn ghé', LINK, 0, { linkCard: { title: '' } })).toBe(`Mời bạn ghé\n\n${LINK}`);
    expect(sentText('threads', 'Mời bạn ghé', LINK, 0, { linkCard: card })).toBe(`Mời bạn ghé\n\n${LINK}`);
    expect(carriesLinkCard('bluesky', { linkCard: card }, '  ', 0)).toBe(false);
  });

  it('counts the Bluesky text without the link, so a carded post near 300 graphemes fits', () => {
    const body = `Mời bạn ghé ${'ư'.repeat(280)}`;
    expect(codes(draft({ provider: 'bluesky', body, settings: {} }))).toContain('TEXT_TOO_LONG');
    expect(codes(draft({ provider: 'bluesky', body }))).toEqual([]);
    // A thread's first post is counted the same way.
    expect(splitThread('bluesky', body, { settings: { linkCard: card }, linkUrl: LINK })?.posts).toHaveLength(1);
  });

  it('accepts a card on a LinkedIn, Company Page or Bluesky link post', () => {
    for (const provider of ['linkedin', 'linkedin_page', 'bluesky'] as const) expect(codes(draft({ provider }))).toEqual([]);
  });

  it('refuses a card on another channel, of another shape, with media or a poll, or without a link', () => {
    expect(codes(draft({ provider: 'threads' }))).toEqual(['LINK_CARD_NOT_SUPPORTED']);
    expect(validateVariant(draft({ settings: { linkCard: { title: 'x'.repeat(201) } } }))).toEqual([{ code: 'LINK_CARD_INVALID', field: 'settings.linkCard.title', limit: LINK_CARD_TITLE_MAX, actual: 201 }]);
    expect(validateVariant(draft({ settings: { linkCard: { title: ' ' } } }))).toEqual([{ code: 'LINK_CARD_INVALID', field: 'settings.linkCard.title', limit: LINK_CARD_TITLE_MAX, actual: 0 }]);
    expect(validateVariant(draft({ settings: { linkCard: { title: 'x', description: 'y'.repeat(301) } } }))).toEqual([{ code: 'LINK_CARD_INVALID', field: 'settings.linkCard.description', limit: LINK_CARD_DESCRIPTION_MAX, actual: 301 }]);
    expect(validateVariant(draft({ settings: { linkCard: 'x' } }))).toEqual([{ code: 'LINK_CARD_INVALID', field: 'settings.linkCard', limit: null, actual: null }]);
    expect(codes(draft({ media: [image] }))).toEqual(['LINK_CARD_WITH_MEDIA']);
    expect(codes(draft({ provider: 'bluesky', media: [image, image] }))).toEqual(['LINK_CARD_WITH_MEDIA']);
    expect(codes(draft({ settings: { linkCard: card, poll: { question: 'Bạn thích?', options: ['Có', 'Không'] } } }))).toEqual(['LINK_CARD_WITH_POLL']);
    expect(codes(draft({ linkUrl: null }))).toEqual(['LINK_CARD_NEEDS_LINK']);
  });
});
