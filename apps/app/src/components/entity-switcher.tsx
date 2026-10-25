// The legal entity switcher of the app shell (issue #1486, the screens of #1280): under the org switch, on the screens
// that work in one entity (the finance books, the Overview and Settings), when the caller sees more than one. The
// screens read the same choice with useChosenEntity and send it with every finance call, so their lists, reports,
// requests and downloads follow it.
import { useQuery } from '@tanstack/react-query';
import { useLocation, useParams } from '@tanstack/react-router';
import { useId } from 'react';
import { useTranslations } from 'use-intl';
import { Label } from '@crove/ui/components/label';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { orpc } from '../lib/api.ts';
import { getConfig } from '../lib/auth.ts';
import { chooseEntity, isEntityPath, keepEntity, useKeptEntity, type VisibleEntity } from '../lib/legal-entity-choice.ts';

const NONE: readonly VisibleEntity[] = [];

// The entities whose books the caller sees (bookEntities.list, #1280), filtered by their scope on the server, the
// default first. Without the finance module there are no books, so nothing to choose between.
// settled is false while the list is still loading.
function useVisibleEntities(): { entities: readonly VisibleEntity[]; settled: boolean } {
  const finance = getConfig().modules.includes('finance');
  const entities = useQuery({ ...orpc.bookEntities.list.queryOptions(), enabled: finance, staleTime: 60_000 });
  return { entities: entities.data ?? NONE, settled: !finance || !entities.isPending };
}

// The entity the finance screens work in, and the entities to choose from. entityId is null while the caller sees
// none (the server then answers for the default entity, or refuses).
export function useLegalEntity(slug: string): { entities: readonly VisibleEntity[]; entityId: string | null; settled: boolean } {
  const { entities, settled } = useVisibleEntities();
  const kept = useKeptEntity(slug);
  return { entities, entityId: chooseEntity(entities, kept), settled };
}

// The entity a finance screen sends as legalEntityId, in the org of the current route. Calls wait for ready, so they
// are not made once for no entity and again when the list arrives; legalEntityId stays undefined when the list
// failed or is empty (the server then answers for the default entity).
export function useChosenEntity(): { ready: boolean; legalEntityId: string | undefined } {
  const { slug } = useParams({ strict: false }) as { slug?: string };
  const { entityId, settled } = useLegalEntity(slug ?? '');
  return { ready: settled, legalEntityId: entityId ?? undefined };
}

export function EntitySwitcher({ slug }: { slug: string }) {
  const t = useTranslations('nav');
  const id = useId();
  const { pathname } = useLocation();
  const { entities, entityId } = useLegalEntity(slug);
  if (entities.length < 2 || !isEntityPath(pathname)) return null;
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
