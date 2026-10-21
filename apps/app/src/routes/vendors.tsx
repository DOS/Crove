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

const refreshParties = () => {
  void queryClient.invalidateQueries({ queryKey: orpc.parties.list.key() });
  void queryClient.invalidateQueries({ queryKey: orpc.parties.duplicateHints.key() });
};

// Owners and admins mark this vendor as a duplicate of another (#887): it leaves the list, and its documents count
// under the one kept. Nothing is deleted; "Tách" on the kept vendor undoes it.
function MergeVendor({ vendor, others }: { vendor: Party; others: readonly Party[] }) {
  const t = useTranslations('vendors');
  const [keepId, setKeepId] = useState('');
  const mark = useMutation(orpc.parties.markDuplicate.mutationOptions({ onSuccess: refreshParties }));
  if (vendor.duplicates.length > 0) return <p className="text-xs text-subtle-foreground">{t('mergeHasDuplicates')}</p>;
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (keepId) mark.mutate({ partyId: vendor.id, keepId });
      }}
    >
      <div className="flex flex-col gap-1">
        <Label htmlFor={`merge-${vendor.id}`}>{t('mergeInto')}</Label>
        <NativeSelect id={`merge-${vendor.id}`} size="sm" className="w-72" value={keepId} onChange={(e) => setKeepId(e.target.value)}>
          <NativeSelectOption value="">{t('mergeChoose')}</NativeSelectOption>
          {others
            .filter((o) => o.id !== vendor.id)
            .map((o) => (
              <NativeSelectOption key={o.id} value={o.id}>
                {o.taxCode ? `${o.name} · ${o.taxCode}` : o.name}
              </NativeSelectOption>
            ))}
        </NativeSelect>
      </div>
      <Button type="submit" variant="outline" size="sm" disabled={!keepId || mark.isPending}>
        {t('merge')}
      </Button>
      {mark.error && <ErrorText>{errorMessage(mark.error)}</ErrorText>}
    </form>
  );
}

// The vendors marked as duplicates of this one, each with "Tách" for owners and admins.
function Duplicates({ vendor, canManage }: { vendor: Party; canManage: boolean }) {
  const t = useTranslations('vendors');
  const unmark = useMutation(orpc.parties.unmarkDuplicate.mutationOptions({ onSuccess: refreshParties }));
  if (vendor.duplicates.length === 0) return null;
  return (
    <ul className="mt-1 flex flex-col gap-1 text-xs text-subtle-foreground">
      {vendor.duplicates.map((d) => (
        <li key={d.id} className="flex items-center gap-2">
          <span>{t('merged', { name: d.taxCode ? `${d.name} · ${d.taxCode}` : d.name })}</span>
          {canManage && (
            <Button variant="ghost" size="sm" disabled={unmark.isPending} onClick={() => unmark.mutate({ partyId: d.id })} aria-label={t('unmergeOf', { name: d.name })}>
              {t('unmerge')}
            </Button>
          )}
        </li>
      ))}
      {unmark.error && <ErrorText>{errorMessage(unmark.error)}</ErrorText>}
    </ul>
  );
}

// Pairs of vendors that look like one (same enterprise tax code, same phone, or names alike), strongest first, each
// with "Gộp" for owners and admins.
function DuplicateHints({ canManage }: { canManage: boolean }) {
  const t = useTranslations('vendors');
  const hints = useQuery(orpc.parties.duplicateHints.queryOptions({ input: {} }));
  const mark = useMutation(orpc.parties.markDuplicate.mutationOptions({ onSuccess: refreshParties }));
  if (!hints.data || hints.data.length === 0) return null;
  const label = (p: { name: string; taxCode: string | null }) => (p.taxCode ? `${p.name} (${p.taxCode})` : p.name);
  return (
    <section aria-label={t('hintsTitle')} className="mb-4 rounded-xl border bg-card p-4">
      <h2 className="text-sm font-medium text-foreground">{t('hintsTitle')}</h2>
      <p className="mb-2 text-xs text-subtle-foreground">{t('hintsIntro')}</p>
      <ul className="flex flex-col gap-2 text-sm">
        {hints.data.map((h) => (
          <li key={`${h.keep.id}-${h.duplicate.id}`} className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-foreground">
              {t('hint', { duplicate: label(h.duplicate), keep: label(h.keep) })}
              <span className="ml-2 text-xs text-subtle-foreground">{h.reasons.map((r) => t(`reasons.${r}`)).join(', ')}</span>
            </span>
            {canManage && (
              <Button variant="outline" size="sm" disabled={mark.isPending} onClick={() => mark.mutate({ partyId: h.duplicate.id, keepId: h.keep.id })}>
                {t('mergeHint', { keep: h.keep.name })}
              </Button>
            )}
          </li>
        ))}
      </ul>
      {mark.error && <ErrorText>{errorMessage(mark.error)}</ErrorText>}
    </section>
  );
}

function VendorRow({
  vendor,
  others,
  accounts,
  canManage,
  canEdit,
}: {
  vendor: Party;
  others: readonly Party[];
  accounts: readonly ChartAccount[];
  canManage: boolean;
  canEdit: boolean;
}) {
  const t = useTranslations('vendors');
  const f = useFormat();
  const [editing, setEditing] = useState(false);
  return (
    <>
      <TableRow>
        <TableCell className="px-4 py-3">
          <p className="font-medium text-foreground">{vendor.name}</p>
          {(vendor.email || vendor.phone) && <p className="text-xs text-subtle-foreground">{[vendor.phone, vendor.email].filter(Boolean).join(' · ')}</p>}
          <Duplicates vendor={vendor} canManage={canManage} />
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
            {canManage && (
              <div className="mt-4 border-t pt-3">
                <MergeVendor vendor={vendor} others={others} />
              </div>
            )}
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
      {canEdit && <DuplicateHints canManage={canManage} />}
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
            <VendorRow key={v.id} vendor={v} others={vendors.data ?? []} accounts={accounts.data ?? []} canManage={canManage} canEdit={canEdit} />
          ))}
        </DataTable>
      )}
    </>
  );
}
