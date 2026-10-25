// The org's legal entities in Settings (issue #1278): owners and admins see the companies, branches and household
// businesses the org keeps books for, add one, and change one. The default entity is the org itself: its tax code is
// the org's and changes only through the tax code field above it. Entities are never deleted. The server enforces
// every rule; the screen only offers what can succeed and shows the server's reason otherwise.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import { LEGAL_ENTITY_KINDS, type LegalEntity, type LegalEntityKind } from '@crove/kernel-contract';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Input } from '@crove/ui/components/input';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { ErrorText, Spinner } from '../components/ui.tsx';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';
import { parentChoices, parentName } from '../lib/legal-entities.ts';

// The shell's switcher lists the entities with books (bookEntities.list), so an added or renamed one shows there too.
const refresh = () =>
  Promise.all([queryClient.invalidateQueries({ queryKey: orpc.legalEntities.list.key() }), queryClient.invalidateQueries({ queryKey: orpc.bookEntities.list.key() })]);

interface Draft {
  name: string;
  kind: LegalEntityKind;
  taxCode: string;
  parentId: string;
}
const draftOf = (e: LegalEntity | null): Draft => ({ name: e?.name ?? '', kind: e?.kind ?? 'branch', taxCode: e?.taxCode ?? '', parentId: e?.parentId ?? '' });
const inputOf = (d: Draft) => ({ name: d.name.trim(), kind: d.kind, taxCode: d.taxCode.trim() ? d.taxCode.trim() : null, parentId: d.parentId || null });

// The fields of an entity, for adding one (entity null) or changing one.
function EntityForm({
  entities,
  entity,
  pending,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  entities: readonly LegalEntity[];
  entity: LegalEntity | null;
  pending: boolean;
  submitLabel: string;
  onSubmit: (draft: Draft) => void;
  onCancel?: () => void;
}) {
  const t = useTranslations('legalEntities');
  const tc = useTranslations('common');
  const [draft, setDraft] = useState<Draft>(() => draftOf(entity));
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit(draft);
  };
  const lockedTaxCode = entity?.isDefault ?? false;
  return (
    <form className="mt-2 space-y-2" onSubmit={submit} aria-label={entity ? t('editOf', { name: entity.name }) : t('addTitle')}>
      <Input required maxLength={200} placeholder={t('namePlaceholder')} aria-label={t('name')} value={draft.name} onChange={(e) => set('name', e.target.value)} />
      <div className="flex flex-wrap gap-2">
        <NativeSelect className="min-w-48 flex-1" value={draft.kind} onChange={(e) => set('kind', e.target.value as LegalEntityKind)} aria-label={t('kind')}>
          {LEGAL_ENTITY_KINDS.map((k) => (
            <NativeSelectOption key={k} value={k}>
              {t(`kinds.${k}`)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <Input
          className="w-48 font-mono"
          maxLength={20}
          placeholder={t('taxCodePlaceholder')}
          aria-label={t('taxCode')}
          value={draft.taxCode}
          disabled={lockedTaxCode}
          title={lockedTaxCode ? t('defaultTaxCodeHint') : undefined}
          onChange={(e) => set('taxCode', e.target.value)}
        />
      </div>
      {lockedTaxCode && <p className="text-xs text-subtle-foreground">{t('defaultTaxCodeHint')}</p>}
      <NativeSelect className="w-full" value={draft.parentId} onChange={(e) => set('parentId', e.target.value)} aria-label={t('parent')}>
        <NativeSelectOption value="">{t('noParent')}</NativeSelectOption>
        {parentChoices(entities, entity?.id ?? null).map((e) => (
          <NativeSelectOption key={e.id} value={e.id}>
            {e.taxCode ? `${e.name} (${e.taxCode})` : e.name}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      <div className="flex gap-2">
        <Button type="submit" variant="outline" size="sm" disabled={pending || !draft.name.trim()}>
          {pending ? <Spinner className="text-current" /> : null}
          {submitLabel}
        </Button>
        {onCancel && (
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            {tc('cancel')}
          </Button>
        )}
      </div>
    </form>
  );
}

function EntityRow({ entity, entities }: { entity: LegalEntity; entities: readonly LegalEntity[] }) {
  const t = useTranslations('legalEntities');
  const [editing, setEditing] = useState(false);
  const update = useMutation(
    orpc.legalEntities.update.mutationOptions({
      onSuccess: async () => {
        setEditing(false);
        await refresh();
      },
    }),
  );
  const parent = parentName(entities, entity);
  return (
    <li className="py-2 text-sm">
      {editing ? (
        <EntityForm
          entities={entities}
          entity={entity}
          pending={update.isPending}
          submitLabel={t('save')}
          onSubmit={(d) => update.mutate({ legalEntityId: entity.id, ...inputOf(d) })}
          onCancel={() => {
            setEditing(false);
            update.reset();
          }}
        />
      ) : (
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="flex flex-wrap items-center gap-2 text-foreground">
              <span className="truncate">{entity.name}</span>
              {entity.isDefault && <Badge variant="brand">{t('default')}</Badge>}
            </p>
            <p className="text-xs text-subtle-foreground">
              {t(`kinds.${entity.kind}`)} · {entity.taxCode ? <span className="font-mono">{entity.taxCode}</span> : t('noTaxCode')}
              {parent ? ` · ${t('under', { parent })}` : null}
            </p>
          </div>
          <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(true)} aria-label={t('editOf', { name: entity.name })}>
            {t('edit')}
          </Button>
        </div>
      )}
      {update.error && <ErrorText>{errorMessage(update.error)}</ErrorText>}
    </li>
  );
}

function AddEntity({ entities }: { entities: readonly LegalEntity[] }) {
  const t = useTranslations('legalEntities');
  // A new form after each add, so the fields start empty again.
  const [round, setRound] = useState(0);
  const create = useMutation(
    orpc.legalEntities.create.mutationOptions({
      onSuccess: async () => {
        setRound((r) => r + 1);
        await refresh();
      },
    }),
  );
  return (
    <div className="mt-4">
      <p className="text-xs font-medium text-muted-foreground">{t('addTitle')}</p>
      <EntityForm key={round} entities={entities} entity={null} pending={create.isPending} submitLabel={t('add')} onSubmit={(d) => create.mutate(inputOf(d))} />
      {create.error && <ErrorText>{errorMessage(create.error)}</ErrorText>}
    </div>
  );
}

// Owners and admins only: the list itself is theirs (kernel.legal_entity.list).
export function LegalEntitiesCard() {
  const t = useTranslations('legalEntities');
  const entities = useQuery(orpc.legalEntities.list.queryOptions());
  return (
    <Card className="block p-4" aria-label={t('title')}>
      <p className="text-sm font-medium text-muted-foreground">{t('title')}</p>
      <p className="mt-2 text-sm text-muted-foreground">{t('intro')}</p>
      {entities.isLoading ? (
        <Spinner />
      ) : entities.error ? (
        <ErrorText>{errorMessage(entities.error)}</ErrorText>
      ) : (
        <>
          <ul className="mt-3 divide-y">
            {(entities.data ?? []).map((e) => (
              <EntityRow key={`${e.id}:${e.updatedAt}`} entity={e} entities={entities.data ?? []} />
            ))}
          </ul>
          <AddEntity entities={entities.data ?? []} />
        </>
      )}
    </Card>
  );
}
