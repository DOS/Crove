// Two helpers of a channel's queue editor (#1166). *Gợi ý từ giờ đẹp* adds the channel's best weekday-and-hour slots
// (#980, from the same 90-day metrics summary) to the editor's draft, in the queue's own time zone and never one the
// queue has; the person edits the draft and saves it. *Sao chép sang kênh khác* copies the saved slots, their content
// categories (#745) and the time zone to the channels picked, one `social.queue.set` each, after a confirmation that
// shows each target's slots now and how many of its queued posts the copy places again.
import { useMutation, useQueries, useQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { useTranslations } from 'use-intl';
import { Button } from '@crove/ui/components/button';
import { Checkbox } from '@crove/ui/components/checkbox';
import { ChannelSetPicker } from './social-channel-sets.tsx';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';
import { providerName } from '../lib/social.ts';
import { BEST_TIME_DAYS, BEST_TIME_MIN_POSTS, knownZone, queueSuggestions, type QueueSuggestion } from '../lib/social-best-time.ts';
import { COPY_POSTS_LIMIT, copyQueue, replacedCount, type CopyResult, type CopySlot } from '../lib/social-queue-copy.ts';

type Channel = { id: string; provider: string; displayName: string };

export function QueueSuggestButton({ connectionId, timeZone, slots, onSuggest }: { connectionId: string; timeZone: string; slots: readonly { weekday: number; minute: number }[]; onSuggest: (slots: QueueSuggestion[]) => void }) {
  const t = useTranslations('social.queueTools');
  const id = useId();
  // Shared with the "Giờ đẹp" buttons and the other queues on the page.
  const history = useQuery({ ...orpc.social.metrics.summary.queryOptions({ input: { days: BEST_TIME_DAYS } }), staleTime: 10 * 60_000 });
  const zone = knownZone(timeZone);
  const found = history.data ? queueSuggestions(history.data, connectionId, zone, slots) : null;
  const reason = history.error
    ? t('suggestError')
    : found?.state === 'few'
      ? t('suggestFew', { min: String(BEST_TIME_MIN_POSTS), posts: String(found.posts) })
      : found?.state === 'none'
        ? t('suggestNone')
        : found?.state === 'had'
          ? t('suggestHad')
          : null;
  return (
    <>
      {/* A disabled button takes no pointer events, so the reason sits on its wrapper. */}
      <span title={reason ?? t('suggestHint', { days: String(BEST_TIME_DAYS), zone })}>
        <Button type="button" variant="outline" size="sm" disabled={found?.state !== 'ready'} aria-describedby={reason ? `${id}-why` : undefined} onClick={() => found?.state === 'ready' && onSuggest(found.slots)}>
          {t('suggest')}
        </Button>
      </span>
      {reason && (
        <span id={`${id}-why`} className="sr-only">
          {reason}
        </span>
      )}
    </>
  );
}

export interface CopyRow {
  connectionId: string;
  name: string;
  loading: boolean;
  error: string | null;
  slots: number | null;
  replaced: number | null;
  // Queued posts that would find no free slot and leave the queue.
  unqueued?: number;
  // The post list came back full: the count is at least this many.
  partial: boolean;
}

// What a copy will do, target by target, before anything changes.
export function QueueCopyConfirm({ source, zone, slots, rows, pending, onConfirm, onCancel }: { source: string; zone: string; slots: number; rows: readonly CopyRow[]; pending: boolean; onConfirm: () => void; onCancel: () => void }) {
  const t = useTranslations('social.queueTools');
  const ready = rows.length > 0 && rows.every((r) => !r.loading && r.error === null);
  return (
    <div role="group" aria-label={t('copyConfirmLabel')} className="space-y-2 rounded-lg border border-warning/40 bg-warning/5 p-3">
      <p className="text-sm text-foreground">{t('copyConfirmTitle', { count: rows.length, slots, channel: source, zone })}</p>
      <ul className="space-y-1 text-xs text-muted-foreground">
        {rows.map((r) => (
          <li key={r.connectionId}>
            <span className="font-medium text-foreground">{r.name}</span>:{' '}
            {r.loading ? t('copyLoading') : r.error !== null ? <span className="text-destructive">{r.error}</span> : `${t('copyTargetSlots', { slots: r.slots ?? 0 })}; ${r.partial ? t('copyTargetReplacedAtLeast', { count: r.replaced ?? 0 }) : t('copyTargetReplaced', { count: r.replaced ?? 0 })}${(r.unqueued ?? 0) > 0 ? `; ${t('copyTargetUnqueued', { count: r.unqueued ?? 0 })}` : ''}.`}
          </li>
        ))}
      </ul>
      <p className="text-xs text-subtle-foreground">{t('copyConfirmHint')}</p>
      <div className="flex flex-wrap gap-2">
        <Button variant="destructive" size="sm" disabled={!ready || pending} onClick={onConfirm}>
          {t('copyConfirm', { count: rows.length })}
        </Button>
        <Button variant="ghost" size="sm" disabled={pending} onClick={onCancel}>
          {t('copyCancel')}
        </Button>
      </div>
    </div>
  );
}

// Each target's outcome in words.
export function QueueCopyResults({ results, names }: { results: readonly CopyResult[]; names: ReadonlyMap<string, string> }) {
  const t = useTranslations('social.queueTools');
  return (
    <ul role="status" className="space-y-1 text-xs">
      {results.map((r) => {
        const channel = names.get(r.connectionId) ?? r.connectionId;
        return r.ok ? (
          <li key={r.connectionId} className="text-muted-foreground">
            {t('copyDone', { channel, moved: r.moved })}
            {r.unqueued > 0 && ` ${t('copyUnqueued', { count: r.unqueued })}`}
          </li>
        ) : (
          <li key={r.connectionId} className="text-destructive">
            {t('copyFailed', { channel, error: r.message })}
          </li>
        );
      })}
    </ul>
  );
}

// Owners and admins only, as `social.queue.set`; targets are the other live channels the person may use (#1081).
export function QueueCopy({ source, saved, targets, unsaved, canEdit }: { source: Channel; saved: { timeZone: string; slots: readonly CopySlot[] } | null; targets: readonly Channel[]; unsaved: boolean; canEdit: boolean }) {
  const t = useTranslations('social.queueTools');
  const ts = useTranslations('social');
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  // The instant the confirmation was opened: the queued posts from then on are the ones it counts.
  const [reviewAt, setReviewAt] = useState<number | null>(null);
  const names = new Map(targets.map((c) => [c.id, `${providerName(c.provider)} · ${c.displayName}`]));
  const reviewing = reviewAt === null ? [] : picked;
  const queues = useQueries({ queries: reviewing.map((connectionId) => orpc.social.queues.get.queryOptions({ input: { connectionId } })) });
  const lists = useQueries({
    queries: reviewing.map((connectionId) => orpc.social.posts.list.queryOptions({ input: { connectionId, from: new Date(reviewAt ?? 0).toISOString(), limit: COPY_POSTS_LIMIT } })),
  });
  const copy = useMutation({
    mutationFn: (spec: { timeZone: string; slots: readonly CopySlot[] }) => copyQueue(picked, spec, (input) => client.social.queues.set(input), errorMessage),
    onSuccess: () => {
      setReviewAt(null);
      setOpen(false);
      setPicked([]);
      void queryClient.invalidateQueries();
    },
  });
  if (!canEdit) return null;
  const empty = !saved || saved.slots.length === 0;
  const blocked = unsaved ? ts('saveQueueFirst') : empty ? t('copyEmpty') : targets.length === 0 ? t('copyNoTargets') : null;
  const next = saved ? { timeZone: saved.timeZone, slots: saved.slots.map((s) => ({ weekday: s.weekday, minute: s.minute, labelId: s.labelId ?? null })) } : null;
  const rows: CopyRow[] = reviewing.map((connectionId, i) => {
    const q = queues[i];
    const l = lists[i];
    const error = q?.error ?? l?.error ?? null;
    const before = q?.data ? (q.data.queueId && q.data.timeZone ? { timeZone: q.data.timeZone, slots: q.data.slots.filter((s) => s.active).map((s) => ({ weekday: s.weekday, minute: s.minute, labelId: s.labelId })) } : null) : undefined;
    const counts = before !== undefined && l?.data && next && reviewAt !== null ? replacedCount(l.data, connectionId, before, next, reviewAt) : null;
    return {
      connectionId,
      name: names.get(connectionId) ?? connectionId,
      loading: !error && (!q?.data || !l?.data),
      error: error ? errorMessage(error) : null,
      slots: q?.data ? q.data.slots.length : null,
      replaced: counts?.moved ?? null,
      unqueued: counts?.unqueued ?? 0,
      partial: (l?.data?.length ?? 0) >= COPY_POSTS_LIMIT,
    };
  });
  return (
    <div className="space-y-2 border-t pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <span title={blocked ?? undefined}>
          <Button variant="outline" size="sm" disabled={blocked !== null || copy.isPending} aria-expanded={open} onClick={() => (open ? (setOpen(false), setReviewAt(null)) : setOpen(true))}>
            {t('copy')}
          </Button>
        </span>
        {blocked && <span className="text-xs text-subtle-foreground">{blocked}</span>}
      </div>
      {open && blocked === null && saved && reviewAt === null && (
        <div className="space-y-2">
          <p className="text-xs text-subtle-foreground">{t('copyHint', { slots: saved.slots.length, zone: saved.timeZone })}</p>
          <ChannelSetPicker live={targets} onPick={setPicked} />
          <div role="group" aria-label={t('copyPick')} className="flex flex-wrap gap-3">
            {targets.map((c) => (
              <label key={c.id} className="flex items-center gap-2 text-sm text-muted-foreground">
                <Checkbox checked={picked.includes(c.id)} onCheckedChange={(on) => setPicked(on === true ? [...picked, c.id] : picked.filter((x) => x !== c.id))} />
                {names.get(c.id)}
              </label>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="ghost" size="sm" onClick={() => setPicked(picked.length === targets.length ? [] : targets.map((c) => c.id))}>
              {picked.length === targets.length ? t('copyPickNone') : t('copyPickAll')}
            </Button>
            <Button size="sm" disabled={picked.length === 0} onClick={() => setReviewAt(Date.now())}>
              {t('copyReview')}
            </Button>
          </div>
        </div>
      )}
      {open && blocked === null && saved && reviewAt !== null && (
        <QueueCopyConfirm
          source={source.displayName}
          zone={saved.timeZone}
          slots={saved.slots.length}
          rows={rows}
          pending={copy.isPending}
          onConfirm={() => copy.mutate(saved)}
          onCancel={() => setReviewAt(null)}
        />
      )}
      {copy.data && <QueueCopyResults results={copy.data} names={names} />}
    </div>
  );
}
