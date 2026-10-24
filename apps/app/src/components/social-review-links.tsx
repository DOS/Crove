// Client review links on the post screen (#589): owners and admins make one (shown once, to copy and send, often over
// Zalo), revoke it, and everyone sees what clients answered. A client's answer is a signal for the team, never one of
// the approvals a channel needs. The plan links the post is in (#902) are listed too. Members and above answer each
// client answer with one team reply (#1301), which the client sees under it signed with the org's name.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Input } from '@crove/ui/components/input';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { Textarea } from '@crove/ui/components/textarea';
import { useMemberNames } from './social-mentions.tsx';
import { ErrorText } from './ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';
import { reviewUrl } from '../lib/social-plan-review.ts';

const DAYS = [3, 7, 14, 30] as const;

// Where the card starts warning, as a share of what a link takes (answersMax: REVIEW_LINK_ANSWERS_MAX per link, or
// REVIEW_PLAN_ANSWERS_PER_POST for this post of a plan link, #902).
const nearlyFull = (used: number, max: number) => used >= Math.ceil(max * 0.9);

// The longest team reply (REVIEW_REPLY_MAX on the server), as long as a client's own comment.
export const REPLY_MAX = 2000;

type Feedback = {
  id: string;
  name: string;
  verdict: 'approved' | 'changes_requested' | 'comment';
  body: string | null;
  changed: boolean;
  createdAt: string;
  reply: { body: string; by: string; at: string } | null;
};

// One client answer with the team's reply under it (#1301): members and above write, edit and remove the reply; the
// client sees it on the link's page signed with the org's name, never the member's.
export function ClientAnswer({ fb, canReply, nameOf }: { fb: Feedback; canReply: boolean; nameOf: (userId: string) => string | null }) {
  const t = useTranslations('social.reviewLinks');
  const f = useFormat();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const save = useMutation({
    mutationFn: (body: string | null) => client.social.reviewLinks.reply({ feedbackId: fb.id, body }),
    onSuccess: () => {
      setEditing(false);
      void queryClient.invalidateQueries({ queryKey: orpc.social.reviewLinks.list.key() });
    },
  });
  const open = () => {
    setText(fb.reply?.body ?? '');
    setEditing(true);
  };
  return (
    <li className="space-y-1 border-l-2 border-border py-1 pl-3 text-sm">
      <p className="text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{fb.name}</span> · <Badge variant={fb.verdict === 'approved' ? 'secondary' : 'outline'}>{t(`verdict.${fb.verdict}`)}</Badge> ·{' '}
        {f.dateTime(fb.createdAt)}
        {fb.changed ? ` · ${t('answeredChanged')}` : ''}
      </p>
      {fb.body && <p className="whitespace-pre-wrap break-words text-foreground">{fb.body}</p>}
      {fb.reply && !editing && (
        <div className="ml-2 space-y-0.5 rounded-md bg-muted/50 px-2 py-1.5">
          <p className="text-xs text-muted-foreground">{t('repliedBy', { name: nameOf(fb.reply.by) ?? t('formerMember'), when: f.dateTime(fb.reply.at) })}</p>
          <p className="whitespace-pre-wrap break-words text-foreground">{fb.reply.body}</p>
          {canReply && (
            <div className="flex gap-1">
              <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={open}>
                {t('replyEdit')}
              </Button>
              <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" disabled={save.isPending} onClick={() => window.confirm(t('replyClearConfirm')) && save.mutate(null)}>
                {t('replyClear')}
              </Button>
            </div>
          )}
        </div>
      )}
      {canReply && !fb.reply && !editing && (
        <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={open}>
          {t('reply')}
        </Button>
      )}
      {canReply && editing && (
        <div className="space-y-1.5">
          <Textarea aria-label={t('replyLabel', { name: fb.name })} value={text} rows={2} maxLength={REPLY_MAX} placeholder={t('replyPlaceholder')} onChange={(e) => setText(e.target.value)} />
          <p className="text-xs text-subtle-foreground">{t('replyHint')}</p>
          <div className="flex gap-2">
            <Button size="sm" disabled={save.isPending || !text.trim()} onClick={() => save.mutate(text)}>
              {fb.reply ? t('replySave') : t('replySend')}
            </Button>
            <Button size="sm" variant="ghost" disabled={save.isPending} onClick={() => setEditing(false)}>
              {t('replyCancel')}
            </Button>
          </div>
        </div>
      )}
      {save.error && <ErrorText>{errorMessage(save.error)}</ErrorText>}
    </li>
  );
}

export function ReviewLinks({ postId, canDecide, canReply = false }: { postId: string; canDecide: boolean; canReply?: boolean }) {
  const t = useTranslations('social.reviewLinks');
  const f = useFormat();
  const list = useQuery(orpc.social.reviewLinks.list.queryOptions({ input: { postId } }));
  const { nameOf } = useMemberNames();
  const [days, setDays] = useState<number>(7);
  const [made, setMade] = useState<{ url: string; expiresAt: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: orpc.social.reviewLinks.list.key() });
  const create = useMutation({
    mutationFn: () => client.social.reviewLinks.create({ postId, days }),
    onSuccess: (r) => {
      setMade({ url: reviewUrl(window.location.origin, r.token), expiresAt: r.expiresAt });
      setCopied(false);
      refresh();
    },
  });
  const revoke = useMutation({
    mutationFn: (linkId: string) => client.social.reviewLinks.revoke({ linkId }),
    onSuccess: () => {
      refresh();
      void queryClient.invalidateQueries({ queryKey: orpc.social.reviewLinks.plans.key() });
    },
  });
  const copy = async () => {
    if (!made) return;
    try {
      await navigator.clipboard.writeText(made.url);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  const links = list.data?.links ?? [];
  const feedback = list.data?.feedback ?? [];
  const now = Date.now();
  const live = links.filter((l) => !l.revokedAt && Date.parse(l.expiresAt) > now);
  if (!canDecide && !list.error && links.length === 0 && feedback.length === 0) return null;
  return (
    <Card className="block space-y-3 p-4">
      <div>
        <h3 className="text-sm font-medium text-foreground">{t('title')}</h3>
        <p className="text-xs text-subtle-foreground">{t('hint')}</p>
      </div>
      {canDecide && (
        <div className="flex flex-wrap items-center gap-2">
          <NativeSelect value={String(days)} aria-label={t('validFor')} className="w-auto" onChange={(e) => setDays(Number(e.target.value))}>
            {DAYS.map((d) => (
              <NativeSelectOption key={d} value={String(d)}>
                {t('days', { count: d })}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <Button size="sm" disabled={create.isPending} onClick={() => create.mutate()}>
            {t('create')}
          </Button>
        </div>
      )}
      {list.error && <ErrorText>{errorMessage(list.error)}</ErrorText>}
      {create.error && <ErrorText>{errorMessage(create.error)}</ErrorText>}
      {made && (
        <div className="space-y-1.5 rounded-lg border border-primary/40 p-3">
          <p className="text-xs text-muted-foreground">{t('madeHint', { until: f.dateTime(made.expiresAt) })}</p>
          <div className="flex gap-2">
            <Input readOnly value={made.url} aria-label={t('link')} onFocus={(e) => e.target.select()} />
            <Button size="sm" variant="outline" onClick={() => void copy()}>
              {copied ? t('copied') : t('copy')}
            </Button>
          </div>
        </div>
      )}
      {live.length > 0 && (
        <ul className="space-y-1 text-xs text-muted-foreground">
          {live.map((l) => (
            <li key={l.id} className="flex flex-wrap items-center gap-2">
              <span>{t('liveUntil', { until: f.dateTime(l.expiresAt) })}</span>
              {l.kind === 'plan' && <Badge variant="secondary">{t('inPlan', { count: l.posts })}</Badge>}
              {l.changed && <Badge variant="outline">{t('changedSince')}</Badge>}
              {/* A link takes 100 answers (#626), a plan link 20 per post: near the end, the team sends a new one before the client hits the wall. */}
              {l.answers >= l.answersMax ? (
                <Badge variant="outline" className="border-destructive/50 text-destructive">
                  {t('full', { max: l.answersMax })}
                </Badge>
              ) : nearlyFull(l.answers, l.answersMax) ? (
                <Badge variant="outline" className="border-warning/50 text-warning">
                  {t('nearlyFull', { used: l.answers, max: l.answersMax })}
                </Badge>
              ) : l.answers > 0 ? (
                <span>{t('answers', { used: l.answers, max: l.answersMax })}</span>
              ) : null}
              {canDecide && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs"
                  disabled={revoke.isPending}
                  onClick={() => (l.kind !== 'plan' || window.confirm(t('revokePlanConfirm', { count: l.posts }))) && revoke.mutate(l.id)}
                >
                  {t('revoke')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {revoke.error && <ErrorText>{errorMessage(revoke.error)}</ErrorText>}
      {feedback.length > 0 && (
        <ol className="space-y-2">
          {feedback.map((fb) => (
            <ClientAnswer key={fb.id} fb={fb} canReply={canReply} nameOf={nameOf} />
          ))}
        </ol>
      )}
    </Card>
  );
}
