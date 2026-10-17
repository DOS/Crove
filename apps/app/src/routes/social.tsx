// Crove Social home: what goes out next (an agenda by day), what waits for review, drafts, and what went out.
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { useTranslations } from 'use-intl';
import { Badge } from '@crove/ui/components/badge';
import { Button, buttonVariants } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@crove/ui/components/tabs';
import { Empty, ErrorText, PageHeader, Spinner } from '../components/ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { errorMessage, orpc } from '../lib/api.ts';
import { dayKey, providerName, VARIANT_TONE } from '../lib/social.ts';
import { pollEvery, SAFETY_POLL_MS, useStreamLive } from '../lib/stream-hook.ts';

type Tab = 'upcoming' | 'review' | 'drafts' | 'done' | 'metrics';
const TABS: Tab[] = ['upcoming', 'review', 'drafts', 'done', 'metrics'];
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
  if (rows.isLoading) return <Spinner />;
  if (rows.error) return <ErrorText>{errorMessage(rows.error)}</ErrorText>;
  const data = rows.data ?? [];
  const total = (name: string) => data.reduce((sum, r) => sum + (r.metrics[name] ?? 0), 0);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {[7, 30, 90].map((d) => (
          <Button key={d} variant={d === days ? 'secondary' : 'ghost'} size="sm" onClick={() => setDays(d)}>
            {t('metricsDays', { days: String(d) })}
          </Button>
        ))}
      </div>
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
                        {providerName(r.provider)} · {names.get(r.connectionId) ?? ''} · {r.publishedAt ? f.dateTime(r.publishedAt) : ''}
                        {r.capturedAt ? ` · ${t('metricsAsOf', { when: f.dateTime(r.capturedAt) })}` : ` · ${t('metricsPending')}`}
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
          <h3 className="mb-2 text-xs font-medium tracking-wide text-subtle-foreground uppercase">{f.date(key)}</h3>
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

  const lists: Record<Exclude<Tab, 'upcoming' | 'metrics'>, Post[]> = {
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
