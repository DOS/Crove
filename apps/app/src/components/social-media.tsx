// Images of a Social post (#372): pick, reorder and remove them, and show them in the channel previews. Files are
// uploaded with purpose=social, so they are stored like documents but never read as invoices.
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { SOCIAL_IMAGE_TYPES, SOCIAL_VIDEO_TYPES } from '@crove/kernel-contract';
import { Button } from '@crove/ui/components/button';
import { Input } from '@crove/ui/components/input';
import { cn } from '@crove/ui/lib/utils';
import { client, errorMessage, fetchFile, queryClient, uploadFiles } from '../lib/api.ts';
import { ErrorText, Spinner } from './ui.tsx';

export interface MediaItem {
  fileId: string;
  altText: string;
  mime: string;
  sizeBytes: number;
  // A video's duration as the server read it; unknown (null or absent) until the post is saved.
  durationMs?: number | null | undefined;
}

export const MAX_POST_MEDIA = 20;

export type LibraryItem = Awaited<ReturnType<typeof client.social.media.list>>['items'][number];

// The org's library (S9), page by page, newest first; search matches the file name.
export function useLibrary(search: string, enabled = true) {
  const term = search.trim();
  return useInfiniteQuery({
    queryKey: ['social-library', term],
    queryFn: ({ pageParam }) => client.social.media.list({ ...(term ? { search: term } : {}), ...(pageParam ? { before: pageParam } : {}) }),
    initialPageParam: null as { createdAt: string; fileId: string } | null,
    getNextPageParam: (page) => {
      const last = page.items.at(-1);
      return page.more && last ? { createdAt: last.createdAt, fileId: last.fileId } : null;
    },
    placeholderData: keepPreviousData,
    enabled,
  });
}

export const sizeLabel = (bytes: number) => (bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

// Images from the library to add to a post: a click adds one, a second click takes it out again.
function LibraryPicker({ media, onChange }: { media: MediaItem[]; onChange: (media: MediaItem[]) => void }) {
  const t = useTranslations('social');
  const [search, setSearch] = useState('');
  const library = useLibrary(search);
  const items = library.data?.pages.flatMap((p) => p.items) ?? [];
  const chosen = new Set(media.map((m) => m.fileId));
  const toggle = (item: LibraryItem) =>
    onChange(chosen.has(item.fileId) ? media.filter((m) => m.fileId !== item.fileId) : media.length >= MAX_POST_MEDIA ? media : [...media, { fileId: item.fileId, altText: '', mime: item.mime, sizeBytes: item.sizeBytes, durationMs: item.durationMs }]);
  return (
    <div className="space-y-3 rounded-xl border bg-muted/40 p-3">
      <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('librarySearch')} aria-label={t('librarySearch')} className="h-8 max-w-xs text-sm" />
      {library.isLoading ? (
        <Spinner />
      ) : library.error ? (
        <ErrorText>{errorMessage(library.error)}</ErrorText>
      ) : items.length === 0 ? (
        <p className="text-xs text-subtle-foreground">{search.trim() ? t('libraryNoMatch') : t('libraryEmpty')}</p>
      ) : (
        <ul className="grid grid-cols-3 gap-2 sm:grid-cols-5">
          {items.map((item) => (
            <li key={item.fileId}>
              <button
                type="button"
                aria-pressed={chosen.has(item.fileId)}
                title={item.filename}
                disabled={!chosen.has(item.fileId) && media.length >= MAX_POST_MEDIA}
                onClick={() => toggle(item)}
                className={cn(
                  'block w-full rounded-lg ring-offset-2 ring-offset-background focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-50',
                  chosen.has(item.fileId) && 'ring-2 ring-primary',
                )}
              >
                <Thumb fileId={item.fileId} alt={item.filename} mime={item.mime} durationMs={item.durationMs} className="aspect-square" />
                <span className="sr-only">{t(chosen.has(item.fileId) ? 'libraryChosen' : 'libraryChoose', { name: item.filename })}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {library.hasNextPage && (
        <Button variant="ghost" size="sm" disabled={library.isFetchingNextPage} onClick={() => void library.fetchNextPage()}>
          {t('libraryMore')}
        </Button>
      )}
    </div>
  );
}

// A stored image, fetched once per file while it is shown (the bytes of a file id never change). Each thumbnail makes
// its own object URL and revokes it when it goes away.
function useImageUrl(fileId: string) {
  const blob = useQuery({ queryKey: ['social-media', fileId], queryFn: () => fetchFile(fileId), staleTime: Infinity });
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob.data) return;
    const next = URL.createObjectURL(blob.data);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [blob.data]);
  return { url, isLoading: blob.isLoading };
}

const clock = (ms: number) => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

// An image, or a video's first frame with its length, from the stored file.
export function Thumb({ fileId, alt, className, mime, durationMs }: { fileId: string; alt: string; className?: string; mime?: string; durationMs?: number | null | undefined }) {
  const url = useImageUrl(fileId);
  const video = mime?.startsWith('video/') ?? false;
  return (
    <div className={cn('relative overflow-hidden rounded-lg border bg-muted', className)}>
      {!url.url ? (
        <div className="flex size-full items-center justify-center">{url.isLoading ? <Spinner /> : null}</div>
      ) : video ? (
        <video src={`${url.url}#t=0.001`} aria-label={alt} muted playsInline preload="metadata" className="size-full object-cover" />
      ) : (
        <img src={url.url} alt={alt} className="size-full object-cover" />
      )}
      {video && (
        <span className="absolute bottom-1 left-1 rounded bg-background/80 px-1.5 text-xs text-foreground tabular-nums">
          ▶{durationMs ? ` ${clock(durationMs)}` : ''}
        </span>
      )}
    </div>
  );
}

// The images in a channel preview, the way most platforms lay out one to four of them.
export function MediaPreview({ media }: { media: readonly MediaItem[] }) {
  const t = useTranslations('social');
  if (media.length === 0) return null;
  const shown = media.slice(0, 4);
  return (
    <div className={cn('mt-3 grid gap-1', shown.length === 1 ? 'grid-cols-1' : 'grid-cols-2')}>
      {shown.map((m, i) => (
        <div key={m.fileId} className="relative">
          <Thumb fileId={m.fileId} alt={m.altText || t('imageAlt', { n: String(i + 1) })} mime={m.mime} durationMs={m.durationMs} className={shown.length === 1 ? 'aspect-[4/3]' : 'aspect-square'} />
          {i === 3 && media.length > 4 && (
            <span className="absolute inset-0 flex items-center justify-center rounded-lg bg-background/70 text-lg font-semibold text-foreground">+{media.length - 4}</span>
          )}
        </div>
      ))}
    </div>
  );
}

export function MediaField({ media, onChange, disabled }: { media: MediaItem[]; onChange: (media: MediaItem[]) => void; disabled: boolean }) {
  const t = useTranslations('social');
  const picker = useRef<HTMLInputElement>(null);
  const [browsing, setBrowsing] = useState(false);
  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      const room = MAX_POST_MEDIA - media.length;
      const chosen = files.slice(0, Math.max(0, room));
      const { files: stored } = await uploadFiles(chosen, 'social');
      return stored.map((s, i) => ({ fileId: s.fileId, altText: '', mime: chosen[i]?.type ?? '', sizeBytes: chosen[i]?.size ?? 0 }));
    },
    onSuccess: (added) => {
      onChange([...media, ...added.filter((a) => !media.some((m) => m.fileId === a.fileId))]);
      void queryClient.invalidateQueries({ queryKey: ['social-library'] });
    },
  });
  const move = (i: number, by: number) => {
    const next = [...media];
    const [item] = next.splice(i, 1);
    if (item) next.splice(i + by, 0, item);
    onChange(next);
  };
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-foreground">{t('images')}</span>
        <span className="text-xs text-subtle-foreground tabular-nums">
          {media.length}/{MAX_POST_MEDIA}
        </span>
      </div>
      {media.length > 0 && (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {media.map((m, i) => (
            <li key={m.fileId} className="space-y-1.5">
              <Thumb fileId={m.fileId} alt={m.altText || t('imageAlt', { n: String(i + 1) })} mime={m.mime} durationMs={m.durationMs} className="aspect-square" />
              <Input
                value={m.altText}
                disabled={disabled}
                maxLength={1000}
                aria-label={t('altText', { n: String(i + 1) })}
                placeholder={t('altTextPlaceholder')}
                className="h-7 text-xs"
                onChange={(e) => onChange(media.map((x, j) => (j === i ? { ...x, altText: e.target.value } : x)))}
              />
              <div className="flex gap-1">
                <Button variant="ghost" size="sm" disabled={disabled || i === 0} aria-label={t('moveEarlier')} onClick={() => move(i, -1)}>
                  ←
                </Button>
                <Button variant="ghost" size="sm" disabled={disabled || i === media.length - 1} aria-label={t('moveLater')} onClick={() => move(i, 1)}>
                  →
                </Button>
                <Button variant="ghost" size="sm" disabled={disabled} className="ml-auto text-destructive" onClick={() => onChange(media.filter((_, j) => j !== i))}>
                  {t('removeImage')}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
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
      <Button variant="outline" size="sm" disabled={disabled || upload.isPending || media.length >= MAX_POST_MEDIA} onClick={() => picker.current?.click()}>
        {upload.isPending ? <Spinner className="text-current" /> : null}
        {t('addImages')}
      </Button>
      <Button variant="ghost" size="sm" disabled={disabled} aria-expanded={browsing} onClick={() => setBrowsing(!browsing)}>
        {t(browsing ? 'libraryClose' : 'libraryOpen')}
      </Button>
      {browsing && !disabled && <LibraryPicker media={media} onChange={onChange} />}
      <p className="text-xs text-subtle-foreground">{t('imagesHint')}</p>
      {upload.error && <ErrorText>{errorMessage(upload.error)}</ErrorText>}
    </div>
  );
}
