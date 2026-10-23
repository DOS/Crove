// The Social calendar (#580): month and week views of when each channel goes out, in the viewer's time zone. Owners
// and admins drag a scheduled channel to another day (same time of day) to move it; a click on a day starts a post
// planned for it. At phone width the week is a list of days. Vietnamese occasions (#702) show on their days, each
// starting a post planned a few days before, with a list of the next 60 days; a viewer can hide them. Members switch to
// picking (#1057): a click on a post then ticks it for the bulk bar's labels and assignee instead of opening it.
// Members plan drafts (#1145): the "Chưa có ngày" list holds the drafts with no time yet, and a draft dropped on a day
// (or a planned draft moved to another) gets its planned time through social.post.update with the revision shown. In
// week view the hours of each day are drop targets while something is dragged. Without dragging, the list's "Đặt ngày"
// and the chip's menu set a date and time by keyboard; at phone width, where chips are too narrow for a menu, the list
// is a plain list with its "Đặt ngày".
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useMemo, useState, type DragEvent, type ReactNode } from 'react';
import { occasionsBetween, type Occasion } from '@crove/mod-social/contract';
import { useTranslations } from 'use-intl';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Input } from '@crove/ui/components/input';
import { Label } from '@crove/ui/components/label';
import { RepeatIcon } from '@crove/ui/components/repeat-icon';
import { cn } from '@crove/ui/lib/utils';
import { ErrorText, Spinner } from './ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';
import { providerName, VARIANT_TONE } from '../lib/social.ts';
import {
  addDays,
  calendarItems,
  DAY_MS,
  dayId,
  DROP_HOURS,
  followsPlan,
  localMoment,
  notesByDay,
  onDay,
  planDrop,
  plannedAt,
  startOfDay,
  viewDays,
  type CalendarItem,
  type PlanRequest,
  type PlanTarget,
  type View,
} from '../lib/social-calendar.ts';
import { NoteChip, NoteEditor, type NoteDraft } from './social-calendar-notes.tsx';
import { PlanExportPanel } from './social-plan-export.tsx';
import { occasionStart, occasionsShown, setOccasionsShown } from '../lib/social-occasions.ts';

const excerpt = (text: string) => text.replace(/\s+/g, ' ').trim();

type Post = CalendarItem['post'];
// What is being dragged: a channel on the calendar, or an undated draft from the list (#1145).
type Dragged = { kind: 'variant'; id: string } | { kind: 'post'; id: string };
// A draft opened in the date editor, with the text it is named by.
type Planning = PlanTarget & { text: string };

// The undated drafts the list shows, the post list's default page.
const UNDATED_LIMIT = 50;

const hourLabel = (hour: number) => `${String(hour).padStart(2, '0')}:00`;

// picked: null shows a link to the post (dragged by owners and admins, or by members for a planned draft); true or
// false, picking (#1057), where a click ticks or unticks the chip's post for the bulk bar instead. onPlan: the chip's
// menu, which opens the date editor for a planned draft (#1145).
function Chip({
  item,
  slug,
  name,
  draggable,
  picked,
  onToggle,
  onDragStart,
  onDragEnd,
  onPlan,
}: {
  item: CalendarItem;
  slug: string;
  name: string | undefined;
  draggable: boolean;
  picked: boolean | null;
  onToggle: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onPlan: (() => void) | null;
}) {
  const t = useTranslations('social');
  const f = useFormat();
  const start = (e: DragEvent) => {
    e.dataTransfer.setData('text/plain', item.v.id);
    e.dataTransfer.effectAllowed = 'move';
    onDragStart();
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
  const text = excerpt(item.v.effective.body) || t('emptyText');
  const content = (
    <>
      <span className="font-mono tabular-nums">{f.time(item.at.toISOString())}</span>{' '}
      {recurring && (
        <>
          <RepeatIcon className="text-primary" />
          <span className="sr-only">{t('calendar.recurring')}</span>{' '}
        </>
      )}
      <span className="text-subtle-foreground">{providerName(item.v.provider)}</span> {text}
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
  const link = (
    <Link
      to="/o/$slug/social/$id"
      params={{ slug, id: item.post.id }}
      draggable={draggable}
      onDragStart={draggable ? start : undefined}
      onDragEnd={draggable ? onDragEnd : undefined}
      title={title}
      data-testid="calendar-chip"
      className={cn(look, onPlan && 'min-w-0 flex-1', draggable && 'cursor-grab active:cursor-grabbing')}
    >
      {content}
    </Link>
  );
  if (!onPlan) return link;
  return (
    <div className="group/chip flex items-center gap-0.5">
      {link}
      <button
        type="button"
        onClick={onPlan}
        aria-label={t('calendar.changeDateOf', { text })}
        title={t('calendar.changeDate')}
        className="shrink-0 rounded px-1 text-xs text-subtle-foreground opacity-0 group-hover/chip:opacity-100 hover:text-foreground focus-visible:opacity-100 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none max-sm:hidden"
      >
        ⋯
      </button>
    </div>
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

// The drafts with no time yet (#1145): dragged onto a day on wide screens, or given a date with "Đặt ngày" (the way by
// keyboard, and the only one at phone width, where the list is a plain list).
function UndatedList({
  posts,
  slug,
  capped,
  onDragStart,
  onDragEnd,
  onPlan,
}: {
  posts: readonly Post[];
  slug: string;
  capped: boolean;
  onDragStart: (postId: string) => void;
  onDragEnd: () => void;
  onPlan: (post: Post, text: string) => void;
}) {
  const t = useTranslations('social');
  return (
    <section aria-labelledby="calendar-undated" className="space-y-2 rounded-xl border p-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h4 id="calendar-undated" className="text-sm font-medium text-foreground">
          {t('calendar.undated')} <span className="text-subtle-foreground tabular-nums">({posts.length})</span>
        </h4>
        <p className="text-xs text-subtle-foreground">{t('calendar.undatedHint')}</p>
      </div>
      <ul className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-1">
        {posts.map((p) => {
          const text = excerpt(p.title ?? '') || excerpt(p.body) || t('emptyText');
          const channels = [...new Set(p.variants.filter((v) => v.status !== 'cancelled').map((v) => providerName(v.provider)))].join(', ');
          return (
            <li
              key={p.id}
              data-testid="undated-draft"
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData('text/plain', `post:${p.id}`);
                e.dataTransfer.effectAllowed = 'move';
                onDragStart(p.id);
              }}
              onDragEnd={onDragEnd}
              className="flex min-w-0 items-center gap-2 rounded-lg border border-dashed bg-background px-2 py-1.5 text-sm sm:cursor-grab sm:active:cursor-grabbing"
            >
              {/* The link stays draggable: a drag that starts on it is the item's (its dragstart bubbles up here). */}
              <span className="min-w-0 flex-1">
                <Link to="/o/$slug/social/$id" params={{ slug, id: p.id }} className="block truncate text-foreground hover:underline">
                  {text}
                </Link>
                {channels && <span className="block truncate text-xs text-subtle-foreground">{channels}</span>}
              </span>
              <Button size="sm" variant="outline" aria-label={t('calendar.setDateOf', { text })} onClick={() => onPlan(p, text)}>
                {t('calendar.setDate')}
              </Button>
            </li>
          );
        })}
      </ul>
      {capped && <p className="text-xs text-subtle-foreground">{t('calendar.undatedCapped', { count: UNDATED_LIMIT })}</p>}
    </section>
  );
}

// A date and time for a draft, without dragging (#1145): its planned time to start with, or the first free 09:00 (the
// next full hour today) for an undated one.
function PlanEditor({ target, busy, onSave, onClose }: { target: Planning; busy: boolean; onSave: (request: PlanRequest) => void; onClose: () => void }) {
  const t = useTranslations('social.calendar');
  const [initial] = useState(() => {
    const now = new Date();
    return target.at ?? plannedAt(now, now) ?? plannedAt(addDays(startOfDay(now), 1), now) ?? now;
  });
  const [date, setDate] = useState(dayId(initial));
  const [time, setTime] = useState(`${String(initial.getHours()).padStart(2, '0')}:${String(initial.getMinutes()).padStart(2, '0')}`);
  const [past, setPast] = useState(false);
  return (
    <Card className="block space-y-3 p-4">
      <div>
        <h3 className="text-sm font-medium text-foreground">{t('planTitle')}</h3>
        <p className="truncate text-xs text-subtle-foreground">{target.text}</p>
      </div>
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          const at = localMoment(date, time);
          if (!at || at.getTime() <= Date.now()) {
            setPast(true);
            return;
          }
          setPast(false);
          if (target.at && at.getTime() === target.at.getTime()) {
            onClose();
            return;
          }
          if (!busy) onSave({ postId: target.post.id, revision: target.post.revision, scheduledAt: at.toISOString() });
        }}
      >
        <div className="space-y-1">
          <Label htmlFor="plan-date" className="text-xs">
            {t('planDate')}
          </Label>
          <Input id="plan-date" type="date" autoFocus required value={date} min={dayId(new Date())} onChange={(e) => setDate(e.target.value)} className="w-40" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="plan-time" className="text-xs">
            {t('planTime')}
          </Label>
          <Input id="plan-time" type="time" required value={time} onChange={(e) => setTime(e.target.value)} className="w-32" />
        </div>
        <div className="flex gap-2">
          <Button type="submit" size="sm" disabled={busy}>
            {t('setDate')}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={onClose}>
            {t('planCancel')}
          </Button>
        </div>
      </form>
      {past && <ErrorText>{t('planPast')}</ErrorText>}
    </Card>
  );
}

// filters: the Social home's post filters (label #639, channel, text, mine #640), the same as the lists and the board
// (#1022). canWrite: may add and change notes on dates (#794) and plan drafts (#1145).
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
  // The drafts with no time yet, under the same filters (#1145), for those who may plan them.
  const undated = useQuery({ ...orpc.social.posts.list.queryOptions({ input: { undated: true, ...filters, limit: UNDATED_LIMIT } }), enabled: canWrite });
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
  const [dragged, setDragged] = useState<Dragged | null>(null);
  // Set after the drag has started: changing the page in dragstart itself ends some browsers' drag at once.
  const beginDrag = (what: Dragged) => void setTimeout(() => setDragged(what), 0);
  const [refusal, setRefusal] = useState<'dropPast' | 'planPast' | null>(null);
  const [planning, setPlanning] = useState<Planning | null>(null);
  const [done, setDone] = useState<string | null>(null);
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
  // A draft's planned time (#1145), on the revision the viewer saw: a post changed meanwhile is refused as stale, said
  // with the server's message, and everything reloads either way.
  const plan = useMutation({
    mutationFn: (request: PlanRequest) => client.social.posts.update(request),
    onSuccess: (_, request) => {
      // An editor opened meanwhile for another post stays open.
      setPlanning((open) => (open && open.post.id !== request.postId ? open : null));
      setDone(t('calendar.planDone', { when: f.dateTime(request.scheduledAt) }));
    },
    onError: (error) => {
      if ((error as { code?: unknown }).code === 'STALE_REVISION') setPlanning(null);
    },
    onSettled: () => void queryClient.invalidateQueries(),
  });
  const clearNotices = () => {
    move.reset();
    plan.reset();
    setRefusal(null);
    setDone(null);
  };
  const sendPlan = (request: PlanRequest | 'past' | null) => {
    if (request === null || plan.isPending) return;
    if (request === 'past') {
      setRefusal('planPast');
      return;
    }
    plan.mutate(request);
  };
  const today = dayId(new Date());
  const shift = (n: number) => setAnchor((a) => (view === 'month' ? new Date(a.getFullYear(), a.getMonth() + n, 1) : addDays(a, 7 * n)));
  // A drop on a day, or on one of its hours in week view.
  const drop = (day: Date, hour?: number) => (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setOver(null);
    const data = e.dataTransfer.getData('text/plain');
    const what: Dragged | null = dragged ?? (data.startsWith('post:') ? { kind: 'post', id: data.slice(5) } : data ? { kind: 'variant', id: data } : null);
    setDragged(null);
    if (!what) return;
    clearNotices();
    const now = new Date();
    if (what.kind === 'post') {
      const post = (undated.data ?? []).find((p) => p.id === what.id);
      if (post && canWrite) sendPlan(planDrop({ post, at: null }, day, now, hour));
      return;
    }
    const item = items.find((i) => i.v.id === what.id);
    if (!item) return;
    if (followsPlan(item)) {
      if (canWrite) sendPlan(planDrop({ post: item.post, at: item.at }, day, now, hour));
      return;
    }
    if (!canDecide || item.planned || item.v.status !== 'scheduled' || item.v.queuePaused) return;
    const at = onDay(item.at, day, hour);
    if (at.getTime() === item.at.getTime()) return;
    // Today, at a time already gone: say so here rather than ask the server.
    if (at.getTime() <= now.getTime()) {
      setRefusal('dropPast');
      return;
    }
    move.mutate({ variantId: item.v.id, at });
  };
  const openPlan = (target: Planning) => {
    clearNotices();
    setPlanning(target);
  };
  // A new post planned at 09:00 that day; today after 09:00, at the next full hour.
  const start = (day: Date) => {
    const at = plannedAt(day, new Date());
    if (at) void navigate({ to: '/o/$slug/social/new', params: { slug }, search: { at: at.toISOString() } });
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
  const undatedPosts = canWrite ? (undated.data ?? []) : [];

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
        canWrite && <p className="text-xs text-subtle-foreground">{t(canDecide ? 'calendar.dragHint' : 'calendar.dragHintMember')}</p>
      )}
      {noteDraft && <NoteEditor key={'note' in noteDraft ? noteDraft.note.id : noteDraft.day} draft={noteDraft} onClose={() => setNoteDraft(null)} />}
      {exporting && canWrite && <PlanExportPanel slug={slug} month={anchor} onClose={() => setExporting(false)} />}
      {planning && <PlanEditor key={planning.post.id} target={planning} busy={plan.isPending} onSave={sendPlan} onClose={() => setPlanning(null)} />}
      {notes.error && <ErrorText>{errorMessage(notes.error)}</ErrorText>}
      {move.error && <ErrorText>{errorMessage(move.error)}</ErrorText>}
      {plan.error && <ErrorText>{errorMessage(plan.error)}</ErrorText>}
      {refusal && <ErrorText>{t(`calendar.${refusal}`)}</ErrorText>}
      <p role="status" className={cn('text-xs text-muted-foreground', !done && 'sr-only')}>
        {done}
      </p>
      {undated.error && <ErrorText>{errorMessage(undated.error)}</ErrorText>}
      {/* On wide screens the undated list stands beside the calendar and stays in view, so every day is a drop away. */}
      <div className={cn('space-y-3', undatedPosts.length > 0 && 'xl:grid xl:grid-cols-[minmax(0,1fr)_16rem] xl:items-start xl:gap-3 xl:space-y-0')}>
        {undatedPosts.length > 0 && (
          <div className="xl:sticky xl:top-4 xl:order-2">
            <UndatedList
              posts={undatedPosts}
              slug={slug}
              capped={undatedPosts.length >= UNDATED_LIMIT}
              onDragStart={(id) => beginDrag({ kind: 'post', id })}
              onDragEnd={() => setDragged(null)}
              onPlan={(post, text) => openPlan({ post, at: null, text })}
            />
          </div>
        )}
        <div className="min-w-0 space-y-3 xl:order-1">
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
                  // Past days take no drop (#1145): nothing is planned or moved into the past.
                  const target = canWrite && !past;
                  // While something is dragged in week view, the hours still ahead on this day are drop targets too.
                  const hours = view === 'week' && dragged && target ? DROP_HOURS.filter((h) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), h).getTime() > Date.now()) : [];
                  return (
                    <div
                      key={id}
                      data-day={id}
                      onDragOver={target ? (e) => (e.preventDefault(), setOver(id)) : undefined}
                      onDragLeave={() => setOver((o) => (o === id ? null : o))}
                      onDrop={target ? drop(d) : undefined}
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
                      {list.slice(0, shown).map((item) => {
                        const plannable = canWrite && followsPlan(item);
                        const movable = canDecide && !item.planned && item.v.status === 'scheduled' && !item.v.queuePaused;
                        return (
                          <Chip
                            key={item.v.id}
                            item={item}
                            slug={slug}
                            name={names.get(item.v.connectionId)}
                            draggable={!picking && (plannable || movable)}
                            picked={picking && bulk ? picked.has(item.post.id) : null}
                            onToggle={() => togglePick(item.post.id)}
                            onDragStart={() => beginDrag({ kind: 'variant', id: item.v.id })}
                            onDragEnd={() => setDragged(null)}
                            onPlan={plannable ? () => openPlan({ post: item.post, at: item.at, text: excerpt(item.v.effective.body) || t('emptyText') }) : null}
                          />
                        );
                      })}
                      {list.length > shown && <span className="text-xs text-subtle-foreground">{t('calendar.more', { count: list.length - shown })}</span>}
                      {hours.length > 0 && (
                        <div className="mt-1 hidden flex-col gap-px sm:flex" aria-hidden="true">
                          {hours.map((h) => {
                            const key = `${id}@${h}`;
                            return (
                              <div
                                key={h}
                                data-hour={key}
                                onDragOver={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  setOver(key);
                                }}
                                onDrop={drop(d, h)}
                                className={cn('rounded border border-dashed px-1 text-[10px] leading-4 text-subtle-foreground tabular-nums', over === key && 'border-primary bg-primary/10 text-foreground')}
                              >
                                {hourLabel(h)}
                              </div>
                            );
                          })}
                        </div>
                      )}
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
      </div>
    </div>
  );
}
