// The bar over the Social home lists when posts are selected (#635): approve them, put them in their channels' queues,
// or cancel them. Each post goes through its own command; the result says what was done, what had nothing to do, and
// what was refused and why.
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { ErrorText } from './ui.tsx';
import { client, errorMessage, queryClient } from '../lib/api.ts';
import { runBulk, type BulkAction, type BulkPost, type BulkRequest, type BulkResult } from '../lib/social-bulk.ts';

const send = (r: BulkRequest) =>
  r.action === 'approve'
    ? client.social.variants.decide({ postId: r.postId, decision: 'approved', variants: r.variants })
    : r.action === 'queue'
      ? client.social.variants.schedule({ postId: r.postId, variantIds: r.variantIds, queue: true })
      : client.social.variants.cancel({ variantIds: r.variantIds });

export function BulkBar({
  posts,
  actions,
  canDecide,
  excerptOf,
  onClear,
}: {
  posts: BulkPost[];
  actions: readonly BulkAction[];
  canDecide: boolean;
  excerptOf: (postId: string) => string;
  onClear: () => void;
}) {
  const t = useTranslations('social.bulk');
  const [result, setResult] = useState<{ action: BulkAction; result: BulkResult } | null>(null);
  // The posts' text as it was when the action ran: a refused post may have left the list since.
  const [labels, setLabels] = useState<Map<string, string>>(new Map());
  const run = useMutation({
    mutationFn: async (action: BulkAction) => ({ action, result: await runBulk(posts, action, canDecide, send) }),
    onSuccess: (r) => {
      setResult(r);
      onClear();
      void queryClient.invalidateQueries();
    },
  });
  const start = (action: BulkAction) => {
    if (action === 'cancel' && !window.confirm(t('confirmCancel', { count: posts.length }))) return;
    setResult(null);
    setLabels(new Map(posts.map((p) => [p.id, excerptOf(p.id)])));
    run.mutate(action);
  };
  return (
    <div className="space-y-2">
      {posts.length > 0 && (
        <Card className="flex flex-wrap items-center gap-2 p-3">
          <span className="text-sm text-foreground">{t('selected', { count: posts.length })}</span>
          {actions.map((a) => (
            <Button key={a} size="sm" variant={a === 'cancel' ? 'outline' : 'default'} disabled={run.isPending} onClick={() => start(a)}>
              {t(`action.${a}`)}
            </Button>
          ))}
          <Button size="sm" variant="ghost" disabled={run.isPending} onClick={onClear}>
            {t('clear')}
          </Button>
        </Card>
      )}
      {run.error && <ErrorText>{errorMessage(run.error)}</ErrorText>}
      {result && (
        <Card className="block space-y-1 p-3 text-sm">
          <p className="text-foreground">{t('result', { action: t(`action.${result.action}`), done: result.result.done.length, skipped: result.result.skipped.length, refused: result.result.refused.length })}</p>
          {result.result.refused.map((r) => (
            <p key={r.postId} className="text-xs text-muted-foreground">
              <span className="text-foreground">{labels.get(r.postId) ?? excerptOf(r.postId)}</span>: <span className="text-warning">{errorMessage(r.error)}</span>
            </p>
          ))}
        </Card>
      )}
    </div>
  );
}
