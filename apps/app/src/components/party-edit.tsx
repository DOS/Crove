// Correcting a customer's or vendor's name, tax code and contact email (issue #670), shared by the customers and
// vendors screens. Owners and admins see the Edit button; the server enforces the roles and every rule, and the form
// shows its reason when it refuses.
import { useMutation } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import { Button } from '@crove/ui/components/button';
import { Input } from '@crove/ui/components/input';
import { Label } from '@crove/ui/components/label';
import { TableCell, TableRow } from '@crove/ui/components/table';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';
import { partyChanges, type PartyFields } from '../lib/parties.ts';
import { ErrorText } from './ui.tsx';

export interface EditableParty extends PartyFields {
  id: string;
}

export function EditPartyButton({ party, onEdit }: { party: EditableParty; onEdit: () => void }) {
  const t = useTranslations('parties');
  return (
    <Button variant="ghost" size="sm" onClick={onEdit} aria-label={t('editOf', { name: party.name })}>
      {t('edit')}
    </Button>
  );
}

// A table row under the party's own row, spanning the table, with the form.
export function PartyEditRow({ party, columns, onClose }: { party: EditableParty; columns: number; onClose: () => void }) {
  const t = useTranslations('parties');
  const tc = useTranslations('common');
  const [name, setName] = useState(party.name);
  const [taxCode, setTaxCode] = useState(party.taxCode ?? '');
  const [email, setEmail] = useState(party.email ?? '');
  const update = useMutation(
    orpc.parties.update.mutationOptions({
      onSuccess: () => {
        // Both lists show the party; the ledger reports and documents show its name and tax code too.
        void queryClient.invalidateQueries({ queryKey: orpc.parties.key() });
        void queryClient.invalidateQueries({ queryKey: orpc.documents.key() });
        void queryClient.invalidateQueries({ queryKey: orpc.ledger.key() });
        onClose();
      },
    }),
  );
  function submit(event: FormEvent) {
    event.preventDefault();
    const changes = partyChanges(party.id, party, { name, taxCode, email });
    if (changes) update.mutate(changes);
    else onClose();
  }
  const id = `party-${party.id}`;
  return (
    <TableRow className="bg-muted/40 hover:bg-muted/40">
      <TableCell colSpan={columns} className="px-4 py-4">
        <form className="space-y-3" onSubmit={submit} aria-label={t('editOf', { name: party.name })}>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1">
              <Label htmlFor={`${id}-name`}>{t('name')}</Label>
              <Input id={`${id}-name`} required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${id}-tax`}>{t('taxCode')}</Label>
              <Input id={`${id}-tax`} className="font-mono" maxLength={20} inputMode="numeric" value={taxCode} onChange={(e) => setTaxCode(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${id}-email`}>{t('email')}</Label>
              <Input id={`${id}-email`} type="email" maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
          </div>
          <p className="text-xs text-subtle-foreground">{t('hint')}</p>
          {update.error && <ErrorText>{errorMessage(update.error)}</ErrorText>}
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={update.isPending}>
              {t('save')}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={onClose}>
              {tc('cancel')}
            </Button>
          </div>
        </form>
      </TableCell>
    </TableRow>
  );
}
