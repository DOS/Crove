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
// Under a channel filter only that channel's chips show (#1044), and the gaps of its queue (#1158): its open slots, as
// dashed "Trống" chips (greyed while the queue is paused). An owner or admin drops an approved or scheduled channel on
// one to put it in exactly that slot (social.variant.schedule with slotAt); a draft dropped there, by a member too, gets
// the slot's time as its planned time. The chip's menu and the list's "Đặt ngày" offer the same slots by keyboard.
// One chip per post and minute (#1220): a post's channels at the same time are one chip naming the channels (or how
// many) and their statuses in words. A chip dragged moves its channels that may move (scheduled ones through
// social.variant.reschedule with the time shown, so a channel moved meanwhile is refused as stale, #956; drafts at the
// post's planned time through social.post.update), and the result names the channels that stayed and why. A day with
// more chips than it shows has a "+N" button opening a dialog with every post and channel of the day, their times and
// statuses, each with its link, its "Đặt ngày" or slot, and a tick for the bulk bar. A drop while a move is still
// running is refused and said so (#1044). The Social home keeps the month or week and its day in the address (#1300).
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useId, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { occasionsBetween, type Occasion } from '@crove/mod-social/contract';
import { useTranslations } from 'use-intl';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Checkbox } from '@crove/ui/components/checkbox';
import { Label } from '@crove/ui/components/label';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { RepeatIcon } from '@crove/ui/components/repeat-icon';
import { cn } from '@crove/ui/lib/utils';
import { DateInput } from './date-input.tsx';
import { TimeInput } from './time-input.tsx';
import { ErrorText, Spinner } from './ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';
import { providerName, VARIANT_TONE, variantStatusKey, variantTone } from '../lib/social.ts';
import {
  addDays,
  calendarGroups,
  calendarItems,
  DAY_MS,
  dayId,
  daysOutsideCampaign,
  DROP_HOURS,
  followsPlan,
  groupDrop,
  groupMovable,
  groupsByDay,
  groupStatuses,
  localMoment,
  notesByDay,
  planDrop,
  plannedAt,
  runGroupMove,
  slotDrop,
  slotRange,
  slotsByDay,
  slotVariant,
  startOfDay,
  viewDays,
  type CalendarGroup,
  type CalendarItem,
  type GroupMove,
  type GroupMoveResult,
  type OpenSlot,
  type PlanRequest,
  type PlanTarget,
  type SlotRequest,
  type View,
} from '../lib/social-calendar.ts';
import { NoteChip, NoteEditor, type NoteDraft } from './social-calendar-notes.tsx';
import { useLabels } from './social-labels.tsx';
import { PlanExportPanel } from './social-plan-export.tsx';
import { occasionStart, occasionsShown, setOccasionsShown } from '../lib/social-occasions.ts';

const excerpt = (text: string) => text.replace(/\s+/g, ' ').trim();

type Post = CalendarItem['post'];
// What is being dragged: a chip on the calendar (a post's channels at one time, #1220), or an undated draft from the
// list (#1145).
type Dragged = { kind: 'group'; key: string } | { kind: 'post'; id: string };
// A draft or channel opened in the date editor, with the text it is named by: item is the chip it was opened from (null:
// the undated list), and dates whether it may be given any date and time (a planned draft) or only an open slot (#1158).
type Planning = Omit<PlanTarget, 'post'> & { post: Post; text: string; item: CalendarItem | null; dates: boolean };
type Scheduling = Extract<SlotRequest, { kind: 'schedule' }>;
// The date and time typed in the date editor (#1350), kept by SocialCalendar for the target it was opened for.
type PlanDraft = { date: string; time: string };
const planKey = (target: Planning) => `${target.post.id}:${target.item?.v.id ?? ''}`;

// The undated drafts the list shows, the post list's default page.
const UNDATED_LIMIT = 50;

const hourLabel = (hour: number) => `${String(hour).padStart(2, '0')}:00`;

// A channel by its provider and, when it has one, its name.
function channelLabel(item: CalendarItem, names: Map<string, string>): string {
  const name = names.get(item.v.connectionId);
  return name ? `${providerName(item.v.provider)} (${name})` : providerName(item.v.provider);
}

const groupText = (group: CalendarGroup, empty: string) => excerpt((group.items[0] as CalendarItem).v.effective.body) || empty;

// One chip per post and minute (#1220): the time, the channel (or how many), the statuses in words and the text.
// picked: null shows a link to the post (dragged when a channel of it may move: scheduled ones by owners and admins,
// planned drafts by members too); true or false, picking (#1057), where a click ticks or unticks the chip's post for
// the bulk bar instead. onPlan: the chip's menu, which opens the date editor for a planned draft (#1145) or the open
// slots (#1158).
function Chip({
  group,
  slug,
  names,
  draggable,
  picked,
  onToggle,
  onDragStart,
  onDragEnd,
  onPlan,
  menu,
}: {
  group: CalendarGroup;
  slug: string;
  names: Map<string, string>;
  draggable: boolean;
  picked: boolean | null;
  onToggle: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onPlan: (() => void) | null;
  // What the menu does: change a draft's planned date, or put the channel in an open slot (#1158).
  menu: 'changeDate' | 'toSlot';
}) {
  const t = useTranslations('social');
  const f = useFormat();
  const start = (e: DragEvent) => {
    e.dataTransfer.setData('text/plain', `group:${group.key}`);
    e.dataTransfer.effectAllowed = 'move';
    onDragStart();
  };
  const first = group.items[0] as CalendarItem;
  // A series post or one of its copies (#979).
  const recurring = group.post.recurrence !== null || group.post.recurrenceSourceId !== null;
  const time = f.time(group.at.toISOString());
  const channels = group.items.length === 1 ? providerName(first.v.provider) : t('calendar.channels', { count: group.items.length });
  const statuses = groupStatuses(group)
    .map((s) => t(`status.${s.key}`))
    .join(', ');
  const title = [
    time,
    group.items.map((i) => `${channelLabel(i, names)}: ${t(`status.${variantStatusKey(i.v)}`)}`).join('; '),
    group.planned ? t('calendar.planned') : null,
    recurring ? t('calendar.recurring') : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const look = cn(
    'block overflow-hidden rounded-md border px-1.5 py-0.5 text-xs text-foreground transition-colors hover:border-ring/60',
    group.planned ? 'border-dashed bg-background text-muted-foreground' : 'bg-card',
    // Taken down from its platform (#860): still on its day, struck through.
    group.items.every((i) => i.v.status === 'removed') && 'text-muted-foreground line-through',
  );
  const text = groupText(group, t('emptyText'));
  // Two lines, so a narrow day still shows the text and, below it, the channels and their statuses.
  const content = (
    <>
      <span className="block truncate">
        <span className="font-mono tabular-nums">{time}</span>{' '}
        {recurring && (
          <>
            <RepeatIcon className="text-primary" />
            <span className="sr-only">{t('calendar.recurring')}</span>{' '}
          </>
        )}
        {text}
      </span>
      <span className="block truncate text-subtle-foreground">
        {channels} · {statuses}
      </span>
    </>
  );
  if (picked !== null) {
    return (
      <button
        type="button"
        aria-pressed={picked}
        title={title}
        onClick={onToggle}
        data-testid="calendar-chip"
        className={cn(look, 'w-full text-left focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none', picked && 'border-primary ring-2 ring-primary/60')}
      >
        {content}
      </button>
    );
  }
  const link = (
    <Link
      to="/o/$slug/social/$id"
      params={{ slug, id: group.post.id }}
      draggable={draggable}
      onDragStart={draggable ? start : undefined}
      onDragEnd={draggable ? onDragEnd : undefined}
      title={title}
      data-testid="calendar-chip"
      data-channels={group.items.length}
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
        aria-label={t(`calendar.${menu}Of`, { text })}
        title={t(`calendar.${menu}`)}
        className="inline-flex min-h-6 min-w-6 shrink-0 items-center justify-center rounded px-1 text-xs text-subtle-foreground opacity-0 group-hover/chip:opacity-100 hover:text-foreground focus-visible:opacity-100 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none max-sm:hidden"
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

// An open slot of the filtered channel's queue (#1158): a drop target for those who may plan or schedule, greyed while
// the queue is paused (a post put there waits until it runs again).
function SlotChip({ slot, paused, over, onDragOver, onDragLeave, onDrop }: { slot: OpenSlot; paused: boolean; over: boolean; onDragOver: ((e: DragEvent) => void) | undefined; onDragLeave: () => void; onDrop: ((e: DragEvent) => void) | undefined }) {
  const t = useTranslations('social.calendar');
  const f = useFormat();
  const title = [`${f.time(slot.at)} · ${t('slotOpen')}`, slot.label ? t('slotKept', { label: slot.label }) : null, paused ? t('slotPaused') : null].filter(Boolean).join(' · ');
  return (
    <div
      data-testid="open-slot"
      data-slot={slot.at}
      title={title}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={cn(
        'block truncate rounded-md border border-dashed bg-muted/40 px-1.5 py-0.5 text-xs text-subtle-foreground',
        paused && 'opacity-50',
        over && 'border-primary bg-primary/10 text-foreground',
      )}
    >
      <span className="font-mono tabular-nums">{f.time(slot.at)}</span> {t('slotOpen')}
      {slot.label && <span> · {slot.label}</span>}
      {paused && <span className="sr-only"> · {t('slotPaused')}</span>}
    </div>
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
// next full hour today) for an undated one. Under a channel filter, the open slots of its queue too (#1158): picking one
// does what a drop on it does (schedules: an owner or admin puts the channel in it; else the draft is planned then).
// draft: the date and time typed before the editor moved into the day's dialog or out of it (#1350), which remounts it.
function PlanEditor({
  target,
  busy,
  slots,
  schedules,
  draft,
  onDraft,
  onSave,
  onSlot,
  onClose,
}: {
  target: Planning;
  busy: boolean;
  slots: readonly OpenSlot[];
  schedules: boolean;
  draft: PlanDraft | null;
  onDraft: (draft: PlanDraft) => void;
  onSave: (request: PlanRequest) => void;
  onSlot: (slot: OpenSlot) => void;
  onClose: () => void;
}) {
  const t = useTranslations('social.calendar');
  const f = useFormat();
  const [picked, setSlotAt] = useState(slots[0]?.at ?? '');
  // The slots may load or change after the editor opens: the first one until another is picked.
  const slotAt = slots.some((s) => s.at === picked) ? picked : (slots[0]?.at ?? '');
  const [initial] = useState(() => {
    const now = new Date();
    return target.at ?? plannedAt(now, now) ?? plannedAt(addDays(startOfDay(now), 1), now) ?? now;
  });
  const [date, setDateOnly] = useState(draft?.date ?? dayId(initial));
  const [time, setTimeOnly] = useState(draft?.time ?? `${String(initial.getHours()).padStart(2, '0')}:${String(initial.getMinutes()).padStart(2, '0')}`);
  const setDate = (next: string) => {
    setDateOnly(next);
    onDraft({ date: next, time });
  };
  const setTime = (next: string) => {
    setTimeOnly(next);
    onDraft({ date, time: next });
  };
  const [past, setPast] = useState(false);
  return (
    <Card className="block space-y-3 p-4">
      <div>
        <h3 className="text-sm font-medium text-foreground">{t(target.dates ? 'planTitle' : 'slotTitle')}</h3>
        <p className="truncate text-xs text-subtle-foreground">{target.text}</p>
      </div>
      {slots.length > 0 && (
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            const slot = slots.find((s) => s.at === slotAt);
            if (slot && !busy) onSlot(slot);
          }}
        >
          <div className="space-y-1">
            <Label htmlFor="plan-slot" className="text-xs">
              {t('slotPick')}
            </Label>
            <NativeSelect id="plan-slot" autoFocus={!target.dates} value={slotAt} onChange={(e) => setSlotAt(e.target.value)} className="w-64">
              {slots.map((s) => (
                <NativeSelectOption key={s.at} value={s.at}>
                  {f.dateTime(s.at)}
                  {s.label ? ` · ${s.label}` : ''}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={busy}>
              {t(schedules ? 'slotSchedule' : 'slotPlan')}
            </Button>
            {!target.dates && (
              <Button type="button" size="sm" variant="ghost" onClick={onClose}>
                {t('planCancel')}
              </Button>
            )}
          </div>
        </form>
      )}
      {!target.dates && slots.length === 0 && <p className="text-xs text-subtle-foreground">{t('slotNone')}</p>}
      {target.dates && (
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
            <DateInput id="plan-date" autoFocus required value={date} min={dayId(new Date())} onChange={setDate} className="w-40" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="plan-time" className="text-xs">
              {t('planTime')}
            </Label>
            <TimeInput id="plan-time" required value={time} onChange={setTime} className="w-28" />
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
      )}
      {past && <ErrorText>{t('planPast')}</ErrorText>}
    </Card>
  );
}

// What a chip's drag did (#1220): how many channels moved and to when, each channel that stayed and why, and each
// refusal with the server's message (STALE_REVISION when a channel's time changed meanwhile, #956).
function MoveResult({ result, names }: { result: GroupMoveResult; names: Map<string, string> }) {
  const t = useTranslations('social.calendar');
  const f = useFormat();
  return (
    <div className="space-y-0.5">
      <p>{t('groupDone', { count: result.moved.length, when: f.dateTime(result.at.toISOString()) })}</p>
      {result.alongside.length > 0 && <p>{t('groupAlongside', { channels: result.alongside.map((i) => channelLabel(i, names)).join(', ') })}</p>}
      {result.stayed.map((s) => (
        <p key={s.item.v.id}>{t('groupStayed', { channel: channelLabel(s.item, names), reason: t(`stay.${s.reason}`) })}</p>
      ))}
      {result.refused.map((x) => (
        <p key={x.item.v.id}>
          {t('groupRefused', { channel: channelLabel(x.item, names) })} <span className="text-warning">{errorMessage(x.error)}</span>
        </p>
      ))}
    </div>
  );
}

// Every post and channel of a day (#1220), opened by its "+N": a modal dialog, as the command palette is, so focus stays
// in it, Esc closes it, and the focus goes back to the button that opened it (DESIGN 4.5). It starts on the heading, so
// a long day is read from the top. Each row links to its post and carries what the chip's menu and picking offer
// (actions). children: the date editor and the notices, shown here while the dialog is open. returnTo (#1233): where
// the focus goes on close, asked then, since the "+N" may be gone by then (the day now shows every chip) and Safari on
// macOS does not focus a button on click; without it, the element that had the focus when the dialog opened.
export function DayDialog({
  title,
  groups,
  slug,
  names,
  editing,
  actions,
  onClose,
  returnTo,
  children,
}: {
  title: string;
  groups: readonly CalendarGroup[];
  slug: string;
  names: Map<string, string>;
  editing: boolean;
  actions: (group: CalendarGroup, text: string) => ReactNode;
  onClose: () => void;
  returnTo?: () => HTMLElement | null;
  children: ReactNode;
}) {
  const back = useRef(returnTo);
  useEffect(() => {
    back.current = returnTo;
  });
  const t = useTranslations('social');
  const f = useFormat();
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const headingId = useId();
  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!el.open) el.showModal();
    heading.current?.focus();
    return () => {
      if (el.open) el.close();
      const to = back.current ? back.current() : trigger;
      if (to?.isConnected) to.focus();
    };
  }, []);
  // The editor closed (saved or cancelled): the focus, left on a button now gone, goes back to the top.
  const wasEditing = useRef(editing);
  useEffect(() => {
    if (wasEditing.current && !editing) heading.current?.focus();
    wasEditing.current = editing;
  }, [editing]);
  return (
    <dialog
      ref={dialog}
      aria-labelledby={headingId}
      onClose={onClose}
      // A click on the backdrop lands on the dialog element itself.
      onClick={(e) => e.target === dialog.current && onClose()}
      className="m-auto max-h-[calc(100dvh-2rem)] w-[min(40rem,calc(100vw-2rem))] overflow-y-auto rounded-xl border bg-popover p-0 text-popover-foreground shadow-2xl backdrop:bg-background/70"
    >
      <div className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b bg-popover px-4 py-3">
        <h3 ref={heading} id={headingId} tabIndex={-1} className="text-sm font-medium text-foreground outline-none first-letter:uppercase">
          {title}
        </h3>
        <Button size="sm" variant="ghost" onClick={onClose}>
          {t('calendar.dayClose')}
        </Button>
      </div>
      <div className="space-y-3 p-4">
        {children}
        {groups.length === 0 ? (
          <p className="text-sm text-subtle-foreground">{t('calendar.dayEmpty')}</p>
        ) : (
          <ul className="space-y-2">
            {groups.map((g) => {
              const text = groupText(g, t('emptyText'));
              return (
                <li key={g.key} data-testid="day-post" className="space-y-2 rounded-lg border p-2.5">
                  <div className="flex min-w-0 items-baseline gap-2">
                    <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">{f.time(g.at.toISOString())}</span>
                    <Link to="/o/$slug/social/$id" params={{ slug, id: g.post.id }} className="min-w-0 flex-1 truncate text-sm text-foreground hover:underline">
                      {text}
                    </Link>
                    {g.planned && <span className="shrink-0 text-xs text-subtle-foreground">{t('calendar.plannedTime')}</span>}
                  </div>
                  <ul className="flex flex-wrap gap-1" aria-label={t('calendar.dayChannels')}>
                    {g.items.map((i) => (
                      <li key={i.v.id}>
                        <Badge variant={variantTone(i.v)}>
                          {channelLabel(i, names)} · {t(`status.${variantStatusKey(i.v)}`)}
                        </Badge>
                      </li>
                    ))}
                  </ul>
                  {actions(g, text)}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </dialog>
  );
}

// filters: the Social home's post filters (label #639, channel, text, mine #640), the same as the lists and the board
// (#1022). canWrite: may add and change notes on dates (#794) and plan drafts (#1145).
export type CalendarFilters = { connectionId?: string; labelId?: string; search?: string; assignee?: string; author?: string };
// The month or week shown and its day (YYYY-MM-DD), kept in the address by the Social home (#1300); date undefined is
// today.
export interface CalendarPeriod {
  view?: View | undefined;
  date?: string | undefined;
}
// bulk: the bulk bar for the posts picked in the month or week shown, with a way to clear them; without it, no picking.
// period and onPeriod: the period shown, held by the caller; without them the calendar holds it itself.
export function SocialCalendar({
  slug,
  names,
  canDecide,
  canWrite,
  filters = {},
  bulk,
  period,
  onPeriod,
}: {
  slug: string;
  names: Map<string, string>;
  canDecide: boolean;
  canWrite: boolean;
  filters?: CalendarFilters;
  bulk?: ((posts: Post[], clear: () => void) => ReactNode) | undefined;
  period?: CalendarPeriod;
  onPeriod?: (next: CalendarPeriod) => void;
}) {
  const t = useTranslations('social');
  const f = useFormat();
  const navigate = useNavigate();
  const [ownPeriod, setOwnPeriod] = useState<CalendarPeriod>({});
  const shownPeriod = onPeriod ? (period ?? {}) : ownPeriod;
  const view: View = shownPeriod.view ?? 'month';
  const anchorDay = shownPeriod.date;
  const anchor = useMemo(() => {
    const m = anchorDay ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(anchorDay) : null;
    return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : startOfDay(new Date());
  }, [anchorDay]);
  const setPeriod = (next: CalendarPeriod) => (onPeriod ? onPeriod(next) : setOwnPeriod(next));
  // Today is no date in the address, so a link without one always opens on the day it is opened.
  const setView = (next: View) => setPeriod({ view: next === 'month' ? undefined : next, date: anchorDay });
  const setAnchor = (day: Date) => setPeriod({ view: shownPeriod.view, date: dayId(day) === dayId(new Date()) ? undefined : dayId(day) });
  const days = useMemo(() => viewDays(view, anchor), [view, anchor]);
  const range = useMemo(() => ({ from: (days[0] as Date).toISOString(), to: addDays(days.at(-1) as Date, 1).toISOString() }), [days]);
  const posts = useQuery(orpc.social.posts.list.queryOptions({ input: { ...range, ...filters, limit: 200 } }));
  const connectionId = filters.connectionId;
  // Under a channel filter, only that channel's chips (#1044); a post's channels at one time are one chip (#1220).
  const groups = useMemo(() => calendarGroups(calendarItems(posts.data ?? [], connectionId)), [posts.data, connectionId]);
  // And the open slots of its queue that the view shows from now on (#1158); the range is read once per view, so the
  // query keeps its key while the view stays.
  const slotWindow = useMemo(() => (connectionId ? slotRange(view, days, anchor, new Date()) : null), [connectionId, view, days, anchor]);
  const slots = useQuery({
    ...orpc.social.queues.openSlots.queryOptions({ input: { connectionId: connectionId ?? '', from: slotWindow?.from ?? '', to: slotWindow?.to ?? '' } }),
    enabled: connectionId !== undefined && slotWindow !== null,
  });
  const openSlots = useMemo(() => (connectionId && slotWindow ? (slots.data?.slots ?? []) : []), [connectionId, slotWindow, slots.data]);
  const slotsOn = useMemo(() => slotsByDay(openSlots), [openSlots]);
  const queuePaused = slots.data?.paused ?? false;
  // The drafts with no time yet, under the same filters (#1145), for those who may plan them.
  const undated = useQuery({ ...orpc.social.posts.list.queryOptions({ input: { undated: true, ...filters, limit: UNDATED_LIMIT } }), enabled: canWrite });
  const notes = useQuery(orpc.social.calendarNotes.list.queryOptions({ input: { from: dayId(days[0] as Date), to: dayId(days.at(-1) as Date) } }));
  const notesOn = useMemo(() => notesByDay(notes.data ?? [], days), [notes.data, days]);
  // Under a campaign label's filter (#1169), the days outside its dates are shaded.
  const labelList = useLabels();
  const campaign = filters.labelId ? (labelList.data ?? []).find((l) => l.id === filters.labelId) : undefined;
  const offCampaign = useMemo(() => daysOutsideCampaign(campaign, days), [campaign, days]);
  const [noteDraft, setNoteDraft] = useState<NoteDraft | null>(null);
  // The content plan export (#978), for members and above.
  const [exporting, setExporting] = useState(false);
  const byDay = useMemo(() => groupsByDay(groups), [groups]);
  // The day whose full list is open (#1220).
  const [dayOpen, setDayOpen] = useState<string | null>(null);
  // Where the focus goes back when the day's list closes (#1233): its "+N", or the day itself once the "+N" is gone.
  const moreButtons = useRef(new Map<string, HTMLButtonElement>());
  const dayCells = useRef(new Map<string, HTMLDivElement>());
  const keep = <E extends HTMLElement>(map: Map<string, E>, id: string) => (el: E | null) => void (el ? map.set(id, el) : map.delete(id));
  const focusBackTo = (id: string) => () => {
    const more = moreButtons.current.get(id);
    return more?.isConnected ? more : (dayCells.current.get(id) ?? null);
  };
  const [over, setOver] = useState<string | null>(null);
  const [dragged, setDragged] = useState<Dragged | null>(null);
  // Set after the drag has started: changing the page in dragstart itself ends some browsers' drag at once.
  const beginDrag = (what: Dragged) => void setTimeout(() => setDragged(what), 0);
  const [refusal, setRefusal] = useState<'dropPast' | 'planPast' | 'slotLabel' | null>(null);
  const [planning, setPlanning] = useState<Planning | null>(null);
  // What the open date editor holds (#1350), by its target's key: it survives "+N" opening or closing the day's dialog.
  const [planDraft, setPlanDraft] = useState<(PlanDraft & { key: string }) | null>(null);
  useEffect(() => {
    if (!planning) setPlanDraft(null);
  }, [planning]);
  const [done, setDone] = useState<string | null>(null);
  const [moved, setMoved] = useState<GroupMoveResult | null>(null);
  // A drop while a move is still running, said rather than dropped silently (#1044).
  const [blocked, setBlocked] = useState(false);
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
  // A chip's channels moved by a drag (#1220): each scheduled one with the time it was shown at (#956), then the drafts'
  // planned time; runGroupMove keeps each refusal for the result.
  const move = useMutation({
    mutationFn: (m: GroupMove) =>
      runGroupMove(m, {
        reschedule: (request) => client.social.variants.reschedule(request),
        plan: (request) => client.social.posts.update(request),
      }),
    onSuccess: (result) => setMoved(result),
    onSettled: () => {
      setBlocked(false);
      void queryClient.invalidateQueries();
    },
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
    onSettled: () => {
      setBlocked(false);
      void queryClient.invalidateQueries();
    },
  });
  // A channel put in exactly an open slot (#1158); the server checks the slot again under the queue's lock.
  const slotting = useMutation({
    mutationFn: (r: Scheduling) => client.social.variants.schedule({ postId: r.postId, variantIds: [r.variantId], queue: true, slotAt: r.slotAt }),
    onSuccess: (_, r) => {
      setPlanning((open) => (open && open.post.id !== r.postId ? open : null));
      setDone(t('calendar.slotDone', { when: f.dateTime(r.slotAt) }));
    },
    onSettled: () => {
      setBlocked(false);
      void queryClient.invalidateQueries();
    },
  });
  const pending = move.isPending || plan.isPending || slotting.isPending;
  const clearNotices = () => {
    move.reset();
    plan.reset();
    slotting.reset();
    setRefusal(null);
    setDone(null);
    setMoved(null);
    setBlocked(false);
  };
  const sendPlan = (request: PlanRequest | 'past' | null) => {
    if (request === null || plan.isPending) return;
    if (request === 'past') {
      setRefusal('planPast');
      return;
    }
    plan.mutate(request);
  };
  const sendSlot = (request: SlotRequest | 'past' | 'label' | null) => {
    if (request === null || slotting.isPending) return;
    if (request === 'past' || request === 'label') {
      setRefusal(request === 'past' ? 'planPast' : 'slotLabel');
      return;
    }
    if (request.kind === 'plan') sendPlan(request.request);
    else slotting.mutate(request);
  };
  // What a slot drop or pick acts on: an undated draft of the list, or a chip (under the channel filter, its channel).
  const slotTargetOf = (what: Dragged) => {
    if (what.kind === 'post') {
      const post = (undated.data ?? []).find((p) => p.id === what.id);
      return post ? { post, item: null } : null;
    }
    const group = groups.find((g) => g.key === what.key);
    const item = group ? (group.items.find((i) => i.v.connectionId === connectionId) ?? group.items[0]) : undefined;
    return group && item ? { post: group.post, item } : null;
  };
  const may = { canDecide, canWrite };
  const today = dayId(new Date());
  const shift = (n: number) => setAnchor(view === 'month' ? new Date(anchor.getFullYear(), anchor.getMonth() + n, 1) : addDays(anchor, 7 * n));
  const draggedOf = (e: DragEvent): Dragged | null => {
    const data = e.dataTransfer.getData('text/plain');
    return dragged ?? (data.startsWith('post:') ? { kind: 'post', id: data.slice(5) } : data.startsWith('group:') ? { kind: 'group', key: data.slice(6) } : null);
  };
  // A drop on an open slot of the filtered channel's queue (#1158).
  const dropOnSlot = (slot: OpenSlot) => (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setOver(null);
    const what = draggedOf(e);
    setDragged(null);
    const target = what ? slotTargetOf(what) : null;
    if (!target || !connectionId) return;
    if (pending) {
      setBlocked(true);
      return;
    }
    clearNotices();
    sendSlot(slotDrop(target, slot, connectionId, may, new Date()));
  };
  // A drop on a day, or on one of its hours in week view.
  const drop = (day: Date, hour?: number) => (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setOver(null);
    const what = draggedOf(e);
    setDragged(null);
    if (!what) return;
    if (pending) {
      setBlocked(true);
      return;
    }
    clearNotices();
    const now = new Date();
    if (what.kind === 'post') {
      const post = (undated.data ?? []).find((p) => p.id === what.id);
      if (post && canWrite) sendPlan(planDrop({ post, at: null }, day, now, hour));
      return;
    }
    const group = groups.find((g) => g.key === what.key);
    if (!group) return;
    const request = groupDrop(group, day, now, may, hour);
    // Today, at a time already gone: say so here rather than ask the server.
    if (request === 'past') setRefusal('dropPast');
    else if (request) move.mutate(request);
  };
  const openPlan = (target: Planning) => {
    clearNotices();
    setPlanDraft(null);
    setPlanning(target);
  };
  // What a chip's menu, and its row in the day's list, opens (#1145, #1158): the date editor for a draft at its post's
  // planned time, else the open slots for a channel an owner or admin may put in one; null when neither applies.
  const menuOf = (group: CalendarGroup): Planning | null => {
    const text = groupText(group, t('emptyText'));
    const plannable = canWrite ? group.items.find(followsPlan) : undefined;
    if (plannable) return { post: group.post, at: plannable.at, text, item: plannable, dates: true };
    const slottable =
      canDecide && connectionId !== undefined && openSlots.length > 0 ? group.items.find((i) => slotVariant({ post: group.post, item: i }, connectionId) !== null) : undefined;
    return slottable ? { post: group.post, at: slottable.at, text, item: slottable, dates: false } : null;
  };
  // A tick in the day's list starts picking, keeping what was picked.
  const pickFromDay = (postId: string) => {
    setPicking(true);
    togglePick(postId);
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
  // The date editor and the notices stand above the calendar, or in the day's list while it is open (the page behind a
  // modal dialog cannot be reached).
  const editor = planning && (
    <PlanEditor
      key={planKey(planning)}
      target={planning}
      busy={plan.isPending || slotting.isPending}
      slots={openSlots}
      schedules={canDecide && connectionId !== undefined && slotVariant(planning, connectionId) !== null}
      draft={planDraft?.key === planKey(planning) ? planDraft : null}
      onDraft={(next) => setPlanDraft({ key: planKey(planning), ...next })}
      onSave={sendPlan}
      onSlot={(slot) => connectionId && sendSlot(slotDrop(planning, slot, connectionId, may, new Date()))}
      onClose={() => setPlanning(null)}
    />
  );
  const notices = (
    <>
      {notes.error && <ErrorText>{errorMessage(notes.error)}</ErrorText>}
      {move.error && <ErrorText>{errorMessage(move.error)}</ErrorText>}
      {plan.error && <ErrorText>{errorMessage(plan.error)}</ErrorText>}
      {slotting.error && <ErrorText>{errorMessage(slotting.error)}</ErrorText>}
      {slots.error && <ErrorText>{errorMessage(slots.error)}</ErrorText>}
      {refusal && <ErrorText>{t(`calendar.${refusal}`)}</ErrorText>}
      <div role="status" className={cn('text-xs text-muted-foreground', !blocked && !done && !moved && 'sr-only')}>
        {blocked ? <p>{t('calendar.busy')}</p> : done ? <p>{done}</p> : moved ? <MoveResult result={moved} names={names} /> : null}
      </div>
    </>
  );
  const openGroups = dayOpen ? (byDay.get(dayOpen) ?? []) : [];

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
      {/* Under a channel filter a chip is that channel alone, but a draft's planned time is the post's (#1233). */}
      {!picking && canWrite && connectionId !== undefined && <p className="text-xs text-subtle-foreground">{t('calendar.filteredDragHint')}</p>}
      {!picking && canWrite && openSlots.length > 0 &&<p className="text-xs text-subtle-foreground">{t(canDecide ? 'calendar.slotHint' : 'calendar.slotHintMember')}</p>}
      {noteDraft && <NoteEditor key={'note' in noteDraft ? noteDraft.note.id : noteDraft.day} draft={noteDraft} onClose={() => setNoteDraft(null)} />}
      {exporting && canWrite && <PlanExportPanel slug={slug} month={anchor} onClose={() => setExporting(false)} />}
      {!dayOpen && editor}
      {!dayOpen && notices}
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
              onPlan={(post, text) => openPlan({ post, at: null, text, item: null, dates: true })}
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
              {campaign && (campaign.startsOn || campaign.endsOn) && (
                <p className="text-xs text-muted-foreground">
                  {t('calendar.campaignShade', {
                    name: campaign.name,
                    period:
                      campaign.startsOn && campaign.endsOn
                        ? t('labels.period', { from: f.date(campaign.startsOn), to: f.date(campaign.endsOn) })
                        : campaign.startsOn
                          ? t('labels.periodFrom', { from: f.date(campaign.startsOn) })
                          : t('labels.periodTo', { to: f.date(campaign.endsOn) }),
                  })}
                </p>
              )}
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
                  const off = offCampaign.has(id);
                  const past = startOfDay(d).getTime() + DAY_MS <= Date.now();
                  // Past days take no drop (#1145): nothing is planned or moved into the past.
                  const target = canWrite && !past;
                  // While something is dragged in week view, the hours still ahead on this day are drop targets too.
                  const hours = view === 'week' && dragged && target ? DROP_HOURS.filter((h) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), h).getTime() > Date.now()) : [];
                  return (
                    <div
                      key={id}
                      data-day={id}
                      ref={keep(dayCells.current, id)}
                      // Focusable by script only: where the focus lands when the day's list closes and its "+N" is gone.
                      tabIndex={-1}
                      onDragOver={target ? (e) => (e.preventDefault(), setOver(id)) : undefined}
                      onDragLeave={() => setOver((o) => (o === id ? null : o))}
                      onDrop={target ? drop(d) : undefined}
                      title={off ? t('calendar.outsideCampaign') : undefined}
                      data-off-campaign={off || undefined}
                      className={cn(
                        'group flex min-h-24 flex-col gap-1 bg-background p-1.5 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset',
                        outside && 'bg-muted/40',
                        off && 'bg-muted/80',
                        over === id && 'ring-2 ring-primary ring-inset',
                        view === 'week' && 'sm:min-h-64',
                      )}
                    >
                      <div className="flex items-center justify-between">
                        <span className={cn('text-xs tabular-nums', id === today ? 'rounded-full bg-primary px-1.5 font-semibold text-primary-foreground' : outside ? 'text-subtle-foreground' : 'text-muted-foreground')}>
                          {view === 'week' ? <span className="sm:hidden">{f.weekdayShort(d.toISOString())} </span> : null}
                          {d.getDate()}
                          {off && <span className="sr-only"> ({t('calendar.outsideCampaign')})</span>}
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
                      {list.slice(0, shown).map((group) => {
                        // The menu: a planned draft's date, or (under a channel filter with open slots, for an owner or
                        // admin) a slot of the queue.
                        const target = menuOf(group);
                        return (
                          <Chip
                            key={group.key}
                            group={group}
                            slug={slug}
                            names={names}
                            draggable={!picking && groupMovable(group, may)}
                            picked={picking && bulk ? picked.has(group.post.id) : null}
                            onToggle={() => togglePick(group.post.id)}
                            onDragStart={() => beginDrag({ kind: 'group', key: group.key })}
                            onDragEnd={() => setDragged(null)}
                            onPlan={target ? () => openPlan(target) : null}
                            menu={target?.dates ? 'changeDate' : 'toSlot'}
                          />
                        );
                      })}
                      {/* The chips past those shown open in the day's full list, by pointer and keyboard (#1220). */}
                      {list.length > shown && (
                        <button
                          type="button"
                          aria-haspopup="dialog"
                          ref={keep(moreButtons.current, id)}
                          onClick={() => setDayOpen(id)}
                          data-testid="calendar-more"
                          className="inline-flex min-h-6 self-start items-center rounded px-1.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
                        >
                          {t('calendar.more', { count: list.length - shown })}
                          <span className="sr-only"> {t('calendar.moreOf', { day: f.date(id) })}</span>
                        </button>
                      )}
                      {(slotsOn.get(id) ?? []).slice(0, shown).map((slot) => {
                        const key = `slot:${slot.at}`;
                        return (
                          <SlotChip
                            key={slot.at}
                            slot={slot}
                            paused={queuePaused}
                            over={over === key}
                            onDragOver={
                              target
                                ? (e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    setOver(key);
                                  }
                                : undefined
                            }
                            onDragLeave={() => setOver((o) => (o === key ? null : o))}
                            onDrop={target ? dropOnSlot(slot) : undefined}
                          />
                        );
                      })}
                      {(slotsOn.get(id)?.length ?? 0) > shown && (
                        <span className="text-xs text-subtle-foreground">{t('calendar.moreSlots', { count: (slotsOn.get(id)?.length ?? 0) - shown })}</span>
                      )}
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
                {openSlots.length > 0 && <span className={cn('rounded-md border border-dashed bg-muted/40 px-1.5', queuePaused && 'opacity-50')}>{t(queuePaused ? 'calendar.slotLegendPaused' : 'calendar.slotLegend')}</span>}
              </div>
              {slots.data?.capped && <p className="text-xs text-subtle-foreground">{t('calendar.slotsCapped')}</p>}
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
      {dayOpen && (
        <DayDialog
          title={t('calendar.dayTitle', { day: f.date(dayOpen) })}
          groups={openGroups}
          slug={slug}
          names={names}
          editing={planning !== null}
          onClose={() => setDayOpen(null)}
          returnTo={focusBackTo(dayOpen)}
          actions={(group, text) => {
            const target = menuOf(group);
            if (!target && !bulk) return null;
            return (
              <div className="flex flex-wrap items-center gap-3">
                {target && (
                  <Button size="sm" variant="outline" aria-label={t(target.dates ? 'calendar.setDateOf' : 'calendar.toSlotOf', { text })} onClick={() => openPlan(target)}>
                    {t(target.dates ? 'calendar.setDate' : 'calendar.toSlot')}
                  </Button>
                )}
                {bulk && (
                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Checkbox checked={picked.has(group.post.id)} onCheckedChange={() => pickFromDay(group.post.id)} aria-label={t('bulk.select', { text })} />
                    {t('calendar.dayPick')}
                  </label>
                )}
              </div>
            );
          }}
        >
          {editor}
          {notices}
        </DayDialog>
      )}
    </div>
  );
}
