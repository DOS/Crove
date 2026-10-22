// The team report on the Metrics tab (#1058), for owners and admins: per member, over the days picked, the posts they
// created, sent to review, had approved and published, the posts assigned to them with a due date then and how many
// ran late, and the review decisions they made with the median time from submission to decision; then the client
// review links' answers and their median time. The file saved is built from the rows shown, with the exports' quoting.
import { useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { teamReportCsv, TEAM_REPORT_MAX_DAYS } from '@crove/mod-social/contract';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Input } from '@crove/ui/components/input';
import { Label } from '@crove/ui/components/label';
import { ErrorText, Spinner } from './ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { errorMessage, orpc } from '../lib/api.ts';
import { lastMonth } from '../lib/social-report.ts';
import { saveCsv } from '../lib/social-plan-export.ts';
import { durationOf, teamFilename, teamRange } from '../lib/social-team-report.ts';

const COUNTS = ['created', 'submitted', 'approved', 'published', 'assigned', 'overdue', 'decisions'] as const;

export function TeamReport() {
  const t = useTranslations('social.team');
  const f = useFormat();
  const { slug } = useParams({ strict: false }) as { slug: string };
  const me = useQuery(orpc.me.get.queryOptions());
  const role = me.data?.orgs.find((o) => o.slug === slug)?.role;
  const canSee = role === 'owner' || role === 'admin';
  const [period, setPeriod] = useState(() => lastMonth(new Date()));
  const range = teamRange(period.from, period.to);
  const report = useQuery({ ...orpc.social.team.report.queryOptions({ input: range ?? { from: '', to: '' } }), enabled: canSee && range !== null });
  if (!canSee) return null;
  const duration = (seconds: number | null) => {
    if (seconds === null) return '-';
    const d = durationOf(seconds);
    return t(`duration.${d.unit}`, { value: d.value });
  };
  const data = report.data;
  const save = () => {
    if (data) saveCsv(teamFilename(period.from, period.to), teamReportCsv(data, t('clientRow')));
  };
  return (
    <Card className="block space-y-3 p-4">
      <div>
        <h3 className="text-sm font-medium text-foreground">{t('title')}</h3>
        <p className="text-xs text-subtle-foreground">{t('hint')}</p>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="team-report-from">{t('from')}</Label>
          <Input id="team-report-from" type="date" value={period.from} onChange={(e) => setPeriod({ ...period, from: e.target.value })} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="team-report-to">{t('to')}</Label>
          <Input id="team-report-to" type="date" value={period.to} onChange={(e) => setPeriod({ ...period, to: e.target.value })} />
        </div>
        <Button size="sm" variant="outline" className="ml-auto" disabled={!data} onClick={save}>
          {t('download')}
        </Button>
      </div>
      {!range && <p className="text-xs text-warning">{t('rangeInvalid', { max: TEAM_REPORT_MAX_DAYS })}</p>}
      {report.error && <ErrorText>{errorMessage(report.error)}</ErrorText>}
      {range && report.isLoading && <Spinner />}
      {data && (
        <>
          <div className="overflow-x-auto rounded-xl border">
            <table className="w-full text-sm">
              <caption className="sr-only">{t('caption', { from: f.date(data.from), to: f.date(new Date(Date.parse(data.to) - 1).toISOString()) })}</caption>
              <thead className="bg-muted text-xs text-subtle-foreground">
                <tr>
                  <th scope="col" className="px-3 py-2 text-left font-medium">
                    {t('column.member')}
                  </th>
                  {COUNTS.map((c) => (
                    <th key={c} scope="col" className="px-3 py-2 text-right font-medium">
                      {t(`column.${c}`)}
                    </th>
                  ))}
                  <th scope="col" className="px-3 py-2 text-right font-medium">
                    {t('column.decisionTime')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.members.map((m) => (
                  <tr key={m.userId} className="border-t">
                    <th scope="row" className="px-3 py-2 text-left font-normal">
                      {m.left ? (
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="text-muted-foreground">{t('leftName', { id: m.userId.slice(0, 8) })}</span>
                          <Badge variant="outline">{t('left')}</Badge>
                        </span>
                      ) : (
                        <span className="text-foreground">{m.name}</span>
                      )}
                    </th>
                    {COUNTS.map((c) => (
                      <td key={c} className={`px-3 py-2 text-right tabular-nums ${c === 'overdue' && m.overdue > 0 ? 'text-destructive' : 'text-foreground'}`}>
                        {f.number(m[c])}
                      </td>
                    ))}
                    <td className="px-3 py-2 text-right text-foreground tabular-nums">{duration(m.decisionSeconds)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-sm text-muted-foreground">
            {data.client.answers === 0
              ? t('clientNone')
              : t('client', { answers: data.client.answers, approved: data.client.approved, changes: data.client.changesRequested, time: duration(data.client.medianSeconds) })}
          </p>
          <p className="text-xs text-subtle-foreground">{t('notes')}</p>
        </>
      )}
    </Card>
  );
}
