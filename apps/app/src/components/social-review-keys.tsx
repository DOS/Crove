// Reviewing Social posts by keyboard (#1221), as the AI Inbox does (#315): J or N the next post of the review list, K
// or P the previous one, A approve and open the next post, R request changes; the shortcuts listed in the review
// panel, and the end of the list, "Hết bài chờ duyệt". The key listener is the AI Inbox's (#1230).
import { Link } from '@tanstack/react-router';
import { useEffect, useId, useRef } from 'react';
import { useTranslations } from 'use-intl';
import { buttonVariants } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';

export { useReviewShortcuts, type ReviewHandlers } from '../lib/review-shortcuts.ts';

/** The shortcuts, as the review panel lists them. */
export function ReviewKeysHint() {
  const t = useTranslations('social.reviewKeys');
  return (
    <p className="text-xs text-subtle-foreground" data-testid="review-shortcuts">
      {t('shortcuts')}
    </p>
  );
}

/**
 * The end of the review list: no post waits for this reviewer's approval. It takes the focus when it appears, which
 * reads it out once; it is a named region rather than a live status, which would read it a second time (#1230).
 */
export function NoneLeftToReview({ slug }: { slug: string }) {
  const t = useTranslations('social.reviewKeys');
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => ref.current?.focus(), []);
  return (
    <Card ref={ref} tabIndex={-1} role="region" aria-labelledby={id} className="block space-y-2 border-success/30 bg-success/10 p-4 outline-none" data-testid="review-none-left">
      <p id={id} className="text-sm font-medium text-foreground">
        {t('noneLeft')}
      </p>
      <p className="text-xs text-muted-foreground">{t('noneLeftHint')}</p>
      <Link to="/o/$slug/social" params={{ slug }} search={{ tab: 'review' }} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
        {t('backToReview')}
      </Link>
    </Card>
  );
}
