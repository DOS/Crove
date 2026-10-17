// Images of a Social post (#372): pick, reorder and remove them, and show them in the channel previews. Files are
// uploaded with purpose=social, so they are stored like documents but never read as invoices.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useRef } from 'react';
import { useTranslations } from 'use-intl';
import { SOCIAL_IMAGE_TYPES } from '@crove/kernel-contract';
import { Button } from '@crove/ui/components/button';
import { Input } from '@crove/ui/components/input';
import { cn } from '@crove/ui/lib/utils';
import { errorMessage, fetchFile, uploadFiles } from '../lib/api.ts';
import { ErrorText, Spinner } from './ui.tsx';

export interface MediaItem {
  fileId: string;
  altText: string;
  mime: string;
  sizeBytes: number;
}

export const MAX_POST_MEDIA = 20;

// A stored image as an object URL, fetched once per file for the session.
function useImageUrl(fileId: string) {
  return useQuery({
    queryKey: ['social-media', fileId],
    queryFn: async () => URL.createObjectURL(await fetchFile(fileId)),
    staleTime: Infinity,
    gcTime: Infinity,
  });
}

export function Thumb({ fileId, alt, className }: { fileId: string; alt: string; className?: string }) {
  const url = useImageUrl(fileId);
  return (
    <div className={cn('overflow-hidden rounded-lg border bg-muted', className)}>
      {url.data ? <img src={url.data} alt={alt} className="size-full object-cover" /> : <div className="flex size-full items-center justify-center">{url.isLoading ? <Spinner /> : null}</div>}
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
          <Thumb fileId={m.fileId} alt={m.altText || t('imageAlt', { n: String(i + 1) })} className={shown.length === 1 ? 'aspect-[4/3]' : 'aspect-square'} />
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
  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      const room = MAX_POST_MEDIA - media.length;
      const chosen = files.slice(0, Math.max(0, room));
      const { files: stored } = await uploadFiles(chosen, 'social');
      return stored.map((s, i) => ({ fileId: s.fileId, altText: '', mime: chosen[i]?.type ?? '', sizeBytes: chosen[i]?.size ?? 0 }));
    },
    onSuccess: (added) => onChange([...media, ...added.filter((a) => !media.some((m) => m.fileId === a.fileId))]),
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
              <Thumb fileId={m.fileId} alt={m.altText || t('imageAlt', { n: String(i + 1) })} className="aspect-square" />
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
        accept={SOCIAL_IMAGE_TYPES.join(',')}
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
      <p className="text-xs text-subtle-foreground">{t('imagesHint')}</p>
      {upload.error && <ErrorText>{errorMessage(upload.error)}</ErrorText>}
    </div>
  );
}
