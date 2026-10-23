// Who follows a channel's account (#1146): a "Followers" section on the Metrics tab and in the client report, with
// the followers' ages and genders as bars and their largest cities and countries, from the latest weekly capture.
import { useQuery } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'use-intl';
import { Card } from '@crove/ui/components/card';
import { useFormat } from '../i18n/provider.tsx';
import { orpc } from '../lib/api.ts';
import { audienceOf, countryName, sharesOf, type Audience, type AudienceShare } from '../lib/social-audience.ts';
import { providerName } from '../lib/social.ts';

function Bars({ title, shares, label }: { title: string; shares: AudienceShare[]; label: (key: string) => string }) {
  const t = useTranslations('social.audience');
  const f = useFormat();
  if (shares.length === 0) return null;
  return (
    <div className="space-y-1.5">
      <h4 className="text-xs font-medium text-subtle-foreground">{title}</h4>
      <ul className="space-y-1">
        {shares.map((s) => {
          const share = t('share', { percent: `${f.number(s.percent)}%`, count: f.number(s.count) });
          return (
            <li key={s.key} className="grid grid-cols-[minmax(0,1fr)_minmax(3rem,1fr)_3.25rem] items-center gap-2 text-xs" title={`${label(s.key)}: ${share}`}>
              <span className="truncate text-foreground">{label(s.key)}</span>
              <span className="block h-2 overflow-hidden rounded-full bg-muted print:border" aria-hidden="true">
                <span className="block h-full rounded-full bg-primary" style={{ width: `${Math.max(s.percent, 1)}%` }} />
              </span>
              <span className="text-right text-muted-foreground tabular-nums">
                <span aria-hidden="true">{f.number(s.percent)}%</span>
                <span className="sr-only">{share}</span>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// One channel's audience: ages, genders, cities and countries, each left out when the platform gave none.
export function AudienceCard({ channel, provider, day, audience }: { channel: string; provider: string; day: string; audience: Audience }) {
  const t = useTranslations('social.audience');
  const f = useFormat();
  const locale = useLocale();
  const gender = (key: string) => (key === 'F' || key === 'M' || key === 'U' ? t(`genders.${key}`) : key);
  return (
    <Card className="block space-y-3 p-4 print:break-inside-avoid">
      <div>
        <h3 className="truncate text-sm font-medium text-foreground">
          {channel} <span className="text-xs font-normal text-subtle-foreground">· {providerName(provider)}</span>
        </h3>
        <p className="text-xs text-subtle-foreground">{t('updated', { date: f.date(day) })}</p>
      </div>
      <div className="grid gap-x-8 gap-y-4 sm:grid-cols-2 print:grid-cols-2">
        <Bars title={t('age')} shares={sharesOf(audience.age, 'age')} label={(k) => k} />
        <Bars title={t('gender')} shares={sharesOf(audience.gender, 'gender')} label={gender} />
        <Bars title={t('cities')} shares={sharesOf(audience.cities, 'cities')} label={(k) => k} />
        <Bars title={t('countries')} shares={sharesOf(audience.countries, 'countries')} label={(k) => countryName(k, locale)} />
      </div>
    </Card>
  );
}

// The Metrics tab's section: every channel with an audience taken in the window, from the same trends the growth card
// reads; nothing when none has one.
export function FollowerAudiences({ days, names }: { days: number; names: Map<string, string> }) {
  const t = useTranslations('social.audience');
  const trends = useQuery(orpc.social.accounts.trends.queryOptions({ input: { days } }));
  const list = (trends.data ?? []).flatMap((trend) => {
    const audience = trend.audience ? audienceOf(trend.audience) : null;
    return audience && trend.audience ? [{ connectionId: trend.connectionId, provider: trend.provider, day: trend.audience.day, audience }] : [];
  });
  if (list.length === 0) return null;
  return (
    <section className="space-y-2">
      <div>
        <h3 className="text-sm font-medium text-foreground">{t('title')}</h3>
        <p className="text-xs text-subtle-foreground">{t('hint')}</p>
      </div>
      <div className="space-y-3">
        {list.map((a) => (
          <AudienceCard key={a.connectionId} channel={names.get(a.connectionId) ?? providerName(a.provider)} provider={a.provider} day={a.day} audience={a.audience} />
        ))}
      </div>
    </section>
  );
}

// The client report's section: the latest audience in the period of each of its channels; nothing when none has one.
export function ReportAudiences({ entries }: { entries: unknown }) {
  const t = useTranslations('social.audience');
  const list = (Array.isArray(entries) ? entries : []).slice(0, 50).flatMap((e: unknown) => {
    if (typeof e !== 'object' || e === null) return [];
    const r = e as { channel?: unknown; provider?: unknown; day?: unknown; audience?: unknown };
    const audience = audienceOf(r.audience);
    return audience && typeof r.channel === 'string' && typeof r.provider === 'string' && typeof r.day === 'string' ? [{ channel: r.channel, provider: r.provider, day: r.day, audience }] : [];
  });
  if (list.length === 0) return null;
  return (
    <section className="space-y-2">
      <div>
        <h2 className="text-base font-semibold">{t('title')}</h2>
        <p className="text-xs text-subtle-foreground">{t('reportHint')}</p>
      </div>
      <div className="space-y-3">
        {list.map((a, i) => (
          <AudienceCard key={`${a.channel}-${i}`} channel={a.channel} provider={a.provider} day={a.day} audience={a.audience} />
        ))}
      </div>
    </section>
  );
}
