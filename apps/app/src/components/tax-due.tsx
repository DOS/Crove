// How a tax due date and its period read (issues #318, #921): on the multi-client home screen and on an org's
// overview (#1249).
import { useTranslations } from 'use-intl';
import { cn } from '@crove/ui/lib/utils';
import { useFormat } from '../i18n/provider.tsx';
import { deadlineTone } from '../lib/clients.ts';
import { taxPeriodParts } from '../lib/tax-calendar.ts';

export const TONE_CLASS = { urgent: 'text-destructive', soon: 'text-warning', later: 'text-foreground' } as const;

// "Tháng 9/2026", "Quý 3/2026" or "Năm 2026".
export function usePeriodLabel() {
  const t = useTranslations('clients');
  const tt = useTranslations('taxCalendar');
  return (period: string) => {
    const parts = taxPeriodParts(period);
    if (!parts) return period;
    if (parts.kind === 'year') return tt('periodYear', { year: String(parts.year) });
    return parts.kind === 'month'
      ? t('periodMonth', { month: String(parts.index), year: String(parts.year) })
      : t('periodQuarter', { quarter: String(parts.index), year: String(parts.year) });
  };
}

export function DueWhen({ due }: { due: { dueDate: string; daysLeft: number } }) {
  const tt = useTranslations('taxCalendar');
  const f = useFormat();
  const tone = due.daysLeft < 0 ? 'text-destructive' : TONE_CLASS[deadlineTone(due.daysLeft)];
  return (
    <span className="block">
      <span className={cn('font-medium tabular-nums', tone)}>{f.date(due.dueDate)}</span>
      <span className="block text-xs text-subtle-foreground">{due.daysLeft < 0 ? tt('overdue', { days: -due.daysLeft }) : tt('daysLeft', { days: due.daysLeft })}</span>
    </span>
  );
}
