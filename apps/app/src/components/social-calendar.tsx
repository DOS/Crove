// The Social calendar (#580): month and week views of when each channel goes out, in the viewer's time zone. Owners
// and admins drag a scheduled channel to another day (same time of day) to move it; a click on a day starts a post
// planned for it. At phone width the week is a list of days.
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useMemo, useState, type DragEvent } from 'react';
import { useTranslations } from 'use-intl';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { cn } from '@crove/ui/lib/utils';
import { ErrorText, Spinner } from './ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';
import { providerName, VARIANT_TONE } from '../lib/social.ts';
import { addDays, calendarItems, DAY_MS, dayId, onDay, startOfDay, viewDays, type CalendarItem, type View } from '../lib/social-calendar.ts';

const excerpt = (text: string) => text.replace(/\s+/g, ' ').trim();

function Chip({ item, slug, name, draggable }: { item: CalendarItem; slug: string; name: string | undefined; draggable: boolean }) {
  const t = useTranslations('social');
  const f = useFormat();
  const onDragStart = (e: DragEvent) => {
    e.dataTransfer.setData('text/plain', item.v.id);
    e.dataTransfer.effectAllowed = 'move';
  };
  return (
    <Link
      to="/o/$slug/social/$id"
      params={{ slug, id: item.post.id }}
      draggable={draggable}
      onDragStart={draggable ? onDragStart : undefined}
      title={`${f.time(item.at.toISOString())} · ${providerName(item.v.provider)}${name ? ` · ${name}` : ''}${item.planned ? ` · ${t('calendar.planned')}` : ''}`}
      className={cn(
        'block truncate rounded-md border px-1.5 py-0.5 text-xs text-foreground transition-colors hover:border-ring/60',
        item.planned ? 'border-dashed bg-background text-muted-foreground' : 'bg-card',
        draggable && 'cursor-grab active:cursor-grabbing',
      )}
    >
      <span className="font-mono tabular-nums">{f.time(item.at.toISOString())}</span> <span className="text-subtle-foreground">{providerName(item.v.provider)}</span>{' '}
      {excerpt(item.v.effective.body) || t('emptyText')}
    </Link>
  );
}

// labelId: only posts with that label (#639).
export function SocialCalendar({ slug, names, canDecide, labelId }: { slug: string; names: Map<string, string>; canDecide: boolean; labelId?: string | undefined }) {
  const t = useTranslations('social');
  const f = useFormat();
  const navigate = useNavigate();
  const [view, setView] = useState<View>('month');
  const [anchor, setAnchor] = useState(() => startOfDay(new Date()));
  const days = useMemo(() => viewDays(view, anchor), [view, anchor]);
  const range = useMemo(() => ({ from: (days[0] as Date).toISOString(), to: addDays(days.at(-1) as Date, 1).toISOString() }), [days]);
  const posts = useQuery(orpc.social.posts.list.queryOptions({ input: { ...range, ...(labelId ? { labelId } : {}), limit: 200 } }));
  const items = useMemo(() => calendarItems(posts.data ?? []), [posts.data]);
  const byDay = useMemo(() => {
    const map = new Map<string, CalendarItem[]>();
    for (const item of items) map.set(dayId(item.at), [...(map.get(dayId(item.at)) ?? []), item]);
    return map;
  }, [items]);
  const [over, setOver] = useState<string | null>(null);
  const [dropError, setDropError] = useState(false);
  const move = useMutation({
    mutationFn: (args: { variantId: string; at: Date }) => client.social.variants.reschedule({ variantId: args.variantId, at: args.at.toISOString() }),
    onSettled: () => void queryClient.invalidateQueries(),
  });
  const today = dayId(new Date());
  const shift = (n: number) => setAnchor((a) => (view === 'month' ? new Date(a.getFullYear(), a.getMonth() + n, 1) : addDays(a, 7 * n)));
  const drop = (day: Date) => (e: DragEvent) => {
    e.preventDefault();
    setOver(null);
    const item = items.find((i) => i.v.id === e.dataTransfer.getData('text/plain'));
    if (!item || item.planned || item.v.status !== 'scheduled' || item.v.queuePaused) return;
    const at = onDay(item.at, day);
    if (dayId(at) === dayId(item.at)) return;
    // Today, at a time already gone: say so here rather than ask the server.
    if (at.getTime() <= Date.now()) {
      setDropError(true);
      return;
    }
    setDropError(false);
    move.mutate({ variantId: item.v.id, at });
  };
  // A new post planned at 09:00 that day; today after 09:00, at the next full hour.
  const start = (day: Date) => {
    let at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 9, 0);
    if (at.getTime() <= Date.now()) {
      const now = new Date();
      at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours() + 1, 0);
      if (dayId(at) !== dayId(day)) return;
    }
    void navigate({ to: '/o/$slug/social/new', params: { slug }, search: { at: at.toISOString() } });
  };
  // Calendar days go to f.date as local YYYY-MM-DD: it reads the date part as written.
  const title = view === 'month' ? f.monthYear(anchor.toISOString()) : `${f.date(dayId(days[0] as Date))} - ${f.date(dayId(days.at(-1) as Date))}`;
  const shown = view === 'month' ? 3 : 20;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => shift(-1)} aria-label={t('calendar.previous')}>
          ‹
        </Button>
        <Button variant="outline" size="sm" onClick={() => setAnchor(startOfDay(new Date()))}>
          {t('calendar.today')}
        </Button>
        <Button variant="outline" size="sm" onClick={() => shift(1)} aria-label={t('calendar.next')}>
          ›
        </Button>
        <h3 className="text-sm font-medium text-foreground first-letter:uppercase">{title}</h3>
        <div className="ml-auto flex gap-1" role="group" aria-label={t('calendar.view')}>
          {(['month', 'week'] as const).map((v) => (
            <Button key={v} variant={view === v ? 'secondary' : 'ghost'} size="sm" aria-pressed={view === v} onClick={() => setView(v)}>
              {t(`calendar.${v}`)}
            </Button>
          ))}
        </div>
      </div>
      {canDecide && <p className="text-xs text-subtle-foreground">{t('calendar.dragHint')}</p>}
      {move.error && <ErrorText>{errorMessage(move.error)}</ErrorText>}
      {dropError && <ErrorText>{t('calendar.dropPast')}</ErrorText>}
      {posts.isLoading ? (
        <Spinner />
      ) : posts.error ? (
        <ErrorText>{errorMessage(posts.error)}</ErrorText>
      ) : (
        <>
          {(posts.data?.length ?? 0) >= 200 && <p className="text-xs text-subtle-foreground">{t('calendar.capped')}</p>}
          <div className={cn('grid gap-px overflow-hidden rounded-xl border bg-border', view === 'month' ? 'grid-cols-7' : 'grid-cols-1 sm:grid-cols-7')}>
            {days.slice(0, 7).map((d) => (
              <div key={`h-${dayId(d)}`} className={cn('bg-muted px-2 py-1 text-xs font-medium text-muted-foreground', view === 'week' && 'hidden sm:block')}>
                {f.weekdayShort(d.toISOString())}
              </div>
            ))}
            {days.map((d) => {
              const id = dayId(d);
              const list = byDay.get(id) ?? [];
              const outside = view === 'month' && d.getMonth() !== anchor.getMonth();
              const past = startOfDay(d).getTime() + DAY_MS <= Date.now();
              return (
                <div
                  key={id}
                  onDragOver={canDecide && !past ? (e) => (e.preventDefault(), setOver(id)) : undefined}
                  onDragLeave={() => setOver((o) => (o === id ? null : o))}
                  onDrop={canDecide && !past ? drop(d) : undefined}
                  className={cn('group flex min-h-24 flex-col gap-1 bg-background p-1.5', outside && 'bg-muted/40', over === id && 'ring-2 ring-primary ring-inset', view === 'week' && 'sm:min-h-64')}
                >
                  <div className="flex items-center justify-between">
                    <span className={cn('text-xs tabular-nums', id === today ? 'rounded-full bg-primary px-1.5 font-semibold text-primary-foreground' : outside ? 'text-subtle-foreground' : 'text-muted-foreground')}>
                      {view === 'week' ? <span className="sm:hidden">{f.weekdayShort(d.toISOString())} </span> : null}
                      {d.getDate()}
                    </span>
                    {!past && (
                      <button
                        type="button"
                        onClick={() => start(d)}
                        aria-label={t('calendar.newOn', { day: f.date(id) })}
                        className="rounded px-1 text-xs text-subtle-foreground opacity-0 group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
                      >
                        +
                      </button>
                    )}
                  </div>
                  {list.slice(0, shown).map((item) => (
                    <Chip key={item.v.id} item={item} slug={slug} name={names.get(item.v.connectionId)} draggable={canDecide && !item.planned && item.v.status === 'scheduled' && !item.v.queuePaused} />
                  ))}
                  {list.length > shown && <span className="text-xs text-subtle-foreground">{t('calendar.more', { count: list.length - shown })}</span>}
                </div>
              );
            })}
          </div>
          <div className="flex flex-wrap gap-2 text-xs text-subtle-foreground">
            <Badge variant={VARIANT_TONE.scheduled}>{t('status.scheduled')}</Badge>
            <Badge variant={VARIANT_TONE.published}>{t('status.published')}</Badge>
            <span className="rounded-md border border-dashed px-1.5">{t('calendar.planned')}</span>
          </div>
        </>
      )}
    </div>
  );
}
