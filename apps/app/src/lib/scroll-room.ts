// Room for a bar that stays on screen (WCAG 2.4.11, DESIGN.md §7, #1575): when the keyboard moves the focus, the browser
// scrolls the focused control into view, and a sticky or fixed bar must not then cover it. The bar's height, measured
// (it wraps, and a bar hidden at this width measures 0), becomes the scroll padding of the box that scrolls under it:
// the page by default, or a scroll box of its own (a table under its pinned header row).
import { useLayoutEffect, type RefObject } from 'react';

export function useScrollRoom(bar: RefObject<HTMLElement | null>, side: 'top' | 'bottom', scroller?: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const el = bar.current;
    const box = scroller ? scroller.current : document.documentElement;
    if (!el || !box) return;
    const property = side === 'top' ? 'scroll-padding-top' : 'scroll-padding-bottom';
    const measure = () => box.style.setProperty(property, `${el.offsetHeight}px`);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => {
      observer.disconnect();
      box.style.removeProperty(property);
    };
  }, [bar, side, scroller]);
}
