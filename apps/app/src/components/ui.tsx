// App-level building blocks composed from the @crove/ui design system. Screens import primitives (Button, Input,
// Card, Badge, ...) from @crove/ui directly and these composites from here.
import { Alert } from '@crove/ui/components/alert';
import { Empty as EmptyRoot, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from '@crove/ui/components/empty';
import { Label } from '@crove/ui/components/label';
import { Skeleton } from '@crove/ui/components/skeleton';
import { Spinner as SpinnerIcon } from '@crove/ui/components/spinner';
import { Table, TableBody, TableFooter, TableHead, TableHeader, TableRow } from '@crove/ui/components/table';
import { cn } from '@crove/ui/lib/utils';
import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { useTranslations } from 'use-intl';
import { brandName } from '../i18n/brand.ts';
import { takeOrgLeftNotice } from '../lib/api.ts';
import { useScrollRoom } from '../lib/scroll-room.ts';

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

// A page's title and subtitle while it loads, where PageHeader puts them.
function HeaderSkeleton() {
  return (
    <div className="mb-6 space-y-2">
      <Skeleton className="h-6 w-56 max-w-full" />
      <Skeleton className="h-4 w-80 max-w-full" />
    </div>
  );
}

// While a whole page loads (DESIGN.md §5.3, #2005): its header and, below it, a table, a list of cards or a two-column
// grid of cards (a settings page), so no page waits behind a lone spinner.
export function PageSkeleton({ body = 'table', columns }: { body?: 'table' | 'list' | 'cards'; columns?: number }) {
  return (
    <div>
      <HeaderSkeleton />
      {body === 'table' ? (
        <TableSkeleton {...(columns ? { columns } : {})} />
      ) : body === 'list' ? (
        <ListSkeleton />
      ) : (
        <div className="grid gap-6 lg:grid-cols-2">
          {[0, 1, 2, 3].map((i) => (
            <CardSkeleton key={i} />
          ))}
        </div>
      )}
    </div>
  );
}

// While the rows of a settings card load: the card's divided rows, a name on the left and a value on the right.
export function RowsSkeleton({ rows = 3 }: { rows?: number }) {
  const t = useTranslations('common');
  return (
    <div aria-busy="true" className="mt-3 divide-y">
      <span className="sr-only">{t('loading')}</span>
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="flex items-center gap-6 py-3">
          <Skeleton className="h-3.5 w-1/3" />
          <Skeleton className="ml-auto h-3 w-1/5" />
        </div>
      ))}
    </div>
  );
}

// While a card loads: its title and a few lines of text.
export function CardSkeleton({ className }: { className?: string }) {
  const t = useTranslations('common');
  return (
    <div aria-busy="true" className={cn('space-y-2.5 rounded-xl border bg-card p-4', className)}>
      <span className="sr-only">{t('loading')}</span>
      <Skeleton className="h-4 w-1/3" />
      <Skeleton className="h-3 w-2/3" />
      <Skeleton className="h-3 w-1/2" />
    </div>
  );
}

// While a source document loads: a page-shaped block where an image appears, a short box where a PDF or an XML file's
// link does.
export function DocumentSkeleton({ image }: { image: boolean }) {
  const t = useTranslations('common');
  return (
    <div aria-busy="true">
      <span className="sr-only">{t('loading')}</span>
      <Skeleton className={cn('w-full rounded-lg', image ? 'aspect-[3/4]' : 'h-20')} />
    </div>
  );
}

// While a proposal loads: its header, the parties card and the lines on the left, the document panel on the right, as
// the proposal page lays them out.
export function ProposalSkeleton() {
  // The lines' table skeleton says it is loading; the rest are bars.
  return (
    <div aria-busy="true">
      <Skeleton className="h-4 w-24" />
      <div className="mt-3">
        <HeaderSkeleton />
      </div>
      <div className="grid gap-6 lg:grid-cols-5">
        <div className="min-w-0 space-y-6 lg:col-span-3">
          <div className="grid gap-4 rounded-xl border bg-card p-4 sm:grid-cols-2">
            {[0, 1].map((i) => (
              <div key={i} className="space-y-2">
                <Skeleton className="h-3 w-1/4" />
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-3 w-1/2" />
              </div>
            ))}
          </div>
          <TableSkeleton columns={4} rows={4} />
        </div>
        <div className="min-w-0 rounded-xl border bg-card p-4 lg:col-span-2">
          <Skeleton className="mb-3 h-4 w-1/4" />
          <Skeleton className="aspect-[3/4] w-full rounded-lg" />
        </div>
      </div>
    </div>
  );
}

// A table with one header row; the body rows are TableRow/TableCell from @crove/ui. `numeric` lists the columns that
// hold amounts: their headers are right-aligned like the amounts (DESIGN.md 4.3).
// A list's table (DESIGN.md §4.3). Its header stays in view (#1444): a table taller than the window scrolls inside its
// card, under a pinned header, and only then becomes a tab stop, so the keyboard can scroll it too. The same when it
// scrolls sideways, as on a phone, where the table is wider than the screen (#1517).
// A total's top rule: twice the hairline between rows and darker, so a total is set apart by more than its weight or a
// color (DESIGN.md §4.3, #2002). The foreground token keeps it visible in both themes.
export const TOTAL_RULE = 'border-t-2 border-t-foreground/40';

// `foot` holds the table's totals rows: a <tfoot>, which screen readers announce as the table's footer, under the rule.
export function DataTable({ head, numeric = [], foot, children }: { head: string[]; numeric?: number[]; foot?: ReactNode; children: ReactNode }) {
  const scroller = useRef<HTMLDivElement>(null);
  // The header row is pinned inside the scroll box: a row the keyboard focuses stops below it (#1575).
  const header = useRef<HTMLTableSectionElement>(null);
  useScrollRoom(header, 'top', scroller);
  const [scrolls, setScrolls] = useState(false);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => setScrolls(el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1);
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
        <TableHeader ref={header} className="sticky top-0 z-10 bg-muted [&_th]:bg-muted [&_th]:shadow-[inset_0_-1px_0_var(--color-border)] [&_tr]:border-b-0">
          <TableRow className="hover:bg-transparent">
            {head.map((h, i) => (
              <TableHead key={i} className={cn('px-4 text-xs font-medium text-subtle-foreground', numeric.includes(i) && 'text-right')}>
                {h}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>{children}</TableBody>
        {foot && <TableFooter className={cn(TOTAL_RULE, '[&_tr]:hover:bg-transparent')}>{foot}</TableFooter>}
      </Table>
    </div>
  );
}

export function Logo() {
  return (
    <span className="inline-flex items-center gap-2 font-semibold tracking-tight text-foreground">
      {/* The Ludy mark (three tiles in an L and Vy's spark), the same as on the marketing site and in favicon.svg. */}
      <svg viewBox="0 0 92 92" className="h-6 w-6" aria-hidden="true">
        <path className="fill-brand" d="M0 11A11 11 0 0 1 11 0H31A11 11 0 0 1 42 11V31A11 11 0 0 1 31 42H11A11 11 0 0 1 0 31ZM0 61A11 11 0 0 1 11 50H31A11 11 0 0 1 42 61V81A11 11 0 0 1 31 92H11A11 11 0 0 1 0 81ZM50 61A11 11 0 0 1 61 50H81A11 11 0 0 1 92 61V81A11 11 0 0 1 81 92H61A11 11 0 0 1 50 81Z" />
        <path className="fill-brand-spark" d="M71 0C73.27 15.5 76.5 18.73 92 21C76.5 23.27 73.27 26.5 71 42C68.73 26.5 65.5 23.27 50 21C65.5 18.73 68.73 15.5 71 0Z" />
      </svg>
      {brandName()}
    </span>
  );
}
