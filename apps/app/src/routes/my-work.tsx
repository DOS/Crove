// "Việc của tôi" (My work, issues #1673 and #1674, notes plan docs/plan/notes.md §3.10, steps N4 and N5): the member's
// own to-dos, which nobody else in the org reads (ADR-0037), and the open tasks of the positions they hold, marked
// "Việc nhóm". Open ones sit in the groups Quá hạn, Hôm nay, 7 ngày tới, Sau đó and Không hạn, by the due day, the
// to-dos in the member's own order; done ones and the trash have their own tabs. Quick add at the top saves on Enter;
// N, J, K, X and E work the to-dos from the keyboard (DESIGN.md §5.2). A to-do can be handed over to a position as a
// team task, after the member confirms the text the team will read.
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState, type FormEvent, type RefObject } from 'react';
import { useTranslations } from 'use-intl';
import type { MyWorkTask, Todo, TodoListView, TodoStep, TodoSummary } from '@crove/kernel-contract';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Checkbox } from '@crove/ui/components/checkbox';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@crove/ui/components/dialog';
import { Input } from '@crove/ui/components/input';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { Tabs, TabsList, TabsTrigger } from '@crove/ui/components/tabs';
import { Textarea } from '@crove/ui/components/textarea';
import { cn } from '@crove/ui/lib/utils';
import { DateInput } from '../components/date-input.tsx';
import { TimeInput } from '../components/time-input.tsx';
import { Empty, ErrorText, ListSkeleton, PageHeader, Spinner } from '../components/ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { client, clientForOrg, errorMessage, orpc, queryClient } from '../lib/api.ts';
import { SAFETY_POLL_MS, pollEvery, useStreamLive } from '../lib/stream-hook.ts';
import { toast } from '../lib/toast.ts';
import { browserTimeZone, groupTodos, handOverDescription, moveTarget, myWorkShortcut, stepSelection, type MyWorkAction } from '../lib/my-work.ts';

const refresh = () => void queryClient.invalidateQueries({ queryKey: orpc.notes.todos.key() });

// A result toast in the action's verb with an undo (DESIGN.md §4.5, #2003): the undo runs the inverse command, says it
// did, or why it could not, and reads the lists again. The inverse goes to the org the action ran in (clientForOrg),
// since the toast outlives a switch to another org.
function toastWithUndo(said: string, undone: string, inverse: () => Promise<unknown>, labels: { undo: string; failed: (reason: string) => string }) {
  const undo = async () => {
    try {
      await inverse();
      toast(undone);
    } catch (error) {
      toast(labels.failed(errorMessage(error)), 'error');
    } finally {
      refresh();
    }
  };
  toast(said, 'success', { action: { label: labels.undo, run: () => void undo() } });
}
type Chart = Awaited<ReturnType<typeof orpc.chart.get.call>>;
// The most to-dos one list shows; a longer list says so.
const LIST_LIMIT = 500;

function DueChip({ todo }: { todo: TodoSummary }) {
  const t = useTranslations('myWork');
  const f = useFormat();
  if (todo.dueOn === null) return null;
  const label = todo.dueTime ? t('dueAt', { day: f.date(todo.dueOn), time: todo.dueTime }) : f.date(todo.dueOn);
  return (
    <Badge variant={todo.overdue ? 'destructive' : 'outline'} data-testid="todo-due">
      {todo.overdue && <span className="sr-only">{t('overdue')}: </span>}
      {label}
    </Badge>
  );
}

// Hands a to-do over to a position as a team task (#1674). The dialog shows the title and description the team will
// read, proposed from the to-do and editable; nothing goes to the task but what the member confirms here. It hands over
// the to-do as saved, so it waits while the editor holds unsaved changes (`disabled`), and it says when the task is due.
function HandOverDialog({ todo, disabled, onDone }: { todo: Todo; disabled: boolean; onDone: () => void }) {
  const t = useTranslations('myWork');
  const common = useTranslations('common');
  const f = useFormat();
  const chart = useQuery(orpc.chart.get.queryOptions());
  const positions = (chart.data?.positions ?? []).filter((p) => p.status !== 'archived');
  const [open, setOpen] = useState(false);
  const [positionId, setPositionId] = useState('');
  const [title, setTitle] = useState(todo.title);
  const [description, setDescription] = useState(() => handOverDescription(todo));
  const handOver = useMutation({
    mutationFn: (v: { positionId: string; title: string; description: string }) =>
      client.notes.todos.handOver({ todoId: todo.id, revision: todo.revision, positionId: v.positionId, title: v.title.trim(), description: v.description }),
    onSuccess: () => {
      refresh();
      void queryClient.invalidateQueries({ queryKey: orpc.tasks.key() });
      setOpen(false);
      onDone();
    },
  });
  // The dialog renders in a portal but sits inside the editor's form in React's tree, so its submit stops here and
  // never saves the editor (the editor ignores keys from outside its own form).
  const submit = (event: FormEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (positionId && title.trim() && !handOver.isPending) handOver.mutate({ positionId, title, description });
  };
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button type="button" variant="outline" disabled={disabled} title={disabled ? t('handOverSaveFirst') : undefined} onClick={() => setOpen(true)} data-testid="todo-hand-over">
        {t('handOver')}
      </Button>
      <DialogContent closeLabel={common('close')} className="sm:max-w-lg">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{t('handOverTitle')}</DialogTitle>
            <DialogDescription>{t('handOverHint')}</DialogDescription>
          </DialogHeader>
          <label className="block text-xs">
            <span className="text-subtle-foreground">{t('handOverPosition')}</span>
            <NativeSelect required className="mt-1 w-full" value={positionId} onChange={(e) => setPositionId(e.target.value)} data-testid="hand-over-position">
              <NativeSelectOption value="">{t('handOverPick')}</NativeSelectOption>
              {positions.map((p) => (
                <NativeSelectOption key={p.id} value={p.id}>
                  {p.holder?.type === 'agent' ? t('handOverAgentHeld', { position: p.title }) : p.title}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </label>
          <label className="block text-xs">
            <span className="text-subtle-foreground">{t('handOverTaskTitle')}</span>
            <Input required maxLength={300} value={title} onChange={(e) => setTitle(e.target.value)} className="mt-1" />
          </label>
          <label className="block text-xs">
            <span className="text-subtle-foreground">{t('handOverDescription')}</span>
            <Textarea rows={6} maxLength={10000} value={description} onChange={(e) => setDescription(e.target.value)} className="mt-1" />
          </label>
          <p className="text-xs text-subtle-foreground" data-testid="hand-over-due">
            {todo.dueOn === null ? t('handOverNoDue') : t('handOverDue', { due: todo.dueTime ? t('dueAt', { day: f.date(todo.dueOn), time: todo.dueTime }) : f.date(todo.dueOn) })}
          </p>
          {chart.data && positions.length === 0 && <p className="text-xs text-subtle-foreground">{t('handOverNoPositions')}</p>}
          {handOver.error && <ErrorText>{errorMessage(handOver.error)}</ErrorText>}
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>{common('cancel')}</DialogClose>
            <Button type="submit" disabled={!positionId || !title.trim() || handOver.isPending}>
              {handOver.isPending ? <Spinner /> : null}
              {t('handOverConfirm')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function positionTitle(chart: Chart | undefined, id: string | null, root: string, unknown: string): string {
  if (id === null) return root;
  return chart?.positions.find((p) => p.id === id)?.title ?? unknown;
}

// A team task of a position the member holds (#1674): read here, worked on the task's own page.
function TaskRow({ task, slug, chart }: { task: MyWorkTask; slug: string; chart: Chart | undefined }) {
  const t = useTranslations('myWork');
  const tt = useTranslations('tasks');
  const f = useFormat();
  return (
    <li data-testid="my-work-task" className="flex flex-wrap items-center gap-3 px-4 py-2">
      <Badge variant="secondary">{t('teamTask')}</Badge>
      <Link to="/o/$slug/tasks/$id" params={{ slug, id: task.id }} className="min-w-0 flex-1 truncate text-sm text-link hover:underline">
        {task.title}
      </Link>
      {task.tainted && (
        <Badge variant="warning" title={tt('taintedHint')}>
          {tt('tainted')}
        </Badge>
      )}
      <span className="text-xs text-subtle-foreground">{positionTitle(chart, task.positionId, tt('rootAssignee'), tt('unknownPosition'))}</span>
      {task.due && (
        <Badge variant={task.overdue ? 'destructive' : 'outline'}>
          {task.overdue && <span className="sr-only">{t('overdue')}: </span>}
          {f.dateTime(task.due)}
        </Badge>
      )}
    </li>
  );
}

// The editor of one to-do: title, details, checklist steps, the due day and time and whether to be reminded (#1675),
// saved against its revision. The reminder is on unless the member turned it off: a to-do with a due day and no
// reminder had it turned off (or its time had passed when it was written). Untouched, the box sends nothing and the
// server keeps the reminder, moving an automatic one with the due day; a time picked elsewhere stays.
function TodoEditor({ todo, onClose }: { todo: Todo; onClose: () => void }) {
  const { slug } = useParams({ strict: false }) as { slug: string };
  const t = useTranslations('myWork');
  const common = useTranslations('common');
  const f = useFormat();
  const [title, setTitle] = useState(todo.title);
  const [details, setDetails] = useState(todo.details);
  const [steps, setSteps] = useState<TodoStep[]>(todo.checklist);
  const [newStep, setNewStep] = useState('');
  const [dueOn, setDueOn] = useState(todo.dueOn ?? '');
  const [dueTime, setDueTime] = useState(todo.dueTime ?? '');
  const [remind, setRemind] = useState(todo.remindAt !== null || todo.dueOn === null);
  const [remindTouched, setRemindTouched] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  useEffect(() => titleRef.current?.focus(), []);
  // A change not saved yet: the hand-over waits for it, so it never hands over a to-do other than the one shown.
  const dirty =
    title !== todo.title ||
    details !== todo.details ||
    JSON.stringify(steps) !== JSON.stringify(todo.checklist) ||
    dueOn !== (todo.dueOn ?? '') ||
    dueTime !== (todo.dueTime ?? '') ||
    remind !== (todo.remindAt !== null || todo.dueOn === null) ||
    newStep.trim() !== '';
  // The values of one save are its variables, so an edit made while it runs does not change what it sends.
  const save = useMutation({
    mutationFn: (v: { title: string; details: string; steps: TodoStep[]; dueOn: string; dueTime: string; remind: boolean; remindTouched: boolean }) =>
      client.notes.todos.update({
        todoId: todo.id,
        revision: todo.revision,
        title: v.title.trim(),
        details: v.details,
        checklist: v.steps,
        dueOn: v.dueOn || null,
        dueTime: v.dueOn && v.dueTime ? v.dueTime : null,
        // A due day is read in the zone the to-do was written in, unless it gets a new day here.
        timeZone: v.dueOn && v.dueOn !== todo.dueOn ? browserTimeZone() : todo.timeZone,
        ...(v.remindTouched ? { reminder: v.remind ? ('auto' as const) : ('off' as const) } : {}),
      }),
    onSuccess: () => {
      refresh();
      onClose();
    },
  });
  const remove = useMutation({
    mutationFn: () => client.notes.todos.delete({ todoId: todo.id }),
    onSuccess: () => {
      refresh();
      onClose();
      toastWithUndo(t('deletedToast', { title: todo.title }), t('undoneToast', { title: todo.title }), () => clientForOrg(slug).notes.todos.restore({ todoId: todo.id }), {
        undo: common('undo'),
        failed: (reason) => common('undoFailed', { reason }),
      });
    },
  });
  const addStep = () => {
    const text = newStep.trim();
    if (!text || steps.length >= 50) return;
    setSteps([...steps, { text, done: false }]);
    setNewStep('');
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (title.trim()) save.mutate({ title, details, steps, dueOn, dueTime, remind, remindTouched });
  };
  return (
    <div className="mt-2 border-t pt-3" data-testid="todo-editor">
      <form onSubmit={submit} className="space-y-3" onKeyDown={(e) => e.key === 'Escape' && e.currentTarget.contains(e.target as Node) && onClose()}>
        <label className="block text-xs">
          <span className="text-subtle-foreground">{t('fieldTitle')}</span>
          <Input ref={titleRef} required maxLength={300} value={title} onChange={(e) => setTitle(e.target.value)} className="mt-1" />
        </label>
        <label className="block text-xs">
          <span className="text-subtle-foreground">{t('fieldDetails')}</span>
          <Textarea rows={3} maxLength={10000} value={details} onChange={(e) => setDetails(e.target.value)} className="mt-1" />
        </label>
        <fieldset className="space-y-2">
          <legend className="text-xs text-subtle-foreground">{t('checklist')}</legend>
          <ul className="space-y-1">
            {steps.map((step, i) => (
              <li key={i} className="flex items-center gap-2" data-testid="todo-step">
                <Checkbox
                  checked={step.done}
                  aria-label={t('stepDone', { step: step.text })}
                  onCheckedChange={(checked) => setSteps(steps.map((s, j) => (j === i ? { ...s, done: checked === true } : s)))}
                />
                <Input
                  aria-label={t('stepText', { n: String(i + 1) })}
                  maxLength={300}
                  value={step.text}
                  onChange={(e) => setSteps(steps.map((s, j) => (j === i ? { ...s, text: e.target.value } : s)))}
                  className={cn('h-8', step.done && 'text-subtle-foreground line-through')}
                />
                <Button type="button" variant="ghost" size="sm" onClick={() => setSteps(steps.filter((_, j) => j !== i))}>
                  {t('removeStep')}
                </Button>
              </li>
            ))}
          </ul>
          <div className="flex gap-2">
            <Input
              aria-label={t('newStep')}
              placeholder={t('newStep')}
              maxLength={300}
              value={newStep}
              onChange={(e) => setNewStep(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addStep();
                }
              }}
              className="h-8"
            />
            <Button type="button" variant="outline" size="sm" onClick={addStep} disabled={!newStep.trim() || steps.length >= 50}>
              {t('addStep')}
            </Button>
          </div>
        </fieldset>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-xs">
            <span className="text-subtle-foreground">{t('fieldDueOn')}</span>
            <DateInput value={dueOn} onChange={setDueOn} className="mt-1" aria-label={t('fieldDueOn')} />
          </label>
          <label className="block text-xs">
            <span className="text-subtle-foreground">{t('fieldDueTime')}</span>
            <TimeInput value={dueTime} onChange={setDueTime} disabled={!dueOn} className="mt-1" aria-label={t('fieldDueTime')} />
          </label>
        </div>
        <label className="flex items-start gap-2 text-xs">
          <Checkbox
            checked={remind && (dueOn !== '' || todo.remindAt !== null)}
            disabled={!dueOn && todo.remindAt === null}
            onCheckedChange={(checked) => {
              setRemind(checked === true);
              setRemindTouched(true);
            }}
            className="mt-0.5"
            data-testid="todo-remind"
          />
          <span>
            <span className="block text-foreground">{t('fieldRemind')}</span>
            <span className="block text-subtle-foreground">
              {todo.remindAt && Date.parse(todo.remindAt) > Date.now() && remind && !remindTouched && dueOn === (todo.dueOn ?? '') && dueTime === (todo.dueTime ?? '')
                ? t('remindAt', { time: f.dateTime(todo.remindAt) })
                : t('remindHint')}
            </span>
          </span>
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={save.isPending || !title.trim()}>
            {save.isPending ? <Spinner /> : null}
            {t('save')}
          </Button>
          <Button type="button" variant="outline" onClick={onClose}>
            {t('cancel')}
          </Button>
          {todo.status === 'open' && todo.deletedAt === null && <HandOverDialog todo={todo} disabled={dirty} onDone={onClose} />}
          <Button type="button" variant="destructive" className="ml-auto" disabled={remove.isPending} onClick={() => remove.mutate()}>
            {t('delete')}
          </Button>
        </div>
        {dirty && todo.status === 'open' && <p className="text-xs text-subtle-foreground">{t('handOverSaveFirst')}</p>}
        {save.error && <ErrorText>{errorMessage(save.error)}</ErrorText>}
        {remove.error && <ErrorText>{errorMessage(remove.error)}</ErrorText>}
      </form>
    </div>
  );
}

function EditorFor({ id, onClose }: { id: string; onClose: () => void }) {
  const todo = useQuery(orpc.notes.todos.get.queryOptions({ input: { todoId: id } }));
  if (todo.isPending) return <ListSkeleton rows={1} />;
  if (todo.error) return <ErrorText>{errorMessage(todo.error)}</ErrorText>;
  // Keyed by revision, so a change saved elsewhere opens fresh.
  return <TodoEditor key={`${todo.data.id}:${todo.data.revision}`} todo={todo.data} onClose={onClose} />;
}

function QuickAdd({ inputRef }: { inputRef: RefObject<HTMLInputElement | null> }) {
  const t = useTranslations('myWork');
  const [title, setTitle] = useState('');
  const create = useMutation({
    mutationFn: (value: string) => client.notes.todos.create({ title: value, timeZone: browserTimeZone() }),
    // Only what was sent is cleared: a title typed meanwhile stays.
    onSuccess: (_, sent) => {
      setTitle((current) => (current.trim() === sent ? '' : current));
      refresh();
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const value = title.trim();
    if (value && !create.isPending) create.mutate(value);
  };
  return (
    <form onSubmit={submit} className="mb-4">
      <Input
        ref={inputRef}
        aria-label={t('quickAdd')}
        placeholder={t('quickAdd')}
        maxLength={300}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => e.key === 'Escape' && e.currentTarget.blur()}
      />
      {create.error && <ErrorText>{errorMessage(create.error)}</ErrorText>}
    </form>
  );
}

export function MyWorkPage() {
  const { slug } = useParams({ strict: false }) as { slug: string };
  const t = useTranslations('myWork');
  const common = useTranslations('common');
  const f = useFormat();
  const [view, setView] = useState<TodoListView>('open');
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const quickAdd = useRef<HTMLInputElement>(null);
  const live = useStreamLive();
  // Read again every minute while the stream is down, and every few minutes anyway: the groups move with the clock
  // (midnight, a due time passing), which sends no hint. The open view also brings the tasks of my positions.
  const refetchInterval = pollEvery(live, 60_000, SAFETY_POLL_MS);
  const work = useQuery({ ...orpc.notes.todos.myWork.queryOptions({ input: { timeZone: browserTimeZone() } }), refetchInterval, enabled: view === 'open' });
  const closed = useQuery({ ...orpc.notes.todos.list.queryOptions({ input: { view, limit: LIST_LIMIT } }), refetchInterval, enabled: view !== 'open' });
  const list = view === 'open' ? work : closed;
  const chart = useQuery({ ...orpc.chart.get.queryOptions(), enabled: (work.data?.tasks.length ?? 0) > 0 });
  const todos = useMemo(() => (view === 'open' ? (work.data?.todos ?? []) : (closed.data ?? [])), [view, work.data, closed.data]);
  const tasks = useMemo(() => (view === 'open' ? (work.data?.tasks ?? []) : []), [view, work.data]);
  const groups = useMemo(() => (view === 'open' ? groupTodos(todos, tasks) : []), [view, todos, tasks]);
  // The order J and K walk: as the screen shows the rows.
  const order = useMemo(() => (view === 'open' ? groups.flatMap((g) => g.items.map((i) => i.id)) : todos.map((i) => i.id)), [view, groups, todos]);

  const act = useMutation({
    // A completion carries the to-do's title as shown when it was asked for: by the answer, the list may have moved on.
    mutationFn: (
      v: { what: 'complete'; todoId: string; title: string } | { what: 'reopen' | 'restore'; todoId: string } | { what: 'reorder'; todoId: string; place: 'before' | 'after'; anchorId: string },
    ) => {
      switch (v.what) {
        case 'reorder':
          return client.notes.todos.reorder({ todoId: v.todoId, place: v.place, anchorId: v.anchorId });
        case 'complete':
          return client.notes.todos.complete({ todoId: v.todoId });
        case 'reopen':
          return client.notes.todos.reopen({ todoId: v.todoId });
        case 'restore':
          return client.notes.todos.restore({ todoId: v.todoId });
      }
    },
    // Completing (the box or the X key) moves the to-do to Done: the toast says so and can open it again.
    onSuccess: (_done, v) => {
      if (v.what !== 'complete') return;
      const { title } = v;
      toastWithUndo(t('completedToast', { title }), t('undoneToast', { title }), () => clientForOrg(slug).notes.todos.reopen({ todoId: v.todoId }), {
        undo: common('undo'),
        failed: (reason) => common('undoFailed', { reason }),
      });
    },
    onSettled: refresh,
  });

  const shortcuts = useRef<Partial<Record<MyWorkAction, () => void>>>({});
  // The handlers of this render, set after it commits; the key listener reads them through the ref.
  useEffect(() => {
    shortcuts.current = {
      new: () => quickAdd.current?.focus(),
      next: () => setSelected(stepSelection(order, selected, 1)),
      previous: () => setSelected(stepSelection(order, selected, -1)),
      ...(selected && view === 'open' ? { done: () => act.mutate({ what: 'complete', todoId: selected, title: todos.find((x) => x.id === selected)?.title ?? '' }) } : {}),
      ...(selected && view === 'open' ? { edit: () => setEditing(selected) } : {}),
    };
  });
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const action = myWorkShortcut(event);
      const handler = action ? shortcuts.current[action] : undefined;
      if (!handler) return;
      event.preventDefault();
      handler();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  // The selected row stays in view as J and K move it.
  useEffect(() => {
    if (selected) document.querySelector(`[data-todo-id="${selected}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const row = (todo: TodoSummary, group: readonly TodoSummary[]) => {
    const up = view === 'open' ? moveTarget(group, todo.id, 'up') : null;
    const down = view === 'open' ? moveTarget(group, todo.id, 'down') : null;
    return (
      <li
        key={todo.id}
        data-todo-id={todo.id}
        data-testid="todo-row"
        aria-current={selected === todo.id ? 'true' : undefined}
        className={cn('flex flex-wrap items-center gap-3 px-4 py-2', selected === todo.id && 'bg-primary/5 ring-1 ring-primary/40 ring-inset')}
      >
        {(view === 'open' || view === 'done') && (todo.status === 'open' || todo.status === 'done') ? (
          <Checkbox
            checked={todo.status === 'done'}
            aria-label={todo.status === 'done' ? t('reopenTodo', { title: todo.title }) : t('completeTodo', { title: todo.title })}
            disabled={act.isPending}
            onCheckedChange={(checked) => act.mutate(checked === true ? { what: 'complete', todoId: todo.id, title: todo.title } : { what: 'reopen', todoId: todo.id })}
          />
        ) : view === 'open' || view === 'done' ? (
          // A handed-over to-do has no checkbox; the space keeps its title in line with the others.
          <span aria-hidden="true" className="size-4 shrink-0" />
        ) : null}
        <button
          type="button"
          data-testid="todo-title"
          className={cn('min-w-0 flex-1 truncate text-left text-sm text-foreground hover:underline focus-visible:underline focus-visible:outline-none', todo.status === 'done' && 'text-subtle-foreground line-through')}
          onClick={() => {
            setSelected(todo.id);
            if (view !== 'trash') setEditing(todo.id);
          }}
        >
          {todo.title}
        </button>
        {todo.steps.total > 0 && (
          <span className="text-xs text-subtle-foreground" aria-label={t('stepsDone', { done: String(todo.steps.done), total: String(todo.steps.total) })}>
            {todo.steps.done}/{todo.steps.total}
          </span>
        )}
        <DueChip todo={todo} />
        {/* Handed over (#1674): the work is now the team's task, opened from here. */}
        {todo.status === 'handed_over' && todo.taskId && (
          <Link to="/o/$slug/tasks/$id" params={{ slug, id: todo.taskId }} data-testid="todo-handed-over" className="text-xs text-link hover:underline">
            <Badge variant="secondary">{t('handedOver')}</Badge> {t('openTask')}
          </Link>
        )}
        {view === 'done' && todo.doneAt && <span className="text-xs text-subtle-foreground">{t('doneOn', { at: f.dateTime(todo.doneAt) })}</span>}
        {view === 'open' && (
          <span className="flex gap-1">
            <Button type="button" variant="ghost" size="sm" disabled={!up || act.isPending} aria-label={t('moveUp', { title: todo.title })} onClick={() => up && act.mutate({ what: 'reorder', todoId: todo.id, ...up })}>
              ↑
            </Button>
            <Button type="button" variant="ghost" size="sm" disabled={!down || act.isPending} aria-label={t('moveDown', { title: todo.title })} onClick={() => down && act.mutate({ what: 'reorder', todoId: todo.id, ...down })}>
              ↓
            </Button>
          </span>
        )}
        {view === 'trash' && (
          <Button type="button" variant="outline" size="sm" disabled={act.isPending} onClick={() => act.mutate({ what: 'restore', todoId: todo.id })}>
            {t('restore')}
          </Button>
        )}
        {editing === todo.id && (
          <div className="basis-full">
            {/* A save or delete that ends after another to-do was opened leaves that one's editor open. */}
            <EditorFor id={todo.id} onClose={() => setEditing((current) => (current === todo.id ? null : current))} />
          </div>
        )}
      </li>
    );
  };

  return (
    <div className="space-y-4">
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      <QuickAdd inputRef={quickAdd} />
      <Tabs
        value={view}
        onValueChange={(value) => {
          setView(value as TodoListView);
          setSelected(null);
          setEditing(null);
        }}
      >
        <TabsList>
          <TabsTrigger value="open">{t('viewOpen')}</TabsTrigger>
          <TabsTrigger value="done">{t('viewDone')}</TabsTrigger>
          <TabsTrigger value="trash">{t('viewTrash')}</TabsTrigger>
        </TabsList>
      </Tabs>
      {list.isPending ? (
        <ListSkeleton />
      ) : list.error ? (
        <ErrorText>{errorMessage(list.error)}</ErrorText>
      ) : todos.length === 0 && tasks.length === 0 ? (
        <Empty title={t(view === 'open' ? 'empty' : view === 'done' ? 'emptyDone' : 'emptyTrash')} hint={view === 'open' ? t('emptyHint') : undefined} />
      ) : view === 'open' ? (
        groups.map((g) => (
          <section key={g.id} aria-labelledby={`todo-group-${g.id}`} data-testid={`todo-group-${g.id}`}>
            <h2 id={`todo-group-${g.id}`} className={cn('mb-1 text-sm font-medium', g.id === 'overdue' ? 'text-destructive' : 'text-foreground')}>
              {t(`groups.${g.id}`)} <span className="text-subtle-foreground">({g.items.length + g.tasks.length})</span>
            </h2>
            <Card className="block p-0">
              <ul className="divide-y">
                {g.items.map((todo) => row(todo, g.items))}
                {g.tasks.map((task) => (
                  <TaskRow key={task.id} task={task} slug={slug} chart={chart.data} />
                ))}
              </ul>
            </Card>
          </section>
        ))
      ) : (
        <Card className="block p-0">
          <ul className="divide-y">{todos.map((todo) => row(todo, todos))}</ul>
        </Card>
      )}
      {todos.length >= LIST_LIMIT && <p className="text-xs text-subtle-foreground">{t('truncated', { count: String(LIST_LIMIT) })}</p>}
      {view === 'open' && work.data?.tasksTruncated && (
        <p className="text-xs text-subtle-foreground">
          {t('tasksTruncated')}{' '}
          <Link to="/o/$slug/tasks" params={{ slug }} search={{ filter: 'mine' }} className="text-link underline">
            {t('openTasks')}
          </Link>
        </p>
      )}
      {act.error && <ErrorText>{errorMessage(act.error)}</ErrorText>}
      <p className="text-xs text-subtle-foreground">{t('shortcuts')}</p>
    </div>
  );
}
