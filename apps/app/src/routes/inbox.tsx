import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useRef, useState, type DragEvent } from 'react';
import { useTranslations } from 'use-intl';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { TableCell, TableRow } from '@crove/ui/components/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@crove/ui/components/tabs';
import { cn } from '@crove/ui/lib/utils';
import { DataTable, Empty, ErrorText, PageHeader, Spinner } from '../components/ui.tsx';
import { errorMessage, orpc, queryClient, uploadFiles } from '../lib/api.ts';
import { getConfig } from '../lib/auth.ts';
import { useFormat } from '../i18n/provider.tsx';
import { REVERSAL_KIND } from '../lib/reversal.ts';
import { SAFETY_POLL_MS, pollEvery, useStreamLive } from '../lib/stream-hook.ts';

type Tab = 'pending' | 'executed' | 'rejected';

const TABS: Tab[] = ['pending', 'executed', 'rejected'];

const FILE_STATUS = { processing: 'brand', proposed: 'success', duplicate: 'warning', failed: 'destructive' } as const;
type FileStatus = keyof typeof FILE_STATUS;

function isFileStatus(status: string): status is FileStatus {
  return Object.hasOwn(FILE_STATUS, status);
}

export function InboxPage() {
  const { slug } = useParams({ strict: false }) as { slug: string };
  const t = useTranslations('inbox');
  const f = useFormat();
  const [tab, setTab] = useState<Tab>('pending');
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const config = getConfig();

  const org = useQuery(orpc.org.get.queryOptions());
  // Polled only while the invalidation stream is down; with it, hints refresh them and a slow poll is the safety net.
  const live = useStreamLive();
  const files = useQuery({
    ...orpc.files.recent.queryOptions(),
    refetchInterval: (query) => pollEvery(live, (query.state.data ?? []).some((f) => f.status === 'processing') ? 2000 : 30_000, SAFETY_POLL_MS),
  });
  const items = useQuery({ ...orpc.inbox.list.queryOptions({ input: { status: tab } }), refetchInterval: pollEvery(live, 5000, SAFETY_POLL_MS) });

  const upload = useMutation({
    mutationFn: (files: File[]) => uploadFiles(files),
    onSuccess: () => void queryClient.invalidateQueries(),
  });
  // Reads a file that could not be read again (for example after AI was configured).
  const reextract = useMutation(orpc.files.reextract.mutationOptions({ onSuccess: () => void queryClient.invalidateQueries() }));

  function onDrop(event: DragEvent) {
    event.preventDefault();
    setDragging(false);
    const dropped = [...event.dataTransfer.files];
    if (dropped.length) upload.mutate(dropped);
  }

  const processing = (files.data ?? []).filter((f) => f.status === 'processing').length;

  return (
    <>
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        actions={
          <Button size="lg" onClick={() => inputRef.current?.click()} disabled={upload.isPending}>
            {upload.isPending ? <Spinner className="text-current" /> : null}
            {t('upload')}
          </Button>
        }
      />
      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        accept=".xml,.pdf,image/jpeg,image/png,image/webp"
        onChange={(e) => {
          const chosen = [...(e.target.files ?? [])];
          if (chosen.length) upload.mutate(chosen);
          e.target.value = '';
        }}
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={cn(
            'flex flex-col items-center justify-center rounded-xl border border-dashed px-6 py-8 text-center transition-colors lg:col-span-2',
            dragging ? 'border-ring bg-primary/10' : 'bg-card',
          )}
        >
          <p className="text-sm font-medium text-foreground">{t('dropHere')}</p>
          <p className="mt-1 text-xs text-subtle-foreground">{config.aiEnabled ? t('formatsAll') : t('formatsXml')}</p>
          {!config.aiEnabled && (
            <p className="mt-3 text-xs text-warning">{t('noAi')}</p>
          )}
          {upload.error && (
            <div className="mt-3">
              <ErrorText>{errorMessage(upload.error)}</ErrorText>
            </div>
          )}
        </div>
        <Card className="block p-4">
          <p className="text-xs font-medium tracking-wide text-subtle-foreground uppercase">{t('forwardTitle')}</p>
          {org.isLoading ? (
            <div className="mt-3">
              <Spinner />
            </div>
          ) : org.data?.inboundAddress ? (
            <>
              <p className="mt-2 font-mono text-sm break-all text-foreground">{org.data.inboundAddress}</p>
              <Button variant="outline" size="lg" className="mt-3" onClick={() => void navigator.clipboard.writeText(org.data?.inboundAddress ?? '')}>
                {t('copyAddress')}
              </Button>
            </>
          ) : (
            <p className="mt-2 text-sm text-muted-foreground">{t('noInbound')}</p>
          )}
        </Card>
      </div>

      {(files.data?.length ?? 0) > 0 && (
        <div className="mt-6">
          <p className="mb-2 text-xs font-medium tracking-wide text-subtle-foreground uppercase">
            {t('recentFiles')}{' '}
            {processing > 0 && <span className="ml-1 text-link normal-case">· {t('readingCount', { count: processing })}</span>}
          </p>
          <div className="flex flex-wrap gap-2">
            {files.data?.slice(0, 8).map((file) => (
              <span
                key={file.id}
                className="inline-flex max-w-full items-center gap-2 rounded-lg border bg-card px-2.5 py-1.5 text-xs"
                title={file.error ?? undefined}
              >
                <span className="max-w-[16rem] truncate text-muted-foreground">{file.filename}</span>
                <Badge variant={isFileStatus(file.status) ? FILE_STATUS[file.status] : 'secondary'}>
                  {isFileStatus(file.status) ? t(`fileStatus.${file.status}`) : file.status}
                </Badge>
                {file.status === 'failed' && file.canReextract && (
                  <button
                    type="button"
                    disabled={reextract.isPending}
                    className="text-link hover:underline disabled:opacity-50"
                    onClick={() => reextract.mutate({ fileId: file.id, idempotencyKey: crypto.randomUUID() })}
                  >
                    {t('reread')}
                  </button>
                )}
              </span>
            ))}
          </div>
          {reextract.error && <p className="mt-2 text-xs text-destructive">{errorMessage(reextract.error)}</p>}
          {files.data?.find((file) => file.status === 'failed')?.error && (
            <p className="mt-2 text-xs text-destructive">{files.data.find((file) => file.status === 'failed')?.error}</p>
          )}
        </div>
      )}

      <Tabs className="mt-8 gap-4" value={tab} onValueChange={(value) => setTab(value as Tab)}>
        <TabsList variant="line" className="w-full justify-start border-b">
          {TABS.map((id) => (
            <TabsTrigger key={id} value={id} className="flex-none px-3">
              {t(`tabs.${id}`)}
            </TabsTrigger>
          ))}
        </TabsList>

      <TabsContent value={tab}>
        {items.isLoading ? (
          <Spinner />
        ) : (items.data?.length ?? 0) === 0 ? (
          <Empty
            title={tab === 'pending' ? t('emptyPending') : t('emptyOther')}
            hint={tab === 'pending' ? t('emptyPendingHint') : undefined}
            action={
              tab === 'pending' && config.modules.includes('finance') ? (
                <Link to="/o/$slug/guide" params={{ slug }} className="text-sm text-link hover:underline">
                  {t('guideLink')}
                </Link>
              ) : undefined
            }
          />
        ) : (
          <DataTable head={[t('columns.document'), t('columns.issueDate'), t('columns.total'), t('columns.checks'), t('columns.received')]}>
            {items.data?.map((item) => (
              <TableRow key={item.id}>
                <TableCell className="px-4 py-3">
                  <Link to="/o/$slug/inbox/$id" params={{ slug, id: item.id }} className="font-medium text-foreground hover:text-link">
                    {item.sellerName ?? item.title}
                  </Link>
                  <p className="text-xs text-subtle-foreground">{item.title}</p>
                </TableCell>
                <TableCell className="px-4 py-3 text-muted-foreground">{f.date(item.issueDate)}</TableCell>
                <TableCell className="px-4 py-3 text-foreground tabular-nums">{f.money(item.total)}</TableCell>
                <TableCell className="px-4 py-3">
                  <div className="flex flex-wrap gap-1">
                    {/* A reversal a user asked for has no invoice checks; its card shows the entry it reverses. */}
                    {item.kind === REVERSAL_KIND && <Badge variant="secondary">{t('reversalKind')}</Badge>}
                    {item.duplicateOf && <Badge variant="warning">{t('maybeDuplicate')}</Badge>}
                    {item.failedChecks > 0 && <Badge variant="destructive">{t('failedChecks', { count: item.failedChecks })}</Badge>}
                    {item.warnChecks > 0 && <Badge variant="warning">{t('warnChecks', { count: item.warnChecks })}</Badge>}
                    {item.kind !== REVERSAL_KIND && item.failedChecks === 0 && item.warnChecks === 0 && !item.duplicateOf && (
                      <Badge variant="success">{t('matched')}</Badge>
                    )}
                  </div>
                </TableCell>
                <TableCell className="px-4 py-3 text-xs text-subtle-foreground">{f.dateTime(item.createdAt)}</TableCell>
              </TableRow>
            ))}
          </DataTable>
        )}
      </TabsContent>
      </Tabs>
    </>
  );
}
