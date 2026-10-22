// The client report page (#643): /-/report#<token>, opened from a link the agency sent, with no account. It shows what
// went out in the period on the link's channels, the totals, the counts per channel and the posts that did best, and
// prints cleanly to PDF from the browser. The token stays after the # and goes to the API in a POST body only.
// With the org's white-label branding (#1053) it shows the agency's logo, name and accent instead of Crove's logo.
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { ChangeChip } from '../components/social-growth.tsx';
import { OutsideChip } from '../components/social-external-posts.tsx';
import { AccentRule, BrandMark, MadeWithCrove, accentStyle, useBrandTitle } from '../components/social-report-branding.tsx';
import { ErrorText, Logo, Spinner } from '../components/ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { errorMessage } from '../lib/api.ts';
import { apiErrorFromResponse } from '../lib/errors.ts';
import { usePrintInLight } from '../lib/print.ts';
import { REPORT_METRICS } from '../lib/social-report.ts';
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

export function SocialReportPage() {
  const t = useTranslations('social.clientReport');
  const tm = useTranslations('social.metric');
  const f = useFormat();
  const [token] = useState(tokenOf);
  const page = useQuery({ queryKey: ['client-report', token], queryFn: () => load(token as string), enabled: token !== null, retry: false });
  const data = page.data;
  const metrics = data ? shown(data.totals) : [];
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
                  </section>
                )}
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
            <p className="text-xs text-subtle-foreground">{t('footer', { until: f.date(data.expiresAt) })}</p>
            <MadeWithCrove brand={brand} />
          </>
        ) : null}
      </div>
    </div>
  );
}
