// Tasks (ADR-0029, issue #258): work given to positions of the chart, held by members or AI agents. Every member
// reads them; owners, admins and members give work, comment and change status. A task made from untrusted content
// (an email, a run that read one) is marked, so nobody acts on it unchecked.
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Input } from '@crove/ui/components/input';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { TableCell, TableRow } from '@crove/ui/components/table';
import { Tabs, TabsList, TabsTrigger } from '@crove/ui/components/tabs';
import { DataTable, Empty, ErrorText, ListSkeleton, PageHeader, Spinner } from '../components/ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { OPEN_TASK_STATUSES, TASK_LIST_LIMIT, TASK_STATUSES, agentPermissions, socialPostOf, type TaskFilter, type TaskStatus, type TasksSearch } from '../lib/agents.ts';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';

type Chart = Awaited<ReturnType<typeof orpc.chart.get.call>>;

const refresh = () => void queryClient.invalidateQueries();

function statusVariant(status: string): 'success' | 'warning' | 'outline' | 'secondary' {
  if (status === 'done') return 'success';
  if (status === 'waiting' || status === 'in_review') return 'warning';
  if (status === 'cancelled') return 'outline';
  return 'secondary';
}

function positionTitle(chart: Chart | undefined, id: string | null, root: string, unknown: string): string {
  if (id === null) return root;
  return chart?.positions.find((p) => p.id === id)?.title ?? unknown;
}

function NewTask({ chart }: { chart: Chart | undefined }) {
  const t = useTranslations('tasks');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [assignee, setAssignee] = useState('');
  const [key, setKey] = useState(() => crypto.randomUUID());
  const create = useMutation(orpc.tasks.create.mutationOptions({ onSuccess: refresh }));
  const positions = (chart?.positions ?? []).filter((p) => p.status !== 'archived');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate(
      { title: title.trim(), ...(description.trim() ? { description: description.trim() } : {}), assigneePositionId: assignee || null, idempotencyKey: key },
      {
        onSuccess: () => {
          setTitle('');
          setDescription('');
          setKey(crypto.randomUUID());
        },
      },
    );
  };
  return (
    <form onSubmit={submit} className="mb-6 grid gap-3 rounded-lg border bg-muted/40 p-3 md:grid-cols-4">
      <p className="text-sm font-medium text-foreground md:col-span-4">{t('newTask')}</p>
      <label className="block text-xs md:col-span-2">
        <span className="text-subtle-foreground">{t('newTitle')}</span>
        <Input required maxLength={300} value={title} onChange={(e) => setTitle(e.target.value)} className="mt-1" />
      </label>
      <label className="block text-xs md:col-span-2">
        <span className="text-subtle-foreground">{t('assignTo')}</span>
        <NativeSelect className="mt-1 w-full" value={assignee} onChange={(e) => setAssignee(e.target.value)}>
          <NativeSelectOption value="">{t('rootAssignee')}</NativeSelectOption>
          {positions.map((p) => (
            <NativeSelectOption key={p.id} value={p.id}>
              {p.title}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </label>
      <label className="block text-xs md:col-span-4">
        <span className="text-subtle-foreground">{t('newDescription')}</span>
        <Input maxLength={10000} value={description} onChange={(e) => setDescription(e.target.value)} className="mt-1" />
      </label>
      <div className="flex items-center gap-2 md:col-span-4">
        <Button type="submit" disabled={create.isPending}>
          {create.isPending ? <Spinner /> : null}
          {t('create')}
        </Button>
        {create.error && <span className="text-xs text-destructive">{errorMessage(create.error)}</span>}
      </div>
    </form>
  );
}

export function TasksPage() {
  const { slug } = useParams({ strict: false }) as { slug: string };
  const t = useTranslations('tasks');
  const f = useFormat();
  // The tab lives in the address (#1513), left out for the open tasks.
  const search: TasksSearch = useSearch({ strict: false });
  const navigate = useNavigate();
  const filter: TaskFilter = search.filter ?? 'open';
  const setFilter = (next: TaskFilter) => void navigate({ to: '/o/$slug/tasks', params: { slug }, search: next === 'open' ? {} : { filter: next } });
  const org = useQuery(orpc.org.get.queryOptions());
  const chart = useQuery(orpc.chart.get.queryOptions());
  const input = filter === 'mine' ? { mine: true } : filter === 'open' ? { status: [...OPEN_TASK_STATUSES] } : {};
  const tasks = useQuery(orpc.tasks.list.queryOptions({ input }));
  const perms = agentPermissions(org.data?.role);

  return (
    <div>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      {perms.tasks && <NewTask chart={chart.data} />}
      <Tabs value={filter} onValueChange={(value) => setFilter(value as TaskFilter)} className="mb-4">
        <TabsList>
          <TabsTrigger value="open">{t('filterOpen')}</TabsTrigger>
          <TabsTrigger value="mine">{t('filterMine')}</TabsTrigger>
          <TabsTrigger value="all">{t('filterAll')}</TabsTrigger>
        </TabsList>
      </Tabs>
      {tasks.isPending ? (
        <ListSkeleton />
      ) : tasks.error ? (
        <ErrorText>{errorMessage(tasks.error)}</ErrorText>
      ) : tasks.data.length === 0 ? (
        <Empty title={t('empty')} hint={t(filter === 'mine' ? 'emptyMineHint' : 'emptyHint')} />
      ) : (
        <>
          {tasks.data.length >= TASK_LIST_LIMIT && <p className="mb-2 text-xs text-muted-foreground">{t('truncated', { count: String(TASK_LIST_LIMIT) })}</p>}
          <DataTable head={[t('colTitle'), t('colAssignee'), t('colStatus'), t('colCreated')]}>
            {tasks.data.map((task) => (
              <TableRow key={task.id} data-testid="task-row">
                <TableCell className="px-4">
                  <Link to="/o/$slug/tasks/$id" params={{ slug, id: task.id }} className="font-medium text-link hover:underline">
                    {task.title}
                  </Link>
                  {task.tainted && (
                    <Badge variant="warning" className="ml-2" title={t('taintedHint')}>
                      {t('tainted')}
                    </Badge>
                  )}
                </TableCell>
                <TableCell className="px-4 text-sm text-muted-foreground">{positionTitle(chart.data, task.assigneePositionId, t('rootAssignee'), t('unknownPosition'))}</TableCell>
                <TableCell className="px-4">
                  <Badge variant={statusVariant(task.status)}>{t(`status.${task.status}`)}</Badge>
                </TableCell>
                <TableCell className="px-4 text-xs text-muted-foreground">{f.dateTime(task.createdAt)}</TableCell>
              </TableRow>
            ))}
          </DataTable>
        </>
      )}
    </div>
  );
}

export function TaskDetailPage() {
  const { slug, id } = useParams({ strict: false }) as { slug: string; id: string };
  const t = useTranslations('tasks');
  const ta = useTranslations('agents');
  const f = useFormat();
  const org = useQuery(orpc.org.get.queryOptions());
  const chart = useQuery(orpc.chart.get.queryOptions());
  const detail = useQuery(orpc.tasks.get.queryOptions({ input: { id } }));
  const perms = agentPermissions(org.data?.role);
  const [body, setBody] = useState('');
  const [commentKey, setCommentKey] = useState(() => crypto.randomUUID());
  const comment = useMutation(orpc.tasks.comment.mutationOptions({ onSuccess: refresh }));
  const setStatus = useMutation(orpc.tasks.setStatus.mutationOptions({ onSuccess: refresh }));

  const back = (
    <Link to="/o/$slug/tasks" params={{ slug }} className="text-sm text-link hover:underline">
      {t('back')}
    </Link>
  );
  if (detail.isPending) return <Spinner />;
  if (detail.error) {
    return (
      <div className="space-y-3">
        {back}
        <ErrorText>{errorMessage(detail.error)}</ErrorText>
      </div>
    );
  }
  const { task, comments, proposal } = detail.data;
  const postId = socialPostOf(task.sourceRef);
  const members = org.data?.members ?? [];
  const authorName = (c: (typeof comments)[number]) =>
    c.authorType === 'agent'
      ? t('author.agent')
      : c.authorType === 'user'
        ? (members.find((m) => m.userId === c.authorId)?.displayName ?? members.find((m) => m.userId === c.authorId)?.email ?? t('author.user'))
        : t('author.system');

  return (
    <div className="space-y-6">
      <div>{back}</div>
      <PageHeader title={task.title} subtitle={positionTitle(chart.data, task.assigneePositionId, t('rootAssignee'), t('unknownPosition'))} />
      <Card className="gap-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={statusVariant(task.status)}>{t(`status.${task.status}`)}</Badge>
          {task.tainted && <Badge variant="warning">{t('tainted')}</Badge>}
          {task.checkedOut && <Badge variant="secondary">{t('checkedOut')}</Badge>}
          <span className="text-xs text-muted-foreground">{f.dateTime(task.createdAt)}</span>
        </div>
        {task.tainted && <p className="text-sm text-warning">{t('taintedHint')}</p>}
        <div>
          <p className="text-xs text-subtle-foreground">{t('description')}</p>
          <p className="text-sm whitespace-pre-wrap text-foreground">{task.description ?? t('noDescription')}</p>
        </div>
        {proposal && (
          <p className="text-sm text-muted-foreground">
            {t('proposal', { title: proposal.title })}{' '}
            <Link to="/o/$slug/inbox/$id" params={{ slug, id: proposal.id }} className="text-link underline">
              {t('openProposal')}
            </Link>
          </p>
        )}
        {/* A Social post's task (#1193) says only counts: the post page has the rest, and answers 404 to a member who
            may not see the post. */}
        {postId && (
          <p className="text-sm">
            <Link to="/o/$slug/social/$id" params={{ slug, id: postId }} className="text-link underline">
              {t('openPost')}
            </Link>
          </p>
        )}
        {perms.tasks && (
          <label className="block w-56 text-xs">
            <span className="text-subtle-foreground">{t('setStatus')}</span>
            <NativeSelect
              className="mt-1 w-full"
              value={task.status}
              disabled={setStatus.isPending}
              onChange={(e) => setStatus.mutate({ id: task.id, status: e.target.value as TaskStatus, idempotencyKey: crypto.randomUUID() })}
            >
              {TASK_STATUSES.map((s) => (
                <NativeSelectOption key={s} value={s}>
                  {t(`status.${s}`)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </label>
        )}
        {setStatus.error && <ErrorText>{errorMessage(setStatus.error)}</ErrorText>}
      </Card>

      <section>
        <h2 className="mb-3 text-sm font-semibold text-foreground">{t('comments')}</h2>
        {comments.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('noComments')}</p>
        ) : (
          <ul className="space-y-2">
            {comments.map((c) => (
              <li key={c.id}>
                <Card className="gap-1 p-3" data-testid="comment">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-subtle-foreground">
                    <span className="font-medium text-foreground">{authorName(c)}</span>
                    {c.authorType === 'agent' && <Badge variant="secondary">{ta('aiBadge')}</Badge>}
                    {c.tainted && <Badge variant="warning">{t('tainted')}</Badge>}
                    <span>{f.dateTime(c.createdAt)}</span>
                  </div>
                  <p className="text-sm whitespace-pre-wrap text-foreground">{c.body}</p>
                </Card>
              </li>
            ))}
          </ul>
        )}
        {perms.tasks && (
          <form
            className="mt-3 flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (!body.trim()) return;
              comment.mutate(
                { id: task.id, body: body.trim(), idempotencyKey: commentKey },
                {
                  onSuccess: () => {
                    setBody('');
                    setCommentKey(crypto.randomUUID());
                  },
                },
              );
            }}
          >
            <Input maxLength={10000} placeholder={t('commentPlaceholder')} aria-label={t('commentPlaceholder')} value={body} onChange={(e) => setBody(e.target.value)} />
            <Button type="submit" disabled={comment.isPending || !body.trim()}>
              {t('send')}
            </Button>
          </form>
        )}
        {comment.error && (
          <div className="mt-2">
            <ErrorText>{errorMessage(comment.error)}</ErrorText>
          </div>
        )}
      </section>
    </div>
  );
}
