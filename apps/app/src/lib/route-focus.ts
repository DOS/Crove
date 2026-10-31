// SPDX-License-Identifier: AGPL-3.0-only
// After a navigation that changes the path (not a search-param change such as ?q= or ?note=), the keyboard focus moves to
// the new screen's heading, or to <main> when it has none, and the screen's name goes to a polite live region, so a
// keyboard or screen reader user lands on the new screen instead of staying on the link they pressed (WCAG 2.4.3, 4.1.3;
// DESIGN.md §7, #2115). The first load and the back and forward buttons keep the focus where the browser puts it, though
// the live region still names the screen.
import { useRouterState } from '@tanstack/react-router';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { currentScreenName, subscribeScreenName } from './screen-title.ts';

// How long a screen may take to name itself before the focus goes to <main> without waiting. The announcement keeps
// following the screen's name until the next navigation (a record's name arrives with its data).
const NAME_WAIT_MS = 2000;

// A back or forward step, noted before the router's own popstate handler runs: that handler can render the new screen
// synchronously, so a listener added after it would learn of the step too late. Capture phase, from module load.
let popped = false;
if (typeof window !== 'undefined') {
  window.addEventListener(
    'popstate',
    () => {
      popped = true;
    },
    true,
  );
}

/** The focus goes to the screen's heading (or <main>), unless the screen already put it in its own content (#1230). */
export function moveFocusToScreen(main: HTMLElement | null): void {
  if (!main) return;
  const active = document.activeElement;
  if (active && active !== document.body && main.contains(active)) return;
  const heading = main.querySelector<HTMLElement>('h1');
  const target = heading ?? main;
  if (target !== main && !target.hasAttribute('tabindex')) target.tabIndex = -1;
  target.focus();
}

/** What the screen-name live region shows: `seq` changes with every announcement, so the same name twice is read twice. */
export interface RouteAnnouncement {
  name: string;
  seq: number;
}

/** Moves the focus on a navigation and returns what the screen-name live region shows. */
export function useRouteFocus(main: RefObject<HTMLElement | null>): RouteAnnouncement {
  // The path of the screen on show: `useLocation()` already holds the address being loaded while the old screen is still
  // mounted (the org's beforeLoad runs first), so it would focus the screen that is about to go.
  const pathname = useRouterState({ select: (s) => (s.resolvedLocation ?? s.location).pathname });
  const href = useRouterState({ select: (s) => (s.resolvedLocation ?? s.location).href });
  const [announcement, setAnnouncement] = useState<RouteAnnouncement>({ name: '', seq: 0 });
  const say = (name: string) => setAnnouncement((before) => ({ name, seq: before.seq + 1 }));
  const previousPath = useRef(pathname);

  useEffect(() => {
    const byHistory = popped;
    if (pathname === previousPath.current) return;
    previousPath.current = pathname;
    let moved = byHistory;
    say('');
    const settle = () => {
      if (moved) return;
      moved = true;
      moveFocusToScreen(main.current);
    };
    const announce = () => {
      const name = currentScreenName();
      if (!name) return;
      say(name);
      settle();
    };
    announce();
    const unsubscribe = subscribeScreenName(announce);
    const timer = setTimeout(settle, NAME_WAIT_MS);
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }, [pathname, main]);

  // A back or forward step that kept the path (a search param moved) must not mark the next link press as one.
  useEffect(() => {
    popped = false;
  }, [href]);

  return announcement;
}
