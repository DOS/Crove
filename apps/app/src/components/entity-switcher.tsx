// The legal entity switcher of the app shell (issue #1486, the screens of #1280): under the org switch, on the finance
// books' screens, when the caller sees more than one legal entity. The screens read the same choice with
// useLegalEntity.
import { useLocation } from '@tanstack/react-router';
import { useId } from 'react';
import { useTranslations } from 'use-intl';
import { Label } from '@crove/ui/components/label';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { chooseEntity, isFinanceBookPath, keepEntity, useKeptEntity, type VisibleEntity } from '../lib/legal-entity-choice.ts';

const NONE: readonly VisibleEntity[] = [];

// The entities the caller sees, filtered by their scope on the server. finance.legalEntities.list comes with #1280
// part 2a; until then there is nothing to choose between, so the switcher stays hidden and the books keep using the
// default entity.
function useVisibleEntities(): readonly VisibleEntity[] {
  return NONE;
}

// The entity the finance screens work in, and the entities to choose from. entityId is null while the caller sees
// none (the server then answers for the default entity, or refuses).
export function useLegalEntity(slug: string): { entities: readonly VisibleEntity[]; entityId: string | null } {
  const entities = useVisibleEntities();
  const kept = useKeptEntity(slug);
  return { entities, entityId: chooseEntity(entities, kept) };
}

export function EntitySwitcher({ slug }: { slug: string }) {
  const t = useTranslations('nav');
  const id = useId();
  const { pathname } = useLocation();
  const { entities, entityId } = useLegalEntity(slug);
  if (entities.length < 2 || !isFinanceBookPath(pathname)) return null;
  return (
    <div className="mt-3">
      <Label htmlFor={id} className="text-xs font-normal text-subtle-foreground">
        {t('legalEntity')}
      </Label>
      <NativeSelect id={id} className="mt-1 w-full" value={entityId ?? ''} onChange={(e) => keepEntity(slug, e.target.value)}>
        {entities.map((e) => (
          <NativeSelectOption key={e.id} value={e.id}>
            {e.name}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    </div>
  );
}
