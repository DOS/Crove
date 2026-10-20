// The client review page (#589): /-/review#<token>, opened from a link the agency sent (often over Zalo), with no
// account. It shows the post as each channel will show it and takes the client's answer with the name they type.
// The token stays after the # (browsers never send it to a server in the address) and goes to the API in a POST
// body only.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Input } from '@crove/ui/components/input';
import { Label } from '@crove/ui/components/label';
import { Textarea } from '@crove/ui/components/textarea';
import { PlatformPreview } from '../components/social-preview.tsx';
import { ErrorText, Logo, Spinner } from '../components/ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { errorMessage } from '../lib/api.ts';
import { apiErrorFromResponse } from '../lib/errors.ts';

interface ReviewPage {
  org: string;
  expiresAt: string;
  changed: boolean;
  channels: { provider: string; channel: string; status: string; body: string; title: string | null; linkUrl: string | null; mediaCount: number }[];
  feedback: { name: string; verdict: 'approved' | 'changes_requested' | 'comment'; body: string | null; at: string }[];
}
type Verdict = ReviewPage['feedback'][number]['verdict'];

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

export function SocialReviewPage() {
  const t = useTranslations('social.clientReview');
  const f = useFormat();
  const [token] = useState(tokenOf);
  const page = useQuery({ queryKey: ['client-review', token], queryFn: () => post<ReviewPage>('/api/review/view', { token }), enabled: token !== null, retry: false });
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
      try {
        window.localStorage.setItem(NAME_KEY, name.trim());
      } catch {
        // A private window keeps no name; nothing else depends on it.
      }
      setSent(verdict);
      setBody('');
      void page.refetch();
    },
  });

  const data = page.data;
  return (
    <div className="min-h-screen bg-background px-4 py-6 text-foreground">
      <div className="mx-auto max-w-3xl space-y-4">
        <div className="flex items-center gap-2">
          <Logo />
        </div>
        {token === null || (page.isFetched && data === null) ? (
          <Card className="block p-6 text-sm text-muted-foreground">{t('invalid')}</Card>
        ) : page.isLoading ? (
          <Spinner />
        ) : page.error ? (
          <ErrorText>{errorMessage(page.error)}</ErrorText>
        ) : data ? (
          <>
            <div>
              <h1 className="text-lg font-semibold">{t('title', { org: data.org })}</h1>
              <p className="text-sm text-muted-foreground">{t('subtitle', { until: f.dateTime(data.expiresAt) })}</p>
            </div>
            {data.changed && <p className="rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-sm">{t('changed')}</p>}
            <div className="grid gap-4 md:grid-cols-2">
              {data.channels.map((c, i) => (
                <div key={i} className="space-y-1">
                  <PlatformPreview channel={c.channel} provider={c.provider} content={{ body: c.body, title: c.title ?? '', linkUrl: c.linkUrl ?? '', media: [] }} />
                  {c.mediaCount > 0 && <p className="text-xs text-subtle-foreground">{t('media', { count: c.mediaCount })}</p>}
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
      </div>
    </div>
  );
}
