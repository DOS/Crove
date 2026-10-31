// SPDX-License-Identifier: AGPL-3.0-only
// The name of the screen on show (WCAG 2.4.2, DESIGN.md §7, #2115): the browser tab's title reads "<screen> · <brand>"
// in the current language, and the shell announces the same name when the keyboard or a link brings the user to a new
// screen. A screen sets its name through `useScreenTitle`; PageHeader does it for every screen that renders one, and the
// screens outside the shell (sign-in, invite, not found) call it themselves.
import { useEffect } from 'react';
import { brandName } from '../i18n/brand.ts';

let current: string | null = null;
const listeners = new Set<() => void>();

function setCurrent(name: string | null): void {
  if (name === current) return;
  current = name;
  for (const listener of listeners) listener();
}

/** The name of the screen on show, or null while it loads or between two screens. */
export function currentScreenName(): string | null {
  return current;
}

export function subscribeScreenName(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** "Sổ sách · Ludy": the tab title of a screen. */
export function screenTitle(name: string, brand = brandName()): string {
  return `${name} · ${brand}`;
}

/** Puts the screen's name in the tab title and tells the shell; the brand alone stands again when the screen goes. */
export function useScreenTitle(name: string | null | undefined): void {
  useEffect(() => {
    if (!name) return;
    document.title = screenTitle(name);
    setCurrent(name);
    return () => {
      document.title = brandName();
      setCurrent(null);
    };
  }, [name]);
}
