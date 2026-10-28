import { useMutation, useQuery } from '@tanstack/react-query';
import { useDeferredValue, useEffect, useState } from 'react';
import { Link, useParams, useSearch } from '@tanstack/react-router';
import { useTranslations } from 'use-intl';
import type { Party } from '@crove/kernel-contract';
import { Button, buttonVariants } from '@crove/ui/components/button';
import { Input } from '@crove/ui/components/input';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { TableCell, TableRow } from '@crove/ui/components/table';
import { RecordNotesPanel, notesInstalled } from '../components/notes-panel.tsx';
import { EditParty, MergeParty, PartyDuplicates, refreshParties } from '../components/party-edit.tsx';
import { DataTable, Empty, ErrorText, PageHeader, TableSkeleton } from '../components/ui.tsx';
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
  const tn = useTranslations('notes');
  const { slug } = useParams({ strict: false }) as { slug: string };
  const [notesOpen, setNotesOpen] = useState(false);
  return (
    <>
      <TableRow>
        <TableCell className="px-4 py-3">
          <p className="font-medium text-foreground">{vendor.name}</p>
          {(vendor.email || vendor.phone) && <p className="text-xs text-subtle-foreground">{[vendor.phone, vendor.email].filter(Boolean).join(' · ')}</p>}
          <PartyDuplicates party={vendor} canManage={canManage} ns="vendors" />
          {notesInstalled() && (
            <Button variant="link" size="sm" className="h-auto px-0 text-xs" onClick={() => setNotesOpen((o) => !o)} aria-expanded={notesOpen} aria-label={tn('panel.toggleOf', { name: vendor.name })}>
              {tn('panel.title')}
            </Button>
          )}
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
            <EditParty party={vendor} ns="vendors" onDone={() => setEditing(false)} />
            {canManage && (
              <div className="mt-4 border-t pt-3">
                <MergeParty party={vendor} others={others} ns="vendors" />
              </div>
            )}
          </TableCell>
        </TableRow>
      )}
      {notesOpen && (
        <TableRow>
          <TableCell colSpan={6} className="px-4 py-3">
            <RecordNotesPanel slug={slug} target={{ targetType: 'kernel.party', targetId: vendor.id }} headingId={`notes-${vendor.id}`} label={tn('panel.toggleOf', { name: vendor.name })} />
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
    setQ(search.q ?? '');
  }, [search.q]);
  const { slug } = useParams({ strict: false }) as { slug: string };
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
        <TableSkeleton columns={4} />
      ) : vendors.error ? (
        <ErrorText>{errorMessage(vendors.error)}</ErrorText>
      ) : (vendors.data?.length ?? 0) === 0 ? (
        term ? (
          <Empty title={t('noMatch')} />
        ) : (
          <Empty
            title={t('empty')}
            hint={t('emptyHint')}
            action={
              <Link to="/o/$slug/inbox" params={{ slug }} className={buttonVariants({ variant: 'outline' })}>
                {t('openInbox')}
              </Link>
            }
          />
        )
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
