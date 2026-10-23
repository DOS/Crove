// The composer's preview of a channel (#588): the post laid out the way its platform shows it in the feed, with the
// text cut where the platform cuts it, images in its frame and a link card where it makes one.
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { isProvider, LINK_PLACEMENT, sentText, type Cover } from '@crove/mod-social/contract';
import { useFormatter, useTranslations } from 'use-intl';
import { cn } from '@crove/ui/lib/utils';
import { Thumb, type MediaItem } from './social-media.tsx';
import { client } from '../lib/api.ts';
import { previewRule, previewText } from '../lib/social-preview.ts';
import { hasTitle, providerName } from '../lib/social.ts';

export interface PreviewContent {
  body: string;
  title: string;
  linkUrl: string;
  media: readonly MediaItem[];
  // A video's cover (#642): a frame of it, or an image shown in its place.
  cover?: Cover | null;
  // The channel's post type (#644): a Story shows only its image or video, in a phone frame.
  postType?: string;
  // A poll's options and a Threads topic tag (#711, #948, #1118); the poll's length in minutes where it has one.
  poll?: readonly string[];
  pollMinutes?: number;
  // A LinkedIn poll's own question; voters may pick several options; counts hidden until the end (#1118).
  pollQuestion?: string;
  pollMultiple?: boolean;
  pollHideTotals?: boolean;
  topicTag?: string;
  // Who may reply to an X or Threads post, when not everyone (#948, #983).
  replySettings?: 'following' | 'mentionedUsers' | 'followers';
  // Who may reply to a Bluesky post when not everyone (#1102): nobody, or one or several groups; and quotes off.
  replyRules?: 'nobody' | readonly ('mentionedUsers' | 'following' | 'followers')[];
  quotesOff?: boolean;
  // Who sees a LinkedIn post, when not anyone (#983).
  visibility?: 'connections' | 'loggedIn';
  // The link buttons under a Telegram post (#1017), in rows.
  buttons?: readonly (readonly { text: string; url: string }[])[];
}

// A poll's length as X shows it under the options: days, else hours, else minutes.
function pollLength(minutes: number): { unit: 'days' | 'hours' | 'minutes'; n: number } {
  if (minutes % 1440 === 0) return { unit: 'days', n: minutes / 1440 };
  if (minutes % 60 === 0) return { unit: 'hours', n: minutes / 60 };
  return { unit: 'minutes', n: minutes };
}

function hostOf(link: string): string {
  try {
    return link ? new URL(link).host : '';
  } catch {
    return '';
  }
}

function Media({ media, layout, max, cover }: { media: readonly MediaItem[]; layout: string; max: number; cover?: Cover | null | undefined }) {
  const t = useTranslations('social');
  if (media.length === 0) return null;
  const alt = (m: MediaItem, i: number) => m.altText?.trim() || t('imageAlt', { n: String(i + 1) });
  if (layout === 'vertical' || layout === 'video' || layout === 'square' || layout === 'article') {
    const first = media[0] as MediaItem;
    const frame = layout === 'vertical' ? 'aspect-[9/16] max-h-96' : layout === 'video' ? 'aspect-video' : layout === 'square' ? 'aspect-square' : 'aspect-[16/9]';
    // One video with a cover shows the cover, as the feed does before the video plays.
    const covered = media.length === 1 && first.mime.startsWith('video/') ? cover : null;
    return (
      <div className="relative mt-3">
        {covered && 'fileId' in covered ? (
          <Thumb fileId={covered.fileId} alt={t('coverImageAlt')} mime="image/jpeg" className={cn(frame, 'mx-auto w-full')} />
        ) : (
          <Thumb fileId={first.fileId} alt={alt(first, 0)} mime={first.mime} durationMs={first.durationMs} frameMs={covered?.atMs} className={cn(frame, 'mx-auto w-full')} />
        )}
        {media.length > 1 && (
          <span className="absolute top-2 right-2 rounded-full bg-background/80 px-2 text-xs text-foreground tabular-nums" aria-label={t('previewCount', { count: media.length })}>
            1/{media.length}
          </span>
        )}
      </div>
    );
  }
  const shown = media.slice(0, max);
  return (
    <div className={cn('mt-3 grid gap-1', shown.length === 1 ? 'grid-cols-1' : 'grid-cols-2')}>
      {shown.map((m, i) => (
        <div key={m.fileId} className={cn('relative', shown.length === 3 && i === 0 && 'row-span-2')}>
          <Thumb fileId={m.fileId} alt={alt(m, i)} mime={m.mime} durationMs={m.durationMs} className={shown.length === 1 ? 'aspect-[4/3]' : shown.length === 3 && i === 0 ? 'h-full' : 'aspect-square'} />
          {i === shown.length - 1 && media.length > shown.length && (
            <span className="absolute inset-0 flex items-center justify-center rounded-lg bg-background/70 text-lg font-semibold text-foreground">+{media.length - shown.length}</span>
          )}
        </div>
      ))}
    </div>
  );
}

// The page's own title and description for a link card (#641), read by the worker; the platform shows its card from
// the same tags. Asked for once per link (after typing stops), then read until the worker answers.
function useLinkPreview(url: string, enabled: boolean) {
  const [settled, setSettled] = useState(url);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(url), 800);
    return () => clearTimeout(timer);
  }, [url]);
  const on = enabled && settled === url && /^https?:\/\//i.test(url);
  const asked = useQuery({ queryKey: ['social-link-preview', 'request', url], queryFn: () => client.social.linkPreviews.request({ url }), enabled: on, staleTime: 10 * 60_000, retry: false });
  const waiting = asked.data?.status === 'pending';
  const read = useQuery({
    queryKey: ['social-link-preview', 'get', url],
    queryFn: () => client.social.linkPreviews.get({ url }),
    enabled: on && waiting,
    retry: false,
    // About half a minute, then the card keeps the host only.
    refetchInterval: (q) => (q.state.data?.status !== 'pending' && q.state.dataUpdateCount > 0) || q.state.dataUpdateCount >= 20 ? false : 1500,
  });
  const latest = read.data ?? asked.data;
  return latest?.status === 'ready' ? latest : null;
}

export function PlatformPreview({ channel, provider, content, readLink = false }: { channel: string; provider: string; content: PreviewContent; readLink?: boolean }) {
  const t = useTranslations('social');
  const format = useFormatter();
  const rule = previewRule(provider);
  const [open, setOpen] = useState(false);
  // Who may reply to a Bluesky post (#1102): one group as X and Threads say it, several joined as the locale lists them.
  const replyRulesLine = (rules: NonNullable<PreviewContent['replyRules']>) => {
    if (rules === 'nobody') return t('previewReplySettings.nobody');
    const [only] = rules;
    if (rules.length === 1 && only) return t(`previewReplySettings.${only}`);
    return t('previewReplyRules', { who: format.list(rules.map((r) => t(`previewReplyWho.${r}`)), { type: 'conjunction' }) });
  };
  // An edit shows the cut again, as the feed would.
  useEffect(() => setOpen(false), [content.body]);
  const host = hostOf(content.linkUrl);
  // The text as the channel sends it: some append the link to it (TikTok, YouTube, Facebook with images).
  const sent = isProvider(provider) ? sentText(provider, content.body, content.linkUrl || null, content.media.length) : content.body;
  const linkInText = sent !== content.body;
  // Instagram and the others whose adapter never sends the link.
  const linkDropped = Boolean(host) && isProvider(provider) && LINK_PLACEMENT[provider] === 'apart' && !rule.linkCard;
  const text = previewText(sent, open ? null : rule.cut);
  const title = hasTitle(provider) && content.title ? content.title : '';
  const body = sent ? (
    <p className="text-sm [overflow-wrap:anywhere] whitespace-pre-wrap text-foreground">
      {text.shown}
      {text.more && (
        <>
          {'… '}
          <button type="button" aria-expanded={open} className="font-medium text-muted-foreground hover:underline" onClick={() => setOpen(true)}>
            {t('previewMore')}
          </button>
        </>
      )}
    </p>
  ) : (
    <p className="text-sm text-subtle-foreground">{t('emptyText')}</p>
  );
  const header = (
    <div className="flex items-center gap-2">
      <span aria-hidden="true" className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/15 text-sm font-semibold text-link">
        {channel.slice(0, 1).toUpperCase()}
      </span>
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-foreground">{channel}</p>
        <p className="text-xs text-subtle-foreground">{providerName(provider)}</p>
      </div>
    </div>
  );
  const showCard = Boolean(rule.linkCard && host && !linkInText && content.media.length === 0);
  const page = useLinkPreview(content.linkUrl, readLink && showCard);
  const card = showCard && (
    <div className="mt-3 overflow-hidden rounded-lg border bg-muted">
      {!page?.title && <div className="aspect-[1.91/1] bg-background/40" />}
      <div className="space-y-0.5 px-3 py-2">
        <p className="truncate font-mono text-xs text-muted-foreground uppercase">{page?.siteName ?? host}</p>
        {page?.title && <p className="line-clamp-2 text-sm font-semibold text-foreground">{page.title}</p>}
        {page?.description && <p className="line-clamp-2 text-xs text-muted-foreground">{page.description}</p>}
      </div>
    </div>
  );
  const plainLink = linkDropped ? <p className="mt-2 text-xs text-subtle-foreground">{t('previewLinkNotSent', { host })}</p> : null;

  if (content.postType === 'story') {
    // A Story: the image or video fills an upright frame under the account's name; no text, link or caption.
    return (
      <div className="mx-auto max-w-56 rounded-2xl border bg-foreground/90 p-1.5">
        <div className="relative">
          <Media media={content.media} layout="vertical" max={1} />
          <div className="absolute inset-x-0 top-0 flex items-center gap-1.5 rounded-t-xl bg-gradient-to-b from-foreground/60 to-transparent p-2">
            <span aria-hidden="true" className="size-5 shrink-0 rounded-full bg-background/80" />
            <span className="truncate text-xs font-semibold text-background">{channel}</span>
          </div>
        </div>
        <p className="mt-1.5 text-center text-xs text-background/80">{t('previewStory')}</p>
      </div>
    );
  }
  if (rule.layout === 'vertical') {
    // TikTok: the video fills the frame, the caption sits over its lower part.
    return (
      <div className="mx-auto max-w-56 rounded-xl border bg-background p-2">
        <Media media={content.media} layout="vertical" max={1} cover={content.cover} />
        <div className="mt-2 space-y-1">
          <p className="text-xs font-semibold text-foreground">@{channel.replace(/^@/, '')}</p>
          {body}
        </div>
      </div>
    );
  }
  if (rule.layout === 'video') {
    // YouTube: the video first, its title under it, the description below.
    return (
      <div className="rounded-xl border bg-background p-3">
        <Media media={content.media} layout="video" max={1} cover={content.cover} />
        <p className="mt-2 text-sm font-semibold text-foreground">{title || t('previewNoTitle')}</p>
        <p className="text-xs text-subtle-foreground">{channel}</p>
        <div className="mt-2 rounded-lg bg-muted p-2">{body}</div>
      </div>
    );
  }
  if (rule.layout === 'article') {
    // An article card: the cover, the title and the opening of the text. On Zalo OA (#943) the first image is the
    // cover and every other image follows the text in order, its alt text as the caption under it.
    const zalo = provider === 'zalo_oa';
    const after = zalo ? content.media.slice(1) : [];
    return (
      <div className="rounded-xl border bg-background p-3">
        {header}
        <Media media={zalo ? content.media.slice(0, 1) : content.media} layout="article" max={1} />
        <p className="mt-3 text-sm font-semibold text-foreground">{title || t('previewNoTitle')}</p>
        <div className="mt-1">{body}</div>
        {after.map((m, i) => (
          <figure key={m.fileId} className="mt-3">
            <Thumb fileId={m.fileId} alt={m.altText?.trim() || t('imageAlt', { n: String(i + 2) })} mime={m.mime} className="mx-auto aspect-[4/3] w-full" />
            {m.altText?.trim() ? <figcaption className="mt-1 text-center text-xs text-muted-foreground">{m.altText.trim()}</figcaption> : null}
          </figure>
        ))}
      </div>
    );
  }
  if (rule.layout === 'square') {
    // Instagram: the image first, square, then the caption after the account name.
    return (
      <div className="rounded-xl border bg-background p-3">
        {header}
        <Media media={content.media} layout="square" max={1} cover={content.cover} />
        <div className="mt-2">{body}</div>
        {plainLink}
      </div>
    );
  }
  return (
    <div className={cn('rounded-xl border bg-background p-3', rule.layout === 'short' && 'space-y-0')}>
      {header}
      {title && <p className="mt-3 text-sm font-semibold text-foreground">{title}</p>}
      {content.topicTag && <p className="mt-2 text-xs font-medium text-link">{content.topicTag}</p>}
      <div className="mt-2">{body}</div>
      {content.poll && content.poll.length > 0 && typeof content.pollQuestion === 'string' && <p className="mt-2 text-sm font-semibold text-foreground">{content.pollQuestion.trim() || ' '}</p>}
      {content.poll && content.poll.length > 0 && (
        <ul className="mt-2 space-y-1" aria-label={t('previewPoll')}>
          {content.poll.map((option, i) => (
            <li key={i} className="rounded-full border px-3 py-1 text-xs text-foreground">
              {option || '\u00a0'}
            </li>
          ))}
        </ul>
      )}
      {content.poll && content.poll.length > 0 && content.pollMinutes !== undefined && (
        <p className="mt-1 text-xs text-subtle-foreground">{t(`previewPollLength.${pollLength(content.pollMinutes).unit}`, { n: pollLength(content.pollMinutes).n })}</p>
      )}
      {content.poll && content.poll.length > 0 && content.pollMultiple && <p className="mt-1 text-xs text-subtle-foreground">{t('previewPollMultiple')}</p>}
      {content.poll && content.poll.length > 0 && content.pollHideTotals && <p className="mt-1 text-xs text-subtle-foreground">{t('previewPollHideTotals')}</p>}
      <Media media={content.media} layout="feed" max={rule.gridMax} />
      {content.replySettings && <p className="mt-2 text-xs text-subtle-foreground">{t(`previewReplySettings.${content.replySettings}`)}</p>}
      {content.visibility && <p className="mt-2 text-xs text-subtle-foreground">{t(`previewVisibility.${content.visibility}`)}</p>}
      {content.replyRules && <p className="mt-2 text-xs text-subtle-foreground">{replyRulesLine(content.replyRules)}</p>}
      {content.quotesOff && <p className="mt-2 text-xs text-subtle-foreground">{t('previewQuotesOff')}</p>}
      {card}
      {content.buttons && content.buttons.length > 0 && (
        // As Telegram lays out an inline keyboard: each row under the message, its buttons sharing the width.
        <div className="mt-2 space-y-1" role="group" aria-label={t('previewButtons')}>
          {content.buttons.map((row, r) => (
            <div key={r} className="flex gap-1">
              {row.map((b, i) => (
                <span key={i} title={b.url} className="min-w-0 flex-1 truncate rounded-md bg-muted px-2 py-1.5 text-center text-xs font-medium text-link">
                  {b.text.trim() || '\u00a0'}
                  <span aria-hidden="true"> ↗</span>
                </span>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}