// White-label client reports (#1053): the agency's mark on the client report, the review page and the plan print, and
// the settings card on the Channels page where owners and admins set it. Without a brand the pages show Crove's logo,
// exactly as before.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { Button } from '@crove/ui/components/button';
import { Checkbox } from '@crove/ui/components/checkbox';
import { Input } from '@crove/ui/components/input';
import { Label } from '@crove/ui/components/label';
import { accentReadable, BRAND_ACCENT_START, BRAND_LOGO_TYPES, BRAND_MIN_CONTRAST, BRAND_NAME_MAX, accentContrast, normalizeAccent } from '@crove/mod-social/contract';
import { ErrorText, Logo, Spinner } from './ui.tsx';
import { LibraryPicker } from './social-media.tsx';
import { client, ClientError, errorMessage, fetchFile, orpc, queryClient, uploadFiles } from '../lib/api.ts';
import { accentStyle, makeLogoDataUrl, type ReportBrand } from '../lib/social-report-branding.ts';

/** The page's mark: the agency's logo and name when the org has a brand, else Crove's logo. */
export function BrandMark({ brand, org }: { brand: ReportBrand | null; org: string }) {
  if (!brand) return <Logo />;
  const name = brand.name ?? org;
  return (
    <span className="inline-flex min-w-0 items-center gap-2 font-semibold tracking-tight text-foreground">
      {brand.logo && <img src={brand.logo} alt={name} className="h-9 w-auto max-w-40 object-contain" />}
      {(!brand.logo || brand.name) && <span className="truncate">{name}</span>}
    </span>
  );
}

/** The line under a branded page that it was made with Crove, unless the org hides it; nothing without a brand. */
export function MadeWithCrove({ brand }: { brand: ReportBrand | null }) {
  const t = useTranslations('social.reportBranding');
  if (!brand || brand.hideCrove) return null;
  return <p className="text-xs text-subtle-foreground">{t('madeWith')}</p>;
}

/** The accent rule under a branded page's header; nothing without an accent. */
export function AccentRule({ brand }: { brand: ReportBrand | null }) {
  if (!brand?.accent) return null;
  return <div aria-hidden="true" className="border-t-4 border-(--brand-accent)" />;
}

export { accentStyle };

/** The browser tab's title on a branded page: the agency's name instead of Crove's, put back when the page goes. */
export function useBrandTitle(brand: ReportBrand | null, org: string) {
  const name = brand ? (brand.name ?? org) : null;
  useEffect(() => {
    if (!name) return;
    const before = document.title;
    document.title = name;
    return () => {
      document.title = before;
    };
  }, [name]);
}

const LIBRARY_TYPES: readonly string[] = BRAND_LOGO_TYPES;

export function ReportBrandingCard({ canEdit }: { canEdit: boolean }) {
  const t = useTranslations('social.reportBranding');
  const current = useQuery(orpc.social.reportBranding.get.queryOptions({ input: {} }));
  const saved = current.data ?? null;
  // What the member changed; undefined: as saved.
  const [name, setName] = useState<string | undefined>(undefined);
  const [logo, setLogo] = useState<string | null | undefined>(undefined);
  const [accent, setAccent] = useState<string | undefined>(undefined);
  const [hideCrove, setHideCrove] = useState<boolean | undefined>(undefined);
  const [browsing, setBrowsing] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const shown = {
    name: name ?? saved?.name ?? '',
    logo: logo === undefined ? (saved?.logo ?? null) : logo,
    accent: accent ?? saved?.accent ?? '',
    hideCrove: hideCrove ?? saved?.hideCrove ?? false,
  };
  const dirty = name !== undefined || logo !== undefined || accent !== undefined || hideCrove !== undefined;
  const reset = () => {
    setName(undefined);
    setLogo(undefined);
    setAccent(undefined);
    setHideCrove(undefined);
  };
  const refresh = () => void queryClient.invalidateQueries({ queryKey: orpc.social.reportBranding.get.key() });
  // A library image (or a new upload, which joins the library first) made into the small logo the pages carry.
  const pick = useMutation({
    mutationFn: async (from: { fileId: string; mime: string } | { file: File }) => {
      if ('file' in from) {
        if (!LIBRARY_TYPES.includes(from.file.type)) throw new ClientError('social.reportBranding.logoType', (tt) => tt('social.reportBranding.logoType'));
        const stored = (await uploadFiles([from.file], 'social')).files[0];
        if (!stored) throw new ClientError('social.reportBranding.uploadFailed', (tt) => tt('social.reportBranding.uploadFailed'));
        void queryClient.invalidateQueries({ queryKey: ['social-library'] });
        return makeLogoDataUrl(from.file, from.file.type);
      }
      if (!LIBRARY_TYPES.includes(from.mime)) throw new ClientError('social.reportBranding.logoType', (tt) => tt('social.reportBranding.logoType'));
      return makeLogoDataUrl(await fetchFile(from.fileId), from.mime);
    },
    onSuccess: (url) => {
      setLogo(url);
      setBrowsing(false);
    },
  });
  const typedAccent = shown.accent.trim();
  const normalized = typedAccent ? normalizeAccent(typedAccent) : null;
  const accentError = typedAccent ? (!normalized ? t('accentInvalid') : !accentReadable(normalized) ? t('accentLowContrast', { ratio: accentContrast(normalized).toFixed(1), min: String(BRAND_MIN_CONTRAST) }) : null) : null;
  const save = useMutation({
    mutationFn: () =>
      client.social.reportBranding.save({
        name: shown.name.trim() ? shown.name.trim() : null,
        logo: shown.logo,
        accent: normalized,
        hideCrove: shown.hideCrove,
      }),
    onSuccess: () => {
      reset();
      refresh();
    },
  });
  const remove = useMutation({
    mutationFn: () => client.social.reportBranding.remove({}),
    onSuccess: () => {
      reset();
      refresh();
    },
  });
  if (current.isLoading) return <Spinner />;
  const preview: ReportBrand = { name: shown.name.trim() || null, logo: shown.logo, accent: normalized && !accentError ? normalized : null, hideCrove: shown.hideCrove };
  return (
    <div className="space-y-3">
      <div className="space-y-2 rounded-lg border p-3" style={accentStyle(preview)}>
        <p className="text-xs text-subtle-foreground">{t('preview')}</p>
        {saved || dirty ? <BrandMark brand={preview} org={t('orgName')} /> : <Logo />}
        <AccentRule brand={preview} />
      </div>
      {!canEdit ? (
        !saved && <p className="text-xs text-subtle-foreground">{t('none')}</p>
      ) : (
        <>
          <div className="space-y-1">
            <Label htmlFor="rb-name" className="text-xs">
              {t('name')}
            </Label>
            <Input id="rb-name" value={shown.name} maxLength={BRAND_NAME_MAX} placeholder={t('namePlaceholder')} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1">
            <p className="text-xs font-medium">{t('logo')}</p>
            <input
              ref={picker}
              type="file"
              accept={LIBRARY_TYPES.join(',')}
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (file) pick.mutate({ file });
              }}
            />
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" disabled={pick.isPending} onClick={() => picker.current?.click()}>
                {pick.isPending ? <Spinner className="text-current" /> : null}
                {t('upload')}
              </Button>
              <Button size="sm" variant="ghost" aria-expanded={browsing} onClick={() => setBrowsing(!browsing)}>
                {t(browsing ? 'libraryClose' : 'libraryOpen')}
              </Button>
              {shown.logo && (
                <Button size="sm" variant="ghost" onClick={() => setLogo(null)}>
                  {t('logoRemove')}
                </Button>
              )}
            </div>
            <p className="text-xs text-subtle-foreground">{t('logoHint')}</p>
            {browsing && (
              <LibraryPicker
                media={[]}
                only={LIBRARY_TYPES}
                onChange={(next) => {
                  const chosen = next.at(-1);
                  if (chosen) pick.mutate({ fileId: chosen.fileId, mime: chosen.mime });
                }}
              />
            )}
          </div>
          <div className="space-y-1">
            <Label htmlFor="rb-accent" className="text-xs">
              {t('accent')}
            </Label>
            <div className="flex items-center gap-2">
              <input type="color" aria-label={t('accentPick')} value={normalized ?? BRAND_ACCENT_START} onChange={(e) => setAccent(e.target.value)} className="h-9 w-12 cursor-pointer rounded-md border bg-transparent" />
              <Input id="rb-accent" className="max-w-36 font-mono" value={shown.accent} maxLength={7} placeholder="#rrggbb" onChange={(e) => setAccent(e.target.value)} aria-invalid={accentError ? true : undefined} />
              {shown.accent && (
                <Button size="sm" variant="ghost" onClick={() => setAccent('')}>
                  {t('accentClear')}
                </Button>
              )}
            </div>
            {accentError ? <p className="text-xs text-destructive">{accentError}</p> : <p className="text-xs text-subtle-foreground">{t('accentHint')}</p>}
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={shown.hideCrove} onCheckedChange={(checked) => setHideCrove(checked === true)} />
            {t('hideCrove')}
          </label>
          <div className="flex flex-wrap gap-2">
            {(dirty || !saved) && (
              <Button size="sm" disabled={save.isPending || accentError !== null} onClick={() => save.mutate()}>
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
        </>
      )}
      {(pick.error ?? save.error ?? remove.error ?? current.error) && <ErrorText>{errorMessage(pick.error ?? save.error ?? remove.error ?? current.error)}</ErrorText>}
    </div>
  );
}
