// Photos an AI draft is written from (#1191): in the composer's AI draft box, *Viết từ ảnh* picks 1 to
// AI_DRAFT_IMAGES_MAX images among the post's own and the library's, and a library item offers *Soạn bài từ ảnh này*.
// The server reads them for the model, which writes only what they show and what the brief adds; the new post carries
// them, in the order picked, and is tainted like any AI draft.
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { AI_DRAFT_IMAGES_MAX, AI_IMAGE_MAX_BYTES, SOCIAL_PHOTO_TYPES } from '@crove/kernel-contract';
import { Button, buttonVariants } from '@crove/ui/components/button';
import { cn } from '@crove/ui/lib/utils';
import { errorMessage } from '../lib/api.ts';
import { Thumb, useLibrary, type LibraryItem, type MediaItem } from './social-media.tsx';
import { ErrorText, Spinner } from './ui.tsx';

// A file the model is sent: a JPG, PNG or WEBP image of at most 10 MB (the server checks it again).
export const usablePhoto = (file: { mime: string; sizeBytes: number }): boolean => SOCIAL_PHOTO_TYPES.includes(file.mime) && file.sizeBytes <= AI_IMAGE_MAX_BYTES;

// The picked photos with one more or one fewer, in the order picked, never more than AI_DRAFT_IMAGES_MAX.
export function togglePhoto(picked: readonly string[], fileId: string): string[] {
  if (picked.includes(fileId)) return picked.filter((id) => id !== fileId);
  return picked.length >= AI_DRAFT_IMAGES_MAX ? [...picked] : [...picked, fileId];
}

// What the AI draft box sends: the brief, the chosen channels, the page's language, and the page or the photos.
export function aiDraftInput(form: { brief: string; connectionIds: readonly string[]; locale: string; source: string | null; photos: readonly string[] }) {
  return {
    brief: form.brief.trim(),
    connectionIds: [...form.connectionIds],
    language: form.locale === 'en' ? ('en' as const) : ('vi' as const),
    ...(form.source ? { sourceUrl: form.source } : {}),
    ...(form.photos.length > 0 ? { fileIds: form.photos.slice(0, AI_DRAFT_IMAGES_MAX) } : {}),
  };
}

function PhotoButton({ fileId, name, mime, picked, order, full, disabled, onToggle }: { fileId: string; name: string; mime: string; picked: boolean; order: number; full: boolean; disabled: boolean; onToggle: () => void }) {
  const t = useTranslations('social.aiPhotos');
  return (
    <li className="relative">
      <button
        type="button"
        aria-pressed={picked}
        aria-label={t(picked ? 'unchoose' : 'choose', { name })}
        title={name}
        disabled={disabled || (!picked && full)}
        onClick={onToggle}
        className={cn(
          'block w-full rounded-lg ring-offset-2 ring-offset-background focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-50',
          picked && 'ring-2 ring-primary',
        )}
      >
        <Thumb fileId={fileId} alt={name} name={name} mime={mime} className="aspect-square" />
      </button>
      {picked && <span className="absolute top-1 left-1 rounded bg-card/90 px-1.5 text-xs font-medium text-foreground tabular-nums">{order + 1}</span>}
    </li>
  );
}

// The library's usable photos, page by page.
function LibraryPhotos({ picked, disabled, onChange }: { picked: readonly string[]; disabled: boolean; onChange: (picked: string[]) => void }) {
  const t = useTranslations('social.aiPhotos');
  const tSocial = useTranslations('social');
  const library = useLibrary('');
  const items: LibraryItem[] = (library.data?.pages.flatMap((p) => p.items) ?? []).filter(usablePhoto);
  if (library.isLoading) return <Spinner />;
  if (library.error) return <ErrorText>{errorMessage(library.error)}</ErrorText>;
  return (
    <div className="space-y-2">
      {items.length === 0 ? (
        <p className="text-xs text-subtle-foreground">{t('libraryEmpty')}</p>
      ) : (
        <ul className="grid grid-cols-4 gap-2 sm:grid-cols-6">
          {items.map((item) => (
            <PhotoButton
              key={item.fileId}
              fileId={item.fileId}
              name={item.filename}
              mime={item.mime}
              picked={picked.includes(item.fileId)}
              order={picked.indexOf(item.fileId)}
              full={picked.length >= AI_DRAFT_IMAGES_MAX}
              disabled={disabled}
              onToggle={() => onChange(togglePhoto(picked, item.fileId))}
            />
          ))}
        </ul>
      )}
      {library.hasNextPage && (
        <Button variant="ghost" size="sm" disabled={library.isFetchingNextPage} onClick={() => void library.fetchNextPage()}>
          {tSocial('libraryMore')}
        </Button>
      )}
    </div>
  );
}

// The photo picker of the AI draft box: the post's usable images first, then the library on demand.
export function AiPhotoPicker({ postMedia, picked, disabled, onChange, libraryOpen: initiallyOpen = false }: { postMedia: readonly MediaItem[]; picked: readonly string[]; disabled: boolean; onChange: (picked: string[]) => void; libraryOpen?: boolean }) {
  const t = useTranslations('social.aiPhotos');
  const [libraryOpen, setLibraryOpen] = useState(initiallyOpen);
  const own = postMedia.filter(usablePhoto);
  const full = picked.length >= AI_DRAFT_IMAGES_MAX;
  return (
    <div className="space-y-3 rounded-xl border bg-muted/40 p-3">
      <p className="text-xs text-subtle-foreground">{t('hint', { max: AI_DRAFT_IMAGES_MAX })}</p>
      <p className="text-xs font-medium text-muted-foreground">{t('fromPost')}</p>
      {own.length === 0 ? (
        <p className="text-xs text-subtle-foreground">{t('noneInPost')}</p>
      ) : (
        <ul className="grid grid-cols-4 gap-2 sm:grid-cols-6">
          {own.map((m, i) => (
            <PhotoButton
              key={m.fileId}
              fileId={m.fileId}
              name={m.filename || m.altText || `${i + 1}`}
              mime={m.mime}
              picked={picked.includes(m.fileId)}
              order={picked.indexOf(m.fileId)}
              full={full}
              disabled={disabled}
              onToggle={() => onChange(togglePhoto(picked, m.fileId))}
            />
          ))}
        </ul>
      )}
      {own.length < postMedia.length && <p className="text-xs text-subtle-foreground">{t('notUsable')}</p>}
      <Button variant="ghost" size="sm" aria-expanded={libraryOpen} onClick={() => setLibraryOpen(!libraryOpen)}>
        {t(libraryOpen ? 'closeLibrary' : 'fromLibrary')}
      </Button>
      {libraryOpen && <LibraryPhotos picked={picked} disabled={disabled} onChange={onChange} />}
      <p className={cn('text-xs tabular-nums', full ? 'text-warning' : 'text-muted-foreground')}>
        {t('picked', { count: picked.length, max: AI_DRAFT_IMAGES_MAX })}
        {full ? ` · ${t('max', { max: AI_DRAFT_IMAGES_MAX })}` : ''}
      </p>
    </div>
  );
}

// *Soạn bài từ ảnh này* on a library item: the composer opens with the photo picked in its AI draft box. Only for a
// photo the model can be sent.
export function DraftFromPhotoLink({ slug, item }: { slug: string; item: Pick<LibraryItem, 'fileId' | 'mime' | 'sizeBytes'> }) {
  const t = useTranslations('social.aiPhotos');
  if (!usablePhoto(item)) return null;
  return (
    <Link to="/o/$slug/social/new" params={{ slug }} search={{ photo: item.fileId }} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
      {t('fromItem')}
    </Link>
  );
}
