// The client review page (#589): /-/review#<token>, opened from a link the agency sent (often over Zalo), with no
// account. It shows the post as each channel will show it and takes the client's answer with the name they type. A
// plan link (#902) shows each of its posts in schedule order and takes an answer on each.
// The token stays after the # (browsers never send it to a server in the address) and goes to the API in a POST
// body only. With the org's white-label branding (#1053) it shows the agency's logo, name and accent instead of Crove's.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Input } from '@crove/ui/components/input';
import { Label } from '@crove/ui/components/label';
import { Textarea } from '@crove/ui/components/textarea';
import { FileSource } from '../components/social-media.tsx';
import { PlatformPreview } from '../components/social-preview.tsx';
import { AccentRule, BrandMark, MadeWithCrove, accentStyle, useBrandTitle } from '../components/social-report-branding.tsx';
import { ErrorText, Logo, Spinner } from '../components/ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { errorMessage } from '../lib/api.ts';
import { apiErrorFromResponse } from '../lib/errors.ts';
import { planProgress } from '../lib/social-plan-review.ts';
import { pageBrand, type ReportBrand } from '../lib/social-report-branding.ts';

type Verdict = 'approved' | 'changes_requested' | 'comment';
type Answer = { name: string; verdict: Verdict; body: string | null; at: string };
type Channel = { provider: string; channel: string; status: string; body: string; title: string | null; linkUrl: string | null };
interface ReviewPage {
  kind?: undefined;
  org: string;
  // The org's white-label branding (#1053), or null; absent from a server without it. Read again by pageBrand.
  brand?: unknown;
  expiresAt: string;
  changed: boolean;
  channels: (Channel & { mediaCount: number })[];
  feedback: Answer[];
}
// A content plan (#902): its posts in schedule order, each answered on its own; a post cancelled since is only gone.
type PlanPost = { id: string; gone: true } | { id: string; gone: false; at: string | null; changed: boolean; channels: (Channel & { media: { id: string; type: string }[] })[]; answers: number; feedback: Answer[] };
interface PlanPage {
  kind: 'plan';
  org: string;
  brand?: unknown;
  expiresAt: string;
  from: string | null;
  to: string | null;
  posts: PlanPost[];
}
type FileFetcher = { key: string; fetch: (fileId: string) => Promise<Blob> };

const NAME_KEY = 'crove.review.name';
const tokenOf = () => {
  const t = window.location.hash.replace(/^#/, '');
  return /^[A-Za-z0-9_-]{43}$/.test(t) ? t : null;
};
const readName = () => {
  try {
    return window.localStorage.getItem(NAME_KEY) ?? '';
  } catch {
    return '';
  }
};

async function post<T>(path: string, body: unknown): Promise<T | null> {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), credentials: 'omit', referrerPolicy: 'no-referrer' });
  if (res.status === 404) return null;
  // A refusal keeps the kernel's code, so the page says it in the reader's language.
  if (!res.ok) throw await apiErrorFromResponse(res);
  return (await res.json()) as T;
}

// A file a channel of the link's post shows (#624): a download URL the page then fetches, or the bytes themselves.
async function reviewFile(token: string, fileId: string): Promise<Blob> {
  const res = await fetch('/api/review/file', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, fileId }), credentials: 'omit', referrerPolicy: 'no-referrer' });
  if (!res.ok) throw await apiErrorFromResponse(res);
  if (res.headers.get('content-type')?.includes('application/json')) {
    const { url } = (await res.json()) as { url: string };
    const file = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (!file.ok) throw new Error(`file ${file.status}`);
    return file.blob();
  }
  return res.blob();
}

const saveName = (name: string) => {
  try {
    window.localStorage.setItem(NAME_KEY, name);
  } catch {
    // A private window keeps no name; nothing else depends on it.
  }
};

// One post of a plan: its previews, its answers through the link, and the client's answer on it alone.
function PlanPostCard({ token, item, index, name, files, onAnswered }: { token: string; item: PlanPost; index: number; name: string; files: FileFetcher; onAnswered: () => void }) {
  const t = useTranslations('social.clientReview');
  const f = useFormat();
  const [body, setBody] = useState('');
  const [sent, setSent] = useState<Verdict | null>(null);
  const answer = useMutation({
    mutationFn: async (verdict: Verdict) => {
      const done = await post<{ recorded: true }>('/api/review/answer', { token, postId: item.id, name: name.trim(), verdict, ...(body.trim() ? { body: body.trim() } : {}) });
      if (!done) throw new Error(t('invalid'));
      return verdict;
    },
    onSuccess: (verdict) => {
      saveName(name.trim());
      setSent(verdict);
      setBody('');
      onAnswered();
    },
  });
  if (item.gone) {
    return (
      <Card className="block p-4 text-sm text-muted-foreground">
        <p>
          <span className="font-medium text-foreground">{t('planPost', { n: index + 1 })}</span> · {t('gone')}
        </p>
      </Card>
    );
  }
  const decided = item.feedback.find((fb) => fb.verdict !== 'comment');
  const bodyId = `plan-body-${item.id}`;
  return (
    <Card className="block space-y-3 p-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium text-foreground">{t('planPost', { n: index + 1 })}</span>
        <span className="text-muted-foreground">{item.at ? f.dateTime(item.at) : t('noTime')}</span>
        {decided && <span className={decided.verdict === 'approved' ? 'text-success' : 'text-warning'}>· {t(`verdict.${decided.verdict}`)}</span>}
      </div>
      {item.changed && <p className="rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-sm">{t('planChanged')}</p>}
      <div className="grid gap-4 md:grid-cols-2">
        {item.channels.map((c, i) => (
          <FileSource.Provider key={i} value={files}>
            <PlatformPreview
              channel={c.channel}
              provider={c.provider}
              content={{ body: c.body, title: c.title ?? '', linkUrl: c.linkUrl ?? '', media: c.media.map((m) => ({ fileId: m.id, altText: '', mime: m.type, sizeBytes: 0 })) }}
            />
          </FileSource.Provider>
        ))}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={bodyId}>{t('comment')}</Label>
        <Textarea id={bodyId} value={body} maxLength={2000} rows={2} placeholder={t('commentPlaceholder')} onChange={(e) => setBody(e.target.value)} />
      </div>
      {sent && <p className="text-sm text-success">{t(`thanks.${sent}`)}</p>}
      {answer.error && <ErrorText>{errorMessage(answer.error)}</ErrorText>}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={answer.isPending || !name.trim()} onClick={() => answer.mutate('approved')}>
          {t('approve')}
        </Button>
        <Button size="sm" variant="outline" disabled={answer.isPending || !name.trim()} onClick={() => answer.mutate('changes_requested')}>
          {t('requestChanges')}
        </Button>
        <Button size="sm" variant="ghost" disabled={answer.isPending || !name.trim() || !body.trim()} onClick={() => answer.mutate('comment')}>
          {t('sendComment')}
        </Button>
      </div>
      {item.feedback.length > 0 && (
        <ul className="space-y-1 border-t pt-2 text-xs text-muted-foreground">
          {item.feedback.map((fb, i) => (
            <li key={i}>
              <span className="font-medium text-foreground">{fb.name}</span> · {t(`verdict.${fb.verdict}`)} · {f.dateTime(fb.at)}
              {fb.body && <span className="block whitespace-pre-wrap break-words text-foreground">{fb.body}</span>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// The plan page (#902): the client's name once, then every post with its own answer.
function PlanReview({ token, data, brand, files, onAnswered }: { token: string; data: PlanPage; brand: ReportBrand | null; files: FileFetcher; onAnswered: () => void }) {
  const t = useTranslations('social.clientReview');
  const f = useFormat();
  const [name, setName] = useState(readName);
  const progress = planProgress(data.posts);
  return (
    <>
      <div className="space-y-1">
        <h1 className="text-lg font-semibold">{t('planTitle', { org: brand?.name ?? data.org })}</h1>
        <p className="text-sm text-muted-foreground">
          {data.from && data.to ? `${t('planPeriod', { from: f.date(data.from), to: f.date(new Date(Date.parse(data.to) - 1).toISOString()) })} · ` : ''}
          {t('subtitle', { until: f.dateTime(data.expiresAt) })}
        </p>
        <p className="text-sm text-foreground">{t('planProgress', { answered: progress.answered, total: progress.total })}</p>
      </div>
      <Card className="block space-y-1.5 p-4">
        <Label htmlFor="review-name">{t('name')}</Label>
        <Input id="review-name" value={name} maxLength={100} autoComplete="name" onChange={(e) => setName(e.target.value)} />
        <p className="text-xs text-subtle-foreground">{t('planNote')}</p>
      </Card>
      {data.posts.map((item, i) => (
        <PlanPostCard key={`${token}:${item.id}`} token={token} item={item} index={i} name={name} files={files} onAnswered={onAnswered} />
      ))}
    </>
  );
}

export function SocialReviewPage() {
  const t = useTranslations('social.clientReview');
  const f = useFormat();
  const [token] = useState(tokenOf);
  const page = useQuery({ queryKey: ['client-review', token], queryFn: () => post<ReviewPage | PlanPage>('/api/review/view', { token }), enabled: token !== null, retry: false });
  // A plan's page carries its files' ids itself.
  const media = useQuery({
    queryKey: ['client-review-media', token],
    queryFn: () => post<{ channels: { id: string; type: string }[][] }>('/api/review/media', { token }),
    enabled: token !== null && page.isSuccess && page.data?.kind !== 'plan',
    retry: false,
  });
  const [files] = useState(() => ({ key: `client-review-file:${token ?? ''}`, fetch: (fileId: string) => reviewFile(token ?? '', fileId) }));
  const [name, setName] = useState(readName);
  const [body, setBody] = useState('');
  const [sent, setSent] = useState<Verdict | null>(null);
  const answer = useMutation({
    mutationFn: async (verdict: Verdict) => {
      const done = await post<{ recorded: true }>('/api/review/answer', { token, name: name.trim(), verdict, ...(body.trim() ? { body: body.trim() } : {}) });
      if (!done) throw new Error(t('invalid'));
      return verdict;
    },
    onSuccess: (verdict) => {
      saveName(name.trim());
      setSent(verdict);
      setBody('');
      void page.refetch();
    },
  });

  const data = page.data;
  const brand = data ? pageBrand(data.brand) : null;
  useBrandTitle(brand, data?.org ?? '');
  // Neither mark until the page is known, so a branded link never shows Crove's logo while it loads.
  const loading = token !== null && page.isLoading;
  return (
    <div className="min-h-screen bg-background px-4 py-6 text-foreground" style={accentStyle(brand)}>
      <div className="mx-auto max-w-3xl space-y-4">
        <div className="flex min-h-7 items-center gap-2">{loading ? <span aria-hidden="true" /> : brand && data ? <BrandMark brand={brand} org={data.org} /> : <Logo />}</div>
        <AccentRule brand={brand} />
        {token === null || (page.isFetched && data === null) ? (
          <Card className="block p-6 text-sm text-muted-foreground">{t('invalid')}</Card>
        ) : page.isLoading ? (
          <Spinner />
        ) : page.error ? (
          <ErrorText>{errorMessage(page.error)}</ErrorText>
        ) : data?.kind === 'plan' ? (
          token && <PlanReview token={token} data={data} brand={brand} files={files} onAnswered={() => void page.refetch()} />
        ) : data ? (
          <>
            <div>
              <h1 className="text-lg font-semibold">{t('title', { org: brand?.name ?? data.org })}</h1>
              <p className="text-sm text-muted-foreground">{t('subtitle', { until: f.dateTime(data.expiresAt) })}</p>
            </div>
            {data.changed && <p className="rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-sm">{t('changed')}</p>}
            <div className="grid gap-4 md:grid-cols-2">
              {data.channels.map((c, i) => (
                <div key={i} className="space-y-1">
                  <FileSource.Provider value={files}>
                    <PlatformPreview
                      channel={c.channel}
                      provider={c.provider}
                      content={{ body: c.body, title: c.title ?? '', linkUrl: c.linkUrl ?? '', media: (media.data?.channels[i] ?? []).map((m) => ({ fileId: m.id, altText: '', mime: m.type, sizeBytes: 0 })) }}
                    />
                  </FileSource.Provider>
                  {c.mediaCount > 0 && !media.data && <p className="text-xs text-subtle-foreground">{t('media', { count: c.mediaCount })}</p>}
                </div>
              ))}
            </div>
            <Card className="block space-y-3 p-4">
              <h2 className="text-sm font-medium">{t('yourAnswer')}</h2>
              {sent && <p className="text-sm text-success">{t(`thanks.${sent}`)}</p>}
              <div className="space-y-1.5">
                <Label htmlFor="review-name">{t('name')}</Label>
                <Input id="review-name" value={name} maxLength={100} autoComplete="name" onChange={(e) => setName(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="review-body">{t('comment')}</Label>
                <Textarea id="review-body" value={body} maxLength={2000} rows={3} placeholder={t('commentPlaceholder')} onChange={(e) => setBody(e.target.value)} />
              </div>
              {answer.error && <ErrorText>{errorMessage(answer.error)}</ErrorText>}
              <div className="flex flex-wrap gap-2">
                <Button disabled={answer.isPending || !name.trim()} onClick={() => answer.mutate('approved')}>
                  {t('approve')}
                </Button>
                <Button variant="outline" disabled={answer.isPending || !name.trim()} onClick={() => answer.mutate('changes_requested')}>
                  {t('requestChanges')}
                </Button>
                <Button variant="ghost" disabled={answer.isPending || !name.trim() || !body.trim()} onClick={() => answer.mutate('comment')}>
                  {t('sendComment')}
                </Button>
              </div>
              <p className="text-xs text-subtle-foreground">{t('note')}</p>
            </Card>
            {data.feedback.length > 0 && (
              <div className="space-y-2">
                <h2 className="text-sm font-medium">{t('earlier')}</h2>
                {data.feedback.map((fb, i) => (
                  <Card key={i} className="block space-y-1 p-3 text-sm">
                    <p className="text-xs text-muted-foreground">
                      <span className="font-medium text-foreground">{fb.name}</span> · {t(`verdict.${fb.verdict}`)} · {f.dateTime(fb.at)}
                    </p>
                    {fb.body && <p className="whitespace-pre-wrap break-words">{fb.body}</p>}
                  </Card>
                ))}
              </div>
            )}
          </>
        ) : null}
        <MadeWithCrove brand={brand} />
      </div>
    </div>
  );
}
