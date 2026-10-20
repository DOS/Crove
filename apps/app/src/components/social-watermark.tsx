// The org's logo watermark (#834), on the Channels page: the logo, its corner, size and opacity. Owners and admins
// edit; the composer then offers to put it on a post's images (MediaField).
import { useMutation, useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { Button } from '@crove/ui/components/button';
import { Label } from '@crove/ui/components/label';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { ErrorText, Spinner } from './ui.tsx';
import { Thumb } from './social-media.tsx';
import { client, errorMessage, orpc, queryClient, uploadFiles } from '../lib/api.ts';
import { WATERMARK_CORNERS, type WatermarkCorner } from '../lib/social-watermark.ts';

const LOGO_TYPES = ['image/png', 'image/webp', 'image/jpeg'];

export function WatermarkCard({ canEdit }: { canEdit: boolean }) {
  const t = useTranslations('social.watermark');
  const current = useQuery(orpc.social.watermark.get.queryOptions({ input: {} }));
  const saved = current.data ?? null;
  const [fileId, setFileId] = useState<string | null>(null);
  const [corner, setCorner] = useState<WatermarkCorner | null>(null);
  const [scale, setScale] = useState<number | null>(null);
  const [opacity, setOpacity] = useState<number | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  // What the form shows: what the member changed, else what is saved, else the defaults.
  const shown = { fileId: fileId ?? saved?.fileId ?? null, corner: corner ?? saved?.corner ?? 'bottom_right', scale: scale ?? saved?.scalePercent ?? 20, opacity: opacity ?? saved?.opacityPercent ?? 80 };
  const dirty = fileId !== null || corner !== null || scale !== null || opacity !== null;
  const reset = () => {
    setFileId(null);
    setCorner(null);
    setScale(null);
    setOpacity(null);
  };
  const refresh = () => void queryClient.invalidateQueries({ queryKey: orpc.social.watermark.get.key() });
  const upload = useMutation({
    mutationFn: async (file: File) => {
      const stored = (await uploadFiles([file], 'social')).files[0];
      if (!stored) throw new Error(t('uploadFailed'));
      return stored.fileId;
    },
    onSuccess: (id) => {
      setFileId(id);
      void queryClient.invalidateQueries({ queryKey: ['social-library'] });
    },
  });
  const save = useMutation({
    mutationFn: () => {
      if (!shown.fileId) throw new Error(t('needLogo'));
      return client.social.watermark.save({ fileId: shown.fileId, corner: shown.corner, scalePercent: shown.scale, opacityPercent: shown.opacity });
    },
    onSuccess: () => {
      reset();
      refresh();
    },
  });
  const remove = useMutation({
    mutationFn: () => client.social.watermark.remove({}),
    onSuccess: () => {
      reset();
      refresh();
    },
  });
  if (current.isLoading) return <Spinner />;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start gap-3">
        {shown.fileId ? (
          <Thumb fileId={shown.fileId} alt={t('logoAlt')} className="size-20 rounded-lg border bg-muted object-contain" />
        ) : (
          <p className="text-xs text-subtle-foreground">{t('none')}</p>
        )}
        {canEdit && (
          <div className="space-y-1">
            <input
              ref={picker}
              type="file"
              accept={LOGO_TYPES.join(',')}
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (file) upload.mutate(file);
              }}
            />
            <Button size="sm" variant="outline" disabled={upload.isPending} onClick={() => picker.current?.click()}>
              {upload.isPending ? <Spinner className="text-current" /> : null}
              {shown.fileId ? t('changeLogo') : t('addLogo')}
            </Button>
            <p className="text-xs text-subtle-foreground">{t('logoHint')}</p>
          </div>
        )}
      </div>
      {canEdit && shown.fileId && (
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1">
            <Label htmlFor="wm-corner" className="text-xs">
              {t('corner')}
            </Label>
            <NativeSelect id="wm-corner" size="sm" className="w-full" value={shown.corner} onChange={(e) => setCorner(e.target.value as WatermarkCorner)}>
              {WATERMARK_CORNERS.map((c) => (
                <NativeSelectOption key={c} value={c}>
                  {t(`corners.${c}`)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          <div className="space-y-1">
            <Label htmlFor="wm-scale" className="text-xs">
              {t('size', { percent: String(shown.scale) })}
            </Label>
            <input id="wm-scale" type="range" min={5} max={50} value={shown.scale} onChange={(e) => setScale(Number(e.target.value))} className="w-full accent-primary" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="wm-opacity" className="text-xs">
              {t('opacity', { percent: String(shown.opacity) })}
            </Label>
            <input id="wm-opacity" type="range" min={10} max={100} value={shown.opacity} onChange={(e) => setOpacity(Number(e.target.value))} className="w-full accent-primary" />
          </div>
        </div>
      )}
      {canEdit && (
        <div className="flex flex-wrap gap-2">
          {shown.fileId && (dirty || !saved) && (
            <Button size="sm" disabled={save.isPending} onClick={() => save.mutate()}>
              {t('save')}
            </Button>
          )}
          {dirty && (
            <Button size="sm" variant="ghost" onClick={reset}>
              {t('cancel')}
            </Button>
          )}
          {saved && !dirty && (
            <Button size="sm" variant="ghost" disabled={remove.isPending} onClick={() => remove.mutate()}>
              {t('remove')}
            </Button>
          )}
        </div>
      )}
      {(upload.error ?? save.error ?? remove.error ?? current.error) && <ErrorText>{errorMessage(upload.error ?? save.error ?? remove.error ?? current.error)}</ErrorText>}
    </div>
  );
}
