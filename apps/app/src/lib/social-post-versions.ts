// The version history of a post (#1021): what restoring a version would change, per channel. Pure, so the panel only
// draws the result.
import { reviewDiff, type ReviewContent, type ReviewDiff } from './social-review-diff.ts';

// Channels that are history: restoring never changes them in place.
export const HISTORY_STATUSES: readonly string[] = ['published', 'cancelled', 'removed'];

export interface CurrentChannel {
  variantId: string;
  name: string;
  status: string;
  content: ReviewContent;
}

export interface VersionChannel {
  variantId: string;
  content: ReviewContent;
}

export interface RestorePreview {
  // The channels restoring would change, with the change from their content now to the version's.
  changes: Array<{ variantId: string; name: string; diff: ReviewDiff }>;
  // Channels of the version that are history now and keep what they have.
  kept: number;
  // Those of them whose content was different in the version (a published channel whose text was corrected on its
  // platform since, #1223): the change from their content now to the version's, shown and never restored.
  history: Array<{ variantId: string; name: string; diff: ReviewDiff }>;
}

// Channels added after the version are not in it and keep their content; channels of the version taken off the post are
// gone and ignored.
export function restorePreview(current: readonly CurrentChannel[], version: readonly VersionChannel[]): RestorePreview {
  const saved = new Map(version.map((v) => [v.variantId, v.content]));
  const changes: RestorePreview['changes'] = [];
  const history: RestorePreview['history'] = [];
  let kept = 0;
  for (const c of current) {
    const content = saved.get(c.variantId);
    if (!content) continue;
    const diff = reviewDiff(c.content, content);
    if (HISTORY_STATUSES.includes(c.status)) {
      kept++;
      if (diff && c.status !== 'cancelled') history.push({ variantId: c.variantId, name: c.name, diff });
      continue;
    }
    if (diff) changes.push({ variantId: c.variantId, name: c.name, diff });
  }
  return { changes, kept, history };
}
