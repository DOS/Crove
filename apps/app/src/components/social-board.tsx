// The Social board (#1022): the posts of the Social home's list (the same query and filters as the lists and the
// calendar) in a column per status. Members drag a card, press the left or right arrow on it, or use its buttons, to
// move it along a legal step; each step is the command the post page uses. Any other drop is refused here with the
// reason and sends nothing. The server still decides who may approve (four-eyes, several approvals): its refusal is
// shown as it comes. The columns wrap (six in a row on wide screens, three or two below, one on a phone) rather than
// scroll sideways, so every drop target is in view. Members tick cards for the bulk bar's labels and assignee (#1057).
// Under a channel filter a move still acts on every channel of the post, as the commands do (#1044): a card with
// channels outside the filter names them. A drop while a move is still running is refused and said so.
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useCallback, useEffect, useId, useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import { useTranslations } from 'use-intl';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Checkbox } from '@crove/ui/components/checkbox';
import { cn } from '@crove/ui/lib/utils';
import { OpenComments } from './social-activity.tsx';
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
  needsChecklist,
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

type Notice = { kind: 'refused'; reason: BoardRefusal } | { kind: 'done'; outcome: BoardOutcome } | { kind: 'busy' };

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
  onFocused,
  picked,
  onToggle,
  filtered,
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
  onFocused: () => void;
  // Whether the card is ticked for the bulk bar; null when the viewer has no bulk action.
  picked: boolean | null;
  onToggle: () => void;
  // The channel filter, if any (#1044).
  filtered: string | undefined;
}) {
  const t = useTranslations('social');
  const f = useFormat();
  const ref = useRef<HTMLDivElement>(null);
  const othersId = useId();
  // The post's channels outside the filter, which a move of the card acts on too.
  const others = filtered
    ? [...new Set(post.variants.filter((v) => v.status !== 'cancelled' && v.connectionId !== filtered).map((v) => (names.get(v.connectionId) ? `${providerName(v.provider)} (${names.get(v.connectionId)})` : providerName(v.provider))))]
    : [];
  // After a move by keyboard, the card takes the focus once it shows in its new column, and only then.
  useEffect(() => {
    if (!focus) return;
    ref.current?.focus();
    onFocused();
  }, [focus, onFocused]);
  const text = excerpt(post.body) || t('emptyText');
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.target !== e.currentTarget || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
    // A held key or a combination (Alt+arrow is the browser's back and forward) never moves a card.
    if (e.repeat || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
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
      aria-describedby={[hintId, others.length > 0 ? othersId : null].filter(Boolean).join(' ') || undefined}
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
      <div className="flex items-start gap-2">
        {picked !== null && <Checkbox className="mt-0.5" checked={picked} onCheckedChange={onToggle} aria-label={t('bulk.select', { text })} />}
        <Link to="/o/$slug/social/$id" params={{ slug, id: post.id }} draggable={false} className="line-clamp-3 min-w-0 flex-1 text-sm [overflow-wrap:anywhere] text-foreground hover:underline">
          {text}
        </Link>
      </div>
      <div className="flex flex-wrap gap-1">
        {post.variants
          .filter((v) => v.status !== 'cancelled')
          .map((v) => (
            <Badge key={v.id} variant={variantTone(v)} title={names.get(v.connectionId)}>
              {providerName(v.provider)} · {t(`status.${variantStatusKey(v)}`)}
            </Badge>
          ))}
        <OpenComments count={post.openComments} />
      </div>
      {(assignee || post.dueAt) && (
        <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          {assignee && <span>{assignee}</span>}
          {post.dueAt && <span className="tabular-nums">{t('assign.dueOn', { when: f.dateTime(post.dueAt) })}</span>}
          {isOverdue(post, Date.now()) && <Badge variant="destructive">{t('assign.overdue')}</Badge>}
        </p>
      )}
      <PostLabels ids={post.labelIds} labels={labels} />
      {others.length > 0 && (
        <p id={othersId} className="text-xs text-subtle-foreground">
          {t('board.otherChannels', { channels: others.join(', ') })}
        </p>
      )}
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
  picked = null,
  onPick = () => undefined,
  connectionId,
}: {
  posts: readonly Post[];
  slug: string;
  names: Map<string, string>;
  labels: readonly SocialLabel[];
  // Member and above; owner or admin.
  canWrite: boolean;
  canDecide: boolean;
  // The posts ticked for the bulk bar (#1057), or null when the viewer has no bulk action.
  picked?: ReadonlySet<string> | null;
  onPick?: (next: Set<string>) => void;
  // The Social home's channel filter (#1044).
  connectionId?: string | undefined;
}) {
  const t = useTranslations('social');
  const hintId = useId();
  const who = { canWrite, canDecide };
  const org = useQuery(orpc.org.get.queryOptions());
  const members = new Map((org.data?.members ?? []).map((m) => [m.userId, m.displayName ?? m.email]));
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<BoardColumn | null>(null);
  // The card moved by keyboard and the column it goes to: it takes the focus there, once.
  const [focusTo, setFocusTo] = useState<{ id: string; column: BoardColumn } | null>(null);
  const clearFocus = useCallback(() => setFocusTo(null), []);
  const [notice, setNotice] = useState<Notice | null>(null);
  const move = useMutation({
    mutationFn: (args: { request: NonNullable<ReturnType<typeof boardRequest>>; postId: string }) => sendBoardRequest(args.request, api),
    onSuccess: (outcome) => setNotice({ kind: 'done', outcome }),
    // A refused move leaves the card where it is, focused already: nothing to take the focus later.
    onError: () => setFocusTo(null),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: orpc.social.posts.key() }),
  });
  const placed = posts.map((post) => ({ post, column: postColumn(post.variants) })).filter((x): x is { post: Post; column: BoardColumn } => x.column !== null);
  const columnOf = (postId: string) => placed.find((x) => x.post.id === postId);

  // A move asked by drop, key or button: refused here with the reason, or sent as the existing command.
  const attempt = (postId: string, to: BoardColumn, byKey: boolean) => {
    const found = columnOf(postId);
    if (!found) return;
    if (move.isPending) {
      setNotice({ kind: 'busy' });
      return;
    }
    setFocusTo(null);
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
    if (request.move === 'approve' && needsChecklist(found.post)) {
      setNotice({ kind: 'refused', reason: 'checklist' });
      return;
    }
    setNotice(null);
    if (byKey) setFocusTo({ id: postId, column: to });
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

  const toggle = (postId: string) => {
    if (!picked) return;
    const next = new Set(picked);
    if (next.has(postId)) next.delete(postId);
    else next.add(postId);
    onPick(next);
  };
  const shownIds = placed.map((x) => x.post.id);

  const doneText = (o: BoardOutcome) => (o.move === 'approve' && o.waiting > 0 ? t('board.done.waiting') : t(`board.done.${o.move}`));
  return (
    <div className="space-y-3">
      {canWrite && (
        <p id={hintId} className="text-xs text-subtle-foreground">
          {t('board.hint')}
        </p>
      )}
      {picked && shownIds.length > 0 && (
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <Checkbox checked={shownIds.every((id) => picked.has(id))} onCheckedChange={(on) => {
              // Adds or removes the posts shown here, keeping what was picked elsewhere.
              const next = new Set(picked);
              for (const id of shownIds) {
                if (on === true) next.add(id);
                else next.delete(id);
              }
              onPick(next);
            }}
          />
          {t('bulk.selectAll')}
        </label>
      )}
      {/* Refusals and results are read out; a server refusal shows as an error with the kernel's message. */}
      <div aria-live="polite" className="space-y-2">
        {move.error ? (
          <ErrorText>{errorMessage(move.error)}</ErrorText>
        ) : notice?.kind === 'refused' ? (
          <ErrorText>{t(`board.refused.${notice.reason}`)}</ErrorText>
        ) : notice?.kind === 'done' ? (
          <p className="text-sm text-muted-foreground">{doneText(notice.outcome)}</p>
        ) : notice?.kind === 'busy' ? (
          <p className="text-sm text-muted-foreground">{t('board.busy')}</p>
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
                    focus={focusTo?.id === post.id && focusTo.column === column}
                    onFocused={clearFocus}
                    hintId={canWrite ? hintId : undefined}
                    draggable={canWrite}
                    onDragStart={() => {
                      setFocusTo(null);
                      setDragging(post.id);
                    }}
                    onDragEnd={() => {
                      setDragging(null);
                      setOver(null);
                    }}
                    onMove={(to, byKey) => attempt(post.id, to, byKey)}
                    picked={picked ? picked.has(post.id) : null}
                    onToggle={() => toggle(post.id)}
                    filtered={connectionId}
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
