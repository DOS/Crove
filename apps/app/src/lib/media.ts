// Whether a CSS media query matches now, kept current as the window changes (#1270). A screen that lays out
// differently by width renders one layout, not both with one hidden, so the page holds each element once.
import { useCallback, useSyncExternalStore } from 'react';

export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = window.matchMedia(query);
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}

// Tailwind's `sm` breakpoint (40rem).
export const SM_UP = '(min-width: 40rem)';

// Wide enough for a list beside its detail (DESIGN.md §3.4, #1514) once the app rail and the menu take their 18rem: a
// 1366 px laptop and up. Below it, list and detail stay separate pages.
export const SPLIT_UP = '(min-width: 84rem)';
