// The org's link-in-bio page (#707): one page at PUBLIC_URL/b/<slug> for an Instagram or TikTok bio, with a title, an
// about, an avatar from the media library, up to 12 buttons and the recent image posts. Owners and admins edit it with
// a preview beside the form; everyone sees its address and the clicks of the last 30 days.
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Checkbox } from '@crove/ui/components/checkbox';
import { Input } from '@crove/ui/components/input';
import { Label } from '@crove/ui/components/label';
import { Textarea } from '@crove/ui/components/textarea';
import { MediaField, Thumb, type MediaItem } from '../components/social-media.tsx';
import { ErrorText, PageHeader, Spinner } from '../components/ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';
import { bioUrl, slugFrom } from '../lib/social-bio.ts';

type Page = NonNullable<Awaited<ReturnType<typeof client.social.bio.get>>>;
type Draft = { slug: string; title: string; about: string; avatar: MediaItem[]; buttons: { label: string; url: string }[]; showPosts: boolean; published: boolean };

const draftOf = (p: Page | null, orgName: string): Draft =>
  p
    ? { slug: p.slug, title: p.title, about: p.about ?? '', avatar: p.avatarFileId ? [{ fileId: p.avatarFileId, altText: '', mime: 'image/jpeg', sizeBytes: 0 }] : [], buttons: p.buttons, showPosts: p.showPosts, published: p.published }
    : { slug: slugFrom(orgName), title: orgName, about: '', avatar: [], buttons: [{ label: '', url: '' }], showPosts: true, published: false };

function Preview({ d }: { d: Draft }) {
  const t = useTranslations('social.bio');
  return (
    <div className="mx-auto w-full max-w-xs space-y-2 rounded-xl border bg-background p-4 text-center" aria-label={t('preview')}>
      {d.avatar[0] && <Thumb fileId={d.avatar[0].fileId} alt="" className="mx-auto size-16 rounded-full" />}
      <p className="text-base font-semibold text-foreground">{d.title || t('titlePlaceholder')}</p>
      {d.about && <p className="text-xs whitespace-pre-line text-muted-foreground">{d.about}</p>}
      {d.buttons
        .filter((b) => b.label.trim())
        .map((b, i) => (
          <span key={i} className="block rounded-xl border px-3 py-2 text-sm font-medium text-foreground">
            {b.label}
          </span>
        ))}
      {d.showPosts && <p className="text-xs text-subtle-foreground">{t('postsPreview')}</p>}
    </div>
  );
}

function Editor({ page, orgName, canManage }: { page: Page | null; orgName: string; canManage: boolean }) {
  const t = useTranslations('social.bio');
  const [d, setD] = useState<Draft>(() => draftOf(page, orgName));
  const save = useMutation({
    mutationFn: () =>
      client.social.bio.save({
        slug: d.slug.trim().toLowerCase(),
        title: d.title.trim(),
        about: d.about.trim() || null,
        avatarFileId: d.avatar[0]?.fileId ?? null,
        buttons: d.buttons.filter((b) => b.label.trim() || b.url.trim()).map((b) => ({ label: b.label.trim(), url: b.url.trim() })),
        showPosts: d.showPosts,
        published: d.published,
      }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: orpc.social.bio.key() }),
  });
  const setButton = (i: number, next: Partial<Draft['buttons'][number]>) => setD({ ...d, buttons: d.buttons.map((b, j) => (j === i ? { ...b, ...next } : b)) });
  const off = !canManage || save.isPending;
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
      <Card className="block space-y-3 p-4">
        <div className="space-y-1.5">
          <Label htmlFor="bio-slug">{t('slug')}</Label>
          <div className="flex items-center gap-1 text-sm text-subtle-foreground">
            <span className="shrink-0">{bioUrl('')}</span>
            <Input id="bio-slug" value={d.slug} maxLength={40} disabled={off} onChange={(e) => setD({ ...d, slug: e.target.value.toLowerCase() })} />
          </div>
          <p className="text-xs text-subtle-foreground">{t('slugHint')}</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="bio-title">{t('title')}</Label>
          <Input id="bio-title" value={d.title} maxLength={100} disabled={off} placeholder={t('titlePlaceholder')} onChange={(e) => setD({ ...d, title: e.target.value })} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="bio-about">{t('about')}</Label>
          <Textarea id="bio-about" value={d.about} maxLength={300} rows={2} disabled={off} onChange={(e) => setD({ ...d, about: e.target.value })} />
        </div>
        <div className="space-y-1.5">
          <p className="text-sm font-medium text-foreground">{t('avatar')}</p>
          <MediaField media={d.avatar} disabled={off} onChange={(media) => setD({ ...d, avatar: media.filter((m) => m.mime.startsWith('image/')).slice(-1) })} />
        </div>
        <div className="space-y-2">
          <p className="text-sm font-medium text-foreground">{t('buttons')}</p>
          {d.buttons.map((b, i) => (
            <div key={i} className="flex flex-wrap gap-1.5">
              <Input aria-label={t('buttonLabel', { n: String(i + 1) })} placeholder={t('buttonLabel', { n: String(i + 1) })} value={b.label} maxLength={60} disabled={off} className="w-40" onChange={(e) => setButton(i, { label: e.target.value })} />
              <Input aria-label={t('buttonUrl', { n: String(i + 1) })} placeholder="https://" type="url" value={b.url} maxLength={2000} disabled={off} className="min-w-48 flex-1" onChange={(e) => setButton(i, { url: e.target.value })} />
              <Button type="button" size="sm" variant="ghost" disabled={off} onClick={() => setD({ ...d, buttons: d.buttons.filter((_, j) => j !== i) })}>
                {t('remove')}
              </Button>
            </div>
          ))}
          {d.buttons.length < 12 && (
            <Button type="button" size="sm" variant="outline" disabled={off} onClick={() => setD({ ...d, buttons: [...d.buttons, { label: '', url: '' }] })}>
              {t('addButton')}
            </Button>
          )}
        </div>
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <Checkbox checked={d.showPosts} disabled={off} onCheckedChange={(checked) => setD({ ...d, showPosts: checked === true })} />
          {t('showPosts')}
        </label>
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <Checkbox checked={d.published} disabled={off} onCheckedChange={(checked) => setD({ ...d, published: checked === true })} />
          {t('published')}
        </label>
        {save.error && <ErrorText>{errorMessage(save.error)}</ErrorText>}
        {canManage ? (
          <Button disabled={off || !d.title.trim() || d.slug.length < 3} onClick={() => save.mutate()}>
            {save.isPending ? <Spinner className="text-current" /> : null}
            {t('save')}
          </Button>
        ) : (
          <p className="text-xs text-subtle-foreground">{t('adminsOnly')}</p>
        )}
      </Card>
      <Preview d={d} />
    </div>
  );
}

function Clicks({ page }: { page: Page }) {
  const t = useTranslations('social.bio');
  const f = useFormat();
  const buttons = page.buttons.map((b, i) => ({ label: b.label, clicks: page.clicks[`button:${i}`] ?? 0 }));
  const posts = Object.entries(page.clicks)
    .filter(([k]) => k.startsWith('post:'))
    .reduce((sum, [, n]) => sum + n, 0);
  return (
    <Card className="block space-y-2 p-4">
      <p className="text-sm font-medium text-foreground">{t('clicksTitle')}</p>
      <ul className="space-y-1 text-sm">
        {buttons.map((b, i) => (
          <li key={i} className="flex justify-between gap-2">
            <span className="truncate text-foreground">{b.label}</span>
            <span className="text-subtle-foreground tabular-nums">{f.number(b.clicks)}</span>
          </li>
        ))}
        <li className="flex justify-between gap-2">
          <span className="text-foreground">{t('postClicks')}</span>
          <span className="text-subtle-foreground tabular-nums">{f.number(posts)}</span>
        </li>
      </ul>
    </Card>
  );
}

export function SocialBioPage() {
  const { slug } = useParams({ strict: false }) as { slug: string };
  const t = useTranslations('social.bio');
  const me = useQuery(orpc.me.get.queryOptions());
  const org = me.data?.orgs.find((o) => o.slug === slug);
  const canManage = org?.role === 'owner' || org?.role === 'admin';
  const page = useQuery(orpc.social.bio.get.queryOptions({ input: {} }));
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
      {page.isLoading || me.isLoading ? (
        <Spinner />
      ) : page.error ? (
        <ErrorText>{errorMessage(page.error)}</ErrorText>
      ) : (
        <>
          {page.data && (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Badge variant={page.data.published ? 'secondary' : 'warning'}>{t(page.data.published ? 'live' : 'draft')}</Badge>
              {page.data.published && (
                <a href={bioUrl(page.data.slug)} target="_blank" rel="noreferrer noopener" className="text-link hover:underline">
                  {bioUrl(page.data.slug)}
                </a>
              )}
            </div>
          )}
          <Editor key={`${slug}-${page.data?.updatedAt ?? 'new'}`} page={page.data ?? null} orgName={org?.name ?? ''} canManage={canManage} />
          {page.data && <Clicks page={page.data} />}
        </>
      )}
    </div>
  );
}
