// Customers (issue #670): the parties of the org's sales invoices (#313) and of its receivables, with each one's tax
// code, what it owes on 131 today and its latest invoice. The same edit actions as vendors (#887): owners, admins and
// members correct a customer's name and contact details; owners and admins merge duplicates and separate them. ?q=
// opens the screen on a search (a sale proposal and the receivables report link here with the customer's tax code).
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link, useParams, useSearch } from '@tanstack/react-router';
import { useDeferredValue, useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';
import type { Customer, CustomerCursor } from '@crove/kernel-contract';
import { Button } from '@crove/ui/components/button';
import { Input } from '@crove/ui/components/input';
import { TableCell, TableRow } from '@crove/ui/components/table';
import { RecordNotesPanel, notesInstalled } from '../components/notes-panel.tsx';
import { useChosenEntity } from '../components/entity-switcher.tsx';
import { EditParty, MergeParty, PartyDuplicates } from '../components/party-edit.tsx';
import { DataTable, Empty, ErrorText, PageHeader, TableSkeleton } from '../components/ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { errorMessage, orpc } from '../lib/api.ts';
import { nextCustomerCursor } from '../lib/parties.ts';

const NUM = 'px-4 py-3 text-right tabular-nums';

function CustomerRow({
  customer,
  others,
  columns,
  canManage,
  canEdit,
}: {
  customer: Customer;
  others: readonly Customer[];
  columns: number;
  canManage: boolean;
  canEdit: boolean;
}) {
  const t = useTranslations('customers');
  const tn = useTranslations('notes');
  const f = useFormat();
  const { slug } = useParams({ strict: false }) as { slug: string };
  const [editing, setEditing] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const contact = [customer.phone, customer.email].filter(Boolean).join(' · ');
  return (
    <>
      <TableRow>
        <TableCell className="min-w-48 px-4 py-3">
          <p className="font-medium text-foreground">{customer.name}</p>
          {customer.address && <p className="text-xs text-subtle-foreground">{customer.address}</p>}
          {contact && <p className="text-xs text-subtle-foreground">{contact}</p>}
          <PartyDuplicates party={customer} canManage={canManage} ns="customers" />
        </TableCell>
        <TableCell className="px-4 py-3 font-mono text-xs text-muted-foreground">{customer.taxCode ?? ''}</TableCell>
        <TableCell className={`${NUM} text-muted-foreground`}>{f.number(customer.invoiceCount)}</TableCell>
        <TableCell className="px-4 py-3 text-muted-foreground">{customer.lastInvoiceDate ? f.date(customer.lastInvoiceDate) : t('noInvoice')}</TableCell>
        <TableCell className={`${NUM} font-medium text-foreground`}>{f.money(customer.receivable)}</TableCell>
        {canEdit && (
          <TableCell className="px-4 py-3 text-right">
            {!editing && (
              <Button variant="ghost" size="sm" onClick={() => setEditing(true)} aria-label={t('editOf', { name: customer.name })}>
                {t('edit')}
              </Button>
            )}
            {/* The party's notes (#1671), beside its other actions. */}
            {notesInstalled() && (
              <Button variant="ghost" size="sm" onClick={() => setNotesOpen((o) => !o)} aria-expanded={notesOpen} aria-label={tn('panel.toggleOf', { name: customer.name })}>
                {tn('panel.title')}
              </Button>
            )}
          </TableCell>
        )}
      </TableRow>
      {editing && (
        <TableRow>
          <TableCell colSpan={columns} className="px-4 py-3">
            <EditParty party={customer} ns="customers" onDone={() => setEditing(false)} />
            {canManage && (
              <div className="mt-4 border-t pt-3">
                <MergeParty party={customer} others={others} ns="customers" />
              </div>
            )}
          </TableCell>
        </TableRow>
      )}
      {notesOpen && (
        <TableRow>
          <TableCell colSpan={columns} className="px-4 py-3">
            <RecordNotesPanel slug={slug} target={{ targetType: 'kernel.party', targetId: customer.id }} headingId={`notes-${customer.id}`} label={tn('panel.toggleOf', { name: customer.name })} />
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

export function CustomersPage() {
  const t = useTranslations('customers');
  const { slug } = useParams({ strict: false }) as { slug: string };
  const search: { q?: string } = useSearch({ strict: false });
  const [q, setQ] = useState(search.q ?? '');
  // A link followed while the screen is open (from the receivables report, the command palette) sets the search again.
  useEffect(() => {
    setQ(search.q ?? '');
  }, [search.q]);
  const term = useDeferredValue(q.trim());
  const org = useQuery(orpc.org.get.queryOptions());
  const canManage = org.data?.role === 'owner' || org.data?.role === 'admin';
  const canEdit = canManage || org.data?.role === 'member';
  // The customers of the entity chosen in the shell, with its own receivable (#1534).
  const entity = useChosenEntity();
  // A page at a time (the server sends at most CUSTOMER_PAGE_SIZE); Load more asks for the customers after the last.
  const customers = useInfiniteQuery({
    ...orpc.parties.customers.infiniteOptions({
      input: (after: CustomerCursor | undefined) => ({ ...(term ? { q: term } : {}), ...(after ? { after } : {}), legalEntityId: entity.legalEntityId }),
      initialPageParam: undefined as CustomerCursor | undefined,
      getNextPageParam: nextCustomerCursor,
      placeholderData: keepPreviousData,
    }),
    enabled: entity.ready,
  });
  const rows = customers.data?.pages.flatMap((p) => p.items) ?? [];
  const head = [t('columns.name'), t('columns.taxCode'), t('columns.invoices'), t('columns.lastInvoice'), t('columns.receivable'), ...(canEdit ? [''] : [])];

  return (
    <>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      <div className="mb-4 max-w-sm">
        <Input type="search" placeholder={t('search')} aria-label={t('search')} maxLength={100} value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {customers.isPending ? (
        <TableSkeleton columns={4} />
      ) : customers.error && rows.length === 0 ? (
        <ErrorText>{errorMessage(customers.error)}</ErrorText>
      ) : rows.length === 0 ? (
        <Empty title={term ? t('noMatch') : t('empty')} hint={term ? undefined : t('emptyHint')} />
      ) : (
        <>
          <DataTable head={head} numeric={[2, 4]}>
            {rows.map((c) => (
              <CustomerRow key={c.id} customer={c} others={rows} columns={head.length} canManage={canManage} canEdit={canEdit} />
            ))}
          </DataTable>
          {customers.error && (
            <div className="mt-3">
              <ErrorText>{errorMessage(customers.error)}</ErrorText>
            </div>
          )}
          {customers.hasNextPage && (
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <p className="text-xs text-muted-foreground">{t('more', { count: rows.length })}</p>
              <Button variant="outline" size="sm" disabled={customers.isFetchingNextPage} onClick={() => void customers.fetchNextPage()}>
                {t('loadMore')}
              </Button>
            </div>
          )}
          <p className="mt-3 text-xs text-subtle-foreground">
            {t('receivableNote')}{' '}
            <Link to="/o/$slug/ledger" params={{ slug }} className="text-link hover:underline">
              {t('toLedger')}
            </Link>
          </p>
        </>
      )}
    </>
  );
}
