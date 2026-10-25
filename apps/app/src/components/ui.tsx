// App-level building blocks composed from the @crove/ui design system. Screens import primitives (Button, Input,
// Card, Badge, ...) from @crove/ui directly and these composites from here.
import { Alert } from '@crove/ui/components/alert';
import { Empty as EmptyRoot, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from '@crove/ui/components/empty';
import { Label } from '@crove/ui/components/label';
import { Skeleton } from '@crove/ui/components/skeleton';
import { Spinner as SpinnerIcon } from '@crove/ui/components/spinner';
import { Table, TableBody, TableHead, TableHeader, TableRow } from '@crove/ui/components/table';
import { cn } from '@crove/ui/lib/utils';
import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { useTranslations } from 'use-intl';
import { brandName } from '../i18n/brand.ts';
import { takeOrgLeftNotice } from '../lib/api.ts';

// titleId: the title can take the focus by this id (a page that moves the focus there when it opens, #1230).
export function PageHeader({ title, subtitle, actions, titleId }: { title: string; subtitle?: string | undefined; actions?: ReactNode; titleId?: string }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 id={titleId} tabIndex={titleId ? -1 : undefined} className="text-xl font-semibold tracking-tight text-foreground outline-none">
          {title}
        </h1>
        {subtitle && <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function Empty({ title, hint, action }: { title: string; hint?: string | undefined; action?: ReactNode }) {
  return (
    <EmptyRoot className="border border-dashed px-6 py-12">
      <EmptyHeader>
        <EmptyTitle className="text-foreground">{title}</EmptyTitle>
        {hint && <EmptyDescription className="text-subtle-foreground">{hint}</EmptyDescription>}
      </EmptyHeader>
      {action && <EmptyContent>{action}</EmptyContent>}
    </EmptyRoot>
  );
}

// `id`: a field whose problem this text explains names it in its aria-describedby.
export function ErrorText({ id, children }: { id?: string | undefined; children: ReactNode }) {
  return (
    <Alert id={id} variant="destructive" className="border-destructive/30 bg-destructive/10">
      {children}
    </Alert>
  );
}

// A form field's error sits under it and is linked to it (DESIGN.md §4.2, #1515): the control has an id, aria-invalid
// while it shows an error, and aria-describedby naming its hint and its error, so a screen reader reads them with it.
export interface FieldControl {
  id: string;
  'aria-invalid': true | undefined;
  'aria-describedby': string | undefined;
}

export const fieldHintId = (id: string) => `${id}-hint`;
export const fieldErrorId = (id: string) => `${id}-error`;

// The attributes of a control whose hint and error are rendered with the ids above.
export function fieldControl(id: string, { hint = false, error = false }: { hint?: boolean; error?: boolean } = {}): FieldControl {
  const describedBy = [hint && fieldHintId(id), error && fieldErrorId(id)].filter(Boolean).join(' ');
  return { id, 'aria-invalid': error || undefined, 'aria-describedby': describedBy || undefined };
}

// The error under a field whose layout is its own; nothing while the field is valid.
export function FieldError({ id, className, children }: { id: string; className?: string; children?: ReactNode }) {
  if (!children) return null;
  return (
    <p id={fieldErrorId(id)} className={cn('text-xs text-destructive', className)}>
      {children}
    </p>
  );
}

// A label above its control, then the hint and the error under it. The control is rendered by `children` with the
// attributes that link it to them; `label` may be left out when the control is named by aria-label.
export function Field({
  id: given,
  label,
  hint,
  error,
  className,
  children,
}: {
  id?: string;
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  className?: string;
  children: (control: FieldControl) => ReactNode;
}) {
  const generated = useId();
  const id = given ?? generated;
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      {label != null && (
        <Label htmlFor={id} className="font-normal text-muted-foreground">
          {label}
        </Label>
      )}
      {children(fieldControl(id, { hint: Boolean(hint), error: Boolean(error) }))}
      {hint && (
        <p id={fieldHintId(id)} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      <FieldError id={id}>{error}</FieldError>
    </div>
  );
}

const FOCUSABLE = ':is(input:not([type="hidden"]), select, textarea, button, [tabindex]):not([tabindex="-1"], :disabled)';

// On a refused submit: the focus goes to the first field marked invalid, or into it when it is a group (a fieldset of
// checkboxes), so the user lands on the problem and hears its error. False when no field is marked.
export function focusFirstInvalid(form: ParentNode | null | undefined): boolean {
  const first = form?.querySelector<HTMLElement>('[aria-invalid="true"]');
  const target = first?.matches(FOCUSABLE) ? first : first?.querySelector<HTMLElement>(FOCUSABLE);
  target?.focus();
  return Boolean(target);
}

// Roughly what a browser's type="email" field accepts (the HTML standard's pattern), for forms that word their own errors.
const EMAIL = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
export const isEmailAddress = (value: string) => EMAIL.test(value.trim());

// The errors a form shows under its fields (DESIGN.md §4.2: on blur and on submit, not on every keystroke). `check`
// words the problem of a field's current value, or returns null. Leaving a field with something in it checks it (an
// empty required field waits for the submit); editing a field hides its error until it is checked again; checkAll, on
// submit, checks the fields given and shows their errors at once, so focusFirstInvalid finds them right after.
export function useFieldErrors<K extends string>(check: (field: K) => string | null) {
  const [errors, setErrors] = useState<Partial<Record<K, string | null>>>({});
  const show = (field: K, error: string | null) => setErrors((current) => ({ ...current, [field]: error }));
  return {
    of: (field: K): string | undefined => errors[field] ?? undefined,
    check: (field: K): boolean => {
      const error = check(field);
      show(field, error);
      return error === null;
    },
    blur: (field: K, value: string) => {
      if (value.trim()) show(field, check(field));
    },
    edit: (field: K) => {
      if (errors[field]) show(field, null);
    },
    reset: () => setErrors({}),
    checkAll: (fields: readonly K[]): boolean => {
      const next: Partial<Record<K, string | null>> = {};
      for (const field of fields) next[field] = check(field);
      flushSync(() => setErrors(next));
      return fields.every((field) => !next[field]);
    },
  };
}

// Read from storage once per page load, so a second render (or React StrictMode's double initializer) still sees it.
let orgLeftNotice: ReturnType<typeof takeOrgLeftNotice> | undefined;
function orgLeftOnce() {
  if (orgLeftNotice === undefined) orgLeftNotice = takeOrgLeftNotice();
  return orgLeftNotice;
}

// Shown once after this tab left an org whose owner revoked this session there (issue #247).
export function OrgLeftNotice() {
  const t = useTranslations('common');
  const [left, setLeft] = useState(orgLeftOnce);
  if (!left) return null;
  return (
    <Alert role="status" className="mb-4 flex items-start justify-between gap-3">
      <span>{t('orgLeft', { org: left.name })}</span>
      <button type="button" className="shrink-0 text-subtle-foreground hover:text-muted-foreground" onClick={() => {
          orgLeftNotice = null;
          setLeft(null);
        }}>
        {t('close')}
      </button>
    </Alert>
  );
}

// Something that worked and the user should read (an email link confirmed, a setting saved); a status, not an alert.
export function Notice({ children }: { children: ReactNode }) {
  return (
    <Alert role="status" className="border-success/30 bg-success/10 text-success">
      {children}
    </Alert>
  );
}

export function Spinner({ className }: { className?: string }) {
  const t = useTranslations('common');
  return <SpinnerIcon className={cn('text-ring', className)} aria-label={t('loading')} />;
}

// While a table loads (DESIGN.md §4.3 and §5.3, #1379): the table's card, its header strip and rows of its own height,
// so the page does not jump when the rows arrive. The region says it is busy; the bars say nothing to screen readers.
export function TableSkeleton({ columns = 4, rows = 5 }: { columns?: number; rows?: number }) {
  const t = useTranslations('common');
  const cells = Array.from({ length: columns }, (_, i) => i);
  return (
    <div aria-busy="true" className="overflow-hidden rounded-xl border bg-card">
      <span className="sr-only">{t('loading')}</span>
      <div className="flex h-10 items-center gap-6 bg-muted px-4">
        {cells.map((i) => (
          <Skeleton key={i} className="h-3 flex-1 bg-background/70" />
        ))}
      </div>
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="flex h-12 items-center gap-6 border-t px-4">
          {cells.map((i) => (
            // The first column holds a name, the others shorter values: the bars follow that shape.
            <Skeleton key={i} className={cn('h-3.5', i === 0 ? 'flex-[2]' : 'flex-1')} />
          ))}
        </div>
      ))}
    </div>
  );
}

// While a list of cards loads (journal entries, tasks, notifications): cards of the list's height, as above.
export function ListSkeleton({ rows = 3 }: { rows?: number }) {
  const t = useTranslations('common');
  return (
    <div aria-busy="true" className="space-y-3">
      <span className="sr-only">{t('loading')}</span>
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="space-y-2.5 rounded-xl border bg-card p-4">
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-3 w-2/3" />
          <Skeleton className="h-3 w-1/2" />
        </div>
      ))}
    </div>
  );
}

// A table with one header row; the body rows are TableRow/TableCell from @crove/ui. `numeric` lists the columns that
// hold amounts: their headers are right-aligned like the amounts (DESIGN.md 4.3).
// A list's table (DESIGN.md §4.3). Its header stays in view (#1444): a table taller than the window scrolls inside its
// card, under a pinned header, and only then becomes a tab stop, so the keyboard can scroll it too.
export function DataTable({ head, numeric = [], children }: { head: string[]; numeric?: number[]; children: ReactNode }) {
  const scroller = useRef<HTMLDivElement>(null);
  const [scrolls, setScrolls] = useState(false);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => setScrolls(el.scrollHeight > el.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    return () => observer.disconnect();
  }, []);
  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      <Table
        className="min-w-[640px] [&_td]:whitespace-normal"
        container={{ ref: scroller, className: 'max-h-[max(24rem,calc(100dvh-10rem))] overflow-y-auto', tabIndex: scrolls ? 0 : undefined }}
      >
        {/* The rule under the header is a shadow: a collapsed border does not move with a sticky row. */}
        <TableHeader className="sticky top-0 z-10 bg-muted [&_th]:bg-muted [&_th]:shadow-[inset_0_-1px_0_var(--color-border)] [&_tr]:border-b-0">
          <TableRow className="hover:bg-transparent">
            {head.map((h, i) => (
              <TableHead key={i} className={cn('px-4 text-xs font-medium text-subtle-foreground', numeric.includes(i) && 'text-right')}>
                {h}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>{children}</TableBody>
      </Table>
    </div>
  );
}

export function Logo() {
  return (
    <span className="inline-flex items-center gap-2 font-semibold tracking-tight text-foreground">
      {/* The Crove mark (a ring C with two sparkles), the same as on the marketing site. */}
      <svg viewBox="0 0 144 144" className="h-7 w-7 fill-primary" aria-hidden="true">
        <path d="M141.5 33.7c-4-1.1-7.5-2.4-11.1-3.2-6-1.3-9.4-4.8-10.7-10.7-0.8-3.4-1.9-6.7-2.9-10.1 0-0.2-0.2-0.3-0.3-0.7-1.2 4.1-2.4 8-3.6 11.9-0.3 1-0.7 2.1-1.1 3.1-0.9 2.3-2.5 4.1-4.9 4.9-4.3 1.4-8.7 2.7-13.1 4.1-0.6 0.2-1.3 0.4-2.3 0.7 3.7 1.1 7 2 10.4 3 1.5 0.4 3 0.9 4.4 1.4 2.9 1 4.8 2.9 5.8 5.8 1.5 4.7 2.9 9.4 4.4 14.2 0.1-0.3 0.3-0.6 0.4-0.9 1.3-4.3 2.6-8.6 3.9-12.9 1-3.4 3.3-5.6 6.7-6.6 4.3-1.1 8.8-2.5 13.8-4z" />
        <path d="M98.1 4c-0.7 2.2-1.3 4-1.7 5.8-0.6 2.3-2 3.6-4.2 4.1-1.8 0.5-3.7 1.1-5.9 1.7 2.3 0.7 4.2 1.3 6.2 1.8 2.1 0.6 3.3 1.8 3.9 3.9 0.5 1.9 1.1 3.7 1.8 5.9 0.6-2.1 1.2-3.7 1.6-5.4 0.6-2.4 2-4 4.5-4.6 1.8-0.4 3.5-1 5.7-1.6-1.2-0.4-2-0.6-2.8-0.9-6.6-1.9-6.2-1.6-8.1-7.9C98.7 6.1 98.4 5.3 98.1 4z" />
        <path d="M56.4 33.7C26.9 33.7 3 57.6 3 87.2c0 23 14.7 43.4 36.6 50.7 2.7 0.5 3.7-1.1 3.7-2.5 0-0.8 0.1-8.4 0.1-15.5 0-4.4 0.8-7 2.8-8.6-10.3-4.1-17.6-14.2-17.6-25.9 0-15.4 12.5-27.9 27.9-27.9 15.4 0 27.9 12.5 27.9 27.9 0 11.8-7.3 21.8-17.6 25.9 1.4 1.3 3.3 3.3 3.1 9.4-0.3 7.1-0.1 12.9-0.1 14.7 0 1.4 1 3.1 3.7 2.5 21.8-7.3 36.4-27.8 36.4-50.7C109.9 57.6 86 33.7 56.4 33.7z" />
      </svg>
      {brandName()}
    </span>
  );
}
