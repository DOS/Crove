import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useRef, useState, type DragEvent } from 'react';
import { useTranslations } from 'use-intl';
import { JOURNAL_VOUCHER_KIND } from '@crove/kernel-contract';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Checkbox } from '@crove/ui/components/checkbox';
import { Label } from '@crove/ui/components/label';
import { TableCell, TableRow } from '@crove/ui/components/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@crove/ui/components/tabs';
import { cn } from '@crove/ui/lib/utils';
import { IntakePanel, useIntake } from '../components/intake.tsx';
import { StepUpPrompt } from '../components/two-factor.tsx';
import { DataTable, Empty, ErrorText, PageHeader, Spinner } from '../components/ui.tsx';
import { client, errorMessage, isStepUpRequired, orpc, queryClient } from '../lib/api.ts';
import { getConfig } from '../lib/auth.ts';
import { useFormat } from '../i18n/provider.tsx';
import { REVERSAL_KIND } from '../lib/reversal.ts';
import { providerName } from '../lib/social.ts';
import { VOUCHER_KIND } from '../lib/vouchers.ts';
import { bulkSelectable, canApproveProposals, planBatches, proposalName, sendBatches, showMatched, type BulkBatch, type BulkProgress } from '../lib/review.ts';
import { SAFETY_POLL_MS, pollEvery, useStreamLive } from '../lib/stream-hook.ts';

// One bulk approval (issue #315): the batches planned when it started, how far it got, and the names to report.
interface BulkRun {
  batches: BulkBatch[];
  progress: BulkProgress;
  names: Readonly<Record<string, string>>;
  total: number;
  sending: boolean;
  // The approver closed the step-up prompt or the error: the batches not sent stay pending.
  stopped: boolean;
}

// Expired proposals (#876) waited past the org's expiry; their author may ask for them again.
type Tab = 'pending' | 'executed' | 'rejected' | 'expired';

const TABS: Tab[] = ['pending', 'executed', 'rejected', 'expired'];

const FILE_STATUS = { processing: 'brand', waiting: 'warning', proposed: 'success', duplicate: 'warning', failed: 'destructive', expanded: 'success' } as const;
type FileStatus = keyof typeof FILE_STATUS;

function isFileStatus(status: string): status is FileStatus {
  return Object.hasOwn(FILE_STATUS, status);
}

// Bank statement lines with no voucher yet, per bank account (#326, stage 2b): each links to its account and the month
// of its oldest open line on the bank screen, where its voucher is entered.
function OpenBankLines({ slug }: { slug: string }) {
  const t = useTranslations('inbox');
  const f = useFormat();
  const open = useQuery(orpc.bank.openLines.queryOptions());
  const accounts = (open.data?.accounts ?? []).filter((a) => a.open > 0);
  if (accounts.length === 0) return null;
  return (
    <Card className="mt-6 block p-4">
      <p className="text-sm font-medium text-foreground">{t('bankLines.title')}</p>
      <ul className="mt-2 space-y-1 text-sm">
        {accounts.map((a) => (
          <li key={a.bankAccount}>
            <Link to="/o/$slug/bank" params={{ slug }} search={{ account: a.bankAccount, month: a.oldest.slice(0, 7) }} className="text-link underline">
              {t('bankLines.account', { account: a.bankAccount, count: a.open, ambiguous: a.ambiguous, date: f.date(a.oldest) })}
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}

// The name a proposal goes by in the list, its checkbox and the bulk report: the customer of a sale (#313; its seller is
// the org itself), the seller of a purchase, else its title.
// Social posts waiting for the viewer's review (#749), where Social runs: each opens its post, where it is decided.
// Social work that needs a person (#771): channels to reconnect and posts that did not go out, each opening where it
// is fixed.
function SocialAttention({ slug }: { slug: string }) {
  const t = useTranslations('inbox.socialAttention');
  const live = useStreamLive();
  const attention = useQuery({ ...orpc.social.attentionInbox.queryOptions({ input: {} }), refetchInterval: pollEvery(live, 30_000, SAFETY_POLL_MS) });
  const data = attention.data;
  if (!data || data.total === 0) return null;
  const status = (s: string) => (s === 'failed' || s === 'needs_attention' || s === 'paused' ? t(`post.${s}`) : s);
  return (
    <Card className="mt-6 block p-4">
      <p className="text-sm font-medium text-foreground">{t('title', { count: data.total })}</p>
      <ul className="mt-2 divide-y text-sm">
        {data.channels.map((c) => (
          <li key={c.connectionId} className="py-2">
            <Link to="/o/$slug/social/channels" params={{ slug }} className="block text-foreground hover:underline">
              {t(`channel.${c.status}`, { channel: `${providerName(c.provider)} · ${c.displayName}` })}
            </Link>
          </li>
        ))}
        {data.posts.map((p) => (
          <li key={p.postId} className="py-2">
            <Link to="/o/$slug/social/$id" params={{ slug, id: p.postId }} className="block text-foreground hover:underline">
              {p.excerpt || t('noText')}
            </Link>
            <p className="text-xs text-warning">{p.channels.map((c) => `${providerName(c.provider)} · ${c.displayName}: ${status(c.status)}`).join(', ')}</p>
          </li>
        ))}
      </ul>
      {/* The total counts every post that needs a person; past the first 50, the Social home lists them all. */}
      {data.total > data.channels.length + data.posts.length && (
        <Link to="/o/$slug/social" params={{ slug }} className="mt-2 inline-block text-sm text-link underline">
          {t('more', { count: data.total - data.channels.length - data.posts.length })}
        </Link>
      )}
    </Card>
  );
}

function SocialReviews({ slug }: { slug: string }) {
  const t = useTranslations('inbox.socialReviews');
  const f = useFormat();
  const live = useStreamLive();
  const reviews = useQuery({ ...orpc.social.reviewInbox.queryOptions({ input: {} }), refetchInterval: pollEvery(live, 30_000, SAFETY_POLL_MS) });
  const items = reviews.data?.items ?? [];
  if (items.length === 0) return null;
  const more = (reviews.data?.total ?? 0) - items.length;
  return (
    <Card className="mt-6 block p-4">
      <p className="text-sm font-medium text-foreground">{t('title', { count: reviews.data?.total ?? items.length })}</p>
      <ul className="mt-2 divide-y text-sm">
        {items.map((item) => (
          <li key={item.postId} className="py-2">
            <Link to="/o/$slug/social/$id" params={{ slug, id: item.postId }} className="block text-foreground hover:underline">
              {item.title || item.excerpt || t('noText')}
            </Link>
            {item.title && item.excerpt && <p className="truncate text-xs text-muted-foreground">{item.excerpt}</p>}
            <p className="text-xs text-subtle-foreground">
              {item.channels.map((c) => `${providerName(c.provider)} · ${c.displayName}`).join(', ')}
              {item.at ? ` · ${t('goesOut', { when: f.dateTime(item.at) })}` : ` · ${t('noTime')}`}
            </p>
          </li>
        ))}
      </ul>
      {more > 0 && (
        <Link to="/o/$slug/social" params={{ slug }} className="mt-2 inline-block text-sm text-link underline">
          {t('more', { count: more })}
        </Link>
      )}
    </Card>
  );
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

  // Many documents or ZIP archives at once, each file uploaded and followed on its own (#314).
  const intake = useIntake();
  // Reads a file that could not be read again (for example after AI was configured).
  const reextract = useMutation(orpc.files.reextract.mutationOptions({ onSuccess: () => void queryClient.invalidateQueries() }));

  function onDrop(event: DragEvent) {
    event.preventDefault();
    setDragging(false);
    const dropped = [...event.dataTransfer.files];
    if (dropped.length) intake.start(dropped);
  }

  const processing = (files.data ?? []).filter((f) => f.status === 'processing').length;

  // Bulk approval (issue #315): owners and admins pick pending purchases and approve them under one step-up. The
  // kernel decides each item as if approved alone and reports the ones it refused.
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [bulk, setBulk] = useState<BulkRun | null>(null);
  const bulkEnabled = tab === 'pending' && canApproveProposals(org.data?.role);
  const selectable = bulkEnabled ? (items.data ?? []).filter((item) => bulkSelectable(item, REVERSAL_KIND)) : [];
  const chosen = selectable.filter((item) => selected.has(item.id));
  const sending = bulk?.sending ?? false;
  // Invoices whose digital signature is unverified (#674): approving them, in bulk as one by one, asks the approver to
  // confirm they checked the original invoice.
  // The confirmation names each unverified invoice and the revision it was given for, so a proposal selected (or read
  // again) after the box was ticked is not covered by it; only the confirmed ones are sent with the confirmation.
  const confirmKey = (item: { id: string; revision: number }) => `${item.id}:${item.revision}`;
  const unverifiedItems = chosen.filter((item) => item.signatureStatus === 'unverified');
  const unverifiedChosen = unverifiedItems.length;
  const [confirmedUnverified, setConfirmedUnverified] = useState<ReadonlySet<string>>(() => new Set());
  const confirmUnverified = unverifiedItems.every((item) => confirmedUnverified.has(confirmKey(item)));

  async function sendBulk(run: BulkRun) {
    setBulk({ ...run, sending: true, stopped: false, progress: { ...run.progress, error: null } });
    const progress = await sendBatches(
      run.batches,
      run.progress,
      (batch) => client.inbox.approveMany({ items: batch.items, idempotencyKey: batch.idempotencyKey }),
      (step) => setBulk((current) => (current ? { ...current, progress: step } : current)),
    );
    setBulk((current) => (current ? { ...current, progress, sending: false } : current));
    if (!progress.error) setSelected(new Set());
    await queryClient.invalidateQueries();
  }

  function startBulk() {
    if (chosen.length === 0 || sending || !confirmUnverified) return;
    const confirmed = confirmedUnverified;
    setConfirmedUnverified(new Set());
    void sendBulk({
      batches: planBatches(
        chosen.map((item) => ({
          id: item.id,
          revision: item.revision,
          ...(item.signatureStatus === 'unverified' && confirmed.has(confirmKey(item)) ? { acceptUnverifiedSignature: true } : {}),
        })),
      ),
      progress: { results: [], next: 0, error: null },
      names: Object.fromEntries(chosen.map((item) => [item.id, proposalName(item)])),
      total: chosen.length,
      sending: false,
      stopped: false,
    });
  }

  const stopBulk = () => setBulk((current) => (current ? { ...current, stopped: true, progress: { ...current.progress, error: null } } : current));
  const bulkError = bulk && !bulk.sending && !bulk.stopped ? bulk.progress.error : null;
  const bulkFinished = bulk && !bulk.sending && (bulk.stopped || bulk.progress.next === bulk.batches.length);
  const bulkApproved = bulk?.progress.results.filter((r) => r.outcome === 'approved').length ?? 0;
  const bulkRefused = bulk?.progress.results.flatMap((r) => (r.outcome === 'refused' ? [r] : [])) ?? [];
  const bulkNotSent = bulk ? bulk.total - bulk.progress.results.length : 0;

  const dropTarget = {
    onDragOver: (e: DragEvent) => {
      e.preventDefault();
      setDragging(true);
    },
    onDragLeave: () => setDragging(false),
    onDrop,
  };

  return (
    <>
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        actions={
          <Button size="lg" onClick={() => inputRef.current?.click()} disabled={intake.uploading}>
            {intake.uploading ? <Spinner className="text-current" /> : null}
            {t('upload')}
          </Button>
        }
      />
      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        accept=".xml,.pdf,.zip,application/zip,image/jpeg,image/png,image/webp"
        onChange={(e) => {
          const chosen = [...(e.target.files ?? [])];
          if (chosen.length) intake.start(chosen);
          e.target.value = '';
        }}
      />

      {/* The full welcome until the first file arrives; then one row (#1268), so the proposals sit near the top. */}
      {(files.data?.length ?? 0) > 0 ? (
        <div
          {...dropTarget}
          className={cn(
            'flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-dashed px-4 py-3 transition-colors',
            dragging ? 'border-ring bg-primary/10' : 'bg-card',
          )}
        >
          <div className="min-w-0">
            <p className="text-sm text-foreground">{t('dropHereCompact')}</p>
            <p className="text-xs text-subtle-foreground">{config.aiEnabled ? t('formatsAll') : t('formatsXml')}</p>
            {!config.aiEnabled && <p className="text-xs text-warning">{t('noAi')}</p>}
          </div>
          {org.data?.inboundAddress && (
            <div className="flex min-w-0 flex-wrap items-center gap-2 sm:ml-auto">
              <span className="text-xs text-subtle-foreground">{t('forwardTo')}</span>
              <span className="min-w-0 font-mono text-xs break-all text-foreground">{org.data.inboundAddress}</span>
              <Button variant="outline" size="sm" onClick={() => void navigator.clipboard.writeText(org.data?.inboundAddress ?? '')}>
                {t('copyAddress')}
              </Button>
            </div>
          )}
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-3">
          <div
            {...dropTarget}
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
            <p className="mt-1 text-xs text-subtle-foreground">{t('formatsZip')}</p>
          </div>
          <Card className="block p-4">
            <p className="text-sm font-medium text-muted-foreground">{t('forwardTitle')}</p>
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
      )}

      <IntakePanel intake={intake} />
      {config.modules.includes('finance') && <OpenBankLines slug={slug} />}
      {config.modules.includes('social') && <SocialAttention slug={slug} />}
      {config.modules.includes('social') && <SocialReviews slug={slug} />}

      {(files.data?.length ?? 0) > 0 && (
        <div className="mt-6">
          <p className="mb-2 text-sm font-medium text-muted-foreground">
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

      <Tabs
        className="mt-8 gap-4"
        value={tab}
        onValueChange={(value) => {
          setTab(value as Tab);
          setSelected(new Set());
        }}
      >
        <TabsList variant="line" className="w-full justify-start border-b">
          {TABS.map((id) => (
            <TabsTrigger key={id} value={id} className="flex-none px-3">
              {t(`tabs.${id}`)}
            </TabsTrigger>
          ))}
        </TabsList>

      <TabsContent value={tab}>
        {bulk && isStepUpRequired(bulkError) && (
          <div className="mb-4">
            <StepUpPrompt action={t('bulk.stepUp', { count: bulkNotSent })} onVerified={() => void sendBulk(bulk)} onCancel={stopBulk} />
          </div>
        )}
        {bulk && bulkError !== null && !isStepUpRequired(bulkError) && (
          <div className="mb-4 space-y-2">
            <ErrorText>{errorMessage(bulkError)}</ErrorText>
            <div className="flex gap-2">
              <Button size="lg" onClick={() => void sendBulk(bulk)}>
                {t('bulk.retry')}
              </Button>
              <Button variant="ghost" size="lg" onClick={stopBulk}>
                {t('bulk.dismiss')}
              </Button>
            </div>
          </div>
        )}
        {bulk && bulkFinished && (
          <Card className="mb-4 block space-y-2 p-4" role="status">
            {bulkApproved > 0 && <p className="text-sm text-foreground">{t('bulk.approved', { count: bulkApproved })}</p>}
            {bulkRefused.length > 0 && (
              <>
                <p className="text-sm text-foreground">{t('bulk.refused', { count: bulkRefused.length })}</p>
                <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                  {bulkRefused.map((r) => (
                    <li key={r.id}>
                      <Link to="/o/$slug/inbox/$id" params={{ slug, id: r.id }} className="text-link hover:underline">
                        {bulk.names[r.id] ?? r.id}
                      </Link>
                      {': '}
                      {errorMessage({ code: r.code, data: r.rule ? { rule: r.rule } : undefined })}
                      {/* A purchase dated in a locked month (#478) is posted in an open month one by one, never in bulk. */}
                      {r.code === 'PERIOD_LOCKED' && ` ${t('bulk.periodLockedHint')}`}
                    </li>
                  ))}
                </ul>
              </>
            )}
            {bulkNotSent > 0 && <p className="text-sm text-warning">{t('bulk.notSent', { count: bulkNotSent })}</p>}
            <Button variant="ghost" size="lg" onClick={() => setBulk(null)}>
              {t('bulk.dismiss')}
            </Button>
          </Card>
        )}
        {bulkEnabled && selectable.length > 0 && (
          <div className="mb-3 flex flex-wrap items-center gap-3">
            <Label className="font-normal text-muted-foreground">
              <Checkbox
                checked={chosen.length === selectable.length}
                indeterminate={chosen.length > 0 && chosen.length < selectable.length}
                disabled={sending}
                onCheckedChange={(checked) => setSelected(checked ? new Set(selectable.map((item) => item.id)) : new Set())}
              />
              {t('bulk.selectAll', { count: selectable.length })}
            </Label>
            {chosen.length > 0 && <span className="text-sm text-subtle-foreground">{t('bulk.selected', { count: chosen.length })}</span>}
            <div className="ml-auto flex gap-2">
              {chosen.length > 0 && !sending && (
                <Button variant="ghost" size="lg" onClick={() => setSelected(new Set())}>
                  {t('bulk.clear')}
                </Button>
              )}
              <Button size="lg" disabled={chosen.length === 0 || sending || !confirmUnverified} onClick={startBulk}>
                {sending ? <Spinner className="text-current" /> : null}
                {sending && bulk
                  ? t('bulk.sending', { done: Math.min(bulk.progress.next + 1, bulk.batches.length), total: bulk.batches.length })
                  : t('bulk.approve', { count: chosen.length })}
              </Button>
            </div>
            {unverifiedChosen > 0 && (
              <Label className="w-full font-normal text-warning">
                <Checkbox checked={confirmUnverified} disabled={sending} onCheckedChange={(checked) => setConfirmedUnverified(checked === true ? new Set(unverifiedItems.map(confirmKey)) : new Set())} />
                {t('bulk.confirmUnverified', { count: unverifiedChosen })}
              </Label>
            )}
            <p className="w-full text-xs text-subtle-foreground">{t('bulk.hint')}</p>
          </div>
        )}
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
          <DataTable
            numeric={[bulkEnabled ? 3 : 2]}
            head={[
              ...(bulkEnabled ? [''] : []),
              t('columns.document'),
              t('columns.issueDate'),
              t('columns.total'),
              t('columns.checks'),
              t('columns.received'),
            ]}
          >
            {items.data?.map((item) => (
              <TableRow key={item.id}>
                {bulkEnabled && (
                  <TableCell className="w-10 px-4 py-3">
                    {bulkSelectable(item, REVERSAL_KIND) ? (
                      <Checkbox
                        checked={selected.has(item.id)}
                        disabled={sending}
                        aria-label={t('bulk.select', { name: proposalName(item) })}
                        onCheckedChange={(checked) =>
                          setSelected((current) => {
                            const next = new Set(current);
                            if (checked) next.add(item.id);
                            else next.delete(item.id);
                            return next;
                          })
                        }
                      />
                    ) : (
                      <Checkbox checked={false} disabled aria-label={t('bulk.notSelectable')} title={t('bulk.notSelectable')} />
                    )}
                  </TableCell>
                )}
                <TableCell className="px-4 py-3">
                  <Link to="/o/$slug/inbox/$id" params={{ slug, id: item.id }} className="font-medium text-foreground hover:text-link">
                    {proposalName(item)}
                  </Link>
                  <p className="text-xs text-subtle-foreground">{item.title}</p>
                  {item.status === 'expired' && item.expiredAfterDays !== null && (
                    <p className="text-xs text-warning">{t('expiredReason', { days: item.expiredAfterDays })}</p>
                  )}
                </TableCell>
                <TableCell className="px-4 py-3 text-muted-foreground">{f.date(item.issueDate)}</TableCell>
                <TableCell className="px-4 py-3 text-right text-foreground tabular-nums">{f.money(item.total)}</TableCell>
                <TableCell className="px-4 py-3">
                  <div className="flex flex-wrap gap-1">
                    {/* A reversal a user asked for has no invoice checks; its card shows the entry it reverses. */}
                    {item.kind === REVERSAL_KIND && <Badge variant="secondary">{t('reversalKind')}</Badge>}
                    {item.kind === VOUCHER_KIND && <Badge variant="secondary">{t('voucherKind')}</Badge>}
                    {item.kind === JOURNAL_VOUCHER_KIND && <Badge variant="secondary">{t('journalVoucherKind')}</Badge>}
                    {item.direction === 'sale' && <Badge variant="secondary">{t('saleKind')}</Badge>}
                    {item.duplicateOf && <Badge variant="warning">{t('maybeDuplicate')}</Badge>}
                    {item.signatureStatus === 'unverified' && <Badge variant="destructive">{t('signatureUnverified')}</Badge>}
                    {item.failedChecks > 0 && <Badge variant="destructive">{t('failedChecks', { count: item.failedChecks })}</Badge>}
                    {item.warnChecks > 0 && <Badge variant="warning">{t('warnChecks', { count: item.warnChecks })}</Badge>}
                    {item.requestedByAgent && <Badge variant="proposal">{t('agentProposed', { name: item.requestedByAgent.name })}</Badge>}
                    {showMatched(item, REVERSAL_KIND, VOUCHER_KIND, JOURNAL_VOUCHER_KIND) && (
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
