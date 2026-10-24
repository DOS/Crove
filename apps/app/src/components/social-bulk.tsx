// The bar over the Social home lists, the board and the calendar when posts are selected (#635): approve them, put them
// in their channels' queues, cancel them, or move them by days or hours (#945). Each post goes through its own command
// (a move, one per channel); the result says what was done, what had nothing to do, and what was refused and why.
// Labels and the assignee (#1057) are set on up to 100 posts per command, and the result names each post left out.
// Find and replace (#1144) shows the server's preview of every match first; the replace changes what it listed.
// Drafts go to review post by post as approvals do, and the result tells apart what had nothing to send, what does not
// fit its channel yet and what holds a blocked word; one channel is added to up to 100 posts per command, and the
// result says which added channels already fit their rules (#1178). Copies of the posts moved by days or weeks (#1192)
// are made post by post, and the result names each copy, each post left out and why, and each copy whose text X or
// LinkedIn would refuse as a repeat.
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Checkbox } from '@crove/ui/components/checkbox';
import { Input } from '@crove/ui/components/input';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { cn } from '@crove/ui/lib/utils';
import { ErrorText } from './ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { client, errorMessage, queryClient } from '../lib/api.ts';
import { fromLocalInput } from '../lib/social-assign.ts';
import { mediaNumber } from '../lib/social-bulk-drafts.ts';
import {
  BULK_REPLACE_MAX,
  MOVE_MAX,
  REPLACE_FIND_MAX,
  REPLACE_WITH_MAX,
  addedSummary,
  assignInput,
  duplicateSummary,
  moveSummary,
  previewSummary,
  replaceKey,
  runAddChannel,
  runBulk,
  runDuplicate,
  runEdit,
  runMove,
  runReplacePreview,
  submitResult,
  toggleEditLabel,
  validDuplicate,
  validLabelEdit,
  validMove,
  validReplace,
  type AddChannelResult,
  type ArchiveAction,
  type AssignEdit,
  type BulkAction,
  type BulkDuplicate,
  type BulkMove,
  type BulkPost,
  type BulkRequest,
  type BulkResult,
  type DuplicatePostResult,
  type DuplicateUnit,
  type EditAction,
  type EditResult,
  type LabelEdit,
  type MovePostResult,
  type MoveUnit,
  type PostAction,
  type ReplaceEdit,
  type ReplacePreviewPost,
  type SubmitIssue,
  type SubmitResult,
} from '../lib/social-bulk.ts';
import { LABEL_TONE, type LabelColor } from '../lib/social-labels.ts';

const send = (r: BulkRequest) =>
  r.action === 'approve'
    ? client.social.variants.decide({ postId: r.postId, decision: 'approved', variants: r.variants })
    : r.action === 'submit'
      ? client.social.posts.submit({ postId: r.postId })
      : r.action === 'queue'
      ? client.social.variants.schedule({ postId: r.postId, variantIds: r.variantIds, queue: true })
      : client.social.variants.cancel({ variantIds: r.variantIds });

// The same call as the post page's "Move the time" and the calendar's drag.
// With the time the channel was shown at, so one moved meanwhile is refused as stale (#956).
const reschedule = (m: { variantId: string; at: string; expectedAt: string }) => client.social.variants.reschedule({ variantId: m.variantId, at: m.at, expectedAt: m.expectedAt });

// A copy of one post, planned for that time or undated (#1192): the same call as the post page's Duplicate.
const duplicatePost = (r: { postId: string; scheduledAt: string | null }) => client.social.posts.duplicate({ postId: r.postId, scheduledAt: r.scheduledAt });

// One command per batch of posts (#1057).
type AssignInput = { assigneeUserId: string | null; dueAt?: string | null };
const editLabels = (edit: LabelEdit) => (postIds: string[]) => client.social.posts.bulkLabels({ postIds, add: edit.add, remove: edit.remove });
const editAssign = (input: AssignInput) => (postIds: string[]) => client.social.posts.bulkAssign({ postIds, ...input });
// Find and replace (#1144): the preview and the replace take the same input.
const previewReplace = (edit: ReplaceEdit) => (postIds: string[]) => client.social.posts.bulkReplacePreview({ postIds, ...edit });
const editReplace = (edit: ReplaceEdit) => (postIds: string[]) => client.social.posts.bulkReplace({ postIds, ...edit });
// One channel on every post (#1178).
const editAddChannel = (connectionId: string) => (postIds: string[]) => client.social.posts.bulkAddChannel({ postIds, connectionId });
// Out of the lists, or back (#1299).
const archivePosts = (action: ArchiveAction) => (postIds: string[]) => (action === 'archive' ? client.social.posts.bulkArchive({ postIds }) : client.social.posts.bulkRestore({ postIds }));

type Outcome =
  | { action: Exclude<PostAction, 'submit'>; result: BulkResult }
  | { action: 'submit'; result: SubmitResult }
  | { action: 'move'; move: BulkMove; results: MovePostResult[] }
  | { action: 'duplicate'; duplicate: BulkDuplicate; results: DuplicatePostResult[] }
  | { action: Exclude<EditAction, 'addChannel'> | ArchiveAction; result: EditResult }
  | { action: 'addChannel'; connectionId: string; result: AddChannelResult };
type Job =
  | { action: PostAction }
  | { action: ArchiveAction }
  | { action: 'move'; move: BulkMove }
  | { action: 'duplicate'; duplicate: BulkDuplicate }
  | { action: 'labels'; edit: LabelEdit }
  | { action: 'assign'; input: AssignInput }
  | { action: 'replace'; edit: ReplaceEdit }
  | { action: 'addChannel'; connectionId: string };
// The forms the bar opens under its buttons.
type Form = 'move' | 'duplicate' | EditAction;
const FORMS: readonly BulkAction[] = ['move', 'duplicate', 'labels', 'assign', 'replace', 'addChannel'];

export interface BulkLabelOption {
  id: string;
  name: string;
  color: LabelColor;
}
export interface BulkMember {
  userId: string;
  name: string;
}
// A channel that can be added to the posts (#1178): live, and one the member may use.
export interface BulkChannelOption {
  id: string;
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
  channelOptions = [],
  findHint = '',
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
  // The channels the member may add to the posts; without any, the bar does not offer it.
  channelOptions?: readonly BulkChannelOption[];
  // What the find and replace starts searching for: the list's search, when there is one.
  findHint?: string | undefined;
  onClear: () => void;
}) {
  const t = useTranslations('social.bulk');
  const ts = useTranslations('social');
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
  // The copies' shift (#1192): one week by default, as a weekly set is copied to the next week.
  const [copyAmount, setCopyAmount] = useState('1');
  const [copyUnit, setCopyUnit] = useState<DuplicateUnit>('weeks');
  const copyShift: BulkDuplicate = { amount: copyAmount.trim() === '' ? Number.NaN : Number(copyAmount), unit: copyUnit };
  // Find and replace (#1144): the form, and the preview with what it was made for.
  const [replaceEdit, setReplaceEdit] = useState<ReplaceEdit>({ find: findHint ?? '', replace: '', caseSensitive: false, wholeWord: false });
  const [preview, setPreview] = useState<{ key: string; posts: ReplacePreviewPost[] } | null>(null);
  // The channel to add (#1178).
  const [addChannelId, setAddChannelId] = useState('');
  const ids = posts.map((p) => p.id);
  const fresh = preview !== null && preview.key === replaceKey(replaceEdit, ids);
  const summary = preview ? previewSummary(preview.posts) : { changes: 0, matches: 0, skipped: 0 };
  // The direction comes from the select alone: a typed minus sign never flips it.
  const move: BulkMove = { amount: (earlier ? -1 : 1) * Math.abs(Number(amount)), unit };
  const run = useMutation({
    // A new run starts clean: no progress or result of the last one.
    onMutate: () => {
      setProgress(null);
      setResult(null);
    },
    mutationFn: async (job: Job): Promise<Outcome> => {
      const step = (done: number, total: number) => setProgress({ done, total });
      if (job.action === 'move') return { action: 'move', move: job.move, results: await runMove(posts, job.move, reschedule, step) };
      if (job.action === 'duplicate') return { action: 'duplicate', duplicate: job.duplicate, results: await runDuplicate(posts, job.duplicate, duplicatePost, Date.now(), step) };
      if (job.action === 'labels') return { action: 'labels', result: await runEdit(ids, editLabels(job.edit), step) };
      if (job.action === 'assign') return { action: 'assign', result: await runEdit(ids, editAssign(job.input), step) };
      if (job.action === 'replace') return { action: 'replace', result: await runEdit(ids, editReplace(job.edit), step, BULK_REPLACE_MAX) };
      if (job.action === 'addChannel') return { action: 'addChannel', connectionId: job.connectionId, result: await runAddChannel(ids, editAddChannel(job.connectionId), step) };
      if (job.action === 'archive' || job.action === 'restore') return { action: job.action, result: await runEdit(ids, archivePosts(job.action), step) };
      if (job.action === 'submit') return { action: 'submit', result: submitResult(await runBulk(posts, 'submit', canDecide, send)) };
      return { action: job.action, result: await runBulk(posts, job.action, canDecide, send) };
    },
    onSuccess: (r) => {
      setResult(r);
      setForm(null);
      setPreview(null);
      onClear();
      void queryClient.invalidateQueries();
    },
    onSettled: () => setProgress(null),
  });
  const previewing = useMutation({
    onMutate: () => {
      setProgress(null);
      setPreview(null);
    },
    mutationFn: async (edit: ReplaceEdit) => ({ key: replaceKey(edit, ids), posts: await runReplacePreview(ids, previewReplace(edit), (done, total) => setProgress({ done, total })) }),
    onSuccess: setPreview,
    onSettled: () => setProgress(null),
  });
  const busy = run.isPending || previewing.isPending;
  const snapshot = () => {
    setResult(null);
    setLabels(new Map(posts.map((p) => [p.id, excerptOf(p.id)])));
    setChannels(new Map(posts.flatMap((p) => p.variants.map((v) => [v.id, channelName(v.connectionId)] as const))));
  };
  const start = (action: BulkAction) => {
    if (action === 'move' || action === 'duplicate' || action === 'labels' || action === 'assign' || action === 'replace' || action === 'addChannel') {
      // An empty search box starts from the list's search.
      if (action === 'replace' && replaceEdit.find === '' && findHint) setReplaceEdit({ ...replaceEdit, find: findHint });
      setForm((open) => (open === action ? null : action));
      return;
    }
    if (action === 'cancel' && !window.confirm(t('confirmCancel', { count: posts.length }))) return;
    if (action === 'archive' && !window.confirm(t('confirmArchive', { count: posts.length }))) return;
    snapshot();
    run.mutate({ action });
  };
  const apply = () => {
    if (!validMove(move)) return;
    snapshot();
    run.mutate({ action: 'move', move });
  };
  const applyDuplicate = () => {
    if (!validDuplicate(copyShift)) return;
    snapshot();
    run.mutate({ action: 'duplicate', duplicate: copyShift });
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
  const applyAddChannel = () => {
    if (!channelOptions.some((c) => c.id === addChannelId)) return;
    snapshot();
    run.mutate({ action: 'addChannel', connectionId: addChannelId });
  };
  const showPreview = () => {
    if (!validReplace(replaceEdit)) return;
    snapshot();
    previewing.mutate(replaceEdit);
  };
  // Only what the preview on screen was made for.
  const applyReplace = () => {
    if (!fresh || summary.changes === 0) return;
    snapshot();
    run.mutate({ action: 'replace', edit: replaceEdit });
  };
  const postName = (postId: string) => labels.get(postId) ?? excerptOf(postId);
  const channel = (variantId: string) => channels.get(variantId) ?? variantId;
  const issueText = (issue: SubmitIssue) => ts(`issues.${issue.code}`, { limit: issue.limit ?? 0, actual: issue.actual ?? 0, n: mediaNumber(issue.field) });
  // Owners and admins only, as social.variant.reschedule (R2); the server refuses anyone else anyway. Labels need a label,
  // adding a channel a channel to add.
  const shown = actions.filter((a) => (a !== 'move' || canDecide) && (a !== 'labels' || labelOptions.length > 0) && (a !== 'addChannel' || channelOptions.length > 0));
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
              <Button key={a} size="sm" variant={a === 'cancel' || a === 'archive' || form === a ? 'outline' : 'default'} disabled={busy} aria-expanded={FORMS.includes(a) ? form === a : undefined} onClick={() => start(a)}>
                {t(`action.${a}`)}
              </Button>
            ))}
            <Button size="sm" variant="ghost" disabled={busy} onClick={onClear}>
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
              <Button size="sm" disabled={busy || !validMove(move)} onClick={apply}>
                {t('move.apply')}
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setForm(null)}>
                {t('move.close')}
              </Button>
              <p className="w-full text-muted-foreground">{t('move.hint')}</p>
            </div>
          )}
          {form === 'duplicate' && (
            <div className="flex flex-wrap items-end gap-2 text-xs">
              <label>
                <span className="text-subtle-foreground">{t('duplicate.amount')}</span>
                <Input type="number" inputMode="numeric" min={0} max={MOVE_MAX} step={1} className="mt-1 w-24" value={copyAmount} onChange={(e) => setCopyAmount(e.target.value)} />
              </label>
              <label>
                <span className="text-subtle-foreground">{t('duplicate.unit')}</span>
                <NativeSelect className="mt-1 w-28" value={copyUnit} onChange={(e) => setCopyUnit(e.target.value === 'days' ? 'days' : 'weeks')}>
                  <NativeSelectOption value="days">{t('duplicate.days')}</NativeSelectOption>
                  <NativeSelectOption value="weeks">{t('duplicate.weeks')}</NativeSelectOption>
                </NativeSelect>
              </label>
              <Button size="sm" disabled={busy || !validDuplicate(copyShift)} onClick={applyDuplicate}>
                {t('duplicate.apply')}
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setForm(null)}>
                {t('move.close')}
              </Button>
              <p className="w-full text-muted-foreground">{t('duplicate.hint')}</p>
            </div>
          )}
          {form === 'labels' && labelOptions.length > 0 && (
            <div className="space-y-2 text-xs">
              {labelRow('add')}
              {labelRow('remove')}
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" disabled={busy || !validLabelEdit(labelEdit)} onClick={applyLabels}>
                  {t('labels.apply')}
                </Button>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => setForm(null)}>
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
              <Button size="sm" disabled={busy || !assignment} onClick={applyAssign}>
                {t('assign.apply')}
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setForm(null)}>
                {t('move.close')}
              </Button>
              <p className="w-full text-muted-foreground">{t('assign.hint')}</p>
            </div>
          )}
          {form === 'addChannel' && channelOptions.length > 0 && (
            <div className="flex flex-wrap items-end gap-2 text-xs">
              <label>
                <span className="text-subtle-foreground">{t('addChannel.channel')}</span>
                <NativeSelect className="mt-1 w-56" value={addChannelId} onChange={(e) => setAddChannelId(e.target.value)}>
                  <NativeSelectOption value="">{t('addChannel.pick')}</NativeSelectOption>
                  {channelOptions.map((c) => (
                    <NativeSelectOption key={c.id} value={c.id}>
                      {c.name}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </label>
              <Button size="sm" disabled={busy || !channelOptions.some((c) => c.id === addChannelId)} onClick={applyAddChannel}>
                {t('addChannel.apply')}
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setForm(null)}>
                {t('move.close')}
              </Button>
              <p className="w-full text-muted-foreground">{t('addChannel.hint')}</p>
            </div>
          )}
          {form === 'replace' && (
            <div className="space-y-2 text-xs">
              <div className="flex flex-wrap items-end gap-2">
                <label>
                  <span className="text-subtle-foreground">{t('replace.find')}</span>
                  <Input className="mt-1 w-56" maxLength={REPLACE_FIND_MAX} value={replaceEdit.find} onChange={(e) => setReplaceEdit({ ...replaceEdit, find: e.target.value })} />
                </label>
                <label>
                  <span className="text-subtle-foreground">{t('replace.with')}</span>
                  <Input className="mt-1 w-56" maxLength={REPLACE_WITH_MAX} value={replaceEdit.replace} onChange={(e) => setReplaceEdit({ ...replaceEdit, replace: e.target.value })} />
                </label>
                <label className="flex items-center gap-1.5 pb-2">
                  <Checkbox checked={replaceEdit.caseSensitive} onCheckedChange={(on) => setReplaceEdit({ ...replaceEdit, caseSensitive: on === true })} />
                  <span>{t('replace.caseSensitive')}</span>
                </label>
                <label className="flex items-center gap-1.5 pb-2">
                  <Checkbox checked={replaceEdit.wholeWord} onCheckedChange={(on) => setReplaceEdit({ ...replaceEdit, wholeWord: on === true })} />
                  <span>{t('replace.wholeWord')}</span>
                </label>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="outline" disabled={busy || !validReplace(replaceEdit)} onClick={showPreview}>
                  {t('replace.preview')}
                </Button>
                <Button size="sm" disabled={busy || !fresh || summary.changes === 0} onClick={applyReplace}>
                  {t('replace.apply', { count: fresh ? summary.changes : 0 })}
                </Button>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => setForm(null)}>
                  {t('move.close')}
                </Button>
              </div>
              <p className="text-muted-foreground">{t('replace.hint')}</p>
              {preview && !fresh && <p className="text-warning">{t('replace.stale')}</p>}
              {preview && fresh && <ReplacePreview posts={preview.posts} replacement={replaceEdit.replace} postName={postName} channelName={channelName} />}
            </div>
          )}
          {progress && (
            <p className="text-xs text-muted-foreground">
              {t(
                previewing.isPending
                  ? 'replace.progress'
                  : form === 'duplicate'
                    ? 'duplicate.progress'
                    : form === 'labels' || form === 'assign' || form === 'replace' || form === 'addChannel' || run.variables?.action === 'archive' || run.variables?.action === 'restore'
                      ? 'edit.progress'
                      : 'move.progress',
                { done: progress.done, total: progress.total },
              )}
            </p>
          )}
        </Card>
      )}
      {run.error && <ErrorText>{errorMessage(run.error)}</ErrorText>}
      {previewing.error && <ErrorText>{errorMessage(previewing.error)}</ErrorText>}
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
      {result?.action === 'duplicate' && <DuplicateOutcome duplicate={result.duplicate} results={result.results} postName={postName} channelName={channelName} />}
      {result?.action === 'addChannel' && (
        <Card className="block space-y-1 p-3 text-sm">
          <p className="text-foreground">
            {t('addChannel.result', {
              channel: channelOptions.find((c) => c.id === result.connectionId)?.name ?? channelName(result.connectionId),
              done: result.result.done.length,
              skipped: result.result.skipped.length,
              refused: result.result.refused.length,
              ...addedSummary(result.result.added),
            })}
          </p>
          {result.result.added
            .filter((a) => a.issues.length > 0)
            .map((a) => (
              <p key={a.variantId} className="text-xs text-muted-foreground">
                <span className="text-foreground">{postName(a.postId)}</span>: {t('addChannel.needsEdits', { issues: a.issues.map(issueText).join('; ') })}
              </p>
            ))}
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
      {result?.action === 'submit' && (
        <Card className="block space-y-1 p-3 text-sm">
          <p className="text-foreground">
            {t('submit.result', {
              done: result.result.done.length,
              skipped: result.result.skipped.length,
              invalid: result.result.invalid.length,
              blocked: result.result.blocked.length,
              refused: result.result.refused.length,
            })}
          </p>
          {result.result.invalid.map((x) => (
            <div key={x.postId} className="space-y-0.5 text-xs text-muted-foreground">
              <p>
                <span className="text-foreground">{postName(x.postId)}</span>: {t('submit.invalid')}
              </p>
              {x.variants.map((v) => (
                <p key={v.variantId} className="pl-3">
                  {channel(v.variantId)}: {v.issues.map(issueText).join('; ')}
                </p>
              ))}
            </div>
          ))}
          {result.result.blocked.map((x) => (
            <p key={x.postId} className="text-xs text-muted-foreground">
              <span className="text-foreground">{postName(x.postId)}</span>: <span className="text-warning">{t('submit.blocked', { words: x.phrases.map((w) => `«${w}»`).join(', ') })}</span>
            </p>
          ))}
          {result.result.refused.map((r) => (
            <p key={r.postId} className="text-xs text-muted-foreground">
              <span className="text-foreground">{postName(r.postId)}</span>: <span className="text-warning">{errorMessage(r.error)}</span>
            </p>
          ))}
        </Card>
      )}
      {(result?.action === 'labels' || result?.action === 'assign' || result?.action === 'replace' || result?.action === 'archive' || result?.action === 'restore') && (
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

// What copying the posts did (#1192): per post its new draft and the time it is planned for, or why it has none, and the
// copy's channels on X or LinkedIn whose text matches another post there, which those platforms refuse as a repeat.
export function DuplicateOutcome({
  duplicate,
  results,
  postName,
  channelName,
}: {
  duplicate: BulkDuplicate;
  results: readonly DuplicatePostResult[];
  postName: (postId: string) => string;
  channelName: (connectionId: string) => string;
}) {
  const t = useTranslations('social.bulk');
  const f = useFormat();
  return (
    <Card className="block space-y-2 p-3 text-sm">
      <p className="text-foreground">
        {t('duplicate.result', {
          ...duplicateSummary(results),
          span: duplicate.amount === 0 ? t('duplicate.spanNone') : t(duplicate.unit === 'weeks' ? 'duplicate.spanWeeks' : 'duplicate.spanDays', { amount: duplicate.amount }),
        })}
      </p>
      {results.map((r) => (
        <div key={r.postId} className="space-y-0.5 text-xs text-muted-foreground">
          <p>
            <span className="text-foreground">{postName(r.postId)}</span>:{' '}
            {r.outcome === 'done' ? (
              r.at ? (
                t('duplicate.copied', { when: f.dateTime(r.at) })
              ) : (
                t('duplicate.undated')
              )
            ) : r.outcome === 'skipped' ? (
              t('duplicate.skipped', { reason: t(`duplicate.skip.${r.reason}`) })
            ) : (
              <span className="text-warning">{errorMessage(r.error)}</span>
            )}
          </p>
          {r.outcome === 'done' &&
            r.repeats.map((x) => (
              <p key={x.variantId} className="pl-3 text-warning">
                {t('duplicate.repeat', { channel: channelName(x.connectionId), status: x.status })}
              </p>
            ))}
        </div>
      ))}
    </Card>
  );
}

// The server's preview of a find and replace (#1144): per post, each field where the text matches, how often, and the
// first match in its context with what replaces it; a post left out says why.
export function ReplacePreview({
  posts,
  replacement,
  postName,
  channelName,
}: {
  posts: readonly ReplacePreviewPost[];
  replacement: string;
  postName: (postId: string) => string;
  channelName: (connectionId: string) => string;
}) {
  const t = useTranslations('social.bulk');
  return (
    <div className="space-y-2">
      <p className="text-foreground">{t('replace.summary', previewSummary(posts))}</p>
      <ul className="max-h-80 space-y-2 overflow-y-auto">
        {posts.map((p) => (
          <li key={p.postId} className="space-y-0.5">
            <p className="text-foreground">
              {postName(p.postId)}
              {p.skip && <span className="text-muted-foreground"> · {t('replace.left', { reason: t(`edit.skip.${p.skip}`) })}</span>}
            </p>
            {p.matches.map((m) => (
              <p key={`${m.variantId ?? 'post'}:${m.field}`} className="break-words text-muted-foreground">
                <span className="text-subtle-foreground">
                  {m.connectionId ? t('replace.onChannel', { field: t(`replace.field.${m.field}`), channel: channelName(m.connectionId) }) : t('replace.onPost', { field: t(`replace.field.${m.field}`) })} (
                  {t('replace.count', { count: m.count })}):
                </span>{' '}
                {m.before}
                <del className="rounded-sm bg-destructive/10 line-through decoration-destructive">{m.match}</del>
                {p.skip === null && <ins className="rounded-sm bg-success/15 text-foreground no-underline">{replacement}</ins>}
                {m.after}
              </p>
            ))}
          </li>
        ))}
      </ul>
    </div>
  );
}
