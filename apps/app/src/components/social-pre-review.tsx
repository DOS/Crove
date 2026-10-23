// What social.post.pre_review found on the channels waiting for review (#1193), in the post page's review panel. The
// content agent's task and its escalation say only how many points there are, since every member reads tasks, also
// one limited to other channels (#1081); the reviewer reads the points here. The query is channel-scoped, and its key
// follows each waiting channel's revision and content, so an edit reads it again.
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'use-intl';
import { orpc } from '../lib/api.ts';

export function PreReviewList({ findings }: { findings: readonly string[] }) {
  const t = useTranslations('social.preReview');
  return (
    <section className="space-y-1.5 rounded-lg border p-3" aria-label={t('title')}>
      <p className="text-sm font-medium text-foreground">{t('title')}</p>
      {findings.length === 0 ? (
        <p className="text-xs text-subtle-foreground">{t('none')}</p>
      ) : (
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
          {findings.map((f, i) => (
            <li key={i} className="[overflow-wrap:anywhere]">
              {f}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function PreReviewFindings({ postId, waiting }: { postId: string; waiting: ReadonlyArray<{ id: string; revision: number; contentHash: string }> }) {
  const options = orpc.social.posts.preReview.queryOptions({ input: { postId } });
  const review = useQuery({ ...options, queryKey: [...options.queryKey, waiting.map((v) => `${v.id}:${v.revision}:${v.contentHash}`).join(',')], enabled: waiting.length > 0 });
  if (waiting.length === 0 || !review.data) return null;
  return <PreReviewList findings={review.data.findings} />;
}
