// SPDX-License-Identifier: AGPL-3.0-only
// After a navigation that changes the path (not a search-param change such as ?q= or ?note=), the keyboard focus moves to
// the new screen's heading, or to <main> when it has none, and the screen's name goes to a polite live region, so a
// keyboard or screen reader user lands on the new screen instead of staying on the link they pressed (WCAG 2.4.3, 4.1.3;
// DESIGN.md §7, #2115). The first load and the back and forward buttons keep the focus where the browser puts it, though
// the live region still names the screen.
import { useLocation } from '@tanstack/react-router';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { currentScreenName, subscribeScreenName } from './screen-title.ts';

// How long a screen may take to name itself before the focus goes to <main> without waiting, and how long after that its
// name may still change (a record's name arrives with its data) and update the announcement.
const NAME_WAIT_MS = 2000;

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

/** Moves the focus on a navigation and returns the text for the screen-name live region. */
export function useRouteFocus(main: RefObject<HTMLElement | null>): string {
  const { pathname, href } = useLocation();
  const [announcement, setAnnouncement] = useState('');
  const previousPath = useRef(pathname);
  const popped = useRef(false);

  useEffect(() => {
    const mark = () => {
      popped.current = true;
    };
    window.addEventListener('popstate', mark);
    return () => window.removeEventListener('popstate', mark);
  }, []);

  useEffect(() => {
    const byHistory = popped.current;
    if (pathname === previousPath.current) return;
    previousPath.current = pathname;
    let moved = byHistory;
    const settle = () => {
      if (moved) return;
      moved = true;
      moveFocusToScreen(main.current);
    };
    const announce = () => {
      const name = currentScreenName();
      if (!name) return;
      setAnnouncement(name);
      settle();
    };
    announce();
    const unsubscribe = subscribeScreenName(announce);
    const timer = setTimeout(() => {
      settle();
      unsubscribe();
    }, NAME_WAIT_MS);
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }, [pathname, main]);

  // A back or forward step that kept the path (a search param moved) must not mark the next link press as one.
  useEffect(() => {
    popped.current = false;
  }, [href]);

  return announcement;
}
