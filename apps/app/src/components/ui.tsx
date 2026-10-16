// App-level building blocks composed from the @crove/ui design system. Screens import primitives (Button, Input,
// Card, Badge, ...) from @crove/ui directly and these composites from here.
import { Alert } from '@crove/ui/components/alert';
import { Empty as EmptyRoot, EmptyDescription, EmptyHeader, EmptyTitle } from '@crove/ui/components/empty';
import { Spinner as SpinnerIcon } from '@crove/ui/components/spinner';
import { Table, TableBody, TableHead, TableHeader, TableRow } from '@crove/ui/components/table';
import { cn } from '@crove/ui/lib/utils';
import { useState, type ReactNode } from 'react';
import { useTranslations } from 'use-intl';
import { takeOrgLeftNotice } from '../lib/api.ts';

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string | undefined; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-foreground">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function Empty({ title, hint }: { title: string; hint?: string | undefined }) {
  return (
    <EmptyRoot className="border border-dashed px-6 py-12">
      <EmptyHeader>
        <EmptyTitle className="text-foreground">{title}</EmptyTitle>
        {hint && <EmptyDescription className="text-subtle-foreground">{hint}</EmptyDescription>}
      </EmptyHeader>
    </EmptyRoot>
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  return (
    <Alert variant="destructive" className="border-destructive/30 bg-destructive/10">
      {children}
    </Alert>
  );
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

export function Spinner({ className }: { className?: string }) {
  const t = useTranslations('common');
  return <SpinnerIcon className={cn('text-ring', className)} aria-label={t('loading')} />;
}

// A table with one header row; the body rows are TableRow/TableCell from @crove/ui.
export function DataTable({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      <Table className="min-w-[640px] [&_td]:whitespace-normal">
        <TableHeader className="bg-muted">
          <TableRow className="hover:bg-transparent">
            {head.map((h) => (
              <TableHead key={h} className="px-4 text-xs font-medium tracking-wide text-subtle-foreground uppercase">
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
      <svg viewBox="0 0 32 32" className="h-7 w-7" aria-hidden="true">
        <rect width="32" height="32" rx="8" className="fill-brand" />
        <path d="M21.5 11.2a7 7 0 1 0 0 9.6" fill="none" className="stroke-primary-foreground" strokeWidth="3" strokeLinecap="round" />
      </svg>
      Crove
    </span>
  );
}
