// A time-of-day field that reads 24-hour HH:mm whatever the browser's language (#1432), where a native time input shows
// AM/PM with Chrome in English. The value in and out is HH:mm, like the native input it replaces. It works as DateInput
// does: a whole time sets it at once, a half-typed one marks the field invalid and, on leaving it, puts the last value
// back, and the button opens the browser's own picker on a hidden native input.
import { useEffect, useRef, useState, type ComponentProps } from 'react';
import { useTranslations } from 'use-intl';
import { ClockIcon } from '@crove/ui/components/clock-icon';
import { Input } from '@crove/ui/components/input';
import { cn } from '@crove/ui/lib/utils';
import { formatTimeValue, parseTimeText } from '../lib/date-input.ts';

type Passed = Pick<ComponentProps<'input'>, 'id' | 'required' | 'disabled' | 'readOnly' | 'autoFocus' | 'aria-label' | 'aria-labelledby' | 'aria-describedby'>;

export function TimeInput({
  value,
  onChange,
  className,
  inputClassName,
  ...props
}: Passed & { value: string; onChange: (value: string) => void; className?: string; inputClassName?: string }) {
  const t = useTranslations('common');
  const [text, setText] = useState(() => formatTimeValue(value));
  const picker = useRef<HTMLInputElement>(null);
  const field = useRef<HTMLInputElement>(null);
  // A value set from outside (a reset, a best time, the picker) shows as typed text, unless the text already says it.
  useEffect(() => {
    setText((current) => (parseTimeText(current) === formatTimeValue(value) ? current : formatTimeValue(value)));
  }, [value]);
  const partial = text.trim() !== '' && parseTimeText(text) === null;
  // A half-typed or impossible time blocks the form's submit, which would otherwise send the last valid value.
  useEffect(() => {
    field.current?.setCustomValidity(partial ? t('invalidTime') : '');
  }, [partial, t]);
  const locked = props.disabled || props.readOnly;

  return (
    <span className={cn('relative flex', className)}>
      <Input
        {...props}
        ref={field}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        placeholder={t('timePlaceholder')}
        aria-invalid={partial || undefined}
        className={cn('w-full pr-9 tabular-nums', inputClassName)}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          const time = parseTimeText(e.target.value);
          if (time !== null) onChange(time);
          else if (e.target.value.trim() === '') onChange('');
        }}
        onBlur={() => {
          if (partial) setText(formatTimeValue(value));
        }}
      />
      {/* The browser's picker, laid over the button so its popover opens there: never focused or read on its own. */}
      <input
        ref={picker}
        type="time"
        step={60}
        tabIndex={-1}
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 right-0 w-9 opacity-0"
        value={formatTimeValue(value)}
        onChange={(e) => {
          const time = parseTimeText(e.target.value);
          onChange(time ?? '');
        }}
      />
      {!locked && (
        <button
          type="button"
          className="absolute inset-y-0 right-0 grid w-9 place-items-center rounded-r-lg text-muted-foreground hover:text-foreground"
          // Its name shares no word with a field's label ("Giờ", "Time"), so a lookup by that label finds the field alone.
          aria-label={t('openClock')}
          onClick={() => {
            try {
              picker.current?.showPicker();
            } catch {
              // A browser without showPicker leaves the typed field, which always works.
            }
          }}
        >
          <ClockIcon />
        </button>
      )}
    </span>
  );
}
