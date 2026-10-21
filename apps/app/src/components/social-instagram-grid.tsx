// The Instagram grid preview (#795): the profile grid of one Instagram channel as it will look, the posts to come
// (dashed) ahead of the latest ones out, newest first, three to a row. Owners and admins drag a scheduled post onto
// another scheduled one to swap their times, with the same reschedule the calendar uses. Stories are left out; a Reel
// shows its cover.
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useMemo, useState, type DragEvent } from 'react';
import { useTranslations } from 'use-intl';
import { coverOf } from '@crove/mod-social/contract';
import { Card } from '@crove/ui/components/card';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { cn } from '@crove/ui/lib/utils';
import { Thumb } from './social-media.tsx';
import { ErrorText, Spinner } from './ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';
import { DAY_MS } from '../lib/social-calendar.ts';
import { gridItems, swappable, swapTimes, type GridItem } from '../lib/social-grid.ts';

// Two months back, four ahead: enough to see the rows around today.
const BACK_MS = 60 * DAY_MS;
const AHEAD_MS = 120 * DAY_MS;

function Tile({ item, slug, draggable, over, onDragOver, onDrop }: { item: GridItem; slug: string; draggable: boolean; over: boolean; onDragOver: (e: DragEvent) => void; onDrop: (e: DragEvent) => void }) {
  const t = useTranslations('social.grid');
  const f = useFormat();
  const media = item.v.media[0];
  const cover = coverOf(item.v.settings);
  const label = `${item.upcoming ? t('upcoming') : t('published')} · ${f.dateTime(item.at.toISOString())}`;
  return (
    <Link
      to="/o/$slug/social/$id"
      params={{ slug, id: item.post.id }}
      title={label}
      aria-label={label}
      draggable={draggable}
      onDragStart={
        draggable
          ? (e: DragEvent) => {
              e.dataTransfer.setData('text/plain', item.v.id);
              e.dataTransfer.effectAllowed = 'move';
            }
          : undefined
      }
      onDragOver={onDragOver}
      onDrop={onDrop}
      className={cn('relative block aspect-square', item.upcoming && 'rounded-lg ring-2 ring-dashed ring-primary/50', over && 'ring-2 ring-ring', draggable && 'cursor-grab active:cursor-grabbing')}
    >
      {media &&
        (cover && 'fileId' in cover ? (
          <Thumb fileId={cover.fileId} alt={label} className="size-full" />
        ) : (
          <Thumb fileId={media.fileId} alt={label} mime={media.mime} durationMs={media.durationMs} frameMs={cover && 'atMs' in cover ? cover.atMs : undefined} className="size-full" />
        ))}
      {item.v.media.length > 1 && <span className="absolute right-1 top-1 rounded bg-background/80 px-1 text-xs text-foreground">⧉</span>}
      {item.upcoming && <span className="absolute bottom-1 right-1 rounded bg-background/80 px-1 text-xs text-foreground tabular-nums">{f.date(item.at.toISOString())}</span>}
    </Link>
  );
}

export function InstagramGrid({ slug, channels, canDecide }: { slug: string; channels: readonly { id: string; displayName: string }[]; canDecide: boolean }) {
  const t = useTranslations('social.grid');
  const [picked, setPicked] = useState('');
  const connectionId = picked || channels[0]?.id || '';
  const range = useMemo(() => {
    const now = Date.now();
    return { from: new Date(now - BACK_MS).toISOString(), to: new Date(now + AHEAD_MS).toISOString() };
  }, []);
  const posts = useQuery({ ...orpc.social.posts.list.queryOptions({ input: { ...range, limit: 200 } }), enabled: connectionId !== '' });
  const items = useMemo(() => gridItems(posts.data ?? [], connectionId), [posts.data, connectionId]);
  const [over, setOver] = useState<string | null>(null);
  const swap = useMutation({
    mutationFn: async (moves: readonly { variantId: string; at: Date }[]) => {
      for (const m of moves) await client.social.variants.reschedule({ variantId: m.variantId, at: m.at.toISOString() });
    },
    onSettled: () => void queryClient.invalidateQueries(),
  });
  if (channels.length === 0) return null;
  const drop = (target: GridItem) => (e: DragEvent) => {
    e.preventDefault();
    setOver(null);
    const source = items.find((i) => i.v.id === e.dataTransfer.getData('text/plain'));
    const moves = source ? swapTimes(source, target) : null;
    if (moves && !swap.isPending) swap.mutate(moves);
  };
  return (
    <Card className="block space-y-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="mr-auto">
          <h3 className="text-sm font-medium text-foreground">{t('title')}</h3>
          <p className="text-xs text-subtle-foreground">{canDecide ? t('hintDrag') : t('hint')}</p>
        </div>
        {channels.length > 1 && (
          <NativeSelect value={connectionId} onChange={(e) => setPicked(e.target.value)} aria-label={t('channel')} className="w-auto">
            {channels.map((c) => (
              <NativeSelectOption key={c.id} value={c.id}>
                {c.displayName}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        )}
      </div>
      {swap.error && <ErrorText>{errorMessage(swap.error)}</ErrorText>}
      {posts.isLoading ? (
        <Spinner />
      ) : posts.error ? (
        <ErrorText>{errorMessage(posts.error)}</ErrorText>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('empty')}</p>
      ) : (
        <ol className="mx-auto grid max-w-md grid-cols-3 gap-1" aria-label={t('title')}>
          {items.map((item) => {
            const movable = canDecide && swappable(item);
            return (
              <li key={item.v.id}>
                <Tile
                  item={item}
                  slug={slug}
                  draggable={movable}
                  over={over === item.v.id}
                  onDragOver={(e) => {
                    if (!movable) return;
                    e.preventDefault();
                    setOver(item.v.id);
                  }}
                  onDrop={drop(item)}
                />
              </li>
            );
          })}
        </ol>
      )}
    </Card>
  );
}
