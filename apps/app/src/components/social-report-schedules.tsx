// Scheduled client report mail on the Metrics tab (#704): owners and admins set a schedule (weekly or monthly, at an
// hour of their time zone), the period each mail covers, the channels and up to 10 recipients; pause, test or remove
// it, and see each recent send with every mail's delivery status.
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
import { Textarea } from '@crove/ui/components/textarea';
import { ErrorText } from './ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';
import { providerName } from '../lib/social.ts';
import { parseRecipients } from '../lib/social-report.ts';

type Schedule = Awaited<ReturnType<typeof client.social.reportSchedules.list>>[number];
type Period = Schedule['period'];
const PERIODS: readonly Period[] = ['previous_week', 'previous_month', 'last_7_days', 'last_30_days'];
const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;
const HOURS = Array.from({ length: 24 }, (_, h) => h);
const DELIVERED = new Set(['sent', 'delivered']);
const FAILED = new Set(['failed', 'bounced', 'complained', 'suppressed']);

const browserZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Ho_Chi_Minh';
  } catch {
    return 'Asia/Ho_Chi_Minh';
  }
};

function Form({ channels, onDone }: { channels: readonly { id: string; displayName: string; provider: string }[]; onDone: () => void }) {
  const t = useTranslations('social.reportSchedules');
  const [name, setName] = useState('');
  const [cadence, setCadence] = useState<'weekly' | 'monthly'>('weekly');
  const [weekday, setWeekday] = useState(1);
  const [monthDay, setMonthDay] = useState(1);
  const [sendHour, setSendHour] = useState(8);
  const [period, setPeriod] = useState<Period>('previous_week');
  const [recipients, setRecipients] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const parsed = parseRecipients(recipients);
  const save = useMutation({
    mutationFn: () =>
      client.social.reportSchedules.save({
        name: name.trim(),
        cadence,
        ...(cadence === 'weekly' ? { weekday } : { monthDay }),
        sendHour,
        timeZone: browserZone(),
        period,
        connectionIds: [...picked],
        recipients: parsed.valid,
      }),
    onSuccess: () => {
      setName('');
      setRecipients('');
      setPicked(new Set());
      onDone();
    },
  });
  const toggle = (id: string) => {
    const next = new Set(picked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setPicked(next);
  };
  const ok = name.trim().length > 0 && parsed.valid.length > 0 && parsed.valid.length <= 10 && parsed.invalid.length === 0;
  return (
    <div className="space-y-3 rounded-lg border p-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="schedule-name">{t('name')}</Label>
          <Input id="schedule-name" value={name} maxLength={120} placeholder={t('namePlaceholder')} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="schedule-period">{t('period')}</Label>
          <NativeSelect id="schedule-period" value={period} onChange={(e) => setPeriod(e.target.value as Period)}>
            {PERIODS.map((p) => (
              <NativeSelectOption key={p} value={p}>
                {t(`periods.${p}`)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="schedule-cadence">{t('cadence')}</Label>
          <NativeSelect id="schedule-cadence" value={cadence} onChange={(e) => setCadence(e.target.value as 'weekly' | 'monthly')}>
            <NativeSelectOption value="weekly">{t('weekly')}</NativeSelectOption>
            <NativeSelectOption value="monthly">{t('monthly')}</NativeSelectOption>
          </NativeSelect>
        </div>
        <div className="flex gap-2">
          {cadence === 'weekly' ? (
            <div className="flex-1 space-y-1.5">
              <Label htmlFor="schedule-weekday">{t('weekday')}</Label>
              <NativeSelect id="schedule-weekday" value={String(weekday)} onChange={(e) => setWeekday(Number(e.target.value))}>
                {WEEKDAYS.map((d) => (
                  <NativeSelectOption key={d} value={String(d)}>
                    {t(`weekdays.${d}`)}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
          ) : (
            <div className="flex-1 space-y-1.5">
              <Label htmlFor="schedule-day">{t('monthDay')}</Label>
              <NativeSelect id="schedule-day" value={String(monthDay)} onChange={(e) => setMonthDay(Number(e.target.value))}>
                {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
                  <NativeSelectOption key={d} value={String(d)}>
                    {t('dayOfMonth', { day: String(d) })}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
          )}
          <div className="w-28 space-y-1.5">
            <Label htmlFor="schedule-hour">{t('hour')}</Label>
            <NativeSelect id="schedule-hour" value={String(sendHour)} onChange={(e) => setSendHour(Number(e.target.value))}>
              {HOURS.map((h) => (
                <NativeSelectOption key={h} value={String(h)}>
                  {`${String(h).padStart(2, '0')}:00`}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="schedule-recipients">{t('recipients')}</Label>
        <Textarea id="schedule-recipients" rows={2} value={recipients} placeholder="khach@example.com, sep@example.com" onChange={(e) => setRecipients(e.target.value)} />
        <p className="text-xs text-subtle-foreground">{parsed.invalid.length > 0 ? t('recipientsInvalid', { list: parsed.invalid.join(', ') }) : t('recipientsHint')}</p>
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
      <p className="text-xs text-subtle-foreground">{t('zoneHint', { zone: browserZone() })}</p>
      <Button size="sm" disabled={!ok || save.isPending} onClick={() => save.mutate()}>
        {t('save')}
      </Button>
      {save.error && <ErrorText>{errorMessage(save.error)}</ErrorText>}
    </div>
  );
}

function Item({ s, names }: { s: Schedule; names: Map<string, string> }) {
  const t = useTranslations('social.reportSchedules');
  const f = useFormat();
  const refresh = () => void queryClient.invalidateQueries({ queryKey: orpc.social.reportSchedules.list.key() });
  const toggle = useMutation({
    mutationFn: () =>
      client.social.reportSchedules.save({
        scheduleId: s.id,
        name: s.name,
        cadence: s.cadence,
        weekday: s.weekday,
        monthDay: s.monthDay,
        sendHour: s.sendHour,
        timeZone: s.timeZone,
        period: s.period,
        connectionIds: s.connectionIds,
        recipients: s.recipients,
        paused: !s.paused,
      }),
    onSuccess: refresh,
  });
  const test = useMutation({ mutationFn: () => client.social.reportSchedules.test({ scheduleId: s.id }), onSuccess: refresh });
  const remove = useMutation({ mutationFn: () => client.social.reportSchedules.remove({ scheduleId: s.id }), onSuccess: refresh });
  const when = s.cadence === 'weekly' ? t('everyWeek', { day: t(`weekdays.${(s.weekday ?? 1) as (typeof WEEKDAYS)[number]}`), hour: String(s.sendHour).padStart(2, '0') }) : t('everyMonth', { day: String(s.monthDay ?? 1), hour: String(s.sendHour).padStart(2, '0') });
  const busy = toggle.isPending || test.isPending || remove.isPending;
  const error = toggle.error ?? test.error ?? remove.error;
  return (
    <li className="space-y-2 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-foreground">{s.name}</span>
          <span className="block text-xs text-subtle-foreground">
            {when} · {t(`periods.${s.period}`)} · {s.connectionIds.length === 0 ? t('allChannels') : s.connectionIds.map((id) => names.get(id) ?? t('goneChannel')).join(', ')}
          </span>
          <span className="block text-xs text-subtle-foreground">{t('to', { list: s.recipients.join(', ') })}</span>
        </span>
        {s.paused ? <Badge variant="outline">{t('paused')}</Badge> : <Badge variant="secondary">{t('next', { at: f.dateTime(s.nextRunAt) })}</Badge>}
        <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" disabled={busy} onClick={() => test.mutate()}>
          {t('test')}
        </Button>
        <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" disabled={busy} onClick={() => toggle.mutate()}>
          {s.paused ? t('resume') : t('pause')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-xs"
          disabled={busy}
          onClick={() => {
            if (window.confirm(t('removeConfirm'))) remove.mutate();
          }}
        >
          {t('remove')}
        </Button>
      </div>
      {test.data && <p className="text-xs text-muted-foreground">{test.data.suppressed > 0 ? t('testSuppressed') : t('testQueued')}</p>}
      {error && <ErrorText>{errorMessage(error)}</ErrorText>}
      {s.runs.length > 0 && (
        <ul className="space-y-1 text-xs">
          {s.runs.map((r) => (
            <li key={r.id} className="flex flex-wrap items-baseline gap-x-2 text-subtle-foreground">
              <span className="text-muted-foreground">
                {f.dateTime(r.createdAt)}
                {r.kind === 'test' ? ` · ${t('testRun')}` : ''}
              </span>
              <span>{t('runPeriod', { from: f.date(r.periodStart), to: f.date(new Date(Date.parse(r.periodEnd) - 1).toISOString()) })}</span>
              {r.mails.map((m, i) => (
                <span key={i} className={DELIVERED.has(m.status) ? 'text-success' : FAILED.has(m.status) ? 'text-destructive' : ''}>
                  {m.to ?? t('erased')}: {t(`status.${m.status in STATUS ? (m.status as keyof typeof STATUS) : 'other'}`)}
                  {m.errorCode === 'MAIL_OFF' ? ` (${t('mailOff')})` : ''}
                </span>
              ))}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

const STATUS = { queued: 1, sending: 1, sent: 1, delivered: 1, bounced: 1, complained: 1, suppressed: 1, failed: 1, ambiguous: 1 } as const;

export function ReportSchedules({ channels }: { channels: readonly { id: string; displayName: string; provider: string }[] }) {
  const t = useTranslations('social.reportSchedules');
  const { slug } = useParams({ strict: false }) as { slug: string };
  const me = useQuery(orpc.me.get.queryOptions());
  const role = me.data?.orgs.find((o) => o.slug === slug)?.role;
  const canManage = role === 'owner' || role === 'admin';
  const list = useQuery({ ...orpc.social.reportSchedules.list.queryOptions({ input: {} }), enabled: canManage });
  const [adding, setAdding] = useState(false);
  if (!canManage) return null;
  const schedules = list.data ?? [];
  const names = new Map(channels.map((c) => [c.id, c.displayName]));
  return (
    <Card className="block space-y-3 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-medium text-foreground">{t('title')}</h3>
          <p className="text-xs text-subtle-foreground">{t('hint')}</p>
        </div>
        {schedules.length < 5 && (
          <Button size="sm" variant="outline" onClick={() => setAdding(!adding)}>
            {adding ? t('cancel') : t('add')}
          </Button>
        )}
      </div>
      {adding && (
        <Form
          channels={channels}
          onDone={() => {
            setAdding(false);
            void queryClient.invalidateQueries({ queryKey: orpc.social.reportSchedules.list.key() });
          }}
        />
      )}
      {list.error && <ErrorText>{errorMessage(list.error)}</ErrorText>}
      {schedules.length > 0 ? (
        <ul className="divide-y rounded-lg border">
          {schedules.map((s) => (
            <Item key={s.id} s={s} names={names} />
          ))}
        </ul>
      ) : (
        !adding && <p className="text-xs text-subtle-foreground">{t('empty')}</p>
      )}
    </Card>
  );
}
