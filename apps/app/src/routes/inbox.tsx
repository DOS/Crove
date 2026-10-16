import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useRef, useState, type DragEvent } from 'react';
import { useTranslations } from 'use-intl';
import { Badge, Button, Card, Empty, ErrorText, PageHeader, Spinner, Table, cx } from '../components/ui.tsx';
import { errorMessage, orpc, queryClient, uploadFiles } from '../lib/api.ts';
import { getConfig } from '../lib/auth.ts';
import { useFormat } from '../i18n/provider.tsx';

type Tab = 'pending' | 'executed' | 'rejected';

const TABS: Tab[] = ['pending', 'executed', 'rejected'];

const FILE_STATUS = { processing: 'brand', proposed: 'good', duplicate: 'warn', failed: 'bad' } as const;
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
  const files = useQuery({
    ...orpc.files.recent.queryOptions(),
    refetchInterval: (query) => ((query.state.data ?? []).some((f) => f.status === 'processing') ? 2000 : 30_000),
  });
  const items = useQuery({ ...orpc.inbox.list.queryOptions({ input: { status: tab } }), refetchInterval: 5000 });

  const upload = useMutation({
    mutationFn: uploadFiles,
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
          <Button variant="primary" onClick={() => inputRef.current?.click()} disabled={upload.isPending}>
            {upload.isPending ? <Spinner /> : null}
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
          className={cx(
            'flex flex-col items-center justify-center rounded-xl border border-dashed px-6 py-8 text-center transition-colors lg:col-span-2',
            dragging ? 'border-brand-500 bg-brand-600/10' : 'border-line bg-surface',
          )}
        >
          <p className="text-sm font-medium text-fg">{t('dropHere')}</p>
          <p className="mt-1 text-xs text-fg-3">{config.aiEnabled ? t('formatsAll') : t('formatsXml')}</p>
          {!config.aiEnabled && (
            <p className="mt-3 text-xs text-amber-300">{t('noAi')}</p>
          )}
          {upload.error && (
            <div className="mt-3">
              <ErrorText>{errorMessage(upload.error)}</ErrorText>
            </div>
          )}
        </div>
        <Card className="p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-fg-3">{t('forwardTitle')}</p>
          {org.isLoading ? (
            <div className="mt-3">
              <Spinner />
            </div>
          ) : org.data?.inboundAddress ? (
            <>
              <p className="mt-2 break-all font-mono text-sm text-fg">{org.data.inboundAddress}</p>
              <Button className="mt-3" onClick={() => void navigator.clipboard.writeText(org.data?.inboundAddress ?? '')}>
                {t('copyAddress')}
              </Button>
            </>
          ) : (
            <p className="mt-2 text-sm text-fg-2">{t('noInbound')}</p>
          )}
        </Card>
      </div>

      {(files.data?.length ?? 0) > 0 && (
        <div className="mt-6">
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-fg-3">
            {t('recentFiles')}{' '}
            {processing > 0 && <span className="ml-1 normal-case text-brand-300">· {t('readingCount', { count: processing })}</span>}
          </p>
          <div className="flex flex-wrap gap-2">
            {files.data?.slice(0, 8).map((file) => (
              <span
                key={file.id}
                className="inline-flex max-w-full items-center gap-2 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-xs"
                title={file.error ?? undefined}
              >
                <span className="max-w-[16rem] truncate text-fg-2">{file.filename}</span>
                <Badge tone={isFileStatus(file.status) ? FILE_STATUS[file.status] : 'neutral'}>
                  {isFileStatus(file.status) ? t(`fileStatus.${file.status}`) : file.status}
                </Badge>
                {file.status === 'failed' && file.canReextract && (
                  <button
                    type="button"
                    disabled={reextract.isPending}
                    className="text-brand-300 hover:underline disabled:opacity-50"
                    onClick={() => reextract.mutate({ fileId: file.id, idempotencyKey: crypto.randomUUID() })}
                  >
                    {t('reread')}
                  </button>
                )}
              </span>
            ))}
          </div>
          {reextract.error && <p className="mt-2 text-xs text-rose-300">{errorMessage(reextract.error)}</p>}
          {files.data?.find((file) => file.status === 'failed')?.error && (
            <p className="mt-2 text-xs text-rose-300">{files.data.find((file) => file.status === 'failed')?.error}</p>
          )}
        </div>
      )}

      <div className="mt-8 flex gap-1 border-b border-line">
        {TABS.map((id) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={cx('-mb-px border-b-2 px-3 py-2 text-sm', tab === id ? 'border-brand-500 text-fg' : 'border-transparent text-fg-3 hover:text-fg-2')}
          >
            {t(`tabs.${id}`)}
          </button>
        ))}
      </div>

      <div className="mt-4">
        {items.isLoading ? (
          <Spinner />
        ) : (items.data?.length ?? 0) === 0 ? (
          <Empty title={tab === 'pending' ? t('emptyPending') : t('emptyOther')} hint={tab === 'pending' ? t('emptyPendingHint') : undefined} />
        ) : (
          <Table head={[t('columns.document'), t('columns.issueDate'), t('columns.total'), t('columns.checks'), t('columns.received')]}>
            {items.data?.map((item) => (
              <tr key={item.id} className="hover:bg-surface-2">
                <td className="px-4 py-3">
                  <Link to="/o/$slug/inbox/$id" params={{ slug, id: item.id }} className="font-medium text-fg hover:text-brand-300">
                    {item.sellerName ?? item.title}
                  </Link>
                  <p className="text-xs text-fg-3">{item.title}</p>
                </td>
                <td className="px-4 py-3 text-fg-2">{f.date(item.issueDate)}</td>
                <td className="tabular px-4 py-3 text-fg">{f.money(item.total)}</td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap gap-1">
                    {item.duplicateOf && <Badge tone="warn">{t('maybeDuplicate')}</Badge>}
                    {item.failedChecks > 0 && <Badge tone="bad">{t('failedChecks', { count: item.failedChecks })}</Badge>}
                    {item.warnChecks > 0 && <Badge tone="warn">{t('warnChecks', { count: item.warnChecks })}</Badge>}
                    {item.failedChecks === 0 && item.warnChecks === 0 && !item.duplicateOf && <Badge tone="good">{t('matched')}</Badge>}
                  </div>
                </td>
                <td className="px-4 py-3 text-xs text-fg-3">{f.dateTime(item.createdAt)}</td>
              </tr>
            ))}
          </Table>
        )}
      </div>
    </>
  );
}
