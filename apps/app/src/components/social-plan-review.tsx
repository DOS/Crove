// One client review link for a content plan (#902). On the Calendar tab, owners and admins send the client the posts
// going out in a date range on the channels they pick; in the posts lists, the posts they selected. The link is shown
// once, to copy and send; the card lists the plan links with their posts and how many the client answered, and
// revokes them. Each answer settles its post through the client's review step, as a single-post link's does.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Checkbox } from '@crove/ui/components/checkbox';
import { Input } from '@crove/ui/components/input';
import { Label } from '@crove/ui/components/label';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { ErrorText } from './ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';
import { reportPeriod } from '../lib/social-report.ts';
import { nextMonth, PLAN_POSTS_MAX, reviewUrl } from '../lib/social-plan-review.ts';
import { providerName } from '../lib/social.ts';

const DAYS = [3, 7, 14, 30] as const;

const refresh = () => {
  void queryClient.invalidateQueries({ queryKey: orpc.social.reviewLinks.plans.key() });
  void queryClient.invalidateQueries({ queryKey: orpc.social.reviewLinks.list.key() });
};

// The link just made, shown once.
function MadeLink({ made }: { made: { url: string; expiresAt: string; posts: number } }) {
  const t = useTranslations('social.planReview');
  const f = useFormat();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(made.url);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="space-y-1.5 rounded-lg border border-primary/40 p-3">
      <p className="text-xs text-muted-foreground">{t('madeHint', { count: made.posts, until: f.dateTime(made.expiresAt) })}</p>
      <div className="flex gap-2">
        <Input readOnly value={made.url} aria-label={t('link')} onFocus={(e) => e.target.select()} />
        <Button size="sm" variant="outline" onClick={() => void copy()}>
          {copied ? t('copied') : t('copy')}
        </Button>
      </div>
    </div>
  );
}

// The Calendar tab's card: a plan from a date range on chosen channels, and the org's plan links.
export function PlanReviewCard({ channels, canManage }: { channels: readonly { id: string; displayName: string; provider: string; status?: string }[]; canManage: boolean }) {
  const t = useTranslations('social.planReview');
  const f = useFormat();
  const list = useQuery({ ...orpc.social.reviewLinks.plans.queryOptions({ input: {} }), enabled: canManage });
  const [period, setPeriod] = useState(() => nextMonth(new Date()));
  const [days, setDays] = useState<number>(7);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [made, setMade] = useState<{ url: string; expiresAt: string; posts: number } | null>(null);
  const range = reportPeriod(period.from, period.to);
  const create = useMutation({
    mutationFn: () => {
      if (!range) throw new Error(t('periodInvalid'));
      return client.social.reviewLinks.createPlan({ range: { from: range.periodStart, to: range.periodEnd, ...(picked.size > 0 ? { connectionIds: [...picked] } : {}) }, days });
    },
    onSuccess: (r) => {
      setMade({ url: reviewUrl(window.location.origin, r.token), expiresAt: r.expiresAt, posts: r.posts });
      refresh();
    },
  });
  const revoke = useMutation({ mutationFn: (linkId: string) => client.social.reviewLinks.revoke({ linkId }), onSuccess: refresh });
  if (!canManage) return null;
  const live = channels.filter((c) => c.status !== 'revoked');
  const toggle = (id: string) => {
    const next = new Set(picked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setPicked(next);
  };
  const now = Date.now();
  const links = list.data ?? [];
  return (
    <Card className="block space-y-3 p-4">
      <div>
        <h3 className="text-sm font-medium text-foreground">{t('title')}</h3>
        <p className="text-xs text-subtle-foreground">{t('hint')}</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1.5">
          <Label htmlFor="plan-from">{t('from')}</Label>
          <Input id="plan-from" type="date" value={period.from} onChange={(e) => setPeriod({ ...period, from: e.target.value })} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="plan-to">{t('to')}</Label>
          <Input id="plan-to" type="date" value={period.to} onChange={(e) => setPeriod({ ...period, to: e.target.value })} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="plan-days">{t('validFor')}</Label>
          <NativeSelect id="plan-days" value={String(days)} onChange={(e) => setDays(Number(e.target.value))}>
            {DAYS.map((d) => (
              <NativeSelectOption key={d} value={String(d)}>
                {t('days', { count: d })}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
      </div>
      {live.length > 1 && (
        <fieldset className="space-y-1.5">
          <legend className="text-sm font-medium text-foreground">{t('channels')}</legend>
          <p className="text-xs text-subtle-foreground">{t('channelsHint')}</p>
          <div className="grid gap-1.5 sm:grid-cols-2">
            {live.map((c) => (
              <label key={c.id} className="flex items-center gap-2 text-sm text-muted-foreground">
                <Checkbox checked={picked.has(c.id)} onCheckedChange={() => toggle(c.id)} />
                {c.displayName} · {providerName(c.provider)}
              </label>
            ))}
          </div>
        </fieldset>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={!range || create.isPending} onClick={() => create.mutate()}>
          {t('create')}
        </Button>
        {!range && <span className="text-xs text-warning">{t('periodInvalid')}</span>}
      </div>
      {create.error && <ErrorText>{errorMessage(create.error)}</ErrorText>}
      {made && <MadeLink made={made} />}
      {list.error && <ErrorText>{errorMessage(list.error)}</ErrorText>}
      {links.length > 0 && (
        <ul className="divide-y rounded-lg border text-sm">
          {links.map((l) => {
            const isLive = !l.revokedAt && Date.parse(l.expiresAt) > now;
            return (
              <li key={l.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-foreground">
                    {l.from && l.to ? t('period', { from: f.date(l.from), to: f.date(new Date(Date.parse(l.to) - 1).toISOString()) }) : t('picked', { count: l.posts })}
                  </span>
                  <span className="block text-xs text-subtle-foreground">
                    {t('answered', { answered: l.answered, posts: l.posts - l.gone })}
                    {l.gone > 0 ? ` · ${t('gone', { count: l.gone })}` : ''}
                  </span>
                </span>
                {isLive ? <Badge variant="secondary">{t('liveUntil', { until: f.date(l.expiresAt) })}</Badge> : <Badge variant="outline">{l.revokedAt ? t('revoked') : t('expired')}</Badge>}
                {isLive && (
                  <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" disabled={revoke.isPending && revoke.variables === l.id} onClick={() => revoke.mutate(l.id)}>
                    {t('revoke')}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {revoke.error && <ErrorText>{errorMessage(revoke.error)}</ErrorText>}
    </Card>
  );
}

// Under a posts list's selection: one plan link for the posts selected.
export function PlanFromPosts({ postIds }: { postIds: readonly string[] }) {
  const t = useTranslations('social.planReview');
  const [made, setMade] = useState<{ url: string; expiresAt: string; posts: number } | null>(null);
  const create = useMutation({
    mutationFn: () => client.social.reviewLinks.createPlan({ postIds: [...postIds] }),
    onSuccess: (r) => {
      setMade({ url: reviewUrl(window.location.origin, r.token), expiresAt: r.expiresAt, posts: r.posts });
      refresh();
    },
  });
  if (postIds.length === 0 && !made) return null;
  const tooMany = postIds.length > PLAN_POSTS_MAX;
  return (
    <div className="mt-2 space-y-2">
      {postIds.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" disabled={tooMany || create.isPending} onClick={() => create.mutate()}>
            {t('fromSelected', { count: postIds.length })}
          </Button>
          {tooMany && <span className="text-xs text-warning">{t('tooMany', { max: PLAN_POSTS_MAX })}</span>}
        </div>
      )}
      {create.error && <ErrorText>{errorMessage(create.error)}</ErrorText>}
      {made && <MadeLink made={made} />}
    </div>
  );
}
