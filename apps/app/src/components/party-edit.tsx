// Editing a party (#887), shared by the vendors and customers (#670) screens: its name and contact details, and marking
// it as a duplicate of another or separating its duplicates. `ns` picks the screen's own words (a vendor, a customer).
// The server enforces the roles and every rule; these forms show its reason when it refuses.
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import type { Party } from '@crove/kernel-contract';
import { Button } from '@crove/ui/components/button';
import { Input } from '@crove/ui/components/input';
import { Label } from '@crove/ui/components/label';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';
import { ErrorText } from './ui.tsx';

export type PartyScreen = 'vendors' | 'customers';
// What the forms need of a party: a vendor of the vendors list or a customer of the customers list.
export type EditableParty = Pick<Party, 'id' | 'name' | 'taxCode' | 'address' | 'email' | 'phone' | 'version' | 'duplicates'>;

// Both lists, and the duplicate hints, show parties.
export const refreshParties = () => {
  void queryClient.invalidateQueries({ queryKey: orpc.parties.key() });
};

// A party's name and contact details, edited in a row under it by owners, admins and members. The version read goes
// back with the save, so an edit made meanwhile by someone else is refused rather than overwritten. A tax code can be
// added but not changed: it is how invoices find their party.
export function EditParty({ party, ns, onDone }: { party: EditableParty; ns: PartyScreen; onDone: () => void }) {
  const t = useTranslations(ns);
  const tc = useTranslations('common');
  const [form, setForm] = useState({
    name: party.name,
    taxCode: party.taxCode ?? '',
    address: party.address ?? '',
    email: party.email ?? '',
    phone: party.phone ?? '',
  });
  const save = useMutation(
    orpc.parties.update.mutationOptions({
      onSuccess: () => {
        refreshParties();
        onDone();
      },
    }),
  );
  const field = (key: keyof typeof form, props: { type?: string; maxLength: number; disabled?: boolean; required?: boolean }) => (
    <div className="flex flex-col gap-1">
      <Label htmlFor={`party-${party.id}-${key}`}>{t(`fields.${key}`)}</Label>
      <Input id={`party-${party.id}-${key}`} value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} {...props} />
    </div>
  );
  const orNull = (value: string) => (value.trim() === '' ? null : value);
  return (
    <form
      className="grid gap-3 sm:grid-cols-2"
      aria-label={t('editOf', { name: party.name })}
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate({
          partyId: party.id,
          version: party.version,
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
        {field('taxCode', { maxLength: 20, disabled: party.taxCode !== null })}
        {party.taxCode !== null && <p className="text-xs text-subtle-foreground">{t('taxCodeLocked')}</p>}
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

// Owners and admins mark this party as a duplicate of another: it leaves the list, and its documents and ledger lines
// count under the one kept. Nothing is deleted; "Tách" on the kept party undoes it.
export function MergeParty({ party, others, ns }: { party: EditableParty; others: readonly EditableParty[]; ns: PartyScreen }) {
  const t = useTranslations(ns);
  const [keepId, setKeepId] = useState('');
  const mark = useMutation(orpc.parties.markDuplicate.mutationOptions({ onSuccess: refreshParties }));
  if (party.duplicates.length > 0) return <p className="text-xs text-subtle-foreground">{t('mergeHasDuplicates')}</p>;
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (keepId) mark.mutate({ partyId: party.id, keepId });
      }}
    >
      <div className="flex flex-col gap-1">
        <Label htmlFor={`merge-${party.id}`}>{t('mergeInto')}</Label>
        <NativeSelect id={`merge-${party.id}`} size="sm" className="w-72 max-w-full" value={keepId} onChange={(e) => setKeepId(e.target.value)}>
          <NativeSelectOption value="">{t('mergeChoose')}</NativeSelectOption>
          {others
            .filter((o) => o.id !== party.id)
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

// The parties marked as duplicates of this one, each with "Tách" for owners and admins.
export function PartyDuplicates({ party, canManage, ns }: { party: EditableParty; canManage: boolean; ns: PartyScreen }) {
  const t = useTranslations(ns);
  const unmark = useMutation(orpc.parties.unmarkDuplicate.mutationOptions({ onSuccess: refreshParties }));
  if (party.duplicates.length === 0) return null;
  return (
    <ul className="mt-1 flex flex-col gap-1 text-xs text-subtle-foreground">
      {party.duplicates.map((d) => (
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
