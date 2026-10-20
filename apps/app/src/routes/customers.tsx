// Customers (issue #670): the parties of the org's sales invoices (#313) and of its receivables, with each one's tax
// code, what it owes on 131 today and its latest invoice. Owners and admins correct a customer's name, tax code and
// contact email, as on the vendors screen. ?q= opens the screen on a search (a sale proposal and the receivables
// report link here with the customer's tax code).
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link, useParams, useSearch } from '@tanstack/react-router';
import { Fragment, useDeferredValue, useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';
import type { CustomerCursor } from '@crove/kernel-contract';
import { Button } from '@crove/ui/components/button';
import { Input } from '@crove/ui/components/input';
import { TableCell, TableRow } from '@crove/ui/components/table';
import { EditPartyButton, PartyEditRow } from '../components/party-edit.tsx';
import { DataTable, Empty, ErrorText, PageHeader, Spinner } from '../components/ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { errorMessage, orpc } from '../lib/api.ts';
import { nextCustomerCursor } from '../lib/parties.ts';

const NUM = 'px-4 py-3 text-right tabular-nums';

export function CustomersPage() {
  const t = useTranslations('customers');
  const f = useFormat();
  const { slug } = useParams({ strict: false }) as { slug: string };
  const search = useSearch({ strict: false }) as { q?: string };
  const [q, setQ] = useState(search.q ?? '');
  // A link followed while the screen is open (from the receivables report, the back button) sets the search again.
  useEffect(() => setQ(search.q ?? ''), [search.q]);
  const term = useDeferredValue(q.trim());
  const [editing, setEditing] = useState<string | null>(null);
  const org = useQuery(orpc.org.get.queryOptions());
  const canManage = org.data?.role === 'owner' || org.data?.role === 'admin';
  // A page at a time (the server sends at most CUSTOMER_PAGE_SIZE); Load more asks for the customers after the last.
  const customers = useInfiniteQuery(
    orpc.parties.customers.infiniteOptions({
      input: (after: CustomerCursor | undefined) => ({ ...(term ? { q: term } : {}), ...(after ? { after } : {}) }),
      initialPageParam: undefined as CustomerCursor | undefined,
      getNextPageParam: nextCustomerCursor,
      placeholderData: keepPreviousData,
    }),
  );
  const rows = customers.data?.pages.flatMap((p) => p.items) ?? [];
  const head = [t('columns.name'), t('columns.taxCode'), t('columns.email'), t('columns.invoices'), t('columns.lastInvoice'), t('columns.receivable')];
  if (canManage) head.push('');

  return (
    <>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      <div className="mb-4 max-w-sm">
        <Input type="search" placeholder={t('search')} aria-label={t('search')} maxLength={100} value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {customers.isLoading ? (
        <Spinner />
      ) : customers.error && rows.length === 0 ? (
        <ErrorText>{errorMessage(customers.error)}</ErrorText>
      ) : rows.length === 0 ? (
        <Empty title={term ? t('noMatch') : t('empty')} hint={term ? undefined : t('emptyHint')} />
      ) : (
        <>
          <DataTable head={head} numeric={[3, 5]}>
            {rows.map((c) => (
              <Fragment key={c.id}>
                <TableRow>
                  <TableCell className="px-4 py-3">
                    <span className="font-medium text-foreground">{c.name}</span>
                    {c.address && <p className="text-xs text-subtle-foreground">{c.address}</p>}
                  </TableCell>
                  <TableCell className="px-4 py-3 font-mono text-xs text-muted-foreground">{c.taxCode ?? ''}</TableCell>
                  <TableCell className="px-4 py-3 text-muted-foreground">{c.email ?? ''}</TableCell>
                  <TableCell className={`${NUM} text-muted-foreground`}>{f.number(c.invoiceCount)}</TableCell>
                  <TableCell className="px-4 py-3 text-muted-foreground">{c.lastInvoiceDate ? f.date(c.lastInvoiceDate) : t('noInvoice')}</TableCell>
                  <TableCell className={`${NUM} font-medium text-foreground`}>{f.money(c.receivable)}</TableCell>
                  {canManage && (
                    <TableCell className="px-4 py-3 text-right">
                      <EditPartyButton party={c} onEdit={() => setEditing(c.id)} />
                    </TableCell>
                  )}
                </TableRow>
                {editing === c.id && <PartyEditRow party={c} columns={head.length} onClose={() => setEditing(null)} />}
              </Fragment>
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
