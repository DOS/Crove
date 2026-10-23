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
import { MediaTagEditor, TagFilter, Thumb, sizeLabel, useLibrary, type LibraryItem } from '../components/social-media.tsx';
import { SocialBoard } from '../components/social-board.tsx';
import { useChannelScope } from '../components/social-channel-access.tsx';
import { SocialCalendar } from '../components/social-calendar.tsx';
import { CalendarFeedCard } from '../components/social-calendar-feed.tsx';
import { InstagramGrid } from '../components/social-instagram-grid.tsx';
import { PostLabels, useLabels, type SocialLabel } from '../components/social-labels.tsx';
import { isOverdue } from '../lib/social-assign.ts';
import { BulkBar } from '../components/social-bulk.tsx';
import { DraftsFromMediaPanel } from '../components/social-bulk-drafts.tsx';
import { DRAFTS_FROM_MEDIA_MAX, togglePick } from '../lib/social-bulk-drafts.ts';
import { PlanFromPosts, PlanReviewCard } from '../components/social-plan-review.tsx';
import { ReportLinks } from '../components/social-report-links.tsx';
import { GoalsCard } from '../components/social-goals.tsx';
import { TeamReport } from '../components/social-team-report.tsx';
import { ReportSchedules } from '../components/social-report-schedules.tsx';
import type { BulkAction } from '../lib/social-bulk.ts';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@crove/ui/components/tabs';
import { Empty, ErrorText, PageHeader, Spinner } from '../components/ui.tsx';
import { AccountGrowth, ChangeChip, ChannelTotals, TopPosts } from '../components/social-growth.tsx';
import { WhatWorks } from '../components/social-insights.tsx';
import { OutsidePostCell, OutsideSwitch } from '../components/social-external-posts.tsx';
import { mergePublished } from '../lib/social-external.ts';
import { StoryLine, StoryTotals } from '../components/social-story-metrics.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { client, errorMessage, orpc, queryClient, uploadFiles } from '../lib/api.ts';
import { dayKey, dayRange, providerName, SOCIAL_TABS, variantStatusKey, variantTone, type SocialSearch, type SocialTab } from '../lib/social.ts';
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
          <Badge key={v.id} variant={variantTone(v)} title={names.get(v.connectionId)}>
            {providerName(v.provider)} · {t(`status.${variantStatusKey(v)}`)}
          </Badge>
        ))}
    </div>
  );
}

function PostRow({ post, slug, names, labels, right }: { post: Post; slug: string; names: Map<string, string>; labels: readonly SocialLabel[]; right?: string }) {
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
        <PostLabels ids={post.labelIds} labels={labels} />
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {isOverdue(post, Date.now()) && <Badge variant="destructive">{t('assign.overdue')}</Badge>}
        {right && <span className="text-xs text-subtle-foreground tabular-nums">{right}</span>}
      </div>
    </Link>
  );
}

// How published posts did (S8): totals over the window, then each published channel with its latest capture; with a
// label chosen (#639), only the posts that carry it, on the screen and in the export. With the outside switch on
// (#1054), the posts the channels published outside Crove count in the totals and show in the table with their chip;
// they carry no label, so a label filter turns the switch off.
function Metrics({ slug, names, labelId }: { slug: string; names: Map<string, string>; labelId: string | undefined }) {
  const t = useTranslations('social');
  const f = useFormat();
  const [days, setDays] = useState(30);
  const [outside, setOutside] = useState(false);
  const counting = outside && !labelId;
  const label = labelId ? { labelId } : {};
  const rows = useQuery(orpc.social.metrics.summary.queryOptions({ input: { days, ...label } }));
  // The totals over every published channel of the window, summed by the server (#397); the list below stops at 500.
  const totals = useQuery(orpc.social.metrics.totals.queryOptions({ input: { days, ...label, ...(counting ? { includeExternal: true } : {}) } }));
  const outsideRows = useQuery({ ...orpc.social.metrics.external.queryOptions({ input: { days } }), enabled: counting });
  // The window as a CSV file, built and audited by the server, saved by the browser.
  const exportCsv = useMutation({
    mutationFn: () => client.social.metrics.export({ days, ...label }),
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
  const extra = counting ? (outsideRows.data ?? []) : [];
  const total = (name: string) => totals.data?.metrics[name] ?? [...data, ...extra].reduce((sum, r) => sum + (r.metrics[name] ?? 0), 0);
  // Clicks on Crove's short links (#706), where a channel sends its links through them.
  const clicks = totals.data ? totals.data.clicks : data.some((r) => r.clicks !== null) ? data.reduce((sum, r) => sum + (r.clicks ?? 0), 0) : null;
  const hasClicks = clicks !== null;
  // The same totals of the window just before (#947), for the change next to each.
  const previous = totals.data?.previous;
  const against = t('growth.change.days', { days: String(days) });
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
      <OutsideSwitch checked={outside} onChange={setOutside} disabled={Boolean(labelId)} />
      {exportCsv.error && <ErrorText>{errorMessage(exportCsv.error)}</ErrorText>}
      {/* Without the server's totals the cards sum the listed rows only. */}
      {totals.error && <ErrorText>{errorMessage(totals.error)}</ErrorText>}
      {counting && outsideRows.error && <ErrorText>{errorMessage(outsideRows.error)}</ErrorText>}
      {exportCsv.data?.truncated && <p className="text-xs text-warning">{t('metricsExportCut')}</p>}
      <AccountGrowth days={days} names={names} />
      {data.length === 0 && extra.length === 0 ? (
        <Empty title={t('empty.metrics')} hint={t('metricsHint')} />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {totals.data && (
              <Card className="block p-4">
                <p className="text-xs text-subtle-foreground">{t('growth.posts')}</p>
                <p className="mt-1 text-xl font-semibold text-foreground tabular-nums">{f.number(totals.data.posts)}</p>
                <ChangeChip current={totals.data.posts} previous={previous?.posts} against={against} withPrevious className="mt-1" />
              </Card>
            )}
            {METRIC_COLUMNS.map((m) => (
              <Card key={m} className="block p-4">
                <p className="text-xs text-subtle-foreground">{t(`metric.${m}`)}</p>
                <p className="mt-1 text-xl font-semibold text-foreground tabular-nums">{totals.isLoading ? '…' : f.number(total(m))}</p>
                {previous && <ChangeChip current={total(m)} previous={previous.metrics[m]} against={against} withPrevious className="mt-1" />}
              </Card>
            ))}
            {hasClicks && (
              <Card className="block p-4">
                <p className="text-xs text-subtle-foreground">{t('metricsClicks')}</p>
                <p className="mt-1 text-xl font-semibold text-foreground tabular-nums">{totals.isLoading ? '…' : f.number(clicks ?? 0)}</p>
                {previous && <ChangeChip current={clicks} previous={previous.clicks} against={against} withPrevious className="mt-1" />}
              </Card>
            )}
          </div>
          {totals.data && <StoryTotals metrics={totals.data.metrics} />}
          {totals.data && totals.data.channels.length > 0 && <ChannelTotals current={totals.data.channels} previous={previous?.channels ?? []} days={days} names={names} />}
          {data.length >= 500 && <p className="text-xs text-subtle-foreground">{t(totals.data ? 'metricsCapped' : 'metricsCappedPartial')}</p>}
          <BestTimes rows={data} names={names} />
      <WhatWorks slug={slug} days={days} labelId={labelId} names={names} />
          <TopPosts rows={data} names={names} slug={slug} />
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
                  {hasClicks && <th className="px-3 py-2 text-right font-medium">{t('metricsClicks')}</th>}
                </tr>
              </thead>
              <tbody>
                {mergePublished(data, extra).map((item) => {
                  const r = item.row;
                  const meta = [providerName(r.provider), names.get(r.connectionId), r.publishedAt ? f.dateTime(r.publishedAt) : null, r.capturedAt ? t('metricsAsOf', { when: f.dateTime(r.capturedAt) }) : t('metricsPending')]
                    .filter(Boolean)
                    .join(' · ');
                  return (
                    <tr key={item.kind === 'crove' ? item.row.variantId : `outside-${item.row.id}`} className="border-t">
                      <td className="max-w-md px-3 py-2">
                        {item.kind === 'crove' ? (
                          <>
                            <Link to="/o/$slug/social/$id" params={{ slug, id: item.row.postId }} className="line-clamp-1 text-foreground hover:underline">
                              {item.row.excerpt || t('emptyText')}
                            </Link>
                            <p className="text-xs text-subtle-foreground">{meta}</p>
                            <StoryLine metrics={r.metrics} />
                          </>
                        ) : (
                          <OutsidePostCell excerpt={item.row.excerpt} url={item.row.url} meta={meta} />
                        )}
                      </td>
                      {METRIC_COLUMNS.map((m) => (
                        <td key={m} className="px-3 py-2 text-right text-foreground tabular-nums">
                          {r.metrics[m] === undefined ? '-' : f.number(r.metrics[m])}
                        </td>
                      ))}
                      {hasClicks && <td className="px-3 py-2 text-right text-foreground tabular-nums">{item.kind === 'crove' && item.row.clicks !== null ? f.number(item.row.clicks) : '-'}</td>}
                    </tr>
                  );
                })}
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

// The media library (S9): the org's post images, searchable by name and filtered by tag (#904), each with the posts
// that show it and its tags.
function Library({ slug, canWrite }: { slug: string; canWrite: boolean }) {
  const t = useTranslations('social');
  const f = useFormat();
  const [search, setSearch] = useState('');
  const [tag, setTag] = useState<string | null>(null);
  const [chosen, setOpen] = useState<LibraryItem | null>(null);
  // Files picked for drafts (#1080), in the order picked; the panel keeps the files it was opened with.
  const [picked, setPicked] = useState<LibraryItem[]>([]);
  const [drafting, setDrafting] = useState<{ key: number; files: LibraryItem[] } | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const library = useLibrary(search, tag);
  const upload = useMutation({ mutationFn: (files: File[]) => uploadFiles(files, 'social'), onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['social-library'] }) });
  const items = library.data?.pages.flatMap((p) => p.items) ?? [];
  // The chosen file as the list has it now (its tags may have changed), or as it was when it left the list.
  const open = chosen ? (items.find((i) => i.fileId === chosen.fileId) ?? chosen) : null;
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
      <TagFilter value={tag} onChange={setTag} />
      <p className="text-xs text-subtle-foreground">{t('libraryHint')}</p>
      {canWrite && picked.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border bg-card px-3 py-2 text-sm" role="region" aria-label={t('bulkDrafts.picked', { count: picked.length })}>
          <span className="text-foreground tabular-nums">{t('bulkDrafts.picked', { count: picked.length })}</span>
          {picked.length >= DRAFTS_FROM_MEDIA_MAX && <span className="text-xs text-warning">{t('bulkDrafts.max', { max: DRAFTS_FROM_MEDIA_MAX })}</span>}
          <Button size="sm" className="ml-auto" onClick={() => setDrafting({ key: Date.now(), files: picked })}>
            {t('bulkDrafts.open')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setPicked([])}>
            {t('bulkDrafts.clear')}
          </Button>
        </div>
      )}
      {drafting && <DraftsFromMediaPanel key={drafting.key} slug={slug} files={drafting.files} onClose={() => setDrafting(null)} onCreated={() => setPicked([])} />}
      {upload.error && <ErrorText>{errorMessage(upload.error)}</ErrorText>}
      {library.isLoading ? (
        <Spinner />
      ) : library.error ? (
        <ErrorText>{errorMessage(library.error)}</ErrorText>
      ) : items.length === 0 ? (
        <Empty title={tag ? t('libraryNoTagMatch') : search.trim() ? t('libraryNoMatch') : t('libraryEmpty')} />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-5">
            {items.map((item) => {
              const order = picked.findIndex((p) => p.fileId === item.fileId);
              return (
              <li key={item.fileId} className="relative">
                {canWrite && (
                  <span className="absolute top-3 left-3 z-10 flex items-center gap-1 rounded-md bg-card/90 px-1 py-0.5">
                    <Checkbox
                      checked={order >= 0}
                      disabled={order < 0 && picked.length >= DRAFTS_FROM_MEDIA_MAX}
                      aria-label={order >= 0 ? t('bulkDrafts.unpick', { name: item.filename }) : t('bulkDrafts.pick', { name: item.filename })}
                      onCheckedChange={() => {
                        const ids = togglePick(picked.map((p) => p.fileId), item.fileId);
                        setPicked(ids.map((id) => picked.find((p) => p.fileId === id) ?? item));
                      }}
                    />
                    {order >= 0 && <span className="text-xs font-medium text-foreground tabular-nums">{order + 1}</span>}
                  </span>
                )}
                <button
                  type="button"
                  aria-pressed={open?.fileId === item.fileId}
                  onClick={() => setOpen(open?.fileId === item.fileId ? null : item)}
                  className={cn(
                    'block w-full space-y-1.5 rounded-xl border bg-card p-2 text-left transition-colors hover:border-ring/60 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
                    (open?.fileId === item.fileId || order >= 0) && 'border-primary/60',
                  )}
                >
                  <Thumb fileId={item.fileId} alt={item.filename} mime={item.mime} durationMs={item.durationMs} className="aspect-square" />
                  <span className="block truncate text-xs text-foreground" title={item.filename}>
                    {item.filename}
                  </span>
                  <span className="block text-xs text-subtle-foreground tabular-nums">
                    {sizeLabel(item.sizeBytes)} · {item.usedIn > 0 ? t('libraryUsedIn', { count: String(item.usedIn) }) : t('libraryUnused')}
                  </span>
                  {item.tags.length > 0 && (
                    <span className="block truncate text-xs text-muted-foreground" title={item.tags.join(', ')}>
                      {item.tags.join(' · ')}
                    </span>
                  )}
                </button>
              </li>
              );
            })}
          </ul>
          {open && (
            <Card className="block h-fit space-y-3 p-4">
              <Thumb fileId={open.fileId} alt={open.filename} mime={open.mime} durationMs={open.durationMs} className="aspect-[4/3]" />
              <p className="text-sm font-medium [overflow-wrap:anywhere] text-foreground">{open.filename}</p>
              <p className="text-xs text-subtle-foreground">{f.dateTime(open.createdAt)}</p>
              <MediaTagEditor key={`${open.fileId}:${open.tags.join('\n')}`} fileId={open.fileId} tags={open.tags} canWrite={canWrite} />
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

function Agenda({
  posts,
  slug,
  names,
  labels,
  picked,
  onPick,
}: {
  posts: Post[];
  slug: string;
  names: Map<string, string>;
  labels: readonly SocialLabel[];
  // The posts picked for a bulk move (#945), or null when the viewer may not move them; a line picks its whole post.
  picked: Set<string> | null;
  onPick: (next: Set<string>) => void;
}) {
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
  const shown = [...new Set(items.map((i) => i.post.id))];
  const toggle = (id: string) => {
    if (!picked) return;
    const next = new Set(picked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onPick(next);
  };
  return (
    <div className="space-y-6">
      {picked && (
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <Checkbox checked={shown.every((id) => picked.has(id))} onCheckedChange={(on) => onPick(on === true ? new Set(shown) : new Set())} />
          {t('bulk.selectAll')}
        </label>
      )}
      {[...days.entries()].map(([key, list]) => (
        <section key={key}>
          <h3 className="mb-2 text-sm font-medium text-muted-foreground">{f.date(key)}</h3>
          <div className="space-y-2">
            {list.map(({ post, v }) => (
              <div key={v.id} className="flex items-center gap-2">
                {picked && <Checkbox checked={picked.has(post.id)} onCheckedChange={() => toggle(post.id)} aria-label={t('bulk.select', { text: excerpt(post.body, 40) || t('emptyText') })} />}
                <Link
                  to="/o/$slug/social/$id"
                  params={{ slug, id: post.id }}
                  className="flex min-w-0 flex-1 items-start gap-4 rounded-xl border bg-card px-4 py-3 transition-colors hover:border-ring/60"
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
                      {v.status !== 'scheduled' && <Badge variant={variantTone(v)}>{t(`status.${variantStatusKey(v)}`)}</Badge>}
                    </div>
                    <PostLabels ids={post.labelIds} labels={labels} />
                  </div>
                </Link>
              </div>
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
  const filters = { ...(search.channel ? { connectionId: search.channel } : {}), ...(search.label ? { labelId: search.label } : {}), ...(search.q ? { search: search.q } : {}), ...(search.mine ? { assignee: 'me' as const } : {}) };
  // The agenda window starts now; a new day does not need a reload to move it, a refetch does.
  const range = useMemo(() => {
    const from = new Date(Date.now() - DAY);
    return { from: from.toISOString(), to: new Date(from.getTime() + (AGENDA_DAYS + 1) * DAY).toISOString() };
  }, []);
  const channels = useQuery(orpc.channels.list.queryOptions({ input: {} }));
  // The channel filter offers a member limited to some channels (#1081) those only.
  const scope = useChannelScope();
  const labels = useLabels();
  const labelList = labels.data ?? [];
  const me = useQuery(orpc.me.get.queryOptions());
  const role = me.data?.orgs.find((o) => o.slug === slug)?.role;
  const canWrite = role === 'owner' || role === 'admin' || role === 'member';
  const upcoming = useQuery({ ...orpc.social.posts.list.queryOptions({ input: { ...range, ...filters, limit: 200 } }), enabled: tab === 'upcoming', refetchInterval: pollEvery(live, 30_000, SAFETY_POLL_MS) });
  const listTab: ListTab | null = tab === 'review' || tab === 'attention' || tab === 'drafts' || tab === 'done' ? tab : null;
  // The server filters and pages (#574); a page at a time, newest change first.
  const list = useInfiniteQuery({
    ...orpc.social.posts.list.infiniteOptions({
      // The board (#1022) is the same list without a stage: every post, in a column per status.
      input: (before: PostCursor | undefined) => ({ ...(listTab ? { stage: listTab } : {}), ...filters, ...dayRange(search.from, search.to), limit: PAGE, ...(before ? { before } : {}) }),
      initialPageParam: undefined as PostCursor | undefined,
      getNextPageParam: (page: Post[]) => {
        const last = page.at(-1);
        return page.length === PAGE && last ? { updatedAt: last.updatedAt, postId: last.id } : undefined;
      },
    }),
    enabled: listTab !== null || tab === 'board',
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
  const filtered = Boolean(search.channel || search.label || search.q || search.from || search.to || search.mine);
  // The post filters (label, channel, search, mine) are the same in the lists, the board and the calendar (#1022): one
  // state, in the address. The metrics take the label only; the calendar's own month or week is its date range.
  const postFilters = tab === 'upcoming' || listTab !== null || tab === 'board' || tab === 'calendar';
  const labelFilter = (postFilters || tab === 'metrics') && (labelList.length > 0 || Boolean(search.label));
  // Posts picked for a bulk action (#635), in the list on screen; a new tab or filter starts afresh.
  const [picked, setPicked] = useState<Set<string>>(new Set());
  useEffect(() => setPicked(new Set()), [tab, search.channel, search.label, search.q, search.from, search.to, search.mine]);
  const canDecide = role === 'owner' || role === 'admin';
  // Moving by days or hours (#945) is for owners and admins, like a single reschedule; the agenda offers only that.
  const bulkActions: readonly BulkAction[] = !canWrite
    ? []
    : listTab === 'review'
      ? canDecide ? ['approve', 'move', 'cancel'] : ['cancel']
      : listTab === 'drafts'
        ? canDecide ? ['queue', 'move', 'cancel'] : ['cancel']
        : listTab === 'attention'
          ? canDecide ? ['move', 'cancel'] : ['cancel']
          : [];
  // Labels and the assignee on many posts at once (#1057), and find and replace (#1144), for members and above, in the
  // lists, the board and the calendar.
  const editActions: readonly BulkAction[] = canWrite ? ['labels', 'assign', 'replace'] : [];
  const listActions = bulkActions.length > 0 ? [...bulkActions, ...editActions] : [];
  const agendaActions: readonly BulkAction[] = [...(canDecide ? (['move'] as const) : []), ...editActions];
  const org = useQuery({ ...orpc.org.get.queryOptions(), enabled: canWrite });
  const members = (org.data?.members ?? []).map((m) => ({ userId: m.userId, name: m.displayName ?? m.email }));
  const toggle = (id: string) => setPicked((now) => { const next = new Set(now); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const excerptOf = (postId: string) => excerpt((rows.find((p) => p.id === postId) ?? upcoming.data?.find((p) => p.id === postId))?.body ?? '', 60) || t('emptyText');
  const channelName = (connectionId: string) => names.get(connectionId) ?? t('bulk.move.channelGone');

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
            <Link to="/o/$slug/social/ideas" params={{ slug }} className={buttonVariants({ variant: 'outline', size: 'lg' })}>
              {t('ideas.title')}
            </Link>
            <Link to="/o/$slug/social/bio" params={{ slug }} className={buttonVariants({ variant: 'outline', size: 'lg' })}>
              {t('bio.pageTitle')}
            </Link>
            <Link to="/o/$slug/social/feeds" params={{ slug }} className={buttonVariants({ variant: 'outline', size: 'lg' })}>
              {t('feeds.title')}
            </Link>
            <Link to="/o/$slug/social/snippets" params={{ slug }} className={buttonVariants({ variant: 'outline', size: 'lg' })}>
              {t('snippets.title')}
            </Link>
            <Link to="/o/$slug/social/labels" params={{ slug }} className={buttonVariants({ variant: 'outline', size: 'lg' })}>
              {t('labels.title')}
            </Link>
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
        {(postFilters || labelFilter) && (
          <div className="flex flex-wrap items-end gap-3">
            {labelFilter && (
              <label className="text-xs">
                <span className="text-subtle-foreground">{t('filters.label')}</span>
                <NativeSelect className="mt-1 w-48" value={search.label ?? ''} onChange={(e) => setSearch({ label: e.target.value || undefined })}>
                  <NativeSelectOption value="">{t('filters.allLabels')}</NativeSelectOption>
                  {labelList.map((l) => (
                    <NativeSelectOption key={l.id} value={l.id}>
                      {l.name}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </label>
            )}
            {postFilters && (
              <>
                <label className="text-xs">
                  <span className="text-subtle-foreground">{t('filters.channel')}</span>
                  <NativeSelect className="mt-1 w-56" value={search.channel ?? ''} onChange={(e) => setSearch({ channel: e.target.value || undefined })}>
                    <NativeSelectOption value="">{t('filters.allChannels')}</NativeSelectOption>
                    {(channels.data ?? []).filter((c) => scope.allows(c.id)).map((c) => (
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
                {(listTab === 'review' || listTab === 'done' || tab === 'board') && (
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
              </>
            )}
            {postFilters && (
              <label className="flex items-center gap-2 pb-2 text-xs text-muted-foreground">
                <Checkbox checked={search.mine === true} onCheckedChange={(on) => setSearch({ mine: on === true ? true : undefined })} />
                {t('assign.mine')}
              </label>
            )}
            {(postFilters ? filtered : Boolean(search.label)) && (
              <Button variant="ghost" onClick={() => setSearch({ channel: undefined, label: undefined, q: undefined, from: undefined, to: undefined, mine: undefined })}>
                {t('filters.clear')}
              </Button>
            )}
          </div>
        )}
        <TabsContent value="upcoming">
          {agendaActions.length > 0 && (
            <div className="mb-2">
              <BulkBar
                posts={(upcoming.data ?? []).filter((p) => picked.has(p.id))}
                actions={agendaActions}
                canDecide={canDecide}
                excerptOf={excerptOf}
                channelName={channelName}
                labelOptions={labelList}
                members={members}
                findHint={search.q}
                onClear={() => setPicked(new Set())}
              />
            </div>
          )}
          {upcoming.isLoading ? (
            <Spinner />
          ) : upcoming.error ? (
            <ErrorText>{errorMessage(upcoming.error)}</ErrorText>
          ) : (
            <Agenda posts={upcoming.data ?? []} slug={slug} names={names} labels={labelList} picked={agendaActions.length > 0 ? picked : null} onPick={setPicked} />
          )}
        </TabsContent>
        <TabsContent value="calendar">
          {tab === 'calendar' && (
            <div className="space-y-4">
              <SocialCalendar
                slug={slug}
                names={names}
                canDecide={role === 'owner' || role === 'admin'}
                canWrite={canWrite}
                filters={filters}
                bulk={
                  editActions.length > 0
                    ? (selected, clear) => (
                        <BulkBar
                          posts={selected}
                          actions={editActions}
                          canDecide={canDecide}
                          excerptOf={(postId) => excerpt(selected.find((p) => p.id === postId)?.body ?? '', 60) || t('emptyText')}
                          channelName={channelName}
                          labelOptions={labelList}
                          members={members}
                          findHint={search.q}
                          onClear={clear}
                        />
                      )
                    : undefined
                }
              />
              <InstagramGrid slug={slug} channels={(channels.data ?? []).filter((c) => c.provider === 'instagram' && c.status !== 'revoked')} canDecide={role === 'owner' || role === 'admin'} />
              <PlanReviewCard channels={channels.data ?? []} canManage={canDecide} />
              <CalendarFeedCard canManage={role === 'owner' || role === 'admin'} />
            </div>
          )}
        </TabsContent>
        <TabsContent value="board">
          {tab === 'board' && (
            <>
              {list.isLoading ? (
                <Spinner />
              ) : list.error && rows.length === 0 ? (
                <ErrorText>{errorMessage(list.error)}</ErrorText>
              ) : (
                <>
                  {editActions.length > 0 && (
                    <div className="mb-2">
                      <BulkBar
                        posts={rows.filter((p) => picked.has(p.id))}
                        actions={editActions}
                        canDecide={canDecide}
                        excerptOf={excerptOf}
                        channelName={channelName}
                        labelOptions={labelList}
                        members={members}
                        findHint={search.q}
                        onClear={() => setPicked(new Set())}
                      />
                    </div>
                  )}
                  <SocialBoard
                    posts={rows}
                    slug={slug}
                    names={names}
                    labels={labelList}
                    canWrite={canWrite}
                    canDecide={canDecide}
                    picked={editActions.length > 0 ? picked : null}
                    onPick={setPicked}
                  />
                </>
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
        <TabsContent value="metrics">
          <div className="space-y-4">
            <GoalsCard channels={channels.data ?? []} />
            <Metrics slug={slug} names={names} labelId={search.label} />
            <TeamReport key={slug} />
            <ReportLinks channels={channels.data ?? []} />
            <ReportSchedules channels={channels.data ?? []} />
          </div>
        </TabsContent>
        <TabsContent value="library">{tab === 'library' && <Library slug={slug} canWrite={canWrite} />}</TabsContent>
        {(['review', 'attention', 'drafts', 'done'] as const).map((id) => (
          <TabsContent key={id} value={id}>
            {tab === id && (
              <>
                {listActions.length > 0 && (
                  <div className="mb-2">
                    <BulkBar
                      posts={rows.filter((p) => picked.has(p.id))}
                      actions={listActions}
                      canDecide={canDecide}
                      excerptOf={excerptOf}
                      channelName={channelName}
                      labelOptions={labelList}
                      members={members}
                      findHint={search.q}
                      onClear={() => setPicked(new Set())}
                    />
                    {/* One client review link for the posts selected (#902). */}
                    {canDecide && (id === 'review' || id === 'drafts') && <PlanFromPosts postIds={rows.filter((p) => picked.has(p.id)).map((p) => p.id)} />}
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
                    {listActions.length > 0 && (
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
                        {listActions.length > 0 && <Checkbox checked={picked.has(post.id)} onCheckedChange={() => toggle(post.id)} aria-label={t('bulk.select', { text: excerpt(post.body, 40) || t('emptyText') })} />}
                        <div className="min-w-0 flex-1">
                          <PostRow post={post} slug={slug} names={names} labels={labelList} right={f.dateTime(post.updatedAt)} />
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
