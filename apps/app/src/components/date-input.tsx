// A date or month field that reads dd/mm/yyyy and mm/yyyy whatever the browser's language (#1304). The value in and out
// is ISO, like the native inputs it replaces. Typing a whole, real date sets it at once; a half-typed one marks the field
// invalid and, on leaving it, puts the last value back. A whole date before min or after max marks it invalid too, with
// the bound as dd/mm/yyyy (#1432). The button opens the browser's own picker on a hidden native input, which keeps min
// and max for the picker but belongs to no form, so a submit never stops on that hidden field.
import { useEffect, useRef, useState, type ComponentProps } from 'react';
import { useTranslations } from 'use-intl';
import { CalendarIcon } from '@crove/ui/components/calendar-icon';
import { Input } from '@crove/ui/components/input';
import { cn } from '@crove/ui/lib/utils';
import { dateFieldError, formatDateValue, parseDateText, typedValue, type DateKind } from '../lib/date-input.ts';

// The form attribute of the hidden pickers: an id no element has, so they belong to no form.
export const NO_FORM = 'crove-picker-without-form';

type Passed = Pick<ComponentProps<'input'>, 'id' | 'required' | 'disabled' | 'readOnly' | 'autoFocus' | 'min' | 'max' | 'aria-label' | 'aria-labelledby' | 'aria-describedby' | 'aria-invalid'>;

export function DateInput({
  kind = 'day',
  value,
  onChange,
  className,
  inputClassName,
  min,
  max,
  'aria-invalid': invalid,
  ...props
}: Passed & { kind?: DateKind; value: string; onChange: (value: string) => void; className?: string; inputClassName?: string }) {
  const t = useTranslations('common');
  const [text, setText] = useState(() => formatDateValue(value, kind));
  const picker = useRef<HTMLInputElement>(null);
  const field = useRef<HTMLInputElement>(null);
  // A value set from outside (a reset, a prefill, the picker) shows as typed text, unless the text already says it.
  useEffect(() => {
    setText((current) => (parseDateText(current, kind) === value ? current : formatDateValue(value, kind)));
  }, [value, kind]);
  const lo = min === undefined || min === '' ? undefined : String(min);
  const hi = max === undefined || max === '' ? undefined : String(max);
  const error = dateFieldError(text, kind, lo, hi);
  const partial = error === 'partial';
  // A half-typed, impossible or out-of-range date blocks the form's submit, which would otherwise send the last valid
  // value (or one the server refuses), and the browser says why on this field.
  const message =
    error === 'partial'
      ? t(kind === 'day' ? 'invalidDate' : 'invalidMonth')
      : error === 'early'
        ? t('dateTooEarly', { min: formatDateValue(lo ?? '', kind) })
        : error === 'late'
          ? t('dateTooLate', { max: formatDateValue(hi ?? '', kind) })
          : '';
  useEffect(() => {
    field.current?.setCustomValidity(message);
  }, [message]);
  const locked = props.disabled || props.readOnly;

  return (
    // A block, as the native input was: a label's text sits above it, never beside it.
    <span className={cn('relative flex', className)}>
      <Input
        {...props}
        ref={field}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        placeholder={kind === 'day' ? t('datePlaceholder') : t('monthPlaceholder')}
        // Invalid when its own text is, or when the form's check says so (an error the form shows under it).
        aria-invalid={error !== null || invalid === true || invalid === 'true' || undefined}
        className={cn('w-full pr-9 tabular-nums', inputClassName)}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          const next = typedValue(e.target.value, (s) => parseDateText(s, kind));
          if (next !== null) onChange(next);
        }}
        onBlur={() => {
          if (partial) setText(formatDateValue(value, kind));
        }}
      />
      {/* The browser's picker, laid over the button so its popover opens there: never focused or read on its own. */}
      <input
        ref={picker}
        type={kind === 'day' ? 'date' : 'month'}
        tabIndex={-1}
        aria-hidden="true"
        // No form owns it (no element has this id): its min and max limit the picker, never a submit.
        form={NO_FORM}
        className="pointer-events-none absolute inset-y-0 right-0 w-9 opacity-0"
        value={value}
        {...(min !== undefined ? { min } : {})}
        {...(max !== undefined ? { max } : {})}
        onChange={(e) => onChange(e.target.value)}
      />
      {!locked && (
        <button
          type="button"
          className="absolute inset-y-0 right-0 grid w-9 place-items-center rounded-r-lg text-muted-foreground hover:text-foreground"
          // Its name shares no word with a field's label, so a lookup by that label finds the field alone.
          aria-label={t('openCalendar')}
          onClick={() => {
            try {
              picker.current?.showPicker();
            } catch {
              // A browser without showPicker leaves the typed field, which always works.
            }
          }}
        >
          <CalendarIcon />
        </button>
      )}
    </span>
  );
}
