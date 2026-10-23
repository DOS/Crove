// The ideas board (#701): ideas for posts before they are posts, in three columns (new, planned, drafted) and an
// archive. Members add, change and move ideas; "Write a draft" opens the composer with the idea's text, link and
// media, and the post saved there is linked to the idea. On a phone the columns stack.
// "Suggest ideas" (#1181) asks the AI for a few ideas from a theme; the member ticks the ones to keep, which are added
// as new ideas marked as AI suggestions. A draft written from one of them is AI-assisted and needs a person's approval.
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { useLocale, useTranslations } from 'use-intl';
import { Button, buttonVariants } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Checkbox } from '@crove/ui/components/checkbox';
import { Input } from '@crove/ui/components/input';
import { Label } from '@crove/ui/components/label';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { Textarea } from '@crove/ui/components/textarea';
import { cn } from '@crove/ui/lib/utils';
import { useChannelScope } from '../components/social-channel-access.tsx';
import { LabelChip, useLabels, type SocialLabel } from '../components/social-labels.tsx';
import { MediaField, Thumb, type MediaItem } from '../components/social-media.tsx';
import { Empty, ErrorText, PageHeader, Spinner } from '../components/ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';
import { getConfig } from '../lib/auth.ts';
import { providerName } from '../lib/social.ts';
import { BOARD_STAGES, OCCASION_MAX, SUGGEST_COUNTS, SUGGEST_DEFAULT_COUNT, THEME_MAX, ideasOccasion, linkHost, type IdeaStage } from '../lib/social-ideas.ts';

type Idea = Awaited<ReturnType<typeof client.social.ideas.list>>['ideas'][number];
type Draft = { title: string; note: string; linkUrl: string; media: MediaItem[]; labelIds: string[] };
const EMPTY: Draft = { title: '', note: '', linkUrl: '', media: [], labelIds: [] };

const refresh = () => void queryClient.invalidateQueries({ queryKey: orpc.social.ideas.key() });
const draftOf = (i: Idea): Draft => ({
  title: i.title,
  note: i.note ?? '',
  linkUrl: i.linkUrl ?? '',
  media: i.media.map((m) => ({ fileId: m.fileId, altText: '', mime: m.mime, sizeBytes: m.sizeBytes, durationMs: m.durationMs, width: m.width, height: m.height })),
  labelIds: i.labelIds,
});
const fieldsOf = (d: Draft) => ({ title: d.title.trim(), note: d.note.trim() || null, linkUrl: d.linkUrl.trim() || null, fileIds: d.media.map((m) => m.fileId), labelIds: d.labelIds });

type Suggestion = Awaited<ReturnType<typeof client.social.ideas.suggest>>['ideas'][number];

// Ideas from the AI (#1181): a theme, an optional label or occasion, how many, and whose voice; the answer is a list to
// pick from, and only the ideas ticked are added to the board (as new ideas marked as AI suggestions, with the label).
function SuggestPanel({ labels, onClose }: { labels: readonly SocialLabel[]; onClose: () => void }) {
  const t = useTranslations('social.ideas.suggest');
  const locale = useLocale();
  const channels = useQuery(orpc.channels.list.queryOptions({ input: {} }));
  // A member limited to some channels (#1081) may take only those channels' voices.
  const scope = useChannelScope();
  const live = (channels.data ?? []).filter((c) => c.status === 'active' && scope.allows(c.id));
  const [theme, setTheme] = useState('');
  const [labelId, setLabelId] = useState('');
  const [occasion, setOccasion] = useState('');
  const [count, setCount] = useState<number>(SUGGEST_DEFAULT_COUNT);
  const [connectionId, setConnectionId] = useState('');
  const [kept, setKept] = useState<number[]>([]);
  // The suggestions already on the board: kept once, never offered again (a retry after a failure saves only the rest).
  const [saved, setSaved] = useState<number[]>([]);
  const label = labels.find((l) => l.id === labelId) ?? null;
  const ask = useMutation({
    mutationFn: () => {
      const forWhat = ideasOccasion(label, occasion);
      return client.social.ideas.suggest({
        theme: theme.trim(),
        count,
        language: locale === 'en' ? 'en' : 'vi',
        ...(forWhat ? { occasion: forWhat } : {}),
        ...(connectionId ? { connectionId } : {}),
      });
    },
    onSuccess: () => {
      setKept([]);
      setSaved([]);
    },
  });
  const ideas: Suggestion[] = ask.data?.ideas ?? [];
  const keep = useMutation({
    mutationFn: async (picked: number[]) => {
      // One at a time, in the order shown; an idea kept before a failure stays on the board and leaves the picks.
      for (const i of [...picked].sort((a, b) => a - b)) {
        const idea = ideas[i];
        if (!idea) continue;
        await client.social.ideas.create({ title: idea.title, note: idea.note, origin: 'ai', ...(label ? { labelIds: [label.id] } : {}) });
        setSaved((s) => [...s, i]);
        setKept((k) => k.filter((x) => x !== i));
      }
    },
    onSettled: refresh,
    onSuccess: onClose,
  });
  const busy = ask.isPending || keep.isPending;
  return (
    <Card className="block space-y-4 p-4" role="region" aria-label={t('title')}>
      <div>
        <h3 className="text-sm font-medium text-foreground">{t('title')}</h3>
        <p className="text-xs text-subtle-foreground">{t('hint')}</p>
      </div>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (theme.trim() && !busy) ask.mutate();
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor="ideas-suggest-theme">{t('theme')}</Label>
          <Textarea id="ideas-suggest-theme" value={theme} maxLength={THEME_MAX} rows={3} placeholder={t('themePlaceholder')} onChange={(e) => setTheme(e.target.value)} />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {labels.length > 0 && (
            <div className="space-y-1.5">
              <Label htmlFor="ideas-suggest-label">{t('label')}</Label>
              <NativeSelect id="ideas-suggest-label" className="w-full" value={labelId} onChange={(e) => setLabelId(e.target.value)}>
                <NativeSelectOption value="">{t('noLabel')}</NativeSelectOption>
                {labels.map((l) => (
                  <NativeSelectOption key={l.id} value={l.id}>
                    {l.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="ideas-suggest-occasion">{t('occasion')}</Label>
            <Input id="ideas-suggest-occasion" value={occasion} maxLength={OCCASION_MAX} placeholder={t('occasionPlaceholder')} onChange={(e) => setOccasion(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ideas-suggest-count">{t('count')}</Label>
            <NativeSelect id="ideas-suggest-count" className="w-full" value={String(count)} onChange={(e) => setCount(Number(e.target.value))}>
              {SUGGEST_COUNTS.map((n) => (
                <NativeSelectOption key={n} value={String(n)}>
                  {t('countOption', { n })}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          {live.length > 0 && (
            <div className="space-y-1.5">
              <Label htmlFor="ideas-suggest-voice">{t('voice')}</Label>
              <NativeSelect id="ideas-suggest-voice" className="w-full" value={connectionId} onChange={(e) => setConnectionId(e.target.value)}>
                <NativeSelectOption value="">{t('voiceOrg')}</NativeSelectOption>
                {live.map((c) => (
                  <NativeSelectOption key={c.id} value={c.id}>
                    {c.displayName} · {providerName(c.provider)}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
          )}
        </div>
        {ask.error ? <ErrorText>{errorMessage(ask.error)}</ErrorText> : null}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={!theme.trim() || busy}>
            {ask.isPending ? <Spinner className="text-current" /> : null}
            {ask.data ? t('again') : t('ask')}
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('close')}
          </Button>
        </div>
      </form>
      {ideas.length > 0 && (
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-foreground">{t('results')}</legend>
          <p className="text-xs text-subtle-foreground">{t('resultsHint')}</p>
          <ul className="space-y-1.5">
            {ideas.map((idea, i) => (
              <li key={`${i}-${idea.title}`}>
                <label className="flex items-start gap-2 rounded-lg border border-dashed p-2 text-sm">
                  <Checkbox className="mt-0.5" checked={kept.includes(i) || saved.includes(i)} disabled={keep.isPending || saved.includes(i)} onCheckedChange={() => setKept(kept.includes(i) ? kept.filter((x) => x !== i) : [...kept, i])} />
                  <span className="min-w-0 space-y-0.5">
                    <span className="block font-medium break-words text-foreground">{idea.title}</span>
                    {idea.note && <span className="block text-xs break-words whitespace-pre-line text-muted-foreground">{idea.note}</span>}
                  </span>
                </label>
              </li>
            ))}
          </ul>
          {keep.error ? <ErrorText>{errorMessage(keep.error)}</ErrorText> : null}
          <Button type="button" disabled={kept.length === 0 || busy} onClick={() => keep.mutate(kept)}>
            {keep.isPending ? <Spinner className="text-current" /> : null}
            {t('keep', { count: kept.length })}
          </Button>
        </fieldset>
      )}
    </Card>
  );
}

function IdeaForm({ id, initial, labels, onSave, onCancel, pending, error }: { id: string; initial: Draft; labels: readonly SocialLabel[]; onSave: (d: Draft) => void; onCancel?: () => void; pending: boolean; error: unknown }) {
  const t = useTranslations('social.ideas');
  const [d, setD] = useState(initial);
  const valid = d.title.trim() !== '';
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid && !pending) onSave(d);
      }}
    >
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-title`}>{t('ideaTitle')}</Label>
        <Input id={`${id}-title`} value={d.title} maxLength={200} placeholder={t('ideaTitlePlaceholder')} onChange={(e) => setD({ ...d, title: e.target.value })} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-note`}>{t('note')}</Label>
        <Textarea id={`${id}-note`} value={d.note} maxLength={5000} rows={3} placeholder={t('notePlaceholder')} onChange={(e) => setD({ ...d, note: e.target.value })} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-link`}>{t('link')}</Label>
        <Input id={`${id}-link`} type="url" value={d.linkUrl} maxLength={2000} placeholder="https://" onChange={(e) => setD({ ...d, linkUrl: e.target.value })} />
      </div>
      <MediaField media={d.media} onChange={(media) => setD({ ...d, media })} disabled={pending} />
      {labels.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-sm font-medium text-foreground">{t('labels')}</p>
          <div className="flex flex-wrap gap-1.5">
            {labels.map((l) => {
              const on = d.labelIds.includes(l.id);
              return (
                <button
                  key={l.id}
                  type="button"
                  aria-pressed={on}
                  className={cn('rounded-full ring-offset-background transition-opacity focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none', on ? 'opacity-100' : 'opacity-50 hover:opacity-80')}
                  onClick={() => setD({ ...d, labelIds: on ? d.labelIds.filter((x) => x !== l.id) : [...d.labelIds, l.id] })}
                >
                  <LabelChip label={l} />
                </button>
              );
            })}
          </div>
        </div>
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

function IdeaCard({ idea, labels, canWrite }: { idea: Idea; labels: readonly SocialLabel[]; canWrite: boolean }) {
  const t = useTranslations('social.ideas');
  const f = useFormat();
  const { slug } = useParams({ strict: false }) as { slug: string };
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const update = useMutation({
    mutationFn: (d: Draft) => client.social.ideas.update({ ideaId: idea.id, ...fieldsOf(d) }),
    onSuccess: () => {
      setEditing(false);
      refresh();
    },
  });
  const move = useMutation({ mutationFn: (stage: 'new' | 'planned' | 'archived') => client.social.ideas.move({ ideaId: idea.id, stage }), onSuccess: refresh });
  const chips = idea.labelIds.map((id) => labels.find((l) => l.id === id)).filter((l): l is SocialLabel => l !== undefined);
  if (editing) {
    return (
      <Card className="block p-3">
        <IdeaForm id={`idea-${idea.id}`} initial={draftOf(idea)} labels={labels} onSave={(d) => update.mutate(d)} onCancel={() => setEditing(false)} pending={update.isPending} error={update.error} />
      </Card>
    );
  }
  const host = idea.linkUrl ? linkHost(idea.linkUrl) : null;
  return (
    <Card className="block space-y-2 p-3" data-testid="idea-card">
      <p className="text-sm font-medium break-words text-foreground">{idea.title}</p>
      {idea.origin === 'ai' && <p className="text-xs text-subtle-foreground">{t('fromAi')}</p>}
      {idea.note && <p className="line-clamp-3 text-xs break-words whitespace-pre-line text-muted-foreground">{idea.note}</p>}
      {host && (
        <a href={idea.linkUrl ?? undefined} target="_blank" rel="noreferrer noopener" className="block truncate text-xs text-link hover:underline">
          {host}
        </a>
      )}
      {idea.media.length > 0 && (
        <div className="flex gap-1.5">
          {idea.media.slice(0, 4).map((m) => (
            <Thumb key={m.fileId} fileId={m.fileId} alt="" mime={m.mime} durationMs={m.durationMs} className="size-12 rounded-md" />
          ))}
          {idea.media.length > 4 && <span className="self-center text-xs text-subtle-foreground">+{idea.media.length - 4}</span>}
        </div>
      )}
      {chips.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {chips.map((l) => (
            <LabelChip key={l.id} label={l} />
          ))}
        </div>
      )}
      <p className="text-xs text-subtle-foreground">{t('updated', { when: f.dateTime(idea.updatedAt) })}</p>
      <div className="flex flex-wrap gap-1.5">
        {idea.postId ? (
          <Link to="/o/$slug/social/$id" params={{ slug, id: idea.postId }} className={buttonVariants({ size: 'sm', variant: 'secondary' })}>
            {t('openDraft')}
          </Link>
        ) : (
          canWrite &&
          idea.stage !== 'archived' && (
            <Button size="sm" onClick={() => void navigate({ to: '/o/$slug/social/new', params: { slug }, search: { idea: idea.id } })}>
              {t('writeDraft')}
            </Button>
          )
        )}
        {canWrite && (
          <>
            {idea.stage === 'new' && (
              <Button size="sm" variant="outline" disabled={move.isPending} onClick={() => move.mutate('planned')}>
                {t('toPlanned')}
              </Button>
            )}
            {idea.stage === 'planned' && (
              <Button size="sm" variant="outline" disabled={move.isPending} onClick={() => move.mutate('new')}>
                {t('toNew')}
              </Button>
            )}
            {idea.stage !== 'archived' && (
              <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
                {t('edit')}
              </Button>
            )}
            {idea.stage === 'archived' ? (
              // An idea with its draft stays in the archive: its draft already says where it came from.
              !idea.postId && (
                <Button size="sm" variant="outline" disabled={move.isPending} onClick={() => move.mutate('new')}>
                  {t('restore')}
                </Button>
              )
            ) : (
              <Button size="sm" variant="ghost" disabled={move.isPending} onClick={() => move.mutate('archived')}>
                {t('archive')}
              </Button>
            )}
          </>
        )}
      </div>
      {move.error && <ErrorText>{errorMessage(move.error)}</ErrorText>}
    </Card>
  );
}

function Column({ stage, ideas, labels, canWrite }: { stage: IdeaStage; ideas: readonly Idea[]; labels: readonly SocialLabel[]; canWrite: boolean }) {
  const t = useTranslations('social.ideas');
  return (
    <section aria-label={t(`stages.${stage}`)} className="min-w-0 space-y-2 rounded-xl bg-muted/40 p-2">
      <h3 className="flex items-center justify-between px-1 text-sm font-medium text-foreground">
        {t(`stages.${stage}`)}
        <span className="text-xs text-subtle-foreground tabular-nums">{ideas.length}</span>
      </h3>
      {ideas.length === 0 ? <p className="px-1 py-3 text-xs text-subtle-foreground">{t(`emptyStage.${stage}`)}</p> : ideas.map((i) => <IdeaCard key={i.id} idea={i} labels={labels} canWrite={canWrite} />)}
    </section>
  );
}

export function SocialIdeasPage() {
  const { slug } = useParams({ strict: false }) as { slug: string };
  const t = useTranslations('social.ideas');
  const me = useQuery(orpc.me.get.queryOptions());
  const role = me.data?.orgs.find((o) => o.slug === slug)?.role;
  const canWrite = role === 'owner' || role === 'admin' || role === 'member';
  const [archived, setArchived] = useState(false);
  const [labelId, setLabelId] = useState('');
  const labels = useLabels().data ?? [];
  const list = useQuery(orpc.social.ideas.list.queryOptions({ input: { archived, ...(labelId ? { labelId } : {}) } }));
  const [adding, setAdding] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const canSuggest = canWrite && getConfig().aiEnabled === true;
  const create = useMutation({
    mutationFn: (d: Draft) => client.social.ideas.create(fieldsOf(d)),
    onSuccess: () => {
      setAdding(false);
      refresh();
    },
  });
  const ideas = list.data?.ideas ?? [];
  return (
    <div className="space-y-4">
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        actions={
          <>
            {canSuggest && !suggesting && (
              <Button variant="outline" onClick={() => setSuggesting(true)}>
                {t('suggest.open')}
              </Button>
            )}
            {canWrite && !adding && <Button onClick={() => setAdding(true)}>{t('new')}</Button>}
            <Link to="/o/$slug/social" params={{ slug }} className="inline-flex h-9 items-center px-2.5 text-sm text-muted-foreground hover:text-foreground">
              {t('back')}
            </Link>
          </>
        }
      />
      {suggesting && <SuggestPanel labels={labels} onClose={() => setSuggesting(false)} />}
      {adding && (
        <Card className="block p-4">
          <h3 className="mb-3 text-sm font-medium text-foreground">{t('new')}</h3>
          <IdeaForm id="idea-new" initial={EMPTY} labels={labels} onSave={(d) => create.mutate(d)} onCancel={() => setAdding(false)} pending={create.isPending} error={create.error} />
        </Card>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1" role="tablist">
          <Button size="sm" role="tab" aria-selected={!archived} variant={archived ? 'ghost' : 'secondary'} onClick={() => setArchived(false)}>
            {t('board')}
          </Button>
          <Button size="sm" role="tab" aria-selected={archived} variant={archived ? 'secondary' : 'ghost'} onClick={() => setArchived(true)}>
            {t('archived')}
          </Button>
        </div>
        {labels.length > 0 && (
          <NativeSelect size="sm" aria-label={t('filterLabel')} value={labelId} onChange={(e) => setLabelId(e.target.value)} className="w-48">
            <NativeSelectOption value="">{t('allLabels')}</NativeSelectOption>
            {labels.map((l) => (
              <NativeSelectOption key={l.id} value={l.id}>
                {l.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        )}
      </div>
      {list.isLoading ? (
        <Spinner />
      ) : list.error ? (
        <ErrorText>{errorMessage(list.error)}</ErrorText>
      ) : archived ? (
        ideas.length === 0 ? (
          <Empty title={t('emptyArchive')} hint={t('emptyArchiveHint')} />
        ) : (
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {ideas.map((i) => (
              <IdeaCard key={i.id} idea={i} labels={labels} canWrite={canWrite} />
            ))}
          </div>
        )
      ) : (
        <div className="grid gap-3 md:grid-cols-3">
          {BOARD_STAGES.map((stage) => (
            <Column key={stage} stage={stage} ideas={ideas.filter((i) => i.stage === stage)} labels={labels} canWrite={canWrite} />
          ))}
        </div>
      )}
      {list.data?.truncated && <p className="text-xs text-subtle-foreground">{t('truncated')}</p>}
    </div>
  );
}
