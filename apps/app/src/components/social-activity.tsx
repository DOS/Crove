// A post's internal comments and timeline (#582): members write a comment on the post or on one channel, the author
// may fix it for 15 minutes, and everyone sees what happened to the post, newest first. Comments are never published.
// A comment dealt with is marked resolved (#1168) and shows greyed, with who resolved it and when; it can be reopened.
// A comment can be pinned (#1180) to a spot on one of the post's images or a moment in one of its videos.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { SENT_TO_APP, WORDPRESS_DRAFT, WORDPRESS_PENDING, mentionsForEditing, mentionsForStoring } from '@crove/mod-social/contract';
import { cn } from '@crove/ui/lib/utils';
import { CommentBody, MentionBox, useMemberNames, type Picked } from './social-mentions.tsx';
import { PinBoard, boardPins, clockOf, commentAnchor, revealMarker, useMediaLabels, type DraftPin, type PinMedia } from './social-comment-pins.tsx';
import { Thumb } from './social-media.tsx';
import { TickedChecks } from './social-review-checklist.tsx';
import { ErrorText, Spinner } from './ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';

type Item = Awaited<ReturnType<typeof client.social.posts.activity>>['items'][number];
const MAX = 4000;

// Where a comment is pinned (#1180): its number on the board, which brings its marker into view; on a resolved
// comment, whose marker is hidden, only where; on a file the post no longer uses, that file's thumbnail.
function PinNote({ item, n, onBoard }: { item: Item & { pin: NonNullable<Item['pin']> }; n: number | null; onBoard: boolean }) {
  const t = useTranslations('social.activity');
  const { pin } = item;
  const time = pin.atSeconds !== null ? clockOf(pin.atSeconds) : null;
  if (!pin.current || !onBoard) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground" data-testid="pin-old">
        <Thumb fileId={pin.fileId} alt={pin.filename} name={pin.filename} mime={pin.mime} className="size-12 shrink-0" />
        <span>
          {t(pin.mime.startsWith('video/') ? 'oldVideo' : 'oldImage')}
          {time ? ` · ${time}` : ''}
        </span>
      </div>
    );
  }
  if (n === null) return <p className="text-xs text-muted-foreground">{time ? t('pinnedAtHidden', { time }) : t('pinnedHidden')}</p>;
  return (
    <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => revealMarker(item.id)}>
      {time ? t('pinnedAt', { n: String(n), time }) : t('pinned', { n: String(n) })}
    </Button>
  );
}

function Entry({ item, channel, canWrite, pinNumber, onBoard }: { item: Item; channel: string | null; canWrite: boolean; pinNumber: number | null; onBoard: boolean }) {
  const t = useTranslations('social.activity');
  const f = useFormat();
  const [editing, setEditing] = useState<string | null>(null);
  const [picked, setPicked] = useState<Picked>([]);
  const { labelOf } = useMemberNames();
  const edit = useMutation({
    mutationFn: (body: string) => client.social.posts.editComment({ commentId: item.id, body: mentionsForStoring(body, picked) }),
    onSuccess: () => {
      setEditing(null);
      void queryClient.invalidateQueries({ queryKey: orpc.social.posts.activity.key() });
    },
  });
  // Resolving or reopening changes the post's open count too, so the post is read again with the timeline.
  const mark = useMutation({
    mutationFn: (resolve: boolean) => (resolve ? client.social.posts.resolveComment({ commentId: item.id }) : client.social.posts.reopenComment({ commentId: item.id })),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: orpc.social.posts.activity.key() });
      void queryClient.invalidateQueries({ queryKey: orpc.social.posts.get.key() });
      void queryClient.invalidateQueries({ queryKey: orpc.social.posts.list.key() });
    },
  });
  const resolved = item.kind === 'comment' && item.resolvedAt !== null;
  const who = item.name ?? t(item.userId ? 'formerMember' : 'system');
  const what =
    item.kind === 'decision'
      ? t(`decision.${item.decision === 'approved' ? 'approved' : item.decision === 'rejected' ? 'rejected' : 'changes_requested'}`)
      : item.kind === 'created' && item.code === 'ai'
        ? t('createdAi')
        : // A draft sent to the TikTok app (#903) or kept on the WordPress site (#981) is not out yet.
          item.kind === 'published' && item.code === SENT_TO_APP
          ? t('sentToApp')
          : item.kind === 'published' && (item.code === WORDPRESS_DRAFT || item.code === WORDPRESS_PENDING)
            ? t(item.code === WORDPRESS_DRAFT ? 'wordpressDraft' : 'wordpressPending')
            : // How a queue reorder (#1020) moved it: shuffled, put first, or one place later behind a post put first.
              item.kind === 'queue_moved' && (item.code === 'shuffle' || item.code === 'front' || item.code === 'shifted')
              ? t(`queueMoved.${item.code}`)
              : t(`kind.${item.kind}`);
  return (
    <li
      id={item.kind === 'comment' ? commentAnchor(item.id) : undefined}
      tabIndex={item.kind === 'comment' ? -1 : undefined}
      className={cn('space-y-1 border-l-2 py-1 pl-3 text-sm focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none', item.kind === 'comment' && !resolved ? 'border-primary' : 'border-border', resolved && 'opacity-60')}
      data-resolved={resolved || undefined}
    >
      <p className="text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{item.kind === 'published' || item.kind === 'failed' || item.kind === 'cancelled' || item.kind === 'auto_replied' || item.kind === 'auto_reply_failed' || item.kind === 'reposted' || item.kind === 'repost_failed' || item.kind === 'live_edited' || item.kind === 'live_edit_failed' ? (channel ?? t('channel')) : who}</span>{' '}
        {what}
        {channel && !['published', 'failed', 'cancelled', 'auto_replied', 'auto_reply_failed', 'reposted', 'repost_failed', 'live_edited', 'live_edit_failed'].includes(item.kind) ? ` · ${channel}` : ''} · <time dateTime={item.at}>{f.dateTime(item.at)}</time>
        {item.editedAt ? ` · ${t('edited')}` : ''}
      </p>
      {(item.kind === 'failed' || item.kind === 'auto_reply_failed' || item.kind === 'repost_failed' || item.kind === 'live_edit_failed') && item.code && <p className="font-mono text-xs text-warning">{item.code}</p>}
      {/* The review checklist items the reviewer ticked when approving (#1105). */}
      {item.kind === 'decision' && <TickedChecks items={item.checklist} />}
      {item.kind === 'published' && item.url && /^https?:\/\//.test(item.url) && (
        <a href={item.url} target="_blank" rel="noopener noreferrer" className="text-xs text-link hover:underline">
          {t('open')}
        </a>
      )}
      {editing !== null ? (
        <div className="space-y-2">
          <MentionBox value={editing} onChange={setEditing} picked={picked} onPicked={setPicked} maxLength={MAX} rows={3} label={t('editLabel')} />
          {mentionsForStoring(editing.trim(), picked).length > MAX && <ErrorText>{t('tooLong', { max: MAX })}</ErrorText>}
          {edit.error && <ErrorText>{errorMessage(edit.error)}</ErrorText>}
          <div className="flex gap-2">
            <Button size="sm" disabled={edit.isPending || editing.trim() === '' || mentionsForStoring(editing.trim(), picked).length > MAX} onClick={() => edit.mutate(editing.trim())}>
              {t('saveEdit')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
              {t('cancelEdit')}
            </Button>
          </div>
        </div>
      ) : (
        item.body && (item.kind === 'comment' ? <CommentBody body={item.body} /> : <p className="whitespace-pre-wrap break-words text-foreground">{item.body}</p>)
      )}
      {item.kind === 'comment' && item.pin && <PinNote item={{ ...item, pin: item.pin }} n={pinNumber} onBoard={onBoard} />}
      {resolved && item.resolvedAt && (
        <p className="text-xs text-muted-foreground">{t('resolvedBy', { name: item.resolvedByName ?? t('formerMember'), when: f.dateTime(item.resolvedAt) })}</p>
      )}
      {item.kind === 'comment' && canWrite && editing === null && (item.editable || item.resolvable) && (
        <div className="flex flex-wrap gap-1">
          {item.editable && (
            <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => {
                const shown = mentionsForEditing(item.body ?? '', labelOf);
                setPicked(shown.picked);
                setEditing(shown.text);
              }}
            >
              {t('edit')}
            </Button>
          )}
          {item.resolvable && (
            <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" disabled={mark.isPending} onClick={() => mark.mutate(!resolved)}>
              {t(resolved ? 'reopen' : 'resolve')}
            </Button>
          )}
        </div>
      )}
      {mark.error && <ErrorText>{errorMessage(mark.error)}</ErrorText>}
    </li>
  );
}

// media: the post's images and videos, and each channel's own, that comments can be pinned to (#1180).
export function PostActivity({ postId, channels, canWrite, className, media = [] }: { postId: string; channels: { variantId: string; name: string }[]; canWrite: boolean; className?: string; media?: readonly PinMedia[] }) {
  const t = useTranslations('social.activity');
  const activity = useQuery(orpc.social.posts.activity.queryOptions({ input: { postId } }));
  const [body, setBody] = useState('');
  const [variantId, setVariantId] = useState('');
  const [picked, setPicked] = useState<Picked>([]);
  const [draft, setDraft] = useState<DraftPin | null>(null);
  const add = useMutation({
    mutationFn: () =>
      client.social.posts.comment({
        postId,
        body: mentionsForStoring(body.trim(), picked),
        ...(variantId ? { variantId } : {}),
        ...(draft ? { pin: 'atSeconds' in draft ? { fileId: draft.fileId, atSeconds: draft.atSeconds } : { fileId: draft.fileId, x: draft.x, y: draft.y } } : {}),
      }),
    onSuccess: () => {
      setBody('');
      setPicked([]);
      setDraft(null);
      void queryClient.invalidateQueries({ queryKey: orpc.social.posts.activity.key() });
    },
  });
  const nameOf = new Map(channels.map((c) => [c.variantId, c.name]));
  const items = activity.data?.items ?? [];
  const onBoard = new Set(media.map((m) => m.fileId));
  const pins = boardPins(items, onBoard);
  const pinNumber = new Map(pins.map((p) => [p.commentId, p.n]));
  // A pin on a channel's own file makes the comment that channel's; choosing another target drops such a pin.
  const pickPin = (pin: DraftPin) => {
    setDraft(pin);
    if (pin.variantId) setVariantId(pin.variantId);
  };
  const labels = useMediaLabels(media);
  const draftName = draft ? (labels.get(`${draft.variantId ?? 'post'}:${draft.fileId}`) ?? '') : '';
  // Each mention is stored as its member's token, longer than the @name shown, so the limit counts what is stored.
  const tooLong = mentionsForStoring(body.trim(), picked).length > MAX;
  return (
    <Card className={cn('block space-y-3 p-4', className)}>
      <div>
        <h3 className="text-sm font-medium text-foreground">{t('title')}</h3>
        <p className="text-xs text-subtle-foreground">{t('hint')}</p>
      </div>
      <PinBoard media={media} pins={pins} draft={draft} onDraft={pickPin} canPin={canWrite} />
      {canWrite && (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (body.trim() !== '' && !add.isPending && !tooLong) add.mutate();
          }}
        >
          <MentionBox value={body} onChange={setBody} picked={picked} onPicked={setPicked} maxLength={MAX} rows={3} placeholder={t('placeholder')} label={t('placeholder')} />
          {draft && (
            <div className="flex flex-wrap items-center gap-2 text-xs text-foreground" role="status" data-testid="pin-draft-note">
              <span>{'atSeconds' in draft ? t('draftVideo', { media: draftName, time: clockOf(draft.atSeconds) }) : t('draftImage', { media: draftName })}</span>
              <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setDraft(null)}>
                {t('unpin')}
              </Button>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {channels.length > 1 && (
              <NativeSelect
                value={variantId}
                onChange={(e) => {
                  setVariantId(e.target.value);
                  if (draft?.variantId && draft.variantId !== e.target.value) setDraft(null);
                }}
                aria-label={t('about')}
                className="w-auto"
              >
                <NativeSelectOption value="">{t('wholePost')}</NativeSelectOption>
                {channels.map((c) => (
                  <NativeSelectOption key={c.variantId} value={c.variantId}>
                    {c.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            )}
            <Button type="submit" size="sm" disabled={add.isPending || body.trim() === '' || tooLong}>
              {add.isPending ? <Spinner className="text-current" /> : null}
              {t('send')}
            </Button>
          </div>
          {tooLong && <ErrorText>{t('tooLong', { max: MAX })}</ErrorText>}
          {add.error && <ErrorText>{errorMessage(add.error)}</ErrorText>}
        </form>
      )}
      {activity.isLoading ? (
        <Spinner />
      ) : activity.error ? (
        <ErrorText>{errorMessage(activity.error)}</ErrorText>
      ) : (
        <>
          <ol className="space-y-2">
            {items.map((item) => (
              <Entry
                key={item.id}
                item={item}
                channel={item.variantId ? (nameOf.get(item.variantId) ?? null) : null}
                canWrite={canWrite}
                pinNumber={pinNumber.get(item.id) ?? null}
                onBoard={item.pin ? onBoard.has(item.pin.fileId) : false}
              />
            ))}
          </ol>
          {activity.data?.more && <p className="text-xs text-subtle-foreground">{t('more')}</p>}
        </>
      )}
    </Card>
  );
}

// The comments of a post not resolved yet (#1168), on its row in the lists, its board card and the review inbox.
export function OpenComments({ count }: { count: number }) {
  const t = useTranslations('social');
  if (count <= 0) return null;
  return (
    <Badge variant="warning" data-testid="open-comments">
      {t('openComments', { count })}
    </Badge>
  );
}
