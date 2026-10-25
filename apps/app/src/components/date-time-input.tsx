// A date and time field (#1432): a DateInput (dd/mm/yyyy) and a TimeInput (24-hour HH:mm) side by side, in place of a
// native datetime-local input, which shows mm/dd/yyyy and AM/PM with Chrome in English. Its value in and out is the
// same datetime-local string (yyyy-mm-ddTHH:mm, local time) that toLocalInput builds and fromLocalInput reads in
// lib/social.ts, so the callers and what they send do not change. Like the native input, the value is "" while either
// half is missing; the half already typed stays in the field.
import { useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';
import { cn } from '@crove/ui/lib/utils';
import { DateInput } from './date-input.tsx';
import { TimeInput } from './time-input.tsx';
import { changeDateTime, splitDateTime, syncDateTime, type DateTimeParts } from '../lib/date-input.ts';

export function DateTimeInput({
  value,
  onChange,
  min,
  id,
  disabled,
  required,
  className,
  inputClassName,
  ...labels
}: {
  value: string;
  onChange: (value: string) => void;
  // A datetime-local string: the date picker starts from its day (a time before it on that day is the server's to refuse).
  min?: string | undefined;
  // The date half's id, for a Label's htmlFor; the time half is named by common.time.
  id?: string;
  disabled?: boolean;
  required?: boolean;
  className?: string;
  // The two fields' own classes (a height).
  inputClassName?: string;
  // The group's name.
  'aria-label'?: string;
  'aria-labelledby'?: string;
}) {
  const t = useTranslations('common');
  const [parts, setParts] = useState(() => splitDateTime(value));
  // A value set from outside (a best time, a reset) replaces both halves; "" while a half is missing keeps the other.
  useEffect(() => {
    setParts((current) => syncDateTime(current, value));
  }, [value]);
  const set = (change: Partial<DateTimeParts>) => {
    const next = changeDateTime(parts, change);
    setParts(next.parts);
    onChange(next.value);
  };
  const minDay = min ? splitDateTime(min).date : '';

  return (
    <span role="group" {...labels} className={cn('flex gap-1.5', className)}>
      <DateInput
        {...(id ? { id } : { 'aria-label': t('date') })}
        disabled={disabled}
        required={required}
        {...(minDay ? { min: minDay } : {})}
        className="w-40 shrink-0"
        {...(inputClassName ? { inputClassName } : {})}
        value={parts.date}
        onChange={(date) => set({ date })}
      />
      <TimeInput
        aria-label={t('time')}
        disabled={disabled}
        required={required}
        className="w-28 shrink-0"
        {...(inputClassName ? { inputClassName } : {})}
        value={parts.time}
        onChange={(time) => set({ time })}
      />
    </span>
  );
}
