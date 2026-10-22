// Monthly goals on the Metrics tab (#1056): how the month stands against the org's goals and each channel's (count,
// target, a progress bar, the linear end-of-month projection, met or missed), for every member; owners and admins set
// and remove them. GoalList also draws the goals of a one-month client report.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Input } from '@crove/ui/components/input';
import { Label } from '@crove/ui/components/label';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { GOAL_METRICS, GOAL_TARGET_MAX, type GoalMetric, type GoalProgress, type GoalStatus } from '@crove/mod-social/contract';
import { cn } from '@crove/ui/lib/utils';
import { ErrorText } from './ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';
import { shiftMonth } from '../lib/social-goals.ts';
import { providerName } from '../lib/social.ts';

type Goals = Awaited<ReturnType<typeof orpc.social.goals.progress.call>>;
type Goal = Goals['goals'][number];

const BADGE: Readonly<Record<GoalStatus, 'success' | 'destructive' | 'brand' | 'warning' | 'outline'>> = {
  met: 'success',
  missed: 'destructive',
  on_track: 'brand',
  behind: 'warning',
  no_data: 'outline',
};
const BAR: Readonly<Record<GoalStatus, string>> = { met: 'bg-success', missed: 'bg-destructive', on_track: 'bg-primary', behind: 'bg-warning', no_data: 'bg-muted' };

/** Each goal of a scope: its count against its target, a bar, the projection while the month runs, its status. */
export function GoalList({ items, over }: { items: readonly GoalProgress[]; over: boolean }) {
  const t = useTranslations('social.goals');
  const f = useFormat();
  return (
    <ul className="space-y-3">
      {items.map((g) => {
        const width = g.ratio === null ? 0 : Math.max(0, Math.min(1, g.ratio)) * 100;
        return (
          <li key={g.metric} className="space-y-1 print:break-inside-avoid">
            <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
              <span className="text-foreground">{t(`metric.${g.metric}`)}</span>
              <span className="flex items-center gap-2">
                <span className="text-foreground tabular-nums">{t('of', { actual: g.actual === null ? '-' : f.number(g.actual), target: f.number(g.target) })}</span>
                <Badge variant={BADGE[g.status]}>{t(`status.${g.status}`)}</Badge>
              </span>
            </div>
            <div
              className="h-2 overflow-hidden rounded-full bg-muted"
              role="progressbar"
              aria-label={t(`metric.${g.metric}`)}
              aria-valuemin={0}
              aria-valuemax={g.target}
              aria-valuenow={g.actual ?? 0}
            >
              <div className={cn('h-full rounded-full', BAR[g.status])} style={{ width: `${width}%` }} />
            </div>
            {!over && g.projected !== null && g.status !== 'met' && (
              <p className="text-xs text-subtle-foreground tabular-nums">{t('projected', { value: f.number(g.projected) })}</p>
            )}
          </li>
        );
      })}
    </ul>
  );
}

// A scope's targets as the form shows them: empty where none is set.
function fill(g: Goal | undefined): Record<GoalMetric, string> {
  const v: Record<GoalMetric, string> = { posts: '', reach: '', impressions: '', engagement: '', followersGained: '' };
  if (g) for (const m of GOAL_METRICS) v[m] = g.targets[m] === null ? '' : String(g.targets[m]);
  return v;
}

// A target as typed: empty is no target; otherwise a whole count from 1 up, or undefined when it is not one.
function parseTarget(text: string): number | null | undefined {
  const s = text.replace(/[\s.,]/g, '');
  if (s === '') return null;
  if (!/^\d+$/.test(s)) return undefined;
  const n = Number(s);
  return n >= 1 && n <= GOAL_TARGET_MAX ? n : undefined;
}

function GoalForm({ goals, channels, onDone }: { goals: Goals; channels: readonly { id: string; displayName: string; provider: string }[]; onDone: () => void }) {
  const t = useTranslations('social.goals');
  const [scope, setScope] = useState<string>('');
  const current = goals.goals.find((g) => (g.connectionId ?? '') === scope);
  const [values, setValues] = useState<Record<GoalMetric, string>>(() => fill(current));
  const parsed = GOAL_METRICS.map((m) => [m, parseTarget(values[m])] as const);
  const invalid = parsed.some(([, v]) => v === undefined);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: orpc.social.goals.progress.key() });
  // The zone months are counted in: the org's, or this browser's for the first goal.
  const timeZone = goals.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const save = useMutation({
    mutationFn: () =>
      client.social.goals.set({ connectionId: scope === '' ? null : scope, timeZone, targets: Object.fromEntries(parsed.map(([m, v]) => [m, v ?? null])) as Record<GoalMetric, number | null> }),
    onSuccess: () => {
      refresh();
      onDone();
    },
  });
  const remove = useMutation({
    mutationFn: () => client.social.goals.remove({ connectionId: scope === '' ? null : scope }),
    onSuccess: () => {
      refresh();
      onDone();
    },
  });
  return (
    <div className="space-y-3 rounded-lg border p-3">
      <div className="space-y-1.5">
        <Label htmlFor="goal-scope">{t('scope')}</Label>
        <NativeSelect
          id="goal-scope"
          value={scope}
          onChange={(e) => {
            setScope(e.target.value);
            setValues(fill(goals.goals.find((g) => (g.connectionId ?? '') === e.target.value)));
          }}
        >
          <NativeSelectOption value="">{t('org')}</NativeSelectOption>
          {channels.map((c) => (
            <NativeSelectOption key={c.id} value={c.id}>
              {c.displayName} · {providerName(c.provider)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {GOAL_METRICS.map((m) => (
          <div key={m} className="space-y-1.5">
            <Label htmlFor={`goal-${m}`}>{t(`metric.${m}`)}</Label>
            <Input
              id={`goal-${m}`}
              inputMode="numeric"
              value={values[m]}
              placeholder={t('targetPlaceholder')}
              aria-invalid={parseTarget(values[m]) === undefined}
              onChange={(e) => setValues({ ...values, [m]: e.target.value })}
            />
          </div>
        ))}
      </div>
      <p className="text-xs text-subtle-foreground">{t('engagementHint')}</p>
      {invalid && <p className="text-xs text-warning">{t('invalid')}</p>}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={invalid || save.isPending} onClick={() => save.mutate()}>
          {t('save')}
        </Button>
        {current && (
          <Button size="sm" variant="outline" disabled={remove.isPending} onClick={() => remove.mutate()}>
            {t('remove')}
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={onDone}>
          {t('cancel')}
        </Button>
      </div>
      {save.error && <ErrorText>{errorMessage(save.error)}</ErrorText>}
      {remove.error && <ErrorText>{errorMessage(remove.error)}</ErrorText>}
    </div>
  );
}

export function GoalsCard({ channels }: { channels: readonly { id: string; displayName: string; provider: string; status?: string }[] }) {
  const t = useTranslations('social.goals');
  const { slug } = useParams({ strict: false }) as { slug: string };
  const me = useQuery(orpc.me.get.queryOptions());
  const role = me.data?.orgs.find((o) => o.slug === slug)?.role;
  const canEdit = role === 'owner' || role === 'admin';
  const [month, setMonth] = useState<string | undefined>(undefined);
  const [editing, setEditing] = useState(false);
  const goals = useQuery(orpc.social.goals.progress.queryOptions({ input: month ? { month } : {} }));
  if (goals.isLoading) return null;
  if (goals.error) return <ErrorText>{errorMessage(goals.error)}</ErrorText>;
  const data = goals.data;
  if (!data) return null;
  if (data.goals.length === 0 && !canEdit) return null;
  const names = new Map(channels.map((c) => [c.id, c]));
  const [year, mon] = data.month.split('-');
  const now = Date.now();
  const end = Date.parse(data.periodEnd);
  const over = now >= end;
  const daysLeft = over ? 0 : Math.ceil((end - Math.max(now, Date.parse(data.periodStart))) / 86_400_000);
  return (
    <Card className="block space-y-3 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-medium text-foreground">{t('title')}</h3>
          <p className="text-xs text-subtle-foreground">
            {t('month', { month: mon ?? '', year: year ?? '' })} · {t('daysLeft', { count: daysLeft })}
            {data.timeZone ? ` · ${t('zone', { zone: data.timeZone })}` : ''}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <Button size="sm" variant="ghost" onClick={() => setMonth(shiftMonth(data.month, -1))}>
            {t('previous')}
          </Button>
          {month && (
            <Button size="sm" variant="ghost" onClick={() => setMonth(undefined)}>
              {t('current')}
            </Button>
          )}
          {canEdit && !editing && (
            <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
              {t('edit')}
            </Button>
          )}
        </div>
      </div>
      {editing && <GoalForm goals={data} channels={channels.filter((c) => c.status !== 'revoked')} onDone={() => setEditing(false)} />}
      {data.goals.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('empty')}</p>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {data.goals.map((g) => {
            const c = g.connectionId === null ? null : names.get(g.connectionId);
            return (
              <section key={g.id} className="space-y-2">
                <h4 className="text-sm font-medium text-foreground">
                  {g.connectionId === null ? t('org') : c ? `${c.displayName} · ${providerName(c.provider)}` : t('goneChannel')}
                  <span className="ml-2 text-xs font-normal text-subtle-foreground">{t('met', { met: g.progress.filter((p) => p.status === 'met').length, total: g.progress.length })}</span>
                </h4>
                <GoalList items={g.progress} over={over} />
              </section>
            );
          })}
        </div>
      )}
    </Card>
  );
}
