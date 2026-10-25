// What each Google Business Profile location brought (#1477): its calls, direction requests, website clicks and profile
// views, on the Metrics tab (over the window) and in the client report (over the period, against the one before), with
// the latest day Google has given figures for, since they come a few days late. Only Google Business channels have
// them; nothing shows when none has figures.
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'use-intl';
import { Card } from '@crove/ui/components/card';
import { useFormat } from '../i18n/provider.tsx';
import { orpc } from '../lib/api.ts';
import { PERFORMANCE_FIGURES, reportPerformance, sumDays, type PerformanceTotals } from '../lib/social-performance.ts';
import { providerName } from '../lib/social.ts';
import { ChangeChip } from './social-growth.tsx';

// One channel's four figures, with the change against the period before when there is one.
function PerformanceCard({
  channel,
  provider,
  lastDay,
  totals,
  previous,
  against,
}: {
  channel: string;
  provider: string;
  lastDay: string | null;
  totals: PerformanceTotals;
  previous?: PerformanceTotals | null;
  against?: string;
}) {
  const t = useTranslations('social.performance');
  const f = useFormat();
  return (
    <Card className="block space-y-3 p-4 print:break-inside-avoid">
      <div>
        <h3 className="truncate text-sm font-medium text-foreground">
          {channel} <span className="text-xs font-normal text-subtle-foreground">· {providerName(provider)}</span>
        </h3>
        {lastDay && <p className="text-xs text-subtle-foreground">{t('through', { date: f.date(lastDay) })}</p>}
      </div>
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4 print:grid-cols-4">
        {PERFORMANCE_FIGURES.map((m) => (
          <div key={m}>
            <dt className="text-xs text-subtle-foreground">{t(m)}</dt>
            <dd className="mt-1 text-xl font-semibold text-foreground tabular-nums">{f.number(totals[m])}</dd>
            {previous && against && <ChangeChip current={totals[m]} previous={previous[m]} against={against} withPrevious className="mt-1" />}
          </div>
        ))}
      </dl>
    </Card>
  );
}

// The Metrics tab's section: every Google Business channel with figures in the window, from the same trends the growth
// card reads.
export function ProfilePerformance({ days, names }: { days: number; names: Map<string, string> }) {
  const t = useTranslations('social.performance');
  const trends = useQuery(orpc.social.accounts.trends.queryOptions({ input: { days } }));
  const list = (trends.data ?? []).flatMap((trend) => {
    const sum = sumDays(trend.performance ?? []);
    return sum ? [{ connectionId: trend.connectionId, provider: trend.provider, ...sum }] : [];
  });
  if (list.length === 0) return null;
  return (
    <section className="space-y-2">
      <div>
        <h3 className="text-sm font-medium text-foreground">{t('title')}</h3>
        <p className="text-xs text-subtle-foreground">{t('hint')}</p>
      </div>
      <div className="space-y-3">
        {list.map((p) => (
          <PerformanceCard key={p.connectionId} channel={names.get(p.connectionId) ?? providerName(p.provider)} provider={p.provider} lastDay={p.lastDay} totals={p.totals} />
        ))}
      </div>
    </section>
  );
}

// The client report's section, after the channels: each Google Business channel's figures in the period, against the
// period before when the report compares and that period has figures.
export function ReportPerformance({ entries, against }: { entries: unknown; against: string }) {
  const t = useTranslations('social.performance');
  const list = reportPerformance(entries);
  if (list.length === 0) return null;
  return (
    <section className="space-y-2">
      <div>
        <h2 className="text-base font-semibold">{t('title')}</h2>
        <p className="text-xs text-subtle-foreground">{t('reportHint')}</p>
      </div>
      <div className="space-y-3">
        {list.map((p, i) => (
          <PerformanceCard
            key={`${p.channel}-${i}`}
            channel={p.channel}
            provider={p.provider}
            lastDay={p.lastDay}
            totals={p.totals}
            previous={p.previous && p.previous.days > 0 ? p.previous.totals : null}
            against={against}
          />
        ))}
      </div>
    </section>
  );
}
