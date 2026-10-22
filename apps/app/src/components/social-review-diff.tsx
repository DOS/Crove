// What changed since the last review (#944): for each channel waiting for review whose content changed after its last
// decision, the text added and removed, the link, the images or videos added and removed, and the settings that changed.
// Nothing shows on a first review or when the content is the one decided on.
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'use-intl';
import { useFormat } from '../i18n/provider.tsx';
import { orpc } from '../lib/api.ts';
import { reviewDiff, type DiffPart, type DiffMedia, type ReviewDiff } from '../lib/social-review-diff.ts';
import { Thumb } from './social-media.tsx';

type Diff = Awaited<ReturnType<typeof orpc.social.posts.reviewDiff.call>>;
type Decision = NonNullable<Diff['variants'][number]['lastDecision']>;

// Added text on the success tint, removed text struck through on the destructive tint; each with words for screen
// readers, which do not announce the colors.
export function DiffText({ parts }: { parts: readonly DiffPart[] }) {
  const t = useTranslations('social.reviewDiff');
  return (
    <>
      {parts.map((p, i) =>
        p.kind === 'added' ? (
          <ins key={i} className="rounded-sm bg-success/15 text-foreground no-underline">
            <span className="sr-only">{t('addedSr')} </span>
            {p.text}
          </ins>
        ) : p.kind === 'removed' ? (
          <del key={i} className="rounded-sm bg-destructive/10 text-muted-foreground line-through decoration-destructive">
            <span className="sr-only">{t('removedSr')} </span>
            {p.text}
          </del>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  );
}

function MediaRow({ list, label, faded = false }: { list: readonly DiffMedia[]; label: string; faded?: boolean }) {
  const t = useTranslations('social.reviewDiff');
  if (list.length === 0) return null;
  return (
    <div className="space-y-1">
      <p>{label}</p>
      <ul className="flex flex-wrap gap-2">
        {list.map((m) => (
          <li key={m.fileId} className={faded ? 'opacity-60' : undefined}>
            <Thumb fileId={m.fileId} alt={m.altText ?? t('noAlt')} {...(m.mime ? { mime: m.mime } : {})} className="size-14" />
          </li>
        ))}
      </ul>
    </div>
  );
}

// The changes of one channel's content, as reviewDiff found them; the version history (#1021) shows them too.
export function ContentChanges({ diff }: { diff: ReviewDiff }) {
  const t = useTranslations('social.reviewDiff');
  const none = t('none');
  return (
    <div className="space-y-2 text-xs text-muted-foreground">
      {diff.title && (
        <div>
          <p className="font-medium text-foreground">{t('fieldTitle')}</p>
          <p className="text-sm text-foreground">
            <DiffText parts={diff.title} />
          </p>
        </div>
      )}
      {diff.body && (
        <div>
          <p className="font-medium text-foreground">{t('fieldBody')}</p>
          <p className="rounded-lg border bg-muted/40 p-3 text-sm whitespace-pre-wrap break-words text-foreground">
            <DiffText parts={diff.body} />
          </p>
        </div>
      )}
      {diff.link && (
        <div>
          <p className="font-medium text-foreground">{t('fieldLink')}</p>
          <p className="break-all">
            <del className="text-muted-foreground line-through decoration-destructive">
              <span className="sr-only">{t('removedSr')} </span>
              {diff.link.before ?? none}
            </del>
            {' → '}
            <ins className="text-foreground no-underline">
              <span className="sr-only">{t('addedSr')} </span>
              {diff.link.after ?? none}
            </ins>
          </p>
        </div>
      )}
      {diff.media && (
        <div className="space-y-1.5">
          <p className="font-medium text-foreground">{t('fieldMedia')}</p>
          <MediaRow list={diff.media.added} label={t('mediaAdded', { count: diff.media.added.length })} />
          <MediaRow list={diff.media.removed} label={t('mediaRemoved', { count: diff.media.removed.length })} faded />
          {diff.media.altChanged.map((m) => (
            <p key={m.fileId}>{t('altChanged', { before: m.before || t('noAlt'), after: m.after || t('noAlt') })}</p>
          ))}
          {diff.media.reordered && <p>{t('mediaReordered')}</p>}
        </div>
      )}
      {diff.settings.length > 0 && (
        <div>
          <p className="font-medium text-foreground">{t('fieldSettings')}</p>
          <ul className="space-y-0.5">
            {diff.settings.map((s) => (
              <li key={s.key} className="break-all">
                <code className="text-foreground">{s.key}</code>: {s.before ?? none} → {s.after ?? none}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// variants: the channels in review, with their name and the revision and hash the panel shows, so the diff is read again
// whenever their content moves.
export function ReviewChanges({ postId, variants }: { postId: string; variants: ReadonlyArray<{ id: string; name: string; revision: number; contentHash: string }> }) {
  const t = useTranslations('social.reviewDiff');
  const f = useFormat();
  const options = orpc.social.posts.reviewDiff.queryOptions({ input: { postId } });
  const diff = useQuery({ ...options, queryKey: [...options.queryKey, variants.map((v) => `${v.id}:${v.revision}:${v.contentHash}`).join(',')], enabled: variants.length > 0 });
  const shown = variants.flatMap((v) => {
    const row = diff.data?.variants.find((x) => x.variantId === v.id);
    const last = row?.lastDecision;
    if (!row || !last?.changed) return [];
    const changes = reviewDiff(last.content, row.current);
    return changes ? [{ ...v, last, changes }] : [];
  });
  if (shown.length === 0) return null;
  const since = (last: Decision) => t('since', { who: last.decidedByName ?? t('formerMember'), decision: t(`decision.${last.decision}`), when: f.dateTime(last.at) });
  return (
    <section className="space-y-3 rounded-lg border p-3" aria-label={t('title')}>
      <p className="text-sm font-medium text-foreground">{t('title')}</p>
      {shown.map((v) => (
        <div key={v.id} className="space-y-2">
          <p className="text-xs text-subtle-foreground">
            <span className="font-medium text-foreground">{v.name}</span>
            {' · '}
            {since(v.last)}
          </p>
          <ContentChanges diff={v.changes} />
        </div>
      ))}
    </section>
  );
}
