// Drafts from a sheet (#586): the member picks a CSV or Excel file, sees every row with its problems and each channel's
// rule issues, and creates drafts (or sends them to review) for the rows that are ready. Nothing is published here.
// Images, alt texts, labels and a first comment (#1258): the rows' file names are looked up in the library and their
// image URLs fetched into it by the server (never by the browser) before anything is created, so a bad URL, a file too
// large or not an image, an unknown file or one outside the member's channels shows on its row first.
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { SOCIAL_MEDIA_URLS_MAX } from '@crove/kernel-contract';
import { COMMENT_RULES, isProvider } from '@crove/mod-social/contract';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { TableCell, TableRow } from '@crove/ui/components/table';
import { Thumb } from '../components/social-media.tsx';
import { DataTable, ErrorText, PageHeader, Spinner } from '../components/ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';
import { MAX_STATEMENT_BYTES, readStatementFile } from '../lib/bank-statement.ts';
import { draftIssues, providerName } from '../lib/social.ts';
import type { SheetRows } from '../lib/xlsx.ts';
import { IMPORT_TEMPLATE, importRows, lookupKey, MAX_IMPORT_ROWS, newLabels, pendingRefs, withMedia, type ImportRow, type MediaLookup } from '../lib/social-import.ts';

// File names asked for at once (social.media.resolve), and tries of a batch of URLs while the server is busy.
const RESOLVE_BATCH = 200;
const BUSY_TRIES = 5;
// Lookups worth asking again: the server was busy, or the image host did not answer.
const TRANSIENT = new Set(['MEDIA_URL_BUSY', 'MEDIA_URL_UNREACHABLE']);

const batches = <T,>(list: readonly T[], size: number): T[][] => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// A batch of URLs fetched by the server, waiting while it says it is busy with other members' images.
async function fetchUrls(urls: string[]) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await client.social.media.fetchUrls({ urls });
    } catch (error) {
      const refusal = error as { code?: unknown; data?: { retryAfterSeconds?: unknown } };
      if (refusal.code !== 'MEDIA_URLS_BUSY' || attempt >= BUSY_TRIES) throw error;
      await pause((typeof refusal.data?.retryAfterSeconds === 'number' ? refusal.data.retryAfterSeconds : 5) * 1000);
    }
  }
}

export function SocialImportPage() {
  const { slug } = useParams({ strict: false }) as { slug: string };
  const t = useTranslations('social');
  const f = useFormat();
  const navigate = useNavigate();
  const channels = useQuery(orpc.channels.list.queryOptions({ input: {} }));
  // Each channel's signature (#1190), which the import adds to every draft on it: the checks count it, so the rows
  // wait for it as they wait for the channels.
  const policies = useQuery(orpc.social.policies.list.queryOptions({ input: {} }));
  const signatures = new Map((policies.data ?? []).map((p) => [p.connectionId, p.signature]));
  // The org's labels (#639), so a row's new label names are said before they are created.
  const labels = useQuery(orpc.social.labels.list.queryOptions({ input: {} }));
  // The sheet as read; its rows are worked out against the channels, again whenever those load or change.
  const [sheet, setSheet] = useState<SheetRows | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const loading = channels.isLoading || policies.isPending || labels.isPending;
  const rows = useMemo<ImportRow[] | null>(() => (sheet && channels.data && !loading ? importRows(sheet, channels.data) : null), [sheet, channels.data, loading]);
  const tooMany = rows !== null && rows.length > MAX_IMPORT_ROWS;
  const headerMissing = sheet !== null && channels.data !== undefined && !loading && rows === null;
  // One key per set of rows sent: a retry after a lost answer returns the first import.
  const attempt = useRef<{ key: string; payload: string } | null>(null);
  const byId = new Map((channels.data ?? []).map((c) => [c.id, c]));

  // What the server answered for each file name and URL, kept while the page is open (the same file picked again
  // after a fix is not fetched again).
  const [lookups, setLookups] = useState<ReadonlyMap<string, MediaLookup>>(new Map());
  const [checkError, setCheckError] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  const checking = useRef(false);
  const pending = useMemo(() => (rows && !tooMany ? pendingRefs(rows, lookups) : { files: [], urls: [] }), [rows, tooMany, lookups]);
  useEffect(() => {
    if (checking.current || checkError !== null || (pending.files.length === 0 && pending.urls.length === 0)) return;
    checking.current = true;
    const keep = (answers: { key: string; lookup: MediaLookup }[]) =>
      setLookups((before) => {
        const next = new Map(before);
        for (const a of answers) next.set(a.key, a.lookup);
        return next;
      });
    void (async () => {
      try {
        for (const refs of batches(pending.files, RESOLVE_BATCH)) {
          const answer = await client.social.media.resolve({ refs });
          keep(answer.map((a) => ({ key: lookupKey({ kind: 'file', ref: a.ref }), lookup: { file: a.file, problem: a.problem } })));
        }
        for (const urls of batches(pending.urls, SOCIAL_MEDIA_URLS_MAX)) {
          const { results } = await fetchUrls(urls);
          keep(results.map((r) => ({ key: lookupKey({ kind: 'url', ref: r.url }), lookup: { file: r.file, problem: r.problem } })));
        }
      } catch (error) {
        setCheckError(errorMessage(error));
      } finally {
        checking.current = false;
        // Rows read meanwhile may name more.
        setRound((n) => n + 1);
      }
    })();
  }, [pending, checkError, round]);
  const checkAgain = () => {
    setCheckError(null);
    setLookups((before) => new Map([...before].filter(([, l]) => !(l.problem && TRANSIENT.has(l.problem)))));
  };

  // The labels the import creates, and the rows that would need one past the org's limit.
  const created = useMemo(() => newLabels(rows ?? [], (labels.data ?? []).map((l) => l.name)), [rows, labels.data]);
  // Each row with its files as found and every problem; a row is ready when nothing is wrong or still being checked.
  const checked = (rows ?? []).map((r) => {
    const media = withMedia(r, lookups);
    const problems = created.overLimit.has(r.row) ? [...media.problems, { code: 'LABEL_LIMIT' as const }] : media.problems;
    return { row: r, files: media.files, problems, pending: media.pending };
  });
  // The first comment goes on the channels that take one (as the composer offers it); the others are told.
  const takesComment = (provider: string) => isProvider(provider) && COMMENT_RULES[provider] !== undefined;
  const issuesOf = (c: (typeof checked)[number]) =>
    c.row.connectionIds.flatMap((id) => {
      const channel = byId.get(id);
      if (!channel) return [];
      // The title goes to every channel, as the import sends it: one without titles says so.
      const signature = signatures.get(id);
      const settings = { ...(signature ? { signature } : {}), ...(c.row.firstComment && takesComment(channel.provider) ? { firstComment: c.row.firstComment } : {}) };
      return draftIssues(channel.provider, { body: c.row.body, title: c.row.title || null, linkUrl: c.row.link || null, media: c.files, settings }).map((i) => ({ channel, issue: i }));
    });
  const ready = tooMany ? [] : checked.filter((c) => c.problems.length === 0 && !c.pending);
  const stillChecking = !tooMany && checked.some((c) => c.pending) && checkError === null;
  const fromUrls = (rows ?? []).some((r) => r.media.some((m) => m.kind === 'url'));
  const transient = checkError !== null || [...lookups.values()].some((l) => l.problem && TRANSIENT.has(l.problem));

  const pick = async (input: HTMLInputElement) => {
    const file = input.files?.[0];
    // The same file picked again (fixed and saved) is read again.
    input.value = '';
    setFileError(null);
    setSheet(null);
    if (!file) return;
    if (file.size > MAX_STATEMENT_BYTES) return setFileError(t('import.tooBig'));
    try {
      setSheet(await readStatementFile(new Uint8Array(await file.arrayBuffer()), file.name));
    } catch {
      setFileError(t('import.unreadable'));
    }
  };
  const create = useMutation({
    mutationFn: (submit: boolean) => {
      const posts = ready.map(({ row: r, files }) => ({
        body: r.body,
        title: r.title || null,
        linkUrl: r.link || null,
        ...(r.plannedAt ? { scheduledAt: r.plannedAt } : {}),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        connectionIds: r.connectionIds,
        ...(files.length > 0 ? { media: files.map((file) => ({ fileId: file.fileId, altText: file.altText })) } : {}),
        ...(r.labels.length > 0 ? { labels: r.labels } : {}),
        ...(r.firstComment ? { firstComment: r.firstComment } : {}),
      }));
      const payload = JSON.stringify({ submit, posts });
      if (attempt.current?.payload !== payload) attempt.current = { key: crypto.randomUUID(), payload };
      return client.social.posts.import({ submit, posts, idempotencyKey: attempt.current.key });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries();
      void navigate({ to: '/o/$slug/social', params: { slug } });
    },
  });
  const template = () => {
    const url = URL.createObjectURL(new Blob([IMPORT_TEMPLATE], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'crove-social-mau.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  return (
    <>
      <PageHeader
        title={t('import.title')}
        subtitle={t('import.subtitle')}
        actions={
          <Link to="/o/$slug/social" params={{ slug }} className="inline-flex h-9 items-center px-2.5 text-sm text-muted-foreground hover:text-foreground">
            {t('back')}
          </Link>
        }
      />
      <Card className="mb-4 block space-y-3 p-4">
        <p className="text-sm text-muted-foreground">{t('import.howTo')}</p>
        <p className="text-sm text-muted-foreground">{t('import.howToMedia')}</p>
        <div className="flex flex-wrap items-center gap-2">
          <input type="file" accept=".csv,.xlsx,text/csv" aria-label={t('import.pick')} onChange={(e) => void pick(e.currentTarget)} className="text-sm" />
          <Button variant="ghost" size="sm" onClick={template}>
            {t('import.template')}
          </Button>
        </div>
        {fileError && <ErrorText>{fileError}</ErrorText>}
        {headerMissing && <ErrorText>{t('import.noHeader')}</ErrorText>}
        {tooMany && <ErrorText>{t('import.tooMany', { max: MAX_IMPORT_ROWS })}</ErrorText>}
        {sheet && loading && <Spinner />}
      </Card>
      {rows && !tooMany && (
        <div className="space-y-3">
          <p className="text-sm text-foreground">{t('import.summary', { ready: ready.length, total: rows.length })}</p>
          {stillChecking && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
              <Spinner /> {t('import.checkingMedia')}
            </p>
          )}
          {fromUrls && <p className="text-xs text-subtle-foreground">{t('import.urlHint')}</p>}
          {created.names.length > 0 && <p className="text-xs text-subtle-foreground">{t('import.newLabels', { count: created.names.length, names: created.names.join(', ') })}</p>}
          {checkError && <ErrorText>{checkError}</ErrorText>}
          {transient && !stillChecking && (
            <Button variant="outline" size="sm" onClick={checkAgain}>
              {t('import.checkAgain')}
            </Button>
          )}
          <DataTable head={[t('import.row'), t('import.text'), t('import.channels'), t('import.media'), t('import.time'), t('import.problems')]}>
            {checked.map((c) => {
              const r = c.row;
              const issues = issuesOf(c);
              const noComment = r.firstComment ? r.connectionIds.map((id) => byId.get(id)).filter((ch) => ch && !takesComment(ch.provider)) : [];
              return (
                <TableRow key={r.row}>
                  <TableCell className="px-4 py-3 align-top font-mono text-xs tabular-nums">{r.row}</TableCell>
                  <TableCell className="max-w-80 px-4 py-3 align-top">
                    {r.title && <p className="text-sm font-medium text-foreground">{r.title}</p>}
                    <p className="line-clamp-3 text-sm [overflow-wrap:anywhere] text-foreground">{r.body}</p>
                    {r.link && <p className="truncate font-mono text-xs text-subtle-foreground">{r.link}</p>}
                    {r.firstComment && <p className="line-clamp-2 text-xs [overflow-wrap:anywhere] text-muted-foreground">{t('import.firstComment', { text: r.firstComment })}</p>}
                    {r.labels.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {r.labels.map((name) => (
                          <Badge key={name} variant="secondary">
                            {name}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="px-4 py-3 align-top">
                    <div className="flex flex-wrap gap-1">
                      {r.connectionIds.map((id) => (
                        <Badge key={id} variant="outline">
                          {byId.get(id)?.displayName ?? id} · {providerName(byId.get(id)?.provider ?? '')}
                        </Badge>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell className="px-4 py-3 align-top">
                    {r.media.length === 0 ? (
                      <span className="text-xs text-subtle-foreground">-</span>
                    ) : (
                      <ul className="flex flex-wrap gap-1" aria-label={t('import.mediaOf', { row: r.row })}>
                        {c.files.map((file) => (
                          <li key={file.fileId} title={file.altText ? `${file.filename}: ${file.altText}` : file.filename}>
                            <Thumb fileId={file.fileId} alt={file.altText ?? file.filename} name={file.filename} mime={file.mime} className="size-10" />
                          </li>
                        ))}
                      </ul>
                    )}
                    {r.media.length > 0 && <p className="mt-1 text-xs text-subtle-foreground tabular-nums">{t('import.mediaCount', { found: c.files.length, total: r.media.length })}</p>}
                  </TableCell>
                  <TableCell className="px-4 py-3 align-top text-xs">{r.plannedAt ? f.dateTime(r.plannedAt) : '-'}</TableCell>
                  <TableCell className="px-4 py-3 align-top text-xs">
                    {c.problems.length === 0 && !c.pending && issues.length === 0 && <span className="text-success">{t('import.ok')}</span>}
                    {c.pending && c.problems.length === 0 && <span className="text-muted-foreground">{t('import.checkingRow')}</span>}
                    {c.problems.map((p, i) => (
                      <p key={`p${i}`} className="[overflow-wrap:anywhere] text-destructive">
                        {t(`import.problem.${p.code}`, { value: p.value ?? '' })}
                      </p>
                    ))}
                    {issues.map(({ channel, issue }, i) => (
                      <p key={`i${i}`} className="text-warning">
                        {channel.displayName}: {t(`issues.${issue.code}`, { limit: issue.limit ?? 0, actual: issue.actual ?? 0, n: Number(issue.field.split('.')[1] ?? 0) + 1 })}
                      </p>
                    ))}
                    {noComment.map((ch) => (
                      <p key={`c${ch?.id}`} className="text-muted-foreground">
                        {t('import.commentSkipped', { channel: ch?.displayName ?? '' })}
                      </p>
                    ))}
                  </TableCell>
                </TableRow>
              );
            })}
          </DataTable>
          <p className="text-xs text-subtle-foreground">{t('import.issuesHint')}</p>
          {create.error && <ErrorText>{errorMessage(create.error)}</ErrorText>}
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="lg" disabled={ready.length === 0 || create.isPending || stillChecking} onClick={() => create.mutate(false)}>
              {t('import.createDrafts', { count: ready.length })}
            </Button>
            <Button size="lg" disabled={ready.length === 0 || create.isPending || stillChecking} onClick={() => create.mutate(true)}>
              {t('import.createAndSubmit', { count: ready.length })}
            </Button>
          </div>
        </div>
      )}
    </>
  );
}
