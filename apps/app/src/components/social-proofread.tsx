// An AI proofread of a text (#1167): what the fix would change, as the review panel's word diff (#944), with Áp dụng to
// take it into the text (the post is then AI-assisted, as with any accepted rewrite) and Bỏ qua to leave it.
import { useTranslations } from 'use-intl';
import { Button } from '@crove/ui/components/button';
import { diffText, type DiffPart } from '../lib/social-review-diff.ts';
import { DiffText } from './social-review-diff.tsx';

interface Content {
  text: string;
  title: string | null;
}

const changed = (parts: readonly DiffPart[]) => parts.some((p) => p.kind !== 'same');

// The changes of a proofread, the text's and the title's (null when that one is unchanged); null when it changed
// nothing. White space around the whole text does not count: the server trims it.
export function proofreadDiff(before: Content, after: Content): { body: DiffPart[] | null; title: DiffPart[] | null } | null {
  const body = diffText(before.text.trim(), after.text.trim());
  const title = diffText((before.title ?? '').trim(), (after.title ?? '').trim());
  if (!changed(body) && !changed(title)) return null;
  return { body: changed(body) ? body : null, title: changed(title) ? title : null };
}

// outdated: the text was typed on since the ask, so the fix no longer applies.
export function ProofreadProposal({ before, after, outdated, onApply, onDiscard }: { before: Content; after: Content; outdated: boolean; onApply: () => void; onDiscard: () => void }) {
  const t = useTranslations('social');
  const diff = proofreadDiff(before, after);
  if (!diff) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm text-foreground">{t('aiProofreadClean')}</p>
        <Button variant="ghost" size="sm" onClick={onDiscard}>
          {t('aiRewriteDrop')}
        </Button>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {diff.title && (
        <p className="text-sm font-medium text-foreground">
          <DiffText parts={diff.title} />
        </p>
      )}
      {diff.body && (
        <p className="rounded-lg border bg-muted/40 p-3 text-sm whitespace-pre-wrap [overflow-wrap:anywhere] text-foreground">
          <DiffText parts={diff.body} />
        </p>
      )}
      <p className="text-xs text-subtle-foreground">{t(outdated ? 'aiRewriteOutdated' : 'aiProofreadHint')}</p>
      <div className="flex gap-2">
        <Button size="sm" disabled={outdated} onClick={onApply}>
          {t('aiProofreadApply')}
        </Button>
        <Button variant="ghost" size="sm" onClick={onDiscard}>
          {t('aiRewriteDrop')}
        </Button>
      </div>
    </div>
  );
}
