import { useMutation, useQuery } from '@tanstack/react-query';
import { useDeferredValue, useState } from 'react';
import { useTranslations } from 'use-intl';
import { Input } from '@crove/ui/components/input';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { TableCell, TableRow } from '@crove/ui/components/table';
import { DataTable, Empty, ErrorText, PageHeader, Spinner } from '../components/ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { accountLabel, pickableAccounts, type ChartAccount } from '../lib/accounts.ts';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';

// The debit account proposed first for a vendor's invoices (#319): set by approving an invoice, and here by owners and
// admins, to any account in use (a sub-account included). Everyone else sees it.
function DefaultAccount({ vendor, accounts, canManage }: { vendor: { id: string; name: string; defaultAccount: string | null }; accounts: readonly ChartAccount[]; canManage: boolean }) {
  const t = useTranslations('vendors');
  const set = useMutation(orpc.parties.setDefaultAccount.mutationOptions({ onSuccess: () => void queryClient.invalidateQueries({ queryKey: orpc.parties.list.key() }) }));
  const current = accounts.find((a) => a.code === vendor.defaultAccount);
  if (!canManage) return <>{vendor.defaultAccount ? accountLabel(current ?? { code: vendor.defaultAccount, name: '' }) : t('noDefault')}</>;
  return (
    <>
      <NativeSelect
        size="sm"
        className="w-56"
        value={vendor.defaultAccount ?? ''}
        disabled={set.isPending}
        aria-label={t('defaultAccountOf', { name: vendor.name })}
        onChange={(e) => set.mutate({ partyId: vendor.id, accountCode: e.target.value || null })}
      >
        <NativeSelectOption value="">{t('noDefault')}</NativeSelectOption>
        {pickableAccounts(accounts, vendor.defaultAccount, 'purchase').map((a) => (
          <NativeSelectOption key={a.code} value={a.code}>
            {accountLabel(a)}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      {set.error && <ErrorText>{errorMessage(set.error)}</ErrorText>}
    </>
  );
}

export function VendorsPage() {
  const t = useTranslations('vendors');
  const f = useFormat();
  const [q, setQ] = useState('');
  const term = useDeferredValue(q.trim());
  const vendors = useQuery(orpc.parties.list.queryOptions({ input: term ? { q: term } : {} }));
  const accounts = useQuery(orpc.accounts.list.queryOptions());
  const org = useQuery(orpc.org.get.queryOptions());
  const canManage = org.data?.role === 'owner' || org.data?.role === 'admin';
  return (
    <>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      <div className="mb-4 max-w-sm">
        <Input placeholder={t('search')} value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {vendors.isLoading ? (
        <Spinner />
      ) : vendors.error ? (
        <ErrorText>{errorMessage(vendors.error)}</ErrorText>
      ) : (vendors.data?.length ?? 0) === 0 ? (
        <Empty title={t('empty')} />
      ) : (
        <DataTable head={[t('columns.name'), t('columns.taxCode'), t('columns.address'), t('columns.documents'), t('columns.defaultAccount')]}>
          {vendors.data?.map((v) => (
            <TableRow key={v.id}>
              <TableCell className="px-4 py-3 font-medium text-foreground">{v.name}</TableCell>
              <TableCell className="px-4 py-3 font-mono text-xs text-muted-foreground">{v.taxCode}</TableCell>
              <TableCell className="px-4 py-3 text-subtle-foreground">{v.address}</TableCell>
              <TableCell className="px-4 py-3 text-muted-foreground tabular-nums">{f.number(v.documentCount)}</TableCell>
              <TableCell className="px-4 py-3 text-muted-foreground">
                <DefaultAccount vendor={v} accounts={accounts.data ?? []} canManage={canManage} />
              </TableCell>
            </TableRow>
          ))}
        </DataTable>
      )}
    </>
  );
}
