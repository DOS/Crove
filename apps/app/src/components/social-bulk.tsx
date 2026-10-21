// The bar over the Social home lists when posts are selected (#635): approve them, put them in their channels' queues,
// cancel them, or move them by days or hours (#945). Each post goes through its own command (a move, one per channel);
// the result says what was done, what had nothing to do, and what was refused and why.
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Input } from '@crove/ui/components/input';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { ErrorText } from './ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { client, errorMessage, queryClient } from '../lib/api.ts';
import {
  MOVE_MAX,
  moveSummary,
  runBulk,
  runMove,
  validMove,
  type BulkAction,
  type BulkMove,
  type BulkPost,
  type BulkRequest,
  type BulkResult,
  type MovePostResult,
  type MoveUnit,
  type PostAction,
} from '../lib/social-bulk.ts';

const send = (r: BulkRequest) =>
  r.action === 'approve'
    ? client.social.variants.decide({ postId: r.postId, decision: 'approved', variants: r.variants })
    : r.action === 'queue'
      ? client.social.variants.schedule({ postId: r.postId, variantIds: r.variantIds, queue: true })
      : client.social.variants.cancel({ variantIds: r.variantIds });

// The same call as the post page's "Move the time" and the calendar's drag.
const reschedule = (m: { variantId: string; at: string }) => client.social.variants.reschedule({ variantId: m.variantId, at: m.at });

type Outcome = { action: PostAction; result: BulkResult } | { action: 'move'; move: BulkMove; results: MovePostResult[] };

export function BulkBar({
  posts,
  actions,
  canDecide,
  excerptOf,
  channelName,
  onClear,
}: {
  posts: BulkPost[];
  actions: readonly BulkAction[];
  canDecide: boolean;
  excerptOf: (postId: string) => string;
  // A channel's name for the move's result, by its connection.
  channelName: (connectionId: string) => string;
  onClear: () => void;
}) {
  const t = useTranslations('social.bulk');
  const f = useFormat();
  const [result, setResult] = useState<Outcome | null>(null);
  // The posts' text and the channels' names as they were when the action ran: a refused post may have left the list since.
  const [labels, setLabels] = useState<Map<string, string>>(new Map());
  const [channels, setChannels] = useState<Map<string, string>>(new Map());
  // The move's form (#945): how far, in which unit, later or earlier.
  const [moving, setMoving] = useState(false);
  const [amount, setAmount] = useState('7');
  const [unit, setUnit] = useState<MoveUnit>('days');
  const [earlier, setEarlier] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const move: BulkMove = { amount: (earlier ? -1 : 1) * Number(amount), unit };
  const run = useMutation({
    mutationFn: async (job: { action: PostAction } | { action: 'move'; move: BulkMove }): Promise<Outcome> =>
      job.action === 'move'
        ? { action: 'move', move: job.move, results: await runMove(posts, job.move, reschedule, (done, total) => setProgress({ done, total })) }
        : { action: job.action, result: await runBulk(posts, job.action, canDecide, send) },
    onSuccess: (r) => {
      setResult(r);
      setMoving(false);
      onClear();
      void queryClient.invalidateQueries();
    },
    onSettled: () => setProgress(null),
  });
  const snapshot = () => {
    setResult(null);
    setLabels(new Map(posts.map((p) => [p.id, excerptOf(p.id)])));
    setChannels(new Map(posts.flatMap((p) => p.variants.map((v) => [v.id, channelName(v.connectionId)] as const))));
  };
  const start = (action: BulkAction) => {
    if (action === 'move') {
      setMoving((open) => !open);
      return;
    }
    if (action === 'cancel' && !window.confirm(t('confirmCancel', { count: posts.length }))) return;
    snapshot();
    run.mutate({ action });
  };
  const apply = () => {
    if (!validMove(move)) return;
    snapshot();
    run.mutate({ action: 'move', move });
  };
  const postName = (postId: string) => labels.get(postId) ?? excerptOf(postId);
  const channel = (variantId: string) => channels.get(variantId) ?? variantId;
  // Owners and admins only, as social.variant.reschedule (R2); the server refuses anyone else anyway.
  const shown = actions.filter((a) => a !== 'move' || canDecide);
  return (
    <div className="space-y-2">
      {posts.length > 0 && (
        <Card className="block space-y-2 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-foreground">{t('selected', { count: posts.length })}</span>
            {shown.map((a) => (
              <Button key={a} size="sm" variant={a === 'cancel' || (a === 'move' && moving) ? 'outline' : 'default'} disabled={run.isPending} aria-expanded={a === 'move' ? moving : undefined} onClick={() => start(a)}>
                {t(`action.${a}`)}
              </Button>
            ))}
            <Button size="sm" variant="ghost" disabled={run.isPending} onClick={onClear}>
              {t('clear')}
            </Button>
          </div>
          {moving && canDecide && (
            <div className="flex flex-wrap items-end gap-2 text-xs">
              <label>
                <span className="text-subtle-foreground">{t('move.direction')}</span>
                <NativeSelect className="mt-1 w-32" value={earlier ? 'earlier' : 'later'} onChange={(e) => setEarlier(e.target.value === 'earlier')}>
                  <NativeSelectOption value="later">{t('move.later')}</NativeSelectOption>
                  <NativeSelectOption value="earlier">{t('move.earlier')}</NativeSelectOption>
                </NativeSelect>
              </label>
              <label>
                <span className="text-subtle-foreground">{t('move.amount')}</span>
                <Input type="number" inputMode="numeric" min={1} max={MOVE_MAX} step={1} className="mt-1 w-24" value={amount} onChange={(e) => setAmount(e.target.value)} />
              </label>
              <label>
                <span className="text-subtle-foreground">{t('move.unit')}</span>
                <NativeSelect className="mt-1 w-28" value={unit} onChange={(e) => setUnit(e.target.value === 'hours' ? 'hours' : 'days')}>
                  <NativeSelectOption value="days">{t('move.days')}</NativeSelectOption>
                  <NativeSelectOption value="hours">{t('move.hours')}</NativeSelectOption>
                </NativeSelect>
              </label>
              <Button size="sm" disabled={run.isPending || !validMove(move)} onClick={apply}>
                {t('move.apply')}
              </Button>
              <Button size="sm" variant="ghost" disabled={run.isPending} onClick={() => setMoving(false)}>
                {t('move.close')}
              </Button>
              <p className="w-full text-muted-foreground">{t('move.hint')}</p>
            </div>
          )}
          {progress && <p className="text-xs text-muted-foreground">{t('move.progress', { done: progress.done, total: progress.total })}</p>}
        </Card>
      )}
      {run.error && <ErrorText>{errorMessage(run.error)}</ErrorText>}
      {result?.action === 'move' && (
        <Card className="block space-y-2 p-3 text-sm">
          <p className="text-foreground">
            {t('move.result', {
              ...moveSummary(result.results),
              span: t(result.move.unit === 'hours' ? 'move.spanHours' : 'move.spanDays', { amount: Math.abs(result.move.amount) }),
              earlier: result.move.amount < 0 ? 'yes' : 'no',
            })}
          </p>
          {result.results.map((r) => (
            <div key={r.postId} className="space-y-0.5 text-xs text-muted-foreground">
              <p className="text-foreground">{postName(r.postId)}</p>
              {r.moved.map((m) => (
                <p key={m.variantId}>{t('move.moved', { channel: channel(m.variantId), when: f.dateTime(m.at) })}</p>
              ))}
              {r.skipped.map((s) => (
                <p key={s.variantId}>{t('move.skipped', { channel: channel(s.variantId), reason: t(`move.skip.${s.reason}`) })}</p>
              ))}
              {r.refused.map((x) => (
                <p key={x.variantId}>
                  {t('move.refused', { channel: channel(x.variantId) })} <span className="text-warning">{errorMessage(x.error)}</span>
                </p>
              ))}
            </div>
          ))}
        </Card>
      )}
      {result && result.action !== 'move' && (
        <Card className="block space-y-1 p-3 text-sm">
          <p className="text-foreground">{t('result', { action: t(`action.${result.action}`), done: result.result.done.length, skipped: result.result.skipped.length, refused: result.result.refused.length })}</p>
          {result.result.refused.map((r) => (
            <p key={r.postId} className="text-xs text-muted-foreground">
              <span className="text-foreground">{postName(r.postId)}</span>: <span className="text-warning">{errorMessage(r.error)}</span>
            </p>
          ))}
        </Card>
      )}
    </div>
  );
}
