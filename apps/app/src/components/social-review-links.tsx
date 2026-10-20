// Client review links on the post screen (#589): owners and admins make one (shown once, to copy and send, often over
// Zalo), revoke it, and everyone sees what clients answered. A client's answer is a signal for the team, never one of
// the approvals a channel needs.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Input } from '@crove/ui/components/input';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { ErrorText } from './ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';

const DAYS = [3, 7, 14, 30] as const;

export function ReviewLinks({ postId, canDecide }: { postId: string; canDecide: boolean }) {
  const t = useTranslations('social.reviewLinks');
  const f = useFormat();
  const list = useQuery(orpc.social.reviewLinks.list.queryOptions({ input: { postId } }));
  const [days, setDays] = useState<number>(7);
  const [made, setMade] = useState<{ url: string; expiresAt: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: orpc.social.reviewLinks.list.key() });
  const create = useMutation({
    mutationFn: () => client.social.reviewLinks.create({ postId, days }),
    onSuccess: (r) => {
      setMade({ url: `${window.location.origin}/-/review#${r.token}`, expiresAt: r.expiresAt });
      setCopied(false);
      refresh();
    },
  });
  const revoke = useMutation({ mutationFn: (linkId: string) => client.social.reviewLinks.revoke({ linkId }), onSuccess: refresh });
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
  if (!canDecide && links.length === 0 && feedback.length === 0) return null;
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
              {l.changed && <Badge variant="outline">{t('changedSince')}</Badge>}
              {canDecide && (
                <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" disabled={revoke.isPending} onClick={() => revoke.mutate(l.id)}>
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
            <li key={fb.id} className="space-y-1 border-l-2 border-border py-1 pl-3 text-sm">
              <p className="text-xs text-muted-foreground">
                <span className="font-medium text-foreground">{fb.name}</span> · <Badge variant={fb.verdict === 'approved' ? 'secondary' : 'outline'}>{t(`verdict.${fb.verdict}`)}</Badge> ·{' '}
                {f.dateTime(fb.createdAt)}
                {fb.changed ? ` · ${t('answeredChanged')}` : ''}
              </p>
              {fb.body && <p className="whitespace-pre-wrap break-words text-foreground">{fb.body}</p>}
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
