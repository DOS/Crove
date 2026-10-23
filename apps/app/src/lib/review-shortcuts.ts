// The one key listener of the review shortcuts (#315, #1221), shared by the AI Inbox and Social posts (#1230): J or N
// the next item, K or P the previous one, A approve, E edit, R reject or ask for changes. reviewShortcut decides which
// key means what and ignores keys typed in a field, with a modifier or held down.
import { useEffect, useRef } from 'react';
import { reviewShortcut, type ReviewAction } from './review.ts';

export type ReviewHandlers = Partial<Record<ReviewAction, () => void>>;

/**
 * Listens for the review shortcuts on the window and runs the handler the key asks for, if the page gave one now.
 * The handlers are read on each key press through a ref, so they always see the latest render; a key with no handler
 * is left alone (the browser's own meaning stays).
 */
export function useReviewShortcuts(handlers: ReviewHandlers): void {
  const current = useRef<ReviewHandlers>({});
  useEffect(() => {
    current.current = handlers;
  });
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const action = reviewShortcut(event);
      const handler = action ? current.current[action] : undefined;
      if (!handler) return;
      event.preventDefault();
      handler();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
