// Helpers for the legal entities card in Settings (issue #1278). The server enforces every rule; these only keep the
// form from offering what cannot succeed.
import type { LegalEntity } from '@crove/kernel-contract';

// The entities `self` may be placed under: every entity but itself and those below it (a parent there would form a
// cycle, which the server refuses). For a new entity (self null), every entity.
export function parentChoices(entities: readonly LegalEntity[], self: string | null): LegalEntity[] {
  if (!self) return [...entities];
  const below = new Set<string>([self]);
  // Walk down from self until no new child is found; a tree of n entities needs at most n rounds.
  for (let grew = true; grew; ) {
    grew = false;
    for (const e of entities) {
      if (e.parentId && below.has(e.parentId) && !below.has(e.id)) {
        below.add(e.id);
        grew = true;
      }
    }
  }
  return entities.filter((e) => !below.has(e.id));
}

// The name of an entity's parent, or null when it has none (or the parent is not in the list).
export function parentName(entities: readonly LegalEntity[], entity: LegalEntity): string | null {
  if (!entity.parentId) return null;
  return entities.find((e) => e.id === entity.parentId)?.name ?? null;
}
