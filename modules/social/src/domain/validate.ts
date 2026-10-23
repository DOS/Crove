// Checks a variant against its channel's capabilities (Social plan §3.6). Returns every issue rather than the first,
// so the composer can show them all; an empty list means the variant fits the channel. A variant that breaks a
// rule is flagged, never silently cut.
import { AUTO_REPLY_LIKES_MAX, AUTO_REPLY_RULES, autoReplyOf, REPOST_HOURS_MAX, REPOST_PROVIDERS, repostRuleOf, CAPABILITIES, GBP_CTAS, GBP_LANGUAGES, GBP_TOPICS, gbpOf, COMMENT_RULES, CONTENT_WARNING_MAX, MASTODON_VISIBILITY, IG_COLLABORATORS_MAX, IG_USER_TAGS_MAX, instagramPeopleOf, THREAD_PARTS_MAX, THREAD_RULES, threadPartsOf, COVER_RULES, IMAGE_RULES, MEDIA_BODY_MAX, PHOTO_BODY_MAX, POLL_RULES, POST_TYPE_RULES, TOPIC_TAG_RULES, pollDurationOf, pollFlagOf, pollOptionsOf, pollQuestionOf, type PollRule, topicTagOf, RATIO_SLACK, REEL_MAX_VIDEO_SECONDS, STORY_IMAGE, STORY_MAX_VIDEO_SECONDS, postTypeOf, VIDEO_ONLY_ADAPTERS, coverKind, coverOf, VIDEO_READY, countLinks, countText, firstCommentOf, sentText, YOUTUBE_CATEGORIES, YOUTUBE_TAGS_MAX, youtubeTagsLength, youtubeTagsOf, YOUTUBE_PLAYLISTS_MAX, youtubePlaylistsOf, type ChannelCapabilities, type MediaKind, type Provider, type TextRule, tiktokModeOf, tiktokDisclosureOf, REMOVE_READY, removeAtOf, WORDPRESS_CATEGORIES_MAX, WORDPRESS_EXCERPT_MAX, WORDPRESS_STATUSES, WORDPRESS_TAGS_MAX, WORDPRESS_TERM_MAX, telegramOptionsOf, REPLY_SETTINGS, linkedinVisibilities, telegramButtonsOf, isButtonUrl, TELEGRAM_BUTTON_ROWS_MAX, TELEGRAM_BUTTONS_PER_ROW_MAX, TELEGRAM_BUTTON_TEXT_MAX, type TelegramButton, instagramReelOf, isInstagramReel, discordOptionsOf, discordThreadName, isDiscordForum, isDiscordId, DISCORD_TAGS_MAX, DISCORD_THREAD_NAME_MAX, blueskyRepliesOf, DOCUMENT_PROVIDERS, DOCUMENT_TITLE_MAX, documentTitleOf, pinterestSectionOf, IG_HASHTAGS_MAX, IG_MENTIONS_MAX, captionHashtags, captionMentions } from './channels.ts';
import { SIGNATURE_MAX, signatureOf, withSignature } from './signature.ts';
import { sentLink } from './utm.ts';

// TikTok's privacy levels; which ones an account may use is checked with TikTok when the video goes out.
export const TIKTOK_PRIVACY: readonly string[] = ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY'];

export interface MediaItem {
  kind: MediaKind;
  mime: string;
  sizeBytes: number;
  durationSeconds: number | null;
  // An image's size as shown (#636); absent or null when unknown, and then not checked.
  width?: number | null;
  height?: number | null;
}

export interface VariantDraft {
  provider: Provider;
  body: string;
  title: string | null;
  media: readonly MediaItem[];
  // The post's link: the adapters of some channels add it to the text, which then counts against the limit.
  linkUrl?: string | null;
  // The variant's provider settings (privacy level and the like); absent is none.
  settings?: Readonly<Record<string, unknown>>;
}

export type IssueCode =
  // Instagram collaborators and people tags (#796): not usernames, too many, or on a post that takes none.
  | 'IG_COLLABORATORS_INVALID'
  | 'IG_USER_TAGS_INVALID'
  | 'IG_TAGS_NOT_SUPPORTED'
  // An Instagram caption (#1190) with more than IG_HASHTAGS_MAX hashtags or IG_MENTIONS_MAX @ tags, as it is sent.
  | 'IG_TOO_MANY_HASHTAGS'
  | 'IG_TOO_MANY_MENTIONS'
  // The variant's signature (#1190), settings.signature: neither a text of 1 to SIGNATURE_MAX characters nor false.
  | 'SIGNATURE_INVALID'
  // Where an Instagram Reel shows (#1019): settings.instagram on another channel; not { reelFeed, trialGraduation? }
  // with known values (a graduation only on a trial); set on a post that is not a Reel (a Story, images, a carousel).
  | 'INSTAGRAM_NOT_SUPPORTED'
  | 'IG_REEL_FEED_INVALID'
  | 'IG_REEL_FEED_NOT_REEL'
  | 'CONTENT_REQUIRED'
  | 'TEXT_REQUIRED'
  | 'TEXT_TOO_LONG'
  // Within the count, over the channel's cap in UTF-8 bytes.
  | 'TEXT_TOO_MANY_BYTES'
  | 'TITLE_REQUIRED'
  | 'TITLE_TOO_LONG'
  | 'TITLE_NOT_SUPPORTED'
  | 'MEDIA_REQUIRED'
  | 'TOO_MANY_MEDIA'
  | 'MEDIA_KIND_NOT_ALLOWED'
  | 'MEDIA_MIX_NOT_ALLOWED'
  | 'TOO_MANY_VIDEOS'
  | 'IMAGE_TYPE_NOT_ALLOWED'
  | 'IMAGE_TOO_LARGE'
  // An image's shape (actual: width / height x 1000) or width (limit, actual: pixels) the channel refuses (#636).
  | 'IMAGE_RATIO_NOT_ALLOWED'
  | 'IMAGE_TOO_SMALL'
  | 'VIDEO_TOO_LARGE'
  | 'VIDEO_TOO_LONG'
  | 'VIDEO_LENGTH_UNKNOWN'
  // The platform takes video, Crove's adapter for it does not yet.
  | 'VIDEO_NOT_SUPPORTED_YET'
  // Documents (#1119): a PDF on a channel that shows none (only LinkedIn does); a document beside other files (a
  // document is the post's only file); one over the channel's size (limit, actual: bytes).
  | 'DOCUMENT_NOT_SUPPORTED'
  | 'DOCUMENT_ALONE'
  | 'DOCUMENT_TOO_LARGE'
  // A LinkedIn document's title (#1119), settings.linkedin: set on another channel; not { documentTitle } with 1 to
  // DOCUMENT_TITLE_MAX characters (limit, actual: characters, null when not text); a title on a post with no document.
  | 'LINKEDIN_NOT_SUPPORTED'
  | 'DOCUMENT_TITLE_INVALID'
  | 'DOCUMENT_TITLE_NEEDS_DOCUMENT'
  // TikTok: the person posting picks who sees the video; there is no default. Not in inbox mode (#903), where the
  // creator picks it in TikTok.
  | 'PRIVACY_REQUIRED'
  // TikTok (#903): settings.tiktokMode is neither 'direct' nor 'inbox'.
  | 'TIKTOK_MODE_INVALID'
  // TikTok's commercial content and AI labels (#1078), settings.tiktok: set on another channel; not an object of
  // true-or-false keys commercial, yourBrand, brandedContent and aiGenerated; the disclosure turned on with neither
  // your brand nor branded content chosen; branded content with the privacy level "only me" (SELF_ONLY), which TikTok
  // forbids; any of them on a draft sent to the TikTok app (#903), where the creator sets them in TikTok.
  | 'TIKTOK_NOT_SUPPORTED'
  | 'TIKTOK_DISCLOSURE_INVALID'
  | 'TIKTOK_COMMERCIAL_CHOOSE'
  | 'TIKTOK_BRANDED_PRIVATE'
  | 'TIKTOK_DISCLOSURE_INBOX'
  // The platform takes photos, Crove's adapter for it posts only video.
  | 'IMAGES_NOT_SUPPORTED_YET'
  | 'TOO_MANY_LINKS'
  // The first comment (#587): too long for the channel, or a channel that takes none yet.
  | 'COMMENT_TOO_LONG'
  | 'COMMENT_NOT_SUPPORTED'
  // Files the channel fetches by URL, on a deployment that hands out none (#772); raised by the composer, which knows.
  | 'MEDIA_NEEDS_PUBLIC_STORAGE'
  // Mastodon (#748): a visibility other than public or unlisted (LinkedIn, #983: public, connections or loggedIn); a
  // content warning over CONTENT_WARNING_MAX characters.
  | 'VISIBILITY_INVALID'
  | 'CONTENT_WARNING_TOO_LONG'
  // Thread parts (#742): a channel that takes none; more than THREAD_PARTS_MAX; an empty part or one too long for the
  // channel (field settings.threadParts.<index>); a first comment beside a thread.
  | 'THREAD_NOT_SUPPORTED'
  | 'THREAD_TOO_MANY_PARTS'
  | 'THREAD_PART_EMPTY'
  | 'THREAD_PART_TOO_LONG'
  | 'THREAD_WITH_COMMENT'
  // The auto-reply (#746): not a text and a like count from 1 to AUTO_REPLY_LIKES_MAX; a channel that takes none; a
  // text too long for the channel.
  | 'AUTO_REPLY_INVALID'
  | 'AUTO_REPLY_NOT_SUPPORTED'
  | 'AUTO_REPLY_TOO_LONG'
  // The repost rule (#773): not a like count and/or hours in range; a channel that reposts nothing.
  | 'REPOST_INVALID'
  | 'REPOST_NOT_SUPPORTED'
  // The planned takedown (#861): not a full ISO 8601 time with Z or an offset; a channel (or a Story) Crove cannot
  // take down.
  | 'REMOVE_AT_INVALID'
  | 'REMOVE_AT_NOT_SUPPORTED'
  // A video's cover (#642): not a frame or an image; set on a post that is not one video; a kind the channel's
  // adapter cannot send; a frame past the end of the video.
  | 'COVER_INVALID'
  | 'COVER_NEEDS_VIDEO'
  | 'COVER_NOT_SUPPORTED'
  | 'COVER_OUT_OF_RANGE'
  // The post type (#644): one the channel does not post; a Story that is not one image or video; a Reel that is not one
  // video.
  | 'POST_TYPE_NOT_SUPPORTED'
  | 'STORY_ONE_MEDIA'
  | 'REEL_ONE_VIDEO'
  // A poll or a topic tag (#711): on a channel that takes none; not 2 to 4 options (limit: the most, actual: how many);
  // an option empty or too long (field settings.poll.<index>); a poll with media; a tag Threads would refuse.
  | 'POLL_NOT_SUPPORTED'
  | 'POLL_OPTIONS'
  | 'POLL_OPTION_LENGTH'
  | 'POLL_WITH_MEDIA'
  // A poll's length (#948, X): not whole minutes from the channel's least to its most, or not one of the lengths it
  // takes (LinkedIn, #1118) (limit: the most, actual: minutes).
  | 'POLL_DURATION'
  // Polls on Mastodon, Telegram and LinkedIn (#1118): a choice the channel's polls do not take (several answers, counts
  // hidden until the end, a question of its own; field settings.poll.<name>), or one that is not true or false (or text,
  // for the question); LinkedIn's question missing or too long (field settings.poll.question); Telegram's question, the
  // post's text with its link, empty or too long (field body).
  | 'POLL_SETTING_NOT_SUPPORTED'
  | 'POLL_SETTING_INVALID'
  | 'POLL_QUESTION_LENGTH'
  | 'POLL_TEXT_LENGTH'
  // Who may reply (#948 X, #983 Threads, #1102 Bluesky): a value the channel does not take (everyone, following or
  // mentionedUsers; Threads also followers; Bluesky also nobody, or a list of distinct mentionedUsers, following and
  // followers).
  | 'REPLY_SETTINGS_INVALID'
  // Quote posts (#1102, Bluesky): settings.quotes is set and is not true or false, or is set on another channel.
  | 'QUOTES_INVALID'
  | 'QUOTES_NOT_SUPPORTED'
  | 'TOPIC_TAG_NOT_SUPPORTED'
  | 'TOPIC_TAG_INVALID'
  // Google Business Profile (#709): settings on another channel, or ones Google would refuse (an unknown topic or call to
  // action, an event without its title or dates, an offer without dates); a call to action with no link to open.
  | 'GBP_NOT_SUPPORTED'
  | 'GBP_INVALID'
  | 'GBP_CTA_NEEDS_LINK'
  // YouTube video details (#905): an audience that is not yes or no; a category outside YouTube's assignable list;
  // tags that are not a list of strings, or one empty or with an angle bracket (field settings.tags.<index>); tags
  // over YouTube's 500 characters as it counts them (limit, actual).
  | 'YT_AUDIENCE_INVALID'
  | 'YT_CATEGORY_INVALID'
  | 'YT_TAG_INVALID'
  | 'YT_TAGS_TOO_LONG'
  // YouTube's altered or synthetic content disclosure (#1078): settings.syntheticMedia is set and is not true or false.
  | 'YT_SYNTHETIC_INVALID'
  // YouTube playlists (#1018): settings.youtube on another channel; not { playlistIds } with distinct playlist ids;
  // more than YOUTUBE_PLAYLISTS_MAX playlists (limit, actual).
  | 'YOUTUBE_NOT_SUPPORTED'
  | 'YT_PLAYLISTS_INVALID'
  | 'YT_PLAYLISTS_TOO_MANY'
  // Pinterest board sections (#1120): settings.pinterest on another channel; not { sectionId } with a section's id.
  | 'PINTEREST_NOT_SUPPORTED'
  | 'PINTEREST_SECTION_INVALID'
  // Zalo OA (#943): settings.comments is set and is not true or false.
  | 'ZALO_COMMENTS_INVALID'
  // Telegram (#982): settings.telegram on another channel; or not { silent?, pin? } with true or false values.
  | 'TELEGRAM_NOT_SUPPORTED'
  | 'TELEGRAM_INVALID'
  // Telegram link buttons (#1017), settings.telegram.buttons: not a list of rows of { text, url }, or an empty list or
  // row; more than TELEGRAM_BUTTON_ROWS_MAX rows (field settings.telegram.buttons) or TELEGRAM_BUTTONS_PER_ROW_MAX in a
  // row (field settings.telegram.buttons.<row>), with limit and actual; a label empty or over TELEGRAM_BUTTON_TEXT_MAX
  // characters (field .<row>.<index>.text); a link that is not https (field .<row>.<index>.url); buttons on an album,
  // which Telegram sends as a media group that takes no buttons (actual: the number of files).
  | 'TELEGRAM_BUTTONS_INVALID'
  | 'TELEGRAM_TOO_MANY_BUTTONS'
  | 'TELEGRAM_BUTTON_TEXT_LENGTH'
  | 'TELEGRAM_BUTTON_URL_INVALID'
  | 'TELEGRAM_BUTTONS_ON_ALBUM'
  // WordPress (#981), settings.wordpress: set on another channel, or not an object; more than WORDPRESS_CATEGORIES_MAX
  // categories or WORDPRESS_TAGS_MAX tags (limit, actual); a name that is not text, is empty, holds < or >, or is over
  // WORDPRESS_TERM_MAX characters (field settings.wordpress.categories.<index> or .tags.<index>); an excerpt over
  // WORDPRESS_EXCERPT_MAX characters (limit, actual); a status other than publish, draft or pending.
  | 'WORDPRESS_NOT_SUPPORTED'
  | 'WORDPRESS_INVALID'
  | 'WORDPRESS_TOO_MANY_CATEGORIES'
  | 'WORDPRESS_TOO_MANY_TAGS'
  | 'WORDPRESS_TERM_INVALID'
  | 'WORDPRESS_EXCERPT_TOO_LONG'
  | 'WORDPRESS_STATUS_INVALID'
  // Discord forum posts and threads (#1103), settings.discord: set on another channel, or not { forum?, threadName?,
  // tags?, threadId? } with values of their types; a name or tags on a post not marked as a forum post; a forum post
  // with a thread id too (Discord refuses both); a forum post with no name, title or text to name it; a name over
  // DISCORD_THREAD_NAME_MAX characters (limit, actual); a tag that is not a Discord id or is given twice (field
  // settings.discord.tags.<index>); more than DISCORD_TAGS_MAX tags (limit, actual); a thread id that is not a Discord id.
  | 'DISCORD_NOT_SUPPORTED'
  | 'DISCORD_INVALID'
  | 'DISCORD_FORUM_ONLY'
  | 'DISCORD_THREAD_CONFLICT'
  | 'DISCORD_THREAD_NAME_REQUIRED'
  | 'DISCORD_THREAD_NAME_TOO_LONG'
  | 'DISCORD_TAG_INVALID'
  | 'DISCORD_TOO_MANY_TAGS'
  | 'DISCORD_THREAD_ID_INVALID';

export interface Issue {
  code: IssueCode;
  // 'body', 'title', 'media' or 'media.<index>'.
  field: string;
  limit: number | null;
  actual: number | null;
}

function checkText(issues: Issue[], field: 'body' | 'title', text: string, rule: TextRule): void {
  const required: IssueCode = field === 'body' ? 'TEXT_REQUIRED' : 'TITLE_REQUIRED';
  const tooLong: IssueCode = field === 'body' ? 'TEXT_TOO_LONG' : 'TITLE_TOO_LONG';
  if (rule.required && text.trim() === '') issues.push({ code: required, field, limit: null, actual: null });
  if (rule.max !== null) {
    const n = countText(text, rule.count);
    if (n > rule.max) {
      issues.push({ code: tooLong, field, limit: rule.max, actual: n });
      return;
    }
  }
  if (rule.maxBytes !== undefined) {
    const bytes = countText(text, 'bytes');
    if (bytes > rule.maxBytes) issues.push({ code: 'TEXT_TOO_MANY_BYTES', field, limit: rule.maxBytes, actual: bytes });
  }
}

// The audience, category and tags of a YouTube video (#905). Each is optional: absent, the adapter sends what it always
// did (not made for kids, category 22, no tags).
function checkYouTube(issues: Issue[], variant: VariantDraft): void {
  const s = variant.settings;
  if (s?.madeForKids !== undefined && typeof s.madeForKids !== 'boolean') issues.push({ code: 'YT_AUDIENCE_INVALID', field: 'settings.madeForKids', limit: null, actual: null });
  if (s?.syntheticMedia !== undefined && typeof s.syntheticMedia !== 'boolean') issues.push({ code: 'YT_SYNTHETIC_INVALID', field: 'settings.syntheticMedia', limit: null, actual: null });
  if (s?.categoryId !== undefined && !(YOUTUBE_CATEGORIES as readonly unknown[]).includes(s.categoryId)) issues.push({ code: 'YT_CATEGORY_INVALID', field: 'settings.categoryId', limit: null, actual: null });
  const tags = youtubeTagsOf(s);
  if (tags === 'invalid') {
    issues.push({ code: 'YT_TAG_INVALID', field: 'settings.tags', limit: null, actual: null });
    return;
  }
  if (tags === null) return;
  tags.forEach((tag, i) => {
    if (tag.trim() === '' || /[<>]/.test(tag)) issues.push({ code: 'YT_TAG_INVALID', field: `settings.tags.${i}`, limit: null, actual: null });
  });
  const n = youtubeTagsLength(tags);
  if (n > YOUTUBE_TAGS_MAX) issues.push({ code: 'YT_TAGS_TOO_LONG', field: 'settings.tags', limit: YOUTUBE_TAGS_MAX, actual: n });
}

// Collaborators go on feed posts and Reels, people tags on image posts (on the first image); a Story takes neither.
function checkInstagramPeople(issues: Issue[], variant: VariantDraft) {
  const collaborators = instagramPeopleOf(variant.settings, 'collaborators');
  const tags = instagramPeopleOf(variant.settings, 'userTags');
  if (collaborators === null && tags === null) return;
  const story = postTypeOf(variant.settings) === 'story';
  if (collaborators === 'invalid' || (collaborators && collaborators.length > IG_COLLABORATORS_MAX)) {
    issues.push({ code: 'IG_COLLABORATORS_INVALID', field: 'settings.collaborators', limit: IG_COLLABORATORS_MAX, actual: Array.isArray(collaborators) ? collaborators.length : null });
  } else if (collaborators && story) {
    issues.push({ code: 'IG_TAGS_NOT_SUPPORTED', field: 'settings.collaborators', limit: null, actual: null });
  }
  if (tags === 'invalid' || (tags && tags.length > IG_USER_TAGS_MAX)) {
    issues.push({ code: 'IG_USER_TAGS_INVALID', field: 'settings.userTags', limit: IG_USER_TAGS_MAX, actual: Array.isArray(tags) ? tags.length : null });
  } else if (tags && (story || variant.media[0]?.kind !== 'image')) {
    issues.push({ code: 'IG_TAGS_NOT_SUPPORTED', field: 'settings.userTags', limit: null, actual: null });
  }
}

export function validateVariant(variant: VariantDraft, given: ChannelCapabilities = CAPABILITIES[variant.provider]): Issue[] {
  const issues: Issue[] = [];
  // A photo post's own text limit, where the channel has one (#710).
  const photoMax = PHOTO_BODY_MAX[variant.provider];
  const photos = variant.media.length > 0 && variant.media.every((m) => m.kind === 'image');
  const withPhotos = photoMax !== undefined && photos ? { ...given, body: { ...given.body, max: photoMax } } : given;
  // A caption's own limit, where posts with media take one (#747).
  const mediaMax = MEDIA_BODY_MAX[variant.provider];
  const caps = mediaMax !== undefined && variant.media.length > 0 ? { ...withPhotos, body: { ...withPhotos.body, max: mediaMax } } : withPhotos;
  // The text with the signature (#1190), before the link: effectiveContent appends it already, and appending it again
  // changes nothing.
  const body = withSignature(variant.body, variant.settings);
  // No channel takes an empty post: it needs text or media.
  if (body.trim() === '' && variant.media.length === 0) issues.push({ code: 'CONTENT_REQUIRED', field: 'body', limit: null, actual: null });
  // The text as the adapter sends it, with the link it appends.
  // The link as the channel sends it, with its UTM tags (#585), counted where the channel counts it.
  // The post type (#644): a Story sends no text or link, so neither is checked; a Reel's text is checked as a post's.
  const postType = postTypeOf(variant.settings);
  if (postType === null || (postType !== 'feed' && !POST_TYPE_RULES[variant.provider]?.includes(postType))) {
    issues.push({ code: 'POST_TYPE_NOT_SUPPORTED', field: 'settings.postType', limit: null, actual: null });
  }
  // Story and Reel rules hold only where the channel posts them; elsewhere the refusal above is the one issue to fix.
  const supported = postType !== null && (postType === 'feed' || Boolean(POST_TYPE_RULES[variant.provider]?.includes(postType)));
  const story = supported && postType === 'story';
  const reel = supported && postType === 'reel';
  const sent = story ? '' : sentText(variant.provider, body, sentLink(variant.provider, variant.linkUrl ?? null, variant.settings, body), variant.media.length);
  if (!story) checkText(issues, 'body', sent, caps.body);
  if (variant.provider === 'instagram' && !story) {
    const hashtags = captionHashtags(sent);
    if (hashtags > IG_HASHTAGS_MAX) issues.push({ code: 'IG_TOO_MANY_HASHTAGS', field: 'body', limit: IG_HASHTAGS_MAX, actual: hashtags });
    const mentions = captionMentions(sent);
    if (mentions > IG_MENTIONS_MAX) issues.push({ code: 'IG_TOO_MANY_MENTIONS', field: 'body', limit: IG_MENTIONS_MAX, actual: mentions });
  }
  if (signatureOf(variant.settings) === 'invalid') issues.push({ code: 'SIGNATURE_INVALID', field: 'settings.signature', limit: SIGNATURE_MAX, actual: null });
  // A Discord forum post (#1103) takes the post's title as its name, cut to Discord's limit by the adapter.
  const titleRule = caps.title ?? (isDiscordForum(variant.provider, variant.settings) ? DISCORD_FORUM_TITLE : null);
  if (story) {
    // Nothing to check: the title is not sent either.
  } else if (titleRule) checkText(issues, 'title', variant.title ?? '', titleRule);
  else if (variant.title !== null && variant.title.trim() !== '') issues.push({ code: 'TITLE_NOT_SUPPORTED', field: 'title', limit: null, actual: null });

  const { media } = variant;
  const rule = caps.media;
  if (story && media.length !== 1) issues.push({ code: 'STORY_ONE_MEDIA', field: 'media', limit: 1, actual: media.length });
  else if (reel && (media.length !== 1 || media[0]?.kind !== 'video')) issues.push({ code: 'REEL_ONE_VIDEO', field: 'media', limit: 1, actual: media.length });
  else if (!story && !reel) {
    if (media.length < rule.min) issues.push({ code: 'MEDIA_REQUIRED', field: 'media', limit: rule.min, actual: media.length });
    if (media.length > rule.max) issues.push({ code: 'TOO_MANY_MEDIA', field: 'media', limit: rule.max, actual: media.length });
  }
  const videos = media.filter((m) => m.kind === 'video').length;
  if (videos > rule.maxVideos && rule.kinds.includes('video')) {
    issues.push({ code: 'TOO_MANY_VIDEOS', field: 'media', limit: rule.maxVideos, actual: videos });
  }
  const allowedKinds = media.every((m) => rule.kinds.includes(m.kind));
  // A document goes alone (#1119): said once for the post, instead of a mix of images and video.
  const documents = media.filter((m) => m.kind === 'document').length;
  if (documents > 0 && media.length > 1 && rule.kinds.includes('document')) issues.push({ code: 'DOCUMENT_ALONE', field: 'media', limit: 1, actual: media.length });
  else if (!rule.mixed && allowedKinds && videos > 0 && videos < media.length) issues.push({ code: 'MEDIA_MIX_NOT_ALLOWED', field: 'media', limit: null, actual: null });

  media.forEach((m, i) => {
    const field = `media.${i}`;
    if (!rule.kinds.includes(m.kind)) {
      issues.push({ code: m.kind === 'document' ? 'DOCUMENT_NOT_SUPPORTED' : 'MEDIA_KIND_NOT_ALLOWED', field, limit: null, actual: null });
      return;
    }
    if (m.kind === 'document') {
      if (rule.maxDocumentBytes !== undefined && m.sizeBytes > rule.maxDocumentBytes) issues.push({ code: 'DOCUMENT_TOO_LARGE', field, limit: rule.maxDocumentBytes, actual: m.sizeBytes });
    } else if (m.kind === 'image') {
      if (VIDEO_ONLY_ADAPTERS.has(variant.provider)) issues.push({ code: 'IMAGES_NOT_SUPPORTED_YET', field, limit: null, actual: null });
      if (rule.imageTypes.length > 0 && !rule.imageTypes.includes(m.mime.toLowerCase())) {
        issues.push({ code: 'IMAGE_TYPE_NOT_ALLOWED', field, limit: null, actual: null });
      }
      if (rule.maxImageBytes !== null && m.sizeBytes > rule.maxImageBytes) {
        issues.push({ code: 'IMAGE_TOO_LARGE', field, limit: rule.maxImageBytes, actual: m.sizeBytes });
      }
      // A Story image is held to the upright Story frame instead of the feed's shapes, on every channel that posts one.
      const feed = IMAGE_RULES[variant.provider];
      const shape = story ? { ...STORY_IMAGE, minWidth: feed?.minWidth ?? 0 } : feed;
      if (shape && m.width && m.height) {
        const ratio = m.width / m.height;
        if (ratio < shape.minRatio * (1 - RATIO_SLACK) || ratio > shape.maxRatio * (1 + RATIO_SLACK)) {
          issues.push({ code: 'IMAGE_RATIO_NOT_ALLOWED', field, limit: null, actual: Math.round(ratio * 1000) });
        }
        if (m.width < shape.minWidth) issues.push({ code: 'IMAGE_TOO_SMALL', field, limit: shape.minWidth, actual: m.width });
      }
    } else {
      if (!VIDEO_READY.has(variant.provider)) issues.push({ code: 'VIDEO_NOT_SUPPORTED_YET', field, limit: null, actual: null });
      if (rule.maxVideoBytes !== null && m.sizeBytes > rule.maxVideoBytes) {
        issues.push({ code: 'VIDEO_TOO_LARGE', field, limit: rule.maxVideoBytes, actual: m.sizeBytes });
      }
      const maxSeconds = story ? STORY_MAX_VIDEO_SECONDS : reel ? (REEL_MAX_VIDEO_SECONDS[variant.provider] ?? rule.maxVideoSeconds) : rule.maxVideoSeconds;
      if (maxSeconds !== null && m.durationSeconds !== null && m.durationSeconds > maxSeconds) {
        issues.push({ code: 'VIDEO_TOO_LONG', field, limit: maxSeconds, actual: m.durationSeconds });
      }
      // A channel with a length limit and a video whose length could not be read (#850): checked, not let through.
      if (maxSeconds !== null && m.durationSeconds === null) issues.push({ code: 'VIDEO_LENGTH_UNKNOWN', field, limit: maxSeconds, actual: null });
    }
  });

  const comment = firstCommentOf(variant.settings);
  if (comment !== null) {
    // A Story takes no comment from its account.
    const rule = story ? undefined : COMMENT_RULES[variant.provider];
    if (!rule) issues.push({ code: 'COMMENT_NOT_SUPPORTED', field: 'settings.firstComment', limit: null, actual: null });
    else {
      const n = countText(comment, rule.count);
      const bytes = countText(comment, 'bytes');
      if (rule.max !== null && n > rule.max) issues.push({ code: 'COMMENT_TOO_LONG', field: 'settings.firstComment', limit: rule.max, actual: n });
      else if (rule.maxBytes !== undefined && bytes > rule.maxBytes) issues.push({ code: 'COMMENT_TOO_LONG', field: 'settings.firstComment', limit: rule.maxBytes, actual: bytes });
    }
  }
  const parts = threadPartsOf(variant.settings);
  if (variant.settings?.threadParts !== undefined && !Array.isArray(variant.settings.threadParts)) issues.push({ code: 'THREAD_PART_EMPTY', field: 'settings.threadParts', limit: null, actual: null });
  if (parts) {
    const rule = story ? undefined : THREAD_RULES[variant.provider];
    if (!rule) issues.push({ code: 'THREAD_NOT_SUPPORTED', field: 'settings.threadParts', limit: null, actual: null });
    else {
      if (parts.length > THREAD_PARTS_MAX) issues.push({ code: 'THREAD_TOO_MANY_PARTS', field: 'settings.threadParts', limit: THREAD_PARTS_MAX, actual: parts.length });
      if (comment !== null) issues.push({ code: 'THREAD_WITH_COMMENT', field: 'settings.firstComment', limit: null, actual: null });
      parts.slice(0, THREAD_PARTS_MAX).forEach((part, i) => {
        const field = `settings.threadParts.${i}`;
        if (!part) return void issues.push({ code: 'THREAD_PART_EMPTY', field, limit: null, actual: null });
        const n = countText(part, rule.count);
        const bytes = countText(part, 'bytes');
        if (rule.max !== null && n > rule.max) issues.push({ code: 'THREAD_PART_TOO_LONG', field, limit: rule.max, actual: n });
        else if (rule.maxBytes !== undefined && bytes > rule.maxBytes) issues.push({ code: 'THREAD_PART_TOO_LONG', field, limit: rule.maxBytes, actual: bytes });
      });
    }
  }
  const repost = repostRuleOf(variant.settings);
  if (repost !== null) {
    if (story || !REPOST_PROVIDERS.has(variant.provider)) issues.push({ code: 'REPOST_NOT_SUPPORTED', field: 'settings.repost', limit: null, actual: null });
    else if (repost === 'invalid') issues.push({ code: 'REPOST_INVALID', field: 'settings.repost', limit: REPOST_HOURS_MAX, actual: null });
  }
  const removeAt = removeAtOf(variant.settings);
  if (removeAt !== null) {
    if (story || !REMOVE_READY.has(variant.provider)) issues.push({ code: 'REMOVE_AT_NOT_SUPPORTED', field: 'settings.removeAt', limit: null, actual: null });
    else if (removeAt === 'invalid') issues.push({ code: 'REMOVE_AT_INVALID', field: 'settings.removeAt', limit: null, actual: null });
  }
  const reply = autoReplyOf(variant.settings);
  if (reply !== null) {
    const rule = story ? undefined : AUTO_REPLY_RULES[variant.provider];
    if (!rule) issues.push({ code: 'AUTO_REPLY_NOT_SUPPORTED', field: 'settings.autoReply', limit: null, actual: null });
    else if (reply === 'invalid') issues.push({ code: 'AUTO_REPLY_INVALID', field: 'settings.autoReply', limit: AUTO_REPLY_LIKES_MAX, actual: null });
    else {
      const n = countText(reply.text, rule.count);
      const bytes = countText(reply.text, 'bytes');
      if (rule.max !== null && n > rule.max) issues.push({ code: 'AUTO_REPLY_TOO_LONG', field: 'settings.autoReply.text', limit: rule.max, actual: n });
      else if (rule.maxBytes !== undefined && bytes > rule.maxBytes) issues.push({ code: 'AUTO_REPLY_TOO_LONG', field: 'settings.autoReply.text', limit: rule.maxBytes, actual: bytes });
    }
  }
  if (variant.provider === 'mastodon') {
    const visibility = variant.settings?.visibility;
    if (visibility !== undefined && !(MASTODON_VISIBILITY as readonly unknown[]).includes(visibility)) issues.push({ code: 'VISIBILITY_INVALID', field: 'settings.visibility', limit: null, actual: null });
    const cw = variant.settings?.contentWarning;
    if (cw !== undefined && (typeof cw !== 'string' || countText(cw, 'codepoints') > CONTENT_WARNING_MAX)) issues.push({ code: 'CONTENT_WARNING_TOO_LONG', field: 'settings.contentWarning', limit: CONTENT_WARNING_MAX, actual: typeof cw === 'string' ? countText(cw, 'codepoints') : null });
  }
  // LinkedIn (#983): who sees the post, public unless chosen; a Company Page (#1077) has no connections to choose.
  const linkedinValues = linkedinVisibilities(variant.provider);
  if (linkedinValues && variant.settings?.visibility !== undefined && !(linkedinValues as readonly unknown[]).includes(variant.settings.visibility)) {
    issues.push({ code: 'VISIBILITY_INVALID', field: 'settings.visibility', limit: null, actual: null });
  }
  checkDocumentTitle(issues, variant);
  if (variant.provider === 'instagram') checkInstagramPeople(issues, variant);
  // Instagram Reels (#1019): in the feed too unless chosen.
  const reelOptions = instagramReelOf(variant.settings);
  if (reelOptions !== null) {
    if (variant.provider !== 'instagram') issues.push({ code: 'INSTAGRAM_NOT_SUPPORTED', field: 'settings.instagram', limit: null, actual: null });
    else if (reelOptions === 'invalid') issues.push({ code: 'IG_REEL_FEED_INVALID', field: 'settings.instagram', limit: null, actual: null });
    else if (!isInstagramReel(variant.media, variant.settings)) issues.push({ code: 'IG_REEL_FEED_NOT_REEL', field: 'settings.instagram.reelFeed', limit: null, actual: null });
  }
  if (variant.provider === 'youtube') checkYouTube(issues, variant);
  // YouTube playlists (#1018), none when absent.
  const playlists = youtubePlaylistsOf(variant.settings);
  if (playlists !== null) {
    if (variant.provider !== 'youtube') issues.push({ code: 'YOUTUBE_NOT_SUPPORTED', field: 'settings.youtube', limit: null, actual: null });
    else if (playlists === 'invalid') issues.push({ code: 'YT_PLAYLISTS_INVALID', field: 'settings.youtube.playlistIds', limit: null, actual: null });
    else if (playlists.length > YOUTUBE_PLAYLISTS_MAX) issues.push({ code: 'YT_PLAYLISTS_TOO_MANY', field: 'settings.youtube.playlistIds', limit: YOUTUBE_PLAYLISTS_MAX, actual: playlists.length });
  }
  // Pinterest board sections (#1120), none when absent. Whether the board still has the section is checked when
  // publishing, against the board as it is then.
  const section = pinterestSectionOf(variant.settings);
  if (section !== null) {
    if (variant.provider !== 'pinterest') issues.push({ code: 'PINTEREST_NOT_SUPPORTED', field: 'settings.pinterest', limit: null, actual: null });
    else if (section === 'invalid') issues.push({ code: 'PINTEREST_SECTION_INVALID', field: 'settings.pinterest.sectionId', limit: null, actual: null });
  }
  // Zalo OA (#943): comments on the article, on when absent.
  if (variant.provider === 'zalo_oa' && variant.settings?.comments !== undefined && typeof variant.settings.comments !== 'boolean') {
    issues.push({ code: 'ZALO_COMMENTS_INVALID', field: 'settings.comments', limit: null, actual: null });
  }
  // Telegram (#982): a silent post and a pin, off when absent.
  const telegram = telegramOptionsOf(variant.settings);
  if (telegram !== null) {
    if (variant.provider !== 'telegram') issues.push({ code: 'TELEGRAM_NOT_SUPPORTED', field: 'settings.telegram', limit: null, actual: null });
    else if (telegram === 'invalid') issues.push({ code: 'TELEGRAM_INVALID', field: 'settings.telegram', limit: null, actual: null });
    else checkTelegramButtons(issues, variant);
  }
  if (variant.settings?.cover !== undefined) checkCover(issues, variant);
  checkDiscord(issues, variant, sent);
  checkPollAndTag(issues, variant, caps, sent);
  checkGbp(issues, variant);
  checkWordPress(issues, variant);
  if (variant.provider === 'tiktok') {
    // Direct posts need a privacy level; a draft sent to the TikTok inbox (#903) takes none.
    const mode = tiktokModeOf(variant.settings);
    if (mode === null) issues.push({ code: 'TIKTOK_MODE_INVALID', field: 'settings.tiktokMode', limit: null, actual: null });
    else if (mode === 'direct' && !TIKTOK_PRIVACY.includes(String(variant.settings?.privacyLevel ?? ''))) {
      issues.push({ code: 'PRIVACY_REQUIRED', field: 'settings.privacyLevel', limit: null, actual: null });
    }
  }
  checkTikTokDisclosure(issues, variant);
  if (caps.maxLinks !== null) {
    const links = countLinks(sent);
    if (links > caps.maxLinks) issues.push({ code: 'TOO_MANY_LINKS', field: 'body', limit: caps.maxLinks, actual: links });
  }
  return issues;
}

// A LinkedIn document's title (#1119). Absent, the adapter sends the post's title or the file's name.
function checkDocumentTitle(issues: Issue[], variant: VariantDraft): void {
  const title = documentTitleOf(variant.settings);
  if (title === null) return;
  if (!DOCUMENT_PROVIDERS.has(variant.provider)) return void issues.push({ code: 'LINKEDIN_NOT_SUPPORTED', field: 'settings.linkedin', limit: null, actual: null });
  if (title === 'invalid') {
    const raw = (variant.settings?.linkedin as { documentTitle?: unknown } | undefined)?.documentTitle;
    return void issues.push({ code: 'DOCUMENT_TITLE_INVALID', field: 'settings.linkedin.documentTitle', limit: DOCUMENT_TITLE_MAX, actual: typeof raw === 'string' ? raw.trim().normalize('NFC').length : null });
  }
  if (!variant.media.some((m) => m.kind === 'document')) issues.push({ code: 'DOCUMENT_TITLE_NEEDS_DOCUMENT', field: 'settings.linkedin.documentTitle', limit: null, actual: null });
}

const DISCORD_FORUM_TITLE: TextRule = { max: null, count: 'utf16', required: false };

// Discord forum posts and threads (#1103). Absent, the post is a message in the webhook's channel, as before. sent: the
// text as the adapter sends it, whose first line names a forum post without a name or title.
function checkDiscord(issues: Issue[], variant: VariantDraft, sent: string): void {
  const options = discordOptionsOf(variant.settings);
  if (options === null) return;
  const field = 'settings.discord';
  if (variant.provider !== 'discord') return void issues.push({ code: 'DISCORD_NOT_SUPPORTED', field, limit: null, actual: null });
  if (options === 'invalid') return void issues.push({ code: 'DISCORD_INVALID', field, limit: null, actual: null });
  const name = options.threadName?.trim() ?? '';
  if (!options.forum && (name !== '' || options.tags.length > 0)) issues.push({ code: 'DISCORD_FORUM_ONLY', field: `${field}.forum`, limit: null, actual: null });
  if (options.forum && options.threadId !== null) issues.push({ code: 'DISCORD_THREAD_CONFLICT', field: `${field}.threadId`, limit: null, actual: null });
  if (options.forum && discordThreadName(options.threadName, variant.title, sent) === '') issues.push({ code: 'DISCORD_THREAD_NAME_REQUIRED', field: `${field}.threadName`, limit: null, actual: null });
  if (name.length > DISCORD_THREAD_NAME_MAX) issues.push({ code: 'DISCORD_THREAD_NAME_TOO_LONG', field: `${field}.threadName`, limit: DISCORD_THREAD_NAME_MAX, actual: name.length });
  const seen = new Set<string>();
  options.tags.forEach((tag, i) => {
    if (!isDiscordId(tag) || seen.has(tag)) issues.push({ code: 'DISCORD_TAG_INVALID', field: `${field}.tags.${i}`, limit: null, actual: null });
    seen.add(tag);
  });
  if (options.tags.length > DISCORD_TAGS_MAX) issues.push({ code: 'DISCORD_TOO_MANY_TAGS', field: `${field}.tags`, limit: DISCORD_TAGS_MAX, actual: options.tags.length });
  if (options.threadId !== null && !isDiscordId(options.threadId)) issues.push({ code: 'DISCORD_THREAD_ID_INVALID', field: `${field}.threadId`, limit: null, actual: null });
}

// TikTok's commercial content and AI labels (#1078). Absent, the adapter sends what it always did (no disclosure).
function checkTikTokDisclosure(issues: Issue[], variant: VariantDraft): void {
  const disclosure = tiktokDisclosureOf(variant.settings);
  if (disclosure === null) return;
  const field = 'settings.tiktok';
  if (variant.provider !== 'tiktok') issues.push({ code: 'TIKTOK_NOT_SUPPORTED', field, limit: null, actual: null });
  else if (disclosure === 'invalid') issues.push({ code: 'TIKTOK_DISCLOSURE_INVALID', field, limit: null, actual: null });
  else if (tiktokModeOf(variant.settings) === 'inbox') issues.push({ code: 'TIKTOK_DISCLOSURE_INBOX', field, limit: null, actual: null });
  else {
    if (disclosure.commercial && !disclosure.yourBrand && !disclosure.brandedContent) issues.push({ code: 'TIKTOK_COMMERCIAL_CHOOSE', field: 'settings.tiktok.commercial', limit: null, actual: null });
    if (disclosure.brandedContent && variant.settings?.privacyLevel === 'SELF_ONLY') issues.push({ code: 'TIKTOK_BRANDED_PRIVATE', field: 'settings.tiktok.brandedContent', limit: null, actual: null });
  }
}

// A poll's choices and question (#1118): several answers and hidden counts only where the channel's polls take them
// (false, the default, is fine anywhere); LinkedIn's own question, required; Telegram's question, the text as sent.
function checkPollChoices(issues: Issue[], variant: VariantDraft, rule: PollRule, sent: string): void {
  for (const key of ['multiple', 'hideTotals'] as const) {
    const value = pollFlagOf(variant.settings, key);
    const field = `settings.poll.${key}`;
    if (value === 'invalid') issues.push({ code: 'POLL_SETTING_INVALID', field, limit: null, actual: null });
    else if (value && !rule[key]) issues.push({ code: 'POLL_SETTING_NOT_SUPPORTED', field, limit: null, actual: null });
  }
  const question = pollQuestionOf(variant.settings);
  const field = 'settings.poll.question';
  if (question === 'invalid') issues.push({ code: 'POLL_SETTING_INVALID', field, limit: null, actual: null });
  else if (rule.question) {
    const n = question === null ? 0 : countText(question, rule.question.count);
    if (n < 1 || n > rule.question.maxChars) issues.push({ code: 'POLL_QUESTION_LENGTH', field, limit: rule.question.maxChars, actual: n });
  } else if (question) issues.push({ code: 'POLL_SETTING_NOT_SUPPORTED', field, limit: null, actual: null });
  if (rule.textAsQuestion) {
    const n = countText(sent.trim(), CAPABILITIES[variant.provider].body.count);
    if (n < 1 || n > rule.textAsQuestion.maxChars) issues.push({ code: 'POLL_TEXT_LENGTH', field: 'body', limit: rule.textAsQuestion.maxChars, actual: n });
  }
}

function checkPollAndTag(issues: Issue[], variant: VariantDraft, caps: ChannelCapabilities, sent: string): void {
  const options = pollOptionsOf(variant.settings);
  const rule = options !== null ? POLL_RULES[variant.provider] : undefined;
  if (options !== null && !rule) issues.push({ code: 'POLL_NOT_SUPPORTED', field: 'settings.poll', limit: null, actual: null });
  if (options !== null && rule) {
    if (options === 'invalid' || options.length < rule.minOptions || options.length > rule.maxOptions) {
      issues.push({ code: 'POLL_OPTIONS', field: 'settings.poll', limit: rule.maxOptions, actual: options === 'invalid' ? null : options.length });
    } else {
      options.forEach((option, i) => {
        const n = countText(option, rule.count ?? 'codepoints');
        if (n < 1 || n > rule.maxChars) issues.push({ code: 'POLL_OPTION_LENGTH', field: `settings.poll.${i}`, limit: rule.maxChars, actual: n });
      });
    }
    const minutes = rule.duration ? pollDurationOf(variant.settings) : null;
    const length = rule.duration;
    if (length && minutes !== null && (minutes === 'invalid' || minutes < length.min || minutes > length.max || (length.choices !== undefined && !length.choices.includes(minutes)))) {
      issues.push({ code: 'POLL_DURATION', field: 'settings.poll.durationMinutes', limit: length.max, actual: minutes === 'invalid' ? null : minutes });
    }
    checkPollChoices(issues, variant, rule, sent);
    if (variant.media.length > 0) issues.push({ code: 'POLL_WITH_MEDIA', field: 'settings.poll', limit: null, actual: null });
  }
  const replyAllowed = REPLY_SETTINGS[variant.provider];
  if (replyAllowed && variant.settings?.replySettings !== undefined && !(replyAllowed as readonly unknown[]).includes(variant.settings.replySettings)) {
    issues.push({ code: 'REPLY_SETTINGS_INVALID', field: 'settings.replySettings', limit: null, actual: null });
  }
  // Bluesky (#1102): who may reply, one choice or several rules together, and whether others may quote the post.
  if (variant.provider === 'bluesky' && blueskyRepliesOf(variant.settings) === 'invalid') issues.push({ code: 'REPLY_SETTINGS_INVALID', field: 'settings.replySettings', limit: null, actual: null });
  if (variant.settings?.quotes !== undefined) {
    if (variant.provider !== 'bluesky') issues.push({ code: 'QUOTES_NOT_SUPPORTED', field: 'settings.quotes', limit: null, actual: null });
    else if (typeof variant.settings.quotes !== 'boolean') issues.push({ code: 'QUOTES_INVALID', field: 'settings.quotes', limit: null, actual: null });
  }
  const tag = topicTagOf(variant.settings);
  if (tag !== null) {
    const rule = TOPIC_TAG_RULES[variant.provider];
    if (!rule) issues.push({ code: 'TOPIC_TAG_NOT_SUPPORTED', field: 'settings.topicTag', limit: null, actual: null });
    else {
      const n = tag === false ? 0 : countText(tag, caps.body.count);
      if (tag === false || n < 1 || n > rule.maxChars || /[.&]/.test(tag)) issues.push({ code: 'TOPIC_TAG_INVALID', field: 'settings.topicTag', limit: rule.maxChars, actual: n });
    }
  }
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
function checkGbp(issues: Issue[], variant: VariantDraft): void {
  const raw = variant.settings?.gbp;
  if (raw === undefined || raw === null) return;
  const field = 'settings.gbp';
  if (variant.provider !== 'google_business') {
    issues.push({ code: 'GBP_NOT_SUPPORTED', field, limit: null, actual: null });
    return;
  }
  const g = gbpOf(variant.settings);
  const r = raw as Record<string, unknown>;
  const known = g !== null && (r.topic === undefined || (GBP_TOPICS as readonly unknown[]).includes(r.topic)) && (r.cta === undefined || r.cta === null || (GBP_CTAS as readonly unknown[]).includes(r.cta)) &&
    (r.language === undefined || r.language === null || (GBP_LANGUAGES as readonly unknown[]).includes(r.language));
  if (!g || !known) {
    issues.push({ code: 'GBP_INVALID', field, limit: null, actual: null });
    return;
  }
  if (g.topic !== 'STANDARD') {
    const e = g.event;
    const titleLength = [...e.title.trim()].length;
    const dated = DAY.test(e.startDate) && DAY.test(e.endDate) && e.endDate >= e.startDate;
    const timed = (e.startTime === '' || TIME.test(e.startTime)) && (e.endTime === '' || TIME.test(e.endTime));
    if (!dated || !timed || titleLength > 58 || (g.topic === 'EVENT' && titleLength === 0)) issues.push({ code: 'GBP_INVALID', field: 'settings.gbp.event', limit: 58, actual: titleLength });
  }
  if (g.cta && g.cta !== 'CALL' && !(variant.linkUrl ?? '').trim()) issues.push({ code: 'GBP_CTA_NEEDS_LINK', field, limit: null, actual: null });
}

// A WordPress post's categories, tags, excerpt and status (#981). Each is optional; the names are checked against the
// site only when the post goes out (an unknown category then fails it with nothing posted).
// Telegram's link buttons (#1017): rows of labelled https links, none on an album.
function checkTelegramButtons(issues: Issue[], variant: VariantDraft): void {
  const rows = telegramButtonsOf(variant.settings);
  if (rows === null) return;
  const field = 'settings.telegram.buttons';
  if (rows === 'invalid') return void issues.push({ code: 'TELEGRAM_BUTTONS_INVALID', field, limit: null, actual: null });
  if (variant.media.length > 1) issues.push({ code: 'TELEGRAM_BUTTONS_ON_ALBUM', field, limit: null, actual: variant.media.length });
  if (rows.length > TELEGRAM_BUTTON_ROWS_MAX) issues.push({ code: 'TELEGRAM_TOO_MANY_BUTTONS', field, limit: TELEGRAM_BUTTON_ROWS_MAX, actual: rows.length });
  rows.forEach((row: TelegramButton[], r) => {
    if (row.length > TELEGRAM_BUTTONS_PER_ROW_MAX) issues.push({ code: 'TELEGRAM_TOO_MANY_BUTTONS', field: `${field}.${r}`, limit: TELEGRAM_BUTTONS_PER_ROW_MAX, actual: row.length });
    row.forEach((button, i) => {
      const n = countText(button.text.trim(), 'codepoints');
      if (n < 1 || n > TELEGRAM_BUTTON_TEXT_MAX) issues.push({ code: 'TELEGRAM_BUTTON_TEXT_LENGTH', field: `${field}.${r}.${i}.text`, limit: TELEGRAM_BUTTON_TEXT_MAX, actual: n });
      if (!isButtonUrl(button.url)) issues.push({ code: 'TELEGRAM_BUTTON_URL_INVALID', field: `${field}.${r}.${i}.url`, limit: null, actual: null });
    });
  });
}

function checkWordPress(issues: Issue[], variant: VariantDraft): void {
  const raw = variant.settings?.wordpress;
  if (raw === undefined || raw === null) return;
  const field = 'settings.wordpress';
  if (variant.provider !== 'wordpress') {
    issues.push({ code: 'WORDPRESS_NOT_SUPPORTED', field, limit: null, actual: null });
    return;
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    issues.push({ code: 'WORDPRESS_INVALID', field, limit: null, actual: null });
    return;
  }
  const w = raw as Record<string, unknown>;
  const names = (key: 'categories' | 'tags', max: number, tooMany: IssueCode) => {
    const value = w[key];
    if (value === undefined || value === null) return;
    if (!Array.isArray(value)) {
      issues.push({ code: 'WORDPRESS_TERM_INVALID', field: `${field}.${key}`, limit: WORDPRESS_TERM_MAX, actual: null });
      return;
    }
    if (value.length > max) issues.push({ code: tooMany, field: `${field}.${key}`, limit: max, actual: value.length });
    value.forEach((name, i) => {
      const n = typeof name === 'string' ? countText(name.trim(), 'codepoints') : null;
      if (n === null || n === 0 || n > WORDPRESS_TERM_MAX || /[<>]/.test(name as string)) issues.push({ code: 'WORDPRESS_TERM_INVALID', field: `${field}.${key}.${i}`, limit: WORDPRESS_TERM_MAX, actual: n });
    });
  };
  names('categories', WORDPRESS_CATEGORIES_MAX, 'WORDPRESS_TOO_MANY_CATEGORIES');
  names('tags', WORDPRESS_TAGS_MAX, 'WORDPRESS_TOO_MANY_TAGS');
  const excerpt = w.excerpt;
  if (excerpt !== undefined && excerpt !== null) {
    const n = typeof excerpt === 'string' ? countText(excerpt.trim(), 'codepoints') : null;
    if (n === null || n > WORDPRESS_EXCERPT_MAX) issues.push({ code: 'WORDPRESS_EXCERPT_TOO_LONG', field: `${field}.excerpt`, limit: WORDPRESS_EXCERPT_MAX, actual: n });
  }
  if (w.status !== undefined && w.status !== null && !(WORDPRESS_STATUSES as readonly unknown[]).includes(w.status)) {
    issues.push({ code: 'WORDPRESS_STATUS_INVALID', field: `${field}.status`, limit: null, actual: null });
  }
}

// A cover belongs to one video, alone in the post (a Reel on Instagram); the channel decides which kinds it takes.
function checkCover(issues: Issue[], variant: VariantDraft): void {
  const field = 'settings.cover';
  const cover = coverOf(variant.settings);
  if (!cover) {
    issues.push({ code: 'COVER_INVALID', field, limit: null, actual: null });
    return;
  }
  const video = variant.media.length === 1 && variant.media[0]?.kind === 'video' ? variant.media[0] : null;
  if (!video) {
    issues.push({ code: 'COVER_NEEDS_VIDEO', field, limit: null, actual: null });
    return;
  }
  // A Story takes no cover (#644), nor a draft sent to the TikTok inbox (#903): the creator picks it in TikTok.
  const tiktokInbox = variant.provider === 'tiktok' && tiktokModeOf(variant.settings) === 'inbox';
  if (postTypeOf(variant.settings) === 'story' || tiktokInbox || !COVER_RULES[variant.provider]?.includes(coverKind(cover))) {
    issues.push({ code: 'COVER_NOT_SUPPORTED', field, limit: null, actual: null });
    return;
  }
  // A frame within the video, when its length is known (read at upload).
  if ('atMs' in cover && video.durationSeconds !== null) {
    const lastMs = Math.floor(video.durationSeconds * 1000);
    if (cover.atMs > lastMs) issues.push({ code: 'COVER_OUT_OF_RANGE', field, limit: lastMs, actual: cover.atMs });
  }
}
