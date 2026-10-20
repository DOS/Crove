// Cropping a post image to a platform's frame (#636): pick a frame, slide the crop along the image, see the result,
// then save it. The crop is drawn in the browser and uploaded as a new image of the library; the post (or the
// channel) then shows that file instead, and the original stays in the library.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { Button } from '@crove/ui/components/button';
import { Label } from '@crove/ui/components/label';
import { ErrorText, Spinner } from './ui.tsx';
import type { MediaItem } from './social-media.tsx';
import { errorMessage, fetchFile, queryClient, uploadFiles } from '../lib/api.ts';
import { CROP_PRESETS, cropAxis, cropName, cropRect, cropType, outputSize, type CropPreset } from '../lib/social-crop.ts';

// The image decoded once, turned the way its EXIF says.
function useBitmap(fileId: string) {
  return useQuery({
    queryKey: ['social-media-bitmap', fileId],
    queryFn: async () => createImageBitmap(await fetchFile(fileId), { imageOrientation: 'from-image' }),
    staleTime: Infinity,
    gcTime: 60_000,
  });
}

function draw(canvas: HTMLCanvasElement, bitmap: ImageBitmap, rect: { x: number; y: number; width: number; height: number }, width: number, height: number) {
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, rect.x, rect.y, rect.width, rect.height, 0, 0, width, height);
}

export function CropPanel({ item, onDone, onCancel, initial = 'portrait' }: { item: MediaItem; onDone: (next: MediaItem) => void; onCancel: () => void; initial?: CropPreset }) {
  const t = useTranslations('social.crop');
  const bitmap = useBitmap(item.fileId);
  const [preset, setPreset] = useState<CropPreset>(initial);
  const [at, setAt] = useState(0.5);
  const preview = useRef<HTMLCanvasElement>(null);
  const ratio = CROP_PRESETS.find((p) => p.id === preset)?.ratio ?? 1;
  const image = bitmap.data;
  const rect = image ? cropRect(image.width, image.height, ratio, at) : null;

  // The preview: the crop at a small size, redrawn as the frame or the position changes.
  useEffect(() => {
    if (!image || !rect || !preview.current) return;
    const scale = 360 / Math.max(rect.width, rect.height);
    draw(preview.current, image, rect, Math.max(1, Math.round(rect.width * scale)), Math.max(1, Math.round(rect.height * scale)));
  }, [image, rect?.x, rect?.y, rect?.width, rect?.height]);

  const save = useMutation({
    mutationFn: async (): Promise<MediaItem> => {
      if (!image || !rect) throw new Error(t('notReady'));
      const size = outputSize(rect);
      const canvas = document.createElement('canvas');
      draw(canvas, image, rect, size.width, size.height);
      const type = cropType(item.mime);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.92));
      if (!blob) throw new Error(t('failed'));
      const file = new File([blob], cropName('anh', preset, type), { type });
      const stored = (await uploadFiles([file], 'social')).files[0];
      if (!stored) throw new Error(t('failed'));
      return { fileId: stored.fileId, altText: item.altText, mime: type, sizeBytes: blob.size, width: size.width, height: size.height };
    },
    onSuccess: (next) => {
      void queryClient.invalidateQueries({ queryKey: ['social-library'] });
      onDone(next);
    },
  });

  const axis = image ? cropAxis(image.width, image.height, ratio) : 'x';
  const free = image && rect ? (axis === 'x' ? image.width - rect.width : image.height - rect.height) > 0 : false;
  return (
    <div className="space-y-3 rounded-xl border bg-muted/40 p-3">
      <div className="flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label={t('frame')}>
        <span className="mr-1 text-xs text-subtle-foreground">{t('frame')}</span>
        {CROP_PRESETS.map((p) => (
          <Button
            key={p.id}
            type="button"
            size="sm"
            role="radio"
            aria-checked={preset === p.id}
            variant={preset === p.id ? 'secondary' : 'ghost'}
            onClick={() => {
              setPreset(p.id);
              setAt(0.5);
            }}
          >
            {p.label} · {t(`presets.${p.id}`)}
          </Button>
        ))}
      </div>
      {bitmap.isLoading ? (
        <Spinner />
      ) : bitmap.error ? (
        <ErrorText>{t('cannotRead')}</ErrorText>
      ) : (
        <div className="flex flex-wrap items-start gap-4">
          <canvas ref={preview} className="max-h-72 max-w-full rounded-lg border bg-background" aria-label={t('preview')} />
          <div className="min-w-48 flex-1 space-y-2">
            {free && (
              <div className="space-y-1.5">
                <Label htmlFor={`crop-at-${item.fileId}`}>{t(axis === 'x' ? 'moveAcross' : 'moveDown')}</Label>
                <input id={`crop-at-${item.fileId}`} type="range" min={0} max={100} value={Math.round(at * 100)} onChange={(e) => setAt(Number(e.target.value) / 100)} className="w-full accent-primary" />
              </div>
            )}
            {image && rect && (
              <p className="text-xs text-subtle-foreground tabular-nums">
                {t('sizes', { from: `${image.width} × ${image.height}`, to: `${outputSize(rect).width} × ${outputSize(rect).height}` })}
              </p>
            )}
            <div className="flex gap-2">
              <Button type="button" size="sm" disabled={!rect || save.isPending} onClick={() => save.mutate()}>
                {save.isPending ? <Spinner className="text-current" /> : null}
                {t('save')}
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
                {t('cancel')}
              </Button>
            </div>
            <p className="text-xs text-subtle-foreground">{t('hint')}</p>
          </div>
        </div>
      )}
      {save.error && <ErrorText>{errorMessage(save.error)}</ErrorText>}
    </div>
  );
}
