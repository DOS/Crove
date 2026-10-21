import { useMutation, useQuery } from '@tanstack/react-query';
import { useDeferredValue, useEffect, useState } from 'react';
import { useSearch } from '@tanstack/react-router';
import { useTranslations } from 'use-intl';
import type { Party } from '@crove/kernel-contract';
import { Button } from '@crove/ui/components/button';
import { Input } from '@crove/ui/components/input';
import { Label } from '@crove/ui/components/label';
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

// A party's name and contact details (#887), edited in a row under it by owners, admins and members. The version read
// goes back with the save, so an edit made meanwhile by someone else is refused rather than overwritten. A tax code
// can be added but not changed: it is how invoices find their party.
function EditVendor({ vendor, onDone }: { vendor: Party; onDone: () => void }) {
  const t = useTranslations('vendors');
  const tc = useTranslations('common');
  const [form, setForm] = useState({
    name: vendor.name,
    taxCode: vendor.taxCode ?? '',
    address: vendor.address ?? '',
    email: vendor.email ?? '',
    phone: vendor.phone ?? '',
  });
  const save = useMutation(
    orpc.parties.update.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: orpc.parties.list.key() });
        onDone();
      },
    }),
  );
  const field = (key: keyof typeof form, props: { type?: string; maxLength: number; disabled?: boolean; required?: boolean }) => (
    <div className="flex flex-col gap-1">
      <Label htmlFor={`party-${vendor.id}-${key}`}>{t(`fields.${key}`)}</Label>
      <Input id={`party-${vendor.id}-${key}`} value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} {...props} />
    </div>
  );
  const orNull = (value: string) => (value.trim() === '' ? null : value);
  return (
    <form
      className="grid gap-3 sm:grid-cols-2"
      aria-label={t('editOf', { name: vendor.name })}
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate({
          partyId: vendor.id,
          version: vendor.version,
          name: form.name,
          taxCode: orNull(form.taxCode),
          address: orNull(form.address),
          email: orNull(form.email),
          phone: orNull(form.phone),
        });
      }}
    >
      {field('name', { maxLength: 300, required: true })}
      <div className="flex flex-col gap-1">
        {field('taxCode', { maxLength: 20, disabled: vendor.taxCode !== null })}
        {vendor.taxCode !== null && <p className="text-xs text-subtle-foreground">{t('taxCodeLocked')}</p>}
      </div>
      {field('address', { maxLength: 500 })}
      {field('email', { type: 'email', maxLength: 254 })}
      {field('phone', { type: 'tel', maxLength: 30 })}
      <div className="flex items-end gap-2">
        <Button type="submit" variant="outline" size="sm" disabled={save.isPending}>
          {t('save')}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onDone}>
          {tc('cancel')}
        </Button>
      </div>
      {save.error && (
        <div className="sm:col-span-2">
          <ErrorText>{errorMessage(save.error)}</ErrorText>
        </div>
      )}
    </form>
  );
}

function VendorRow({ vendor, accounts, canManage, canEdit }: { vendor: Party; accounts: readonly ChartAccount[]; canManage: boolean; canEdit: boolean }) {
  const t = useTranslations('vendors');
  const f = useFormat();
  const [editing, setEditing] = useState(false);
  return (
    <>
      <TableRow>
        <TableCell className="px-4 py-3">
          <p className="font-medium text-foreground">{vendor.name}</p>
          {(vendor.email || vendor.phone) && <p className="text-xs text-subtle-foreground">{[vendor.phone, vendor.email].filter(Boolean).join(' · ')}</p>}
        </TableCell>
        <TableCell className="px-4 py-3 font-mono text-xs text-muted-foreground">{vendor.taxCode}</TableCell>
        <TableCell className="px-4 py-3 text-subtle-foreground">{vendor.address}</TableCell>
        <TableCell className="px-4 py-3 text-muted-foreground tabular-nums">{f.number(vendor.documentCount)}</TableCell>
        <TableCell className="px-4 py-3 text-muted-foreground">
          <DefaultAccount vendor={vendor} accounts={accounts} canManage={canManage} />
        </TableCell>
        {canEdit && (
          <TableCell className="px-4 py-3 text-right">
            {!editing && (
              <Button variant="ghost" size="sm" onClick={() => setEditing(true)} aria-label={t('editOf', { name: vendor.name })}>
                {t('edit')}
              </Button>
            )}
          </TableCell>
        )}
      </TableRow>
      {editing && (
        <TableRow>
          <TableCell colSpan={6} className="px-4 py-3">
            <EditVendor vendor={vendor} onDone={() => setEditing(false)} />
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

export function VendorsPage() {
  const t = useTranslations('vendors');
  // ?q= from a link (a party found by the command palette, #673) starts the filter.
  const search: { q?: string } = useSearch({ strict: false });
  const [q, setQ] = useState(search.q ?? '');
  useEffect(() => {
    if (search.q !== undefined) setQ(search.q);
  }, [search.q]);
  const term = useDeferredValue(q.trim());
  const vendors = useQuery(orpc.parties.list.queryOptions({ input: term ? { q: term } : {} }));
  const accounts = useQuery(orpc.accounts.list.queryOptions());
  const org = useQuery(orpc.org.get.queryOptions());
  const canManage = org.data?.role === 'owner' || org.data?.role === 'admin';
  const canEdit = canManage || org.data?.role === 'member';
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
        <DataTable
          head={[t('columns.name'), t('columns.taxCode'), t('columns.address'), t('columns.documents'), t('columns.defaultAccount'), ...(canEdit ? [''] : [])]}
        >
          {vendors.data?.map((v) => (
            <VendorRow key={v.id} vendor={v} accounts={accounts.data ?? []} canManage={canManage} canEdit={canEdit} />
          ))}
        </DataTable>
      )}
    </>
  );
}
