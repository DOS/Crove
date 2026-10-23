// The version history of a post (#1021): every save of its content kept as a version, newest first, with what restoring
// one would change per channel (the diff of #944) and, for members who may edit, a restore after a confirmation. A
// restore is a new edit: channels that change go back to draft and are reviewed again; published ones keep their content.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { ContentChanges } from './social-review-diff.tsx';
import { TickedChecks } from './social-review-checklist.tsx';
import { ErrorText, Notice, Spinner } from './ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { client, errorMessage, orpc } from '../lib/api.ts';
import { restorePreview, type CurrentChannel } from '../lib/social-post-versions.ts';

type Versions = Awaited<ReturnType<typeof orpc.social.posts.versions.call>>;
type Version = Versions['versions'][number];

function VersionEntry({
  version,
  current,
  newest,
  canRestore,
  editing,
  restoring,
  onRestore,
}: {
  version: Version;
  current: readonly CurrentChannel[];
  newest: boolean;
  canRestore: boolean;
  editing: boolean;
  restoring: boolean;
  onRestore: () => void;
}) {
  const t = useTranslations('social.versions');
  const f = useFormat();
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const preview = restorePreview(current, version.variants);
  const same = preview.changes.length === 0;
  const who =
    version.createdBy === null ? t('before', { when: f.dateTime(version.createdAt) }) : t('by', { who: version.createdByName ?? t('formerMember'), when: f.dateTime(version.createdAt) });
  return (
    <li className="space-y-2 border-l-2 border-border py-1 pl-3 text-sm">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-medium text-foreground">{t('version', { number: version.number })}</span>
        {newest && same && <Badge variant="secondary">{t('current')}</Badge>}
        <span className="text-xs text-subtle-foreground">{who}</span>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="ghost" size="sm" aria-expanded={open} onClick={() => setOpen(!open)}>
          {t(open ? 'hide' : 'show')}
        </Button>
        {canRestore && !same && !confirming && (
          <Button variant="outline" size="sm" disabled={editing || restoring} onClick={() => setConfirming(true)}>
            {t('restore')}
          </Button>
        )}
      </div>
      {canRestore && !same && editing && <p className="text-xs text-subtle-foreground">{t('saveFirst')}</p>}
      {confirming && (
        <div className="space-y-2 rounded-lg border border-warning/40 bg-warning/10 p-3">
          <p className="text-sm text-foreground">{t('confirm', { number: version.number })}</p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={editing || restoring}
              onClick={() => {
                setConfirming(false);
                onRestore();
              }}
            >
              {t('confirmAction')}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
              {t('cancel')}
            </Button>
          </div>
        </div>
      )}
      {open && (
        <div className="space-y-3">
          {same ? (
            <p className="text-xs text-muted-foreground">{t('same')}</p>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">{t('changesIntro')}</p>
              {preview.changes.map((c) => (
                <div key={c.variantId} className="space-y-1">
                  <p className="text-xs font-medium text-foreground">{c.name}</p>
                  <ContentChanges diff={c.diff} />
                </div>
              ))}
            </>
          )}
          {preview.kept > 0 && <p className="text-xs text-subtle-foreground">{t('kept', { count: preview.kept })}</p>}
          {/* The approvals given to this version's content, with the review checklist items each reviewer ticked (#1105). */}
          {version.variants
            .filter((v) => v.approvals.length > 0)
            .map((v) => (
              <div key={`approvals-${v.variantId}`} className="space-y-1">
                <p className="text-xs font-medium text-foreground">{current.find((c) => c.variantId === v.variantId)?.name ?? ''}</p>
                <ul className="space-y-1.5">
                  {v.approvals.map((a, i) => (
                    <li key={i} className="space-y-0.5">
                      <p className="text-xs text-muted-foreground">{t('approvedBy', { who: a.decidedByName ?? t('formerMember'), when: f.dateTime(a.at) })}</p>
                      <TickedChecks items={a.checklist} />
                    </li>
                  ))}
                </ul>
              </div>
            ))}
        </div>
      )}
    </li>
  );
}

// current: the post's channels with their content now, as the post view gives it. editing: there are unsaved edits on
// the page, which a restore would overwrite, so it waits for them to be saved or dropped.
export function PostVersions({
  postId,
  revision,
  variantRevisions,
  current,
  canWrite,
  editing,
  onRestored,
}: {
  postId: string;
  revision: number;
  // Each channel's revision as the page shows it, so a channel edited elsewhere since refuses the restore.
  variantRevisions: Record<string, number>;
  current: readonly CurrentChannel[];
  canWrite: boolean;
  editing: boolean;
  onRestored: () => void;
}) {
  const t = useTranslations('social.versions');
  const versions = useQuery(orpc.social.posts.versions.queryOptions({ input: { postId } }));
  const [done, setDone] = useState<number | null>(null);
  const restore = useMutation({
    mutationFn: (v: Version) => client.social.posts.restoreVersion({ postId, versionId: v.id, revision, variantRevisions }).then(() => v.number),
    onSuccess: (number) => {
      setDone(number);
      onRestored();
    },
  });
  const list = versions.data?.versions ?? [];
  return (
    <Card className="block space-y-3 p-4" aria-label={t('title')}>
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">{t('title')}</p>
        <p className="text-xs text-subtle-foreground">{t('hint')}</p>
      </div>
      {versions.isPending && <Spinner />}
      {versions.error && <ErrorText>{errorMessage(versions.error)}</ErrorText>}
      {versions.data && list.length === 0 && <p className="text-xs text-muted-foreground">{t('empty')}</p>}
      {done !== null && <Notice>{t('restored', { number: done })}</Notice>}
      {restore.error && <ErrorText>{errorMessage(restore.error)}</ErrorText>}
      {list.length > 0 && (
        <ol className="space-y-3">
          {list.map((v, i) => (
            <VersionEntry
              key={v.id}
              version={v}
              current={current}
              newest={i === 0}
              canRestore={canWrite}
              editing={editing}
              restoring={restore.isPending}
              onRestore={() => {
                setDone(null);
                restore.mutate(v);
              }}
            />
          ))}
        </ol>
      )}
    </Card>
  );
}
