// A channel's post type (#644), as the variant's settings carry it (`settings.postType`): a feed post (the default, and
// what a missing value means), a Story (one image or video, shown for a day, no text or link) or a Reel (one short
// video). The Social module checks which channels take which and the media each needs; the Instagram and Facebook Page
// adapters post Stories and Reels, and an adapter given a value it does not know refuses with POST_TYPE_NOT_SUPPORTED
// before anything is posted.
export type PostType = 'feed' | 'story' | 'reel';

// null: a value that is not one of the three.
export function postTypeOf(settings: Readonly<Record<string, unknown>> | undefined): PostType | null {
  const value = settings?.postType;
  if (value === undefined || value === null) return 'feed';
  return value === 'feed' || value === 'story' || value === 'reel' ? value : null;
}
