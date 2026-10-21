// Checks a variant against its channel's capabilities (Social plan §3.6). Returns every issue rather than the first,
// so the composer can show them all; an empty list means the variant fits the channel. A variant that breaks a
// rule is flagged, never silently cut.
import { AUTO_REPLY_LIKES_MAX, AUTO_REPLY_RULES, autoReplyOf, REPOST_HOURS_MAX, REPOST_PROVIDERS, repostRuleOf, CAPABILITIES, GBP_CTAS, GBP_LANGUAGES, GBP_TOPICS, gbpOf, COMMENT_RULES, CONTENT_WARNING_MAX, MASTODON_VISIBILITY, IG_COLLABORATORS_MAX, IG_USER_TAGS_MAX, instagramPeopleOf, THREAD_PARTS_MAX, THREAD_RULES, threadPartsOf, COVER_RULES, IMAGE_RULES, MEDIA_BODY_MAX, PHOTO_BODY_MAX, POLL_RULES, POST_TYPE_RULES, TOPIC_TAG_RULES, pollOptionsOf, topicTagOf, RATIO_SLACK, REEL_MAX_VIDEO_SECONDS, STORY_IMAGE, STORY_MAX_VIDEO_SECONDS, postTypeOf, VIDEO_ONLY_ADAPTERS, coverKind, coverOf, VIDEO_READY, countLinks, countText, firstCommentOf, sentText, YOUTUBE_CATEGORIES, YOUTUBE_TAGS_MAX, youtubeTagsLength, youtubeTagsOf, type ChannelCapabilities, type MediaKind, type Provider, type TextRule, tiktokModeOf } from './channels.ts';
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
  // TikTok: the person posting picks who sees the video; there is no default. Not in inbox mode (#903), where the
  // creator picks it in TikTok.
  | 'PRIVACY_REQUIRED'
  // TikTok (#903): settings.tiktokMode is neither 'direct' nor 'inbox'.
  | 'TIKTOK_MODE_INVALID'
  // The platform takes photos, Crove's adapter for it posts only video.
  | 'IMAGES_NOT_SUPPORTED_YET'
  | 'TOO_MANY_LINKS'
  // The first comment (#587): too long for the channel, or a channel that takes none yet.
  | 'COMMENT_TOO_LONG'
  | 'COMMENT_NOT_SUPPORTED'
  // Files the channel fetches by URL, on a deployment that hands out none (#772); raised by the composer, which knows.
  | 'MEDIA_NEEDS_PUBLIC_STORAGE'
  // Mastodon (#748): a visibility other than public or unlisted; a content warning over CONTENT_WARNING_MAX characters.
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
  | 'YT_TAGS_TOO_LONG';

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
  // No channel takes an empty post: it needs text or media.
  if (variant.body.trim() === '' && variant.media.length === 0) issues.push({ code: 'CONTENT_REQUIRED', field: 'body', limit: null, actual: null });
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
  const sent = story ? '' : sentText(variant.provider, variant.body, sentLink(variant.provider, variant.linkUrl ?? null, variant.settings, variant.body), variant.media.length);
  if (!story) checkText(issues, 'body', sent, caps.body);
  if (story) {
    // Nothing to check: the title is not sent either.
  } else if (caps.title) checkText(issues, 'title', variant.title ?? '', caps.title);
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
  if (!rule.mixed && allowedKinds && videos > 0 && videos < media.length) issues.push({ code: 'MEDIA_MIX_NOT_ALLOWED', field: 'media', limit: null, actual: null });

  media.forEach((m, i) => {
    const field = `media.${i}`;
    if (!rule.kinds.includes(m.kind)) {
      issues.push({ code: 'MEDIA_KIND_NOT_ALLOWED', field, limit: null, actual: null });
      return;
    }
    if (m.kind === 'image') {
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
  if (variant.provider === 'instagram') checkInstagramPeople(issues, variant);
  if (variant.provider === 'youtube') checkYouTube(issues, variant);
  if (variant.settings?.cover !== undefined) checkCover(issues, variant);
  checkPollAndTag(issues, variant, caps);
  checkGbp(issues, variant);
  if (variant.provider === 'tiktok') {
    // Direct posts need a privacy level; a draft sent to the TikTok inbox (#903) takes none.
    const mode = tiktokModeOf(variant.settings);
    if (mode === null) issues.push({ code: 'TIKTOK_MODE_INVALID', field: 'settings.tiktokMode', limit: null, actual: null });
    else if (mode === 'direct' && !TIKTOK_PRIVACY.includes(String(variant.settings?.privacyLevel ?? ''))) {
      issues.push({ code: 'PRIVACY_REQUIRED', field: 'settings.privacyLevel', limit: null, actual: null });
    }
  }
  if (caps.maxLinks !== null) {
    const links = countLinks(sent);
    if (links > caps.maxLinks) issues.push({ code: 'TOO_MANY_LINKS', field: 'body', limit: caps.maxLinks, actual: links });
  }
  return issues;
}

function checkPollAndTag(issues: Issue[], variant: VariantDraft, caps: ChannelCapabilities): void {
  const options = pollOptionsOf(variant.settings);
  if (options !== null) {
    const rule = POLL_RULES[variant.provider];
    if (!rule) issues.push({ code: 'POLL_NOT_SUPPORTED', field: 'settings.poll', limit: null, actual: null });
    else if (options === 'invalid' || options.length < rule.minOptions || options.length > rule.maxOptions) {
      issues.push({ code: 'POLL_OPTIONS', field: 'settings.poll', limit: rule.maxOptions, actual: options === 'invalid' ? null : options.length });
    } else {
      options.forEach((option, i) => {
        const n = countText(option, caps.body.count);
        if (n < 1 || n > rule.maxChars) issues.push({ code: 'POLL_OPTION_LENGTH', field: `settings.poll.${i}`, limit: rule.maxChars, actual: n });
      });
    }
    if (rule && variant.media.length > 0) issues.push({ code: 'POLL_WITH_MEDIA', field: 'settings.poll', limit: null, actual: null });
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
