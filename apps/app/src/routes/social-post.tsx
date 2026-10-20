// Compose a post and work on it: shared text, a variant per channel that inherits it or has its own text, live
// channel rules and a preview, then review (owners and admins decide on what they see), schedule and cancel.
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useLocale, useTranslations } from 'use-intl';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Checkbox } from '@crove/ui/components/checkbox';
import { Input } from '@crove/ui/components/input';
import { Label } from '@crove/ui/components/label';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { Textarea } from '@crove/ui/components/textarea';
import { cn } from '@crove/ui/lib/utils';
import { COMMENT_RULES, isProvider, type Issue } from '@crove/mod-social/contract';
import { MediaField, type MediaItem } from '../components/social-media.tsx';
import { PlatformPreview } from '../components/social-preview.tsx';
import { PostActivity } from '../components/social-activity.tsx';
import { ErrorText, PageHeader, Spinner } from '../components/ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';
import { getConfig } from '../lib/auth.ts';
import {
  CANCELLABLE,
  EDITABLE,
  draftIssues,
  fromLocalInput,
  hasTitle,
  providerName,
  SUBMITTABLE,
  setFlash,
  takeFlash,
  textBudget,
  toLocalInput,
  VARIANT_TONE,
  type VariantStatus,
} from '../lib/social.ts';

type Post = Awaited<ReturnType<typeof orpc.social.posts.get.call>>;
type Variant = Post['variants'][number];
type Channel = Awaited<ReturnType<typeof orpc.channels.list.call>>[number];

interface Base {
  body: string;
  title: string;
  linkUrl: string;
  media: MediaItem[];
}

// A channel's own text, or none (it uses the shared text).
interface Own {
  custom: boolean;
  body: string;
  title: string;
  // The channel's provider settings (TikTok privacy and interactions, YouTube visibility).
  settings: Record<string, unknown>;
  // The channel's own images or video instead of the post's (#581).
  customMedia: boolean;
  media: MediaItem[];
}

const EMPTY_OWN: Own = { custom: false, body: '', title: '', settings: {}, customMedia: false, media: [] };
const sameMediaList = (a: readonly MediaItem[], b: readonly MediaItem[]) => JSON.stringify(mediaInput(a)) === JSON.stringify(mediaInput(b));
// The images a channel shows: its own when it has them, else the post's.
const mediaOfOwn = (own: Own, base: Base) => (own.customMedia ? own.media : base.media);
const sameSettings = (a: Record<string, unknown> | null | undefined, b: Record<string, unknown> | null | undefined) =>
  JSON.stringify(Object.entries(a ?? {}).sort()) === JSON.stringify(Object.entries(b ?? {}).sort());

// The settings a channel asks the person posting to choose (TikTok's posting rules), or that it offers (YouTube).
function ProviderSettings({ provider, settings, onChange, disabled }: { provider: string; settings: Record<string, unknown>; onChange: (settings: Record<string, unknown>) => void; disabled: boolean }) {
  const t = useTranslations('social');
  if (provider === 'youtube') {
    return (
      <div className="space-y-1.5">
        <Label className="text-xs">{t('ytPrivacy')}</Label>
        <NativeSelect size="sm" className="w-full max-w-xs" value={typeof settings.privacy === 'string' ? settings.privacy : 'public'} disabled={disabled} onChange={(e) => onChange({ ...settings, privacy: e.target.value })}>
          {(['public', 'unlisted', 'private'] as const).map((p) => (
            <NativeSelectOption key={p} value={p}>
              {t(`ytPrivacyOption.${p}`)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>
    );
  }
  if (provider !== 'tiktok') return null;
  const toggle = (key: 'allowComments' | 'allowDuet' | 'allowStitch') => (
    <label className="flex items-center gap-2 text-sm text-muted-foreground">
      <Checkbox checked={settings[key] === true} disabled={disabled} onCheckedChange={(on) => onChange({ ...settings, [key]: on === true })} />
      {t(`ttToggle.${key}`)}
    </label>
  );
  return (
    <div className="space-y-2 rounded-lg border p-3">
      <div className="space-y-1.5">
        <Label className="text-xs">{t('ttPrivacy')}</Label>
        <NativeSelect size="sm" className="w-full max-w-xs" value={typeof settings.privacyLevel === 'string' ? settings.privacyLevel : ''} disabled={disabled} onChange={(e) => onChange({ ...settings, privacyLevel: e.target.value })}>
          <NativeSelectOption value="">{t('ttPrivacyChoose')}</NativeSelectOption>
          {(['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY'] as const).map((p) => (
            <NativeSelectOption key={p} value={p}>
              {t(`ttPrivacyOption.${p}`)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>
      {toggle('allowComments')}
      {toggle('allowDuet')}
      {toggle('allowStitch')}
      <p className="text-xs text-subtle-foreground">{t('ttConsent')}</p>
    </div>
  );
}

function useRole(slug: string) {
  const me = useQuery(orpc.me.get.queryOptions());
  const role = me.data?.orgs.find((o) => o.slug === slug)?.role;
  return { role, canDecide: role === 'owner' || role === 'admin', canWrite: role === 'owner' || role === 'admin' || role === 'member' };
}

function IssueList({ issues }: { issues: Issue[] }) {
  const t = useTranslations('social.issues');
  if (issues.length === 0) return null;
  const text = (issue: Issue) => {
    const limit = issue.limit ?? 0;
    const actual = issue.actual ?? 0;
    switch (issue.code) {
      case 'TEXT_TOO_LONG':
        return t('TEXT_TOO_LONG', { limit, actual });
      case 'TEXT_TOO_MANY_BYTES':
        return t('TEXT_TOO_MANY_BYTES', { limit, actual });
      case 'TITLE_TOO_LONG':
        return t('TITLE_TOO_LONG', { limit, actual });
      case 'MEDIA_REQUIRED':
        return t('MEDIA_REQUIRED', { limit });
      case 'TOO_MANY_MEDIA':
        return t('TOO_MANY_MEDIA', { limit });
      case 'TOO_MANY_LINKS':
        return t('TOO_MANY_LINKS', { limit, actual });
      case 'COMMENT_TOO_LONG':
        return t('COMMENT_TOO_LONG', { limit, actual });
      default:
        return t(issue.code);
    }
  };
  return (
    <ul className="space-y-1 text-xs text-destructive">
      {issues.map((issue) => (
        <li key={`${issue.code}:${issue.field}`}>{text(issue)}</li>
      ))}
    </ul>
  );
}

function Counter({ provider, body, linkUrl, mediaCount }: { provider: string; body: string; linkUrl: string; mediaCount: number }) {
  const { used, max } = textBudget(provider, body, { linkUrl, mediaCount });
  if (max === null) return null;
  const over = used > max;
  return <span className={cn('font-mono text-xs tabular-nums', over ? 'text-destructive' : used > max * 0.9 ? 'text-warning' : 'text-subtle-foreground')}>{used}/{max}</span>;
}

const REWRITES = ['shorten', 'formal', 'casual', 'translate_en', 'translate_vi'] as const;

// An AI rewrite of a text (#583): a proposal shown next to the text, which the member takes or leaves. Taking it marks
// the post as AI-assisted.
function AiRewrite({ text, title, connectionId, onAccept }: { text: string; title: string | null; connectionId?: string; onAccept: (next: { text: string; title: string | null }) => void }) {
  const t = useTranslations('social');
  const [action, setAction] = useState<(typeof REWRITES)[number]>('shorten');
  // The text the proposal was made from: typed on since, it no longer fits and is not offered.
  const [asked, setAsked] = useState<string | null>(null);
  const rewrite = useMutation({
    mutationFn: () => {
      setAsked(text);
      return client.social.posts.rewriteWithAi({ text, title, action, ...(connectionId ? { connectionId } : {}) });
    },
  });
  const outdated = rewrite.data !== undefined && asked !== text;
  if (getConfig().aiEnabled !== true || !text.trim()) return null;
  return (
    <div className="space-y-2 rounded-lg border border-dashed p-2">
      <div className="flex flex-wrap items-center gap-2">
        <NativeSelect size="sm" value={action} aria-label={t('aiRewrite')} onChange={(e) => setAction(e.target.value as (typeof REWRITES)[number])}>
          {REWRITES.map((a) => (
            <NativeSelectOption key={a} value={a}>
              {t(`aiRewrites.${a}`)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <Button variant="outline" size="sm" disabled={rewrite.isPending} onClick={() => rewrite.mutate()}>
          {rewrite.isPending ? <Spinner className="text-current" /> : null}
          {t('aiRewrite')}
        </Button>
      </div>
      {rewrite.error && <ErrorText>{errorMessage(rewrite.error)}</ErrorText>}
      {rewrite.data && (
        <div className="space-y-2">
          {rewrite.data.title && <p className="text-sm font-medium text-foreground">{rewrite.data.title}</p>}
          <p className="text-sm whitespace-pre-wrap [overflow-wrap:anywhere] text-foreground">{rewrite.data.text}</p>
          <p className="text-xs text-subtle-foreground">{t(outdated ? 'aiRewriteOutdated' : 'aiRewriteHint')}</p>
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={outdated}
              onClick={() => {
                onAccept(rewrite.data);
                rewrite.reset();
              }}
            >
              {t('aiRewriteUse')}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => rewrite.reset()}>
              {t('aiRewriteDrop')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function ChannelEditor({
  provider,
  channel,
  base,
  own,
  onChange,
  disabled,
  status,
  footer,
  connectionId,
  onAiUsed,
}: {
  provider: string;
  channel: string;
  base: Base;
  own: Own;
  onChange: (own: Own) => void;
  disabled: boolean;
  status?: VariantStatus;
  footer?: ReactNode;
  connectionId?: string;
  onAiUsed?: () => void;
}) {
  const t = useTranslations('social');
  const content = { body: own.custom ? own.body : base.body, title: own.custom ? own.title : base.title, linkUrl: base.linkUrl, media: mediaOfOwn(own, base) };
  const issues = draftIssues(provider, { body: content.body, title: hasTitle(provider) ? content.title : null, linkUrl: content.linkUrl, media: content.media, settings: own.settings });
  return (
    <Card className="block space-y-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Badge variant="outline">{providerName(provider)}</Badge>
          <span className="truncate text-sm font-medium text-foreground">{channel}</span>
          {status && <Badge variant={VARIANT_TONE[status]}>{t(`status.${status}`)}</Badge>}
        </div>
        <Counter provider={provider} body={content.body} linkUrl={content.linkUrl} mediaCount={content.media.length} />
      </div>
      <label className="flex items-center gap-2 text-sm text-muted-foreground">
        <Checkbox checked={own.custom} disabled={disabled} onCheckedChange={(checked) => onChange({ ...own, custom: checked === true, body: own.body || base.body })} />
        {t('ownText')}
      </label>
      {own.custom && (
        <div className="space-y-2">
          {hasTitle(provider) && <Input value={own.title} disabled={disabled} aria-label={t('titleField')} placeholder={base.title || t('titlePlaceholder')} onChange={(e) => onChange({ ...own, title: e.target.value })} />}
          <Textarea value={own.body} disabled={disabled} rows={5} aria-label={t('ownTextPlaceholder')} placeholder={t('ownTextPlaceholder')} onChange={(e) => onChange({ ...own, body: e.target.value })} />
          {!disabled && onAiUsed && (
            <AiRewrite
              text={own.body}
              title={hasTitle(provider) ? own.title || null : null}
              {...(connectionId ? { connectionId } : {})}
              onAccept={(next) => {
                onChange({ ...own, body: next.text, title: next.title ?? own.title });
                onAiUsed();
              }}
            />
          )}
        </div>
      )}
      <label className="flex items-center gap-2 text-sm text-muted-foreground">
        <Checkbox checked={own.customMedia} disabled={disabled} onCheckedChange={(checked) => onChange({ ...own, customMedia: checked === true, media: own.media.length > 0 ? own.media : base.media })} />
        {t('ownMedia')}
      </label>
      {own.customMedia && <MediaField media={own.media} disabled={disabled} onChange={(media) => onChange({ ...own, media })} />}
      {own.customMedia && own.media.length === 0 && <p className="text-xs text-subtle-foreground">{t('ownMediaEmpty')}</p>}
      {isProvider(provider) && COMMENT_RULES[provider] && (
        <div className="space-y-1">
          <Label className="text-xs">{t('firstComment')}</Label>
          <Textarea
            rows={2}
            disabled={disabled}
            value={typeof own.settings.firstComment === 'string' ? own.settings.firstComment : ''}
            placeholder={t('firstCommentPlaceholder')}
            onChange={(e) => {
              const { firstComment: _old, ...rest } = own.settings;
              onChange({ ...own, settings: e.target.value ? { ...rest, firstComment: e.target.value } : rest });
            }}
          />
        </div>
      )}
      <ProviderSettings provider={provider} settings={own.settings} disabled={disabled} onChange={(settings) => onChange({ ...own, settings })} />
      <IssueList issues={issues} />
      <PlatformPreview channel={channel} provider={provider} content={content} />
      {footer}
    </Card>
  );
}

function SharedFields({ base, onChange, disabled, needsTitle, autoFocus = false, onAiUsed }: { base: Base; onChange: (base: Base) => void; disabled: boolean; needsTitle: boolean; autoFocus?: boolean; onAiUsed?: () => void }) {
  const t = useTranslations('social');
  return (
    <Card className="block space-y-3 p-4">
      <div className="space-y-1.5">
        <Label htmlFor="social-body">{t('sharedText')}</Label>
        <Textarea id="social-body" autoFocus={autoFocus} value={base.body} disabled={disabled} rows={7} placeholder={t('sharedTextPlaceholder')} onChange={(e) => onChange({ ...base, body: e.target.value })} />
        {!disabled && onAiUsed && (
          <AiRewrite
            text={base.body}
            title={needsTitle ? base.title || null : null}
            onAccept={(next) => {
              onChange({ ...base, body: next.text, title: next.title ?? base.title });
              onAiUsed();
            }}
          />
        )}
      </div>
      {needsTitle && (
        <div className="space-y-1.5">
          <Label htmlFor="social-title">{t('titleField')}</Label>
          <Input id="social-title" value={base.title} disabled={disabled} placeholder={t('titlePlaceholder')} onChange={(e) => onChange({ ...base, title: e.target.value })} />
        </div>
      )}
      <div className="space-y-1.5">
        <Label htmlFor="social-link">{t('link')}</Label>
        <Input id="social-link" type="url" inputMode="url" value={base.linkUrl} disabled={disabled} placeholder="https://" onChange={(e) => onChange({ ...base, linkUrl: e.target.value })} />
      </div>
      <MediaField media={base.media} disabled={disabled} onChange={(media) => onChange({ ...base, media })} />
    </Card>
  );
}

const orNull = (value: string) => (value.trim() === '' ? null : value);
const mediaInput = (media: readonly MediaItem[]) => media.map((m) => ({ fileId: m.fileId, altText: orNull(m.altText) }));
const mediaItems = (media: readonly { fileId: string; altText: string | null; mime: string; sizeBytes: number; durationMs: number | null }[]): MediaItem[] =>
  media.map((m) => ({ fileId: m.fileId, altText: m.altText ?? '', mime: m.mime, sizeBytes: m.sizeBytes, durationMs: m.durationMs }));

// ---------------------------------------------------------------------------------------------------------------------
// New post
// ---------------------------------------------------------------------------------------------------------------------

export function SocialComposePage() {
  const { slug } = useParams({ strict: false }) as { slug: string };
  const t = useTranslations('social');
  const f = useFormat();
  const navigate = useNavigate();
  const channels = useQuery(orpc.channels.list.queryOptions({ input: {} }));
  const [base, setBase] = useState<Base>({ body: '', title: '', linkUrl: '', media: [] });
  const [chosen, setChosen] = useState<string[]>([]);
  const [own, setOwn] = useState<Record<string, Own>>({});
  // An AI rewrite was taken into the text (#583): the post is saved as AI-assisted.
  const [aiUsed, setAiUsed] = useState(false);
  const live = (channels.data ?? []).filter((c) => c.status === 'active');
  // A planned time from the calendar (#580), kept on the draft; scheduling starts from it.
  const search: { at?: string } = useSearch({ strict: false });
  const [plannedAt, setPlannedAt] = useState<string | null>(() => (search.at && Date.parse(search.at) > Date.now() ? search.at : null));
  useEffect(() => {
    // The only channel is chosen for you.
    if (chosen.length === 0 && live.length === 1 && live[0]) setChosen([live[0].id]);
  }, [live.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // One key per content: a retry of the same content after a lost answer returns the post the first request created;
  // content edited after a failed attempt is a new request (the server would refuse the old key with other content).
  const attempt = useRef<{ key: string; payload: string } | null>(null);
  const create = useMutation({
    mutationFn: async (submit: boolean) => {
      const request = {
        body: base.body,
        title: orNull(base.title),
        linkUrl: orNull(base.linkUrl),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        // A planned time that went by while the page was open is dropped.
        ...(plannedAt && Date.parse(plannedAt) > Date.now() ? { scheduledAt: plannedAt } : {}),
        ...(aiUsed ? { aiAssisted: true as const } : {}),
        media: mediaInput(base.media),
        channels: chosen.map((connectionId) => {
          const mine = own[connectionId] ?? EMPTY_OWN;
          const settings = Object.keys(mine.settings).length > 0 ? { settings: mine.settings as Record<string, string | boolean> } : {};
          const media = mine.customMedia ? { media: mediaInput(mine.media) } : {};
          return mine.custom ? { connectionId, body: mine.body, title: orNull(mine.title), ...settings, ...media } : { connectionId, ...settings, ...media };
        }),
      };
      const payload = JSON.stringify(request);
      if (attempt.current?.payload !== payload) attempt.current = { key: crypto.randomUUID(), payload };
      const created = await client.social.posts.create({ idempotencyKey: attempt.current.key, ...request });
      // The draft exists now: a failed submit is shown on its page, never answered with a second post.
      if (submit) await client.social.posts.submit({ postId: created.postId }).catch((error: unknown) => setFlash(errorMessage(error)));
      return created.postId;
    },
    onSuccess: (postId) => {
      void queryClient.invalidateQueries();
      void navigate({ to: '/o/$slug/social/$id', params: { slug, id: postId } });
    },
  });

  // AI drafting (S7): the server asks the model for a draft of the brief for the chosen channels and saves it as a
  // new post marked as written by AI; every channel of it is reviewed before it can go out.
  const [brief, setBrief] = useState('');
  const locale = useLocale();
  const aiEnabled = getConfig().aiEnabled === true;
  const aiDraft = useMutation({
    mutationFn: () => client.social.posts.draftWithAi({ brief: brief.trim(), connectionIds: chosen, language: locale === 'en' ? 'en' : 'vi' }),
    onSuccess: ({ postId }) => {
      void queryClient.invalidateQueries();
      void navigate({ to: '/o/$slug/social/$id', params: { slug, id: postId } });
    },
  });

  const selected = live.filter((c) => chosen.includes(c.id));
  const blocking = selected.some((c) => {
    const mine = own[c.id] ?? EMPTY_OWN;
    const content = { body: mine.custom ? mine.body : base.body, title: mine.custom ? mine.title : base.title };
    return draftIssues(c.provider, { body: content.body, title: hasTitle(c.provider) ? content.title : null, linkUrl: base.linkUrl, media: mediaOfOwn(mine, base), settings: mine.settings }).length > 0;
  });
  const onKey = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && chosen.length > 0 && !blocking && !create.isPending) {
      e.preventDefault();
      create.mutate(true);
    }
  };

  if (channels.isLoading) return <Spinner />;
  return (
    <div onKeyDown={onKey}>
      <PageHeader
        title={t('composeTitle')}
        subtitle={t('composeSubtitle')}
        actions={
          <>
            <Button variant="outline" size="lg" disabled={chosen.length === 0 || create.isPending} onClick={() => create.mutate(false)}>
              {t('saveDraft')}
            </Button>
            <Button size="lg" disabled={chosen.length === 0 || blocking || create.isPending} onClick={() => create.mutate(true)}>
              {create.isPending ? <Spinner className="text-current" /> : null}
              {t('saveAndSubmit')}
            </Button>
          </>
        }
      />
      {create.error && (
        <div className="mb-4">
          <ErrorText>{errorMessage(create.error)}</ErrorText>
        </div>
      )}
      {plannedAt && (
        <p className="mb-4 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          {t('plannedFor', { when: f.dateTime(plannedAt) })}
          <Button variant="ghost" size="sm" onClick={() => setPlannedAt(null)}>
            {t('plannedClear')}
          </Button>
        </p>
      )}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="space-y-4">
          <SharedFields base={base} onChange={setBase} disabled={create.isPending} autoFocus needsTitle={selected.some((c) => hasTitle(c.provider))} onAiUsed={() => setAiUsed(true)} />
          <Card className="block p-4">
            <p className="mb-3 text-sm font-medium text-foreground">{t('pickChannels')}</p>
            {live.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t('noChannelsHint')}{' '}
                <Link to="/o/$slug/social/channels" params={{ slug }} className="text-link hover:underline">
                  {t('connectFirst')}
                </Link>
              </p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {live.map((c) => {
                  const on = chosen.includes(c.id);
                  return (
                    <button
                      key={c.id}
                      type="button"
                      aria-pressed={on}
                      onClick={() => setChosen(on ? chosen.filter((id) => id !== c.id) : [...chosen, c.id])}
                      className={cn(
                        'inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
                        on ? 'border-primary/50 bg-primary/15 text-foreground' : 'bg-card text-muted-foreground hover:text-foreground',
                      )}
                    >
                      <span className="text-xs text-subtle-foreground">{providerName(c.provider)}</span>
                      {c.displayName}
                    </button>
                  );
                })}
              </div>
            )}
          </Card>
          <Card className="block space-y-2 p-4">
            <Label htmlFor="social-ai-brief">{t('aiDraftTitle')}</Label>
            {aiEnabled ? (
              <>
                <Textarea id="social-ai-brief" value={brief} rows={3} maxLength={4000} placeholder={t('aiBriefPlaceholder')} disabled={aiDraft.isPending} onChange={(e) => {
                  setBrief(e.target.value);
                  if (aiDraft.error) aiDraft.reset();
                }} />
                <p className="text-xs text-subtle-foreground">{t('aiDraftHint')}</p>
                <Button variant="outline" size="sm" disabled={!brief.trim() || chosen.length === 0 || aiDraft.isPending} onClick={() => aiDraft.mutate()}>
                  {aiDraft.isPending ? <Spinner className="text-current" /> : null}
                  {t('aiDraft')}
                </Button>
                {aiDraft.error && <ErrorText>{errorMessage(aiDraft.error)}</ErrorText>}
              </>
            ) : (
              <p className="text-xs text-subtle-foreground">{t('aiOff')}</p>
            )}
          </Card>
          <p className="text-xs text-subtle-foreground">{t('shortcutHint')}</p>
        </div>
        <div className="space-y-4">
          {selected.length === 0 ? (
            <Card className="block p-6 text-sm text-muted-foreground">{t('pickChannelsHint')}</Card>
          ) : (
            selected.map((c) => (
              <ChannelEditor
                key={c.id}
                provider={c.provider}
                channel={c.displayName}
                base={base}
                own={own[c.id] ?? EMPTY_OWN}
                disabled={create.isPending}
                onChange={(next) => setOwn({ ...own, [c.id]: next })}
                connectionId={c.id}
                onAiUsed={() => setAiUsed(true)}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// One post: edit, review, schedule
// ---------------------------------------------------------------------------------------------------------------------

function ownOf(v: Variant): Own {
  return { custom: v.overrides.body !== null, body: v.overrides.body ?? '', title: v.overrides.title ?? '', settings: v.settings, customMedia: v.ownMedia, media: v.ownMedia ? mediaItems(v.media) : [] };
}

// What a post says, not its status: the post's revision and each variant's revision and own content (an override
// change elsewhere shows as an edit even if it did not move the revision).
function contentKey(p: Post): string {
  return `${p.revision}|${p.variants.map((v) => `${v.id}:${v.revision}:${JSON.stringify([v.overrides, v.settings, v.ownMedia])}`).join(',')}`;
}

function baseOf(p: Post): Base {
  return { body: p.body, title: p.title ?? '', linkUrl: p.linkUrl ?? '', media: mediaItems(p.media) };
}

function sameOwn(a: Own, b: Own): boolean {
  return (
    a.custom === b.custom &&
    (!a.custom || (a.body === b.body && a.title === b.title)) &&
    sameSettings(a.settings, b.settings) &&
    a.customMedia === b.customMedia &&
    (!a.customMedia || sameMediaList(a.media, b.media))
  );
}

function ReviewPanel({ post, names, onDone }: { post: Post; names: Map<string, string>; onDone: () => void }) {
  const t = useTranslations('social');
  const me = useQuery(orpc.me.get.queryOptions());
  const self = me.data?.userId;
  const inReview = post.variants.filter((v) => v.status === 'in_review');
  // A channel that needs several approvals waits for another person once this reviewer has approved it.
  // The reviewer may still ask for changes or reject such a channel, which ends the round; only approving it again is
  // refused.
  const mine = (v: Variant) => self !== undefined && v.review.approvedBy.includes(self);
  const waiting = inReview;
  const [unticked, setUnticked] = useState<string[]>([]);
  const picked = waiting.map((v) => v.id).filter((id) => !unticked.includes(id));
  const [comment, setComment] = useState('');
  const decide = useMutation({
    mutationFn: (decision: 'approved' | 'changes_requested' | 'rejected') =>
      client.social.variants.decide({
        postId: post.id,
        decision,
        ...(comment.trim() ? { comment: comment.trim() } : {}),
        // What this reviewer sees: a newer revision is refused, never approved by mistake.
        variants: waiting.filter((v) => picked.includes(v.id) && (decision !== 'approved' || !mine(v))).map((v) => ({ variantId: v.id, revision: v.revision, contentHash: v.contentHash })),
      }),
    onSuccess: () => {
      setComment('');
      setUnticked([]);
      onDone();
    },
  });
  if (inReview.length === 0) return null;
  const done = inReview.filter(mine);
  const approvable = waiting.filter((v) => picked.includes(v.id) && !mine(v));

  return (
    <Card className="block space-y-3 border-warning/40 p-4">
      <p className="text-sm font-medium text-foreground">{t('reviewTitle')}</p>
      {done.length > 0 && <p className="text-xs text-subtle-foreground">{t('reviewYouApproved', { channels: done.map((v) => names.get(v.connectionId) ?? providerName(v.provider)).join(', ') })}</p>}
      {waiting.length > 0 && (
        <div className="space-y-1.5">
          {waiting.map((v) => (
            <label key={v.id} className="flex items-center gap-2 text-sm text-muted-foreground">
              <Checkbox checked={picked.includes(v.id)} onCheckedChange={(on) => setUnticked(on === true ? unticked.filter((id) => id !== v.id) : [...unticked, v.id])} />
              {names.get(v.connectionId) ?? providerName(v.provider)}
              {v.review.required > 1 && (
                <span className="text-xs text-subtle-foreground tabular-nums">{t('reviewSteps', { given: String(v.review.approvedBy.length), required: String(v.review.required) })}</span>
              )}
            </label>
          ))}
        </div>
      )}
      <Textarea value={comment} rows={2} aria-label={t('commentPlaceholder')} placeholder={t('commentPlaceholder')} onChange={(e) => setComment(e.target.value)} />
      {decide.error && <ErrorText>{errorMessage(decide.error)}</ErrorText>}
      <div className="flex flex-wrap gap-2">
        <Button size="lg" disabled={self === undefined || approvable.length === 0 || decide.isPending} onClick={() => decide.mutate('approved')}>
          {t('approve')}
        </Button>
        <Button variant="outline" size="lg" disabled={picked.length === 0 || decide.isPending || !comment.trim()} onClick={() => decide.mutate('changes_requested')}>
          {t('requestChanges')}
        </Button>
        <Button variant="destructive" size="lg" disabled={picked.length === 0 || decide.isPending} onClick={() => decide.mutate('rejected')}>
          {t('reject')}
        </Button>
      </div>
      {!comment.trim() && waiting.length > 0 && <p className="text-xs text-subtle-foreground">{t('changesNeedComment')}</p>}
    </Card>
  );
}

function SchedulePanel({ post, names, onDone }: { post: Post; names: Map<string, string>; onDone: () => void }) {
  const t = useTranslations('social');
  const ready = post.variants.filter((v) => v.status === 'approved');
  const [mode, setMode] = useState<'time' | 'queue'>('time');
  const [when, setWhen] = useState(() => toLocalInput(post.scheduledAt ?? new Date(Date.now() + 3_600_000).toISOString()));
  // A time per channel (#576): each starts at the shared time.
  const [perChannel, setPerChannel] = useState(false);
  const [times, setTimes] = useState<Record<string, string>>({});
  const timeOf = (variantId: string) => times[variantId] ?? when;
  const allSet = perChannel ? ready.every((v) => fromLocalInput(timeOf(v.id))) : Boolean(fromLocalInput(when));
  const schedule = useMutation({
    mutationFn: () => {
      if (mode === 'time' && perChannel) {
        return client.social.variants.schedule({ postId: post.id, times: ready.map((v) => ({ variantId: v.id, at: fromLocalInput(timeOf(v.id)) as string })) });
      }
      const at = fromLocalInput(when);
      return client.social.variants.schedule({ postId: post.id, variantIds: ready.map((v) => v.id), ...(mode === 'queue' ? { queue: true as const } : at ? { at } : {}) });
    },
    onSuccess: onDone,
  });
  if (ready.length === 0) return null;
  const min = toLocalInput(new Date().toISOString());
  return (
    <Card className="block space-y-3 border-primary/40 p-4">
      <p className="text-sm font-medium text-foreground">{t('scheduleTitle', { count: ready.length })}</p>
      <div className="flex flex-wrap gap-2" role="group" aria-label={t('scheduleTitle', { count: ready.length })}>
        {(['time', 'queue'] as const).map((m) => (
          <button
            key={m}
            type="button"
            aria-pressed={mode === m}
            onClick={() => setMode(m)}
            className={cn(
              'rounded-lg border px-3 py-1.5 text-sm focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
              mode === m ? 'border-primary/50 bg-primary/15 text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {t(m === 'time' ? 'atTime' : 'nextSlot')}
          </button>
        ))}
      </div>
      {mode === 'time' && !perChannel && <Input type="datetime-local" aria-label={t('atTime')} value={when} min={min} onChange={(e) => setWhen(e.target.value)} className="max-w-xs" />}
      {mode === 'time' && ready.length > 1 && (
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <input type="checkbox" checked={perChannel} onChange={(e) => setPerChannel(e.target.checked)} className="size-4 accent-primary" />
          {t('timePerChannel')}
        </label>
      )}
      {mode === 'time' && perChannel && (
        <div className="space-y-2">
          {ready.map((v) => (
            <label key={v.id} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="min-w-40 text-foreground">
                {names.get(v.connectionId) ?? providerName(v.provider)} <span className="text-xs text-subtle-foreground">{providerName(v.provider)}</span>
              </span>
              <Input type="datetime-local" value={timeOf(v.id)} min={min} onChange={(e) => setTimes((prev) => ({ ...prev, [v.id]: e.target.value }))} className="max-w-xs" />
            </label>
          ))}
        </div>
      )}
      {mode === 'queue' && <p className="text-xs text-subtle-foreground">{t('nextSlotHint')}</p>}
      {schedule.error && <ErrorText>{errorMessage(schedule.error)}</ErrorText>}
      <Button size="lg" disabled={schedule.isPending || (mode === 'time' && !allSet)} onClick={() => schedule.mutate()}>
        {t('schedule')}
      </Button>
    </Card>
  );
}

const EVERGREEN_DAYS = [7, 14, 30, 60, 90, 180, 365] as const;

// Evergreen (S9): a published post drafted again every N days and sent to review; a person approves each repost.
function EvergreenPanel({ post, onDone }: { post: Post; onDone: () => void }) {
  const t = useTranslations('social');
  const set = useMutation({ mutationFn: (days: number | null) => client.social.posts.setEvergreen({ postId: post.id, days }), onSuccess: onDone });
  const current = post.evergreenDays;
  return (
    <Card className="block space-y-2 p-4">
      <Label htmlFor="evergreen" className="text-sm font-medium text-foreground">
        {t('evergreenTitle')}
      </Label>
      <NativeSelect
        id="evergreen"
        size="sm"
        className="w-full max-w-xs"
        value={current === null ? '' : String(current)}
        disabled={set.isPending}
        onChange={(e) => set.mutate(e.target.value === '' ? null : Number(e.target.value))}
      >
        <NativeSelectOption value="">{t('evergreenOff')}</NativeSelectOption>
        {current !== null && !(EVERGREEN_DAYS as readonly number[]).includes(current) && (
          <NativeSelectOption value={String(current)}>{t('evergreenEvery', { days: String(current) })}</NativeSelectOption>
        )}
        {EVERGREEN_DAYS.map((d) => (
          <NativeSelectOption key={d} value={String(d)}>
            {t('evergreenEvery', { days: String(d) })}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      <p className="text-xs text-subtle-foreground">{t('evergreenHint')}</p>
      {set.error && <ErrorText>{errorMessage(set.error)}</ErrorText>}
    </Card>
  );
}

// What happened to a variant on its way out, in words: a retry time, a pending or unknown outcome, a pause on its
// channel, a refusal with what the platform said.
function Outcome({ variant: v, slug }: { variant: Variant; slug: string }) {
  const t = useTranslations('social');
  const f = useFormat();
  const said = v.error?.message ? <p className="text-subtle-foreground [overflow-wrap:anywhere]">{t('outcome.platformSaid', { message: v.error.message })}</p> : null;
  switch (v.status) {
    case 'in_review':
      // The kept time counts only while it is ahead: past it, or with no slot left, a person schedules again.
      return v.error?.code === 'POLICY_RAISED' ? (
        <p className="text-warning">{t(v.error.action === 'reschedule' && v.effectiveAt && Date.parse(v.effectiveAt) > Date.now() ? 'outcome.policyRaisedReschedule' : 'outcome.policyRaised')}</p>
      ) : null;
    case 'scheduled':
      if (v.queuePaused) return <p className="text-warning">{t('outcome.queuePaused')}</p>;
      return v.error?.retryAt ? <p className="text-warning">{t('outcome.retrying', { when: f.dateTime(v.error.retryAt) })}</p> : null;
    case 'publishing':
    case 'processing':
      return <p>{t(`outcome.${v.status}`)}</p>;
    case 'ambiguous':
      return <p className="text-warning">{t('outcome.ambiguous')}</p>;
    case 'needs_attention':
      return <p className="text-warning">{t('outcome.needsAttention')}</p>;
    case 'paused':
      return (
        <div className="space-y-1">
          <p className="text-warning">
            {t(v.error?.code === 'CHANNEL_OWNER_LEFT' ? 'outcome.ownerLeft' : v.error?.code === 'CHANNEL_REVOKED' ? 'outcome.revoked' : 'outcome.paused')}
          </p>
          {v.error?.code !== 'CHANNEL_REVOKED' && (
            <Link to="/o/$slug/social/channels" params={{ slug }} className="text-link hover:underline">
              {t('reconnect')}
            </Link>
          )}
        </div>
      );
    case 'failed':
      return (
        <div className="space-y-1">
          <p className="text-destructive">{t('outcome.failed')}</p>
          {said}
        </div>
      );
    default:
      return null;
  }
}

// Another time for a scheduled channel, its approvals kept (#580): the calendar's drag, from the keyboard.
function MoveTime({ variantId, at, onDone }: { variantId: string; at: string | null; onDone: () => void }) {
  const t = useTranslations('social');
  const [open, setOpen] = useState(false);
  const [when, setWhen] = useState(() => toLocalInput(at ?? new Date(Date.now() + 3_600_000).toISOString()));
  const move = useMutation({
    mutationFn: () => client.social.variants.reschedule({ variantId, at: fromLocalInput(when) as string }),
    onSuccess: () => {
      setOpen(false);
      onDone();
    },
  });
  if (!open) {
    return (
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          // From the time it has now (a drag in the calendar or another tab may have moved it).
          setWhen(toLocalInput(at ?? new Date(Date.now() + 3_600_000).toISOString()));
          setOpen(true);
        }}
      >
        {t('moveTime')}
      </Button>
    );
  }
  return (
    <span className="flex flex-wrap items-center gap-2">
      <Input type="datetime-local" aria-label={t('moveTime')} value={when} min={toLocalInput(new Date().toISOString())} onChange={(e) => setWhen(e.target.value)} className="h-8 max-w-56" />
      <Button size="sm" disabled={move.isPending || !fromLocalInput(when)} onClick={() => move.mutate()}>
        {t('moveTimeSave')}
      </Button>
      <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
        {t('keep')}
      </Button>
      {move.error && <ErrorText>{errorMessage(move.error)}</ErrorText>}
    </span>
  );
}

const POST_METRICS = ['reach', 'impressions', 'views', 'reactions', 'comments', 'shares', 'saves', 'clicks'] as const;

// A published channel's latest counts, as the platform reported them; a count it does not report is left out.
function VariantMetrics({ row }: { row: { metrics: Record<string, number>; capturedAt: string | null } | undefined }) {
  const t = useTranslations('social');
  const f = useFormat();
  if (!row?.capturedAt) return <p className="text-subtle-foreground">{t('metricsNotYet')}</p>;
  const shown = POST_METRICS.filter((m) => row.metrics[m] !== undefined);
  if (shown.length === 0) return <p className="text-subtle-foreground">{t('metricsNone', { when: f.dateTime(row.capturedAt) })}</p>;
  return (
    <div className="space-y-1">
      <dl className="flex flex-wrap gap-x-4 gap-y-1">
        {shown.map((m) => (
          <div key={m} className="flex gap-1">
            <dt>{t(`metric.${m}`)}</dt>
            <dd className="font-medium text-foreground tabular-nums">{f.number(row.metrics[m] ?? 0)}</dd>
          </div>
        ))}
      </dl>
      <p className="text-subtle-foreground">{t('metricsAt', { when: f.dateTime(row.capturedAt) })}</p>
    </div>
  );
}

// Each post gets fresh page state: the route keeps the page mounted when it opens another post (a repost, its source).
export function SocialPostPage() {
  const { slug, id: postId } = useParams({ strict: false }) as { slug: string; id: string };
  return <PostScreen key={postId} slug={slug} postId={postId} />;
}

function PostScreen({ slug, postId }: { slug: string; postId: string }) {
  const t = useTranslations('social');
  const f = useFormat();
  const { canDecide, canWrite } = useRole(slug);
  const navigate = useNavigate();
  const post = useQuery(orpc.social.posts.get.queryOptions({ input: { postId } }));
  // The latest counts of each published channel (#578).
  const metrics = useQuery({ ...orpc.social.metrics.summary.queryOptions({ input: { postId } }), enabled: post.data?.variants.some((v) => v.status === 'published') ?? false });
  const channels = useQuery(orpc.channels.list.queryOptions({ input: { includeRevoked: true } }));
  const names = useMemo(() => new Map((channels.data ?? []).map((c: Channel) => [c.id, c.displayName])), [channels.data]);
  const [base, setBase] = useState<Base | null>(null);
  const [own, setOwn] = useState<Record<string, Own>>({});
  // An AI rewrite was taken into the text (#583): the next save marks the post AI-assisted.
  const [aiUsed, setAiUsed] = useState(false);
  // The server content the edits started from. A status change elsewhere (a teammate approving another channel, the
  // publisher) keeps the edits; a content change elsewhere replaces them only when there are none, else it says so.
  const [origin, setOrigin] = useState<Post | null>(null);
  const [stale, setStale] = useState(false);
  const [flash] = useState(takeFlash);
  const adopt = (p: Post, keepOwn = false) => {
    setOrigin(p);
    setBase(baseOf(p));
    if (!keepOwn) setOwn(Object.fromEntries(p.variants.map((v) => [v.id, ownOf(v)])));
    setStale(false);
  };
  const editsOf = (o: Post) =>
    base !== null &&
    (JSON.stringify(base) !== JSON.stringify(baseOf(o)) ||
      o.variants.some((v) => EDITABLE.includes(v.status) && own[v.id] !== undefined && !sameOwn(own[v.id] as Own, ownOf(v))));
  useEffect(() => {
    const p = post.data;
    if (!p) return;
    if (!origin) adopt(p);
    else if (contentKey(p) === contentKey(origin)) setOrigin(p);
    else if (!editsOf(origin)) adopt(p);
    else setStale(true);
  }, [post.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = () => void queryClient.invalidateQueries();
  // After this page's own save: read the post once and take it as the new starting point here, rather than waiting
  // for a refetch to notice (a refetch identical to the cache never fires the effect above).
  const settle = async (keepOwn: boolean) => {
    const p = await client.social.posts.get({ postId });
    queryClient.setQueryData(orpc.social.posts.get.queryOptions({ input: { postId } }).queryKey, p);
    adopt(p, keepOwn);
  };
  const save = useMutation({
    mutationFn: async () => {
      if (!origin || !base) return;
      const before = baseOf(origin);
      const mediaChanged = JSON.stringify(mediaInput(base.media)) !== JSON.stringify(mediaInput(before.media));
      const baseChanged = base.body !== before.body || base.title !== before.title || base.linkUrl !== before.linkUrl || mediaChanged;
      let baseSaved = false;
      try {
        if (baseChanged) {
          await client.social.posts.update({
            postId,
            revision: origin.revision,
            body: base.body,
            title: orNull(base.title),
            linkUrl: orNull(base.linkUrl),
            ...(mediaChanged ? { media: mediaInput(base.media) } : {}),
            ...(aiUsed ? { aiAssisted: true as const } : {}),
          });
          baseSaved = true;
        }
        // Base edits move the inheriting variants' revisions: read them again before saving overrides.
        const fresh = await client.social.posts.get({ postId });
        for (const v of fresh.variants) {
          const mine = own[v.id];
          // Only what was edited here: a channel left as it was loaded keeps what another tab may have saved since.
          const loaded = origin.variants.find((ov) => ov.id === v.id);
          if (!mine || (loaded && sameOwn(mine, ownOf(loaded))) || sameOwn(mine, ownOf(v)) || !EDITABLE.includes(v.status)) continue;
          await client.social.variants.update({
            variantId: v.id,
            revision: v.revision,
            body: mine.custom ? mine.body : null,
            title: mine.custom ? orNull(mine.title) : null,
            ...(sameSettings(mine.settings, v.settings) ? {} : { settings: mine.settings as Record<string, string | boolean> }),
            ...(aiUsed ? { aiAssisted: true as const } : {}),
            ...(mine.customMedia === v.ownMedia && (!mine.customMedia || sameMediaList(mine.media, mediaItems(v.media))) ? {} : { media: mine.customMedia ? mediaInput(mine.media) : null }),
          });
        }
      } catch (error) {
        // A save that failed part way: take what went in (the shared text, some channels) and keep the channel edits
        // not saved yet. Shared text that did not go in stays as typed, so the server's is not taken over it.
        if (baseSaved || !baseChanged) await settle(true).catch(() => undefined);
        throw error;
      }
      await settle(false);
    },
    onSettled: refresh,
  });
  const submit = useMutation({ mutationFn: () => client.social.posts.submit({ postId }), onSuccess: refresh });
  // A repost opens as a new draft for the same channels.
  const repost = useMutation({
    mutationFn: () => client.social.posts.repost({ postId }),
    onSuccess: (made) => {
      refresh();
      void navigate({ to: '/o/$slug/social/$id', params: { slug, id: made.postId } });
    },
  });
  // A copy of the post as a new draft, opened at once.
  const duplicate = useMutation({
    mutationFn: () => client.social.posts.duplicate({ postId }),
    onSuccess: (made) => {
      refresh();
      void navigate({ to: '/o/$slug/social/$id', params: { slug, id: made.postId } });
    },
  });
  const unschedule = useMutation({ mutationFn: (variantId: string) => client.social.variants.unschedule({ variantIds: [variantId] }), onSuccess: refresh });
  // The first comment again (#587); the worker posts it in a moment.
  const retryComment = useMutation({ mutationFn: (variantId: string) => client.social.variants.retryComment({ variantId }), onSuccess: refresh });
  const cancel = useMutation({ mutationFn: (variantId: string) => client.social.variants.cancel({ variantIds: [variantId] }), onSuccess: refresh });
  const retry = useMutation({ mutationFn: (variantId: string) => client.social.variants.retry({ variantIds: [variantId] }), onSuccess: refresh });
  const resolve = useMutation({
    mutationFn: (args: { variantId: string; outcome: 'published' | 'dropped' }) => client.social.variants.resolve({ variantIds: [args.variantId], outcome: args.outcome }),
    onSuccess: refresh,
  });

  if (post.isLoading || !base || !origin) return post.error ? <ErrorText>{errorMessage(post.error)}</ErrorText> : <Spinner />;
  if (!post.data) return null;
  const p = post.data;
  const dirty = editsOf(origin);
  const editable = canWrite && p.variants.some((v) => EDITABLE.includes(v.status));
  const submittable = p.variants.filter((v) => SUBMITTABLE.includes(v.status));
  const onKey = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 's' && dirty && !save.isPending) {
      e.preventDefault();
      save.mutate();
    }
  };
  const published = p.variants.some((v) => v.status === 'published');
  const metricsOf = new Map((metrics.data ?? []).map((r) => [r.variantId, r]));
  const error = save.error ?? submit.error ?? retryComment.error ?? repost.error ?? duplicate.error ?? unschedule.error ?? cancel.error ?? retry.error ?? resolve.error;
  const reviewable = !dirty && !stale;

  return (
    <div onKeyDown={onKey}>
      <PageHeader
        title={t('postTitle')}
        subtitle={t('postSubtitle', { updated: f.dateTime(p.updatedAt) })}
        actions={
          <>
            <Link to="/o/$slug/social" params={{ slug }} className="inline-flex h-9 items-center px-2.5 text-sm text-muted-foreground hover:text-foreground">
              {t('back')}
            </Link>
            {editable && (
              <Button variant="outline" size="lg" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
                {save.isPending ? <Spinner className="text-current" /> : null}
                {t('save')}
              </Button>
            )}
            {canWrite && submittable.length > 0 && (
              <Button size="lg" disabled={dirty || submit.isPending} title={dirty ? t('saveFirst') : undefined} onClick={() => submit.mutate()}>
                {t('submit')}
              </Button>
            )}
            {canWrite && published && (
              <Button variant="outline" size="lg" disabled={dirty || repost.isPending} title={t('repostHint')} onClick={() => repost.mutate()}>
                {repost.isPending ? <Spinner className="text-current" /> : null}
                {t('repost')}
              </Button>
            )}
            {canWrite && (
              <Button variant="outline" size="lg" disabled={dirty || duplicate.isPending} title={dirty ? t('saveFirst') : t('duplicateHint')} onClick={() => duplicate.mutate()}>
                {duplicate.isPending ? <Spinner className="text-current" /> : null}
                {t('duplicate')}
              </Button>
            )}
          </>
        }
      />
      {(error || flash) && (
        <div className="mb-4">
          <ErrorText>{error ? errorMessage(error) : flash}</ErrorText>
        </div>
      )}
      {(p.origin === 'ai' || p.tainted) && (
        <div className="mb-4 flex items-center gap-2 rounded-xl border bg-muted px-4 py-3 text-sm text-foreground">
          <Badge variant="secondary">{t(p.origin === 'ai' ? 'aiBadge' : 'aiAssistedBadge')}</Badge>
          <span>{t(p.origin === 'ai' ? 'aiBadgeHint' : 'aiAssistedHint')}</span>
        </div>
      )}
      {p.repostOf && (
        <div className="mb-4 rounded-xl border bg-muted px-4 py-3 text-sm text-foreground">
          {t('repostOf')}{' '}
          <Link to="/o/$slug/social/$id" params={{ slug, id: p.repostOf }} className="text-link hover:underline">
            {t('repostOfLink')}
          </Link>
        </div>
      )}
      {stale && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-sm text-foreground">
          <span>{t('changedElsewhere')}</span>
          <Button variant="outline" size="sm" onClick={() => adopt(p)}>
            {t('loadLatest')}
          </Button>
        </div>
      )}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="space-y-4">
          <SharedFields base={base} onChange={setBase} disabled={!editable || save.isPending} needsTitle={p.variants.some((v) => hasTitle(v.provider))} onAiUsed={() => setAiUsed(true)} />
          {canDecide && reviewable && <ReviewPanel post={p} names={names} onDone={refresh} />}
          {canDecide && reviewable && <SchedulePanel post={p} names={names} onDone={refresh} />}
          {canWrite && (published || p.evergreenDays !== null) && <EvergreenPanel post={p} onDone={refresh} />}
          {dirty && <p className="text-xs text-subtle-foreground">{t('unsaved')}</p>}
        </div>
        <div className="space-y-4">
          {p.variants.map((v) => {
            const frozen = !EDITABLE.includes(v.status);
            const decision = v.latestDecision;
            return (
              <ChannelEditor
                key={v.id}
                provider={v.provider}
                channel={names.get(v.connectionId) ?? providerName(v.provider)}
                // A channel's own link (set on the variant) is the one its adapter sends, so its checks count that one.
                base={frozen ? { body: v.effective.body, title: v.effective.title ?? '', linkUrl: v.effective.linkUrl ?? '', media: mediaItems(v.media) } : v.overrides.linkUrl != null ? { ...base, linkUrl: v.overrides.linkUrl } : base}
                own={frozen ? EMPTY_OWN : (own[v.id] ?? ownOf(v))}
                connectionId={v.connectionId}
                onAiUsed={() => setAiUsed(true)}
                disabled={frozen || !canWrite || save.isPending}
                status={v.status}
                onChange={(next) => setOwn({ ...own, [v.id]: next })}
                footer={
                  <div className="space-y-2 border-t pt-3 text-xs text-muted-foreground">
                    {v.effectiveAt && ['scheduled', 'paused', 'publishing', 'processing', 'published'].includes(v.status) && (
                      <p>{t(v.status === 'published' ? 'publishedAt' : 'goesOutAt', { when: f.dateTime(v.effectiveAt) })}{v.queueSlotAt && v.status !== 'published' ? ` · ${t('fromQueue')}` : ''}</p>
                    )}
                    {decision && decision.comment && ['changes_requested', 'rejected'].includes(v.status) && <p className="text-warning">{t('reviewerSaid', { comment: decision.comment })}</p>}
                    {v.status === 'in_review' && v.review.required > 1 && <p>{t('reviewSteps', { given: String(v.review.approvedBy.length), required: String(v.review.required) })}</p>}
                    <Outcome variant={v} slug={slug} />
                    {v.externalUrl && (
                      <a href={v.externalUrl} target="_blank" rel="noopener noreferrer" className="text-link hover:underline">
                        {t('openPost')}
                      </a>
                    )}
                    {v.commentStatus && (
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={v.commentStatus === 'failed' || v.commentStatus === 'unknown' ? 'text-warning' : ''}>{t(`commentStatus.${v.commentStatus}`)}</span>
                        {canDecide && (v.commentStatus === 'failed' || v.commentStatus === 'unknown') && (
                          <Button variant="outline" size="sm" disabled={retryComment.isPending} onClick={() => retryComment.mutate(v.id)}>
                            {t('commentRetry')}
                          </Button>
                        )}
                      </div>
                    )}
                    {v.status === 'published' && <VariantMetrics row={metricsOf.get(v.id)} />}
                    <div className="flex flex-wrap gap-2">
                      {canDecide && (v.status === 'failed' || v.status === 'needs_attention') && (
                        <Button variant="outline" size="sm" disabled={retry.isPending} onClick={() => retry.mutate(v.id)}>
                          {t(v.status === 'failed' ? 'retry' : 'retryUnknown')}
                        </Button>
                      )}
                      {canDecide && v.status === 'needs_attention' && (
                        <>
                          <Button variant="outline" size="sm" disabled={resolve.isPending} onClick={() => resolve.mutate({ variantId: v.id, outcome: 'published' })}>
                            {t('confirmPublished')}
                          </Button>
                          <Button variant="ghost" size="sm" disabled={resolve.isPending} onClick={() => resolve.mutate({ variantId: v.id, outcome: 'dropped' })}>
                            {t('dropChannel')}
                          </Button>
                        </>
                      )}
                      {canDecide && v.status === 'scheduled' && !v.queuePaused && <MoveTime variantId={v.id} at={v.effectiveAt} onDone={refresh} />}
                      {canDecide && ['scheduled', 'paused'].includes(v.status) && (
                        <Button variant="outline" size="sm" disabled={unschedule.isPending} onClick={() => unschedule.mutate(v.id)}>
                          {t('unschedule')}
                        </Button>
                      )}
                      {canWrite && CANCELLABLE.includes(v.status) && (canDecide || !['approved', 'scheduled', 'paused'].includes(v.status)) && (
                        <Button variant="ghost" size="sm" disabled={cancel.isPending} onClick={() => cancel.mutate(v.id)}>
                          {t('cancelChannel')}
                        </Button>
                      )}
                    </div>
                  </div>
                }
              />
            );
          })}
        </div>
        <PostActivity postId={p.id} channels={p.variants.map((v) => ({ variantId: v.id, name: names.get(v.connectionId) ?? providerName(v.provider) }))} canWrite={canWrite} className="lg:col-span-2" />
      </div>
    </div>
  );
}
