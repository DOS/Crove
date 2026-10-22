// The content plan as a page to print (#978): /o/<slug>/print/social-plan?from=&to=&channels=&labels=, opened in a new
// tab from Export plan on the calendar, outside the app's frame so only the plan reaches the paper. The rows come from
// the same audited export as the CSV file (format print), in the browser's time zone, and print to PDF from the
// browser with the client report's print styles (#643). With the org's white-label branding (#1053) it carries the
// agency's logo, name and accent, as the client report does.
import { useQuery } from '@tanstack/react-query';
import { useParams, useSearch } from '@tanstack/react-router';
import { useTranslations } from 'use-intl';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { ErrorText, Logo, Spinner } from '../components/ui.tsx';
import { AccentRule, BrandMark, MadeWithCrove, accentStyle } from '../components/social-report-branding.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { client, errorMessage, orpc } from '../lib/api.ts';
import { usePrintInLight } from '../lib/print.ts';
import { PLAN_EXPORT_MAX_ROWS, planRange, type PlanFilter } from '../lib/social-plan-export.ts';
import { providerName, VARIANT_TONE, type VariantStatus } from '../lib/social.ts';
import { pageBrand } from '../lib/social-report-branding.ts';

export function SocialPlanPrintPage() {
  const { slug } = useParams({ strict: false }) as { slug: string };
  const search = useSearch({ strict: false }) as Partial<PlanFilter>;
  const t = useTranslations('social');
  const tp = useTranslations('social.planExport');
  const f = useFormat();
  usePrintInLight();
  const range = search.from && search.to ? planRange(search.from, search.to) : null;
  const me = useQuery(orpc.me.get.queryOptions());
  const org = me.data?.orgs.find((o) => o.slug === slug)?.name ?? '';
  const branding = useQuery(orpc.social.reportBranding.get.queryOptions({ input: {} }));
  const brand = pageBrand(branding.data);
  const channels = search.channels ?? [];
  const labels = search.labels ?? [];
  // A command (each print is audited like a download); asked once, never again on its own.
  const plan = useQuery({
    queryKey: ['social-plan-print', slug, range, channels, labels],
    queryFn: () =>
      client.social.plan.export({
        ...(range as { from: string; to: string }),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        ...(channels.length > 0 ? { connectionIds: channels } : {}),
        ...(labels.length > 0 ? { labelIds: labels } : {}),
        format: 'print',
      }),
    enabled: range !== null,
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  const rows = plan.data?.rows ?? [];
  return (
    <div className="min-h-screen bg-background px-4 py-6 text-foreground print:px-0 print:py-0" style={accentStyle(brand)}>
      <div className="mx-auto max-w-4xl space-y-5">
        <div className="flex min-h-7 items-center justify-between gap-2">
          {branding.isLoading ? <span aria-hidden="true" /> : brand ? <BrandMark brand={brand} org={org} /> : <Logo />}
          {/* Printing waits for the branding too: a PDF made meanwhile would carry Crove's mark, not the agency's. */}
          {plan.data && branding.isSuccess && (
            <Button variant="outline" size="sm" className="print:hidden" onClick={() => window.print()}>
              {tp('print')}
            </Button>
          )}
        </div>
        {branding.error && (
          <div className="flex flex-wrap items-center gap-2 print:hidden">
            <ErrorText>{tp('brandingError')}</ErrorText>
            <Button variant="outline" size="sm" onClick={() => void branding.refetch()}>
              {tp('brandingRetry')}
            </Button>
          </div>
        )}
        {range === null ? (
          <Card className="block p-6">
            <h1 className="text-lg font-semibold">{tp('invalidTitle')}</h1>
            <p className="mt-1 text-sm text-muted-foreground">{tp('invalid')}</p>
          </Card>
        ) : plan.isLoading ? (
          <Spinner />
        ) : plan.error ? (
          <ErrorText>{errorMessage(plan.error)}</ErrorText>
        ) : plan.data ? (
          <>
            <AccentRule brand={brand} />
            <header className="space-y-1">
              {(brand?.name ?? org) && <p className="text-sm text-muted-foreground">{brand?.name ?? org}</p>}
              <h1 className="text-2xl font-semibold">{tp('pageTitle')}</h1>
              <p className="text-sm text-muted-foreground">
                {tp('period', { from: f.date(search.from), to: f.date(search.to) })} · {tp('count', { count: rows.length })}
              </p>
            </header>
            {plan.data.truncated && <p className="text-sm text-warning">{tp('printTruncated', { max: PLAN_EXPORT_MAX_ROWS })}</p>}
            {rows.length === 0 ? (
              <Card className="block p-6 text-sm text-muted-foreground">{tp('empty')}</Card>
            ) : (
              <ol className="space-y-2">
                {rows.map((r) => (
                  <li key={r.variantId} className="rounded-xl border p-3 print:break-inside-avoid">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-subtle-foreground">
                      <span className="font-mono text-foreground tabular-nums">{f.dateTime(r.at)}</span>
                      <span>
                        {r.channel} · {providerName(r.provider)}
                      </span>
                      <Badge variant={VARIANT_TONE[r.status as VariantStatus] ?? 'outline'}>{t(`status.${r.status as VariantStatus}`)}</Badge>
                    </div>
                    {r.title && <p className="mt-1 text-sm font-medium">{r.title}</p>}
                    <p className="mt-1 text-sm break-words whitespace-pre-wrap">{r.body || tp('noText')}</p>
                    {r.linkUrl && <p className="mt-1 font-mono text-xs break-all text-muted-foreground">{r.linkUrl}</p>}
                    {(r.labels.length > 0 || r.assignee) && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        {[r.labels.length > 0 ? tp('labelsLine', { labels: r.labels.join(', ') }) : null, r.assignee ? tp('assigneeLine', { name: r.assignee }) : null].filter(Boolean).join(' · ')}
                      </p>
                    )}
                  </li>
                ))}
              </ol>
            )}
            <MadeWithCrove brand={brand} />
          </>
        ) : null}
      </div>
    </div>
  );
}
