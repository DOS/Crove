// Crove Social home: what goes out next (an agenda by day), what waits for review, drafts, and what went out.
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useMemo, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { Badge } from '@crove/ui/components/badge';
import { Button, buttonVariants } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Input } from '@crove/ui/components/input';
import { SOCIAL_IMAGE_TYPES, SOCIAL_VIDEO_TYPES } from '@crove/kernel-contract';
import { bestTimes, type PublishedSample } from '@crove/mod-social/contract';
import { cn } from '@crove/ui/lib/utils';
import { Thumb, sizeLabel, useLibrary, type LibraryItem } from '../components/social-media.tsx';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@crove/ui/components/tabs';
import { Empty, ErrorText, PageHeader, Spinner } from '../components/ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { client, errorMessage, orpc, queryClient, uploadFiles } from '../lib/api.ts';
import { dayKey, providerName, VARIANT_TONE } from '../lib/social.ts';
import { pollEvery, SAFETY_POLL_MS, useStreamLive } from '../lib/stream-hook.ts';

type Tab = 'upcoming' | 'review' | 'drafts' | 'done' | 'metrics' | 'library';
const TABS: Tab[] = ['upcoming', 'review', 'drafts', 'done', 'metrics', 'library'];
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

export function SocialPage() {
  const { slug } = useParams({ strict: false }) as { slug: string };
  const t = useTranslations('social');
  const f = useFormat();
  const live = useStreamLive();
  const [tab, setTab] = useState<Tab>('upcoming');
  // The agenda window starts now; a new day does not need a reload to move it, a refetch does.
  const range = useMemo(() => {
    const from = new Date(Date.now() - DAY);
    return { from: from.toISOString(), to: new Date(from.getTime() + (AGENDA_DAYS + 1) * DAY).toISOString() };
  }, []);
  const channels = useQuery(orpc.channels.list.queryOptions({ input: {} }));
  const me = useQuery(orpc.me.get.queryOptions());
  const role = me.data?.orgs.find((o) => o.slug === slug)?.role;
  const canWrite = role === 'owner' || role === 'admin' || role === 'member';
  const upcoming = useQuery({ ...orpc.social.posts.list.queryOptions({ input: { ...range, limit: 200 } }), enabled: tab === 'upcoming', refetchInterval: pollEvery(live, 30_000, SAFETY_POLL_MS) });
  const all = useQuery({ ...orpc.social.posts.list.queryOptions({ input: { limit: 200 } }), enabled: tab !== 'upcoming', refetchInterval: pollEvery(live, 30_000, SAFETY_POLL_MS) });
  const names = new Map((channels.data ?? []).map((c) => [c.id, c.displayName]));
  const noChannels = channels.isSuccess && channels.data.length === 0;

  const lists: Record<Exclude<Tab, 'upcoming' | 'metrics' | 'library'>, Post[]> = {
    review: (all.data ?? []).filter((p) => p.variants.some((v) => v.status === 'in_review')),
    drafts: (all.data ?? []).filter((p) => p.status === 'draft' && !p.variants.some((v) => v.status === 'in_review')),
    done: (all.data ?? []).filter((p) => ['published', 'partially_published', 'failed', 'publishing', 'cancelled'].includes(p.status)),
  };
  const reviewCount = lists.review.length;

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
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="upcoming">
          {upcoming.isLoading ? <Spinner /> : upcoming.error ? <ErrorText>{errorMessage(upcoming.error)}</ErrorText> : <Agenda posts={upcoming.data ?? []} slug={slug} names={names} />}
        </TabsContent>
        <TabsContent value="metrics">
          <Metrics slug={slug} names={names} />
        </TabsContent>
        <TabsContent value="library">{tab === 'library' && <Library slug={slug} canWrite={canWrite} />}</TabsContent>
        {(['review', 'drafts', 'done'] as const).map((id) => (
          <TabsContent key={id} value={id}>
            {all.isLoading ? (
              <Spinner />
            ) : all.error ? (
              <ErrorText>{errorMessage(all.error)}</ErrorText>
            ) : lists[id].length === 0 ? (
              <Empty title={t(`empty.${id}`)} />
            ) : (
              <div className="space-y-2">
                {lists[id].map((post) => (
                  <PostRow key={post.id} post={post} slug={slug} names={names} right={f.dateTime(post.updatedAt)} />
                ))}
              </div>
            )}
          </TabsContent>
        ))}
      </Tabs>
    </>
  );
}
