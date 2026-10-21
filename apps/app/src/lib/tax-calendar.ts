// The tax calendar on the multi-client home screen (issue #921): every client's obligations due in the next 30 days or
// overdue, in one list by due date, and how a period reads. The dues themselves come from me.clients (each read in its
// own org on the server); nothing here decides what is due.
import type { TaxDueView, TaxObligation } from '@crove/kernel-contract';
import { periodParts } from './clients.ts';

export interface TaxDueRow extends TaxDueView {
  orgId: string;
  slug: string;
  name: string;
  role: string;
}

// Every client's dues in one list: the earliest due date first, then by client name and obligation.
export function dueAcrossClients(
  clients: ReadonlyArray<{ orgId: string; slug: string; name: string; role: string; overview: { taxDues?: readonly TaxDueView[] } }>,
  locale: string,
): TaxDueRow[] {
  const byName = new Intl.Collator(locale, { sensitivity: 'base', numeric: true });
  const rows = clients.flatMap((c) => (c.overview.taxDues ?? []).map((d) => ({ ...d, orgId: c.orgId, slug: c.slug, name: c.name, role: c.role })));
  return rows.sort((a, b) => (a.dueDate !== b.dueDate ? (a.dueDate < b.dueDate ? -1 : 1) : byName.compare(a.name, b.name) || a.obligation.localeCompare(b.obligation) || a.period.localeCompare(b.period)));
}

// A period as its parts: a year ("2026"), or a month or quarter as clients.ts reads them.
export function taxPeriodParts(period: string): { kind: 'year'; year: number } | { kind: 'month' | 'quarter'; index: number; year: number } | null {
  if (/^\d{4}$/.test(period)) return { kind: 'year', year: Number(period) };
  return periodParts(period);
}

// Who may mark an obligation done (kernel.tax_obligation.done): owners, admins and members.
export function canMarkTaxDone(role: string | null | undefined): boolean {
  return role === 'owner' || role === 'admin' || role === 'member';
}

export type { TaxObligation };
