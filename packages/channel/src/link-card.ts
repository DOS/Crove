// A link card (#1498), as the variant's settings carry it (`settings.linkCard`: { title, description?, thumbFileId? }):
// LinkedIn and Bluesky build no preview from a URL, so the poster sends the card's text and image. The Social module
// checks the shape, the limits and the image file when the variant is written; the adapters read the same shape and
// refuse a card they cannot send (LINK_CARD_INVALID, LINK_CARD_WITH_MEDIA, LINK_CARD_NEEDS_LINK) before any call. The
// card carries text the member saw and kept, never the fetched link preview. The image's bytes come through
// `readMedia`, like the post's media.
export const LINK_CARD_TITLE_MAX = 200;
export const LINK_CARD_DESCRIPTION_MAX = 300;
// Bluesky's app.bsky.embed.external thumb is a blob of at most 1,000,000 bytes.
export const BLUESKY_LINK_CARD_THUMB_MAX_BYTES = 1_000_000;

export interface LinkCard {
  title: string;
  // '' when the card has none.
  description: string;
  thumbFileId: string | null;
}

// Counted as the module counts them: code points of the NFC form, a Vietnamese letter with its marks as one.
const size = (text: string): number => [...text.normalize('NFC')].length;

// The card in a variant's settings: null when there is none, 'invalid' when it is not an object of those keys with a
// title of 1 to LINK_CARD_TITLE_MAX characters, a description of at most LINK_CARD_DESCRIPTION_MAX and a file id.
export function linkCardOf(settings: Readonly<Record<string, unknown>> | undefined): LinkCard | 'invalid' | null {
  const raw = settings?.linkCard;
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) return 'invalid';
  const r = raw as Record<string, unknown>;
  if (Object.keys(r).some((k) => k !== 'title' && k !== 'description' && k !== 'thumbFileId')) return 'invalid';
  if (typeof r.title !== 'string' || (r.description !== undefined && typeof r.description !== 'string') || (r.thumbFileId !== undefined && (typeof r.thumbFileId !== 'string' || r.thumbFileId === ''))) return 'invalid';
  const title = r.title.trim();
  const description = (r.description as string | undefined)?.trim() ?? '';
  if (size(title) < 1 || size(title) > LINK_CARD_TITLE_MAX || size(description) > LINK_CARD_DESCRIPTION_MAX) return 'invalid';
  return { title, description, thumbFileId: (r.thumbFileId as string | undefined)?.toLowerCase() ?? null };
}

// Why a card cannot go out with this content, or null when it can (or there is none): a card goes on a link post with
// no images, video or document, as a post has one embed on Bluesky and one content on LinkedIn.
export function linkCardRefusal(card: LinkCard | 'invalid' | null, content: { linkUrl: string | null; media: readonly unknown[] }): 'LINK_CARD_INVALID' | 'LINK_CARD_WITH_MEDIA' | 'LINK_CARD_NEEDS_LINK' | null {
  if (card === null) return null;
  if (card === 'invalid') return 'LINK_CARD_INVALID';
  if (content.media.length > 0) return 'LINK_CARD_WITH_MEDIA';
  if (!content.linkUrl?.trim()) return 'LINK_CARD_NEEDS_LINK';
  return null;
}
