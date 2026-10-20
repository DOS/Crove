// A post's internal comments and timeline (#582): members write a comment on the post or on one channel, the author
// may fix it for 15 minutes, and everyone sees what happened to the post, newest first. Comments are never published.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { mentionsForEditing, mentionsForStoring } from '@crove/mod-social/contract';
import { cn } from '@crove/ui/lib/utils';
import { CommentBody, MentionBox, useMemberNames, type Picked } from './social-mentions.tsx';
import { ErrorText, Spinner } from './ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';

type Item = Awaited<ReturnType<typeof client.social.posts.activity>>['items'][number];
const MAX = 4000;

function Entry({ item, channel, canWrite }: { item: Item; channel: string | null; canWrite: boolean }) {
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
  const who = item.name ?? t(item.userId ? 'formerMember' : 'system');
  const what =
    item.kind === 'decision' ? t(`decision.${item.decision === 'approved' ? 'approved' : item.decision === 'rejected' ? 'rejected' : 'changes_requested'}`) : item.kind === 'created' && item.code === 'ai' ? t('createdAi') : t(`kind.${item.kind}`);
  return (
    <li className={cn('space-y-1 border-l-2 py-1 pl-3 text-sm', item.kind === 'comment' ? 'border-primary' : 'border-border')}>
      <p className="text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{item.kind === 'published' || item.kind === 'failed' || item.kind === 'cancelled' || item.kind === 'auto_replied' || item.kind === 'auto_reply_failed' || item.kind === 'reposted' || item.kind === 'repost_failed' ? (channel ?? t('channel')) : who}</span>{' '}
        {what}
        {channel && !['published', 'failed', 'cancelled', 'auto_replied', 'auto_reply_failed', 'reposted', 'repost_failed'].includes(item.kind) ? ` · ${channel}` : ''} · <time dateTime={item.at}>{f.dateTime(item.at)}</time>
        {item.editedAt ? ` · ${t('edited')}` : ''}
      </p>
      {(item.kind === 'failed' || item.kind === 'auto_reply_failed' || item.kind === 'repost_failed') && item.code && <p className="font-mono text-xs text-warning">{item.code}</p>}
      {item.kind === 'published' && item.url && /^https?:\/\//.test(item.url) && (
        <a href={item.url} target="_blank" rel="noopener noreferrer" className="text-xs text-link hover:underline">
          {t('open')}
        </a>
      )}
      {editing !== null ? (
        <div className="space-y-2">
          <MentionBox value={editing} onChange={setEditing} picked={picked} onPicked={setPicked} maxLength={MAX} rows={3} label={t('editLabel')} />
          {edit.error && <ErrorText>{errorMessage(edit.error)}</ErrorText>}
          <div className="flex gap-2">
            <Button size="sm" disabled={edit.isPending || editing.trim() === ''} onClick={() => edit.mutate(editing.trim())}>
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
      {item.kind === 'comment' && item.editable && canWrite && editing === null && (
        <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => {
            const shown = mentionsForEditing(item.body ?? '', labelOf);
            setPicked(shown.picked);
            setEditing(shown.text);
          }}
        >
          {t('edit')}
        </Button>
      )}
    </li>
  );
}

export function PostActivity({ postId, channels, canWrite, className }: { postId: string; channels: { variantId: string; name: string }[]; canWrite: boolean; className?: string }) {
  const t = useTranslations('social.activity');
  const activity = useQuery(orpc.social.posts.activity.queryOptions({ input: { postId } }));
  const [body, setBody] = useState('');
  const [variantId, setVariantId] = useState('');
  const [picked, setPicked] = useState<Picked>([]);
  const add = useMutation({
    mutationFn: () => client.social.posts.comment({ postId, body: mentionsForStoring(body.trim(), picked), ...(variantId ? { variantId } : {}) }),
    onSuccess: () => {
      setBody('');
      setPicked([]);
      void queryClient.invalidateQueries({ queryKey: orpc.social.posts.activity.key() });
    },
  });
  const nameOf = new Map(channels.map((c) => [c.variantId, c.name]));
  return (
    <Card className={cn('block space-y-3 p-4', className)}>
      <div>
        <h3 className="text-sm font-medium text-foreground">{t('title')}</h3>
        <p className="text-xs text-subtle-foreground">{t('hint')}</p>
      </div>
      {canWrite && (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (body.trim() !== '' && !add.isPending) add.mutate();
          }}
        >
          <MentionBox value={body} onChange={setBody} picked={picked} onPicked={setPicked} maxLength={MAX} rows={3} placeholder={t('placeholder')} label={t('placeholder')} />
          <div className="flex flex-wrap items-center gap-2">
            {channels.length > 1 && (
              <NativeSelect value={variantId} onChange={(e) => setVariantId(e.target.value)} aria-label={t('about')} className="w-auto">
                <NativeSelectOption value="">{t('wholePost')}</NativeSelectOption>
                {channels.map((c) => (
                  <NativeSelectOption key={c.variantId} value={c.variantId}>
                    {c.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            )}
            <Button type="submit" size="sm" disabled={add.isPending || body.trim() === ''}>
              {add.isPending ? <Spinner className="text-current" /> : null}
              {t('send')}
            </Button>
          </div>
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
            {(activity.data?.items ?? []).map((item) => (
              <Entry key={item.id} item={item} channel={item.variantId ? (nameOf.get(item.variantId) ?? null) : null} canWrite={canWrite} />
            ))}
          </ol>
          {activity.data?.more && <p className="text-xs text-subtle-foreground">{t('more')}</p>}
        </>
      )}
    </Card>
  );
}
