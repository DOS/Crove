// Client report links on the Metrics tab (#643): owners and admins make a link to a report of a period, on every
// channel or the ones they pick, shown once to copy and send; the list says which are live, and revokes them.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
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
import { lastMonth, reportPeriod, reportUrl } from '../lib/social-report.ts';
import { providerName } from '../lib/social.ts';

const DAYS = [7, 30, 90] as const;

export function ReportLinks({ channels }: { channels: readonly { id: string; displayName: string; provider: string }[] }) {
  const t = useTranslations('social.reportLinks');
  const f = useFormat();
  const { slug } = useParams({ strict: false }) as { slug: string };
  const me = useQuery(orpc.me.get.queryOptions());
  const role = me.data?.orgs.find((o) => o.slug === slug)?.role;
  const canMake = role === 'owner' || role === 'admin';
  const list = useQuery({ ...orpc.social.reportLinks.list.queryOptions({ input: {} }), enabled: canMake });
  const [period, setPeriod] = useState(() => lastMonth(new Date()));
  const [title, setTitle] = useState('');
  const [days, setDays] = useState<number>(30);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [made, setMade] = useState<{ url: string; expiresAt: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: orpc.social.reportLinks.list.key() });
  const range = reportPeriod(period.from, period.to);
  const create = useMutation({
    mutationFn: () => {
      if (!range) throw new Error(t('periodInvalid'));
      return client.social.reportLinks.create({ ...range, days, ...(picked.size > 0 ? { connectionIds: [...picked] } : {}), ...(title.trim() ? { title: title.trim() } : {}) });
    },
    onSuccess: (r) => {
      setMade({ url: reportUrl(window.location.origin, r.token), expiresAt: r.expiresAt });
      setCopied(false);
      refresh();
    },
  });
  const revoke = useMutation({ mutationFn: (linkId: string) => client.social.reportLinks.revoke({ linkId }), onSuccess: refresh });
  const copy = async () => {
    if (!made) return;
    try {
      await navigator.clipboard.writeText(made.url);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  if (!canMake) return null;
  const now = Date.now();
  const links = list.data ?? [];
  const names = new Map(channels.map((c) => [c.id, c.displayName]));
  const toggle = (id: string) => {
    const next = new Set(picked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setPicked(next);
  };
  return (
    <Card className="block space-y-3 p-4">
      <div>
        <h3 className="text-sm font-medium text-foreground">{t('title')}</h3>
        <p className="text-xs text-subtle-foreground">{t('hint')}</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="report-from">{t('from')}</Label>
          <Input id="report-from" type="date" value={period.from} onChange={(e) => setPeriod({ ...period, from: e.target.value })} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="report-to">{t('to')}</Label>
          <Input id="report-to" type="date" value={period.to} onChange={(e) => setPeriod({ ...period, to: e.target.value })} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="report-title">{t('name')}</Label>
          <Input id="report-title" value={title} maxLength={120} placeholder={t('namePlaceholder')} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="report-days">{t('validFor')}</Label>
          <NativeSelect id="report-days" value={String(days)} onChange={(e) => setDays(Number(e.target.value))}>
            {DAYS.map((d) => (
              <NativeSelectOption key={d} value={String(d)}>
                {t('days', { count: d })}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
      </div>
      {channels.length > 1 && (
        <fieldset className="space-y-1.5">
          <legend className="text-sm font-medium text-foreground">{t('channels')}</legend>
          <p className="text-xs text-subtle-foreground">{t('channelsHint')}</p>
          <div className="grid gap-1.5 sm:grid-cols-2">
            {channels.map((c) => (
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
      {list.error && <ErrorText>{errorMessage(list.error)}</ErrorText>}
      {links.length > 0 && (
        <ul className="divide-y rounded-lg border text-sm">
          {links.map((l) => {
            const live = !l.revokedAt && Date.parse(l.expiresAt) > now;
            const last = new Date(Date.parse(l.periodEnd) - 1).toISOString();
            return (
              <li key={l.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-foreground">{l.title ?? t('untitled')}</span>
                  <span className="block text-xs text-subtle-foreground">
                    {t('period', { from: f.date(l.periodStart), to: f.date(last) })} ·{' '}
                    {l.connectionIds.length === 0 ? t('allChannels') : l.connectionIds.map((id) => names.get(id) ?? t('goneChannel')).join(', ')}
                  </span>
                </span>
                {live ? <Badge variant="secondary">{t('liveUntil', { until: f.date(l.expiresAt) })}</Badge> : <Badge variant="outline">{l.revokedAt ? t('revoked') : t('expired')}</Badge>}
                {live && (
                  <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" disabled={revoke.isPending} onClick={() => revoke.mutate(l.id)}>
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
