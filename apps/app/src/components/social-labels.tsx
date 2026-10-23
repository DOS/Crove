// Labels for posts (#639): a label's chip, a post's chips, the colour choice and the picker on the post screen. A
// post's labels save at once on their own; they are not part of its text, so they never send it back to review.
// A campaign label (#1169) shows its dates and tags, and the post screen says where its channels do not follow them.
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { campaignFindings, isCampaign, type CampaignChannel, type CampaignFinding } from '@crove/mod-social/contract';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Input } from '@crove/ui/components/input';
import { cn } from '@crove/ui/lib/utils';
import { ErrorText, Spinner } from './ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
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

type Dates = Pick<SocialLabel, 'startsOn' | 'endsOn'>;
// A campaign's dates as words: both ends, or the open one; '' without dates.
function usePeriod() {
  const t = useTranslations('social.labels');
  const f = useFormat();
  return (d: Dates) =>
    d.startsOn && d.endsOn ? t('period', { from: f.date(d.startsOn), to: f.date(d.endsOn) }) : d.startsOn ? t('periodFrom', { from: f.date(d.startsOn) }) : d.endsOn ? t('periodTo', { to: f.date(d.endsOn) }) : '';
}

// A campaign label's dates and tags in one line (#1169); nothing for a plain label.
export function CampaignLine({ label }: { label: Pick<SocialLabel, 'startsOn' | 'endsOn' | 'utmCampaign' | 'utmMedium'> }) {
  const t = useTranslations('social.labels');
  const period = usePeriod()(label);
  const parts = [period, label.utmCampaign ? t('utmLine', { campaign: label.utmCampaign, medium: label.utmMedium ?? 'social' }) : ''].filter(Boolean);
  if (parts.length === 0) return null;
  return <p className="text-xs text-muted-foreground">{t('campaignLine', { details: parts.join(' · ') })}</p>;
}

// Where a post's channels do not follow its campaign labels (#1169), as social.post.pre_review tells the reviewer: a
// link with another UTM campaign, or a time outside the campaign's dates. Nothing for plain labels.
export function CampaignFindings({ labelIds, labels, channels, timeZone }: { labelIds: readonly string[]; labels: readonly SocialLabel[]; channels: readonly CampaignChannel[]; timeZone: string }) {
  const t = useTranslations('social.labels');
  const f = useFormat();
  const period = usePeriod();
  const found = campaignFindings(labelsOf(labelIds, labels).filter(isCampaign), channels, timeZone);
  if (found.length === 0) return null;
  const text = (x: CampaignFinding) =>
    x.kind === 'utm_campaign'
      ? x.actual === null
        ? t('findingUtmMissing', { channel: x.channel, label: x.label, expected: x.expected })
        : t('findingUtm', { channel: x.channel, label: x.label, expected: x.expected, actual: x.actual })
      : t('findingDates', { channel: x.channel, label: x.label, day: f.date(x.day), period: period(x) });
  return (
    <div role="status" className="space-y-1 rounded-lg border border-warning/40 bg-warning/5 p-3 text-xs">
      <p className="font-medium text-foreground">{t('findingsTitle')}</p>
      <ul className="list-disc space-y-0.5 ps-4 text-muted-foreground">
        {found.map((x, i) => (
          <li key={`${x.kind}:${x.label}:${x.channel}:${i}`}>{text(x)}</li>
        ))}
      </ul>
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
// onPut: a label was turned on (#1169), so the screen may fill its empty UTM fields from a campaign label; it answers
// whether it did, and the picker then says the change waits to be saved.
export function LabelPicker({
  slug,
  postId,
  labelIds,
  canWrite,
  onPut,
}: {
  slug: string;
  postId: string;
  labelIds: readonly string[];
  canWrite: boolean;
  onPut?: (label: SocialLabel) => boolean;
}) {
  const t = useTranslations('social.labels');
  const labels = useLabels();
  const [name, setName] = useState('');
  const [full, setFull] = useState(false);
  const [prefilled, setPrefilled] = useState<string | null>(null);
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
  const all = labels.data ?? [];
  const toggle = (id: string) => {
    const next = toggleLabel(current, id);
    setFull(next === null);
    if (!next) return;
    const label = all.find((l) => l.id === id);
    // A campaign label fills the post's UTM fields only once it is on the post.
    save.mutate(next, { onSuccess: () => label && next.includes(id) && onPut?.(label) && setPrefilled(label.name) });
  };
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
          {prefilled && (
            <p role="status" className="text-xs text-muted-foreground">
              {t('prefilled', { name: prefilled })}
            </p>
          )}
          {save.error && <ErrorText>{errorMessage(save.error)}</ErrorText>}
          {create.error && <ErrorText>{errorMessage(create.error)}</ErrorText>}
        </>
      )}
    </Card>
  );
}
