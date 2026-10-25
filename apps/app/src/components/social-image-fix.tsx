// Fixing an image a channel of the post refuses (#1500), under the image in the composer: the channels that refuse it,
// and a button that saves a JPEG every channel takes (smaller when one of them has a byte limit) as a new library
// file, which then takes the original's place in the post. The original stays in the library.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslations } from 'use-intl';
import { Button } from '@crove/ui/components/button';
import { ErrorText, Spinner } from './ui.tsx';
import { sizeLabel, type MediaItem } from './social-media.tsx';
import { fetchFile, errorMessage, queryClient, uploadFiles } from '../lib/api.ts';
import { providerName } from '../lib/social.ts';
import { FIX_TYPE, firstFit, fixName, fixSteps, imageFix, isAnimated, type FixStep } from '../lib/social-image-fix.ts';

// The bytes of a stored file, from the thumbnails' cache (the bytes of a file id never change).
const fileBytes = (fileId: string) => queryClient.fetchQuery({ queryKey: ['social-media', fileId], queryFn: () => fetchFile(fileId), staleTime: Infinity });

// One encode: the image drawn at the step's size on white (a transparent PNG has no background in a JPEG) and saved
// as a JPEG at the step's quality. The canvas writes no EXIF, so the camera and location details are dropped.
async function encode(canvas: HTMLCanvasElement, bitmap: ImageBitmap, step: FixStep): Promise<Blob> {
  canvas.width = step.width;
  canvas.height = step.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas');
  // Pixels of the saved image, not a colour of the interface.
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, step.width, step.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, step.width, step.height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, FIX_TYPE, step.quality));
  if (!blob) throw new Error('canvas');
  return blob;
}

export function ImageFix({ item, providers, disabled, onFixed }: { item: MediaItem; providers: readonly string[]; disabled: boolean; onFixed: (next: MediaItem) => void }) {
  const t = useTranslations('social.imageFix');
  const offer = imageFix(item, providers);
  // A WebP or PNG may move (a canvas keeps one frame): read from its first bytes, only when a channel refuses it.
  const moving = useQuery({
    queryKey: ['social-image-animated', item.fileId],
    queryFn: async () => isAnimated(item.mime, new Uint8Array(await (await fileBytes(item.fileId)).slice(0, 65_536).arrayBuffer())),
    staleTime: Infinity,
    enabled: offer?.kind === 'fix' && (item.mime === 'image/webp' || item.mime === 'image/png'),
  });
  const fix = useMutation({
    mutationFn: async (): Promise<MediaItem> => {
      if (offer?.kind !== 'fix') throw new Error(t('failed'));
      const { target } = offer;
      const bitmap = await createImageBitmap(await fileBytes(item.fileId), { imageOrientation: 'from-image' }).catch(() => {
        throw new Error(t('cannotRead'));
      });
      try {
        const canvas = document.createElement('canvas');
        const fit = await firstFit(fixSteps(bitmap.width, bitmap.height, target), target.maxBytes, (step) => encode(canvas, bitmap, step));
        if (!fit) throw new Error(t('noFit', { max: sizeLabel(target.maxBytes ?? 0) }));
        const file = new File([fit.result], fixName(item.filename), { type: FIX_TYPE });
        const stored = (await uploadFiles([file], 'social')).files[0];
        if (!stored) throw new Error(t('failed'));
        return { fileId: stored.fileId, altText: item.altText, mime: FIX_TYPE, sizeBytes: fit.result.size, width: fit.step.width, height: fit.step.height, filename: file.name };
      } finally {
        bitmap.close();
      }
    },
    onSuccess: (next) => {
      void queryClient.invalidateQueries({ queryKey: ['social-library'] });
      onFixed(next);
    },
  });
  if (!offer) return null;
  const channels = offer.kind === 'fix' ? offer.target.refusedBy : offer.refusedBy;
  const refused = <p className="text-xs text-warning">{t('refused', { channels: channels.map(providerName).join(', ') })}</p>;
  if (offer.kind === 'animated' || moving.data === true) {
    return (
      <div className="space-y-1">
        {refused}
        <p className="text-xs text-subtle-foreground">{t('animated')}</p>
      </div>
    );
  }
  const { maxBytes } = offer.target;
  return (
    <div className="space-y-1">
      {refused}
      <Button type="button" variant="outline" size="sm" className="h-7 max-w-full px-2 text-xs" disabled={disabled || fix.isPending || moving.isLoading} onClick={() => fix.mutate()}>
        {fix.isPending ? <Spinner className="text-current" /> : null}
        {t('fix')}
      </Button>
      <p className="text-xs text-subtle-foreground">{maxBytes === null ? t('note') : t('noteSize', { max: sizeLabel(maxBytes) })}</p>
      {fix.error && <ErrorText>{errorMessage(fix.error)}</ErrorText>}
    </div>
  );
}
