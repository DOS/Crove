// The composer's preview of a channel (#588): the post laid out the way its platform shows it in the feed, with the
// text cut where the platform cuts it, images in its frame and a link card where it makes one.
import { useEffect, useState } from 'react';
import { isProvider, LINK_PLACEMENT, sentText } from '@crove/mod-social/contract';
import { useTranslations } from 'use-intl';
import { cn } from '@crove/ui/lib/utils';
import { Thumb, type MediaItem } from './social-media.tsx';
import { previewRule, previewText } from '../lib/social-preview.ts';
import { hasTitle, providerName } from '../lib/social.ts';

export interface PreviewContent {
  body: string;
  title: string;
  linkUrl: string;
  media: readonly MediaItem[];
}

function hostOf(link: string): string {
  try {
    return link ? new URL(link).host : '';
  } catch {
    return '';
  }
}

function Media({ media, layout, max }: { media: readonly MediaItem[]; layout: string; max: number }) {
  const t = useTranslations('social');
  if (media.length === 0) return null;
  const alt = (m: MediaItem, i: number) => m.altText || t('imageAlt', { n: String(i + 1) });
  if (layout === 'vertical' || layout === 'video' || layout === 'square' || layout === 'article') {
    const first = media[0] as MediaItem;
    const frame = layout === 'vertical' ? 'aspect-[9/16] max-h-96' : layout === 'video' ? 'aspect-video' : layout === 'square' ? 'aspect-square' : 'aspect-[16/9]';
    return (
      <div className="relative mt-3">
        <Thumb fileId={first.fileId} alt={alt(first, 0)} mime={first.mime} durationMs={first.durationMs} className={cn(frame, 'mx-auto w-full')} />
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

export function PlatformPreview({ channel, provider, content }: { channel: string; provider: string; content: PreviewContent }) {
  const t = useTranslations('social');
  const rule = previewRule(provider);
  const [open, setOpen] = useState(false);
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
  const card = rule.linkCard && host && !linkInText && content.media.length === 0 && (
    <div className="mt-3 overflow-hidden rounded-lg border bg-muted">
      <div className="aspect-[1.91/1] bg-background/40" />
      <p className="truncate px-3 py-2 font-mono text-xs text-muted-foreground uppercase">{host}</p>
    </div>
  );
  const plainLink = linkDropped ? <p className="mt-2 text-xs text-subtle-foreground">{t('previewLinkNotSent', { host })}</p> : null;

  if (rule.layout === 'vertical') {
    // TikTok: the video fills the frame, the caption sits over its lower part.
    return (
      <div className="mx-auto max-w-56 rounded-xl border bg-background p-2">
        <Media media={content.media} layout="vertical" max={1} />
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
        <Media media={content.media} layout="video" max={1} />
        <p className="mt-2 text-sm font-semibold text-foreground">{title || t('previewNoTitle')}</p>
        <p className="text-xs text-subtle-foreground">{channel}</p>
        <div className="mt-2 rounded-lg bg-muted p-2">{body}</div>
      </div>
    );
  }
  if (rule.layout === 'article') {
    // Zalo OA: an article card, the cover, the title and the opening of the text.
    return (
      <div className="rounded-xl border bg-background p-3">
        {header}
        <Media media={content.media} layout="article" max={1} />
        <p className="mt-3 text-sm font-semibold text-foreground">{title || t('previewNoTitle')}</p>
        <div className="mt-1">{body}</div>
      </div>
    );
  }
  if (rule.layout === 'square') {
    // Instagram: the image first, square, then the caption after the account name.
    return (
      <div className="rounded-xl border bg-background p-3">
        {header}
        <Media media={content.media} layout="square" max={1} />
        <div className="mt-2">{body}</div>
        {plainLink}
      </div>
    );
  }
  return (
    <div className={cn('rounded-xl border bg-background p-3', rule.layout === 'short' && 'space-y-0')}>
      {header}
      {title && <p className="mt-3 text-sm font-semibold text-foreground">{title}</p>}
      <div className="mt-2">{body}</div>
      <Media media={content.media} layout="feed" max={rule.gridMax} />
      {card}
    </div>
  );
}