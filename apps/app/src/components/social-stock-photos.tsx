// Free photos from Pexels in the media library and the composer (#1106), when the server has a Pexels key: search,
// a grid with each photographer's credit, and "save to the library". Everything goes through the API (the key and the
// requests to Pexels stay on the server); thumbnails arrive as data: URLs. Pexels asks for a visible link back and a
// credit to the photographer, both shown here and on saved items. Names and descriptions come from Pexels, so they are
// shown as text only, and a link is drawn only to a page on pexels.com.
import { useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { useLocale, useTranslations } from 'use-intl';
import { Button } from '@crove/ui/components/button';
import { Input } from '@crove/ui/components/input';
import { client, errorMessage, queryClient } from '../lib/api.ts';
import { ErrorText, Spinner } from './ui.tsx';

export const PEXELS_URL = 'https://www.pexels.com';

export type StockPhoto = Awaited<ReturnType<typeof client.social.stockPhotos.search>>['photos'][number];
export type StockSaved = Awaited<ReturnType<typeof client.social.stockPhotos.save>>;

// A page on pexels.com over https, or null: the only links the credits draw.
export function pexelsHref(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && (url.hostname === 'pexels.com' || url.hostname.endsWith('.pexels.com')) ? url.toString() : null;
  } catch {
    return null;
  }
}

// Whether this server offers Pexels photos (MEDIA_PEXELS_API_KEY); false while unknown.
export function useStockPhotosEnabled(): boolean {
  const status = useQuery({ queryKey: ['social-stock-photos', 'status'], queryFn: () => client.social.stockPhotos.status({}), staleTime: 10 * 60_000 });
  return status.data?.enabled === true;
}

function OutLink({ href, children }: { href: string | null; children: ReactNode }) {
  if (!href) return <>{children}</>;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-link hover:underline">
      {children}
    </a>
  );
}

// "Photo by X on Pexels", each part linked back.
export function StockCredit({ photographer, photographerUrl, className }: { photographer: string; photographerUrl: string | null; className?: string }) {
  const t = useTranslations('social');
  return (
    <p className={className ?? 'text-xs text-subtle-foreground'}>
      {t.rich('stock.credit', {
        name: photographer,
        photographer: (chunks) => <OutLink href={pexelsHref(photographerUrl)}>{chunks}</OutLink>,
        pexels: (chunks) => <OutLink href={PEXELS_URL}>{chunks}</OutLink>,
      })}
    </p>
  );
}

// The search panel. onSaved: after a photo is stored in the library (the composer adds it to the post); mode words
// the button for where it is.
export function StockPhotoSearch({ onSaved, mode = 'library', disabled = false }: { onSaved?: (saved: StockSaved, photo: StockPhoto) => void; mode?: 'library' | 'post'; disabled?: boolean }) {
  const t = useTranslations('social');
  const locale = useLocale();
  const [typed, setTyped] = useState('');
  const [query, setQuery] = useState('');
  const [done, setDone] = useState<ReadonlySet<number>>(new Set());
  const language = locale === 'en' ? 'en-US' : 'vi-VN';
  const results = useInfiniteQuery({
    queryKey: ['social-stock-photos', 'search', query, language],
    queryFn: ({ pageParam }) => client.social.stockPhotos.search({ query, page: pageParam, locale: language }),
    initialPageParam: 1,
    getNextPageParam: (page) => (page.more ? page.page + 1 : null),
    enabled: query !== '',
    staleTime: 5 * 60_000,
  });
  const save = useMutation({
    mutationFn: (photo: StockPhoto) => client.social.stockPhotos.save({ photoId: photo.id }),
    onSuccess: (saved, photo) => {
      setDone((prev) => new Set([...prev, photo.id]));
      onSaved?.(saved, photo);
      void queryClient.invalidateQueries({ queryKey: ['social-library'] });
    },
  });
  const photos = results.data?.pages.flatMap((p) => p.photos) ?? [];
  const total = results.data?.pages[0]?.total ?? 0;
  return (
    <section className="space-y-3 rounded-xl border bg-muted/40 p-3" aria-label={t('stock.title')}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium text-foreground">{t('stock.title')}</h3>
        <p className="text-xs text-subtle-foreground">{t.rich('stock.providedBy', { pexels: (chunks) => <OutLink href={PEXELS_URL}>{chunks}</OutLink> })}</p>
      </div>
      <form
        className="flex flex-wrap gap-2"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          const next = typed.trim().slice(0, 100);
          if (next) setQuery(next);
        }}
      >
        <Input value={typed} maxLength={100} onChange={(e) => setTyped(e.target.value)} placeholder={t('stock.placeholder')} aria-label={t('stock.search')} className="h-8 max-w-xs text-sm" />
        <Button type="submit" size="sm" variant="outline" disabled={typed.trim() === '' || results.isFetching}>
          {results.isFetching && !results.isFetchingNextPage ? <Spinner className="text-current" /> : null}
          {t('stock.submit')}
        </Button>
      </form>
      <p className="text-xs text-subtle-foreground">{t('stock.hint')}</p>
      {results.error && <ErrorText>{errorMessage(results.error)}</ErrorText>}
      {save.error && <ErrorText>{errorMessage(save.error)}</ErrorText>}
      {query !== '' && results.data && (photos.length === 0 ? <p className="text-xs text-subtle-foreground">{t('stock.empty')}</p> : <p className="text-xs text-subtle-foreground tabular-nums">{t('stock.results', { count: total })}</p>)}
      {photos.length > 0 && (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {photos.map((photo) => {
            const saved = done.has(photo.id);
            const busy = save.isPending && save.variables?.id === photo.id;
            return (
              <li key={photo.id} className="space-y-1.5">
                <div className="aspect-[4/3] overflow-hidden rounded-lg border bg-muted">
                  {photo.thumb ? (
                    <img src={photo.thumb} alt={photo.alt ?? ''} className="size-full object-cover" />
                  ) : (
                    <span className="flex size-full items-center justify-center p-2 text-center text-xs text-subtle-foreground">{t('stock.noThumb')}</span>
                  )}
                </div>
                <StockCredit photographer={photo.photographer} photographerUrl={photo.photographerUrl} className="truncate text-xs text-subtle-foreground" />
                <div className="flex flex-wrap items-center gap-1">
                  <Button size="sm" variant={saved ? 'ghost' : 'outline'} className="h-7 px-2 text-xs" disabled={disabled || saved || save.isPending} onClick={() => save.mutate(photo)}>
                    {busy ? <Spinner className="text-current" /> : null}
                    {saved ? t(mode === 'post' ? 'stock.added' : 'stock.saved') : t(mode === 'post' ? 'stock.saveAndAdd' : 'stock.save')}
                  </Button>
                  <a href={pexelsHref(photo.pageUrl) ?? PEXELS_URL} target="_blank" rel="noopener noreferrer" className="text-xs text-link hover:underline">
                    {t('stock.viewOnPexels')}
                  </a>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {results.hasNextPage && (
        <Button variant="ghost" size="sm" disabled={results.isFetchingNextPage} onClick={() => void results.fetchNextPage()}>
          {results.isFetchingNextPage ? <Spinner className="text-current" /> : null}
          {t('stock.more')}
        </Button>
      )}
    </section>
  );
}
