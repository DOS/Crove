// How each platform lays a post out in its feed (#588), for the composer's preview: where it cuts the text behind a
// "See more", how it frames images and video, and whether a link shows as a card. Approximations of the platforms' own
// apps on a phone, not their markup; no logos.
export type PreviewLayout = 'feed' | 'square' | 'vertical' | 'video' | 'article' | 'short';

export interface PreviewRule {
  layout: PreviewLayout;
  // Characters shown before the platform's "See more"; null: the whole text.
  cut: number | null;
  // A link without media shows as a card.
  linkCard: boolean;
  // Images shown at most in the feed before "+N".
  gridMax: number;
}

const RULES: Readonly<Record<string, PreviewRule>> = {
  facebook_page: { layout: 'feed', cut: 250, linkCard: true, gridMax: 4 },
  instagram: { layout: 'square', cut: 125, linkCard: false, gridMax: 1 },
  threads: { layout: 'feed', cut: null, linkCard: true, gridMax: 4 },
  linkedin: { layout: 'feed', cut: 210, linkCard: true, gridMax: 4 },
  x: { layout: 'short', cut: null, linkCard: true, gridMax: 4 },
  bluesky: { layout: 'short', cut: null, linkCard: true, gridMax: 4 },
  tiktok: { layout: 'vertical', cut: 100, linkCard: false, gridMax: 1 },
  youtube: { layout: 'video', cut: 100, linkCard: false, gridMax: 1 },
  zalo_oa: { layout: 'article', cut: 160, linkCard: false, gridMax: 1 },
  telegram: { layout: 'feed', cut: null, linkCard: true, gridMax: 4 },
  mastodon: { layout: 'short', cut: null, linkCard: true, gridMax: 4 },
  pinterest: { layout: 'short', cut: null, linkCard: false, gridMax: 1 },
  discord: { layout: 'feed', cut: null, linkCard: true, gridMax: 4 },
  // A blog post: its title over the text, as an article.
  wordpress: { layout: 'article', cut: 300, linkCard: false, gridMax: 1 },
};

export const previewRule = (provider: string): PreviewRule => RULES[provider] ?? { layout: 'feed', cut: null, linkCard: true, gridMax: 4 };

// The text as the feed shows it before "See more": cut at the last space before the limit, by user-perceived
// characters, so a Vietnamese letter with its marks or an emoji is never split.
export function previewText(text: string, cut: number | null): { shown: string; more: boolean } {
  if (cut === null) return { shown: text, more: false };
  const graphemes = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map((s) => s.segment);
  if (graphemes.length <= cut) return { shown: text, more: false };
  const head = graphemes.slice(0, cut).join('');
  const space = head.search(/\s\S*$/);
  return { shown: (space > cut * 0.6 ? head.slice(0, space) : head).trimEnd(), more: true };
}