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
