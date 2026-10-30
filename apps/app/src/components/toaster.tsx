// Where toasts show (#1384): bottom right, above the phone's safe area, newest last. Each is a status, read once by
// screen readers; a result toast leaves on its own, an error one stays until closed. A toast's action (an undo, #2003)
// is a button in the status, read with it and in the tab order; the toast waits while it is hovered or focused.
import { useSyncExternalStore } from 'react';
import { useTranslations } from 'use-intl';
import { NavIcon } from '@crove/ui/components/nav-icon';
import { cn } from '@crove/ui/lib/utils';
import { currentToasts, dismissToast, pauseToast, resumeToast, runToastAction, subscribeToasts } from '../lib/toast.ts';

export function Toaster() {
  const t = useTranslations('common');
  const toasts = useSyncExternalStore(subscribeToasts, currentToasts, currentToasts);
  if (toasts.length === 0) return null;
  return (
    <div
      aria-label={t('toasts')}
      className="pointer-events-none fixed right-0 bottom-0 z-50 flex w-full max-w-sm flex-col gap-2 pr-[max(1rem,env(safe-area-inset-right))] pb-[max(1rem,env(safe-area-inset-bottom))] pl-4"
    >
      {toasts.map((item) => (
        <div
          key={item.id}
          role="status"
          onMouseEnter={() => pauseToast(item.id)}
          onMouseLeave={(e) => !e.currentTarget.contains(document.activeElement) && resumeToast(item.id)}
          onFocus={() => pauseToast(item.id)}
          onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && !e.currentTarget.matches(':hover') && resumeToast(item.id)}
          className={cn(
            'pointer-events-auto flex items-start gap-3 rounded-lg border bg-popover px-4 py-3 text-sm text-popover-foreground shadow-md',
            'motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2',
            item.tone === 'error' && 'border-destructive/40',
          )}
        >
          <span className={cn('min-w-0 flex-1', item.tone === 'error' && 'text-destructive')}>{item.message}</span>
          {item.action && (
            <button
              type="button"
              onClick={() => runToastAction(item.id)}
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
