// The bar over the Social home lists, the board and the calendar when posts are selected (#635): approve them, put them
// in their channels' queues, cancel them, or move them by days or hours (#945). Each post goes through its own command
// (a move, one per channel); the result says what was done, what had nothing to do, and what was refused and why.
// Labels and the assignee (#1057) are set on up to 100 posts per command, and the result names each post left out.
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Input } from '@crove/ui/components/input';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { cn } from '@crove/ui/lib/utils';
import { ErrorText } from './ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { client, errorMessage, queryClient } from '../lib/api.ts';
import { fromLocalInput } from '../lib/social-assign.ts';
import {
  MOVE_MAX,
  assignInput,
  moveSummary,
  runBulk,
  runEdit,
  runMove,
  toggleEditLabel,
  validLabelEdit,
  validMove,
  type AssignEdit,
  type BulkAction,
  type BulkMove,
  type BulkPost,
  type BulkRequest,
  type BulkResult,
  type EditAction,
  type EditResult,
  type LabelEdit,
  type MovePostResult,
  type MoveUnit,
  type PostAction,
} from '../lib/social-bulk.ts';
import { LABEL_TONE, type LabelColor } from '../lib/social-labels.ts';

const send = (r: BulkRequest) =>
  r.action === 'approve'
    ? client.social.variants.decide({ postId: r.postId, decision: 'approved', variants: r.variants })
    : r.action === 'queue'
      ? client.social.variants.schedule({ postId: r.postId, variantIds: r.variantIds, queue: true })
      : client.social.variants.cancel({ variantIds: r.variantIds });

// The same call as the post page's "Move the time" and the calendar's drag.
const reschedule = (m: { variantId: string; at: string }) => client.social.variants.reschedule({ variantId: m.variantId, at: m.at });

// One command per batch of posts (#1057).
type AssignInput = { assigneeUserId: string | null; dueAt?: string | null };
const editLabels = (edit: LabelEdit) => (postIds: string[]) => client.social.posts.bulkLabels({ postIds, add: edit.add, remove: edit.remove });
const editAssign = (input: AssignInput) => (postIds: string[]) => client.social.posts.bulkAssign({ postIds, ...input });

type Outcome = { action: PostAction; result: BulkResult } | { action: 'move'; move: BulkMove; results: MovePostResult[] } | { action: EditAction; result: EditResult };
type Job = { action: PostAction } | { action: 'move'; move: BulkMove } | { action: 'labels'; edit: LabelEdit } | { action: 'assign'; input: AssignInput };
// The forms the bar opens under its buttons.
type Form = 'move' | EditAction;
const FORMS: readonly BulkAction[] = ['move', 'labels', 'assign'];

export interface BulkLabelOption {
  id: string;
  name: string;
  color: LabelColor;
}
export interface BulkMember {
  userId: string;
  name: string;
}

export function BulkBar({
  posts,
  actions,
  canDecide,
  excerptOf,
  channelName,
  labelOptions = [],
  members = [],
  onClear,
}: {
  posts: BulkPost[];
  actions: readonly BulkAction[];
  canDecide: boolean;
  excerptOf: (postId: string) => string;
  // A channel's name for the move's result, by its connection.
  channelName: (connectionId: string) => string;
  // The org's labels, for setting labels; without any, the bar does not offer it.
  labelOptions?: readonly BulkLabelOption[];
  // The org's members, for assigning.
  members?: readonly BulkMember[];
  onClear: () => void;
}) {
  const t = useTranslations('social.bulk');
  const f = useFormat();
  const [result, setResult] = useState<Outcome | null>(null);
  // The posts' text and the channels' names as they were when the action ran: a refused post may have left the list since.
  const [labels, setLabels] = useState<Map<string, string>>(new Map());
  const [channels, setChannels] = useState<Map<string, string>>(new Map());
  // The open form: the move (#945), labels or the assignee (#1057).
  const [form, setForm] = useState<Form | null>(null);
  const moving = form === 'move';
  const [labelEdit, setLabelEdit] = useState<LabelEdit>({ add: [], remove: [] });
  const [assignEdit, setAssignEdit] = useState<AssignEdit>({ assigneeUserId: null, due: { mode: 'keep' } });
  // The due date typed, in local time, while the form sets one.
  const [dueValue, setDueValue] = useState('');
  const assignment = assignInput(assignEdit.due.mode === 'set' ? { ...assignEdit, due: { mode: 'set', at: fromLocalInput(dueValue) } } : assignEdit);
  const [amount, setAmount] = useState('7');
  const [unit, setUnit] = useState<MoveUnit>('days');
  const [earlier, setEarlier] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  // The direction comes from the select alone: a typed minus sign never flips it.
  const move: BulkMove = { amount: (earlier ? -1 : 1) * Math.abs(Number(amount)), unit };
  const run = useMutation({
    // A new run starts clean: no progress or result of the last one.
    onMutate: () => {
      setProgress(null);
      setResult(null);
    },
    mutationFn: async (job: Job): Promise<Outcome> => {
      const step =(done: number, total: number) => setProgress({ done, total });
      const ids = posts.map((p) => p.id);
      if (job.action === 'move') return { action: 'move', move: job.move, results: await runMove(posts, job.move, reschedule, step) };
      if (job.action === 'labels') return { action: 'labels', result: await runEdit(ids, editLabels(job.edit), step) };
      if (job.action === 'assign') return { action: 'assign', result: await runEdit(ids, editAssign(job.input), step) };
      return { action: job.action, result: await runBulk(posts, job.action, canDecide, send) };
    },
    onSuccess: (r) => {
      setResult(r);
      setForm(null);
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
    if (action === 'move' || action === 'labels' || action === 'assign') {
      setForm((open) => (open === action ? null : action));
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
  const applyLabels = () => {
    if (!validLabelEdit(labelEdit)) return;
    snapshot();
    run.mutate({ action: 'labels', edit: labelEdit });
  };
  const applyAssign = () => {
    if (!assignment) return;
    snapshot();
    run.mutate({ action: 'assign', input: assignment });
  };
  const postName = (postId: string) => labels.get(postId) ?? excerptOf(postId);
  const channel = (variantId: string) => channels.get(variantId) ?? variantId;
  // Owners and admins only, as social.variant.reschedule (R2); the server refuses anyone else anyway. Labels need a label.
  const shown = actions.filter((a) => (a !== 'move' || canDecide) && (a !== 'labels' || labelOptions.length > 0));
  const labelRow = (side: keyof LabelEdit) => (
    <div className="space-y-1">
      <p className="text-subtle-foreground">{t(`labels.${side}`)}</p>
      <div className="flex flex-wrap gap-1.5">
        {labelOptions.map((l) => {
          const on = labelEdit[side].includes(l.id);
          return (
            <button
              key={l.id}
              type="button"
              aria-pressed={on}
              onClick={() => setLabelEdit(toggleEditLabel(labelEdit, side, l.id))}
              className={cn(
                'max-w-48 truncate rounded-md border px-2 py-0.5 text-xs transition-shadow focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
                LABEL_TONE[l.color],
                on ? 'ring-2 ring-ring' : 'opacity-70 hover:opacity-100',
              )}
            >
              {on ? (side === 'add' ? '+ ' : '- ') : ''}
              {l.name}
            </button>
          );
        })}
      </div>
    </div>
  );
  return (
    <div className="space-y-2">
      {posts.length > 0 && (
        <Card className="block space-y-2 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-foreground">{t('selected', { count: posts.length })}</span>
            {shown.map((a) => (
              <Button key={a} size="sm" variant={a === 'cancel' || form === a ? 'outline' : 'default'} disabled={run.isPending} aria-expanded={FORMS.includes(a) ? form === a : undefined} onClick={() => start(a)}>
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
              <Button size="sm" variant="ghost" disabled={run.isPending} onClick={() => setForm(null)}>
                {t('move.close')}
              </Button>
              <p className="w-full text-muted-foreground">{t('move.hint')}</p>
            </div>
          )}
          {form === 'labels' && labelOptions.length > 0 && (
            <div className="space-y-2 text-xs">
              {labelRow('add')}
              {labelRow('remove')}
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" disabled={run.isPending || !validLabelEdit(labelEdit)} onClick={applyLabels}>
                  {t('labels.apply')}
                </Button>
                <Button size="sm" variant="ghost" disabled={run.isPending} onClick={() => setForm(null)}>
                  {t('move.close')}
                </Button>
              </div>
              <p className="text-muted-foreground">{t('labels.hint')}</p>
            </div>
          )}
          {form === 'assign' && (
            <div className="flex flex-wrap items-end gap-2 text-xs">
              <label>
                <span className="text-subtle-foreground">{t('assign.assignee')}</span>
                <NativeSelect className="mt-1 w-48" value={assignEdit.assigneeUserId ?? ''} onChange={(e) => setAssignEdit({ ...assignEdit, assigneeUserId: e.target.value || null })}>
                  <NativeSelectOption value="">{t('assign.nobody')}</NativeSelectOption>
                  {members.map((m) => (
                    <NativeSelectOption key={m.userId} value={m.userId}>
                      {m.name}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </label>
              <label>
                <span className="text-subtle-foreground">{t('assign.due')}</span>
                <NativeSelect
                  className="mt-1 w-44"
                  value={assignEdit.due.mode}
                  onChange={(e) => setAssignEdit({ ...assignEdit, due: e.target.value === 'set' ? { mode: 'set', at: null } : e.target.value === 'clear' ? { mode: 'clear' } : { mode: 'keep' } })}
                >
                  <NativeSelectOption value="keep">{t('assign.dueKeep')}</NativeSelectOption>
                  <NativeSelectOption value="set">{t('assign.dueSet')}</NativeSelectOption>
                  <NativeSelectOption value="clear">{t('assign.dueClear')}</NativeSelectOption>
                </NativeSelect>
              </label>
              {assignEdit.due.mode === 'set' && (
                <label>
                  <span className="text-subtle-foreground">{t('assign.dueAt')}</span>
                  <Input type="datetime-local" className="mt-1 w-52" value={dueValue} onChange={(e) => setDueValue(e.target.value)} />
                </label>
              )}
              <Button size="sm" disabled={run.isPending || !assignment} onClick={applyAssign}>
                {t('assign.apply')}
              </Button>
              <Button size="sm" variant="ghost" disabled={run.isPending} onClick={() => setForm(null)}>
                {t('move.close')}
              </Button>
              <p className="w-full text-muted-foreground">{t('assign.hint')}</p>
            </div>
          )}
          {progress && <p className="text-xs text-muted-foreground">{t(form === 'labels' || form === 'assign' ? 'edit.progress' : 'move.progress', { done: progress.done, total: progress.total })}</p>}
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
      {(result?.action === 'labels' || result?.action === 'assign') && (
        <Card className="block space-y-1 p-3 text-sm">
          <p className="text-foreground">{t('edit.result', { action: t(`action.${result.action}`), done: result.result.done.length, skipped: result.result.skipped.length, refused: result.result.refused.length })}</p>
          {result.result.skipped.map((s) => (
            <p key={s.postId} className="text-xs text-muted-foreground">
              <span className="text-foreground">{postName(s.postId)}</span>: {t(`edit.skip.${s.reason}`)}
            </p>
          ))}
          {result.result.refused.map((r) => (
            <p key={r.postId} className="text-xs text-muted-foreground">
              <span className="text-foreground">{postName(r.postId)}</span>: <span className="text-warning">{errorMessage(r.error)}</span>
            </p>
          ))}
        </Card>
      )}
      {result && (result.action === 'approve' || result.action === 'queue' || result.action === 'cancel') && (
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
