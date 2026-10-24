// Period lock (#329) on the ledger screen: what is locked and who changed it last; owners and admins lock the next
// month once it has ended (the first lock may name any month that has); owners and chief accountants (#1279) unlock
// the last locked month with a reason and a fresh second factor (R3).
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { vietnamMonth } from '@crove/kernel-contract';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Input } from '@crove/ui/components/input';
import { useFormat } from '../i18n/provider.tsx';
import { errorMessage, isStepUpRequired, orpc, queryClient } from '../lib/api.ts';
import { canLockPeriods, canUnlockPeriods, monthLabel, previousMonth } from '../lib/period-lock.ts';
import { StepUpPrompt } from './two-factor.tsx';
import { ErrorText } from './ui.tsx';

export function PeriodLockPanel() {
  const t = useTranslations('periodLock');
  const f = useFormat();
  const org = useQuery(orpc.org.get.queryOptions());
  const state = useQuery(orpc.periodLock.state.queryOptions());
  const [picked, setPicked] = useState(() => previousMonth(vietnamMonth()));
  const [unlocking, setUnlocking] = useState(false);
  const [reason, setReason] = useState('');
  // One key per action: a retry after the step-up is the same request; a new one follows each success.
  const [lockKey, setLockKey] = useState(() => crypto.randomUUID());
  const [unlockKey, setUnlockKey] = useState(() => crypto.randomUUID());
  // Every screen that posts or shows postings may read the lock, so all queries are refreshed.
  const lock = useMutation(
    orpc.periodLock.lock.mutationOptions({
      onSuccess: () => {
        setLockKey(crypto.randomUUID());
        void queryClient.invalidateQueries();
      },
    }),
  );
  const unlock = useMutation(
    orpc.periodLock.unlock.mutationOptions({
      onSuccess: () => {
        setUnlockKey(crypto.randomUUID());
        setUnlocking(false);
        setReason('');
        void queryClient.invalidateQueries();
      },
    }),
  );

  const data = state.data;
  if (state.error) return <ErrorText>{errorMessage(state.error)}</ErrorText>;
  if (!data) return null;
  const canLock = canLockPeriods(org.data?.role);
  const canUnlock = canUnlockPeriods(org.data?.role, org.data?.permissions);
  // The month a lock names: the one after the last locked month, or the one picked while nothing is locked.
  const next = data.nextMonth ?? picked;
  const ended = /^\d{4}-\d{2}$/.test(next) && next < vietnamMonth();
  const last = data.lastMonth;
  const stepUp = isStepUpRequired(unlock.error);

  return (
    <Card className="mb-4 block space-y-3 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold text-foreground">{t('title')}</h2>
          <p className="text-sm text-muted-foreground">{data.lockedThrough ? t('locked', { through: f.date(data.lockedThrough) }) : t('none')}</p>
          {data.updatedAt && (
            <p className="text-xs text-subtle-foreground">
              {data.updatedBy ? t('lastChange', { who: data.updatedBy, when: f.dateTime(data.updatedAt) }) : t('lastChangeUnknown', { when: f.dateTime(data.updatedAt) })}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-end gap-2">
          {canLock && !data.nextMonth && (
            <label className="text-xs">
              <span className="text-subtle-foreground">{t('month')}</span>
              <Input
                type="month"
                aria-label={t('month')}
                className="mt-1 w-44"
                value={picked}
                max={previousMonth(vietnamMonth())}
                onChange={(e) => {
                  setPicked(e.target.value);
                  lock.reset();
                }}
              />
            </label>
          )}
          {canLock && (
            <Button variant="outline" disabled={lock.isPending || !ended} onClick={() => lock.mutate({ month: next, idempotencyKey: lockKey })}>
              {t('lock', { month: monthLabel(next) })}
            </Button>
          )}
          {canUnlock && last && !unlocking && (
            <Button variant="ghost" onClick={() => setUnlocking(true)}>
              {t('unlock', { month: monthLabel(last) })}
            </Button>
          )}
        </div>
      </div>
      {canLock && !ended && /^\d{4}-\d{2}$/.test(next) && <p className="text-xs text-subtle-foreground">{t('notEnded', { month: monthLabel(next) })}</p>}
      {lock.error && <ErrorText>{errorMessage(lock.error)}</ErrorText>}
      {unlocking && last && (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            unlock.mutate({ month: last, reason, idempotencyKey: unlockKey });
          }}>
          <label className="min-w-64 grow text-xs">
            <span className="text-subtle-foreground">{t('reason')}</span>
            <Input aria-label={t('reason')} className="mt-1" value={reason} maxLength={500} placeholder={t('reasonPlaceholder')} onChange={(e) => setReason(e.target.value)} />
          </label>
          <Button type="submit" variant="destructive" disabled={unlock.isPending || reason.trim() === ''}>
            {t('confirmUnlock', { month: monthLabel(last) })}
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setUnlocking(false);
              unlock.reset();
            }}>
            {t('cancel')}
          </Button>
        </form>
      )}
      {stepUp && last && (
        <StepUpPrompt action={t('stepUp', { month: monthLabel(last) })} onVerified={() => unlock.variables && unlock.mutate(unlock.variables)} onCancel={() => unlock.reset()} />
      )}
      {unlock.error && !stepUp && <ErrorText>{errorMessage(unlock.error)}</ErrorText>}
    </Card>
  );
}
