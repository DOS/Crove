// Where toasts show (#1384): bottom right, above the phone's safe area, newest last. A result toast leaves on its own,
// an error one stays until closed. A toast's action (an undo, #2003) is a button in the toast, in the tab order; the
// toast waits while it is hovered or focused.
//
// Screen readers (#2026): a live region filled in the moment it is inserted is often not read, so the list itself is
// the one polite status region, always mounted (empty and out of the way when there is nothing to say), and each new
// toast is an addition read once. A toast with an action also says that F8 reaches it. F8 moves the focus to the newest
// toast's first button; when the toast that holds the focus goes (its action ran, it was closed, or a newer one pushed
// it out), the focus goes back to where it came from, or else to the page's main region.
import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { useTranslations } from 'use-intl';
import { NavIcon } from '@crove/ui/components/nav-icon';
import { cn } from '@crove/ui/lib/utils';
import { currentToasts, dismissToast, isToastShortcut, pauseToast, resumeToast, runToastAction, subscribeToasts, TOAST_SHORTCUT } from '../lib/toast.ts';

export function Toaster() {
  const t = useTranslations('common');
  const toasts = useSyncExternalStore(subscribeToasts, currentToasts, currentToasts);
  const list = useRef<HTMLDivElement>(null);
  // The toast that holds the focus, and the element the focus came from.
  const focused = useRef<number | null>(null);
  const cameFrom = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isToastShortcut(event)) return;
      const newest = list.current?.querySelector<HTMLElement>('[data-toast]:last-child button');
      if (!newest) return;
      event.preventDefault();
      newest.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // The focused toast is gone: give the focus back.
  useLayoutEffect(() => {
    if (focused.current === null || toasts.some((item) => item.id === focused.current)) return;
    focused.current = null;
    const back = cameFrom.current;
    cameFrom.current = null;
    if (back?.isConnected) back.focus();
    else document.querySelector<HTMLElement>('main')?.focus();
  }, [toasts]);

  return (
    <div
      ref={list}
      role="status"
      aria-label={t('toasts')}
      className="pointer-events-none fixed right-0 bottom-0 z-50 flex w-full max-w-sm flex-col gap-2 pr-[max(1rem,env(safe-area-inset-right))] pb-[max(1rem,env(safe-area-inset-bottom))] pl-4"
    >
      {toasts.map((item) => (
        <div
          key={item.id}
          data-toast={item.id}
          onMouseEnter={() => pauseToast(item.id)}
          onMouseLeave={(e) => !e.currentTarget.contains(document.activeElement) && resumeToast(item.id)}
          onFocus={(e) => {
            pauseToast(item.id);
            const from = e.relatedTarget as HTMLElement | null;
            if (!list.current?.contains(from)) cameFrom.current = from;
            focused.current = item.id;
          }}
          onBlur={(e) => {
            // A toast taken away while it holds the focus keeps focused.current: the layout effect gives the focus back.
            if (!currentToasts().some((x) => x.id === item.id)) return;
            const to = e.relatedTarget as Node | null;
            if (e.currentTarget.contains(to)) return;
            if (!list.current?.contains(to)) {
              focused.current = null;
              cameFrom.current = null;
            }
            if (!e.currentTarget.matches(':hover')) resumeToast(item.id);
          }}
          className={cn(
            'pointer-events-auto flex items-start gap-3 rounded-lg border bg-popover px-4 py-3 text-sm text-popover-foreground shadow-md',
            'motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2',
            item.tone === 'error' && 'border-destructive/40',
          )}
        >
          <span className={cn('min-w-0 flex-1', item.tone === 'error' && 'text-destructive')}>
            {item.message}
            {item.action && <span className="sr-only"> {t('toastShortcut', { key: TOAST_SHORTCUT, action: item.action.label })}</span>}
          </span>
          {item.action && (
            <button
              type="button"
              onClick={() => runToastAction(item.id)}
              aria-keyshortcuts={TOAST_SHORTCUT}
              className="-my-1 shrink-0 rounded px-2 py-1 font-medium text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              {item.action.label}
            </button>
          )}
          <button
            type="button"
            onClick={() => dismissToast(item.id)}
            aria-label={t('close')}
            className="-m-1 grid size-6 shrink-0 place-items-center rounded text-muted-foreground hover:text-foreground"
          >
            <NavIcon name="close" />
          </button>
        </div>
      ))}
    </div>
  );
}
