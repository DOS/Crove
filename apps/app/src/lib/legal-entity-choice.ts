// The legal entity the finance screens work in (issue #1486, the screens of #1280). One choice per org, kept in this
// browser, made in the app shell's switcher and read by every finance screen. The server decides what the caller may
// see (le_scope); the choice only picks among the entities it answered, and falls back when the kept one is gone.
import { useSyncExternalStore } from 'react';

export interface VisibleEntity {
  id: string;
  name: string;
  isDefault: boolean;
}

// The screens that work in one entity: the finance books, the Overview (the VAT return filed per entity) and Settings
// (the learned account rules per entity). The switcher shows on these only.
const ENTITY_SCREENS: ReadonlySet<string> = new Set(['documents', 'journal', 'vouchers', 'bank', 'fixed-assets', 'ledger', 'vat', 'overview', 'settings']);

// Whether a path (/o/<slug>/<screen>/...) is one of the screens that work in one entity.
export function isEntityPath(pathname: string): boolean {
  const [, o, , screen] = pathname.split('/');
  return o === 'o' && screen !== undefined && ENTITY_SCREENS.has(screen);
}

// The entity to work in: the kept one while the caller still sees it, else the default entity, else the first one
// seen; null when the caller sees none.
export function chooseEntity(entities: readonly VisibleEntity[], kept: string | null): string | null {
  if (kept && entities.some((e) => e.id === kept)) return kept;
  return (entities.find((e) => e.isDefault) ?? entities[0])?.id ?? null;
}

// The kept choice per org. Browser storage may be missing or refuse (a private window): the choice then lasts for the
// page's life only.
const memory = new Map<string, string>();
const listeners = new Set<() => void>();
const storageKey = (slug: string) => `crove.legalEntity.${slug}`;

export function keptEntity(slug: string): string | null {
  try {
    const stored = window.localStorage.getItem(storageKey(slug));
    if (stored) return stored;
  } catch {
    // Storage refused: fall through to the page's own memory.
  }
  return memory.get(slug) ?? null;
}

export function keepEntity(slug: string, id: string): void {
  memory.set(slug, id);
  try {
    window.localStorage.setItem(storageKey(slug), id);
  } catch {
    // Kept in memory only.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useKeptEntity(slug: string): string | null {
  return useSyncExternalStore(
    subscribe,
    () => keptEntity(slug),
    () => null,
  );
}
