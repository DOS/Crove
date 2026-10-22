// The Social calendar (#580): month and week views of when each channel goes out, in the viewer's time zone. Owners
// and admins drag a scheduled channel to another day (same time of day) to move it; a click on a day starts a post
// planned for it. At phone width the week is a list of days. Vietnamese occasions (#702) show on their days, each
// starting a post planned a few days before, with a list of the next 60 days; a viewer can hide them. Members switch to
// picking (#1057): a click on a post then ticks it for the bulk bar's labels and assignee instead of opening it.
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useMemo, useState, type DragEvent, type ReactNode } from 'react';
import { occasionsBetween, type Occasion } from '@crove/mod-social/contract';
import { useTranslations } from 'use-intl';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { RepeatIcon } from '@crove/ui/components/repeat-icon';
import { cn } from '@crove/ui/lib/utils';
import { ErrorText, Spinner } from './ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';
import { providerName, VARIANT_TONE } from '../lib/social.ts';
import { addDays, calendarItems, DAY_MS, dayId, notesByDay, onDay, startOfDay, viewDays, type CalendarItem, type View } from '../lib/social-calendar.ts';
import { NoteChip, NoteEditor, type NoteDraft } from './social-calendar-notes.tsx';
import { PlanExportPanel } from './social-plan-export.tsx';
import { occasionStart, occasionsShown, setOccasionsShown } from '../lib/social-occasions.ts';

const excerpt = (text: string) => text.replace(/\s+/g, ' ').trim();

type Post = CalendarItem['post'];

// picked: null shows a link to the post (dragged by owners and admins); true or false, picking (#1057), where a click
// ticks or unticks the chip's post for the bulk bar instead.
function Chip({ item, slug, name, draggable, picked, onToggle }: { item: CalendarItem; slug: string; name: string | undefined; draggable: boolean; picked: boolean | null; onToggle: () => void }) {
  const t = useTranslations('social');
  const f = useFormat();
  const onDragStart = (e: DragEvent) => {
    e.dataTransfer.setData('text/plain', item.v.id);
    e.dataTransfer.effectAllowed = 'move';
  };
  // A series post or one of its copies (#979).
  const recurring = item.post.recurrence !== null || item.post.recurrenceSourceId !== null;
  const title = `${f.time(item.at.toISOString())} · ${providerName(item.v.provider)}${name ? ` · ${name}` : ''}${item.planned ? ` · ${t('calendar.planned')}` : ''}${recurring ? ` · ${t('calendar.recurring')}` : ''}${item.v.status === 'removed' ? ` · ${t('status.removed')}` : ''}`;
  const look = cn(
    'block truncate rounded-md border px-1.5 py-0.5 text-xs text-foreground transition-colors hover:border-ring/60',
    item.planned ? 'border-dashed bg-background text-muted-foreground' : 'bg-card',
    // Taken down from its platform (#860): still on its day, struck through.
    item.v.status === 'removed' && 'text-muted-foreground line-through',
  );
  const content = (
    <>
      <span className="font-mono tabular-nums">{f.time(item.at.toISOString())}</span>{' '}
      {recurring && (
        <>
          <RepeatIcon className="text-primary" />
          <span className="sr-only">{t('calendar.recurring')}</span>{' '}
        </>
      )}
      <span className="text-subtle-foreground">{providerName(item.v.provider)}</span>{' '}
      {excerpt(item.v.effective.body) || t('emptyText')}
    </>
  );
  if (picked !== null) {
    return (
      <button
        type="button"
        aria-pressed={picked}
        title={title}
        onClick={onToggle}
        className={cn(look, 'w-full text-left focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none', picked && 'border-primary ring-2 ring-primary/60')}
      >
        {content}
      </button>
    );
  }
  return (
    <Link
      to="/o/$slug/social/$id"
      params={{ slug, id: item.post.id }}
      draggable={draggable}
      onDragStart={draggable ? onDragStart : undefined}
      title={title}
      className={cn(look, draggable && 'cursor-grab active:cursor-grabbing')}
    >
      {content}
    </Link>
  );
}

// An occasion on its day: a click starts a post for it, planned a few days before (none once its day is over).
function OccasionChip({ occasion, onStart }: { occasion: Occasion; onStart: (o: Occasion) => void }) {
  const t = useTranslations('social.occasions');
  const open = occasionStart(occasion.date) !== null;
  const name = t(`names.${occasion.id as 'tet'}`);
  return (
    <button
      type="button"
      disabled={!open}
      onClick={() => onStart(occasion)}
      title={open ? t('draftFor', { name }) : name}
      className={cn(
        'block w-full truncate rounded-md px-1.5 py-0.5 text-left text-xs font-medium',
        occasion.kind === 'shopping' ? 'bg-warning/15 text-foreground' : 'bg-primary/10 text-foreground',
        open ? 'hover:ring-1 hover:ring-ring/60' : 'cursor-default opacity-70',
      )}
    >
      {name}
    </button>
  );
}

// filters: the Social home's post filters (label #639, channel, text, mine #640), the same as the lists and the board
// (#1022). canWrite: may add and change notes on dates (#794).
export type CalendarFilters = { connectionId?: string; labelId?: string; search?: string; assignee?: 'me' };
// bulk: the bulk bar for the posts picked in the month or week shown, with a way to clear them; without it, no picking.
export function SocialCalendar({
  slug,
  names,
  canDecide,
  canWrite,
  filters = {},
  bulk,
}: {
  slug: string;
  names: Map<string, string>;
  canDecide: boolean;
  canWrite: boolean;
  filters?: CalendarFilters;
  bulk?: ((posts: Post[], clear: () => void) => ReactNode) | undefined;
}) {
  const t = useTranslations('social');
  const f = useFormat();
  const navigate = useNavigate();
  const [view, setView] = useState<View>('month');
  const [anchor, setAnchor] = useState(() => startOfDay(new Date()));
  const days = useMemo(() => viewDays(view, anchor), [view, anchor]);
  const range = useMemo(() => ({ from: (days[0] as Date).toISOString(), to: addDays(days.at(-1) as Date, 1).toISOString() }), [days]);
  const posts = useQuery(orpc.social.posts.list.queryOptions({ input: { ...range, ...filters, limit: 200 } }));
  const items = useMemo(() => calendarItems(posts.data ?? []), [posts.data]);
  const notes = useQuery(orpc.social.calendarNotes.list.queryOptions({ input: { from: dayId(days[0] as Date), to: dayId(days.at(-1) as Date) } }));
  const notesOn = useMemo(() => notesByDay(notes.data ?? [], days), [notes.data, days]);
  const [noteDraft, setNoteDraft] = useState<NoteDraft | null>(null);
  // The content plan export (#978), for members and above.
  const [exporting, setExporting] = useState(false);
  const byDay = useMemo(() => {
    const map = new Map<string, CalendarItem[]>();
    for (const item of items) map.set(dayId(item.at), [...(map.get(dayId(item.at)) ?? []), item]);
    return map;
  }, [items]);
  const [over, setOver] = useState<string | null>(null);
  const [dropError, setDropError] = useState(false);
  // Picking posts for the bulk bar (#1057): a post leaves the selection when it leaves the month or week shown.
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const selected = (posts.data ?? []).filter((p) => picked.has(p.id));
  const togglePick = (postId: string) =>
    setPicked((now) => {
      const next = new Set(now);
      if (next.has(postId)) next.delete(postId);
      else next.add(postId);
      return next;
    });
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
  const [showOccasions, setShowOccasions] = useState(() => occasionsShown(slug));
  const occasions = useMemo(() => (showOccasions ? occasionsBetween(dayId(days[0] as Date), dayId(days.at(-1) as Date)) : []), [days, showOccasions]);
  const occasionsByDay = useMemo(() => {
    const map = new Map<string, Occasion[]>();
    for (const o of occasions) map.set(o.date, [...(map.get(o.date) ?? []), o]);
    return map;
  }, [occasions]);
  const upcoming = useMemo(() => (showOccasions ? occasionsBetween(dayId(new Date()), dayId(addDays(new Date(), 60))) : []), [showOccasions]);
  const startFor = (o: Occasion) => {
    const at = occasionStart(o.date);
    if (!at) return;
    void navigate({ to: '/o/$slug/social/new', params: { slug }, search: { at: at.toISOString(), occasion: o.id, on: o.date } });
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
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto"
          aria-pressed={showOccasions}
          onClick={() => {
            setOccasionsShown(slug, !showOccasions);
            setShowOccasions(!showOccasions);
          }}
        >
          {t(showOccasions ? 'occasions.hide' : 'occasions.show')}
        </Button>
        {canWrite && (
          <Button variant="ghost" size="sm" onClick={() => setNoteDraft({ day: dayId(new Date()) })}>
            {t('calendarNotes.add')}
          </Button>
        )}
        {canWrite && (
          <Button variant="ghost" size="sm" aria-expanded={exporting} onClick={() => setExporting(!exporting)}>
            {t('planExport.open')}
          </Button>
        )}
        {bulk && (
          <Button
            variant={picking ? 'secondary' : 'ghost'}
            size="sm"
            aria-pressed={picking}
            onClick={() => {
              setPicking(!picking);
              setPicked(new Set());
            }}
          >
            {t('calendar.pick')}
          </Button>
        )}
        <div className="flex gap-1" role="group" aria-label={t('calendar.view')}>
          {(['month', 'week'] as const).map((v) => (
            <Button key={v} variant={view === v ? 'secondary' : 'ghost'} size="sm" aria-pressed={view === v} onClick={() => setView(v)}>
              {t(`calendar.${v}`)}
            </Button>
          ))}
        </div>
      </div>
      {picking && bulk ? (
        <>
          <p className="text-xs text-subtle-foreground">{t('calendar.pickHint')}</p>
          {bulk(selected, () => setPicked(new Set()))}
        </>
      ) : (
        canDecide && <p className="text-xs text-subtle-foreground">{t('calendar.dragHint')}</p>
      )}
      {noteDraft && <NoteEditor key={'note' in noteDraft ? noteDraft.note.id : noteDraft.day} draft={noteDraft} onClose={() => setNoteDraft(null)} />}
      {exporting && canWrite && <PlanExportPanel slug={slug} month={anchor} onClose={() => setExporting(false)} />}
      {notes.error && <ErrorText>{errorMessage(notes.error)}</ErrorText>}
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
                  {(notesOn.get(id) ?? []).map((n) => (
                    <NoteChip key={n.id} note={n} onOpen={canWrite ? (note) => setNoteDraft({ note }) : null} />
                  ))}
                  {(occasionsByDay.get(id) ?? []).map((o) => (
                    <OccasionChip key={o.id} occasion={o} onStart={startFor} />
                  ))}
                  {list.slice(0, shown).map((item) => (
                    <Chip
                      key={item.v.id}
                      item={item}
                      slug={slug}
                      name={names.get(item.v.connectionId)}
                      draggable={canDecide && !picking && !item.planned && item.v.status === 'scheduled' && !item.v.queuePaused}
                      picked={picking && bulk ? picked.has(item.post.id) : null}
                      onToggle={() => togglePick(item.post.id)}
                    />
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
          {upcoming.length > 0 && (
            <section aria-label={t('occasions.upcoming')} className="space-y-2 rounded-xl border p-3">
              <p className="text-sm font-medium text-foreground">{t('occasions.upcoming')}</p>
              <ul className="space-y-1.5">
                {upcoming.map((o) => (
                  <li key={`${o.id}-${o.date}`} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                    <span>
                      <span className="text-foreground">{t(`occasions.names.${o.id as 'tet'}`)}</span>
                      <span className="text-subtle-foreground">{' · '}{f.date(o.date)}</span>
                    </span>
                    {occasionStart(o.date) && (
                      <Button size="sm" variant="outline" onClick={() => startFor(o)}>
                        {t('occasions.draft')}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}
