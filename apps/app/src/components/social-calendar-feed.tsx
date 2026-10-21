// Subscribing to the posting calendar from Google Calendar or Outlook (#862), on the Calendar tab. Owners and admins
// make the feed's address (shown once, to copy), make a new one to cut off the old, or revoke it; everyone else sees
// whether there is one.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Input } from '@crove/ui/components/input';
import { ErrorText } from './ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';

const calendarFeedUrl = (origin: string, token: string) => `${origin}/cal/${token}.ics`;

export function CalendarFeedCard({ canManage }: { canManage: boolean }) {
  const t = useTranslations('social.calendarFeed');
  const f = useFormat();
  const feed = useQuery(orpc.social.calendarFeed.get.queryOptions({ input: {} }));
  const [made, setMade] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: orpc.social.calendarFeed.get.key() });
  const create = useMutation({
    mutationFn: () => client.social.calendarFeed.create({}),
    onSuccess: (r) => {
      setMade(calendarFeedUrl(window.location.origin, r.token));
      setCopied(false);
      refresh();
    },
  });
  const revoke = useMutation({
    mutationFn: () => client.social.calendarFeed.revoke({}),
    onSuccess: () => {
      setMade(null);
      refresh();
    },
  });
  const copy = async () => {
    if (!made) return;
    try {
      await navigator.clipboard.writeText(made);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  const live = feed.data ?? null;
  const busy = create.isPending || revoke.isPending;
  return (
    <Card className="block space-y-3 p-4">
      <div>
        <h3 className="text-sm font-medium text-foreground">{t('title')}</h3>
        <p className="text-xs text-subtle-foreground">{t('hint')}</p>
      </div>
      {feed.error ? (
        <ErrorText>{errorMessage(feed.error)}</ErrorText>
      ) : (
        feed.isSuccess && <p className="text-sm text-muted-foreground">{live ? t('live', { at: f.dateTime(live.createdAt) }) : t('none')}</p>
      )}
      {canManage && feed.isSuccess && (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={busy} onClick={() => (!live || window.confirm(t('recreateConfirm'))) && create.mutate()}>
            {live ? t('recreate') : t('create')}
          </Button>
          {live && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => window.confirm(t('revokeConfirm')) && revoke.mutate()}>
              {t('revoke')}
            </Button>
          )}
        </div>
      )}
      {!canManage && !live && feed.isSuccess && <p className="text-xs text-subtle-foreground">{t('askAdmin')}</p>}
      {create.error && <ErrorText>{errorMessage(create.error)}</ErrorText>}
      {revoke.error && <ErrorText>{errorMessage(revoke.error)}</ErrorText>}
      {made && (
        <div className="space-y-1.5 rounded-lg border border-primary/40 p-3">
          <p className="text-xs text-muted-foreground">{t('madeHint')}</p>
          <div className="flex gap-2">
            <Input readOnly value={made} aria-label={t('link')} onFocus={(e) => e.target.select()} />
            <Button size="sm" variant="outline" onClick={() => void copy()}>
              {copied ? t('copied') : t('copy')}
            </Button>
          </div>
          <p className="text-xs text-subtle-foreground">{t('once')}</p>
        </div>
      )}
    </Card>
  );
}
