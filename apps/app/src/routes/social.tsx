// Crove Social home: what goes out next (an agenda by day), what waits for review, drafts, and what went out.
import { useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { Badge } from '@crove/ui/components/badge';
import { Button, buttonVariants } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Checkbox } from '@crove/ui/components/checkbox';
import { Input } from '@crove/ui/components/input';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { SOCIAL_IMAGE_TYPES, SOCIAL_VIDEO_TYPES } from '@crove/kernel-contract';
import { bestTimes, type PublishedSample } from '@crove/mod-social/contract';
import { cn } from '@crove/ui/lib/utils';
import { Thumb, sizeLabel, useLibrary, type LibraryItem } from '../components/social-media.tsx';
import { SocialCalendar } from '../components/social-calendar.tsx';
import { BulkBar } from '../components/social-bulk.tsx';
import type { BulkAction } from '../lib/social-bulk.ts';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@crove/ui/components/tabs';
import { Empty, ErrorText, PageHeader, Spinner } from '../components/ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { client, errorMessage, orpc, queryClient, uploadFiles } from '../lib/api.ts';
import { dayKey, dayRange, providerName, SOCIAL_TABS, VARIANT_TONE, type SocialSearch, type SocialTab } from '../lib/social.ts';
import { pollEvery, SAFETY_POLL_MS, useStreamLive } from '../lib/stream-hook.ts';

type Tab = SocialTab;
const TABS = SOCIAL_TABS;
// Posts a list page shows; Load more asks for the next ones.
const PAGE = 50;
type ListTab = 'review' | 'attention' | 'drafts' | 'done';
type PostCursor = { updatedAt: string; postId: string };
// The counts the analytics table shows, in order; a platform that does not report one shows a dash.
const METRIC_COLUMNS = ['reach', 'reactions', 'comments', 'shares'] as const;
const DAY = 86_400_000;
// The agenda lists what goes out in the next year, day by day.
const AGENDA_DAYS = 366;

type Post = Awaited<ReturnType<typeof orpc.social.posts.list.call>>[number];
type Variant = Post['variants'][number];

function excerpt(text: string, max = 160): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

function ChannelChips({ post, names }: { post: Post; names: Map<string, string> }) {
  const t = useTranslations('social');
  return (
    <div className="flex flex-wrap gap-1.5">
      {post.variants
        .filter((v) => v.status !== 'cancelled')
        .map((v) => (
          <Badge key={v.id} variant={VARIANT_TONE[v.status]} title={names.get(v.connectionId)}>
            {providerName(v.provider)} · {t(`status.${v.status}`)}
          </Badge>
        ))}
    </div>
  );
}

function PostRow({ post, slug, names, right }: { post: Post; slug: string; names: Map<string, string>; right?: string }) {
  const t = useTranslations('social');
  return (
    <Link
      to="/o/$slug/social/$id"
      params={{ slug, id: post.id }}
      className="flex flex-col gap-2 rounded-xl border bg-card px-4 py-3 transition-colors hover:border-ring/60 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="min-w-0 space-y-1.5">
        <p className="line-clamp-2 text-sm [overflow-wrap:anywhere] text-foreground">{excerpt(post.body) || <span className="text-subtle-foreground">{t('emptyText')}</span>}</p>
        <ChannelChips post={post} names={names} />
      </div>
      {right && <span className="shrink-0 text-xs text-subtle-foreground tabular-nums">{right}</span>}
    </Link>
  );
}

// How published posts did (S8): totals over the window, then each published channel with its latest capture.
function Metrics({ slug, names }: { slug: string; names: Map<string, string> }) {
  const t = useTranslations('social');
  const f = useFormat();
  const [days, setDays] = useState(30);
  const rows = useQuery(orpc.social.metrics.summary.queryOptions({ input: { days } }));
  // The window as a CSV file, built and audited by the server, saved by the browser.
  const exportCsv = useMutation({
    mutationFn: () => client.social.metrics.export({ days }),
    onSuccess: (file) => {
      const url = URL.createObjectURL(new Blob([file.csv], { type: 'text/csv;charset=utf-8' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = file.filename;
      a.click();
      // Some browsers still read the link a moment after the click.
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    },
  });
  if (rows.isLoading) return <Spinner />;
  if (rows.error) return <ErrorText>{errorMessage(rows.error)}</ErrorText>;
  const data = rows.data ?? [];
  const total = (name: string) => data.reduce((sum, r) => sum + (r.metrics[name] ?? 0), 0);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {[7, 30, 90].map((d) => (
          <Button key={d} variant={d === days ? 'secondary' : 'ghost'} size="sm" onClick={() => setDays(d)}>
            {t('metricsDays', { days: String(d) })}
          </Button>
        ))}
        {data.length > 0 && (
          <Button variant="outline" size="sm" className="ml-auto" disabled={exportCsv.isPending} onClick={() => exportCsv.mutate()}>
            {t('metricsExport')}
          </Button>
        )}
      </div>
      {exportCsv.error && <ErrorText>{errorMessage(exportCsv.error)}</ErrorText>}
      {exportCsv.data?.truncated && <p className="text-xs text-warning">{t('metricsExportCut')}</p>}
      {data.length === 0 ? (
        <Empty title={t('empty.metrics')} hint={t('metricsHint')} />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {METRIC_COLUMNS.map((m) => (
              <Card key={m} className="block p-4">
                <p className="text-xs text-subtle-foreground">{t(`metric.${m}`)}</p>
                <p className="mt-1 text-xl font-semibold text-foreground tabular-nums">{f.number(total(m))}</p>
              </Card>
            ))}
          </div>
          {data.length >= 500 && <p className="text-xs text-subtle-foreground">{t('metricsCapped')}</p>}
          <BestTimes rows={data} names={names} />
          <div className="overflow-x-auto rounded-xl border">
            <table className="w-full text-sm">
              <thead className="bg-muted text-xs text-subtle-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">{t('metricsPost')}</th>
                  {METRIC_COLUMNS.map((m) => (
                    <th key={m} className="px-3 py-2 text-right font-medium">
                      {t(`metric.${m}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.map((r) => (
                  <tr key={r.variantId} className="border-t">
                    <td className="max-w-md px-3 py-2">
                      <Link to="/o/$slug/social/$id" params={{ slug, id: r.postId }} className="line-clamp-1 text-foreground hover:underline">
                        {r.excerpt || t('emptyText')}
                      </Link>
                      <p className="text-xs text-subtle-foreground">
                        {[providerName(r.provider), names.get(r.connectionId), r.publishedAt ? f.dateTime(r.publishedAt) : null, r.capturedAt ? t('metricsAsOf', { when: f.dateTime(r.capturedAt) }) : t('metricsPending')]
                          .filter(Boolean)
                          .join(' · ')}
                      </p>
                    </td>
                    {METRIC_COLUMNS.map((m) => (
                      <td key={m} className="px-3 py-2 text-right text-foreground tabular-nums">
                        {r.metrics[m] === undefined ? '-' : f.number(r.metrics[m])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

// When each channel's posts drew the most engagement, in the viewer's time zone, from the posts in the window.
function BestTimes({ rows, names }: { rows: readonly PublishedSample[]; names: Map<string, string> }) {
  const t = useTranslations('social');
  const f = useFormat();
  const best = useMemo(() => bestTimes(rows, Intl.DateTimeFormat().resolvedOptions().timeZone), [rows]);
  if (best.size === 0) return null;
  return (
    <Card className="block space-y-3 p-4">
      <div>
        <p className="text-sm font-medium text-foreground">{t('bestTimesTitle')}</p>
        <p className="text-xs text-subtle-foreground">{t('bestTimesHint')}</p>
      </div>
      <ul className="space-y-2">
        {[...best.entries()].map(([connectionId, slots]) => (
          <li key={connectionId} className="text-sm">
            <span className="text-foreground">{names.get(connectionId) ?? connectionId.slice(0, 8)}</span>
            <span className="text-subtle-foreground">
              {': '}
              {slots
                .map((s) => t('bestTimesSlot', { day: t(`weekday.${DAY_KEYS[s.weekday - 1] ?? 'mon'}`), hour: String(s.hour).padStart(2, '0'), engagement: f.number(Math.round(s.engagement)), posts: String(s.posts) }))
                .join(' · ')}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

// The posts that show an image.
function Usage({ fileId, slug }: { fileId: string; slug: string }) {
  const t = useTranslations('social');
  const f = useFormat();
  const usage = useQuery(orpc.social.media.usage.queryOptions({ input: { fileId } }));
  if (usage.isLoading) return <Spinner />;
  if (usage.error) return <ErrorText>{errorMessage(usage.error)}</ErrorText>;
  if ((usage.data ?? []).length === 0) return <p className="text-xs text-subtle-foreground">{t('libraryUsageNone')}</p>;
  return (
    <ul className="space-y-2">
      {(usage.data ?? []).map((u) => (
        <li key={u.postId}>
          <Link to="/o/$slug/social/$id" params={{ slug, id: u.postId }} className="block rounded-lg border px-3 py-2 text-sm hover:border-ring/60">
            <span className="line-clamp-2 [overflow-wrap:anywhere] text-foreground">{u.excerpt || t('emptyText')}</span>
            <span className="text-xs text-subtle-foreground">{f.dateTime(u.updatedAt)}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

// The media library (S9): the org's post images, searchable by name, each with the posts that show it.
function Library({ slug, canWrite }: { slug: string; canWrite: boolean }) {
  const t = useTranslations('social');
  const f = useFormat();
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState<LibraryItem | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const library = useLibrary(search);
  const upload = useMutation({ mutationFn: (files: File[]) => uploadFiles(files, 'social'), onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['social-library'] }) });
  const items = library.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('librarySearch')} aria-label={t('librarySearch')} className="max-w-xs" />
        {canWrite && (
          <>
            <input
              ref={picker}
              type="file"
              multiple
              accept={[...SOCIAL_IMAGE_TYPES, ...SOCIAL_VIDEO_TYPES].join(',')}
              className="hidden"
              onChange={(e) => {
                const files = [...(e.target.files ?? [])];
                e.target.value = '';
                if (files.length > 0) upload.mutate(files);
              }}
            />
            <Button variant="outline" disabled={upload.isPending} onClick={() => picker.current?.click()}>
              {upload.isPending ? <Spinner className="text-current" /> : null}
              {t('libraryUpload')}
            </Button>
          </>
        )}
      </div>
      <p className="text-xs text-subtle-foreground">{t('libraryHint')}</p>
      {upload.error && <ErrorText>{errorMessage(upload.error)}</ErrorText>}
      {library.isLoading ? (
        <Spinner />
      ) : library.error ? (
        <ErrorText>{errorMessage(library.error)}</ErrorText>
      ) : items.length === 0 ? (
        <Empty title={search.trim() ? t('libraryNoMatch') : t('libraryEmpty')} />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-5">
            {items.map((item) => (
              <li key={item.fileId}>
                <button
                  type="button"
                  aria-pressed={open?.fileId === item.fileId}
                  onClick={() => setOpen(open?.fileId === item.fileId ? null : item)}
                  className={cn(
                    'block w-full space-y-1.5 rounded-xl border bg-card p-2 text-left transition-colors hover:border-ring/60 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
                    open?.fileId === item.fileId && 'border-primary/60',
                  )}
                >
                  <Thumb fileId={item.fileId} alt={item.filename} mime={item.mime} durationMs={item.durationMs} className="aspect-square" />
                  <span className="block truncate text-xs text-foreground" title={item.filename}>
                    {item.filename}
                  </span>
                  <span className="block text-xs text-subtle-foreground tabular-nums">
                    {sizeLabel(item.sizeBytes)} · {item.usedIn > 0 ? t('libraryUsedIn', { count: String(item.usedIn) }) : t('libraryUnused')}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {open && (
            <Card className="block h-fit space-y-3 p-4">
              <Thumb fileId={open.fileId} alt={open.filename} mime={open.mime} durationMs={open.durationMs} className="aspect-[4/3]" />
              <p className="text-sm font-medium [overflow-wrap:anywhere] text-foreground">{open.filename}</p>
              <p className="text-xs text-subtle-foreground">{f.dateTime(open.createdAt)}</p>
              <p className="text-sm font-medium text-muted-foreground">{t('libraryUsageTitle')}</p>
              <Usage fileId={open.fileId} slug={slug} />

            </Card>
          )}
        </div>
      )}
      {library.hasNextPage && (
        <Button variant="ghost" size="sm" disabled={library.isFetchingNextPage} onClick={() => void library.fetchNextPage()}>
          {t('libraryMore')}
        </Button>
      )}
    </div>
  );
}

function Agenda({ posts, slug, names }: { posts: Post[]; slug: string; names: Map<string, string> }) {
  const t = useTranslations('social');
  const f = useFormat();
  // One line per variant going out, grouped by local day.
  const items = posts
    .flatMap((post) => post.variants.filter((v) => ['scheduled', 'paused', 'publishing', 'processing'].includes(v.status) && v.effectiveAt).map((v) => ({ post, v })))
    .sort((a, b) => Date.parse(a.v.effectiveAt as string) - Date.parse(b.v.effectiveAt as string));
  if (items.length === 0) return <Empty title={t('agendaEmpty')} hint={t('agendaEmptyHint')} />;
  const days = new Map<string, Array<{ post: Post; v: Variant }>>();
  for (const item of items) {
    const key = dayKey(item.v.effectiveAt as string);
    days.set(key, [...(days.get(key) ?? []), item]);
  }
  return (
    <div className="space-y-6">
      {[...days.entries()].map(([key, list]) => (
        <section key={key}>
          <h3 className="mb-2 text-sm font-medium text-muted-foreground">{f.date(key)}</h3>
          <div className="space-y-2">
            {list.map(({ post, v }) => (
              <Link
                key={v.id}
                to="/o/$slug/social/$id"
                params={{ slug, id: post.id }}
                className="flex items-start gap-4 rounded-xl border bg-card px-4 py-3 transition-colors hover:border-ring/60"
              >
                <span className="w-14 shrink-0 pt-0.5 font-mono text-sm text-foreground tabular-nums">
                  {f.time(v.effectiveAt)}
                </span>
                <div className="min-w-0 flex-1 space-y-1.5">
                  <p className="line-clamp-2 text-sm [overflow-wrap:anywhere] text-foreground">{excerpt(v.effective.body) || t('emptyText')}</p>
                  <div className="flex flex-wrap items-center gap-1.5 text-xs text-subtle-foreground">
                    <Badge variant="outline">{providerName(v.provider)}</Badge>
                    <span className="truncate">{names.get(v.connectionId)}</span>
                    {v.queueSlotAt && <span>· {t('fromQueue')}</span>}
                    {v.status !== 'scheduled' && <Badge variant={VARIANT_TONE[v.status]}>{t(`status.${v.status}`)}</Badge>}
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

// Drops empty filters, so the address shows only what is set.
const clean = (s: { [K in keyof SocialSearch]?: SocialSearch[K] | undefined }): SocialSearch => Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined && v !== '')) as SocialSearch;

export function SocialPage() {
  const { slug } = useParams({ strict: false }) as { slug: string };
  const t = useTranslations('social');
  const f = useFormat();
  const live = useStreamLive();
  const search: SocialSearch = useSearch({ strict: false });
  const navigate = useNavigate();
  const tab: Tab = search.tab ?? 'upcoming';
  // Changes the address, so the back button and a shared link keep the list; replaces rather than piles up history.
  const setSearch = useCallback(
    (next: { [K in keyof SocialSearch]?: SocialSearch[K] | undefined }) => void navigate({ to: '/o/$slug/social', params: { slug }, search: (prev: SocialSearch) => clean({ ...prev, ...next }), replace: true }),
    [navigate, slug],
  );
  const setTab = (next: Tab) => setSearch({ tab: next === 'upcoming' ? undefined : next });
  // The search box writes the address a moment after typing stops.
  const [text, setText] = useState(search.q ?? '');
  // The address changed from outside (back, a link, Clear): the box follows, unless it already says the same.
  useEffect(() => setText((now) => (now.trim() === (search.q ?? '') ? now : (search.q ?? ''))), [search.q]);
  useEffect(() => {
    const q = text.trim() || undefined;
    if (q === search.q) return;
    const timer = setTimeout(() => setSearch({ q }), 300);
    return () => clearTimeout(timer);
  }, [text, search.q, setSearch]);
  const filters = { ...(search.channel ? { connectionId: search.channel } : {}), ...(search.q ? { search: search.q } : {}) };
  // The agenda window starts now; a new day does not need a reload to move it, a refetch does.
  const range = useMemo(() => {
    const from = new Date(Date.now() - DAY);
    return { from: from.toISOString(), to: new Date(from.getTime() + (AGENDA_DAYS + 1) * DAY).toISOString() };
  }, []);
  const channels = useQuery(orpc.channels.list.queryOptions({ input: {} }));
  const me = useQuery(orpc.me.get.queryOptions());
  const role = me.data?.orgs.find((o) => o.slug === slug)?.role;
  const canWrite = role === 'owner' || role === 'admin' || role === 'member';
  const upcoming = useQuery({ ...orpc.social.posts.list.queryOptions({ input: { ...range, ...filters, limit: 200 } }), enabled: tab === 'upcoming', refetchInterval: pollEvery(live, 30_000, SAFETY_POLL_MS) });
  const listTab: ListTab | null = tab === 'review' || tab === 'attention' || tab === 'drafts' || tab === 'done' ? tab : null;
  // The server filters and pages (#574); a page at a time, newest change first.
  const list = useInfiniteQuery({
    ...orpc.social.posts.list.infiniteOptions({
      input: (before: PostCursor | undefined) => ({ stage: listTab ?? 'review', ...filters, ...dayRange(search.from, search.to), limit: PAGE, ...(before ? { before } : {}) }),
      initialPageParam: undefined as PostCursor | undefined,
      getNextPageParam: (page: Post[]) => {
        const last = page.at(-1);
        return page.length === PAGE && last ? { updatedAt: last.updatedAt, postId: last.id } : undefined;
      },
    }),
    enabled: listTab !== null,
    refetchInterval: pollEvery(live, 30_000, SAFETY_POLL_MS),
  });
  // The Review tab's count, whatever list is open.
  const review = useQuery({ ...orpc.social.posts.list.queryOptions({ input: { stage: 'review', limit: 200 } }), refetchInterval: pollEvery(live, 30_000, SAFETY_POLL_MS) });
  // Posts with a channel that failed, needs a person or waits on its channel (#579): their count on the tab.
  const attention = useQuery({ ...orpc.social.posts.list.queryOptions({ input: { stage: 'attention', limit: 200 } }), refetchInterval: pollEvery(live, 30_000, SAFETY_POLL_MS) });
  const names = new Map((channels.data ?? []).map((c) => [c.id, c.displayName]));
  const noChannels = channels.isSuccess && channels.data.length === 0;

  const rows = list.data?.pages.flat() ?? [];
  const reviewCount = review.data?.length ?? 0;
  const attentionCount = attention.data?.length ?? 0;
  const filtered = Boolean(search.channel || search.q || search.from || search.to);
  // Posts picked for a bulk action (#635), in the list on screen; a new tab or filter starts afresh.
  const [picked, setPicked] = useState<Set<string>>(new Set());
  useEffect(() => setPicked(new Set()), [tab, search.channel, search.q, search.from, search.to]);
  const canDecide = role === 'owner' || role === 'admin';
  const bulkActions: readonly BulkAction[] = !canWrite ? [] : listTab === 'review' ? (canDecide ? ['approve', 'cancel'] : ['cancel']) : listTab === 'drafts' ? (canDecide ? ['queue', 'cancel'] : ['cancel']) : listTab === 'attention' ? ['cancel'] : [];
  const toggle = (id: string) => setPicked((now) => { const next = new Set(now); if (next.has(id)) next.delete(id); else next.add(id); return next; });

  return (
    <>
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        actions={
          <>
            <Link to="/o/$slug/social/channels" params={{ slug }} className={buttonVariants({ variant: 'outline', size: 'lg' })}>
              {t('channels')}
            </Link>
            {canWrite && !noChannels && (
              <Link to="/o/$slug/social/import" params={{ slug }} className={buttonVariants({ variant: 'outline', size: 'lg' })}>
                {t('import.open')}
              </Link>
            )}
            {!canWrite ? null : noChannels ? (
              <Button size="lg" disabled>
                {t('compose')}
              </Button>
            ) : (
              <Link to="/o/$slug/social/new" params={{ slug }} className={buttonVariants({ size: 'lg' })}>
                {t('compose')}
              </Link>
            )}
          </>
        }
      />
      {noChannels && (
        <Card className="mb-6 flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-medium text-foreground">{t('noChannelsTitle')}</p>
            <p className="mt-1 text-sm text-muted-foreground">{t('noChannelsHint')}</p>
          </div>
          <Link to="/o/$slug/social/channels" params={{ slug }} className={buttonVariants({ size: 'lg' })}>
            {t('connectFirst')}
          </Link>
        </Card>
      )}
      <Tabs className="gap-4" value={tab} onValueChange={(value) => setTab(value as Tab)}>
        <TabsList variant="line" className="w-full justify-start border-b">
          {TABS.map((id) => (
            <TabsTrigger key={id} value={id} className="flex-none px-3">
              {t(`tabs.${id}`)}
              {id === 'review' && reviewCount > 0 && <span className="ml-1.5 rounded-full bg-primary px-1.5 text-xs text-primary-foreground">{reviewCount}</span>}
              {id === 'attention' && attentionCount > 0 && <span className="ml-1.5 rounded-full bg-destructive px-1.5 text-xs text-primary-foreground">{attentionCount}</span>}
            </TabsTrigger>
          ))}
        </TabsList>
        {(tab === 'upcoming' || listTab) && (
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-xs">
              <span className="text-subtle-foreground">{t('filters.channel')}</span>
              <NativeSelect className="mt-1 w-56" value={search.channel ?? ''} onChange={(e) => setSearch({ channel: e.target.value || undefined })}>
                <NativeSelectOption value="">{t('filters.allChannels')}</NativeSelectOption>
                {(channels.data ?? []).map((c) => (
                  <NativeSelectOption key={c.id} value={c.id}>
                    {c.displayName} · {providerName(c.provider)}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </label>
            <label className="min-w-48 flex-1 text-xs sm:max-w-80">
              <span className="text-subtle-foreground">{t('filters.search')}</span>
              <Input type="search" className="mt-1" value={text} placeholder={t('filters.searchPlaceholder')} onChange={(e) => setText(e.target.value)} />
            </label>
            {(listTab === 'review' || listTab === 'done') && (
              <>
                <label className="text-xs">
                  <span className="text-subtle-foreground">{t('filters.from')}</span>
                  <Input type="date" className="mt-1 w-44" value={search.from ?? ''} onChange={(e) => setSearch({ from: e.target.value || undefined })} />
                </label>
                <label className="text-xs">
                  <span className="text-subtle-foreground">{t('filters.to')}</span>
                  <Input type="date" className="mt-1 w-44" value={search.to ?? ''} onChange={(e) => setSearch({ to: e.target.value || undefined })} />
                </label>
              </>
            )}
            {filtered && (
              <Button variant="ghost" onClick={() => setSearch({ channel: undefined, q: undefined, from: undefined, to: undefined })}>
                {t('filters.clear')}
              </Button>
            )}
          </div>
        )}
        <TabsContent value="upcoming">
          {upcoming.isLoading ? <Spinner /> : upcoming.error ? <ErrorText>{errorMessage(upcoming.error)}</ErrorText> : <Agenda posts={upcoming.data ?? []} slug={slug} names={names} />}
        </TabsContent>
        <TabsContent value="calendar">{tab === 'calendar' && <SocialCalendar slug={slug} names={names} canDecide={role === 'owner' || role === 'admin'} />}</TabsContent>
        <TabsContent value="metrics">
          <Metrics slug={slug} names={names} />
        </TabsContent>
        <TabsContent value="library">{tab === 'library' && <Library slug={slug} canWrite={canWrite} />}</TabsContent>
        {(['review', 'attention', 'drafts', 'done'] as const).map((id) => (
          <TabsContent key={id} value={id}>
            {tab === id && (
              <>
                {bulkActions.length > 0 && (
                  <div className="mb-2">
                    <BulkBar
                      posts={rows.filter((p) => picked.has(p.id))}
                      actions={bulkActions}
                      canDecide={canDecide}
                      excerptOf={(postId) => excerpt(rows.find((p) => p.id === postId)?.body ?? '', 60) || t('emptyText')}
                      onClear={() => setPicked(new Set())}
                    />
                  </div>
                )}
                {list.isLoading ? (
                  <Spinner />
                ) : list.error && rows.length === 0 ? (
                  <ErrorText>{errorMessage(list.error)}</ErrorText>
                ) : rows.length === 0 ? (
                  <Empty title={filtered ? t('filters.noMatch') : t(`empty.${id}`)} />
                ) : (
                  <div className="space-y-2">
                    {bulkActions.length > 0 && (
                      <>
                        <label className="flex items-center gap-2 text-xs text-muted-foreground">
                          <Checkbox
                            checked={rows.length > 0 && rows.every((p) => picked.has(p.id))}
                            onCheckedChange={(on) => setPicked(on === true ? new Set(rows.map((p) => p.id)) : new Set())}
                          />
                          {t('bulk.selectAll')}
                        </label>
                      </>
                    )}
                    {rows.map((post) => (
                      <div key={post.id} className="flex items-center gap-2">
                        {bulkActions.length > 0 && <Checkbox checked={picked.has(post.id)} onCheckedChange={() => toggle(post.id)} aria-label={t('bulk.select', { text: excerpt(post.body, 40) || t('emptyText') })} />}
                        <div className="min-w-0 flex-1">
                          <PostRow post={post} slug={slug} names={names} right={f.dateTime(post.updatedAt)} />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                {list.hasNextPage && (
                  <div className="mt-4 flex justify-center">
                    <Button variant="outline" onClick={() => void list.fetchNextPage()} disabled={list.isFetchingNextPage}>
                      {t('filters.loadMore')}
                    </Button>
                  </div>
                )}
              </>
            )}
          </TabsContent>
        ))}
      </Tabs>
    </>
  );
}
