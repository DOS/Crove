// The review checklist (#1105): the org's list on the Channels page, where owners and admins write up to 10 short items
// a reviewer must check before approving, for every channel or for one; the ticks in the review panel, which the
// Approve button needs; and the items an approval was given with, in the post's activity and versions.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Checkbox } from '@crove/ui/components/checkbox';
import { Input } from '@crove/ui/components/input';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { ErrorText, Notice } from './ui.tsx';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';
import { providerName } from '../lib/social.ts';
import {
  SOCIAL_REVIEW_CHECKS_MAX,
  SOCIAL_REVIEW_CHECK_LABEL_MAX,
  checklistItems,
  draftInput,
  draftOf,
  draftProblem,
  moveItem,
  sameAsSaved,
  type CheckItem,
  type DraftItem,
} from '../lib/social-review-checklist.ts';

type Channel = { id: string; provider: string; displayName: string };

const refresh = () => {
  void queryClient.invalidateQueries({ queryKey: orpc.social.reviewChecklist.list.key() });
  // Each channel of a post view carries its checklist.
  void queryClient.invalidateQueries({ queryKey: orpc.social.posts.key() });
};

let nextKey = 0;
const newKey = () => `new-${++nextKey}`;

export function ReviewChecklistCard({ channels, canEdit }: { channels: readonly Channel[]; canEdit: boolean }) {
  const t = useTranslations('social.reviewChecklist');
  const list = useQuery(orpc.social.reviewChecklist.list.queryOptions({ input: {} }));
  const saved = list.data?.items ?? [];
  const [draft, setDraft] = useState<DraftItem[] | null>(null);
  const [done, setDone] = useState(false);
  const save = useMutation({
    mutationFn: (items: readonly DraftItem[]) => client.social.reviewChecklist.set(draftInput(items)),
    onSuccess: () => {
      setDraft(null);
      setDone(true);
      refresh();
    },
  });
  const names = new Map(channels.map((c) => [c.id, `${providerName(c.provider)} · ${c.displayName}`]));
  const editing = draft ?? draftOf(saved);
  const problem = draftProblem(editing);
  const changed = draft !== null && !sameAsSaved(draft, saved);
  const change = (next: DraftItem[]) => {
    setDone(false);
    setDraft(next);
  };
  const scopeOf = (connectionId: string | null) => (connectionId === null ? t('allChannels') : (names.get(connectionId) ?? t('goneChannel')));

  return (
    <Card className="block space-y-3 p-4">
      <div>
        <p className="text-sm font-medium text-foreground">{t('title')}</p>
        <p className="text-xs text-subtle-foreground">{t('hint', { max: SOCIAL_REVIEW_CHECKS_MAX })}</p>
      </div>
      {list.error && <ErrorText>{errorMessage(list.error)}</ErrorText>}
      {!canEdit ? (
        <>
          {!list.isLoading && saved.length === 0 && <p className="text-xs text-subtle-foreground">{t('empty')}</p>}
          {saved.length > 0 && (
            <ol className="list-decimal space-y-1 pl-5 text-sm">
              {saved.map((c) => (
                <li key={c.id} className="[overflow-wrap:anywhere]">
                  <span className="text-foreground">{c.label}</span>
                  <span className="text-xs text-subtle-foreground"> · {scopeOf(c.connectionId)}</span>
                </li>
              ))}
            </ol>
          )}
          <p className="text-xs text-subtle-foreground">{t('adminsOnly')}</p>
        </>
      ) : (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (changed && problem === null && !save.isPending) save.mutate(editing);
          }}
        >
          {!list.isLoading && editing.length === 0 && <p className="text-xs text-subtle-foreground">{t('empty')}</p>}
          {editing.length > 0 && (
            <ol className="space-y-2">
              {editing.map((d, i) => (
                <li key={d.key} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,14rem)_auto]">
                  <Input
                    value={d.label}
                    maxLength={SOCIAL_REVIEW_CHECK_LABEL_MAX}
                    aria-label={t('itemLabel', { n: i + 1 })}
                    placeholder={t('itemPlaceholder')}
                    onChange={(e) => change(editing.map((x) => (x.key === d.key ? { ...x, label: e.target.value } : x)))}
                  />
                  <NativeSelect
                    size="sm"
                    className="w-full"
                    aria-label={t('itemScope', { n: i + 1 })}
                    value={d.connectionId ?? ''}
                    onChange={(e) => change(editing.map((x) => (x.key === d.key ? { ...x, connectionId: e.target.value === '' ? null : e.target.value } : x)))}
                  >
                    <NativeSelectOption value="">{t('allChannels')}</NativeSelectOption>
                    {channels.map((c) => (
                      <NativeSelectOption key={c.id} value={c.id}>
                        {names.get(c.id)}
                      </NativeSelectOption>
                    ))}
                    {d.connectionId !== null && !names.has(d.connectionId) && <NativeSelectOption value={d.connectionId}>{t('goneChannel')}</NativeSelectOption>}
                  </NativeSelect>
                  <div className="flex gap-1">
                    <Button type="button" variant="ghost" size="icon-sm" disabled={i === 0} aria-label={t('moveUp', { n: i + 1 })} onClick={() => change(moveItem(editing, i, -1))}>
                      ↑
                    </Button>
                    <Button type="button" variant="ghost" size="icon-sm" disabled={i === editing.length - 1} aria-label={t('moveDown', { n: i + 1 })} onClick={() => change(moveItem(editing, i, 1))}>
                      ↓
                    </Button>
                    <Button type="button" variant="ghost" size="sm" onClick={() => change(editing.filter((x) => x.key !== d.key))}>
                      {t('remove')}
                    </Button>
                  </div>
                </li>
              ))}
            </ol>
          )}
          <p className="text-xs text-subtle-foreground tabular-nums">{t('count', { count: editing.length, max: SOCIAL_REVIEW_CHECKS_MAX })}</p>
          {problem !== null && problem !== 'empty' && <p className="text-xs text-warning">{t(`problem.${problem}`, { max: SOCIAL_REVIEW_CHECK_LABEL_MAX, items: SOCIAL_REVIEW_CHECKS_MAX })}</p>}
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" disabled={editing.length >= SOCIAL_REVIEW_CHECKS_MAX} onClick={() => change([...editing, { key: newKey(), connectionId: null, label: '' }])}>
              {t('add')}
            </Button>
            <Button type="submit" size="sm" disabled={!changed || problem !== null || save.isPending}>
              {t('save')}
            </Button>
            {changed && (
              <Button type="button" variant="ghost" size="sm" disabled={save.isPending} onClick={() => setDraft(null)}>
                {t('discard')}
              </Button>
            )}
          </div>
          {changed && problem === 'empty' && <p className="text-xs text-subtle-foreground">{t('problem.empty')}</p>}
          {changed && <p className="text-xs text-subtle-foreground">{t('saveNote')}</p>}
          {done && !changed && <Notice>{t('saved')}</Notice>}
          {save.error && <ErrorText>{errorMessage(save.error)}</ErrorText>}
        </form>
      )}
    </Card>
  );
}

/**
 * The review panel's checklist: every item the channels being approved need, each once; an item of one channel says
 * which. The parent keeps the ticked ids and sends each channel's own.
 */
export function ReviewChecklistTicks({
  variants,
  names,
  ticked,
  onChange,
}: {
  variants: ReadonlyArray<{ connectionId: string; checklist: readonly CheckItem[] }>;
  names: ReadonlyMap<string, string>;
  ticked: ReadonlySet<string>;
  onChange: (next: Set<string>) => void;
}) {
  const t = useTranslations('social.reviewChecklist');
  // A tick of an item that is gone since (the list changed) is never sent: each channel sends its own items' ticks.
  const items = checklistItems(variants);
  if (items.length === 0) return null;
  const left = items.filter((c) => !ticked.has(c.id)).length;
  return (
    <fieldset className="space-y-1.5 rounded-lg border border-border p-3">
      <legend className="px-1 text-xs font-medium text-foreground">{t('reviewLegend')}</legend>
      {items.map((c) => (
        <label key={c.id} className="flex items-start gap-2 text-sm text-foreground">
          <Checkbox
            className="mt-0.5"
            checked={ticked.has(c.id)}
            onCheckedChange={(on) => {
              const next = new Set(ticked);
              if (on === true) next.add(c.id);
              else next.delete(c.id);
              onChange(next);
            }}
          />
          <span className="min-w-0 [overflow-wrap:anywhere]">
            {c.label}
            {c.connectionId !== null && <span className="text-xs text-subtle-foreground"> · {t('onlyOn', { channel: names.get(c.connectionId) ?? t('goneChannel') })}</span>}
          </span>
        </label>
      ))}
      <p className="text-xs text-subtle-foreground" aria-live="polite">
        {left > 0 ? t('reviewLeft', { count: left }) : t('reviewDone')}
      </p>
    </fieldset>
  );
}

/** The items an approval was given with, as the database copied them then. */
export function TickedChecks({ items }: { items: ReadonlyArray<{ id: string; label: string }> | null }) {
  const t = useTranslations('social.reviewChecklist');
  if (!items || items.length === 0) return null;
  return (
    <div className="text-xs text-muted-foreground">
      <p>{t('ticked')}</p>
      <ul className="space-y-0.5">
        {items.map((c) => (
          <li key={c.id} className="flex items-start gap-1.5 [overflow-wrap:anywhere]">
            <span aria-hidden="true" className="text-success">
              ✓
            </span>
            <span>{c.label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
