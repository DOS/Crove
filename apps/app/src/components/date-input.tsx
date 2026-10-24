// A date or month field that reads dd/mm/yyyy and mm/yyyy whatever the browser's language (#1304). The value in and out
// is ISO, like the native inputs it replaces. Typing a whole, real date sets it at once; a half-typed one marks the field
// invalid and, on leaving it, puts the last value back. The button opens the browser's own picker on a hidden native
// input, which keeps min and max.
import { useEffect, useRef, useState, type ComponentProps } from 'react';
import { useTranslations } from 'use-intl';
import { CalendarIcon } from '@crove/ui/components/calendar-icon';
import { Input } from '@crove/ui/components/input';
import { cn } from '@crove/ui/lib/utils';
import { formatDateValue, parseDateText, type DateKind } from '../lib/date-input.ts';

type Passed = Pick<ComponentProps<'input'>, 'id' | 'required' | 'disabled' | 'readOnly' | 'min' | 'max' | 'aria-label'>;

export function DateInput({
  kind = 'day',
  value,
  onChange,
  className,
  min,
  max,
  ...props
}: Passed & { kind?: DateKind; value: string; onChange: (value: string) => void; className?: string }) {
  const t = useTranslations('common');
  const [text, setText] = useState(() => formatDateValue(value, kind));
  const picker = useRef<HTMLInputElement>(null);
  const field = useRef<HTMLInputElement>(null);
  // A value set from outside (a reset, a prefill, the picker) shows as typed text, unless the text already says it.
  useEffect(() => {
    setText((current) => (parseDateText(current, kind) === value ? current : formatDateValue(value, kind)));
  }, [value, kind]);
  const partial = text.trim() !== '' && parseDateText(text, kind) === null;
  // A half-typed or impossible date blocks the form's submit, which would otherwise send the last valid value.
  useEffect(() => {
    field.current?.setCustomValidity(partial ? (kind === 'day' ? t('invalidDate') : t('invalidMonth')) : '');
  }, [partial, kind, t]);
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
        aria-invalid={partial || undefined}
        className="w-full pr-9 tabular-nums"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          const iso = parseDateText(e.target.value, kind);
          if (iso !== null) onChange(iso);
          else if (e.target.value.trim() === '') onChange('');
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
