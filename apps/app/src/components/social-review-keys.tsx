// Reviewing Social posts by keyboard (#1221), as the AI Inbox does (#315): J or N the next post of the review list, K
// or P the previous one, A approve and open the next post, R request changes; the shortcuts listed in the review
// panel, and the end of the list, "Hết bài chờ duyệt".
import { Link } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';
import { useTranslations } from 'use-intl';
import { buttonVariants } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { reviewShortcut, type ReviewAction } from '../lib/review.ts';

export type ReviewHandlers = Partial<Record<ReviewAction, () => void>>;

/**
 * Listens for the review shortcuts on the window and runs the handler the key asks for, if the page gave one now.
 * The handlers are read on each key press through a ref, so they always see the latest render; a key with no handler
 * is left alone (the browser's own meaning stays). reviewShortcut ignores keys typed in a field and with a modifier.
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

/** The shortcuts, as the review panel lists them. */
export function ReviewKeysHint() {
  const t = useTranslations('social.reviewKeys');
  return (
    <p className="text-xs text-subtle-foreground" data-testid="review-shortcuts">
      {t('shortcuts')}
    </p>
  );
}

/** The end of the review list: no post waits for this reviewer's approval. It takes the focus when it appears. */
export function NoneLeftToReview({ slug }: { slug: string }) {
  const t = useTranslations('social.reviewKeys');
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <Card ref={ref} tabIndex={-1} role="status" className="block space-y-2 border-success/30 bg-success/10 p-4 outline-none" data-testid="review-none-left">
      <p className="text-sm font-medium text-foreground">{t('noneLeft')}</p>
      <p className="text-xs text-muted-foreground">{t('noneLeftHint')}</p>
      <Link to="/o/$slug/social" params={{ slug }} search={{ tab: 'review' }} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
        {t('backToReview')}
      </Link>
    </Card>
  );
}
