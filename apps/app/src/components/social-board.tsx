// The Social board (#1022): the posts of the Social home's list (the same query and filters as the lists and the
// calendar) in a column per status. Members drag a card, press the left or right arrow on it, or use its buttons, to
// move it along a legal step; each step is the command the post page uses. Any other drop is refused here with the
// reason and sends nothing. The server still decides who may approve (four-eyes, several approvals): its refusal is
// shown as it comes. The columns wrap (six in a row on wide screens, three or two below, one on a phone) rather than
// scroll sideways, so every drop target is in view.
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useEffect, useId, useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import { useTranslations } from 'use-intl';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { cn } from '@crove/ui/lib/utils';
import { PostLabels, type SocialLabel } from './social-labels.tsx';
import { ErrorText } from './ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';
import { providerName, variantStatusKey, variantTone } from '../lib/social.ts';
import { isOverdue } from '../lib/social-assign.ts';
import {
  adjacentColumn,
  BOARD_COLUMNS,
  boardRequest,
  checkMove,
  movesFrom,
  postColumn,
  sendBoardRequest,
  type BoardApi,
  type BoardColumn,
  type BoardMove,
  type BoardOutcome,
  type BoardRefusal,
} from '../lib/social-board.ts';

type Post = Awaited<ReturnType<typeof orpc.social.posts.list.call>>[number];

// The existing calls, one per move.
const api: BoardApi = {
  submit: (input) => client.social.posts.submit(input),
  decide: (input) => client.social.variants.decide(input),
  schedule: (input) => client.social.variants.schedule(input),
  unschedule: (input) => client.social.variants.unschedule(input),
};

const excerpt = (text: string, max = 140) => {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};

type Notice = { kind: 'refused'; reason: BoardRefusal } | { kind: 'done'; outcome: BoardOutcome };

function Card({
  post,
  column,
  slug,
  names,
  labels,
  members,
  moves,
  busy,
  focus,
  hintId,
  draggable,
  onDragStart,
  onDragEnd,
  onMove,
}: {
  post: Post;
  column: BoardColumn;
  slug: string;
  names: Map<string, string>;
  labels: readonly SocialLabel[];
  members: Map<string, string>;
  moves: { move: BoardMove; to: BoardColumn }[];
  busy: boolean;
  focus: boolean;
  hintId: string | undefined;
  draggable: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onMove: (to: BoardColumn, byKey: boolean) => void;
}) {
  const t = useTranslations('social');
  const f = useFormat();
  const ref = useRef<HTMLDivElement>(null);
  // After a move by keyboard, the card keeps the focus in its new column.
  useEffect(() => {
    if (focus) ref.current?.focus();
  }, [focus, column]);
  const text = excerpt(post.body) || t('emptyText');
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.target !== e.currentTarget || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
    e.preventDefault();
    const to = adjacentColumn(column, e.key === 'ArrowLeft' ? -1 : 1);
    if (to) onMove(to, true);
  };
  const assignee = post.assigneeUserId ? (members.get(post.assigneeUserId) ?? t('assign.formerMember')) : null;
  return (
    <div
      ref={ref}
      tabIndex={0}
      role="group"
      aria-label={t('board.card', { text, column: t(`status.${column}`) })}
      aria-describedby={hintId}
      aria-busy={busy}
      data-testid="board-card"
      draggable={draggable}
      onDragStart={(e: DragEvent) => {
        e.dataTransfer.setData('text/plain', post.id);
        e.dataTransfer.effectAllowed = 'move';
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      onKeyDown={onKeyDown}
      className={cn(
        'block space-y-2 rounded-lg border bg-card p-3 transition-colors outline-none hover:border-ring/60 focus-visible:ring-3 focus-visible:ring-ring/50',
        draggable && 'cursor-grab active:cursor-grabbing',
        busy && 'opacity-60',
      )}
    >
      <Link to="/o/$slug/social/$id" params={{ slug, id: post.id }} draggable={false} className="line-clamp-3 text-sm [overflow-wrap:anywhere] text-foreground hover:underline">
        {text}
      </Link>
      <div className="flex flex-wrap gap-1">
        {post.variants
          .filter((v) => v.status !== 'cancelled')
          .map((v) => (
            <Badge key={v.id} variant={variantTone(v)} title={names.get(v.connectionId)}>
              {providerName(v.provider)} · {t(`status.${variantStatusKey(v)}`)}
            </Badge>
          ))}
      </div>
      {(assignee || post.dueAt) && (
        <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          {assignee && <span>{assignee}</span>}
          {post.dueAt && <span className="tabular-nums">{t('assign.dueOn', { when: f.dateTime(post.dueAt) })}</span>}
          {isOverdue(post, Date.now()) && <Badge variant="destructive">{t('assign.overdue')}</Badge>}
        </p>
      )}
      <PostLabels ids={post.labelIds} labels={labels} />
      {moves.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {moves.map((m) => (
            <Button key={m.move} size="sm" variant="outline" disabled={busy} aria-label={t('board.moveOf', { action: t(`board.move.${m.move}`), text })} onClick={() => onMove(m.to, false)}>
              {t(`board.move.${m.move}`)}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}

export function SocialBoard({
  posts,
  slug,
  names,
  labels,
  canWrite,
  canDecide,
}: {
  posts: readonly Post[];
  slug: string;
  names: Map<string, string>;
  labels: readonly SocialLabel[];
  // Member and above; owner or admin.
  canWrite: boolean;
  canDecide: boolean;
}) {
  const t = useTranslations('social');
  const hintId = useId();
  const who = { canWrite, canDecide };
  const org = useQuery(orpc.org.get.queryOptions());
  const members = new Map((org.data?.members ?? []).map((m) => [m.userId, m.displayName ?? m.email]));
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<BoardColumn | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const move = useMutation({
    mutationFn: (args: { request: NonNullable<ReturnType<typeof boardRequest>>; postId: string }) => sendBoardRequest(args.request, api),
    onSuccess: (outcome) => setNotice({ kind: 'done', outcome }),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: orpc.social.posts.key() }),
  });
  const placed = posts.map((post) => ({ post, column: postColumn(post.variants) })).filter((x): x is { post: Post; column: BoardColumn } => x.column !== null);
  const columnOf = (postId: string) => placed.find((x) => x.post.id === postId);

  // A move asked by drop, key or button: refused here with the reason, or sent as the existing command.
  const attempt = (postId: string, to: BoardColumn, byKey: boolean) => {
    const found = columnOf(postId);
    if (!found || move.isPending) return;
    setFocusId(byKey ? postId : null);
    const check = checkMove(found.column, to, who);
    if (!check) return;
    move.reset();
    if (!check.ok) {
      setNotice({ kind: 'refused', reason: check.reason });
      return;
    }
    const request = boardRequest(found.post, check.move, Date.now());
    if (!request) {
      setNotice({ kind: 'refused', reason: 'nothing' });
      return;
    }
    setNotice(null);
    move.mutate({ request, postId });
  };

  const from = dragging ? columnOf(dragging)?.column : undefined;
  const onDrop = (to: BoardColumn) => (e: DragEvent) => {
    e.preventDefault();
    setOver(null);
    const postId = dragging ?? e.dataTransfer.getData('text/plain');
    setDragging(null);
    if (postId) attempt(postId, to, false);
  };

  const doneText = (o: BoardOutcome) => (o.move === 'approve' && o.waiting > 0 ? t('board.done.waiting') : t(`board.done.${o.move}`));
  return (
    <div className="space-y-3">
      {canWrite && (
        <p id={hintId} className="text-xs text-subtle-foreground">
          {t('board.hint')}
        </p>
      )}
      {/* Refusals and results are read out; a server refusal shows as an error with the kernel's message. */}
      <div aria-live="polite" className="space-y-2">
        {move.error ? (
          <ErrorText>{errorMessage(move.error)}</ErrorText>
        ) : notice?.kind === 'refused' ? (
          <ErrorText>{t(`board.refused.${notice.reason}`)}</ErrorText>
        ) : notice?.kind === 'done' ? (
          <p className="text-sm text-muted-foreground">{doneText(notice.outcome)}</p>
        ) : null}
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
        {BOARD_COLUMNS.map((column) => {
          const cards = placed.filter((x) => x.column === column);
          const legal = from ? checkMove(from, column, who) : null;
          return (
            <section
              key={column}
              aria-labelledby={`${hintId}-${column}`}
              data-column={column}
              onDragOver={(e) => {
                if (!dragging) return;
                e.preventDefault();
                setOver(column);
              }}
              onDragLeave={() => setOver((o) => (o === column ? null : o))}
              onDrop={onDrop(column)}
              className={cn(
                'min-w-0 space-y-2 rounded-lg bg-muted/40 p-2 transition-shadow',
                over === column && column !== from && (legal?.ok ? 'ring-2 ring-primary ring-inset' : 'ring-2 ring-destructive/60 ring-inset'),
              )}
            >
              <h3 className="flex items-center justify-between px-1 text-sm font-medium text-foreground">
                {/* The column is named by its status alone; the count follows it. */}
                <span id={`${hintId}-${column}`}>{t(`status.${column}`)}</span>
                <span className="text-xs text-subtle-foreground tabular-nums">{cards.length}</span>
              </h3>
              {cards.length === 0 ? (
                <p className="px-1 py-3 text-xs text-subtle-foreground">{t('board.emptyColumn')}</p>
              ) : (
                cards.map(({ post }) => (
                  <Card
                    key={post.id}
                    post={post}
                    column={column}
                    slug={slug}
                    names={names}
                    labels={labels}
                    members={members}
                    moves={movesFrom(column, who)}
                    busy={move.isPending && move.variables?.postId === post.id}
                    focus={focusId === post.id}
                    hintId={canWrite ? hintId : undefined}
                    draggable={canWrite}
                    onDragStart={() => {
                      setFocusId(null);
                      setDragging(post.id);
                    }}
                    onDragEnd={() => {
                      setDragging(null);
                      setOver(null);
                    }}
                    onMove={(to, byKey) => attempt(post.id, to, byKey)}
                  />
                ))
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
