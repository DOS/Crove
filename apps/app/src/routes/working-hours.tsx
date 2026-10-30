// The member's working hours and days off in Settings (issue #1313). Each member sets their own: the hours a booking
// page of theirs offers (crm, #1318), in their time zone, and the days they are off. Vietnamese public holidays are
// off without being listed. A viewer sees their hours and changes nothing. The server enforces every rule. Dates read
// dd/mm/yyyy and times 24-hour HH:mm whatever the browser's language (DESIGN.md §5.5, #1428).
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import { CALENDAR_RANGE_MAX_DAYS, type MyCalendar, type Weekday } from '@crove/kernel-contract';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Checkbox } from '@crove/ui/components/checkbox';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { DateInput } from '../components/date-input.tsx';
import { TimeInput } from '../components/time-input.tsx';
import { ErrorText, RowsSkeleton, Spinner } from '../components/ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';
import { WEEKDAY_KEYS, dayOffRange, daysOf, datesOf, hoursOf, timeZones, type DayHours } from '../lib/calendar.ts';

const refresh = () => queryClient.invalidateQueries({ queryKey: orpc.calendar.get.key() });

function HoursForm({ calendar, canEdit }: { calendar: MyCalendar; canEdit: boolean }) {
  const t = useTranslations('workingHours');
  const [timeZone, setTimeZone] = useState(calendar.hours.timeZone);
  const [days, setDays] = useState<DayHours[]>(() => daysOf(calendar.hours));
  const [invalid, setInvalid] = useState<Weekday | null>(null);
  const save = useMutation(orpc.calendar.saveHours.mutationOptions({ onSuccess: refresh }));
  const set = (i: number, patch: Partial<DayHours>) => setDays((all) => all.map((d, k) => (k === i ? { ...d, ...patch } : d)));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const result = hoursOf(timeZone, days);
    if ('invalid' in result) {
      setInvalid(result.invalid);
      return;
    }
    setInvalid(null);
    save.mutate(result.hours);
  };
  return (
    <form className="mt-3 space-y-2" onSubmit={submit} aria-label={t('title')}>
      <NativeSelect className="w-full" value={timeZone} disabled={!canEdit} onChange={(e) => setTimeZone(e.target.value)} aria-label={t('timeZone')}>
        {timeZones(timeZone).map((z) => (
          <NativeSelectOption key={z} value={z}>
            {z}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      <ul className="space-y-1">
        {days.map((d, i) => (
          <li key={d.weekday} className="flex flex-wrap items-center gap-2 text-sm">
            <label className="flex w-28 items-center gap-2">
              <Checkbox checked={d.on} disabled={!canEdit} onCheckedChange={(on) => set(i, { on: on === true })} />
              {t(`weekdays.${WEEKDAY_KEYS[d.weekday]}`)}
            </label>
            {d.on ? (
              <>
                <TimeInput className="w-28" value={d.start} disabled={!canEdit} onChange={(start) => set(i, { start })} aria-label={t('startOf', { day: t(`weekdays.${WEEKDAY_KEYS[d.weekday]}`) })} />
                <span className="text-subtle-foreground">-</span>
                {/* Midnight at the end of the day is "24:00", which no time field shows: it reads 00:00, which hoursOf takes back. */}
                <TimeInput className="w-28" value={d.end === '24:00' ? '00:00' : d.end} disabled={!canEdit} onChange={(end) => set(i, { end })} aria-label={t('endOf', { day: t(`weekdays.${WEEKDAY_KEYS[d.weekday]}`) })} />
              </>
            ) : (
              <span className="text-subtle-foreground">{t('off')}</span>
            )}
          </li>
        ))}
      </ul>
      {invalid !== null && <ErrorText>{t('invalidDay', { day: t(`weekdays.${WEEKDAY_KEYS[invalid]}`) })}</ErrorText>}
      {canEdit && (
        <Button type="submit" variant="outline" size="sm" disabled={save.isPending || !days.some((d) => d.on)}>
          {save.isPending ? <Spinner className="text-current" /> : null}
          {t('save')}
        </Button>
      )}
      {!calendar.saved && <p className="text-xs text-subtle-foreground">{t('defaultHint')}</p>}
      {save.error && <ErrorText>{errorMessage(save.error)}</ErrorText>}
    </form>
  );
}

function DaysOff({ calendar, canEdit }: { calendar: MyCalendar; canEdit: boolean }) {
  const t = useTranslations('workingHours');
  const f = useFormat();
  const tz = calendar.hours.timeZone;
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const add = useMutation(
    orpc.calendar.addEvent.mutationOptions({
      onSuccess: async () => {
        setFrom('');
        setTo('');
        await refresh();
      },
    }),
  );
  const cancel = useMutation(orpc.calendar.cancelEvent.mutationOptions({ onSuccess: refresh }));
  const off = calendar.events.filter((e) => e.kind === 'time_off');
  const day = (date: string) => f.date(date);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    add.mutate({ ...dayOffRange(tz, from, to || from), timeZone: tz, kind: 'time_off', title: null });
  };
  return (
    <div className="mt-4">
      <p className="text-xs font-medium text-muted-foreground">{t('daysOff')}</p>
      <p className="mt-1 text-xs text-subtle-foreground">{t('holidaysHint')}</p>
      {off.length === 0 ? (
        <p className="mt-2 text-sm text-subtle-foreground">{t('noDaysOff')}</p>
      ) : (
        <ul className="mt-2 divide-y">
          {off.map((e) => {
            const range = datesOf(e.timeZone, e.startsAt, e.endsAt);
            const label = range.from === range.to ? day(range.from) : t('range', { from: day(range.from), to: day(range.to) });
            return (
              <li key={e.id} className="flex items-center justify-between gap-3 py-1.5 text-sm">
                <span>{label}</span>
                {canEdit && (
                  <Button type="button" variant="ghost" size="sm" disabled={cancel.isPending} onClick={() => cancel.mutate({ eventId: e.id })} aria-label={t('removeOf', { day: label })}>
                    {t('remove')}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {canEdit && (
        <form className="mt-2 flex flex-wrap items-center gap-2" onSubmit={submit} aria-label={t('addDayOff')}>
          <DateInput required className="w-44" value={from} onChange={setFrom} aria-label={t('from')} />
          <span className="text-subtle-foreground">-</span>
          <DateInput className="w-44" min={from || undefined} value={to} onChange={setTo} aria-label={t('to')} />
          <Button type="submit" variant="outline" size="sm" disabled={add.isPending || !from}>
            {add.isPending ? <Spinner className="text-current" /> : null}
            {t('addDayOff')}
          </Button>
        </form>
      )}
      {(add.error ?? cancel.error) && <ErrorText>{errorMessage(add.error ?? cancel.error)}</ErrorText>}
    </div>
  );
}

// Every member, for their own calendar; canEdit is false for a viewer.
export function WorkingHoursCard({ canEdit }: { canEdit: boolean }) {
  const t = useTranslations('workingHours');
  // The days off ahead: from now to the farthest a calendar read reaches.
  const [range] = useState(() => {
    const now = Date.now();
    return { from: new Date(now).toISOString(), to: new Date(now + (CALENDAR_RANGE_MAX_DAYS - 1) * 86_400_000).toISOString() };
  });
  const calendar = useQuery(orpc.calendar.get.queryOptions({ input: range }));
  return (
    <Card className="block p-4" aria-label={t('title')}>
      <p className="text-sm font-medium text-muted-foreground">{t('title')}</p>
      <p className="mt-2 text-sm text-muted-foreground">{t('intro')}</p>
      {calendar.isLoading ? (
        <RowsSkeleton />
      ) : calendar.error ? (
        <ErrorText>{errorMessage(calendar.error)}</ErrorText>
      ) : calendar.data ? (
        <>
          <HoursForm key={JSON.stringify(calendar.data.hours)} calendar={calendar.data} canEdit={canEdit} />
          <DaysOff calendar={calendar.data} canEdit={canEdit} />
        </>
      ) : null}
    </Card>
  );
}
