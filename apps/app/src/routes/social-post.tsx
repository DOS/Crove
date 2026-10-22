// Compose a post and work on it: shared text, a variant per channel that inherits it or has its own text, live
// channel rules and a preview, then review (owners and admins decide on what they see), schedule and cancel.
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useBlocker, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useLocale, useTranslations } from 'use-intl';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Checkbox } from '@crove/ui/components/checkbox';
import { Input } from '@crove/ui/components/input';
import { Label } from '@crove/ui/components/label';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { Textarea } from '@crove/ui/components/textarea';
import { cn } from '@crove/ui/lib/utils';
import { hashtagSuggestions, hashtagsOf, REPOST_HOURS_MAX, REPOST_PROVIDERS, AUTO_REPLY_LIKES_MAX, AUTO_REPLY_RULES, COMMENT_RULES, THREAD_PARTS_MAX, THREAD_RULES, threadPartsOf, COVER_RULES, GBP_CTAS, GBP_LANGUAGES, GBP_TOPICS, gbpOf, POLL_RULES, POST_TYPE_RULES, TOPIC_TAG_RULES, coverKind, coverOf, isProvider, pollDurationOf, pollOptionsOf, postTypeOf, REMOVE_READY, sentLink, topicTagOf, utmOf, type Cover, type CoverKind, type Issue, YOUTUBE_CATEGORIES, YOUTUBE_DEFAULT_CATEGORY, YOUTUBE_TAGS_MAX, youtubeTagsLength, YOUTUBE_PLAYLISTS_MAX, youtubePlaylistIdFrom, youtubePlaylistsOf, SENT_TO_APP, tiktokModeOf, removeAtFit, removeAtOf, WORDPRESS_CATEGORIES_MAX, WORDPRESS_EXCERPT_MAX, WORDPRESS_STATUSES, WORDPRESS_TAGS_MAX, WORDPRESS_DRAFT, WORDPRESS_PENDING, TELEGRAM_PIN_SCOPE, telegramOptionsOf, localTime, REPLY_SETTINGS, replySettingOf, LINKEDIN_VISIBILITY, telegramButtonsOf, TELEGRAM_BUTTON_ROWS_MAX, TELEGRAM_BUTTONS_PER_ROW_MAX, TELEGRAM_BUTTON_TEXT_MAX, isButtonUrl, countText, type TelegramButton, IG_REEL_FEEDS, IG_TRIAL_GRADUATIONS, instagramReelOf, isInstagramReel, variantTexts, wordsForChannel, wordsForChannels } from '@crove/mod-social/contract';
import { SOCIAL_RECURRENCE_TIMES_MAX } from '@crove/kernel-contract';
import { CoverImageField, MediaField, type MediaItem } from '../components/social-media.tsx';
import { ChannelSetPicker } from '../components/social-channel-sets.tsx';
import { PlatformPreview } from '../components/social-preview.tsx';
import { SnippetPicker } from '../components/social-snippets.tsx';
import { ReviewLinks } from '../components/social-review-links.tsx';
import { PostActivity } from '../components/social-activity.tsx';
import { ReviewChanges } from '../components/social-review-diff.tsx';
import { PostVersions } from '../components/social-post-versions.tsx';
import { BannedWordHints, BannedWordReview, useBannedWords } from '../components/social-banned-words.tsx';
import { LabelPicker } from '../components/social-labels.tsx';
import { AssignCard } from '../components/social-assign.tsx';
import { BestTimeButton } from '../components/social-best-time.tsx';
import { EmojiPicker } from '../components/social-emoji.tsx';
import { ErrorText, Notice, PageHeader, Spinner } from '../components/ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';
import { getConfig } from '../lib/auth.ts';
import { clearDraft, loadDraft, saveDraft, type StoredDraft } from '../lib/social-draft.ts';
import { canMoveToFront } from '../lib/social-queue-order.ts';
import {
  CANCELLABLE,
  EDITABLE,
  draftIssues,
  fromLocalInput,
  hasTitle,
  providerName,
  SUBMITTABLE,
  setFlash,
  takeFlash,
  textBudget,
  toLocalInput,
  notPublicKey,
  variantStatusKey,
  variantTone,
  type VariantStatus,
} from '../lib/social.ts';

type Post = Awaited<ReturnType<typeof orpc.social.posts.get.call>>;
type Variant = Post['variants'][number];
type Channel = Awaited<ReturnType<typeof orpc.channels.list.call>>[number];

interface Base {
  body: string;
  title: string;
  linkUrl: string;
  media: MediaItem[];
}

// A channel's own text, or none (it uses the shared text).
interface Own {
  custom: boolean;
  body: string;
  title: string;
  // The channel's provider settings (TikTok privacy and interactions, YouTube visibility).
  settings: Record<string, unknown>;
  // The channel's own images or video instead of the post's (#581).
  customMedia: boolean;
  media: MediaItem[];
}

const EMPTY_OWN: Own = { custom: false, body: '', title: '', settings: {}, customMedia: false, media: [] };
const sameMediaList = (a: readonly MediaItem[], b: readonly MediaItem[]) => JSON.stringify(mediaInput(a)) === JSON.stringify(mediaInput(b));
// The images a channel shows: its own when it has them, else the post's.
const mediaOfOwn = (own: Own, base: Base) => (own.customMedia ? own.media : base.media);
// Keys sorted at every level: the server's jsonb gives nested objects (the UTM tags) back in its own key order.
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) => (v !== null && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))) : v));
const sameSettings = (a: Record<string, unknown> | null | undefined, b: Record<string, unknown> | null | undefined) => canonical(a ?? {}) === canonical(b ?? {});

// Instagram usernames typed as text (#796): separated by commas or spaces, an @ in front is dropped. The text is
// kept as typed while the field has focus, so a comma can be typed.
function PeopleField({ id, label, hint, names, onChange, disabled }: { id: string; label: string; hint: string; names: readonly string[]; onChange: (names: string[]) => void; disabled: boolean }) {
  const [text, setText] = useState<string | null>(null);
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      <Input
        id={id}
        value={text ?? names.map((n) => `@${n}`).join(' ')}
        disabled={disabled}
        onFocus={() => setText(names.map((n) => `@${n}`).join(' '))}
        onBlur={() => setText(null)}
        onChange={(e) => {
          setText(e.target.value);
          onChange([...new Set(e.target.value.split(/[\s,]+/).map((n) => n.replace(/^@+/, '').toLowerCase()).filter(Boolean))]);
        }}
      />
      <p className="text-xs text-subtle-foreground">{hint}</p>
    </div>
  );
}

// YouTube tags typed as text (#905), separated by commas; a tag may hold spaces. The text is kept as typed while the
// field has focus, so a comma can be typed, and the count is YouTube's own (commas, and quotes around a tag with a space).
function TagsField({ tags, onChange, disabled }: { tags: readonly string[]; onChange: (tags: string[]) => void; disabled: boolean }) {
  const t = useTranslations('social');
  const id = useId();
  const [text, setText] = useState<string | null>(null);
  const used = youtubeTagsLength(tags);
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={id} className="text-xs">
          {t('ytTags')}
        </Label>
        <span className={cn('font-mono text-xs tabular-nums', used > YOUTUBE_TAGS_MAX ? 'text-destructive' : 'text-subtle-foreground')}>
          {used}/{YOUTUBE_TAGS_MAX}
        </span>
      </div>
      <Input
        id={id}
        value={text ?? tags.join(', ')}
        disabled={disabled}
        onFocus={() => setText(tags.join(', '))}
        onBlur={() => setText(null)}
        onChange={(e) => {
          setText(e.target.value);
          onChange([...new Set(e.target.value.split(',').map((tag) => tag.trim().replace(/\s+/g, ' ')).filter(Boolean))]);
        }}
      />
      <p className="text-xs text-subtle-foreground">{t('ytTagsHint')}</p>
    </div>
  );
}

// The playlists a YouTube video goes into once it is out (#1018): the channel's own, pasted as a playlist link or id
// and kept as ids in settings.youtube.playlistIds, at most YOUTUBE_PLAYLISTS_MAX. A playlist that is gone by then
// leaves the video published, with a warning on the post.
function PlaylistsField({ ids, onChange, disabled }: { ids: readonly string[]; onChange: (ids: string[]) => void; disabled: boolean }) {
  const t = useTranslations('social');
  const id = useId();
  const [text, setText] = useState('');
  const [wrong, setWrong] = useState(false);
  const full = ids.length >= YOUTUBE_PLAYLISTS_MAX;
  const add = () => {
    const playlist = youtubePlaylistIdFrom(text);
    if (!playlist) {
      setWrong(true);
      return;
    }
    if (!ids.includes(playlist)) onChange([...ids, playlist]);
    setText('');
    setWrong(false);
  };
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={id} className="text-xs">
          {t('ytPlaylists')}
        </Label>
        <span className={cn('font-mono text-xs tabular-nums', ids.length > YOUTUBE_PLAYLISTS_MAX ? 'text-destructive' : 'text-subtle-foreground')}>
          {ids.length}/{YOUTUBE_PLAYLISTS_MAX}
        </span>
      </div>
      {ids.length > 0 && (
        <ul className="space-y-1">
          {ids.map((playlist) => (
            <li key={playlist} className="flex items-center justify-between gap-2 rounded-md border px-2 py-1">
              <a href={`https://www.youtube.com/playlist?list=${playlist}`} target="_blank" rel="noopener noreferrer" className="truncate font-mono text-xs text-link hover:underline">
                {playlist}
              </a>
              <Button variant="ghost" size="sm" disabled={disabled} onClick={() => onChange(ids.filter((x) => x !== playlist))}>
                {t('ytPlaylistRemove')}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        <Input
          id={id}
          value={text}
          placeholder={t('ytPlaylistPlaceholder')}
          disabled={disabled || full}
          aria-invalid={wrong || undefined}
          onChange={(e) => {
            setText(e.target.value);
            setWrong(false);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
        />
        <Button variant="outline" size="sm" disabled={disabled || full || text.trim() === ''} onClick={add}>
          {t('ytPlaylistAdd')}
        </Button>
      </div>
      {wrong && <p className="text-xs text-destructive">{t('ytPlaylistNotRecognized')}</p>}
      <p className="text-xs text-subtle-foreground">{t('ytPlaylistsHint')}</p>
    </div>
  );
}

// YouTube (#905): who can watch, whether the video is made for kids (YouTube requires the answer; absent is no, as for
// every video Crove posted before), its category from YouTube's fixed list, and its tags.
function YouTubeSettings({ settings, onChange, disabled }: { settings: Record<string, unknown>; onChange: (settings: Record<string, unknown>) => void; disabled: boolean }) {
  const t = useTranslations('social');
  const locale = useLocale();
  const id = useId();
  const without = (key: string) => {
    const { [key]: _gone, ...rest } = settings;
    return rest;
  };
  const category = typeof settings.categoryId === 'string' ? settings.categoryId : YOUTUBE_DEFAULT_CATEGORY;
  // A category set through the API outside the list still shows, so it can be changed.
  const known = (YOUTUBE_CATEGORIES as readonly string[]).includes(category);
  const collator = new Intl.Collator(locale);
  const categories = [...YOUTUBE_CATEGORIES].sort((a, b) => collator.compare(t(`ytCategoryOption.${a}`), t(`ytCategoryOption.${b}`)));
  const tags = Array.isArray(settings.tags) ? (settings.tags as unknown[]).filter((v): v is string => typeof v === 'string') : [];
  const listed = youtubePlaylistsOf(settings);
  const playlists = Array.isArray(listed) ? listed : [];
  return (
    <div className="space-y-2">
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-privacy`} className="text-xs">
          {t('ytPrivacy')}
        </Label>
        <NativeSelect id={`${id}-privacy`} size="sm" className="w-full max-w-xs" value={typeof settings.privacy === 'string' ? settings.privacy : 'public'} disabled={disabled} onChange={(e) => onChange({ ...settings, privacy: e.target.value })}>
          {(['public', 'unlisted', 'private'] as const).map((p) => (
            <NativeSelectOption key={p} value={p}>
              {t(`ytPrivacyOption.${p}`)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-kids`} className="text-xs">
          {t('ytAudience')}
        </Label>
        <NativeSelect id={`${id}-kids`} size="sm" className="w-full max-w-xs" value={settings.madeForKids === true ? 'yes' : 'no'} disabled={disabled} onChange={(e) => onChange({ ...settings, madeForKids: e.target.value === 'yes' })}>
          {(['no', 'yes'] as const).map((a) => (
            <NativeSelectOption key={a} value={a}>
              {t(`ytAudienceOption.${a}`)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <p className="text-xs text-subtle-foreground">{t('ytAudienceHint')}</p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-category`} className="text-xs">
          {t('ytCategory')}
        </Label>
        <NativeSelect id={`${id}-category`} size="sm" className="w-full max-w-xs" value={category} disabled={disabled} onChange={(e) => onChange({ ...settings, categoryId: e.target.value })}>
          {!known && <NativeSelectOption value={category}>{category}</NativeSelectOption>}
          {categories.map((c) => (
            <NativeSelectOption key={c} value={c}>
              {t(`ytCategoryOption.${c}`)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>
      <TagsField tags={tags} disabled={disabled} onChange={(next) => onChange(next.length > 0 ? { ...settings, tags: next } : without('tags'))} />
      <PlaylistsField ids={playlists} disabled={disabled} onChange={(next) => onChange(next.length > 0 ? { ...settings, youtube: { playlistIds: next } } : without('youtube'))} />
    </div>
  );
}

// WordPress category or tag names typed as text (#981), separated by commas; a name may hold spaces. The text is kept
// as typed while the field has focus, so a comma can be typed.
function NamesField({ label, hint, names, max, onChange, disabled }: { label: string; hint: string; names: readonly string[]; max: number; onChange: (names: string[]) => void; disabled: boolean }) {
  const id = useId();
  const [text, setText] = useState<string | null>(null);
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={id} className="text-xs">
          {label}
        </Label>
        <span className={cn('font-mono text-xs tabular-nums', names.length > max ? 'text-destructive' : 'text-subtle-foreground')}>
          {names.length}/{max}
        </span>
      </div>
      <Input
        id={id}
        value={text ?? names.join(', ')}
        disabled={disabled}
        onFocus={() => setText(names.join(', '))}
        onBlur={() => setText(null)}
        onChange={(e) => {
          setText(e.target.value);
          const seen = new Set<string>();
          onChange(
            e.target.value
              .split(',')
              .map((name) => name.trim().replace(/\s+/g, ' '))
              .filter((name) => name && !seen.has(name.toLowerCase()) && seen.add(name.toLowerCase())),
          );
        }}
      />
      <p className="text-xs text-subtle-foreground">{hint}</p>
    </div>
  );
}

// WordPress (#981): published at once, saved as a draft or sent for review; its categories (names the site has), tags
// and excerpt. Each is optional and is stored only when set, so a variant saved before keeps its content hash.
function WordPressSettings({ settings, onChange, disabled }: { settings: Record<string, unknown>; onChange: (settings: Record<string, unknown>) => void; disabled: boolean }) {
  const t = useTranslations('social');
  const id = useId();
  const { wordpress: raw, ...others } = settings;
  const w = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const names = (key: 'categories' | 'tags') => (Array.isArray(w[key]) ? (w[key] as unknown[]).filter((v): v is string => typeof v === 'string') : []);
  const set = (key: 'categories' | 'tags' | 'excerpt' | 'status', value: string | string[] | null) => {
    const { [key]: _gone, ...rest } = w;
    const next = value === null || value.length === 0 ? rest : { ...rest, [key]: value };
    onChange(Object.keys(next).length > 0 ? { ...others, wordpress: next } : others);
  };
  const status = typeof w.status === 'string' ? w.status : 'publish';
  const known = (WORDPRESS_STATUSES as readonly string[]).includes(status);
  const excerpt = typeof w.excerpt === 'string' ? w.excerpt : '';
  const excerptUsed = [...excerpt.trim()].length;
  return (
    <div className="space-y-2">
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-status`} className="text-xs">
          {t('wpStatus')}
        </Label>
        <NativeSelect id={`${id}-status`} size="sm" className="w-full max-w-xs" value={status} disabled={disabled} onChange={(e) => set('status', e.target.value === 'publish' ? null : e.target.value)}>
          {!known && <NativeSelectOption value={status}>{status}</NativeSelectOption>}
          {WORDPRESS_STATUSES.map((s) => (
            <NativeSelectOption key={s} value={s}>
              {t(`wpStatusOption.${s}`)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        {status !== 'publish' && <p className="text-xs text-subtle-foreground">{t('wpStatusHint')}</p>}
      </div>
      <NamesField label={t('wpCategories')} hint={t('wpCategoriesHint')} names={names('categories')} max={WORDPRESS_CATEGORIES_MAX} disabled={disabled} onChange={(v) => set('categories', v)} />
      <NamesField label={t('wpTags')} hint={t('wpTagsHint')} names={names('tags')} max={WORDPRESS_TAGS_MAX} disabled={disabled} onChange={(v) => set('tags', v)} />
      <div className="space-y-1">
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor={`${id}-excerpt`} className="text-xs">
            {t('wpExcerpt')}
          </Label>
          <span className={cn('font-mono text-xs tabular-nums', excerptUsed > WORDPRESS_EXCERPT_MAX ? 'text-destructive' : 'text-subtle-foreground')}>
            {excerptUsed}/{WORDPRESS_EXCERPT_MAX}
          </span>
        </div>
        <Textarea id={`${id}-excerpt`} rows={3} value={excerpt} disabled={disabled} onChange={(e) => set('excerpt', e.target.value === '' ? null : e.target.value)} />
        <p className="text-xs text-subtle-foreground">{t('wpExcerptHint')}</p>
      </div>
    </div>
  );
}

// Where an Instagram Reel shows (#1019): in the feed too (the default, not stored), on the Reels tab only, or as a trial
// Reel shown to non-followers first, which reaches followers by hand in the Instagram app (the default) or by Instagram
// when it does well. Offered on a Reel, and kept on another post while it holds a choice, so it can be set back.
function ReelFeedField({ settings, onChange, disabled }: { settings: Record<string, unknown>; onChange: (settings: Record<string, unknown>) => void; disabled: boolean }) {
  const t = useTranslations('social');
  const id = useId();
  const options = instagramReelOf(settings);
  const feed = options && options !== 'invalid' ? options.reelFeed : 'feed';
  const graduation = options && options !== 'invalid' ? (options.trialGraduation ?? 'manual') : 'manual';
  const { instagram: _old, ...rest } = settings;
  const set = (reelFeed: string, trialGraduation: string) =>
    onChange(reelFeed === 'feed' ? rest : { ...rest, instagram: reelFeed === 'trial' && trialGraduation !== 'manual' ? { reelFeed, trialGraduation } : { reelFeed } });
  return (
    <div className="space-y-1.5">
      <Label htmlFor={`${id}-feed`} className="text-xs">
        {t('igReelFeed')}
      </Label>
      <NativeSelect id={`${id}-feed`} size="sm" className="w-full max-w-xs" value={feed} disabled={disabled} onChange={(e) => set(e.target.value, graduation)}>
        {IG_REEL_FEEDS.map((v) => (
          <NativeSelectOption key={v} value={v}>
            {t(`igReelFeedOption.${v}`)}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      <p className="text-xs text-subtle-foreground">{t(`igReelFeedHint.${feed}`)}</p>
      {feed === 'trial' && (
        <>
          <Label htmlFor={`${id}-graduation`} className="text-xs">
            {t('igTrialGraduation')}
          </Label>
          <NativeSelect id={`${id}-graduation`} size="sm" className="w-full max-w-xs" value={graduation} disabled={disabled} onChange={(e) => set('trial', e.target.value)}>
            {IG_TRIAL_GRADUATIONS.map((v) => (
              <NativeSelectOption key={v} value={v}>
                {t(`igTrialGraduationOption.${v}`)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </>
      )}
    </div>
  );
}

// The settings a channel asks the person posting to choose (TikTok's posting rules), or that it offers (YouTube).
// inboxOffered: the channel's connection was granted video.upload, which Crove asks for only where the deployment turns
// TikTok's inbox mode on (CHANNEL_TIKTOK_INBOX, #903). pinAllowed: the Telegram bot may pin in the channel, as read at
// connect (#982). reel: the post goes out as an Instagram Reel (#1019).
function ProviderSettings({
  provider,
  settings,
  onChange,
  disabled,
  inboxOffered = false,
  pinAllowed = false,
  reel = false,
}: {
  provider: string;
  settings: Record<string, unknown>;
  onChange: (settings: Record<string, unknown>) => void;
  disabled: boolean;
  inboxOffered?: boolean;
  pinAllowed?: boolean;
  reel?: boolean;
}) {
  const t = useTranslations('social');
  // Telegram (#982): a silent post, and a pin to the top of the channel once it is out; link buttons under it (#1017).
  // Only what is on is stored, so a variant left as it was keeps its content hash.
  if (provider === 'telegram') {
    const options = telegramOptionsOf(settings);
    const current = options && options !== 'invalid' ? options : { silent: false, pin: false };
    const buttons = telegramButtonsOf(settings);
    const rows = Array.isArray(buttons) ? buttons : [];
    const save = (next: { silent: boolean; pin: boolean; rows: TelegramButton[][] }) => {
      const { telegram: _old, ...rest } = settings;
      const kept = { ...(next.silent ? { silent: true } : {}), ...(next.pin ? { pin: true } : {}), ...(next.rows.length > 0 ? { buttons: next.rows } : {}) };
      onChange(Object.keys(kept).length > 0 ? { ...rest, telegram: kept } : rest);
    };
    const set = (key: 'silent' | 'pin', on: boolean) => save({ ...current, [key]: on, rows });
    return (
      <div className="space-y-1.5">
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <Checkbox checked={current.silent} disabled={disabled} onCheckedChange={(on) => set('silent', on === true)} />
          {t('telegramSilent')}
        </label>
        {/* Greyed out where the bot may not pin; a pin already on can still be turned off. */}
        <label className={cn('flex items-center gap-2 text-sm text-muted-foreground', !pinAllowed && !current.pin && 'opacity-60')}>
          <Checkbox checked={current.pin} disabled={disabled || (!pinAllowed && !current.pin)} onCheckedChange={(on) => set('pin', on === true)} />
          {t('telegramPin')}
        </label>
        {!pinAllowed && <p className="text-xs text-subtle-foreground">{t('telegramPinHint')}</p>}
        <TelegramButtonsField rows={rows} disabled={disabled} onChange={(next) => save({ ...current, rows: next })} />
      </div>
    );
  }
  // Mastodon (#748): who sees the post, and an optional content warning shown before it.
  if (provider === 'mastodon') {
    const without = (key: string) => {
      const { [key]: _gone, ...rest } = settings;
      return rest;
    };
    return (
      <div className="space-y-1.5">
        <Label htmlFor="mastodon-visibility" className="text-xs">
          {t('mastodonVisibility')}
        </Label>
        <NativeSelect id="mastodon-visibility" size="sm" className="w-full max-w-xs" value={settings.visibility === 'unlisted' ? 'unlisted' : 'public'} disabled={disabled} onChange={(e) => onChange(e.target.value === 'public' ? without('visibility') : { ...settings, visibility: e.target.value })}>
          {(['public', 'unlisted'] as const).map((v) => (
            <NativeSelectOption key={v} value={v}>
              {t(`mastodonVisibilityOption.${v}`)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <Label htmlFor="mastodon-cw" className="text-xs">
          {t('mastodonContentWarning')}
        </Label>
        <Input id="mastodon-cw" value={typeof settings.contentWarning === 'string' ? settings.contentWarning : ''} disabled={disabled} onChange={(e) => onChange(e.target.value ? { ...settings, contentWarning: e.target.value } : without('contentWarning'))} />
        <p className="text-xs text-subtle-foreground">{t('mastodonContentWarningHint')}</p>
      </div>
    );
  }
  // X (#948) and Threads (#983): who may reply; everyone unless chosen. One field, each channel's own choices.
  const replyChoices = isProvider(provider) ? REPLY_SETTINGS[provider] : undefined;
  if (replyChoices) {
    const current = typeof settings.replySettings === 'string' ? settings.replySettings : 'everyone';
    const known = (replyChoices as readonly string[]).includes(current);
    return (
      <div className="space-y-1.5">
        <Label htmlFor={`${provider}-reply-settings`} className="text-xs">
          {t('replySettings')}
        </Label>
        <NativeSelect
          id={`${provider}-reply-settings`}
          size="sm"
          className="w-full max-w-xs"
          value={current}
          disabled={disabled}
          onChange={(e) => {
            const { replySettings: _gone, ...rest } = settings;
            onChange(e.target.value === 'everyone' ? rest : { ...rest, replySettings: e.target.value });
          }}
        >
          {!known && <NativeSelectOption value={current}>{current}</NativeSelectOption>}
          {replyChoices.map((v) => (
            <NativeSelectOption key={v} value={v}>
              {t(`replySettingsOption.${v}`)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>
    );
  }
  // LinkedIn (#983): who sees the post; anyone unless chosen.
  if (provider === 'linkedin') {
    const current = typeof settings.visibility === 'string' ? settings.visibility : 'public';
    const known = (LINKEDIN_VISIBILITY as readonly string[]).includes(current);
    return (
      <div className="space-y-1.5">
        <Label htmlFor="linkedin-visibility" className="text-xs">
          {t('linkedinVisibility')}
        </Label>
        <NativeSelect
          id="linkedin-visibility"
          size="sm"
          className="w-full max-w-xs"
          value={current}
          disabled={disabled}
          onChange={(e) => {
            const { visibility: _gone, ...rest } = settings;
            onChange(e.target.value === 'public' ? rest : { ...rest, visibility: e.target.value });
          }}
        >
          {!known && <NativeSelectOption value={current}>{current}</NativeSelectOption>}
          {LINKEDIN_VISIBILITY.map((v) => (
            <NativeSelectOption key={v} value={v}>
              {t(`linkedinVisibilityOption.${v}`)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>
    );
  }
  // Instagram (#796): collaborators on feed posts and Reels, people tagged on the first image; where a Reel shows (#1019).
  if (provider === 'instagram') {
    const names = (key: string) => (Array.isArray(settings[key]) ? (settings[key] as unknown[]).filter((v): v is string => typeof v === 'string') : []);
    const set = (key: string, value: string[]) => {
      const { [key]: _gone, ...rest } = settings;
      onChange(value.length > 0 ? { ...rest, [key]: value } : rest);
    };
    return (
      <div className="space-y-2">
        {(reel || settings.instagram !== undefined) && <ReelFeedField settings={settings} disabled={disabled} onChange={onChange} />}
        <PeopleField id="ig-collaborators" label={t('igCollaborators')} hint={t('igCollaboratorsHint')} names={names('collaborators')} disabled={disabled} onChange={(v) => set('collaborators', v)} />
        <PeopleField id="ig-user-tags" label={t('igUserTags')} hint={t('igUserTagsHint')} names={names('userTags')} disabled={disabled} onChange={(v) => set('userTags', v)} />
      </div>
    );
  }
  if (provider === 'youtube') return <YouTubeSettings settings={settings} onChange={onChange} disabled={disabled} />;
  if (provider === 'wordpress') return <WordPressSettings settings={settings} onChange={onChange} disabled={disabled} />;
  // Zalo OA (#943): whether the article takes comments. On is the default and is not stored, so a variant saved before
  // keeps its content hash.
  if (provider === 'zalo_oa') {
    const { comments: _comments, ...rest } = settings;
    return (
      <div className="space-y-1.5">
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <Checkbox checked={settings.comments !== false} disabled={disabled} onCheckedChange={(on) => onChange(on === true ? rest : { ...rest, comments: false })} />
          {t('zaloComments')}
        </label>
        <p className="text-xs text-subtle-foreground">{t('zaloCommentsHint')}</p>
      </div>
    );
  }
  if (provider !== 'tiktok') return null;
  const toggle = (key: 'allowComments' | 'allowDuet' | 'allowStitch') => (
    <label className="flex items-center gap-2 text-sm text-muted-foreground">
      <Checkbox checked={settings[key] === true} disabled={disabled} onCheckedChange={(on) => onChange({ ...settings, [key]: on === true })} />
      {t(`ttToggle.${key}`)}
    </label>
  );
  // Posted now, or sent to the TikTok app as a draft (#903). The draft takes no privacy level, interactions or cover
  // (the creator picks them in TikTok), so they are dropped on the switch; direct is the default and is not stored.
  const inbox = tiktokModeOf(settings) === 'inbox';
  // Offered where the connection can send drafts; a variant already in inbox mode keeps the choice, to switch back.
  const offered = inboxOffered || inbox;
  const setMode = (next: 'direct' | 'inbox') => {
    if (next === 'inbox') {
      const { privacyLevel: _privacy, allowComments: _comments, allowDuet: _duet, allowStitch: _stitch, autoAddMusic: _music, cover: _cover, ...rest } = settings;
      onChange({ ...rest, tiktokMode: 'inbox' });
    } else {
      const { tiktokMode: _mode, ...rest } = settings;
      onChange(rest);
    }
  };
  return (
    <div className="space-y-2 rounded-lg border p-3">
      {offered && (
        <div className="space-y-1.5">
          <Label htmlFor="tt-mode" className="text-xs">
            {t('ttMode')}
          </Label>
          <NativeSelect id="tt-mode" size="sm" className="w-full max-w-md" value={inbox ? 'inbox' : 'direct'} disabled={disabled} onChange={(e) => setMode(e.target.value === 'inbox' ? 'inbox' : 'direct')}>
            <NativeSelectOption value="direct">{t('ttModeOption.direct')}</NativeSelectOption>
            <NativeSelectOption value="inbox">{t('ttModeOption.inbox')}</NativeSelectOption>
          </NativeSelect>
        </div>
      )}
      {inbox ? (
        <p className="text-xs text-subtle-foreground">{t('ttInboxHint')}</p>
      ) : (
        <>
          <div className="space-y-1.5">
            <Label className="text-xs">{t('ttPrivacy')}</Label>
            <NativeSelect size="sm" className="w-full max-w-xs" value={typeof settings.privacyLevel === 'string' ? settings.privacyLevel : ''} disabled={disabled} onChange={(e) => onChange({ ...settings, privacyLevel: e.target.value })}>
              <NativeSelectOption value="">{t('ttPrivacyChoose')}</NativeSelectOption>
              {(['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY'] as const).map((p) => (
                <NativeSelectOption key={p} value={p}>
                  {t(`ttPrivacyOption.${p}`)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          {toggle('allowComments')}
          {toggle('allowDuet')}
          {toggle('allowStitch')}
          <p className="text-xs text-subtle-foreground">{t('ttConsent')}</p>
        </>
      )}
    </div>
  );
}

// The time of a video's frame, in seconds as typed; the cover keeps whole milliseconds.
function FrameInput({ atMs, maxMs, disabled, onChange }: { atMs: number; maxMs: number | null; disabled: boolean; onChange: (atMs: number) => void }) {
  const t = useTranslations('social');
  const id = useId();
  const [text, setText] = useState(String(atMs / 1000));
  // A value set elsewhere (a reload, another cover) shows; a half-typed one ("1.") is left as it is.
  useEffect(() => {
    if (text.trim() !== '' && Math.round(Number(text) * 1000) !== atMs) setText(String(atMs / 1000));
  }, [atMs, text]);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Label className="text-xs" htmlFor={id}>
        {t('coverAt')}
      </Label>
      <Input
        id={id}
        type="number"
        inputMode="decimal"
        min={0}
        step={0.1}
        {...(maxMs !== null ? { max: maxMs / 1000 } : {})}
        value={text}
        disabled={disabled}
        className="h-8 w-24 text-sm"
        onChange={(e) => {
          setText(e.target.value);
          const seconds = Number(e.target.value);
          if (e.target.value.trim() !== '' && Number.isFinite(seconds) && seconds >= 0) onChange(Math.round(seconds * 1000));
        }}
      />
      {maxMs !== null && <span className="text-xs text-subtle-foreground">{t('coverAtOf', { total: Math.floor(maxMs / 100) / 10 })}</span>}
    </div>
  );
}

// A video's cover (#642) on the channels whose adapter sends one: a moment in the video or an uploaded image. Shown
// while the channel posts one video, or while a cover is set (so a cover left over from a change of media can go).
function CoverField({ provider, media, settings, onChange, disabled }: { provider: string; media: readonly MediaItem[]; settings: Record<string, unknown>; onChange: (settings: Record<string, unknown>) => void; disabled: boolean }) {
  const t = useTranslations('social');
  const id = useId();
  const cover = coverOf(settings);
  // An image chosen as the kind, before a file is: nothing is stored until there is one.
  const [pickingImage, setPickingImage] = useState(false);
  // A draft sent to the TikTok app (#903) takes no cover: the creator picks it in TikTok.
  const kinds = isProvider(provider) && !(provider === 'tiktok' && tiktokModeOf(settings) === 'inbox') ? COVER_RULES[provider] : undefined;
  const video = media.length === 1 && media[0]?.mime.startsWith('video/') ? media[0] : null;
  if (!kinds || (!video && settings.cover === undefined)) return null;
  const set = (next: Cover | null) => {
    const { cover: _old, ...rest } = settings;
    onChange(next ? { ...rest, cover: next } : rest);
  };
  const mode: CoverKind | 'none' = cover ? coverKind(cover) : pickingImage ? 'image' : 'none';
  // A kind the channel does not take still shows when set (through the API), so it can be changed.
  const options: (CoverKind | 'none')[] = ['none', ...kinds, ...(cover && !kinds.includes(coverKind(cover)) ? [coverKind(cover)] : [])];
  const hint = provider === 'instagram' || provider === 'tiktok' || provider === 'youtube' ? provider : 'other';
  return (
    <div className="space-y-2 rounded-lg border p-3">
      <Label className="text-xs" htmlFor={id}>
        {t('cover')}
      </Label>
      <NativeSelect
        id={id}
        size="sm"
        className="w-full max-w-xs"
        value={mode}
        disabled={disabled}
        onChange={(e) => {
          const next = e.target.value as CoverKind | 'none';
          setPickingImage(next === 'image');
          set(next === 'frame' ? { atMs: 0 } : null);
        }}
      >
        {options.map((o) => (
          <NativeSelectOption key={o} value={o}>
            {t(`coverOption.${o}`)}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      {cover && 'atMs' in cover && <FrameInput atMs={cover.atMs} maxMs={video?.durationMs ?? null} disabled={disabled} onChange={(atMs) => set({ atMs })} />}
      {mode === 'image' && (
        <>
          <CoverImageField fileId={cover && 'fileId' in cover ? cover.fileId : null} disabled={disabled} onChange={(fileId) => set(fileId ? { fileId } : null)} />
          {!cover && <p className="text-xs text-subtle-foreground">{t('coverImageNone')}</p>}
        </>
      )}
      <p className="text-xs text-subtle-foreground">{t(`coverHint.${hint}`)}</p>
    </div>
  );
}

// Thread parts (#742): the post's text is part 1; each part added here goes out as a reply to the one before.
function ThreadField({ settings, disabled, onChange }: { settings: Record<string, unknown>; disabled: boolean; onChange: (settings: Record<string, unknown>) => void }) {
  const t = useTranslations('social');
  const parts = Array.isArray(settings.threadParts) ? settings.threadParts.map((p) => (typeof p === 'string' ? p : '')) : [];
  const set = (next: string[]) => {
    const { threadParts: _old, ...rest } = settings;
    onChange(next.length > 0 ? { ...rest, threadParts: next } : rest);
  };
  const move = (i: number, by: number) => {
    const next = [...parts];
    const [part] = next.splice(i, 1);
    next.splice(i + by, 0, part as string);
    set(next);
  };
  return (
    <div className="space-y-2">
      <Label className="text-xs">{t('threadParts')}</Label>
      {parts.map((part, i) => (
        <div key={i} className="space-y-1">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>{t('threadPart', { n: i + 2 })}</span>
            <Button variant="ghost" size="sm" disabled={disabled || i === 0} onClick={() => move(i, -1)}>
              {t('threadMoveUp')}
            </Button>
            <Button variant="ghost" size="sm" disabled={disabled || i === parts.length - 1} onClick={() => move(i, 1)}>
              {t('threadMoveDown')}
            </Button>
            <Button variant="ghost" size="sm" disabled={disabled} onClick={() => set(parts.filter((_, j) => j !== i))}>
              {t('threadRemove')}
            </Button>
          </div>
          <Textarea rows={2} disabled={disabled} value={part} aria-label={t('threadPart', { n: i + 2 })} onChange={(e) => set(parts.map((p, j) => (j === i ? e.target.value : p)))} />
        </div>
      ))}
      {parts.length < THREAD_PARTS_MAX && (
        <Button variant="outline" size="sm" disabled={disabled} onClick={() => set([...parts, ''])}>
          {t('threadAdd')}
        </Button>
      )}
      <p className="text-xs text-subtle-foreground">{t('threadHint', { max: THREAD_PARTS_MAX + 1 })}</p>
    </div>
  );
}

// Link buttons under a Telegram post (#1017): up to 3 rows of up to 3, each a label and an https link, as Telegram
// shows them under the message. A row left without a button goes; validation flags a label or link that will not do,
// and the field marks which one.
function TelegramButtonsField({ rows, disabled, onChange }: { rows: TelegramButton[][]; disabled: boolean; onChange: (rows: TelegramButton[][]) => void }) {
  const t = useTranslations('social');
  const id = useId();
  const blank: TelegramButton = { text: '', url: 'https://' };
  const edit = (r: number, i: number, change: Partial<TelegramButton>) => onChange(rows.map((row, j) => (j === r ? row.map((b, k) => (k === i ? { ...b, ...change } : b)) : row)));
  const remove = (r: number, i: number) => onChange(rows.map((row, j) => (j === r ? row.filter((_, k) => k !== i) : row)).filter((row) => row.length > 0));
  return (
    <div className="space-y-2 pt-1">
      <p className="text-xs font-medium">{t('telegramButtons')}</p>
      {rows.map((row, r) => (
        <div key={r} className="space-y-2 rounded-lg border p-2">
          <p className="text-xs text-muted-foreground">{t('telegramButtonRow', { n: r + 1 })}</p>
          {row.map((button, i) => (
            <div key={i} className="flex flex-wrap items-end gap-2">
              <div className="min-w-32 flex-1 space-y-1">
                <Label htmlFor={`${id}-${r}-${i}-text`} className="text-xs text-muted-foreground">
                  {t('telegramButtonText')}
                </Label>
                <Input
                  id={`${id}-${r}-${i}-text`}
                  value={button.text}
                  maxLength={TELEGRAM_BUTTON_TEXT_MAX * 2}
                  disabled={disabled}
                  aria-invalid={!button.text.trim() || countText(button.text.trim(), 'codepoints') > TELEGRAM_BUTTON_TEXT_MAX}
                  placeholder={t('telegramButtonTextPlaceholder')}
                  onChange={(e) => edit(r, i, { text: e.target.value })}
                />
              </div>
              <div className="min-w-48 flex-[2] space-y-1">
                <Label htmlFor={`${id}-${r}-${i}-url`} className="text-xs text-muted-foreground">
                  {t('telegramButtonUrl')}
                </Label>
                <Input id={`${id}-${r}-${i}-url`} type="url" inputMode="url" value={button.url} disabled={disabled} aria-invalid={!isButtonUrl(button.url)} placeholder="https://" onChange={(e) => edit(r, i, { url: e.target.value.trim() })} />
              </div>
              <Button variant="ghost" size="sm" disabled={disabled} onClick={() => remove(r, i)}>
                {t('telegramButtonRemove')}
              </Button>
            </div>
          ))}
          {row.length < TELEGRAM_BUTTONS_PER_ROW_MAX && (
            <Button variant="outline" size="sm" disabled={disabled} onClick={() => onChange(rows.map((x, j) => (j === r ? [...x, blank] : x)))}>
              {t('telegramButtonAdd')}
            </Button>
          )}
        </div>
      ))}
      {rows.length < TELEGRAM_BUTTON_ROWS_MAX && (
        <Button variant="outline" size="sm" disabled={disabled} onClick={() => onChange([...rows, [blank]])}>
          {rows.length === 0 ? t('telegramButtonFirst') : t('telegramButtonRowAdd')}
        </Button>
      )}
      <p className="text-xs text-subtle-foreground">{t('telegramButtonsHint', { rows: TELEGRAM_BUTTON_ROWS_MAX, perRow: TELEGRAM_BUTTONS_PER_ROW_MAX, max: TELEGRAM_BUTTON_TEXT_MAX })}</p>
    </div>
  );
}

// The repost when a post takes off (#773): at a like count, after some hours, or whichever comes first.
function RepostField({ settings, disabled, onChange }: { settings: Record<string, unknown>; disabled: boolean; onChange: (settings: Record<string, unknown>) => void }) {
  const t = useTranslations('social');
  const id = useId();
  const current = settings.repost && typeof settings.repost === 'object' ? (settings.repost as { likes?: unknown; afterHours?: unknown }) : null;
  const likes = typeof current?.likes === 'number' ? current.likes : null;
  const hours = typeof current?.afterHours === 'number' ? current.afterHours : null;
  const set = (next: { likes: number | null; afterHours: number | null }) => {
    const { repost: _old, ...rest } = settings;
    onChange(next.likes !== null || next.afterHours !== null ? { ...rest, repost: { ...(next.likes !== null ? { likes: next.likes } : {}), ...(next.afterHours !== null ? { afterHours: next.afterHours } : {}) } } : rest);
  };
  const num = (v: string) => (v === '' ? null : Math.floor(Number(v)));
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium">{t('repostRule')}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Label htmlFor={`${id}-likes`} className="text-xs text-muted-foreground">
          {t('repostRuleLikes')}
        </Label>
        <Input id={`${id}-likes`} type="number" min={1} max={AUTO_REPLY_LIKES_MAX} className="w-28" disabled={disabled} value={likes ?? ''} placeholder="100" onChange={(e) => set({ likes: num(e.target.value), afterHours: hours })} />
        <Label htmlFor={`${id}-hours`} className="text-xs text-muted-foreground">
          {t('repostRuleHours')}
        </Label>
        <Input id={`${id}-hours`} type="number" min={1} max={REPOST_HOURS_MAX} className="w-24" disabled={disabled} value={hours ?? ''} placeholder="24" onChange={(e) => set({ likes, afterHours: num(e.target.value) })} />
      </div>
      <p className="text-xs text-subtle-foreground">{t('repostRuleHint')}</p>
    </div>
  );
}

// The time the post comes down by itself (#861), on the channels Crove can take a post down from. onApplyAll: the same
// time for every channel of the post that can (absent with a single channel).
function RemoveAtField({ settings, disabled, onChange, onApplyAll }: { settings: Record<string, unknown>; disabled: boolean; onChange: (settings: Record<string, unknown>) => void; onApplyAll?: ((removeAt: string) => void) | undefined }) {
  const t = useTranslations('social');
  const id = useId();
  const current = settings.removeAt === undefined || settings.removeAt === null ? null : settings.removeAt;
  const parsed = removeAtOf(settings);
  const set = (next: string | null) => {
    const { removeAt: _old, ...rest } = settings;
    onChange(next ? { ...rest, removeAt: next } : rest);
  };
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <Label htmlFor={id} className="text-xs">
          {t('removeAt')}
        </Label>
        <Input id={id} type="datetime-local" className="h-8 w-auto" disabled={disabled} value={parsed !== null && parsed !== 'invalid' ? toLocalInput(parsed) : ''} onChange={(e) => set(fromLocalInput(e.target.value))} />
        {current !== null && (
          <Button variant="ghost" size="sm" disabled={disabled} onClick={() => set(null)}>
            {t('removeAtClear')}
          </Button>
        )}
        {onApplyAll && parsed !== null && parsed !== 'invalid' && (
          <Button variant="ghost" size="sm" disabled={disabled} onClick={() => onApplyAll(parsed)}>
            {t('removeAtApplyAll')}
          </Button>
        )}
      </div>
      <p className="text-xs text-subtle-foreground">{t('removeAtHint')}</p>
    </div>
  );
}

// The auto-reply on likes (#746): a text and the like count that sets it off; both or neither.
function AutoReplyField({ settings, disabled, onChange }: { settings: Record<string, unknown>; disabled: boolean; onChange: (settings: Record<string, unknown>) => void }) {
  const t = useTranslations('social');
  const id = useId();
  const current = settings.autoReply && typeof settings.autoReply === 'object' ? (settings.autoReply as { text?: unknown; likes?: unknown }) : null;
  const text = typeof current?.text === 'string' ? current.text : '';
  const likes = typeof current?.likes === 'number' ? current.likes : null;
  const set = (next: { text: string; likes: number | null }) => {
    const { autoReply: _old, ...rest } = settings;
    // An empty count is kept as null, which validation names, rather than shown as 0.
    onChange(next.text || next.likes !== null ? { ...rest, autoReply: { text: next.text, likes: next.likes } } : rest);
  };
  return (
    <div className="space-y-1">
      <Label htmlFor={`${id}-text`} className="text-xs">
        {t('autoReply')}
      </Label>
      <Textarea id={`${id}-text`} rows={2} disabled={disabled} value={text} placeholder={t('autoReplyPlaceholder')} onChange={(e) => set({ text: e.target.value, likes })} />
      <div className="flex flex-wrap items-center gap-2">
        <Label htmlFor={`${id}-likes`} className="text-xs text-muted-foreground">
          {t('autoReplyLikes')}
        </Label>
        <Input
          id={`${id}-likes`}
          type="number"
          min={1}
          max={AUTO_REPLY_LIKES_MAX}
          className="w-28"
          disabled={disabled}
          value={likes ?? ''}
          placeholder="100"
          onChange={(e) => set({ text, likes: e.target.value === '' ? null : Math.floor(Number(e.target.value)) })}
        />
      </div>
      <p className="text-xs text-subtle-foreground">{t('autoReplyHint')}</p>
    </div>
  );
}

function useRole(slug: string) {
  const me = useQuery(orpc.me.get.queryOptions());
  const role = me.data?.orgs.find((o) => o.slug === slug)?.role;
  return { userId: me.data?.userId ?? null, role, canDecide: role === 'owner' || role === 'admin', canWrite: role === 'owner' || role === 'admin' || role === 'member' };
}

function IssueList({ issues }: { issues: Issue[] }) {
  const t = useTranslations('social.issues');
  if (issues.length === 0) return null;
  const text = (issue: Issue) => {
    const limit = issue.limit ?? 0;
    const actual = issue.actual ?? 0;
    switch (issue.code) {
      case 'TEXT_TOO_LONG':
        return t('TEXT_TOO_LONG', { limit, actual });
      case 'TEXT_TOO_MANY_BYTES':
        return t('TEXT_TOO_MANY_BYTES', { limit, actual });
      case 'TITLE_TOO_LONG':
        return t('TITLE_TOO_LONG', { limit, actual });
      case 'MEDIA_REQUIRED':
        return t('MEDIA_REQUIRED', { limit });
      case 'TOO_MANY_MEDIA':
        return t('TOO_MANY_MEDIA', { limit });
      case 'TOO_MANY_LINKS':
        return t('TOO_MANY_LINKS', { limit, actual });
      case 'YT_TAGS_TOO_LONG':
        return t('YT_TAGS_TOO_LONG', { limit, actual });
      case 'YT_PLAYLISTS_TOO_MANY':
        return t('YT_PLAYLISTS_TOO_MANY', { limit, actual });
      case 'CONTENT_WARNING_TOO_LONG':
        return t('CONTENT_WARNING_TOO_LONG', { limit, actual });
      case 'IG_COLLABORATORS_INVALID':
        return t('IG_COLLABORATORS_INVALID', { limit });
      case 'IG_USER_TAGS_INVALID':
        return t('IG_USER_TAGS_INVALID', { limit });
      case 'COMMENT_TOO_LONG':
        return t('COMMENT_TOO_LONG', { limit, actual });
      case 'THREAD_TOO_MANY_PARTS':
        return t('THREAD_TOO_MANY_PARTS', { limit });
      // Which part: threadParts.<index> on the issue; the post's own text is part 1.
      case 'THREAD_PART_EMPTY':
        return t('THREAD_PART_EMPTY', { n: Number(issue.field.split('.')[2] ?? 0) + 2 });
      case 'THREAD_PART_TOO_LONG':
        return t('THREAD_PART_TOO_LONG', { n: Number(issue.field.split('.')[2] ?? 0) + 2, limit, actual });
      case 'REPOST_INVALID':
        return t('REPOST_INVALID', { limit });
      case 'AUTO_REPLY_INVALID':
        return t('AUTO_REPLY_INVALID', { limit });
      case 'AUTO_REPLY_TOO_LONG':
        return t('AUTO_REPLY_TOO_LONG', { limit, actual });
      case 'POLL_OPTIONS':
        return t('POLL_OPTIONS', { limit });
      case 'POLL_OPTION_LENGTH':
        return t('POLL_OPTION_LENGTH', { limit });
      case 'GBP_INVALID':
        return t('GBP_INVALID', { limit: limit || 58 });
      case 'TOPIC_TAG_INVALID':
        return t('TOPIC_TAG_INVALID', { limit });
      case 'WORDPRESS_TOO_MANY_CATEGORIES':
        return t('WORDPRESS_TOO_MANY_CATEGORIES', { limit, actual });
      case 'WORDPRESS_TOO_MANY_TAGS':
        return t('WORDPRESS_TOO_MANY_TAGS', { limit, actual });
      case 'WORDPRESS_TERM_INVALID':
        return t('WORDPRESS_TERM_INVALID', { limit });
      case 'WORDPRESS_EXCERPT_TOO_LONG':
        return t('WORDPRESS_EXCERPT_TOO_LONG', { limit, actual });
      // Telegram link buttons (#1017); the editor marks which button's label or link it is.
      case 'TELEGRAM_TOO_MANY_BUTTONS':
        return t('TELEGRAM_TOO_MANY_BUTTONS', { limit });
      case 'TELEGRAM_BUTTONS_ON_ALBUM':
        return t('TELEGRAM_BUTTONS_ON_ALBUM', { actual });
      case 'TELEGRAM_BUTTON_TEXT_LENGTH':
        return t('TELEGRAM_BUTTON_TEXT_LENGTH', { limit });
      // Which image: media.<index> on the issue, counted from 1 for the person.
      case 'IMAGE_RATIO_NOT_ALLOWED':
        return t('IMAGE_RATIO_NOT_ALLOWED', { n: Number(issue.field.split('.')[1] ?? 0) + 1 });
      case 'IMAGE_TOO_SMALL':
        return t('IMAGE_TOO_SMALL', { n: Number(issue.field.split('.')[1] ?? 0) + 1, limit, actual });
      // In milliseconds on the issue, in seconds for the person.
      case 'COVER_OUT_OF_RANGE':
        return t('COVER_OUT_OF_RANGE', { limit: limit / 1000, actual: actual / 1000 });
      default:
        return t(issue.code);
    }
  };
  return (
    <ul className="space-y-1 text-xs text-destructive">
      {issues.map((issue) => (
        <li key={`${issue.code}:${issue.field}`}>{text(issue)}</li>
      ))}
    </ul>
  );
}

function Counter({ provider, body, linkUrl, mediaCount }: { provider: string; body: string; linkUrl: string; mediaCount: number }) {
  const { used, max } = textBudget(provider, body, { linkUrl, mediaCount });
  if (max === null) return null;
  const over = used > max;
  return <span className={cn('font-mono text-xs tabular-nums', over ? 'text-destructive' : used > max * 0.9 ? 'text-warning' : 'text-subtle-foreground')}>{used}/{max}</span>;
}

type UtmTags = { campaign: string; medium: string };
type ApiSettings = NonNullable<Parameters<typeof client.social.variants.update>[0]['settings']>;

// The channel's settings with the post's UTM tags, or without any (#585). A utm_content the channel already has (set
// through the API) is kept.
function withUtm(own: Own, utm: UtmTags | null): Own {
  const { utm: old, ...rest } = own.settings;
  const content = old && typeof old === 'object' && typeof (old as { content?: unknown }).content === 'string' ? { content: (old as { content: string }).content } : {};
  return { ...own, settings: utm && utm.campaign.trim() ? { ...rest, utm: { campaign: utm.campaign.trim(), medium: utm.medium.trim() || 'social', ...content } } : rest };
}

// UTM tags for the post's link (#585): one campaign for every channel, each channel its own utm_source.
function UtmFields({ utm, onChange, disabled }: { utm: UtmTags | null; onChange: (utm: UtmTags | null) => void; disabled: boolean }) {
  const t = useTranslations('social');
  return (
    <div className="space-y-2">
      <label className="flex items-center gap-2 text-sm text-muted-foreground">
        <Checkbox checked={utm !== null} disabled={disabled} onCheckedChange={(checked) => onChange(checked === true ? { campaign: '', medium: 'social' } : null)} />
        {t('utmOn')}
      </label>
      {utm && (
        <div className="grid gap-2 sm:grid-cols-2">
          <Input value={utm.campaign} disabled={disabled} maxLength={100} aria-label={t('utmCampaign')} placeholder={t('utmCampaign')} onChange={(e) => onChange({ ...utm, campaign: e.target.value })} />
          <Input value={utm.medium} disabled={disabled} maxLength={100} aria-label={t('utmMedium')} placeholder="social" onChange={(e) => onChange({ ...utm, medium: e.target.value })} />
          {!utm.campaign.trim() && <p className="text-xs text-warning sm:col-span-2">{t('utmNeedsCampaign')}</p>}
          <p className="text-xs text-subtle-foreground sm:col-span-2">{t('utmHint')}</p>
        </div>
      )}
    </div>
  );
}

const REWRITES = ['shorten', 'formal', 'casual', 'translate_en', 'translate_vi'] as const;

// An AI rewrite of a text (#583): a proposal shown next to the text, which the member takes or leaves. Taking it marks
// the post as AI-assisted.
function AiRewrite({ text, title, connectionId, onAccept }: { text: string; title: string | null; connectionId?: string; onAccept: (next: { text: string; title: string | null }) => void }) {
  const t = useTranslations('social');
  const [action, setAction] = useState<(typeof REWRITES)[number]>('shorten');
  // The text the proposal was made from: typed on since, it no longer fits and is not offered.
  const [asked, setAsked] = useState<string | null>(null);
  const rewrite = useMutation({
    mutationFn: () => {
      setAsked(text);
      return client.social.posts.rewriteWithAi({ text, title, action, ...(connectionId ? { connectionId } : {}) });
    },
  });
  const outdated = rewrite.data !== undefined && asked !== text;
  if (getConfig().aiEnabled !== true || !text.trim()) return null;
  return (
    <div className="space-y-2 rounded-lg border border-dashed p-2">
      <div className="flex flex-wrap items-center gap-2">
        <NativeSelect size="sm" value={action} aria-label={t('aiRewrite')} onChange={(e) => setAction(e.target.value as (typeof REWRITES)[number])}>
          {REWRITES.map((a) => (
            <NativeSelectOption key={a} value={a}>
              {t(`aiRewrites.${a}`)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <Button variant="outline" size="sm" disabled={rewrite.isPending} onClick={() => rewrite.mutate()}>
          {rewrite.isPending ? <Spinner className="text-current" /> : null}
          {t('aiRewrite')}
        </Button>
      </div>
      {rewrite.error && <ErrorText>{errorMessage(rewrite.error)}</ErrorText>}
      {rewrite.data && (
        <div className="space-y-2">
          {rewrite.data.title && <p className="text-sm font-medium text-foreground">{rewrite.data.title}</p>}
          <p className="text-sm whitespace-pre-wrap [overflow-wrap:anywhere] text-foreground">{rewrite.data.text}</p>
          <p className="text-xs text-subtle-foreground">{t(outdated ? 'aiRewriteOutdated' : 'aiRewriteHint')}</p>
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={outdated}
              onClick={() => {
                onAccept(rewrite.data);
                rewrite.reset();
              }}
            >
              {t('aiRewriteUse')}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => rewrite.reset()}>
              {t('aiRewriteDrop')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// A channel's post type (#644): a feed post, a Story or a Reel, where the channel posts them. A feed post keeps no
// setting, so a post saved before this keeps its hash.
function PostTypeField({ provider, settings, onChange, disabled }: { provider: string; settings: Record<string, unknown>; onChange: (settings: Record<string, unknown>) => void; disabled: boolean }) {
  const t = useTranslations('social.postType');
  const types = isProvider(provider) ? POST_TYPE_RULES[provider] : undefined;
  if (!types) return null;
  const current = postTypeOf(settings) ?? 'feed';
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <Label htmlFor={`post-type-${provider}`} className="text-xs">
          {t('label')}
        </Label>
        <NativeSelect
          id={`post-type-${provider}`}
          size="sm"
          className="w-auto"
          value={current}
          disabled={disabled}
          onChange={(e) => {
            const { postType: _old, ...rest } = settings;
            // A Story takes no first comment, thread or cover, and their fields are hidden for it: dropped with the change.
            if (e.target.value === 'story') {
              delete rest.firstComment;
              delete rest.threadParts;
              delete rest.autoReply;
              delete rest.repost;
              delete rest.removeAt;
              delete rest.cover;
              delete rest.instagram;
            }
            onChange(e.target.value === 'feed' ? rest : { ...rest, postType: e.target.value });
          }}
        >
          {types.map((type) => (
            <NativeSelectOption key={type} value={type}>
              {t(`types.${type}`)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>
      {current !== 'feed' && <p className="text-xs text-subtle-foreground">{t(`hints.${current}`)}</p>}
    </div>
  );
}

// The lengths offered for a poll that takes one (X, #948), in minutes: from 5 minutes to 7 days.
const POLL_LENGTHS: readonly number[] = [5, 15, 30, 60, 360, 720, 1440, 2880, 4320, 10_080];

// Threads and X polls and Threads topic tags (#711, #948): a poll of 2 to 4 short options on a post without media (with
// its length on X), and one topic tag. The options are kept as typed; the server trims them.
function PollAndTagField({ provider, settings, onChange, disabled }: { provider: string; settings: Record<string, unknown>; onChange: (settings: Record<string, unknown>) => void; disabled: boolean }) {
  const t = useTranslations('social.threadsExtras');
  if (!isProvider(provider)) return null;
  const pollRule = POLL_RULES[provider];
  const tagRule = TOPIC_TAG_RULES[provider];
  if (!pollRule && !tagRule) return null;
  const rawPoll = settings.poll && typeof settings.poll === 'object' && !Array.isArray(settings.poll) ? (settings.poll as Record<string, unknown>) : null;
  const rawOptions = rawPoll?.options;
  const options = Array.isArray(rawOptions) ? rawOptions.map((o) => (typeof o === 'string' ? o : '')) : null;
  const without = (key: string) => {
    const { [key]: _gone, ...rest } = settings;
    return rest;
  };
  // The poll's length stays when its options change (X, #948).
  const setOptions = (next: string[] | null) => onChange(next ? { ...settings, poll: { ...rawPoll, options: next } } : without('poll'));
  const duration = pollRule?.duration;
  const minutes = duration ? (pollDurationOf(settings) ?? duration.default) : null;
  const setMinutes = (value: number) => {
    const { durationMinutes: _gone, ...rest } = rawPoll ?? {};
    onChange({ ...settings, poll: duration && value === duration.default ? rest : { ...rest, durationMinutes: value } });
  };
  const lengths = duration ? POLL_LENGTHS.filter((m) => m >= duration.min && m <= duration.max) : [];
  const lengthLabel = (m: number) => (m % 1440 === 0 ? t('pollLengthDays', { n: m / 1440 }) : m % 60 === 0 ? t('pollLengthHours', { n: m / 60 }) : t('pollLengthMinutes', { n: m }));
  const tag = typeof settings.topicTag === 'string' ? settings.topicTag : '';
  return (
    <div className="space-y-2">
      {pollRule && (
        <div className="space-y-1.5">
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <Checkbox checked={options !== null} disabled={disabled} onCheckedChange={(checked) => setOptions(checked === true ? ['', ''] : null)} />
            {t('poll')}
          </label>
          {options && (
            <div className="space-y-1.5 pl-6">
              {options.map((option, i) => (
                <div key={i} className="flex items-center gap-1.5">
                  <Input
                    value={option}
                    disabled={disabled}
                    maxLength={pollRule.maxChars + 10}
                    aria-label={t('option', { n: String(i + 1) })}
                    placeholder={t('option', { n: String(i + 1) })}
                    className="h-8 max-w-xs"
                    onChange={(e) => setOptions(options.map((o, j) => (j === i ? e.target.value : o)))}
                  />
                  {options.length > pollRule.minOptions && (
                    <Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={() => setOptions(options.filter((_, j) => j !== i))}>
                      {t('remove')}
                    </Button>
                  )}
                </div>
              ))}
              {options.length < pollRule.maxOptions && (
                <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => setOptions([...options, ''])}>
                  {t('addOption')}
                </Button>
              )}
              {duration && minutes !== null && (
                <div className="flex flex-wrap items-center gap-2">
                  <Label htmlFor={`poll-length-${provider}`} className="text-xs">
                    {t('pollLength')}
                  </Label>
                  <NativeSelect id={`poll-length-${provider}`} size="sm" className="w-40" value={String(minutes)} disabled={disabled} onChange={(e) => setMinutes(Number(e.target.value))}>
                    {minutes === 'invalid' || !lengths.includes(minutes) ? <NativeSelectOption value={String(minutes)}>{minutes === 'invalid' ? '?' : lengthLabel(minutes)}</NativeSelectOption> : null}
                    {lengths.map((m) => (
                      <NativeSelectOption key={m} value={String(m)}>
                        {lengthLabel(m)}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </div>
              )}
              <p className="text-xs text-subtle-foreground">{t('pollHint', { max: String(pollRule.maxChars) })}</p>
            </div>
          )}
        </div>
      )}
      {tagRule && (
        <div className="flex flex-wrap items-center gap-2">
          <Label htmlFor={`topic-tag-${provider}`} className="text-xs">
            {t('topicTag')}
          </Label>
          <Input
            id={`topic-tag-${provider}`}
            value={tag}
            disabled={disabled}
            maxLength={tagRule.maxChars + 1}
            placeholder={t('topicTagPlaceholder')}
            className="h-8 max-w-56"
            onChange={(e) => onChange(e.target.value ? { ...settings, topicTag: e.target.value } : without('topicTag'))}
          />
        </div>
      )}
    </div>
  );
}

// Google Business Profile posts (#709): a standard post, an event or an offer, with an optional call to action whose
// URL is the post's link (CALL dials the profile's number). Events and offers have dates; an offer has a coupon code
// and terms. Kept as typed; the checks say what Google would refuse.
function GbpField({ provider, settings, onChange, disabled }: { provider: string; settings: Record<string, unknown>; onChange: (settings: Record<string, unknown>) => void; disabled: boolean }) {
  const t = useTranslations('social.gbp');
  const uid = useId();
  const g = provider === 'google_business' ? gbpOf(settings) : null;
  if (!g) return null;
  const set = (next: typeof g) =>
    onChange({
      ...settings,
      gbp: {
        topic: next.topic,
        ...(next.language !== 'vi' ? { language: next.language } : {}),
        ...(next.cta ? { cta: next.cta } : {}),
        ...(next.topic !== 'STANDARD' ? { event: next.event } : {}),
        ...(next.topic === 'OFFER' ? { offer: next.offer } : {}),
      },
    });
  const id = (name: string) => `${uid}-gbp-${name}`;
  return (
    <div className="space-y-2 rounded-lg border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Label htmlFor={id('topic')} className="text-xs">
          {t('topic')}
        </Label>
        <NativeSelect id={id('topic')} size="sm" className="w-auto" value={g.topic} disabled={disabled} onChange={(e) => set({ ...g, topic: e.target.value as typeof g.topic })}>
          {GBP_TOPICS.map((x) => (
            <NativeSelectOption key={x} value={x}>
              {t(`topics.${x}`)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <Label htmlFor={id('cta')} className="text-xs">
          {t('cta')}
        </Label>
        <NativeSelect id={id('cta')} size="sm" className="w-auto" value={g.cta ?? ''} disabled={disabled} onChange={(e) => set({ ...g, cta: (e.target.value || null) as typeof g.cta })}>
          <NativeSelectOption value="">{t('noCta')}</NativeSelectOption>
          {GBP_CTAS.map((x) => (
            <NativeSelectOption key={x} value={x}>
              {t(`ctas.${x}`)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <Label htmlFor={id('language')} className="text-xs">
          {t('language')}
        </Label>
        <NativeSelect id={id('language')} size="sm" className="w-auto" value={g.language} disabled={disabled} onChange={(e) => set({ ...g, language: e.target.value as typeof g.language })}>
          {GBP_LANGUAGES.map((x) => (
            <NativeSelectOption key={x} value={x}>
              {t(`languages.${x}`)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>
      {g.topic !== 'STANDARD' && (
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor={id('title')} className="text-xs">
              {t(g.topic === 'EVENT' ? 'eventTitle' : 'offerTitle')}
            </Label>
            <Input id={id('title')} value={g.event.title} maxLength={58} disabled={disabled} className="h-8" onChange={(e) => set({ ...g, event: { ...g.event, title: e.target.value } })} />
          </div>
          <div className="space-y-1">
            <Label htmlFor={id('start')} className="text-xs">
              {t('starts')}
            </Label>
            <div className="flex gap-1.5">
              <Input id={id('start')} type="date" value={g.event.startDate} disabled={disabled} className="h-8" onChange={(e) => set({ ...g, event: { ...g.event, startDate: e.target.value } })} />
              <Input type="time" aria-label={t('startTime')} value={g.event.startTime} disabled={disabled} className="h-8 w-28" onChange={(e) => set({ ...g, event: { ...g.event, startTime: e.target.value } })} />
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor={id('end')} className="text-xs">
              {t('ends')}
            </Label>
            <div className="flex gap-1.5">
              <Input id={id('end')} type="date" value={g.event.endDate} disabled={disabled} className="h-8" onChange={(e) => set({ ...g, event: { ...g.event, endDate: e.target.value } })} />
              <Input type="time" aria-label={t('endTime')} value={g.event.endTime} disabled={disabled} className="h-8 w-28" onChange={(e) => set({ ...g, event: { ...g.event, endTime: e.target.value } })} />
            </div>
          </div>
        </div>
      )}
      {g.topic === 'OFFER' && (
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor={id('coupon')} className="text-xs">
              {t('coupon')}
            </Label>
            <Input id={id('coupon')} value={g.offer.couponCode} maxLength={58} disabled={disabled} className="h-8" onChange={(e) => set({ ...g, offer: { ...g.offer, couponCode: e.target.value } })} />
          </div>
          <div className="space-y-1">
            <Label htmlFor={id('terms')} className="text-xs">
              {t('terms')}
            </Label>
            <Input id={id('terms')} value={g.offer.terms} maxLength={5000} disabled={disabled} className="h-8" onChange={(e) => set({ ...g, offer: { ...g.offer, terms: e.target.value } })} />
          </div>
        </div>
      )}
      <p className="text-xs text-subtle-foreground">{t('hint')}</p>
    </div>
  );
}

function ChannelEditor({
  provider,
  channel,
  base,
  own,
  onChange,
  disabled,
  status,
  statusError,
  footer,
  connectionId,
  scopes,
  onAiUsed,
  slug,
  onRemoveAtAll,
}: {
  provider: string;
  channel: string;
  base: Base;
  own: Own;
  onChange: (own: Own) => void;
  disabled: boolean;
  status?: VariantStatus;
  // The variant's error or note (#903: SENT_TO_APP on a draft sent to the TikTok app), for its status label.
  statusError?: { code: string | null } | null;
  footer?: ReactNode;
  connectionId?: string;
  // What the platform granted the channel's connection (#903: video.upload offers TikTok's inbox mode).
  scopes?: readonly string[];
  onAiUsed?: () => void;
  slug?: string;
  // The same takedown time for every channel of the post that can take one (#861).
  onRemoveAtAll?: ((removeAt: string) => void) | undefined;
}) {
  const t = useTranslations('social');
  // The link as the channel sends it, with its UTM tags (#585).
  const linkUrl = (isProvider(provider) ? sentLink(provider, base.linkUrl || null, own.settings, own.custom ? own.body : base.body) : base.linkUrl) ?? '';
  const postType = postTypeOf(own.settings) ?? 'feed';
  const poll = pollOptionsOf(own.settings);
  const pollRule = isProvider(provider) ? POLL_RULES[provider] : undefined;
  const pollMinutes = pollDurationOf(own.settings);
  const replySettings = replySettingOf(provider, own.settings);
  const linkedinVisibility = provider === 'linkedin' && (own.settings.visibility === 'connections' || own.settings.visibility === 'loggedIn') ? (own.settings.visibility as 'connections' | 'loggedIn') : null;
  const tag = topicTagOf(own.settings);
  const telegramButtons = provider === 'telegram' ? telegramButtonsOf(own.settings) : null;
  const content = {
    body: own.custom ? own.body : base.body,
    title: own.custom ? own.title : base.title,
    linkUrl,
    media: mediaOfOwn(own, base),
    cover: coverOf(own.settings),
    postType,
    ...(Array.isArray(poll) ? { poll } : {}),
    ...(Array.isArray(poll) && pollRule?.duration ? { pollMinutes: typeof pollMinutes === 'number' ? pollMinutes : pollRule.duration.default } : {}),
    ...(typeof tag === 'string' && tag ? { topicTag: tag } : {}),
    ...(replySettings ? { replySettings } : {}),
    ...(linkedinVisibility ? { visibility: linkedinVisibility } : {}),
    ...(Array.isArray(telegramButtons) ? { buttons: telegramButtons } : {}),
  };
  const issues = draftIssues(provider, { body: content.body, title: hasTitle(provider) ? content.title : null, linkUrl: content.linkUrl, media: content.media, settings: own.settings });
  // The channel's own texts against its banned words (#1055); the shared text is marked under the shared fields.
  const allWords = useBannedWords();
  const banned = connectionId ? wordsForChannel(allWords, connectionId) : allWords;
  const ownTexts = variantTexts({ body: own.custom ? content.body : '', title: own.custom && hasTitle(provider) ? content.title || null : null }, own.settings).filter((x) => x.text !== '');
  return (
    <Card className="block space-y-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Badge variant="outline">{providerName(provider)}</Badge>
          <span className="truncate text-sm font-medium text-foreground">{channel}</span>
          {status && <Badge variant={variantTone({ status, error: statusError ?? null })}>{t(`status.${variantStatusKey({ status, error: statusError ?? null })}`)}</Badge>}
        </div>
        <Counter provider={provider} body={content.body} linkUrl={content.linkUrl} mediaCount={content.media.length} />
      </div>
      <PostTypeField provider={provider} settings={own.settings} disabled={disabled} onChange={(settings) => onChange({ ...own, settings })} />
      <PollAndTagField provider={provider} settings={own.settings} disabled={disabled} onChange={(settings) => onChange({ ...own, settings })} />
      <GbpField provider={provider} settings={own.settings} disabled={disabled} onChange={(settings) => onChange({ ...own, settings })} />
      <label className="flex items-center gap-2 text-sm text-muted-foreground">
        <Checkbox checked={own.custom} disabled={disabled} onCheckedChange={(checked) => onChange({ ...own, custom: checked === true, body: own.body || base.body })} />
        {t('ownText')}
      </label>
      {own.custom && (
        <div className="space-y-2">
          {hasTitle(provider) && <Input value={own.title} disabled={disabled} aria-label={t('titleField')} placeholder={base.title || t('titlePlaceholder')} onChange={(e) => onChange({ ...own, title: e.target.value })} />}
          <Textarea id={`social-own-${connectionId ?? provider}`} value={own.body} disabled={disabled} rows={5} aria-label={t('ownTextPlaceholder')} placeholder={t('ownTextPlaceholder')} onChange={(e) => onChange({ ...own, body: e.target.value })} />
          <div className="flex flex-wrap items-center gap-2">
            <EmojiPicker targetId={`social-own-${connectionId ?? provider}`} value={own.body} disabled={disabled} onChange={(body) => onChange({ ...own, body })} />
            {slug && <SnippetPicker slug={slug} targetId={`social-own-${connectionId ?? provider}`} value={own.body} provider={provider} disabled={disabled} onChange={(body) => onChange({ ...own, body })} />}
          </div>
          {!disabled && onAiUsed && (
            <AiRewrite
              text={own.body}
              title={hasTitle(provider) ? own.title || null : null}
              {...(connectionId ? { connectionId } : {})}
              onAccept={(next) => {
                onChange({ ...own, body: next.text, title: next.title ?? own.title });
                onAiUsed();
              }}
            />
          )}
        </div>
      )}
      <label className="flex items-center gap-2 text-sm text-muted-foreground">
        <Checkbox checked={own.customMedia} disabled={disabled} onCheckedChange={(checked) => onChange({ ...own, customMedia: checked === true, media: own.media.length > 0 ? own.media : base.media })} />
        {t('ownMedia')}
      </label>
      {own.customMedia && <MediaField media={own.media} disabled={disabled} onChange={(media) => onChange({ ...own, media })} />}
      {own.customMedia && own.media.length === 0 && <p className="text-xs text-subtle-foreground">{t('ownMediaEmpty')}</p>}
      {isProvider(provider) && REPOST_PROVIDERS.has(provider) && postType !== 'story' && <RepostField settings={own.settings} disabled={disabled} onChange={(settings) => onChange({ ...own, settings })} />}
      {/* A channel Crove cannot take a post down from shows the field only to clear a time set elsewhere (its issue says why). */}
      {((isProvider(provider) && REMOVE_READY.has(provider) && postType !== 'story') || own.settings.removeAt !== undefined) && (
        <RemoveAtField settings={own.settings} disabled={disabled} onApplyAll={onRemoveAtAll} onChange={(settings) => onChange({ ...own, settings })} />
      )}
      {isProvider(provider) && AUTO_REPLY_RULES[provider] && postType !== 'story' && <AutoReplyField settings={own.settings} disabled={disabled} onChange={(settings) => onChange({ ...own, settings })} />}
      {isProvider(provider) && THREAD_RULES[provider] && postType !== 'story' && <ThreadField settings={own.settings} disabled={disabled} onChange={(settings) => onChange({ ...own, settings })} />}
      {isProvider(provider) && COMMENT_RULES[provider] && postType !== 'story' && (!threadPartsOf(own.settings) || typeof own.settings.firstComment === 'string') && (
        <div className="space-y-1">
          <Label className="text-xs">{t('firstComment')}</Label>
          <Textarea
            rows={2}
            disabled={disabled}
            value={typeof own.settings.firstComment === 'string' ? own.settings.firstComment : ''}
            placeholder={t('firstCommentPlaceholder')}
            onChange={(e) => {
              const { firstComment: _old, ...rest } = own.settings;
              onChange({ ...own, settings: e.target.value ? { ...rest, firstComment: e.target.value } : rest });
            }}
          />
        </div>
      )}
      <ProviderSettings
        provider={provider}
        settings={own.settings}
        disabled={disabled}
        inboxOffered={scopes?.includes('video.upload') ?? false}
        pinAllowed={scopes?.includes(TELEGRAM_PIN_SCOPE) ?? false}
        reel={provider === 'instagram' && isInstagramReel(content.media.map((m) => ({ kind: m.mime.startsWith('video/') ? ('video' as const) : ('image' as const) })), own.settings)}
        onChange={(settings) => onChange({ ...own, settings })}
      />
      <CoverField provider={provider} media={content.media} settings={own.settings} disabled={disabled} onChange={(settings) => onChange({ ...own, settings })} />
      <IssueList issues={issues} />
      {!disabled && <BannedWordHints texts={ownTexts} words={banned} />}
      <PlatformPreview channel={channel} provider={provider} content={content} readLink />
      {footer}
    </Card>
  );
}

// A hashtag appended to the text, on its own line when the text ends with other words.
const withHashtag = (text: string, tag: string) => {
  const trimmed = text.replace(/\s+$/, '');
  if (!trimmed) return `#${tag}`;
  return /(^|\s)#[^\s#]+$/u.test(trimmed) ? `${trimmed} #${tag}` : `${trimmed}\n\n#${tag}`;
};

// The org's hashtags that did better than usual over the last 90 days (#818), the ones the text lacks; a click adds one.
// onAiUsed: the post becomes AI-assisted (tainted) when a hashtag the writer suggested goes in (#824).
function HashtagSuggestions({ text, connectionId, onPick, onAiUsed }: { text: string; connectionId: string | null; onPick: (tag: string) => void; onAiUsed?: (() => void) | undefined }) {
  const t = useTranslations('social');
  const locale = useLocale();
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const insights = useQuery({ ...orpc.social.metrics.insights.queryOptions({ input: { days: 90, timeZone } }), staleTime: 10 * 60_000 });
  const tags = hashtagSuggestions(insights.data?.channels ?? [], text, { connectionId });
  const ai = useMutation({
    mutationFn: () =>
      client.social.posts.suggestHashtags({ text: text.trim(), language: locale === 'en' ? 'en' : 'vi', exclude: [...hashtagsOf(text), ...tags].slice(0, 50), ...(connectionId ? { connectionId } : {}) }),
  });
  const aiTags = (ai.data?.hashtags ?? []).filter((tag) => !hashtagsOf(text).includes(tag));
  const canAsk = getConfig().aiEnabled === true && onAiUsed !== undefined && text.trim() !== '';
  if (tags.length === 0 && !canAsk) return null;
  const chip = 'rounded-full border px-2 py-0.5 text-muted-foreground hover:border-ring/60 hover:text-foreground';
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        {tags.length > 0 && <span className="text-subtle-foreground">{t('hashtagSuggestions')}</span>}
        {tags.map((tag) => (
          <button key={tag} type="button" className={chip} onClick={() => onPick(tag)}>
            #{tag}
          </button>
        ))}
        {canAsk && (
          <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-xs" disabled={ai.isPending} onClick={() => ai.mutate()}>
            {ai.isPending ? <Spinner className="text-current" /> : null}
            {t('hashtagsAi')}
          </Button>
        )}
      </div>
      {aiTags.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-subtle-foreground">{t('hashtagsAiLabel')}</span>
          {aiTags.map((tag) => (
            <button
              key={tag}
              type="button"
              className={cn(chip, 'border-dashed')}
              onClick={() => {
                onPick(tag);
                onAiUsed?.();
              }}
            >
              #{tag}
            </button>
          ))}
        </div>
      )}
      {ai.error && <ErrorText>{errorMessage(ai.error)}</ErrorText>}
    </div>
  );
}

function SharedFields({
  base,
  onChange,
  disabled,
  needsTitle,
  autoFocus = false,
  onAiUsed,
  slug,
  connectionIds = [],
}: {
  base: Base;
  onChange: (base: Base) => void;
  disabled: boolean;
  needsTitle: boolean;
  autoFocus?: boolean;
  onAiUsed?: () => void;
  slug?: string;
  // The post's channels: the shared text is checked against the banned words of any of them (#1055).
  connectionIds?: readonly string[];
}) {
  const t = useTranslations('social');
  const banned = wordsForChannels(useBannedWords(), connectionIds);
  return (
    <Card className="block space-y-3 p-4">
      <div className="space-y-1.5">
        <Label htmlFor="social-body">{t('sharedText')}</Label>
        <Textarea id="social-body" autoFocus={autoFocus} value={base.body} disabled={disabled} rows={7} placeholder={t('sharedTextPlaceholder')} onChange={(e) => onChange({ ...base, body: e.target.value })} />
        <div className="flex flex-wrap items-center gap-2">
          <EmojiPicker targetId="social-body" value={base.body} disabled={disabled} onChange={(body) => onChange({ ...base, body })} />
          {slug && <SnippetPicker slug={slug} targetId="social-body" value={base.body} disabled={disabled} onChange={(body) => onChange({ ...base, body })} />}
        </div>
        <BannedWordHints texts={[{ field: 'body', text: base.body }, ...(needsTitle && base.title ? [{ field: 'title', text: base.title }] : [])]} words={banned} />
        {!disabled && <HashtagSuggestions text={base.body} connectionId={null} onAiUsed={onAiUsed} onPick={(tag) => onChange({ ...base, body: withHashtag(base.body, tag) })} />}
        {!disabled && onAiUsed && (
          <AiRewrite
            text={base.body}
            title={needsTitle ? base.title || null : null}
            onAccept={(next) => {
              onChange({ ...base, body: next.text, title: next.title ?? base.title });
              onAiUsed();
            }}
          />
        )}
      </div>
      {needsTitle && (
        <div className="space-y-1.5">
          <Label htmlFor="social-title">{t('titleField')}</Label>
          <Input id="social-title" value={base.title} disabled={disabled} placeholder={t('titlePlaceholder')} onChange={(e) => onChange({ ...base, title: e.target.value })} />
        </div>
      )}
      <div className="space-y-1.5">
        <Label htmlFor="social-link">{t('link')}</Label>
        <Input id="social-link" type="url" inputMode="url" value={base.linkUrl} disabled={disabled} placeholder="https://" onChange={(e) => onChange({ ...base, linkUrl: e.target.value })} />
      </div>
      <MediaField media={base.media} disabled={disabled} onAiUsed={onAiUsed} onChange={(media) => onChange({ ...base, media })} />
    </Card>
  );
}

const orNull = (value: string) => (value.trim() === '' ? null : value);
const mediaInput = (media: readonly MediaItem[]) => media.map((m) => ({ fileId: m.fileId, altText: orNull(m.altText) }));
const mediaItems = (media: readonly { fileId: string; altText: string | null; mime: string; sizeBytes: number; durationMs: number | null; width: number | null; height: number | null }[]): MediaItem[] =>
  media.map((m) => ({ fileId: m.fileId, altText: m.altText ?? '', mime: m.mime, sizeBytes: m.sizeBytes, durationMs: m.durationMs, width: m.width, height: m.height }));

// ---------------------------------------------------------------------------------------------------------------------
// New post
// ---------------------------------------------------------------------------------------------------------------------

// Approves every channel of a post just submitted, as its owner or admin sees it, then schedules the ones that need no
// other reviewer: at the planned time, or in each channel's queue (#638).
async function approveAndSchedule(postId: string, plannedAt: string | null): Promise<void> {
  const post = await client.social.posts.get({ postId });
  const review = post.variants.filter((v) => v.status === 'in_review');
  if (review.length === 0) return;
  const decided = await client.social.variants.decide({ postId, decision: 'approved', variants: review.map((v) => ({ variantId: v.id, revision: v.revision, contentHash: v.contentHash })) });
  const ready = decided.variants.filter((id) => !decided.waiting.includes(id));
  if (ready.length === 0) return;
  const at = plannedAt && Date.parse(plannedAt) > Date.now() ? plannedAt : null;
  await client.social.variants.schedule({ postId, variantIds: ready, ...(at ? { at } : { queue: true as const }) });
}

// What the composer keeps of a post not yet created (#634).
type ComposeDraft = { base: Base; chosen: string[]; own: Record<string, Own>; utm: UtmTags | null; plannedAt: string | null; aiUsed: boolean };

export function SocialComposePage() {
  const { slug } = useParams({ strict: false }) as { slug: string };
  const t = useTranslations('social');
  const f = useFormat();
  const navigate = useNavigate();
  const channels = useQuery(orpc.channels.list.queryOptions({ input: {} }));
  const [base, setBase] = useState<Base>({ body: '', title: '', linkUrl: '', media: [] });
  const [chosen, setChosen] = useState<string[]>([]);
  const [own, setOwn] = useState<Record<string, Own>>({});
  // UTM tags for the post's link, put on every channel's settings when it is created (#585).
  const [utm, setUtm] = useState<UtmTags | null>(null);
  // An AI rewrite was taken into the text (#583): the post is saved as AI-assisted.
  const [aiUsed, setAiUsed] = useState(false);
  const live = (channels.data ?? []).filter((c) => c.status === 'active');
  // A planned time from the calendar (#580), kept on the draft; scheduling starts from it.
  const search: { at?: string; idea?: string; occasion?: string; on?: string } = useSearch({ strict: false });
  // A post for an occasion of the calendar (#702): named above the form, and the AI brief starts from it.
  const tOcc = useTranslations('social.occasions');
  const occasion = search.occasion && search.on ? { name: tOcc(`names.${search.occasion as 'tet'}`), date: f.date(search.on) } : null;
  const [plannedAt, setPlannedAt] = useState<string | null>(() => (search.at && Date.parse(search.at) > Date.now() ? search.at : null));
  // A draft made from an idea (#701): its title and note become the text, its link and media the post's; the saved
  // post names the idea, which then shows as drafted.
  const idea = useQuery({ ...orpc.social.ideas.get.queryOptions({ input: { ideaId: search.idea ?? '' } }), enabled: Boolean(search.idea), staleTime: Infinity });
  const ideaTaken = useRef(false);
  useEffect(() => {
    const i = idea.data;
    if (!i || ideaTaken.current) return;
    ideaTaken.current = true;
    setBase({
      body: i.note ? `${i.title}\n\n${i.note}` : i.title,
      title: '',
      linkUrl: i.linkUrl ?? '',
      media: i.media.map((m) => ({ fileId: m.fileId, altText: '', mime: m.mime, sizeBytes: m.sizeBytes, durationMs: m.durationMs, width: m.width, height: m.height })),
    });
  }, [idea.data]);
  const ideaId = idea.data && !idea.data.postId && idea.data.stage !== 'archived' ? idea.data.id : null;
  useEffect(() => {
    // The only channel is chosen for you.
    if (chosen.length === 0 && live.length === 1 && live[0]) setChosen([live[0].id]);
  }, [live.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // Unsaved work is kept in this browser as it is typed (#634) and offered back after a reload; leaving asks first.
  const [restore, setRestore] = useState(() => loadDraft<ComposeDraft>(slug, 'new'));
  const leaving = useRef(false);
  const touched = base.body.trim() !== '' || base.title.trim() !== '' || base.linkUrl.trim() !== '' || base.media.length > 0 || Object.values(own).some((o) => o.custom || o.customMedia);
  useEffect(() => {
    if (restore) return;
    const timer = setTimeout(() => (touched ? saveDraft<ComposeDraft>(slug, 'new', null, { base, chosen, own, utm, plannedAt, aiUsed }) : clearDraft(slug, 'new')), 400);
    return () => clearTimeout(timer);
  }, [base, chosen, own, utm, plannedAt, aiUsed, restore, touched, slug]);
  const takeDraft = (d: StoredDraft<ComposeDraft>) => {
    setBase(d.data.base);
    setChosen(d.data.chosen);
    setOwn(d.data.own);
    setUtm(d.data.utm);
    setPlannedAt(d.data.plannedAt);
    setAiUsed(d.data.aiUsed);
    setRestore(null);
  };
  useBlocker({ shouldBlockFn: () => touched && !leaving.current && !window.confirm(t('leaveConfirm')), enableBeforeUnload: () => touched && !leaving.current });

  // One key per content: a retry of the same content after a lost answer returns the post the first request created;
  // content edited after a failed attempt is a new request (the server would refuse the old key with other content).
  const attempt = useRef<{ key: string; payload: string } | null>(null);
  const create = useMutation({
    // draft: saved only; submit: sent to review; publish: also approved by this owner or admin and scheduled (#638).
    mutationFn: async (mode: 'draft' | 'submit' | 'publish') => {
      const request = {
        body: base.body,
        title: orNull(base.title),
        linkUrl: orNull(base.linkUrl),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        // A planned time that went by while the page was open is dropped.
        ...(plannedAt && Date.parse(plannedAt) > Date.now() ? { scheduledAt: plannedAt } : {}),
        ...(aiUsed ? { aiAssisted: true as const } : {}),
        ...(ideaId ? { ideaId } : {}),
        media: mediaInput(base.media),
        channels: chosen.map((connectionId) => {
          const mine = withUtm(own[connectionId] ?? EMPTY_OWN, utm);
          const settings = Object.keys(mine.settings).length > 0 ? { settings: mine.settings as ApiSettings } : {};
          const media = mine.customMedia ? { media: mediaInput(mine.media) } : {};
          return mine.custom ? { connectionId, body: mine.body, title: orNull(mine.title), ...settings, ...media } : { connectionId, ...settings, ...media };
        }),
      };
      const payload = JSON.stringify(request);
      if (attempt.current?.payload !== payload) attempt.current = { key: crypto.randomUUID(), payload };
      const created = await client.social.posts.create({ idempotencyKey: attempt.current.key, ...request });
      // The draft exists now: a failed submit is shown on its page, never answered with a second post.
      if (mode === 'draft') return created.postId;
      const submitted = await client.social.posts.submit({ postId: created.postId }).then(
        () => true,
        (error: unknown) => {
          setFlash(errorMessage(error));
          return false;
        },
      );
      if (mode === 'publish' && submitted) await approveAndSchedule(created.postId, plannedAt).catch((error: unknown) => setFlash(errorMessage(error)));
      return created.postId;
    },
    onSuccess: (postId) => {
      leaving.current = true;
      clearDraft(slug, 'new');
      void queryClient.invalidateQueries();
      void navigate({ to: '/o/$slug/social/$id', params: { slug, id: postId } });
    },
  });

  // AI drafting (S7): the server asks the model for a draft of the brief for the chosen channels and saves it as a
  // new post marked as written by AI; every channel of it is reviewed before it can go out.
  const [brief, setBrief] = useState(() => (occasion ? tOcc('brief', occasion) : ''));
  // A page to write about (#769): the post links to it.
  const [sourceUrl, setSourceUrl] = useState('');
  // http(s), with no user name or password in it, as the server takes it.
  const source = /^https?:\/\/[^\s@/?#]+(?:[/?#]\S*)?$/.test(sourceUrl.trim()) ? sourceUrl.trim() : null;
  const locale = useLocale();
  const aiEnabled = getConfig().aiEnabled === true;
  const aiDraft = useMutation({
    mutationFn: () => client.social.posts.draftWithAi({ brief: brief.trim(), connectionIds: chosen, language: locale === 'en' ? 'en' : 'vi', ...(source ? { sourceUrl: source } : {}) }),
    onSuccess: ({ postId }) => {
      leaving.current = true;
      void queryClient.invalidateQueries();
      void navigate({ to: '/o/$slug/social/$id', params: { slug, id: postId } });
    },
  });

  const selected = live.filter((c) => chosen.includes(c.id));
  const blocking = selected.some((c) => {
    const mine = own[c.id] ?? EMPTY_OWN;
    const content = { body: mine.custom ? mine.body : base.body, title: mine.custom ? mine.title : base.title };
    return draftIssues(c.provider, { body: content.body, title: hasTitle(c.provider) ? content.title : null, linkUrl: base.linkUrl, media: mediaOfOwn(mine, base), settings: withUtm(mine, utm).settings }).length > 0;
  });
  // Owners and admins may approve their own post: for one written by a person (no AI text), one action approves it and
  // schedules it (#638). A channel whose policy needs another reviewer still waits for them.
  const { canDecide } = useRole(slug);
  // Not where four-eyes (#740) asks for another reviewer: the author's approval would be refused.
  const policies = useQuery({ ...orpc.social.policies.list.queryOptions({ input: {} }), enabled: canDecide });
  const fourEyes = new Set((policies.data ?? []).filter((p) => p.fourEyes).map((p) => p.connectionId));
  const oneStep = canDecide && !aiUsed && policies.isSuccess && !selected.some((c) => fourEyes.has(c.id));
  const onKey = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && chosen.length > 0 && !blocking && !create.isPending) {
      e.preventDefault();
      create.mutate('submit');
    }
  };

  if (channels.isLoading) return <Spinner />;
  return (
    <div onKeyDown={onKey}>
      <PageHeader
        title={t('composeTitle')}
        subtitle={t('composeSubtitle')}
        actions={
          <>
            <Button variant="outline" size="lg" disabled={chosen.length === 0 || create.isPending} onClick={() => create.mutate('draft')}>
              {t('saveDraft')}
            </Button>
            <Button size="lg" variant={oneStep ? 'outline' : 'default'} disabled={chosen.length === 0 || blocking || create.isPending} onClick={() => create.mutate('submit')}>
              {create.isPending && create.variables === 'submit' ? <Spinner className="text-current" /> : null}
              {t('saveAndSubmit')}
            </Button>
            {oneStep && (
              <Button size="lg" disabled={chosen.length === 0 || blocking || create.isPending} onClick={() => create.mutate('publish')} title={t('publishNowHint')}>
                {create.isPending && create.variables === 'publish' ? <Spinner className="text-current" /> : null}
                {t('publishNow')}
              </Button>
            )}
          </>
        }
      />
      {restore && (
        <Notice>
          <div className="flex flex-wrap items-center gap-2">
            <span>{t('draftFound', { when: f.dateTime(restore.savedAt) })}</span>
            <Button size="sm" onClick={() => takeDraft(restore)}>
              {t('draftRestore')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                clearDraft(slug, 'new');
                setRestore(null);
              }}
            >
              {t('draftDiscard')}
            </Button>
          </div>
        </Notice>
      )}
      {occasion && (
        <Notice>
          <span>{tOcc('composing', occasion)}</span>
        </Notice>
      )}
      {idea.data && (
        <Notice>
          <span>{t(ideaId ? 'ideas.fromIdea' : 'ideas.fromIdeaTaken', { title: idea.data.title })}</span>
        </Notice>
      )}
      {create.error && (
        <div className="mb-4">
          <ErrorText>{errorMessage(create.error)}</ErrorText>
        </div>
      )}
      {plannedAt && (
        <p className="mb-4 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          {t('plannedFor', { when: f.dateTime(plannedAt) })}
          <Button variant="ghost" size="sm" onClick={() => setPlannedAt(null)}>
            {t('plannedClear')}
          </Button>
        </p>
      )}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="space-y-4">
          <SharedFields
            base={base}
            onChange={setBase}
            disabled={create.isPending}
            autoFocus
            needsTitle={selected.some((c) => hasTitle(c.provider))}
            onAiUsed={() => setAiUsed(true)}
            slug={slug}
            connectionIds={selected.map((c) => c.id)}
          />
          {base.linkUrl.trim() && (
            <Card className="block p-4">
              <UtmFields utm={utm} onChange={setUtm} disabled={create.isPending} />
            </Card>
          )}
          <Card className="block p-4">
            <p className="mb-3 text-sm font-medium text-foreground">{t('pickChannels')}</p>
            <ChannelSetPicker live={live} onPick={setChosen} />
            {live.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t('noChannelsHint')}{' '}
                <Link to="/o/$slug/social/channels" params={{ slug }} className="text-link hover:underline">
                  {t('connectFirst')}
                </Link>
              </p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {live.map((c) => {
                  const on = chosen.includes(c.id);
                  return (
                    <button
                      key={c.id}
                      type="button"
                      aria-pressed={on}
                      onClick={() => setChosen(on ? chosen.filter((id) => id !== c.id) : [...chosen, c.id])}
                      className={cn(
                        'inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
                        on ? 'border-primary/50 bg-primary/15 text-foreground' : 'bg-card text-muted-foreground hover:text-foreground',
                      )}
                    >
                      <span className="text-xs text-subtle-foreground">{providerName(c.provider)}</span>
                      {c.displayName}
                    </button>
                  );
                })}
              </div>
            )}
          </Card>
          <Card className="block space-y-2 p-4">
            <Label htmlFor="social-ai-brief">{t('aiDraftTitle')}</Label>
            {aiEnabled ? (
              <>
                <Textarea id="social-ai-brief" value={brief} rows={3} maxLength={4000} placeholder={t('aiBriefPlaceholder')} disabled={aiDraft.isPending} onChange={(e) => {
                  setBrief(e.target.value);
                  if (aiDraft.error) aiDraft.reset();
                }} />
                <Label htmlFor="social-ai-source" className="text-xs">
                  {t('aiSource')}
                </Label>
                <Input id="social-ai-source" type="url" value={sourceUrl} placeholder="https://" disabled={aiDraft.isPending} onChange={(e) => {
                  setSourceUrl(e.target.value);
                  if (aiDraft.error) aiDraft.reset();
                }} />
                <p className="text-xs text-subtle-foreground">{t('aiDraftHint')}</p>
                <Button variant="outline" size="sm" disabled={(!brief.trim() && !source) || (sourceUrl.trim() !== '' && !source) || chosen.length === 0 || aiDraft.isPending} onClick={() => aiDraft.mutate()}>
                  {aiDraft.isPending ? <Spinner className="text-current" /> : null}
                  {t('aiDraft')}
                </Button>
                {aiDraft.error && <ErrorText>{errorMessage(aiDraft.error)}</ErrorText>}
              </>
            ) : (
              <p className="text-xs text-subtle-foreground">{t('aiOff')}</p>
            )}
          </Card>
          <p className="text-xs text-subtle-foreground">{t('shortcutHint')}</p>
        </div>
        <div className="space-y-4">
          {selected.length === 0 ? (
            <Card className="block p-6 text-sm text-muted-foreground">{t('pickChannelsHint')}</Card>
          ) : (
            selected.map((c) => (
              <ChannelEditor
                slug={slug}
                key={c.id}
                provider={c.provider}
                channel={c.displayName}
                base={base}
                own={withUtm(own[c.id] ?? EMPTY_OWN, utm)}
                disabled={create.isPending}
                onChange={(next) => setOwn({ ...own, [c.id]: next })}
                connectionId={c.id}
                scopes={c.scopes}
                onAiUsed={() => setAiUsed(true)}
                onRemoveAtAll={
                  selected.length > 1
                    ? (removeAt) => {
                        const next = { ...own };
                        for (const s of selected) {
                          const mine = own[s.id] ?? EMPTY_OWN;
                          if (isProvider(s.provider) && REMOVE_READY.has(s.provider) && postTypeOf(mine.settings) !== 'story') next[s.id] = { ...mine, settings: { ...mine.settings, removeAt } };
                        }
                        setOwn(next);
                      }
                    : undefined
                }
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// One post: edit, review, schedule
// ---------------------------------------------------------------------------------------------------------------------

function ownOf(v: Variant): Own {
  return { custom: v.overrides.body !== null, body: v.overrides.body ?? '', title: v.overrides.title ?? '', settings: v.settings, customMedia: v.ownMedia, media: v.ownMedia ? mediaItems(v.media) : [] };
}

// What a post says, not its status: the post's revision and each variant's revision and own content (an override
// change elsewhere shows as an edit even if it did not move the revision).
function contentKey(p: Post): string {
  return `${p.revision}|${p.variants.map((v) => `${v.id}:${v.revision}:${JSON.stringify([v.overrides, v.settings, v.ownMedia])}`).join(',')}`;
}

function baseOf(p: Post): Base {
  return { body: p.body, title: p.title ?? '', linkUrl: p.linkUrl ?? '', media: mediaItems(p.media) };
}

function sameOwn(a: Own, b: Own): boolean {
  return (
    a.custom === b.custom &&
    (!a.custom || (a.body === b.body && a.title === b.title)) &&
    sameSettings(a.settings, b.settings) &&
    a.customMedia === b.customMedia &&
    (!a.customMedia || sameMediaList(a.media, b.media))
  );
}

// A channel's planned takedown time (#861), when it has a valid one.
function plannedRemoval(v: Variant): string | null {
  const at = removeAtOf(v.settings);
  return at === null || at === 'invalid' ? null : at;
}

function ReviewPanel({ post, names, onDone }: { post: Post; names: Map<string, string>; onDone: () => void }) {
  const t = useTranslations('social');
  const f = useFormat();
  const me = useQuery(orpc.me.get.queryOptions());
  const self = me.data?.userId;
  const inReview = post.variants.filter((v) => v.status === 'in_review');
  // A channel that needs several approvals waits for another person once this reviewer has approved it.
  // The reviewer may still ask for changes or reject such a channel, which ends the round; only approving it again is
  // refused.
  const mine = (v: Variant) => self !== undefined && v.review.approvedBy.includes(self);
  // Four-eyes (#740): on these channels the author may not approve their own post.
  const ownPost = self !== undefined && post.authorUserId === self;
  const barred = (v: Variant) => ownPost && v.review.fourEyes;
  const waiting = inReview;
  const [unticked, setUnticked] = useState<string[]>([]);
  const picked = waiting.map((v) => v.id).filter((id) => !unticked.includes(id));
  const [comment, setComment] = useState('');
  const decide = useMutation({
    mutationFn: (decision: 'approved' | 'changes_requested' | 'rejected') =>
      client.social.variants.decide({
        postId: post.id,
        decision,
        ...(comment.trim() ? { comment: comment.trim() } : {}),
        // What this reviewer sees: a newer revision is refused, never approved by mistake.
        variants: waiting.filter((v) => picked.includes(v.id) && (decision !== 'approved' || (!mine(v) && !barred(v)))).map((v) => ({ variantId: v.id, revision: v.revision, contentHash: v.contentHash })),
      }),
    onSuccess: () => {
      setComment('');
      setUnticked([]);
      onDone();
    },
  });
  if (inReview.length === 0) return null;
  const done = inReview.filter(mine);
  const approvable = waiting.filter((v) => picked.includes(v.id) && !mine(v) && !barred(v));
  const others = inReview.filter(barred);

  return (
    <Card className="block space-y-3 border-warning/40 p-4">
      <p className="text-sm font-medium text-foreground">{t('reviewTitle')}</p>
      {others.length > 0 && <p className="text-xs text-subtle-foreground">{t('reviewFourEyes', { channels: others.map((v) => names.get(v.connectionId) ?? providerName(v.provider)).join(', ') })}</p>}
      {done.length > 0 && <p className="text-xs text-subtle-foreground">{t('reviewYouApproved', { channels: done.map((v) => names.get(v.connectionId) ?? providerName(v.provider)).join(', ') })}</p>}
      {waiting.length > 0 && (
        <div className="space-y-1.5">
          {waiting.map((v) => (
            <label key={v.id} className="flex items-center gap-2 text-sm text-muted-foreground">
              <Checkbox checked={picked.includes(v.id)} onCheckedChange={(on) => setUnticked(on === true ? unticked.filter((id) => id !== v.id) : [...unticked, v.id])} />
              {names.get(v.connectionId) ?? providerName(v.provider)}
              {v.review.required > 1 && (
                <span className="text-xs text-subtle-foreground tabular-nums">{t('reviewSteps', { given: String(v.review.approvedBy.length), required: String(v.review.required) })}</span>
              )}
              {/* Approving approves the planned takedown too (#861). */}
              {plannedRemoval(v) && <span className="text-xs text-warning">{t('remove.planned', { when: f.dateTime(plannedRemoval(v) as string) })}</span>}
            </label>
          ))}
        </div>
      )}
      {/* The org's banned or sensitive words each channel holds (#1055): a warning to weigh, a block that refuses approval. */}
      {waiting.map((v) => (
        <BannedWordReview key={`banned-${v.id}`} channel={names.get(v.connectionId) ?? providerName(v.provider)} matches={v.bannedWords} status={v.bannedWordsStatus} content={v.effective} settings={v.settings} />
      ))}
      {/* What changed since each channel's last decision (#944); nothing on a first review. */}
      <ReviewChanges postId={post.id} variants={waiting.map((v) => ({ id: v.id, name: names.get(v.connectionId) ?? providerName(v.provider), revision: v.revision, contentHash: v.contentHash }))} />
      <Textarea value={comment} rows={2} aria-label={t('commentPlaceholder')} placeholder={t('commentPlaceholder')} onChange={(e) => setComment(e.target.value)} />
      {decide.error && <ErrorText>{errorMessage(decide.error)}</ErrorText>}
      <div className="flex flex-wrap gap-2">
        <Button size="lg" disabled={self === undefined || approvable.length === 0 || decide.isPending} onClick={() => decide.mutate('approved')}>
          {t('approve')}
        </Button>
        <Button variant="outline" size="lg" disabled={picked.length === 0 || decide.isPending || !comment.trim()} onClick={() => decide.mutate('changes_requested')}>
          {t('requestChanges')}
        </Button>
        <Button variant="destructive" size="lg" disabled={picked.length === 0 || decide.isPending} onClick={() => decide.mutate('rejected')}>
          {t('reject')}
        </Button>
      </div>
      {!comment.trim() && waiting.length > 0 && <p className="text-xs text-subtle-foreground">{t('changesNeedComment')}</p>}
    </Card>
  );
}

function SchedulePanel({ post, names, onDone }: { post: Post; names: Map<string, string>; onDone: () => void }) {
  const t = useTranslations('social');
  const ready = post.variants.filter((v) => v.status === 'approved');
  const [mode, setMode] = useState<'time' | 'queue'>('time');
  const [when, setWhen] = useState(() => toLocalInput(post.scheduledAt ?? new Date(Date.now() + 3_600_000).toISOString()));
  // A time per channel (#576): each starts at the shared time.
  const [perChannel, setPerChannel] = useState(false);
  const [times, setTimes] = useState<Record<string, string>>({});
  const timeOf = (variantId: string) => times[variantId] ?? when;
  const allSet = perChannel ? ready.every((v) => fromLocalInput(timeOf(v.id))) : Boolean(fromLocalInput(when));
  const schedule = useMutation({
    mutationFn: () => {
      if (mode === 'time' && perChannel) {
        return client.social.variants.schedule({ postId: post.id, times: ready.map((v) => ({ variantId: v.id, at: fromLocalInput(timeOf(v.id)) as string })) });
      }
      const at = fromLocalInput(when);
      return client.social.variants.schedule({ postId: post.id, variantIds: ready.map((v) => v.id), ...(mode === 'queue' ? { queue: true as const } : at ? { at } : {}) });
    },
    onSuccess: onDone,
  });
  if (ready.length === 0) return null;
  const only = ready.length === 1 ? ready[0] : undefined;
  const min = toLocalInput(new Date().toISOString());
  return (
    <Card className="block space-y-3 border-primary/40 p-4">
      <p className="text-sm font-medium text-foreground">{t('scheduleTitle', { count: ready.length })}</p>
      <div className="flex flex-wrap gap-2" role="group" aria-label={t('scheduleTitle', { count: ready.length })}>
        {(['time', 'queue'] as const).map((m) => (
          <button
            key={m}
            type="button"
            aria-pressed={mode === m}
            onClick={() => setMode(m)}
            className={cn(
              'rounded-lg border px-3 py-1.5 text-sm focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
              mode === m ? 'border-primary/50 bg-primary/15 text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {t(m === 'time' ? 'atTime' : 'nextSlot')}
          </button>
        ))}
      </div>
      {mode === 'time' && !perChannel && (
        <div className="flex flex-wrap items-center gap-2">
          <Input type="datetime-local" aria-label={t('atTime')} value={when} min={min} onChange={(e) => setWhen(e.target.value)} className="max-w-xs" />
          {/* One channel: the shared time is its time (#980). */}
          {only && <BestTimeButton connectionId={only.connectionId} timeZone={post.timeZone} exceptVariantId={only.id} onPick={(at) => setWhen(toLocalInput(at))} />}
        </div>
      )}
      {mode === 'time' && ready.length > 1 && (
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <input type="checkbox" checked={perChannel} onChange={(e) => setPerChannel(e.target.checked)} className="size-4 accent-primary" />
          {t('timePerChannel')}
        </label>
      )}
      {mode === 'time' && perChannel && (
        <div className="space-y-2">
          {ready.map((v) => (
            <div key={v.id} className="flex flex-wrap items-center gap-2 text-sm">
              <span id={`time-${v.id}`} className="min-w-40 text-foreground">
                {names.get(v.connectionId) ?? providerName(v.provider)} <span className="text-xs text-subtle-foreground">{providerName(v.provider)}</span>
              </span>
              <Input type="datetime-local" aria-labelledby={`time-${v.id}`} value={timeOf(v.id)} min={min} onChange={(e) => setTimes((prev) => ({ ...prev, [v.id]: e.target.value }))} className="max-w-xs" />
              <BestTimeButton connectionId={v.connectionId} timeZone={post.timeZone} exceptVariantId={v.id} onPick={(at) => setTimes((prev) => ({ ...prev, [v.id]: toLocalInput(at) }))} />
            </div>
          ))}
        </div>
      )}
      {mode === 'queue' && <p className="text-xs text-subtle-foreground">{t('nextSlotHint')}</p>}
      {schedule.error && <ErrorText>{errorMessage(schedule.error)}</ErrorText>}
      <Button size="lg" disabled={schedule.isPending || (mode === 'time' && !allSet)} onClick={() => schedule.mutate()}>
        {t('schedule')}
      </Button>
    </Card>
  );
}

const EVERGREEN_DAYS = [7, 14, 30, 60, 90, 180, 365] as const;

// Evergreen (S9): a published post drafted again every N days and sent to review; a person approves each repost.
function EvergreenPanel({ post, onDone }: { post: Post; onDone: () => void }) {
  const t = useTranslations('social');
  const set = useMutation({ mutationFn: (days: number | null) => client.social.posts.setEvergreen({ postId: post.id, days }), onSuccess: onDone });
  const current = post.evergreenDays;
  return (
    <Card className="block space-y-2 p-4">
      <Label htmlFor="evergreen" className="text-sm font-medium text-foreground">
        {t('evergreenTitle')}
      </Label>
      <NativeSelect
        id="evergreen"
        size="sm"
        className="w-full max-w-xs"
        value={current === null ? '' : String(current)}
        disabled={set.isPending}
        onChange={(e) => set.mutate(e.target.value === '' ? null : Number(e.target.value))}
      >
        <NativeSelectOption value="">{t('evergreenOff')}</NativeSelectOption>
        {current !== null && !(EVERGREEN_DAYS as readonly number[]).includes(current) && (
          <NativeSelectOption value={String(current)}>{t('evergreenEvery', { days: String(current) })}</NativeSelectOption>
        )}
        {EVERGREEN_DAYS.map((d) => (
          <NativeSelectOption key={d} value={String(d)}>
            {t('evergreenEvery', { days: String(d) })}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      <p className="text-xs text-subtle-foreground">{t('evergreenHint')}</p>
      {set.error && <ErrorText>{errorMessage(set.error)}</ErrorText>}
    </Card>
  );
}

// Recurring posts (#979): weekdays in the Vietnamese week order, T2 to CN (0 = Sunday, as the rule stores them).
const RECURRENCE_DAYS = [1, 2, 3, 4, 5, 6, 0] as const;
const DAY_KEY = { 0: 'sun', 1: 'mon', 2: 'tue', 3: 'wed', 4: 'thu', 5: 'fri', 6: 'sat' } as const;
// 'both' ends at the date or after the count, whichever comes first (a rule may set both).
type RecurrenceEnd = 'never' | 'date' | 'times' | 'both';

// Where a new rule starts: the weekday and local time the post is planned or went out at, else Monday 09:00.
function recurrenceStart(post: Post): { weekday: number; time: string } {
  const at = post.variants.map((v) => v.effectiveAt).find((x) => x !== null) ?? post.scheduledAt;
  if (!at) return { weekday: 1, time: '09:00' };
  const l = localTime(Date.parse(at), post.timeZone);
  return { weekday: l.weekday % 7, time: `${String(l.hour).padStart(2, '0')}:${String(l.minute).padStart(2, '0')}` };
}

// A post repeated every N weeks on chosen weekdays at a local time, until a date or for a number of times. After each
// copy is done the worker drafts the next, planned for its occurrence and sent to review.
function RecurrencePanel({ post, published, onDone }: { post: Post; published: boolean; onDone: () => void }) {
  const t = useTranslations('social');
  const id = useId();
  const rule = post.recurrence;
  const start = recurrenceStart(post);
  const [everyWeeks, setEveryWeeks] = useState(rule?.everyWeeks ?? 1);
  const [weekdays, setWeekdays] = useState<number[]>(rule?.weekdays ?? [start.weekday]);
  const [time, setTime] = useState(rule?.time ?? start.time);
  const [end, setEnd] = useState<RecurrenceEnd>(rule?.until && rule.times ? 'both' : rule?.until ? 'date' : rule?.times ? 'times' : 'never');
  const byDate = end === 'date' || end === 'both';
  const byTimes = end === 'times' || end === 'both';
  const [until, setUntil] = useState(rule?.until ?? '');
  const [times, setTimes] = useState(String(rule?.times ?? 4));
  const count = Number(times);
  const valid =
    weekdays.length > 0 &&
    /^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(time) &&
    (!byDate || /^\d{4}-\d{2}-\d{2}$/.test(until)) &&
    (!byTimes || (Number.isInteger(count) && count >= 1 && count <= SOCIAL_RECURRENCE_TIMES_MAX));
  const save = useMutation({
    mutationFn: () =>
      client.social.posts.setRecurrence({
        postId: post.id,
        recurrence: { everyWeeks, weekdays, time, until: byDate ? until : null, times: byTimes ? count : null },
      }),
    onSuccess: onDone,
  });
  const clear = useMutation({ mutationFn: () => client.social.posts.clearRecurrence({ postId: post.id }), onSuccess: onDone });
  const busy = save.isPending || clear.isPending;
  const toggle = (day: number, on: boolean) => setWeekdays(on ? [...new Set([...weekdays, day])].sort((a, b) => a - b) : weekdays.filter((d) => d !== day));
  return (
    <Card className="block space-y-3 p-4">
      <p className="text-sm font-medium text-foreground">{t('recurrence.title')}</p>
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-every`} className="text-xs">
          {t('recurrence.frequency')}
        </Label>
        <NativeSelect id={`${id}-every`} size="sm" className="w-full max-w-xs" value={String(everyWeeks)} disabled={busy} onChange={(e) => setEveryWeeks(Number(e.target.value))}>
          {(['1', '2', '3', '4'] as const).map((n) => (
            <NativeSelectOption key={n} value={n}>
              {t(`recurrence.every.${n}`)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>
      <fieldset className="space-y-1.5">
        <legend className="text-xs font-medium text-foreground">{t('recurrence.days')}</legend>
        <div className="flex flex-wrap gap-3">
          {RECURRENCE_DAYS.map((day) => (
            <label key={day} className="flex items-center gap-1.5 text-sm text-muted-foreground" title={t(`weekday.${DAY_KEY[day]}`)}>
              <Checkbox checked={weekdays.includes(day)} disabled={busy} aria-label={t(`weekday.${DAY_KEY[day]}`)} onCheckedChange={(on) => toggle(day, on === true)} />
              {t(`weekdayShort.${DAY_KEY[day]}`)}
            </label>
          ))}
        </div>
        {weekdays.length === 0 && <p className="text-xs text-destructive">{t('recurrence.pickDay')}</p>}
      </fieldset>
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-time`} className="text-xs">
          {t('recurrence.time')}
        </Label>
        <div className="flex flex-wrap items-center gap-2">
          <Input id={`${id}-time`} type="time" className="w-32" value={time} disabled={busy} onChange={(e) => setTime(e.target.value)} />
          <span className="text-xs text-subtle-foreground">{t('recurrence.timeZone', { zone: post.timeZone })}</span>
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-end`} className="text-xs">
          {t('recurrence.end')}
        </Label>
        <div className="flex flex-wrap items-center gap-2">
          <NativeSelect id={`${id}-end`} size="sm" className="w-56" value={end} disabled={busy} onChange={(e) => setEnd(e.target.value as RecurrenceEnd)}>
            <NativeSelectOption value="never">{t('recurrence.endNever')}</NativeSelectOption>
            <NativeSelectOption value="date">{t('recurrence.endDate')}</NativeSelectOption>
            <NativeSelectOption value="times">{t('recurrence.endTimes')}</NativeSelectOption>
            <NativeSelectOption value="both">{t('recurrence.endBoth')}</NativeSelectOption>
          </NativeSelect>
          {byDate && <Input type="date" aria-label={t('recurrence.untilLabel')} className="w-40" value={until} disabled={busy} onChange={(e) => setUntil(e.target.value)} />}
          {byTimes && (
            <Input type="number" aria-label={t('recurrence.timesLabel')} min={1} max={SOCIAL_RECURRENCE_TIMES_MAX} className="w-24" value={times} disabled={busy} onChange={(e) => setTimes(e.target.value)} />
          )}
        </div>
      </div>
      <p className="text-xs text-subtle-foreground">{t('recurrence.hint')}</p>
      {rule && !published && <p className="text-xs text-muted-foreground">{t('recurrence.waiting')}</p>}
      {post.recurrenceCount > 0 && <p className="text-xs text-muted-foreground">{t(rule ? 'recurrence.count' : 'recurrence.ended', { count: post.recurrenceCount })}</p>}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={busy || !valid} onClick={() => save.mutate()}>
          {t('recurrence.save')}
        </Button>
        {rule && (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => clear.mutate()}>
            {t('recurrence.turnOff')}
          </Button>
        )}
      </div>
      {(save.error || clear.error) && <ErrorText>{errorMessage(save.error ?? clear.error)}</ErrorText>}
    </Card>
  );
}

// When a published variant that is not public yet went to its platform, in words.
const NOT_PUBLIC_AT: Readonly<Record<string, 'sentToAppAt' | 'wordpressDraftAt' | 'wordpressPendingAt'>> = { sent_to_app: 'sentToAppAt', wordpress_draft: 'wordpressDraftAt', wordpress_pending: 'wordpressPendingAt' };

// The WordPress adapter's refusals of a category or tag (#981), by the outcome text that names it.
type WordPressTermOutcome = 'wordpressCategoryNotFound' | 'wordpressCategoryAmbiguous' | 'wordpressTagNotAllowed';
const WORDPRESS_TERM_OUTCOMES: Readonly<Record<string, WordPressTermOutcome>> = {
  WORDPRESS_CATEGORY_NOT_FOUND: 'wordpressCategoryNotFound',
  WORDPRESS_CATEGORY_AMBIGUOUS: 'wordpressCategoryAmbiguous',
  WORDPRESS_TAG_NOT_ALLOWED: 'wordpressTagNotAllowed',
};

// What happened to a variant on its way out, in words: a retry time, a pending or unknown outcome, a pause on its
// channel, a refusal with what the platform said.
function Outcome({ variant: v, slug }: { variant: Variant; slug: string }) {
  const t = useTranslations('social');
  const f = useFormat();
  const said = v.error?.message ? <p className="text-subtle-foreground [overflow-wrap:anywhere]">{t('outcome.platformSaid', { message: v.error.message })}</p> : null;
  switch (v.status) {
    case 'in_review':
      // The kept time counts only while it is ahead: past it, or with no slot left, a person schedules again.
      return v.error?.code === 'POLICY_RAISED' ? (
        <p className="text-warning">{t(v.error.action === 'reschedule' && v.effectiveAt && Date.parse(v.effectiveAt) > Date.now() ? 'outcome.policyRaisedReschedule' : 'outcome.policyRaised')}</p>
      ) : null;
    case 'scheduled':
      if (v.queuePaused) return <p className="text-warning">{t('outcome.queuePaused')}</p>;
      return v.error?.retryAt ? <p className="text-warning">{t(v.error.code === 'QUOTA_EXHAUSTED' ? 'outcome.quotaExhausted' : 'outcome.retrying', { when: f.dateTime(v.error.retryAt) })}</p> : null;
    case 'publishing':
    case 'processing':
      return <p>{t(`outcome.${v.status}`)}</p>;
    case 'ambiguous':
      return <p className="text-warning">{t('outcome.ambiguous')}</p>;
    case 'needs_attention':
      return <p className="text-warning">{t('outcome.needsAttention')}</p>;
    case 'paused':
      return (
        <div className="space-y-1">
          <p className="text-warning">
            {t(
              v.error?.code === 'CHANNEL_OWNER_LEFT'
                ? 'outcome.ownerLeft'
                : v.error?.code === 'CHANNEL_REVOKED'
                  ? 'outcome.revoked'
                  : v.error?.code === 'CHANNEL_SCOPE_MISSING'
                    ? 'outcome.scopeMissing'
                    : 'outcome.paused',
            )}
          </p>
          {v.error?.code !== 'CHANNEL_REVOKED' && (
            <Link to="/o/$slug/social/channels" params={{ slug }} className="text-link hover:underline">
              {t('reconnect')}
            </Link>
          )}
        </div>
      );
    case 'failed':
      // A draft for the TikTok app on a deployment that has not turned inbox mode on (#903).
      if (v.error?.code === 'TIKTOK_INBOX_NOT_ENABLED') return <p className="text-destructive">{t('outcome.inboxNotEnabled')}</p>;
      // A category or tag the WordPress site refused before anything was posted (#981); the message is its name.
      if (v.error?.code && v.error.code in WORDPRESS_TERM_OUTCOMES) {
        return <p className="text-destructive [overflow-wrap:anywhere]">{t(`outcome.${WORDPRESS_TERM_OUTCOMES[v.error.code] as WordPressTermOutcome}`, { name: v.error.message ?? '' })}</p>;
      }
      // Kept by the org's publishing hold until more than an hour past its time (#946): nothing was sent.
      if (v.error?.code === 'HELD_TOO_LONG') return <p className="text-warning">{t('outcome.heldTooLong')}</p>;
      // TikTok refused an inbox upload for the missing video.upload grant (#903): a reconnect fixes it.
      if (v.error?.code === 'CHANNEL_SCOPE_MISSING') {
        return (
          <div className="space-y-1">
            <p className="text-destructive">{t('outcome.scopeMissingFailed')}</p>
            <Link to="/o/$slug/social/channels" params={{ slug }} className="text-link hover:underline">
              {t('reconnect')}
            </Link>
          </div>
        );
      }
      return (
        <div className="space-y-1">
          <p className="text-destructive">{t('outcome.failed')}</p>
          {said}
        </div>
      );
    case 'published':
      // A draft sent to the TikTok app (#903): not public until the account posts it there.
      if (v.error?.code === SENT_TO_APP) return <p className="text-warning">{t('outcome.sentToApp')}</p>;
      // A draft or a post pending review on the WordPress site (#981): not public until someone publishes it there.
      if (v.error?.code === WORDPRESS_DRAFT || v.error?.code === WORDPRESS_PENDING) return <p className="text-warning">{t(v.error.code === WORDPRESS_DRAFT ? 'outcome.wordpressDraft' : 'outcome.wordpressPending')}</p>;
      return null;
    default:
      return null;
  }
}

// Takes a published channel down from its platform (#860), after a confirmation with an optional reason. again: an
// earlier ask failed or its outcome is unclear.
function RemoveFromChannel({ variantId, channel, again, onDone }: { variantId: string; channel: string; again: boolean; onDone: () => void }) {
  const t = useTranslations('social');
  const id = useId();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const remove = useMutation({
    mutationFn: () => client.social.variants.remove({ variantId, ...(reason.trim() ? { reason: reason.trim() } : {}) }),
    onSuccess: () => {
      setOpen(false);
      setReason('');
      onDone();
    },
  });
  if (!open) {
    return (
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        {t(again ? 'remove.retry' : 'remove.action')}
      </Button>
    );
  }
  return (
    <div className="w-full space-y-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3">
      <p className="text-sm text-foreground">{t('remove.confirm', { channel })}</p>
      <Label htmlFor={`${id}-reason`}>{t('remove.reason')}</Label>
      <Textarea id={`${id}-reason`} rows={2} maxLength={500} value={reason} placeholder={t('remove.reasonHint')} onChange={(e) => setReason(e.target.value)} />
      <div className="flex flex-wrap gap-2">
        <Button variant="destructive" size="sm" disabled={remove.isPending} onClick={() => remove.mutate()}>
          {t('remove.submit')}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
          {t('keep')}
        </Button>
      </div>
      {remove.error && <ErrorText>{errorMessage(remove.error)}</ErrorText>}
    </div>
  );
}

// A channel removed from its platform (#860): when, by whom and why; or where a removal someone asked for stands.
function RemovalNote({ variant: v }: { variant: Variant }) {
  const t = useTranslations('social');
  const f = useFormat();
  const org = useQuery(orpc.org.get.queryOptions());
  if (v.status === 'removed' && v.removedAt) {
    const member = v.removedBy ? org.data?.members.find((m) => m.userId === v.removedBy) : undefined;
    const name = member ? (member.displayName ?? member.email) : null;
    return (
      <div className="space-y-1">
        <p>{name ? t('remove.removedBy', { when: f.dateTime(v.removedAt), name }) : t('remove.removedAt', { when: f.dateTime(v.removedAt) })}</p>
        {v.removeReason && <p className="text-subtle-foreground [overflow-wrap:anywhere]">{t('remove.reasonWas', { reason: v.removeReason })}</p>}
      </div>
    );
  }
  if (!v.removal) {
    // A takedown set for later (#861), on a channel that went out before it: the worker asks for it when it comes.
    const planned = v.status === 'published' && isProvider(v.provider) && REMOVE_READY.has(v.provider) ? removeAtOf(v.settings) : null;
    // One that no longer fits the time the post went out stays up, as the worker's sweep decides.
    if (planned === null || planned === 'invalid' || !v.publishedAt || removeAtFit(v.provider, v.settings, new Date(v.publishedAt)) !== null) return null;
    return <p>{t('remove.planned', { when: f.dateTime(planned) })}</p>;
  }
  const known = v.removal.code === 'TELEGRAM_CANNOT_DELETE' || v.removal.code === 'REMOVE_NOT_RUN' ? v.removal.code : null;
  return (
    <div className="space-y-1">
      <p className={v.removal.state === 'pending' ? '' : 'text-warning'}>{t(`remove.${v.removal.state}`)}</p>
      {known ? <p className="text-subtle-foreground">{t(`remove.code.${known}`)}</p> : v.removal.state === 'failed' && v.removal.code ? <p className="font-mono text-subtle-foreground">{v.removal.code}</p> : null}
    </div>
  );
}

// Another time for a scheduled channel, its approvals kept (#580): the calendar's drag, from the keyboard.
function MoveTime({ variantId, connectionId, timeZone, at, onDone }: { variantId: string; connectionId: string; timeZone: string; at: string | null; onDone: () => void }) {
  const t = useTranslations('social');
  const [open, setOpen] = useState(false);
  const [when, setWhen] = useState(() => toLocalInput(at ?? new Date(Date.now() + 3_600_000).toISOString()));
  const move = useMutation({
    mutationFn: () => client.social.variants.reschedule({ variantId, at: fromLocalInput(when) as string }),
    onSuccess: () => {
      setOpen(false);
      onDone();
    },
  });
  if (!open) {
    return (
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          // From the time it has now (a drag in the calendar or another tab may have moved it).
          setWhen(toLocalInput(at ?? new Date(Date.now() + 3_600_000).toISOString()));
          setOpen(true);
        }}
      >
        {t('moveTime')}
      </Button>
    );
  }
  return (
    <span className="flex flex-wrap items-center gap-2">
      <Input type="datetime-local" aria-label={t('moveTime')} value={when} min={toLocalInput(new Date().toISOString())} onChange={(e) => setWhen(e.target.value)} className="h-8 max-w-56" />
      <BestTimeButton connectionId={connectionId} timeZone={timeZone} exceptVariantId={variantId} disabled={move.isPending} onPick={(next) => setWhen(toLocalInput(next))} />
      <Button size="sm" disabled={move.isPending || !fromLocalInput(when)} onClick={() => move.mutate()}>
        {t('moveTimeSave')}
      </Button>
      <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
        {t('keep')}
      </Button>
      {move.error && <ErrorText>{errorMessage(move.error)}</ErrorText>}
    </span>
  );
}

// A channel waiting in its queue goes first (#1020): it takes the earliest slot it may use and the posts it passes move
// one place later. Sent with the slot time shown, so a queue changed meanwhile is refused rather than reordered blind.
function MoveToFront({ variantId, queueSlotAt, onDone }: { variantId: string; queueSlotAt: string; onDone: () => void }) {
  const t = useTranslations('social');
  const move = useMutation({
    mutationFn: () => client.social.queues.moveToFront({ variantId, expectedAt: queueSlotAt }),
    onSuccess: onDone,
  });
  return (
    <>
      <Button variant="outline" size="sm" disabled={move.isPending} onClick={() => move.mutate()}>
        {t('moveToFront')}
      </Button>
      {move.data && move.data.moved.length === 0 && <span role="status">{t('alreadyFront')}</span>}
      {move.error && <ErrorText>{errorMessage(move.error)}</ErrorText>}
    </>
  );
}

const POST_METRICS = ['reach', 'impressions', 'views', 'reactions', 'comments', 'shares', 'saves', 'clicks'] as const;

// A published channel's latest counts, as the platform reported them; a count it does not report is left out.
function VariantMetrics({ row }: { row: { metrics: Record<string, number>; capturedAt: string | null } | undefined }) {
  const t = useTranslations('social');
  const f = useFormat();
  if (!row?.capturedAt) return <p className="text-subtle-foreground">{t('metricsNotYet')}</p>;
  const shown = POST_METRICS.filter((m) => row.metrics[m] !== undefined);
  if (shown.length === 0) return <p className="text-subtle-foreground">{t('metricsNone', { when: f.dateTime(row.capturedAt) })}</p>;
  return (
    <div className="space-y-1">
      <dl className="flex flex-wrap gap-x-4 gap-y-1">
        {shown.map((m) => (
          <div key={m} className="flex gap-1">
            <dt>{t(`metric.${m}`)}</dt>
            <dd className="font-medium text-foreground tabular-nums">{f.number(row.metrics[m] ?? 0)}</dd>
          </div>
        ))}
      </dl>
      <p className="text-subtle-foreground">{t('metricsAt', { when: f.dateTime(row.capturedAt) })}</p>
    </div>
  );
}

// Each post gets fresh page state: the route keeps the page mounted when it opens another post (a repost, its source).
export function SocialPostPage() {
  const { slug, id: postId } = useParams({ strict: false }) as { slug: string; id: string };
  return <PostScreen key={postId} slug={slug} postId={postId} />;
}

// What the post screen keeps of unsaved edits (#634).
type PostDraft = { base: Base; own: Record<string, Own> };

function PostScreen({ slug, postId }: { slug: string; postId: string }) {
  const t = useTranslations('social');
  const f = useFormat();
  const { canDecide, canWrite, userId } = useRole(slug);
  const navigate = useNavigate();
  const post = useQuery(orpc.social.posts.get.queryOptions({ input: { postId } }));
  // The latest counts of each published channel (#578).
  const metrics = useQuery({ ...orpc.social.metrics.summary.queryOptions({ input: { postId } }), enabled: post.data?.variants.some((v) => v.status === 'published') ?? false });
  const channels = useQuery(orpc.channels.list.queryOptions({ input: { includeRevoked: true } }));
  const names = useMemo(() => new Map((channels.data ?? []).map((c: Channel) => [c.id, c.displayName])), [channels.data]);
  const grants = useMemo(() => new Map((channels.data ?? []).map((c: Channel) => [c.id, c.scopes])), [channels.data]);
  const [base, setBase] = useState<Base | null>(null);
  const [own, setOwn] = useState<Record<string, Own>>({});
  // The post's UTM tags as the screen shows them; changing them changes every editable channel's settings (#585).
  const [utm, setUtmState] = useState<UtmTags | null | undefined>(undefined);
  // An AI rewrite was taken into the text (#583): the next save marks the post AI-assisted.
  const [aiUsed, setAiUsed] = useState(false);
  // The server content the edits started from. A status change elsewhere (a teammate approving another channel, the
  // publisher) keeps the edits; a content change elsewhere replaces them only when there are none, else it says so.
  const [origin, setOrigin] = useState<Post | null>(null);
  const [stale, setStale] = useState(false);
  const [flash] = useState(takeFlash);
  const adopt = (p: Post, keepOwn = false) => {
    setOrigin(p);
    setBase(baseOf(p));
    if (!keepOwn) {
      setOwn(Object.fromEntries(p.variants.map((v) => [v.id, ownOf(v)])));
      // The tags shown follow the channels again.
      setUtmState(undefined);
    }
    setStale(false);
  };
  const editsOf = (o: Post) =>
    base !== null &&
    (JSON.stringify(base) !== JSON.stringify(baseOf(o)) ||
      o.variants.some((v) => EDITABLE.includes(v.status) && own[v.id] !== undefined && !sameOwn(own[v.id] as Own, ownOf(v))));
  useEffect(() => {
    const p = post.data;
    if (!p) return;
    if (!origin) {
      adopt(p);
      // Edits left unsaved on this revision are offered back; edits of an older revision are dropped.
      const kept = loadDraft<PostDraft>(slug, postId);
      if (kept && kept.revision === p.revision) setRestorePost(kept);
      else if (kept) clearDraft(slug, postId);
    } else if (contentKey(p) === contentKey(origin)) setOrigin(p);
    else if (!editsOf(origin)) adopt(p);
    else setStale(true);
  }, [post.data]); // eslint-disable-line react-hooks/exhaustive-deps

  // Unsaved edits are kept in this browser for this revision as they are made (#634); leaving asks first.
  const [restorePost, setRestorePost] = useState<StoredDraft<PostDraft> | null>(null);
  const editing = origin !== null && editsOf(origin);
  useEffect(() => {
    if (!origin || restorePost) return;
    const timer = setTimeout(() => (editing && base ? saveDraft<PostDraft>(slug, postId, origin.revision, { base, own }) : clearDraft(slug, postId)), 400);
    return () => clearTimeout(timer);
  }, [base, own, origin, editing, restorePost, slug, postId]);
  useBlocker({ shouldBlockFn: () => editing && !window.confirm(t('leaveConfirm')), enableBeforeUnload: () => editing });

  const refresh = () => void queryClient.invalidateQueries();
  // After this page's own save: read the post once and take it as the new starting point here, rather than waiting
  // for a refetch to notice (a refetch identical to the cache never fires the effect above).
  const settle = async (keepOwn: boolean) => {
    const p = await client.social.posts.get({ postId });
    queryClient.setQueryData(orpc.social.posts.get.queryOptions({ input: { postId } }).queryKey, p);
    adopt(p, keepOwn);
  };
  const save = useMutation({
    mutationFn: async () => {
      if (!origin || !base) return;
      const before = baseOf(origin);
      const mediaChanged = JSON.stringify(mediaInput(base.media)) !== JSON.stringify(mediaInput(before.media));
      const baseChanged = base.body !== before.body || base.title !== before.title || base.linkUrl !== before.linkUrl || mediaChanged;
      let baseSaved = false;
      try {
        if (baseChanged) {
          await client.social.posts.update({
            postId,
            revision: origin.revision,
            body: base.body,
            title: orNull(base.title),
            linkUrl: orNull(base.linkUrl),
            ...(mediaChanged ? { media: mediaInput(base.media) } : {}),
            ...(aiUsed ? { aiAssisted: true as const } : {}),
          });
          baseSaved = true;
        }
        // Base edits move the inheriting variants' revisions: read them again before saving overrides.
        const fresh = await client.social.posts.get({ postId });
        for (const v of fresh.variants) {
          const mine = own[v.id];
          // Only what was edited here: a channel left as it was loaded keeps what another tab may have saved since.
          const loaded = origin.variants.find((ov) => ov.id === v.id);
          if (!mine || (loaded && sameOwn(mine, ownOf(loaded))) || sameOwn(mine, ownOf(v)) || !EDITABLE.includes(v.status)) continue;
          await client.social.variants.update({
            variantId: v.id,
            revision: v.revision,
            body: mine.custom ? mine.body : null,
            title: mine.custom ? orNull(mine.title) : null,
            ...(sameSettings(mine.settings, v.settings) ? {} : { settings: mine.settings as Record<string, string | boolean> }),
            ...(aiUsed ? { aiAssisted: true as const } : {}),
            ...(mine.customMedia === v.ownMedia && (!mine.customMedia || sameMediaList(mine.media, mediaItems(v.media))) ? {} : { media: mine.customMedia ? mediaInput(mine.media) : null }),
          });
        }
      } catch (error) {
        // A save that failed part way: take what went in (the shared text, some channels) and keep the channel edits
        // not saved yet. Shared text that did not go in stays as typed, so the server's is not taken over it.
        if (baseSaved || !baseChanged) await settle(true).catch(() => undefined);
        throw error;
      }
      await settle(false);
    },
    onSettled: refresh,
  });
  const submit = useMutation({ mutationFn: () => client.social.posts.submit({ postId }), onSuccess: refresh });
  // A repost opens as a new draft for the same channels.
  const repost = useMutation({
    mutationFn: () => client.social.posts.repost({ postId }),
    onSuccess: (made) => {
      refresh();
      void navigate({ to: '/o/$slug/social/$id', params: { slug, id: made.postId } });
    },
  });
  // A copy of the post as a new draft, opened at once.
  const duplicate = useMutation({
    mutationFn: () => client.social.posts.duplicate({ postId }),
    onSuccess: (made) => {
      refresh();
      void navigate({ to: '/o/$slug/social/$id', params: { slug, id: made.postId } });
    },
  });
  const unschedule = useMutation({ mutationFn: (variantId: string) => client.social.variants.unschedule({ variantIds: [variantId] }), onSuccess: refresh });
  // The first comment again (#587); the worker posts it in a moment.
  const retryComment = useMutation({ mutationFn: (variantId: string) => client.social.variants.retryComment({ variantId }), onSuccess: refresh });
  const retryThread = useMutation({ mutationFn: (variantId: string) => client.social.variants.retryThread({ variantId }), onSuccess: refresh });
  const cancel = useMutation({ mutationFn: (variantId: string) => client.social.variants.cancel({ variantIds: [variantId] }), onSuccess: refresh });
  const retry = useMutation({ mutationFn: (variantId: string) => client.social.variants.retry({ variantIds: [variantId] }), onSuccess: refresh });
  const resolve = useMutation({
    mutationFn: (args: { variantId: string; outcome: 'published' | 'dropped' }) => client.social.variants.resolve({ variantIds: [args.variantId], outcome: args.outcome }),
    onSuccess: refresh,
  });

  if (post.isLoading || !base || !origin) return post.error ? <ErrorText>{errorMessage(post.error)}</ErrorText> : <Spinner />;
  if (!post.data) return null;
  const p = post.data;
  // The tags the channels still to go out carry; a published channel keeps the tags it went out with.
  const firstUtm = p.variants.filter((v) => EDITABLE.includes(v.status)).map((v) => utmOf(v.settings)).find((u) => u !== null) ?? null;
  const shownUtm = utm === undefined ? (firstUtm ? { campaign: firstUtm.campaign, medium: firstUtm.medium ?? 'social' } : null) : utm;
  const setUtm = (next: UtmTags | null) => {
    setUtmState(next);
    const changed = { ...own };
    for (const v of p.variants) if (EDITABLE.includes(v.status)) changed[v.id] = withUtm(own[v.id] ?? ownOf(v), next);
    setOwn(changed);
  };
  // The same takedown time (#861) for every channel still to go out that can take one.
  const setRemoveAtAll = (removeAt: string) => {
    const changed = { ...own };
    for (const v of p.variants) {
      const mine = own[v.id] ?? ownOf(v);
      if (EDITABLE.includes(v.status) && isProvider(v.provider) && REMOVE_READY.has(v.provider) && postTypeOf(mine.settings) !== 'story') changed[v.id] = { ...mine, settings: { ...mine.settings, removeAt } };
    }
    setOwn(changed);
  };
  const dirty = editsOf(origin);
  const editable = canWrite && p.variants.some((v) => EDITABLE.includes(v.status));
  const submittable = p.variants.filter((v) => SUBMITTABLE.includes(v.status));
  const onKey = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 's' && dirty && !save.isPending) {
      e.preventDefault();
      save.mutate();
    }
  };
  const published = p.variants.some((v) => v.status === 'published');
  const metricsOf = new Map((metrics.data ?? []).map((r) => [r.variantId, r]));
  const error = save.error ?? submit.error ?? retryComment.error ?? retryThread.error ?? repost.error ?? duplicate.error ?? unschedule.error ?? cancel.error ?? retry.error ?? resolve.error;
  const reviewable = !dirty && !stale;

  return (
    <div onKeyDown={onKey}>
      <PageHeader
        title={t('postTitle')}
        subtitle={t('postSubtitle', { updated: f.dateTime(p.updatedAt) })}
        actions={
          <>
            <Link to="/o/$slug/social" params={{ slug }} className="inline-flex h-9 items-center px-2.5 text-sm text-muted-foreground hover:text-foreground">
              {t('back')}
            </Link>
            {editable && (
              <Button variant="outline" size="lg" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
                {save.isPending ? <Spinner className="text-current" /> : null}
                {t('save')}
              </Button>
            )}
            {canWrite && submittable.length > 0 && (
              <Button size="lg" disabled={dirty || submit.isPending} title={dirty ? t('saveFirst') : undefined} onClick={() => submit.mutate()}>
                {t('submit')}
              </Button>
            )}
            {canWrite && published && (
              <Button variant="outline" size="lg" disabled={dirty || repost.isPending} title={t('repostHint')} onClick={() => repost.mutate()}>
                {repost.isPending ? <Spinner className="text-current" /> : null}
                {t('repost')}
              </Button>
            )}
            {canWrite && (
              <Button variant="outline" size="lg" disabled={dirty || duplicate.isPending} title={dirty ? t('saveFirst') : t('duplicateHint')} onClick={() => duplicate.mutate()}>
                {duplicate.isPending ? <Spinner className="text-current" /> : null}
                {t('duplicate')}
              </Button>
            )}
          </>
        }
      />
      {restorePost && (
        <Notice>
          <div className="flex flex-wrap items-center gap-2">
            <span>{t('draftFound', { when: f.dateTime(restorePost.savedAt) })}</span>
            <Button
              size="sm"
              onClick={() => {
                setBase(restorePost.data.base);
                setOwn(restorePost.data.own);
                setRestorePost(null);
              }}
            >
              {t('draftRestore')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                clearDraft(slug, postId);
                setRestorePost(null);
              }}
            >
              {t('draftDiscard')}
            </Button>
          </div>
        </Notice>
      )}
      {(error || flash) && (
        <div className="mb-4">
          <ErrorText>{error ? errorMessage(error) : flash}</ErrorText>
        </div>
      )}
      {(p.origin === 'ai' || p.tainted) && (
        <div className="mb-4 flex items-center gap-2 rounded-xl border bg-muted px-4 py-3 text-sm text-foreground">
          <Badge variant="secondary">{t(p.origin === 'ai' ? 'aiBadge' : 'aiAssistedBadge')}</Badge>
          <span>{t(p.origin === 'ai' ? 'aiBadgeHint' : 'aiAssistedHint')}</span>
        </div>
      )}
      {p.idea && (
        <div className="mb-4 rounded-xl border bg-muted px-4 py-3 text-sm text-foreground">
          {t('ideas.madeFrom')}{' '}
          <Link to="/o/$slug/social/ideas" params={{ slug }} className="text-link hover:underline">
            {p.idea.title}
          </Link>
        </div>
      )}
      {p.recurrenceSourceId ? (
        <div className="mb-4 rounded-xl border bg-muted px-4 py-3 text-sm text-foreground">
          {t('recurrence.copyOf')}{' '}
          <Link to="/o/$slug/social/$id" params={{ slug, id: p.recurrenceSourceId }} className="text-link hover:underline">
            {t('recurrence.copyOfLink')}
          </Link>
        </div>
      ) : (
        p.repostOf && (
          <div className="mb-4 rounded-xl border bg-muted px-4 py-3 text-sm text-foreground">
            {t('repostOf')}{' '}
            <Link to="/o/$slug/social/$id" params={{ slug, id: p.repostOf }} className="text-link hover:underline">
              {t('repostOfLink')}
            </Link>
          </div>
        )
      )}
      {stale && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-sm text-foreground">
          <span>{t('changedElsewhere')}</span>
          <Button variant="outline" size="sm" onClick={() => adopt(p)}>
            {t('loadLatest')}
          </Button>
        </div>
      )}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="space-y-4">
          <SharedFields
            base={base}
            onChange={setBase}
            disabled={!editable || save.isPending}
            needsTitle={p.variants.some((v) => hasTitle(v.provider))}
            onAiUsed={() => setAiUsed(true)}
            slug={slug}
            connectionIds={p.variants.map((v) => v.connectionId)}
          />
          {base.linkUrl.trim() && editable && (
            <Card className="block p-4">
              <UtmFields utm={shownUtm} onChange={setUtm} disabled={save.isPending} />
            </Card>
          )}
          {canDecide && reviewable && <ReviewPanel post={p} names={names} onDone={refresh} />}
          {canDecide && reviewable && <SchedulePanel post={p} names={names} onDone={refresh} />}
          <LabelPicker slug={slug} postId={p.id} labelIds={p.labelIds} canWrite={canWrite} />
          {canWrite && p.recurrence === null && (published || p.evergreenDays !== null) && <EvergreenPanel post={p} onDone={refresh} />}
          {/* One kind of repeat per post (#979); a copy of a series repeats with its series post. */}
          {canWrite && p.evergreenDays === null && p.recurrenceSourceId === null && (
            <RecurrencePanel key={`${JSON.stringify(p.recurrence)}:${p.recurrenceCount}`} post={p} published={published} onDone={refresh} />
          )}
            <ReviewLinks postId={p.id} canDecide={canDecide} />
            <AssignCard post={p} canEdit={canDecide || (canWrite && p.authorUserId !== null && p.authorUserId === userId)} />
          <PostVersions
            postId={p.id}
            revision={p.revision}
            variantRevisions={Object.fromEntries(p.variants.map((v) => [v.id, v.revision]))}
            current={p.variants.map((v) => ({
              variantId: v.id,
              name: names.get(v.connectionId) ?? providerName(v.provider),
              status: v.status,
              content: { body: v.effective.body, title: v.effective.title, linkUrl: v.effective.linkUrl, media: v.media.map((m) => ({ fileId: m.fileId, altText: m.altText, mime: m.mime })), settings: v.settings },
            }))}
            canWrite={canWrite}
            editing={editing}
            onRestored={() => void settle(false).finally(refresh)}
          />
          {dirty && <p className="text-xs text-subtle-foreground">{t('unsaved')}</p>}
        </div>
        <div className="space-y-4">
          {p.variants.map((v) => {
            const frozen = !EDITABLE.includes(v.status);
            const decision = v.latestDecision;
            return (
              <ChannelEditor
                slug={slug}
                key={v.id}
                provider={v.provider}
                channel={names.get(v.connectionId) ?? providerName(v.provider)}
                // A channel's own link (set on the variant) is the one its adapter sends, so its checks count that one.
                base={frozen ? { body: v.effective.body, title: v.effective.title ?? '', linkUrl: v.effective.linkUrl ?? '', media: mediaItems(v.media) } : v.overrides.linkUrl != null ? { ...base, linkUrl: v.overrides.linkUrl } : base}
                // A frozen channel keeps its settings (its cover, first comment, UTM) to show what went out.
                own={frozen ? { ...EMPTY_OWN, settings: v.settings } : (own[v.id] ?? ownOf(v))}
                connectionId={v.connectionId}
                scopes={grants.get(v.connectionId) ?? []}
                onAiUsed={() => setAiUsed(true)}
                disabled={frozen || !canWrite || save.isPending}
                status={v.status}
                statusError={v.error}
                onChange={(next) => setOwn({ ...own, [v.id]: next })}
                onRemoveAtAll={!frozen && p.variants.filter((x) => EDITABLE.includes(x.status)).length > 1 ? setRemoveAtAll : undefined}
                footer={
                  <div className="space-y-2 border-t pt-3 text-xs text-muted-foreground">
                    {v.effectiveAt && ['scheduled', 'paused', 'publishing', 'processing', 'published'].includes(v.status) && (
                      <p>{t(NOT_PUBLIC_AT[notPublicKey(v) ?? ''] ?? (v.status === 'published' ? 'publishedAt' : 'goesOutAt'), { when: f.dateTime(v.effectiveAt) })}{v.queueSlotAt && v.status !== 'published' ? ` · ${t('fromQueue')}` : ''}</p>
                    )}
                    {decision && decision.comment && ['changes_requested', 'rejected'].includes(v.status) && <p className="text-warning">{t('reviewerSaid', { comment: decision.comment })}</p>}
                    {v.status === 'in_review' && v.review.required > 1 && <p>{t('reviewSteps', { given: String(v.review.approvedBy.length), required: String(v.review.required) })}</p>}
                    {v.status === 'in_review' && v.review.client && <p>{t(v.review.clientVerdict === 'approved' ? 'clientApproved' : 'clientWaiting')}</p>}
                    <Outcome variant={v} slug={slug} />
                    <RemovalNote variant={v} />
                    {v.externalUrl && v.status !== 'removed' && (
                      <a href={v.externalUrl} target="_blank" rel="noopener noreferrer" className="text-link hover:underline">
                        {t('openPost')}
                      </a>
                    )}
                    {v.commentStatus && (
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={v.commentStatus === 'failed' || v.commentStatus === 'reconnect' || v.commentStatus === 'unknown' ? 'text-warning' : ''}>{t(`commentStatus.${v.commentStatus}`)}</span>
                        {canDecide && (v.commentStatus === 'failed' || v.commentStatus === 'reconnect' || v.commentStatus === 'unknown') && (
                          <Button variant="outline" size="sm" disabled={retryComment.isPending} onClick={() => retryComment.mutate(v.id)}>
                            {t('commentRetry')}
                          </Button>
                        )}
                      </div>
                    )}
                    {v.pinStatus && <p className={v.pinStatus === 'failed' || v.pinStatus === 'not_allowed' || v.pinStatus === 'unknown' ? 'text-warning' : ''}>{t(`pinStatus.${v.pinStatus}`)}</p>}
                    {v.playlistStatus && (
                      <p className={v.playlistStatus.state === 'pending' || v.playlistStatus.state === 'added' ? '' : 'text-warning'}>
                        {t(`playlistStatus.${v.playlistStatus.state}`, { added: v.playlistStatus.added, total: v.playlistStatus.total })}
                      </p>
                    )}
                    {v.threadStatus && (
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={v.threadStatus.state === 'failed' || v.threadStatus.state === 'unknown' ? 'text-warning' : ''}>
                          {t(`threadStatus.${v.threadStatus.state}`, { posted: v.threadStatus.posted, total: v.threadStatus.total })}
                        </span>
                        {canDecide && (v.threadStatus.state === 'failed' || v.threadStatus.state === 'unknown') && (
                          <Button variant="outline" size="sm" disabled={retryThread.isPending} onClick={() => retryThread.mutate(v.id)}>
                            {t('threadRetry')}
                          </Button>
                        )}
                      </div>
                    )}
                    {v.status === 'published' && <VariantMetrics row={metricsOf.get(v.id)} />}
                    <div className="flex flex-wrap gap-2">
                      {canDecide && (v.status === 'failed' || v.status === 'needs_attention') && (
                        <Button variant="outline" size="sm" disabled={retry.isPending} onClick={() => retry.mutate(v.id)}>
                          {t(v.status === 'failed' ? 'retry' : 'retryUnknown')}
                        </Button>
                      )}
                      {canDecide && v.status === 'needs_attention' && (
                        <>
                          <Button variant="outline" size="sm" disabled={resolve.isPending} onClick={() => resolve.mutate({ variantId: v.id, outcome: 'published' })}>
                            {t('confirmPublished')}
                          </Button>
                          <Button variant="ghost" size="sm" disabled={resolve.isPending} onClick={() => resolve.mutate({ variantId: v.id, outcome: 'dropped' })}>
                            {t('dropChannel')}
                          </Button>
                        </>
                      )}
                      {canDecide && v.status === 'scheduled' && !v.queuePaused && <MoveTime variantId={v.id} connectionId={v.connectionId} timeZone={p.timeZone} at={v.effectiveAt} onDone={refresh} />}
                      {canDecide && canMoveToFront(v) && <MoveToFront variantId={v.id} queueSlotAt={v.queueSlotAt as string} onDone={refresh} />}
                      {canDecide && ['scheduled', 'paused'].includes(v.status) && (
                        <Button variant="outline" size="sm" disabled={unschedule.isPending} onClick={() => unschedule.mutate(v.id)}>
                          {t('unschedule')}
                        </Button>
                      )}
                      {canDecide && v.status === 'published' && isProvider(v.provider) && REMOVE_READY.has(v.provider) && v.removal?.state !== 'pending' && (
                        <RemoveFromChannel variantId={v.id} channel={names.get(v.connectionId) ?? providerName(v.provider)} again={v.removal !== null} onDone={refresh} />
                      )}
                      {canWrite && CANCELLABLE.includes(v.status) && (canDecide || !['approved', 'scheduled', 'paused'].includes(v.status)) && (
                        <Button variant="ghost" size="sm" disabled={cancel.isPending} onClick={() => cancel.mutate(v.id)}>
                          {t('cancelChannel')}
                        </Button>
                      )}
                    </div>
                  </div>
                }
              />
            );
          })}
        </div>
        <PostActivity postId={p.id} channels={p.variants.map((v) => ({ variantId: v.id, name: names.get(v.connectionId) ?? providerName(v.provider) }))} canWrite={canWrite} className="lg:col-span-2" />
      </div>
    </div>
  );
}
