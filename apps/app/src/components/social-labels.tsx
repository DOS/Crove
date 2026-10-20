// Labels for posts (#639): a label's chip, a post's chips, the colour choice and the picker on the post screen. A
// post's labels save at once on their own; they are not part of its text, so they never send it back to review.
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Input } from '@crove/ui/components/input';
import { cn } from '@crove/ui/lib/utils';
import { ErrorText, Spinner } from './ui.tsx';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';
import { LABEL_COLORS, LABEL_SWATCH, LABEL_TONE, MAX_LABELS_PER_POST, labelsOf, toggleLabel, type LabelColor } from '../lib/social-labels.ts';

export type SocialLabel = Awaited<ReturnType<typeof client.social.labels.list>>[number];

export function useLabels() {
  return useQuery(orpc.social.labels.list.queryOptions({ input: {} }));
}

// After a label or a post's labels change: the label list (its counts) and every post list and view.
export function refreshLabels() {
  void queryClient.invalidateQueries();
}

export function LabelChip({ label, className }: { label: Pick<SocialLabel, 'name' | 'color'>; className?: string }) {
  return (
    <Badge variant="outline" className={cn(LABEL_TONE[label.color], 'max-w-48', className)} title={label.name}>
      <span className="truncate">{label.name}</span>
    </Badge>
  );
}

// A post's labels as chips, in the org's label order.
export function PostLabels({ ids, labels }: { ids: readonly string[]; labels: readonly SocialLabel[] }) {
  const shown = labelsOf(ids, labels);
  if (shown.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {shown.map((l) => (
        <LabelChip key={l.id} label={l} />
      ))}
    </div>
  );
}

// The palette as swatches; one is chosen.
export function ColorChoice({ value, onChange, disabled }: { value: LabelColor; onChange: (color: LabelColor) => void; disabled?: boolean }) {
  const t = useTranslations('social.labels');
  return (
    <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={t('color')}>
      {LABEL_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={value === c}
          aria-label={t(`colors.${c}`)}
          title={t(`colors.${c}`)}
          disabled={disabled}
          onClick={() => onChange(c)}
          className={cn(
            'size-6 rounded-full border-2 border-transparent transition-shadow focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-50',
            LABEL_SWATCH[c],
            value === c && 'ring-2 ring-foreground ring-offset-2 ring-offset-background',
          )}
        />
      ))}
    </div>
  );
}

// The post screen's labels: every label of the org as a chip to turn on or off, and a quick way to add a new one.
export function LabelPicker({ slug, postId, labelIds, canWrite }: { slug: string; postId: string; labelIds: readonly string[]; canWrite: boolean }) {
  const t = useTranslations('social.labels');
  const labels = useLabels();
  const [name, setName] = useState('');
  const [full, setFull] = useState(false);
  const save = useMutation({
    mutationFn: (ids: string[]) => client.social.posts.setLabels({ postId, labelIds: ids }),
    onSettled: refreshLabels,
  });
  const create = useMutation({
    // The post's labels as shown when the name was submitted; picking is disabled until this settles.
    mutationFn: async ({ newName, ids }: { newName: string; ids: readonly string[] }) => {
      const { labelId } = await client.social.labels.create({ name: newName });
      const next = toggleLabel(ids, labelId);
      if (next) await client.social.posts.setLabels({ postId, labelIds: next });
    },
    onSuccess: () => setName(''),
    onSettled: refreshLabels,
  });
  // Shown from the saved post, or from the change on its way.
  const current = save.isPending && save.variables ? save.variables : labelIds;
  const toggle = (id: string) => {
    const next = toggleLabel(current, id);
    setFull(next === null);
    if (next) save.mutate(next);
  };
  const all = labels.data ?? [];
  const mine = labelsOf(current, all);
  return (
    <Card className="block space-y-3 p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-foreground">{t('title')}</h3>
        <Link to="/o/$slug/social/labels" params={{ slug }} className="text-xs text-link hover:underline">
          {t('manage')}
        </Link>
      </div>
      {labels.isLoading ? (
        <Spinner />
      ) : labels.error ? (
        <ErrorText>{errorMessage(labels.error)}</ErrorText>
      ) : !canWrite ? (
        mine.length > 0 ? <PostLabels ids={current} labels={all} /> : <p className="text-xs text-subtle-foreground">{t('none')}</p>
      ) : (
        <>
          {all.length === 0 ? (
            <p className="text-xs text-subtle-foreground">{t('pickerEmpty')}</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {all.map((l) => {
                const on = current.includes(l.id);
                return (
                  <button
                    key={l.id}
                    type="button"
                    aria-pressed={on}
                    disabled={save.isPending || create.isPending}
                    onClick={() => toggle(l.id)}
                    className="rounded-4xl focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-70"
                  >
                    <LabelChip label={l} className={cn('cursor-pointer', !on && 'border-dashed bg-transparent opacity-60 hover:opacity-100')} />
                  </button>
                );
              })}
            </div>
          )}
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const next = name.trim();
              if (next && !create.isPending && !save.isPending && current.length < MAX_LABELS_PER_POST) create.mutate({ newName: next, ids: current });
            }}
          >
            <Input value={name} maxLength={50} placeholder={t('newPlaceholder')} aria-label={t('newPlaceholder')} onChange={(e) => setName(e.target.value)} className="h-8 max-w-56" />
            <Button type="submit" size="sm" variant="outline" disabled={!name.trim() || create.isPending || save.isPending || current.length >= MAX_LABELS_PER_POST}>
              {create.isPending ? <Spinner className="text-current" /> : null}
              {t('add')}
            </Button>
          </form>
          {full && <p className="text-xs text-warning">{t('tooMany', { max: String(MAX_LABELS_PER_POST) })}</p>}
          {save.error && <ErrorText>{errorMessage(save.error)}</ErrorText>}
          {create.error && <ErrorText>{errorMessage(create.error)}</ErrorText>}
        </>
      )}
    </Card>
  );
}
