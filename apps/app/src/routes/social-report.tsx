// The client report page (#643): /-/report#<token>, opened from a link the agency sent, with no account. It shows what
// went out in the period on the link's channels, the totals, the counts per channel and the posts that did best, and
// prints cleanly to PDF from the browser. The token stays after the # and goes to the API in a POST body only.
// With the org's white-label branding (#1053) it shows the agency's logo, name and accent instead of Crove's logo. A
// link may carry the agency's note, shown as plain text, and a report of exactly one month shows the monthly goals
// (#1056), and who follows each channel, from the latest weekly capture in the period (#1146). The engagement rate
// (#1157) of the period, each channel and each best post is worked out on the page from the counts it already gets.
// A campaign report (#1159) counts one label's posts and shows only the link's title, never the label; a link may
// leave out the audience (an empty list), and the period's Reels show their watch time (#1151).
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { ReportAudiences } from '../components/social-audience.tsx';
import { GoalList } from '../components/social-goals.tsx';
import { engagementRate, engagementRateOf } from '@crove/mod-social/contract';
import { ChangeChip, EngagementRateCard, EngagementRateCell } from '../components/social-growth.tsx';
import { useRatePhrase } from '../components/social-engagement-rate.tsx';
import { OutsideChip } from '../components/social-external-posts.tsx';
import { AccentRule, BrandMark, MadeWithCrove, accentStyle, useBrandTitle } from '../components/social-report-branding.tsx';
import { ErrorText, Logo, Spinner } from '../components/ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { errorMessage } from '../lib/api.ts';
import { apiErrorFromResponse } from '../lib/errors.ts';
import { usePrintInLight } from '../lib/print.ts';
import { REPORT_METRICS } from '../lib/social-report.ts';
import { reportReels, watchDuration, watchSeconds } from '../lib/social-insights.ts';
import { reportGoalGroups, type ReportGoals } from '../lib/social-goals.ts';
import { pageBrand } from '../lib/social-report-branding.ts';
import { providerName } from '../lib/social.ts';

type Counts = Record<string, number>;
interface ReportPage {
  org: string;
  // The org's white-label branding (#1053), or null; absent from a server without it. Read again by pageBrand.
  brand?: unknown;
  title: string | null;
  periodStart: string;
  periodEnd: string;
  expiresAt: string;
  posts: number;
  totals: Counts;
  // The period of the same length just before (#947), on the same channels; absent from a server without it.
  previous?: { periodStart: string; periodEnd: string; posts: number; totals: Counts };
  channels: { channel: string; provider: string; posts: number; totals: Counts; previous?: { posts: number; totals: Counts } }[];
  // external (#1054): the post went out outside Crove; includesExternal: the report counts such posts. Both absent from
  // a server without them.
  top: { channel: string; provider: string; excerpt: string; publishedAt: string; url: string | null; metrics: Counts; external?: boolean }[];
  includesExternal?: boolean;
  // The agency's note (#1056), plain text; null or absent when there is none or from a server without notes.
  note?: string | null;
  // The monthly goals (#1056), only for a report of exactly one month; null or absent otherwise.
  goals?: ReportGoals | null;
  // Who follows each channel (#1146): the latest capture in the period; absent from a server without it. Read again by
  // ReportAudiences.
  audience?: unknown;
  // The period's Reels (#1151): how many and the median of their average watch time; absent from a server without it.
  // Read again by ReportReels.
  reels?: unknown;
}

const tokenOf = () => {
  const t = window.location.hash.replace(/^#/, '');
  return /^[A-Za-z0-9_-]{43}$/.test(t) ? t : null;
};

async function load(token: string): Promise<ReportPage | null> {
  const res = await fetch('/api/report/view', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }), credentials: 'omit', referrerPolicy: 'no-referrer' });
  if (res.status === 404) return null;
  if (!res.ok) throw await apiErrorFromResponse(res);
  return (await res.json()) as ReportPage;
}

// The counts a report has, in the order the page shows them.
const shown = (counts: Counts) => REPORT_METRICS.filter((m) => typeof counts[m] === 'number');

// The agency's note, as text: React escapes it, and line breaks show as they were typed.
export function ReportNote({ org, note }: { org: string; note: string }) {
  const t = useTranslations('social.clientReport');
  return (
    <Card className="block space-y-1 p-4 print:break-inside-avoid">
      <h2 className="text-sm font-medium text-foreground">{t('note', { org })}</h2>
      <p className="text-sm break-words whitespace-pre-line text-muted-foreground">{note}</p>
    </Card>
  );
}

// The report's monthly goals by scope (the org's, then each channel's), judged now.
export function ReportGoalsSection({ data, nowMs }: { data: Pick<ReportPage, 'goals' | 'periodStart' | 'periodEnd'>; nowMs: number }) {
  const t = useTranslations('social.clientReport');
  const tg = useTranslations('social.goals');
  const goals = reportGoalGroups(data.goals, data, nowMs);
  if (!goals) return null;
  const [year, month] = goals.month.split('-');
  const over = nowMs >= Date.parse(data.periodEnd);
  return (
    <section className="space-y-2 print:break-inside-avoid">
      <h2 className="text-base font-semibold">{t('goals', { month: month ?? '', year: year ?? '' })}</h2>
      <div className="grid gap-3 md:grid-cols-2 print:grid-cols-2">
        {goals.groups.map((g, i) => (
          <Card key={`${g.channel ?? ''}-${i}`} className="block space-y-2 p-4 print:break-inside-avoid">
            <h3 className="text-sm font-medium text-foreground">
              {g.channel === null ? tg('org') : `${g.channel}${g.provider ? ` · ${providerName(g.provider)}` : ''}`}
              <span className="ml-2 text-xs font-normal text-subtle-foreground">{tg('met', { met: g.progress.filter((p) => p.status === 'met').length, total: g.progress.length })}</span>
            </h3>
            <GoalList items={g.progress} over={over} />
          </Card>
        ))}
      </div>
    </section>
  );
}

// The period's Reels (#1151): how many went out, the median of their average watch time (never a sum of averages) and
// their total watch time against the period before. Nothing when the period has no Reel or the server sends none.
export function ReportReels({ reels, total, previous, against }: { reels: unknown; total: number | undefined; previous: number | undefined; against: string }) {
  const t = useTranslations('social');
  const f = useFormat();
  const r = reportReels(reels);
  if (!r) return null;
  const duration = (ms: number) => {
    const d = watchDuration(ms);
    return t(`watch.${d.unit}`, { value: f.number(d.value) });
  };
  return (
    <Card className="block space-y-1 p-4 print:break-inside-avoid">
      <h2 className="text-base font-semibold">{t('clientReport.reels')}</h2>
      <p className="text-sm text-muted-foreground">{t('clientReport.reelsCount', { count: r.posts })}</p>
      {r.medianAvgWatchTimeMs !== null && (
        <p className="text-sm text-muted-foreground tabular-nums">{t('clientReport.reelsAverage', { time: t('watch.seconds', { value: f.number(watchSeconds(r.medianAvgWatchTimeMs)) }) })}</p>
      )}
      {typeof total === 'number' && Number.isFinite(total) && total >= 0 && (
        <p className="text-sm text-muted-foreground tabular-nums">
          {t('clientReport.reelsTotal', { time: duration(total) })} <ChangeChip current={total} previous={previous} against={against} withPrevious format={duration} />
        </p>
      )}
    </Card>
  );
}

export function SocialReportPage() {
  const t = useTranslations('social.clientReport');
  const tm = useTranslations('social.metric');
  const tr = useTranslations('social.engagementRate');
  const f = useFormat();
  const [token] = useState(tokenOf);
  const page = useQuery({ queryKey: ['client-report', token], queryFn: () => load(token as string), enabled: token !== null, retry: false });
  const data = page.data;
  const metrics = data ? shown(data.totals) : [];
  // The engagement rate (#1157) from the channels' totals the page already has: the sum over the channels that report
  // reach (else impressions), for this period and the one before.
  const rate = data ? engagementRateOf(data.channels.map((c) => c.totals)) : null;
  const rateBefore = data ? engagementRateOf(data.channels.map((c) => c.previous?.totals ?? {})) : null;
  const rateLine = useRatePhrase('line');
  const against = t('against');
  const brand = data ? pageBrand(data.brand) : null;
  useBrandTitle(brand, data?.org ?? '');
  // Neither mark until the page is known, so a branded report never shows Crove's logo while it loads.
  const loading = token !== null && page.isLoading;
  // A printed report is on paper: the light theme while printing, whatever the screen uses.
  usePrintInLight();
  return (
    <div className="min-h-screen bg-background px-4 py-6 text-foreground print:px-0 print:py-0" style={accentStyle(brand)}>
      <div className="mx-auto max-w-4xl space-y-5">
        <div className="flex min-h-7 items-center justify-between gap-2">
          {loading ? <span aria-hidden="true" /> : brand && data ? <BrandMark brand={brand} org={data.org} /> : <Logo />}
          {data && (
            <Button variant="outline" size="sm" className="print:hidden" onClick={() => window.print()}>
              {t('print')}
            </Button>
          )}
        </div>
        {token === null || (page.isSuccess && data === null) ? (
          <Card className="block p-6">
            <h1 className="text-lg font-semibold">{t('invalidTitle')}</h1>
            <p className="mt-1 text-sm text-muted-foreground">{t('invalid')}</p>
          </Card>
        ) : page.isLoading ? (
          <Spinner />
        ) : page.error ? (
          <ErrorText>{errorMessage(page.error)}</ErrorText>
        ) : data ? (
          <>
            <AccentRule brand={brand} />
            <header className="space-y-1">
              <p className="text-sm text-muted-foreground">{brand?.name ?? data.org}</p>
              <h1 className="text-2xl font-semibold">{data.title ?? t('title')}</h1>
              <p className="text-sm text-muted-foreground">
                {t('period', { from: f.date(data.periodStart), to: f.date(new Date(Date.parse(data.periodEnd) - 1).toISOString()) })} · {t('posts', { count: data.posts })}{' '}
                <ChangeChip current={data.posts} previous={data.previous?.posts} against={against} />
              </p>
              {data.previous && (
                <p className="text-xs text-subtle-foreground">
                  {t('compared', { from: f.date(data.previous.periodStart), to: f.date(new Date(Date.parse(data.previous.periodEnd) - 1).toISOString()) })}
                </p>
              )}
              {data.includesExternal === true && <p className="text-xs text-subtle-foreground">{t('withExternal')}</p>}
            </header>
            {typeof data.note === 'string' && data.note.trim() !== '' && <ReportNote org={data.org} note={data.note} />}
            <ReportGoalsSection data={data} nowMs={Date.now()} />
            {data.posts === 0 ? (
              <Card className="block p-6 text-sm text-muted-foreground">{t('empty')}</Card>
            ) : (
              <>
                {metrics.length > 0 && (
                  <section className="grid grid-cols-2 gap-3 sm:grid-cols-4 print:grid-cols-4">
                    {metrics.map((m) => (
                      <Card key={m} className="block p-4 print:break-inside-avoid">
                        <p className="text-xs text-subtle-foreground">{tm(m)}</p>
                        <p className="mt-1 text-xl font-semibold tabular-nums">{f.number(data.totals[m] ?? 0)}</p>
                        <ChangeChip current={data.totals[m]} previous={data.previous?.totals[m]} against={against} withPrevious className="mt-1" />
                      </Card>
                    ))}
                    <EngagementRateCard current={rate} previous={data.previous ? rateBefore : null} against={against} className="print:break-inside-avoid" />
                  </section>
                )}
                <ReportReels reels={data.reels} total={data.totals.totalWatchTimeMs} previous={data.previous?.totals.totalWatchTimeMs} against={against} />
                <section className="space-y-2 print:break-inside-avoid">
                  <h2 className="text-base font-semibold">{t('byChannel')}</h2>
                  <div className="overflow-x-auto rounded-xl border print:overflow-visible">
                    <table className="w-full text-sm">
                      <thead className="bg-muted text-xs text-subtle-foreground print:bg-transparent">
                        <tr>
                          <th className="px-3 py-2 text-left font-medium">{t('channel')}</th>
                          <th className="px-3 py-2 text-right font-medium">{t('postsColumn')}</th>
                          {metrics.map((m) => (
                            <th key={m} className="px-3 py-2 text-right font-medium">
                              {tm(m)}
                            </th>
                          ))}
                          <th className="px-3 py-2 text-right font-medium">{tr('label')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.channels.map((c, i) => (
                          <tr key={`${c.channel}-${i}`} className="border-t align-top">
                            <td className="px-3 py-2">
                              {c.channel} <span className="text-xs text-subtle-foreground">· {providerName(c.provider)}</span>
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums">
                              <span className="block">{f.number(c.posts)}</span>
                              <ChangeChip current={c.posts} previous={c.previous?.posts} against={against} />
                            </td>
                            {metrics.map((m) => (
                              <td key={m} className="px-3 py-2 text-right tabular-nums">
                                {/* A channel that posted only in the period before (#947) shows 0 now where it had a count then. */}
                                <span className="block">{c.totals[m] !== undefined ? f.number(c.totals[m]) : c.previous?.totals[m] !== undefined ? f.number(0) : '-'}</span>
                                <ChangeChip current={c.totals[m]} previous={c.previous?.totals[m]} against={against} />
                              </td>
                            ))}
                            <EngagementRateCell current={c.totals} previous={c.previous?.totals} against={against} />
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
                <section className="space-y-2">
                  <h2 className="text-base font-semibold">{t('top')}</h2>
                  <ol className="space-y-2">
                    {data.top.map((p, i) => (
                      <li key={`${p.publishedAt}-${i}`} className="rounded-xl border p-3 print:break-inside-avoid">
                        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-subtle-foreground">
                          <span>
                            {p.channel} · {providerName(p.provider)} · {f.dateTime(p.publishedAt)}
                          </span>
                          {p.external === true && <OutsideChip label={t('direct')} />}
                        </p>
                        <p className="mt-1 text-sm break-words">{p.excerpt || t('noText')}</p>
                        <p className="mt-1 text-xs text-muted-foreground tabular-nums">
                          {shown(p.metrics)
                            .map((m) => `${tm(m)}: ${f.number(p.metrics[m] ?? 0)}`)
                            .join(' · ')}
                        </p>
                        {engagementRate(p.metrics) && <p className="text-xs text-muted-foreground tabular-nums">{rateLine(engagementRate(p.metrics))}</p>}
                        {p.url && (
                          <a href={p.url} target="_blank" rel="noopener noreferrer nofollow" className="mt-1 inline-block text-xs text-link hover:underline print:hidden">
                            {t('open')}
                          </a>
                        )}
                      </li>
                    ))}
                  </ol>
                </section>
              </>
            )}
            <ReportAudiences entries={data.audience} />
            <p className="text-xs text-subtle-foreground">{t('footer', { until: f.date(data.expiresAt) })}</p>
            <MadeWithCrove brand={brand} />
          </>
        ) : null}
      </div>
    </div>
  );
}
