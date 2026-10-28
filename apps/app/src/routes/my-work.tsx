// "Việc của tôi" (My work, issue #1673, notes plan docs/plan/notes.md §3.10 and step N4): the member's own to-dos,
// which nobody else in the org reads (ADR-0037). Open ones sit in the groups Quá hạn, Hôm nay, 7 ngày tới, Sau đó and
// Không hạn, by the due day in each to-do's time zone, in the member's own order; done ones and the trash have their own
// tabs. Quick add at the top saves on Enter; N, J, K, X and E work the list from the keyboard (DESIGN.md §5.2).
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState, type FormEvent, type RefObject } from 'react';
import { useTranslations } from 'use-intl';
import type { Todo, TodoListView, TodoStep, TodoSummary } from '@crove/kernel-contract';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Checkbox } from '@crove/ui/components/checkbox';
import { Input } from '@crove/ui/components/input';
import { Tabs, TabsList, TabsTrigger } from '@crove/ui/components/tabs';
import { Textarea } from '@crove/ui/components/textarea';
import { cn } from '@crove/ui/lib/utils';
import { DateInput } from '../components/date-input.tsx';
import { TimeInput } from '../components/time-input.tsx';
import { Empty, ErrorText, ListSkeleton, PageHeader, Spinner } from '../components/ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';
import { SAFETY_POLL_MS, pollEvery, useStreamLive } from '../lib/stream-hook.ts';
import { browserTimeZone, groupTodos, moveTarget, myWorkShortcut, stepSelection, type MyWorkAction } from '../lib/my-work.ts';

const refresh = () => void queryClient.invalidateQueries({ queryKey: orpc.notes.todos.key() });
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

// The editor of one to-do: title, details, checklist steps, the due day and time and whether to be reminded (#1675),
// saved against its revision. The reminder is on unless the member turned it off: a to-do with a due day and no
// reminder had it turned off (or its time had passed when it was written). Untouched, the box sends nothing and the
// server keeps the reminder, moving an automatic one with the due day; a time picked elsewhere stays.
function TodoEditor({ todo, onClose }: { todo: Todo; onClose: () => void }) {
  const t = useTranslations('myWork');
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
    <Card className="block p-4" data-testid="todo-editor">
      <form onSubmit={submit} className="space-y-3" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
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
          <Button type="button" variant="destructive" className="ml-auto" disabled={remove.isPending} onClick={() => remove.mutate()}>
            {t('delete')}
          </Button>
        </div>
        {save.error && <ErrorText>{errorMessage(save.error)}</ErrorText>}
        {remove.error && <ErrorText>{errorMessage(remove.error)}</ErrorText>}
      </form>
    </Card>
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
  const t = useTranslations('myWork');
  const f = useFormat();
  const [view, setView] = useState<TodoListView>('open');
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const quickAdd = useRef<HTMLInputElement>(null);
  const live = useStreamLive();
  // Read again every minute while the stream is down, and every few minutes anyway: the groups move with the clock
  // (midnight, a due time passing), which sends no hint.
  const list = useQuery({ ...orpc.notes.todos.list.queryOptions({ input: { view, limit: LIST_LIMIT } }), refetchInterval: pollEvery(live, 60_000, SAFETY_POLL_MS) });
  const todos = useMemo(() => list.data ?? [], [list.data]);
  const groups = useMemo(() => (view === 'open' ? groupTodos(todos) : []), [view, todos]);
  // The order J and K walk: as the screen shows the rows.
  const order = useMemo(() => (view === 'open' ? groups.flatMap((g) => g.items.map((i) => i.id)) : todos.map((i) => i.id)), [view, groups, todos]);

  const act = useMutation({
    mutationFn: (v: { what: 'complete' | 'reopen' | 'restore'; todoId: string } | { what: 'reorder'; todoId: string; place: 'before' | 'after'; anchorId: string }) => {
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
    onSettled: refresh,
  });

  const shortcuts = useRef<Partial<Record<MyWorkAction, () => void>>>({});
  // The handlers of this render, set after it commits; the key listener reads them through the ref.
  useEffect(() => {
    shortcuts.current = {
      new: () => quickAdd.current?.focus(),
      next: () => setSelected(stepSelection(order, selected, 1)),
      previous: () => setSelected(stepSelection(order, selected, -1)),
      ...(selected && view === 'open' ? { done: () => act.mutate({ what: 'complete', todoId: selected }) } : {}),
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
        {view === 'open' || view === 'done' ? (
          <Checkbox
            checked={todo.status === 'done'}
            aria-label={todo.status === 'done' ? t('reopenTodo', { title: todo.title }) : t('completeTodo', { title: todo.title })}
            disabled={act.isPending}
            onCheckedChange={(checked) => act.mutate({ what: checked === true ? 'complete' : 'reopen', todoId: todo.id })}
          />
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
      ) : todos.length === 0 ? (
        <Empty title={t(view === 'open' ? 'empty' : view === 'done' ? 'emptyDone' : 'emptyTrash')} hint={view === 'open' ? t('emptyHint') : undefined} />
      ) : view === 'open' ? (
        groups.map((g) => (
          <section key={g.id} aria-labelledby={`todo-group-${g.id}`} data-testid={`todo-group-${g.id}`}>
            <h2 id={`todo-group-${g.id}`} className={cn('mb-1 text-sm font-medium', g.id === 'overdue' ? 'text-destructive' : 'text-foreground')}>
              {t(`groups.${g.id}`)} <span className="text-subtle-foreground">({g.items.length})</span>
            </h2>
            <Card className="block p-0">
              <ul className="divide-y">{g.items.map((todo) => row(todo, g.items))}</ul>
            </Card>
          </section>
        ))
      ) : (
        <Card className="block p-0">
          <ul className="divide-y">{todos.map((todo) => row(todo, todos))}</ul>
        </Card>
      )}
      {todos.length >= LIST_LIMIT && <p className="text-xs text-subtle-foreground">{t('truncated', { count: String(LIST_LIMIT) })}</p>}
      {act.error && <ErrorText>{errorMessage(act.error)}</ErrorText>}
      <p className="text-xs text-subtle-foreground">{t('shortcuts')}</p>
    </div>
  );
}
