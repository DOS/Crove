// Drafts from a sheet (#586): the member picks a CSV or Excel file, sees every row with its problems and each channel's
// rule issues, and creates drafts (or sends them to review) for the rows that are ready. Nothing is published here.
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useMemo, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { TableCell, TableRow } from '@crove/ui/components/table';
import { DataTable, ErrorText, PageHeader, Spinner } from '../components/ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';
import { MAX_STATEMENT_BYTES, readStatementFile } from '../lib/bank-statement.ts';
import { draftIssues, providerName } from '../lib/social.ts';
import type { SheetRows } from '../lib/xlsx.ts';
import { IMPORT_TEMPLATE, importRows, MAX_IMPORT_ROWS, type ImportRow } from '../lib/social-import.ts';

export function SocialImportPage() {
  const { slug } = useParams({ strict: false }) as { slug: string };
  const t = useTranslations('social');
  const f = useFormat();
  const navigate = useNavigate();
  const channels = useQuery(orpc.channels.list.queryOptions({ input: {} }));
  // The sheet as read; its rows are worked out against the channels, again whenever those load or change.
  const [sheet, setSheet] = useState<SheetRows | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const rows = useMemo<ImportRow[] | null>(() => (sheet && channels.data ? importRows(sheet, channels.data) : null), [sheet, channels.data]);
  const tooMany = rows !== null && rows.length > MAX_IMPORT_ROWS;
  const headerMissing = sheet !== null && channels.data !== undefined && rows === null;
  // One key per set of rows sent: a retry after a lost answer returns the first import.
  const attempt = useRef<{ key: string; payload: string } | null>(null);
  const byId = new Map((channels.data ?? []).map((c) => [c.id, c]));
  // A row is ready when the sheet gave it no problem and every channel takes it as it is.
  const issuesOf = (r: ImportRow) =>
    r.connectionIds.flatMap((id) => {
      const c = byId.get(id);
      // The title goes to every channel, as the import sends it: one without titles says so.
      return c ? draftIssues(c.provider, { body: r.body, title: r.title || null, linkUrl: r.link || null }).map((i) => ({ channel: c, issue: i })) : [];
    });
  const ready = tooMany ? [] : (rows ?? []).filter((r) => r.problems.length === 0);

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
      const posts = ready.map((r) => ({
          body: r.body,
          title: r.title || null,
          linkUrl: r.link || null,
          ...(r.plannedAt ? { scheduledAt: r.plannedAt } : {}),
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          connectionIds: r.connectionIds,
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
        <div className="flex flex-wrap items-center gap-2">
          <input type="file" accept=".csv,.xlsx,text/csv" aria-label={t('import.pick')} onChange={(e) => void pick(e.currentTarget)} className="text-sm" />
          <Button variant="ghost" size="sm" onClick={template}>
            {t('import.template')}
          </Button>
        </div>
        {fileError && <ErrorText>{fileError}</ErrorText>}
        {headerMissing && <ErrorText>{t('import.noHeader')}</ErrorText>}
        {tooMany && <ErrorText>{t('import.tooMany', { max: MAX_IMPORT_ROWS })}</ErrorText>}
        {sheet && channels.isLoading && <Spinner />}
      </Card>
      {rows && !tooMany && (
        <div className="space-y-3">
          <p className="text-sm text-foreground">{t('import.summary', { ready: ready.length, total: rows.length })}</p>
          <DataTable head={[t('import.row'), t('import.text'), t('import.channels'), t('import.time'), t('import.problems')]}>
            {rows.map((r) => {
              const issues = issuesOf(r);
              return (
                <TableRow key={r.row}>
                  <TableCell className="px-4 py-3 align-top font-mono text-xs tabular-nums">{r.row}</TableCell>
                  <TableCell className="max-w-80 px-4 py-3 align-top">
                    {r.title && <p className="text-sm font-medium text-foreground">{r.title}</p>}
                    <p className="line-clamp-3 text-sm [overflow-wrap:anywhere] text-foreground">{r.body}</p>
                    {r.link && <p className="truncate font-mono text-xs text-subtle-foreground">{r.link}</p>}
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
                  <TableCell className="px-4 py-3 align-top text-xs">{r.plannedAt ? f.dateTime(r.plannedAt) : '-'}</TableCell>
                  <TableCell className="px-4 py-3 align-top text-xs">
                    {r.problems.length === 0 && issues.length === 0 && <span className="text-success">{t('import.ok')}</span>}
                    {r.problems.map((p, i) => (
                      <p key={`p${i}`} className="text-destructive">
                        {t(`import.problem.${p.code}`, { value: p.value ?? '' })}
                      </p>
                    ))}
                    {issues.map(({ channel, issue }, i) => (
                      <p key={`i${i}`} className="text-warning">
                        {channel.displayName}: {t(`issues.${issue.code}`, { limit: issue.limit ?? 0, actual: issue.actual ?? 0 })}
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
            <Button variant="outline" size="lg" disabled={ready.length === 0 || create.isPending} onClick={() => create.mutate(false)}>
              {t('import.createDrafts', { count: ready.length })}
            </Button>
            <Button size="lg" disabled={ready.length === 0 || create.isPending} onClick={() => create.mutate(true)}>
              {t('import.createAndSubmit', { count: ready.length })}
            </Button>
          </div>
        </div>
      )}
    </>
  );
}