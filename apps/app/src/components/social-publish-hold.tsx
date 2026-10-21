// A hold on all of the org's publishing (#946): the banner every Social page shows while it is on, with "Tiếp tục đăng"
// for owners and admins, and the card on the Channels page ("Tạm dừng mọi bài đăng") where they put it on with a
// reason. The banner reads the hold again every minute, and when a notification arrives (a hold's start and end come
// with one).
import { useMutation, useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { Alert } from '@crove/ui/components/alert';
import { Button } from '@crove/ui/components/button';
import { Label } from '@crove/ui/components/label';
import { Textarea } from '@crove/ui/components/textarea';
import { ErrorText, Notice } from './ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';

const REASON_MAX = 500;
const POLL_MS = 60_000;

function usePublishHold() {
  return useQuery({ ...orpc.social.publishing.get.queryOptions({ input: {} }), refetchInterval: POLL_MS });
}

function useIsAdmin(): boolean {
  const { slug } = useParams({ strict: false }) as { slug: string };
  const me = useQuery(orpc.me.get.queryOptions());
  const role = me.data?.orgs.find((o) => o.slug === slug)?.role;
  return role === 'owner' || role === 'admin';
}

// Everything a hold changes: the hold itself, and the posts a release moved.
const refresh = () => {
  void queryClient.invalidateQueries({ queryKey: orpc.social.publishing.get.key() });
  void queryClient.invalidateQueries({ queryKey: orpc.social.posts.key() });
};

function useRelease() {
  return useMutation({ mutationFn: () => client.social.publishing.release({}), onSettled: refresh });
}

function ReleasedNotice({ heldTooLong }: { heldTooLong: number }) {
  const t = useTranslations('social.publishHold');
  return <Notice>{heldTooLong > 0 ? t('releasedStale', { count: heldTooLong }) : t('released')}</Notice>;
}

export function PublishHoldBanner() {
  const t = useTranslations('social.publishHold');
  const f = useFormat();
  const isAdmin = useIsAdmin();
  const current = usePublishHold();
  const release = useRelease();
  const hold = current.data?.hold;
  if (!hold)
    return release.data?.released ? (
      <div className="mb-4">
        <ReleasedNotice heldTooLong={release.data.heldTooLong} />
      </div>
    ) : null;
  return (
    <Alert role="status" className="mb-4 flex flex-wrap items-center justify-between gap-2 border-warning/40 bg-warning/10 text-foreground">
      <p className="min-w-0 [overflow-wrap:anywhere]">{t('banner', { reason: hold.reason, name: hold.heldByName ?? t('someone'), when: f.dateTime(hold.heldAt) })}</p>
      {isAdmin && (
        <Button size="sm" disabled={release.isPending} onClick={() => release.mutate()}>
          {t('resume')}
        </Button>
      )}
      {release.error && <ErrorText>{errorMessage(release.error)}</ErrorText>}
    </Alert>
  );
}

export function PublishHoldCard() {
  const t = useTranslations('social.publishHold');
  const isAdmin = useIsAdmin();
  const current = usePublishHold();
  const release = useRelease();
  const [reason, setReason] = useState('');
  const hold = useMutation({
    mutationFn: (text: string) => client.social.publishing.hold({ reason: text }),
    onSuccess: () => setReason(''),
    onSettled: refresh,
  });
  const held = current.data?.held === true;
  const text = reason.trim();
  return (
    <div className="space-y-2">
      <div>
        <p className="text-sm font-medium text-foreground">{t('title')}</p>
        <p className="text-xs text-subtle-foreground">{t('hint')}</p>
      </div>
      {!isAdmin ? (
        <p className="text-xs text-subtle-foreground">{t('adminsOnly')}</p>
      ) : held ? (
        <Button size="sm" disabled={release.isPending} onClick={() => release.mutate()}>
          {t('resume')}
        </Button>
      ) : (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (text) hold.mutate(text);
          }}
        >
          <Label htmlFor="publish-hold-reason">{t('reason')}</Label>
          <Textarea id="publish-hold-reason" value={reason} maxLength={REASON_MAX} placeholder={t('reasonPlaceholder')} onChange={(e) => setReason(e.target.value)} />
          <Button type="submit" size="sm" variant="destructive" disabled={!text || hold.isPending || current.isLoading}>
            {t('hold')}
          </Button>
        </form>
      )}
      {(hold.error ?? release.error) && <ErrorText>{errorMessage(hold.error ?? release.error)}</ErrorText>}
    </div>
  );
}
