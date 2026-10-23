// Labels for posts (#639): the org's campaigns, clients or topics to sort posts by. Members add labels; owners and
// admins rename, recolour and delete them. A label is put on a post on the post screen. Owners and admins may make a
// label a campaign (#1169): its first and last day and the UTM campaign and medium its posts' links should carry.
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Input } from '@crove/ui/components/input';
import { Label } from '@crove/ui/components/label';
import { CampaignLine, ColorChoice, LabelChip, refreshLabels, useLabels, type SocialLabel } from '../components/social-labels.tsx';
import { Empty, ErrorText, PageHeader, Spinner } from '../components/ui.tsx';
import { client, errorMessage, orpc } from '../lib/api.ts';
import { DEFAULT_LABEL_COLOR, campaignInput, campaignProblem, type CampaignDraft, type LabelColor } from '../lib/social-labels.ts';

// The campaign's fields as typed: '' for none.
type Draft = { name: string; color: LabelColor } & CampaignDraft;
const EMPTY: Draft = { name: '', color: DEFAULT_LABEL_COLOR, startsOn: '', endsOn: '', utmCampaign: '', utmMedium: '' };
const draftOf = (l: SocialLabel): Draft => ({ name: l.name, color: l.color, startsOn: l.startsOn ?? '', endsOn: l.endsOn ?? '', utmCampaign: l.utmCampaign ?? '', utmMedium: l.utmMedium ?? '' });

// campaign: the caller may set the campaign's dates and tags (owners and admins).
function LabelForm({
  id,
  initial,
  campaign,
  onSave,
  onCancel,
  pending,
  error,
}: {
  id: string;
  initial: Draft;
  campaign: boolean;
  onSave: (d: Draft) => void;
  onCancel?: () => void;
  pending: boolean;
  error: unknown;
}) {
  const t = useTranslations('social.labels');
  const [d, setD] = useState(initial);
  const problem = campaign ? campaignProblem(d) : null;
  const valid = d.name.trim() !== '' && problem === null;
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid && !pending) onSave(d);
      }}
    >
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-name`}>{t('name')}</Label>
        <Input id={`${id}-name`} value={d.name} maxLength={50} placeholder={t('namePlaceholder')} className="max-w-sm" onChange={(e) => setD({ ...d, name: e.target.value })} />
      </div>
      <div className="space-y-1.5">
        <p className="text-sm font-medium text-foreground">{t('color')}</p>
        <ColorChoice value={d.color} onChange={(c) => setD({ ...d, color: c })} disabled={pending} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-subtle-foreground">{t('preview')}</span>
        <LabelChip label={{ name: d.name.trim() || t('namePlaceholder'), color: d.color }} />
      </div>
      {campaign && (
        <fieldset className="space-y-2 rounded-lg border p-3">
          <legend className="px-1 text-sm font-medium text-foreground">{t('campaign')}</legend>
          <p className="text-xs text-subtle-foreground">{t('campaignHint')}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor={`${id}-from`} className="text-xs">
                {t('startsOn')}
              </Label>
              <Input id={`${id}-from`} type="date" value={d.startsOn} disabled={pending} onChange={(e) => setD({ ...d, startsOn: e.target.value })} className="w-44" />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${id}-to`} className="text-xs">
                {t('endsOn')}
              </Label>
              <Input id={`${id}-to`} type="date" value={d.endsOn} min={d.startsOn || undefined} disabled={pending} onChange={(e) => setD({ ...d, endsOn: e.target.value })} className="w-44" />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${id}-utm-campaign`} className="text-xs">
                {t('utmCampaign')}
              </Label>
              <Input
                id={`${id}-utm-campaign`}
                value={d.utmCampaign}
                maxLength={100}
                disabled={pending}
                placeholder={t('utmCampaignPlaceholder')}
                onChange={(e) => setD({ ...d, utmCampaign: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${id}-utm-medium`} className="text-xs">
                {t('utmMedium')}
              </Label>
              <Input id={`${id}-utm-medium`} value={d.utmMedium} maxLength={100} disabled={pending} placeholder="social" onChange={(e) => setD({ ...d, utmMedium: e.target.value })} />
            </div>
          </div>
          {problem && <p className="text-xs text-warning">{t(`campaignProblem.${problem}`)}</p>}
        </fieldset>
      )}
      {error ? <ErrorText>{errorMessage(error)}</ErrorText> : null}
      <div className="flex gap-2">
        <Button type="submit" disabled={!valid || pending}>
          {pending ? <Spinner className="text-current" /> : null}
          {t('save')}
        </Button>
        {onCancel && (
          <Button type="button" variant="ghost" onClick={onCancel}>
            {t('cancel')}
          </Button>
        )}
      </div>
    </form>
  );
}

function Row({ label, canManage }: { label: SocialLabel; canManage: boolean }) {
  const t = useTranslations('social.labels');
  const [editing, setEditing] = useState(false);
  const update = useMutation({
    // Only the campaign fields this form changed, so it never writes back what another owner set since it opened.
    mutationFn: (d: Draft) => {
      const before: Record<string, unknown> = campaignInput(draftOf(label));
      const changed = Object.fromEntries(Object.entries(campaignInput(d)).filter(([k, v]) => v !== before[k]));
      return client.social.labels.update({ labelId: label.id, name: d.name.trim(), color: d.color, ...changed });
    },
    onSuccess: () => {
      setEditing(false);
      refreshLabels();
    },
  });
  const remove = useMutation({ mutationFn: () => client.social.labels.remove({ labelId: label.id }), onSuccess: refreshLabels });
  if (editing) {
    return (
      <Card className="block p-4">
        <LabelForm
          id={`label-${label.id}`}
          initial={draftOf(label)}
          campaign={canManage}
          onSave={(d) => update.mutate(d)}
          onCancel={() => setEditing(false)}
          pending={update.isPending}
          error={update.error}
        />
      </Card>
    );
  }
  return (
    <Card className="block space-y-2 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <LabelChip label={label} />
        <span className="text-xs text-subtle-foreground tabular-nums">{t('posts', { count: label.postCount })}</span>
        {canManage && (
          <div className="ml-auto flex gap-1">
            <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
              {t('edit')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={remove.isPending}
              onClick={() => {
                if (window.confirm(t('confirmDelete', { name: label.name, count: label.postCount }))) remove.mutate();
              }}
            >
              {t('delete')}
            </Button>
          </div>
        )}
      </div>
      <CampaignLine label={label} />
      {remove.error && <ErrorText>{errorMessage(remove.error)}</ErrorText>}
    </Card>
  );
}

export function SocialLabelsPage() {
  const { slug } = useParams({ strict: false }) as { slug: string };
  const t = useTranslations('social.labels');
  const me = useQuery(orpc.me.get.queryOptions());
  const role = me.data?.orgs.find((o) => o.slug === slug)?.role;
  const canWrite = role === 'owner' || role === 'admin' || role === 'member';
  const canManage = role === 'owner' || role === 'admin';
  const list = useLabels();
  const [formKey, setFormKey] = useState(0);
  const create = useMutation({
    // A member's form has no campaign fields, so it sends none.
    mutationFn: (d: Draft) => client.social.labels.create({ name: d.name.trim(), color: d.color, ...(canManage ? campaignInput(d) : {}) }),
    onSuccess: () => {
      setFormKey((k) => k + 1);
      refreshLabels();
    },
  });
  return (
    <div className="space-y-4">
      <PageHeader
        title={t('pageTitle')}
        subtitle={t('subtitle')}
        actions={
          <Link to="/o/$slug/social" params={{ slug }} className="inline-flex h-9 items-center px-2.5 text-sm text-muted-foreground hover:text-foreground">
            {t('back')}
          </Link>
        }
      />
      {canWrite && (
        <Card className="block p-4">
          <h3 className="mb-3 text-sm font-medium text-foreground">{t('new')}</h3>
          <LabelForm key={formKey} id="label-new" initial={EMPTY} campaign={canManage} onSave={(d) => create.mutate(d)} pending={create.isPending} error={create.error} />
        </Card>
      )}
      {!canManage && canWrite && <p className="text-xs text-subtle-foreground">{t('membersHint')}</p>}
      {list.isLoading ? (
        <Spinner />
      ) : list.error ? (
        <ErrorText>{errorMessage(list.error)}</ErrorText>
      ) : (list.data ?? []).length === 0 ? (
        <Empty title={t('empty')} hint={t('emptyHint')} />
      ) : (
        <div className="space-y-3">
          {(list.data ?? []).map((l) => (
            <Row key={l.id} label={l} canManage={canManage} />
          ))}
        </div>
      )}
    </div>
  );
}
