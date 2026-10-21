// Fiscal year archive packages (#922) on the ledger screen, for owners: ask for the package of a year whose every month
// is locked (R3, a fresh second factor), follow the request until the worker records it, then list its parts, download
// them and verify that every part and original still has the bytes the manifest names.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import type { YearArchive, YearArchiveVerification } from '@crove/kernel-contract';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { useFormat } from '../i18n/provider.tsx';
import { apiFetch, errorMessage, isStepUpRequired, orpc, queryClient } from '../lib/api.ts';
import { archivableYears, canArchiveYears, isStalled, type ArchiveManifestView } from '../lib/year-archive.ts';
import { StepUpPrompt } from './two-factor.tsx';
import { ErrorText, Spinner } from './ui.tsx';

// While a request waits for the worker, the list is read again this often.
const PENDING_REFRESH_MS = 15_000;

async function saveBlob(response: Response, filename: string) {
  const url = URL.createObjectURL(await response.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function YearArchivePanel() {
  const org = useQuery(orpc.org.get.queryOptions());
  if (!canArchiveYears(org.data?.role)) return null;
  return <OwnerYearArchive />;
}

function OwnerYearArchive() {
  const t = useTranslations('yearArchive');
  const list = useQuery({
    ...orpc.yearArchive.list.queryOptions(),
    refetchInterval: (query) => (query.state.data?.archives.some((a) => a.state === 'requested' && !isStalled(a, Date.now())) ? PENDING_REFRESH_MS : false),
  });
  const [picked, setPicked] = useState<number | null>(null);
  // One key per request: a retry after the step-up is the same request; a new one follows each success.
  const [buildKey, setBuildKey] = useState(() => crypto.randomUUID());
  const build = useMutation(
    orpc.yearArchive.build.mutationOptions({
      onSuccess: () => {
        setBuildKey(crypto.randomUUID());
        setPicked(null);
        void queryClient.invalidateQueries({ queryKey: orpc.yearArchive.list.key() });
      },
    }),
  );

  if (list.error) return <ErrorText>{errorMessage(list.error)}</ErrorText>;
  const data = list.data;
  if (!data) return null;
  const years = archivableYears(data.lockedThrough, data.archives, Date.now());
  const year = picked !== null && years.includes(picked) ? picked : years[0];
  const stepUp = isStepUpRequired(build.error);

  return (
    <Card className="mb-4 block space-y-3 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-2xl space-y-1">
          <h2 className="text-sm font-semibold text-foreground">{t('title')}</h2>
          <p className="text-sm text-muted-foreground">{t('intro')}</p>
        </div>
        {year !== undefined && (
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-xs">
              <span className="text-subtle-foreground">{t('year')}</span>
              <NativeSelect
                aria-label={t('year')}
                className="mt-1 w-28"
                value={year}
                onChange={(e) => {
                  setPicked(Number(e.target.value));
                  build.reset();
                }}>
                {years.map((y) => (
                  <NativeSelectOption key={y} value={y}>
                    {y}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </label>
            <Button variant="outline" disabled={build.isPending} onClick={() => build.mutate({ year, idempotencyKey: buildKey })}>
              {t('build', { year: String(year) })}
            </Button>
          </div>
        )}
      </div>
      {year === undefined && data.archives.length === 0 && <p className="text-xs text-subtle-foreground">{t('noLockedYear')}</p>}
      {stepUp && year !== undefined && (
        <StepUpPrompt action={t('stepUp', { year: String(build.variables?.year ?? year) })} onVerified={() => build.variables && build.mutate(build.variables)} onCancel={() => build.reset()} />
      )}
      {build.error && !stepUp && <ErrorText>{errorMessage(build.error)}</ErrorText>}
      {data.archives.length > 0 && (
        <ul className="divide-y divide-border rounded-md border border-border">
          {data.archives.map((archive) => (
            <ArchiveRow key={archive.year} archive={archive} />
          ))}
        </ul>
      )}
    </Card>
  );
}

function ArchiveRow({ archive }: { archive: YearArchive }) {
  const t = useTranslations('yearArchive');
  const f = useFormat();
  const [open, setOpen] = useState(false);
  const base = `/api/finance-archive/${archive.year}`;
  const manifest = useQuery({
    queryKey: ['yearArchive', 'manifest', archive.year, archive.manifestSha256],
    queryFn: async () => (await (await apiFetch(`${base}/manifest`)).json()) as ArchiveManifestView,
    enabled: open && archive.state === 'built',
    staleTime: Infinity,
  });
  const verify = useMutation({ mutationFn: async () => (await (await apiFetch(`${base}/verify`)).json()) as YearArchiveVerification });
  const download = useMutation({
    mutationFn: async (part: { path: string; filename: string }) => saveBlob(await apiFetch(`${base}/${part.path}`), part.filename),
  });

  if (archive.state === 'requested') {
    const stalled = isStalled(archive, Date.now());
    return (
      <li className="flex flex-wrap items-center gap-2 p-3 text-sm">
        <span className="font-medium text-foreground">{archive.year}</span>
        <Badge variant={stalled ? 'destructive' : 'brand'}>{stalled ? t('stalled') : t('pending')}</Badge>
        <span className="text-xs text-subtle-foreground">{t('requestedAt', { when: f.dateTime(archive.requestedAt) })}</span>
        {stalled && <span className="text-xs text-subtle-foreground">{t('stalledHint')}</span>}
      </li>
    );
  }

  return (
    <li className="space-y-2 p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-foreground">{archive.year}</span>
        <Badge variant="success">{t('built')}</Badge>
        <span className="text-xs text-subtle-foreground">
          {t('builtSummary', { when: f.dateTime(archive.builtAt), parts: archive.parts ?? 0, documents: archive.documents ?? 0 })}
        </span>
        <div className="ml-auto flex flex-wrap gap-2">
          <Button variant="ghost" size="sm" onClick={() => setOpen(!open)} aria-expanded={open}>
            {open ? t('hideParts') : t('showParts')}
          </Button>
          <Button variant="outline" size="sm" disabled={verify.isPending} onClick={() => verify.mutate()}>
            {verify.isPending ? <Spinner className="text-current" /> : null}
            {t('verify')}
          </Button>
        </div>
      </div>
      {verify.error && <ErrorText>{errorMessage(verify.error)}</ErrorText>}
      {verify.data && <VerificationResult result={verify.data} />}
      {open && (
        <div className="space-y-2">
          {manifest.isLoading && <Spinner />}
          {manifest.error && <ErrorText>{errorMessage(manifest.error)}</ErrorText>}
          {manifest.data && (
            <>
              <ul className="space-y-1">
                <li className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">{t('manifest')}</span>
                  <Button variant="link" size="sm" onClick={() => download.mutate({ path: 'manifest', filename: `luu-tru-${archive.year}-ban-ke.json` })}>
                    {t('download')}
                  </Button>
                </li>
                {manifest.data.parts.map((part) => (
                  <li key={part.sha256} className="flex items-center justify-between gap-2">
                    <span className="truncate text-foreground">{part.name}</span>
                    <Button variant="link" size="sm" onClick={() => download.mutate({ path: part.sha256, filename: part.name })}>
                      {t('download')}
                    </Button>
                  </li>
                ))}
              </ul>
              <p className="text-xs text-subtle-foreground">{t('originals', { documents: manifest.data.documents.length })}</p>
              {manifest.data.notes.map((note) => (
                <p key={note} className="text-xs text-subtle-foreground">
                  {note}
                </p>
              ))}
            </>
          )}
          {download.error && <ErrorText>{errorMessage(download.error)}</ErrorText>}
        </div>
      )}
    </li>
  );
}

function VerificationResult({ result }: { result: YearArchiveVerification }) {
  const t = useTranslations('yearArchive');
  if (result.ok) {
    return (
      <p className="text-xs text-success" role="status">
        {t('verifyOk', { checked: result.checked })}
      </p>
    );
  }
  return (
    <div className="space-y-1 text-xs text-destructive" role="alert">
      <p>{t('verifyFailed', { problems: result.problems.length, checked: result.checked })}</p>
      <ul className="list-disc pl-5">
        {result.problems.map((problem) => (
          <li key={`${problem.code}:${problem.name}`}>{t(`problem.${problem.code}`, { name: problem.name })}</li>
        ))}
      </ul>
    </div>
  );
}
