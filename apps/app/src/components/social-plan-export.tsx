// Export the content plan (#978), from the Calendar tab: the channel posts of a date range (the visible month to start
// with) on the channels and labels picked, as a CSV file the server builds and audits, or as a print layout opened in
// a new tab for PDF. Members and above; the server checks it again.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Checkbox } from '@crove/ui/components/checkbox';
import { Input } from '@crove/ui/components/input';
import { Label } from '@crove/ui/components/label';
import { ErrorText } from './ui.tsx';
import { brandFileName } from '../i18n/brand.ts';
import { client, errorMessage, orpc } from '../lib/api.ts';
import { monthOf, PLAN_EXPORT_MAX_DAYS, PLAN_EXPORT_MAX_ROWS, planPrintPath, planRange, saveCsv } from '../lib/social-plan-export.ts';
import { providerName } from '../lib/social.ts';
import { useChannelScope } from './social-channel-access.tsx';

const toggled = (set: ReadonlySet<string>, id: string) => {
  const next = new Set(set);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
};

export function PlanExportPanel({ slug, month, onClose }: { slug: string; month: Date; onClose: () => void }) {
  const t = useTranslations('social.planExport');
  const channels = useQuery(orpc.channels.list.queryOptions({ input: {} }));
  const labels = useQuery(orpc.social.labels.list.queryOptions({ input: {} }));
  const [period, setPeriod] = useState(() => monthOf(month));
  const [pickedChannels, setPickedChannels] = useState<ReadonlySet<string>>(new Set());
  const [pickedLabels, setPickedLabels] = useState<ReadonlySet<string>>(new Set());
  const range = planRange(period.from, period.to);
  const filter = { ...(pickedChannels.size > 0 ? { connectionIds: [...pickedChannels] } : {}), ...(pickedLabels.size > 0 ? { labelIds: [...pickedLabels] } : {}) };
  const download = useMutation({
    mutationFn: () => {
      if (!range) throw new Error(t('rangeInvalid', { max: PLAN_EXPORT_MAX_DAYS }));
      return client.social.plan.export({ ...range, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, ...filter, format: 'csv' });
    },
    onSuccess: (file) => {
      if (file.csv !== null) saveCsv(brandFileName(file.filename), file.csv);
    },
  });
  const print = () => {
    if (!range) return;
    window.open(planPrintPath(slug, { ...period, channels: [...pickedChannels], labels: [...pickedLabels] }), '_blank', 'noopener');
  };
  // A member limited to some channels (#1081) exports those only.
  const scope = useChannelScope();
  const live = (channels.data ?? []).filter((c) => c.status !== 'revoked' && scope.allows(c.id));
  const labelList = labels.data ?? [];
  return (
    <Card className="block space-y-3 p-4" role="dialog" aria-label={t('title')}>
      <div>
        <h3 className="text-sm font-medium text-foreground">{t('title')}</h3>
        <p className="text-xs text-subtle-foreground">{t('hint')}</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="plan-export-from">{t('from')}</Label>
          <Input id="plan-export-from" type="date" value={period.from} onChange={(e) => setPeriod({ ...period, from: e.target.value })} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="plan-export-to">{t('to')}</Label>
          <Input id="plan-export-to" type="date" value={period.to} onChange={(e) => setPeriod({ ...period, to: e.target.value })} />
        </div>
      </div>
      {live.length > 1 && (
        <fieldset className="space-y-1.5">
          <legend className="text-sm font-medium text-foreground">{t('channels')}</legend>
          <p className="text-xs text-subtle-foreground">{t('channelsHint')}</p>
          <div className="grid gap-1.5 sm:grid-cols-2">
            {live.map((c) => (
              <label key={c.id} className="flex items-center gap-2 text-sm text-muted-foreground">
                <Checkbox checked={pickedChannels.has(c.id)} onCheckedChange={() => setPickedChannels(toggled(pickedChannels, c.id))} />
                {c.displayName} · {providerName(c.provider)}
              </label>
            ))}
          </div>
        </fieldset>
      )}
      {labelList.length > 0 && (
        <fieldset className="space-y-1.5">
          <legend className="text-sm font-medium text-foreground">{t('labels')}</legend>
          <p className="text-xs text-subtle-foreground">{t('labelsHint')}</p>
          <div className="grid gap-1.5 sm:grid-cols-2">
            {labelList.map((l) => (
              <label key={l.id} className="flex items-center gap-2 text-sm text-muted-foreground">
                <Checkbox checked={pickedLabels.has(l.id)} onCheckedChange={() => setPickedLabels(toggled(pickedLabels, l.id))} />
                {l.name}
              </label>
            ))}
          </div>
        </fieldset>
      )}
      {!range && <p className="text-xs text-warning">{t('rangeInvalid', { max: PLAN_EXPORT_MAX_DAYS })}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={!range || download.isPending} onClick={() => download.mutate()}>
          {t('download')}
        </Button>
        <Button size="sm" variant="outline" disabled={!range} onClick={print}>
          {t('print')}
        </Button>
        <Button size="sm" variant="ghost" className="ml-auto" onClick={onClose}>
          {t('close')}
        </Button>
      </div>
      {download.data?.truncated && <p className="text-xs text-warning">{t('truncated', { max: PLAN_EXPORT_MAX_ROWS })}</p>}
      {download.error && <ErrorText>{errorMessage(download.error)}</ErrorText>}
      {(channels.error || labels.error) && <ErrorText>{errorMessage(channels.error ?? labels.error)}</ErrorText>}
    </Card>
  );
}
