// The client report page (#643): /-/report#<token>, opened from a link the agency sent, with no account. It shows what
// went out in the period on the link's channels, the totals, the counts per channel and the posts that did best, and
// prints cleanly to PDF from the browser. The token stays after the # and goes to the API in a POST body only.
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { ErrorText, Logo, Spinner } from '../components/ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { errorMessage } from '../lib/api.ts';
import { apiErrorFromResponse } from '../lib/errors.ts';
import { usePrintInLight } from '../lib/print.ts';
import { REPORT_METRICS } from '../lib/social-report.ts';
import { providerName } from '../lib/social.ts';

type Counts = Record<string, number>;
interface ReportPage {
  org: string;
  title: string | null;
  periodStart: string;
  periodEnd: string;
  expiresAt: string;
  posts: number;
  totals: Counts;
  channels: { channel: string; provider: string; posts: number; totals: Counts }[];
  top: { channel: string; provider: string; excerpt: string; publishedAt: string; url: string | null; metrics: Counts }[];
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
  // A printed report is on paper: the light theme while printing, whatever the screen uses.
  usePrintInLight();
  return (
    <div className="min-h-screen bg-background px-4 py-6 text-foreground print:px-0 print:py-0">
      <div className="mx-auto max-w-4xl space-y-5">
        <div className="flex items-center justify-between gap-2">
          <Logo />
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
            <header className="space-y-1">
              <p className="text-sm text-muted-foreground">{data.org}</p>
              <h1 className="text-2xl font-semibold">{data.title ?? t('title')}</h1>
              <p className="text-sm text-muted-foreground">
                {t('period', { from: f.date(data.periodStart), to: f.date(new Date(Date.parse(data.periodEnd) - 1).toISOString()) })} · {t('posts', { count: data.posts })}
              </p>
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
                          <tr key={`${c.channel}-${i}`} className="border-t">
                            <td className="px-3 py-2">
                              {c.channel} <span className="text-xs text-subtle-foreground">· {providerName(c.provider)}</span>
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums">{f.number(c.posts)}</td>
                            {metrics.map((m) => (
                              <td key={m} className="px-3 py-2 text-right tabular-nums">
                                {c.totals[m] === undefined ? '-' : f.number(c.totals[m])}
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
                        <p className="text-xs text-subtle-foreground">
                          {p.channel} · {providerName(p.provider)} · {f.dateTime(p.publishedAt)}
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
          </>
        ) : null}
      </div>
    </div>
  );
}
