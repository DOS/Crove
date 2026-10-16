import { useMutation, useQuery } from '@tanstack/react-query';
import { BLOCKING_CHECK_IDS } from '@crove/kernel-contract';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useEffect, useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'use-intl';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Checkbox } from '@crove/ui/components/checkbox';
import { Label } from '@crove/ui/components/label';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { ErrorText, PageHeader, Spinner } from '../components/ui.tsx';
import { errorMessage, fetchFile, orpc, queryClient } from '../lib/api.ts';
import { isZeroAmount, linesBalance, previewPurchaseJournal } from '../lib/decimal.ts';
import { useFormat } from '../i18n/provider.tsx';
import { reversalErrorMessage } from '../lib/reversal.ts';
import { pollEvery, useStreamLive } from '../lib/stream-hook.ts';

const CHECK_TONE = { pass: 'success', warn: 'warning', fail: 'destructive' } as const;
const CHECK_ICON = { pass: '✓', warn: '!', fail: '✕' } as const;

function FilePreview({ fileId, contentType, filename }: { fileId: string; contentType: string; filename: string }) {
  const t = useTranslations('inboxDetail');
  const [url, setUrl] = useState<string | null>(null);
  // The error itself, worded at render (issue #215).
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    let revoked: string | null = null;
    let cancelled = false;
    fetchFile(fileId)
      .then((blob) => {
        // Unmounted (or another file) before the bytes came: no object URL to leak.
        if (cancelled) return;
        revoked = URL.createObjectURL(blob);
        setUrl(revoked);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e ?? new Error());
      });
    return () => {
      cancelled = true;
      if (revoked) URL.revokeObjectURL(revoked);
    };
  }, [fileId]);
  if (error) return <ErrorText>{errorMessage(error)}</ErrorText>;
  if (!url) return <Spinner />;
  if (contentType.startsWith('image/')) return <img src={url} alt={filename} className="w-full rounded-lg border" />;
  if (contentType === 'application/pdf')
    return (
      <div className="rounded-lg border bg-muted p-4 text-sm">
        <p className="text-foreground">{filename}</p>
        <a href={url} target="_blank" rel="noopener noreferrer" className="mt-3 inline-block text-link hover:underline">
          {t('openPdf')}
        </a>
      </div>
    );
  return (
    <div className="rounded-lg border bg-muted p-4 text-sm">
      <p className="text-foreground">{t('xmlFile')}</p>
      <p className="mt-1 text-xs text-subtle-foreground">{t('xmlHint')}</p>
      <a href={url} download={filename} className="mt-3 inline-block text-link hover:underline">
        {t('download', { filename })}
      </a>
    </div>
  );
}

// A reversal proposal (#138, #165): the entry it reverses, as the approver will post its mirror, and what else the
// approval does. The entry is read as the caller sees it; the server posts the mirror of every line or refuses.
function ReversalCard({ reversal, slug }: { reversal: { entryId: string; entryDate: string; reason: string }; slug: string }) {
  const t = useTranslations('inboxDetail');
  const f = useFormat();
  const entry = useQuery(orpc.journal.get.queryOptions({ input: { id: reversal.entryId } }));
  const document = entry.data?.document;
  return (
    <Card className="block space-y-4 p-4">
      <div className="grid gap-4 sm:grid-cols-3">
        <div>
          <p className="text-xs tracking-wide uppercase text-subtle-foreground">{t('reversalDate')}</p>
          <p className="mt-1 text-sm font-medium text-foreground">{f.date(reversal.entryDate)}</p>
        </div>
        <div className="sm:col-span-2">
          <p className="text-xs tracking-wide uppercase text-subtle-foreground">{t('reason')}</p>
          <p className="mt-1 text-sm whitespace-pre-wrap text-foreground">{reversal.reason}</p>
        </div>
      </div>
      {entry.isLoading ? (
        <Spinner />
      ) : entry.error ? (
        <ErrorText>{errorMessage(entry.error)}</ErrorText>
      ) : entry.data ? (
        <div>
          <p className="text-xs font-medium tracking-wide uppercase text-subtle-foreground">
            {t('originalEntry', { date: f.date(entry.data.entryDate), description: entry.data.description })}
          </p>
          <p className="mt-1 text-xs text-subtle-foreground">{t('mirrorHint')}</p>
          <table className="mt-3 w-full text-sm">
            <thead className="text-left text-xs text-subtle-foreground">
              <tr>
                <th className="py-1.5 font-medium">{t('account')}</th>
                <th className="py-1.5 text-right font-medium">{t('originalDebit')}</th>
                <th className="py-1.5 text-right font-medium">{t('originalCredit')}</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {entry.data.lines.map((l) => (
                <tr key={l.lineNo}>
                  <td className="py-2 text-foreground">
                    <span className="font-mono">{l.accountCode}</span> <span className="text-subtle-foreground">{l.accountName}</span>
                  </td>
                  <td className="py-2 text-right text-foreground tabular-nums">{isZeroAmount(l.debit) ? '' : f.money(l.debit)}</td>
                  <td className="py-2 text-right text-foreground tabular-nums">{isZeroAmount(l.credit) ? '' : f.money(l.credit)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {/* The lines are the ones this viewer may see. A posted entry balances, so visible lines that do not mean some
              are hidden from this viewer; the approval then reverses every line or is refused (partial_mirror). */}
          {(entry.data.lines.length === 0 || !linesBalance(entry.data.lines)) && <p className="mt-3 text-sm text-warning">{t('hiddenLines')}</p>}
          {entry.data.reversedBy && <p className="mt-3 text-sm text-warning">{t('alreadyReversed', { date: f.date(entry.data.reversedBy.entryDate) })}</p>}
          {document && (
            <p className="mt-3 text-sm text-warning">
              {t('purchaseDocument', { document: `${document.series ? `${document.series}-` : ''}${document.number}`, vendor: document.partyName })}{' '}
              {document.voided ? t('documentAlreadyVoided') : t('documentWillVoid')}
            </p>
          )}
          <Link to="/o/$slug/journal" params={{ slug }} hash={`entry-${entry.data.id}`} className="mt-3 inline-block text-sm text-link hover:underline">
            {t('viewInJournal')}
          </Link>
        </div>
      ) : null}
    </Card>
  );
}

export function InboxDetailPage() {
  const locale = useLocale();
  const { slug, id } = useParams({ strict: false }) as { slug: string; id: string };
  const navigate = useNavigate();
  const root = useTranslations();
  const t = useTranslations('inboxDetail');
  const f = useFormat();
  // While the file is being read again, poll until the new reading (or its failure) arrives; with the invalidation
  // stream up, its extraction hint refreshes the page instead.
  const live = useStreamLive();
  const detail = useQuery({
    ...orpc.inbox.get.queryOptions({ input: { id } }),
    refetchInterval: (query) => (query.state.data?.extraction?.inFlight ? pollEvery(live, 2000) : false),
  });
  const accounts = useQuery(orpc.accounts.list.queryOptions());
  const [lineAccounts, setLineAccounts] = useState<Record<number, string>>({});
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [acceptFailed, setAcceptFailed] = useState(false);

  const payload = detail.data?.payload ?? null;
  const lines = useMemo(
    () => (payload?.lines ?? []).map((l) => ({ ...l, debitAccount: lineAccounts[l.lineNo] ?? l.debitAccount })),
    [payload, lineAccounts],
  );
  const journal = useMemo(() => (payload ? previewPurchaseJournal(lines, payload.invoice.vatTotal) : []), [payload, lines]);
  const accountName = (code: string) => accounts.data?.find((a) => a.code === code)?.name ?? '';

  const done = async () => {
    await queryClient.invalidateQueries();
    await navigate({ to: '/o/$slug/inbox', params: { slug } });
  };
  const approve = useMutation(orpc.inbox.approve.mutationOptions({ onSuccess: done }));
  const reject = useMutation(orpc.inbox.reject.mutationOptions({ onSuccess: done }));
  // Saving an edit creates a new revision authored by this user; the page then reloads the server's decision.
  const edit = useMutation(
    orpc.inbox.edit.mutationOptions({
      onSuccess: async () => {
        setLineAccounts({});
        await queryClient.invalidateQueries();
      },
    }),
  );
  // Reading the file again replaces the content with a new reading (a new revision), or makes a new proposal
  // after a rejected one. Unsaved account changes are dropped.
  const reextract = useMutation(
    orpc.files.reextract.mutationOptions({
      onSuccess: async () => {
        setLineAccounts({});
        await queryClient.invalidateQueries();
      },
    }),
  );
  const dirty = (payload?.lines ?? []).some((l) => (lineAccounts[l.lineNo] ?? l.debitAccount) !== l.debitAccount);
  const busy = approve.isPending || reject.isPending || edit.isPending || reextract.isPending;

  if (detail.isLoading) return <Spinner />;
  if (detail.error) return <ErrorText>{errorMessage(detail.error)}</ErrorText>;
  const item = detail.data;
  if (!item) return null;
  const pending = item.status === 'pending';
  const reversal = item.reversal;
  const failed = payload?.checks.filter((c) => c.status === 'fail').length ?? 0;
  const blocked = payload?.checks.some((c) => c.status === 'fail' && BLOCKING_CHECK_IDS.includes(c.id)) ?? false;
  const currency = payload?.invoice.currency ?? 'VND';
  const money = (value: string | null | undefined) => f.money(value, currency);
  const reading = item.extraction?.inFlight ?? false;
  const fileId = item.file?.id;
  const reextractButton =
    item.canReextract && fileId ? (
      <Button
        variant="outline"
        size="lg"
        disabled={busy}
        onClick={() => {
          const ask = pending ? t('confirmRereadPending') : item.voided ? t('confirmRereadVoided') : t('confirmRereadOther');
          if (!window.confirm(ask)) return;
          reextract.mutate({ fileId, idempotencyKey: crypto.randomUUID() });
        }}
      >
        {reextract.isPending ? <Spinner /> : null}
        {t('reread')}
      </Button>
    ) : null;
  const lastRun = item.extraction;
  const lastRunFailed = lastRun !== null && lastRun.status === 'failed' && lastRun.version !== lastRun.proposalVersion;

  return (
    <>
      <Link to="/o/$slug/inbox" params={{ slug }} className="text-sm text-subtle-foreground hover:text-muted-foreground">
        {t('back')}
      </Link>
      <div className="mt-3">
        <PageHeader
          title={payload?.seller.name ?? item.title}
          subtitle={
            payload
              ? payload.invoice.series
                ? t('invoiceWithSeries', { series: payload.invoice.series, number: payload.invoice.number, date: f.date(payload.invoice.issueDate) })
                : t('invoice', { number: payload.invoice.number, date: f.date(payload.invoice.issueDate) })
              : reversal
                ? t('reversalSubtitle')
                : undefined
          }
          actions={
            pending ? (
              <>
                {reextractButton}
                {item.canReject && (
                  <Button
                    variant="destructive"
                    size="lg"
                    disabled={busy}
                    onClick={() => {
                      const reason = window.prompt(t('rejectPrompt'));
                      if (reason === null) return;
                      reject.mutate({ id, ...(reason.trim() ? { reason: reason.trim().slice(0, 500) } : {}) });
                    }}
                  >
                    {t('reject')}
                  </Button>
                )}
                {item.canEdit && dirty && (
                  <Button
                    variant="outline"
                    size="lg"
                    disabled={busy}
                    onClick={() =>
                      edit.mutate({
                        id,
                        revision: item.revision,
                        idempotencyKey: crypto.randomUUID(),
                        lineAccounts: lines.map((l) => ({ lineNo: l.lineNo, debitAccount: l.debitAccount })),
                      })
                    }
                  >
                    {edit.isPending ? <Spinner /> : null}
                    {t('saveEdit')}
                  </Button>
                )}
                {item.canApprove && reversal && (
                  <Button size="lg" disabled={busy} onClick={() => approve.mutate({ id, revision: item.revision, idempotencyKey })}>
                    {approve.isPending ? <Spinner /> : null}
                    {t('approveReversal')}
                  </Button>
                )}
                {item.canApprove && !reversal && (
                  <Button
                    size="lg"
                    disabled={busy || dirty || !payload || blocked || (failed > 0 && !acceptFailed)}
                    onClick={() =>
                      approve.mutate({
                        id,
                        revision: item.revision,
                        idempotencyKey,
                        lineAccounts: lines.map((l) => ({ lineNo: l.lineNo, debitAccount: l.debitAccount })),
                        ...(failed > 0 ? { acceptFailedChecks: acceptFailed } : {}),
                      })
                    }
                  >
                    {approve.isPending ? <Spinner /> : null}
                    {t('approve')}
                  </Button>
                )}
              </>
            ) : (
              <>
                {reextractButton}
                <Badge variant={item.status === 'executed' ? 'success' : 'secondary'}>
                  {item.status === 'executed'
                    ? t('executedAt', { at: f.dateTime(item.decidedAt) })
                    : item.status === 'rejected'
                      ? t('rejected')
                      : item.status}
                </Badge>
                {item.voided && <Badge variant="destructive">{t('voidedBadge')}</Badge>}
              </>
            )
          }
        />
      </div>
      {(approve.error || reject.error || edit.error || reextract.error) && (
        <div className="mb-4">
          <ErrorText>
            {reversal && approve.error ? reversalErrorMessage(approve.error, root, locale) : errorMessage(approve.error ?? reject.error ?? edit.error ?? reextract.error)}
          </ErrorText>
        </div>
      )}
      {/* An executed purchase whose document was voided by reversing its entry (#165). */}
      {item.voided && (
        <p className="mb-4 text-sm text-muted-foreground">
          {t('voidedNotice')} {reextractButton ? t('voidedReread') : t('voidedNoReread')}
        </p>
      )}
      {reversal && (
        <div className="mb-6">
          {pending && !item.canApprove && item.approveReason === 'four_eyes' && <p className="mb-4 text-sm text-muted-foreground">{t('reversalFourEyes')}</p>}
          {pending && !item.canApprove && item.approveReason === 'not_eligible' && (
            <p className="mb-4 text-sm text-subtle-foreground">{t('reversalNotEligible')}</p>
          )}
          <ReversalCard reversal={reversal} slug={slug} />
        </div>
      )}
      {reading && (
        <p className="mb-4 flex items-center gap-2 text-sm text-link">
          <Spinner />
          {t('reading', { version: String(lastRun?.version ?? '') })}
        </p>
      )}
      {!reading && lastRunFailed && (
        <div className="mb-4">
          <ErrorText>
            {t('lastRunFailed', { version: String(lastRun?.version ?? ''), error: lastRun?.error ?? t('lastRunUnknownError') })}
            {pending ? ` ${t('lastRunKept')}` : ''}
          </ErrorText>
        </div>
      )}
      {pending && dirty && (
        <p className="mb-4 text-sm text-muted-foreground">{t('dirty')}</p>
      )}
      {pending && !reversal && !dirty && item.approveReason === 'four_eyes' && (
        <p className="mb-4 text-sm text-muted-foreground">{t('fourEyes')}</p>
      )}
      {pending && !reversal && !dirty && item.approveReason === 'not_eligible' && (
        <p className="mb-4 text-sm text-subtle-foreground">{t('notEligible')}</p>
      )}
      {pending && blocked && (
        <div className="mb-4">
          <ErrorText>
            {payload?.extractionMethod === 'einvoice_xml' ? t('blockedXml') : t('blockedAi')}
          </ErrorText>
        </div>
      )}
      {pending && !blocked && failed > 0 && (
        <div className="mb-4 space-y-2">
          <ErrorText>{t('failedChecks', { count: failed })}</ErrorText>
          <Label className="font-normal text-muted-foreground">
            <Checkbox checked={acceptFailed} onCheckedChange={(checked) => setAcceptFailed(checked)} />
            {t('acceptFailed')}
          </Label>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-5">
        <div className="space-y-6 lg:col-span-3">
          {payload && (
            <Card className="grid gap-4 p-4 sm:grid-cols-2">
              <div>
                <p className="text-xs tracking-wide uppercase text-subtle-foreground">{t('seller')}</p>
                <p className="mt-1 text-sm font-medium text-foreground">{payload.seller.name}</p>
                <p className="text-xs text-muted-foreground">{t('taxCode', { code: payload.seller.taxCode ?? t('noTaxCode') })}</p>
                <p className="text-xs text-subtle-foreground">{payload.seller.address}</p>
              </div>
              <div>
                <p className="text-xs tracking-wide uppercase text-subtle-foreground">{t('buyer')}</p>
                <p className="mt-1 text-sm font-medium text-foreground">{payload.buyer.name || t('notStated')}</p>
                <p className="text-xs text-muted-foreground">{t('taxCode', { code: payload.buyer.taxCode ?? t('noTaxCode') })}</p>
              </div>
              <div className="grid grid-cols-3 gap-2 sm:col-span-2">
                <div>
                  <p className="text-xs text-subtle-foreground">{t('subtotal')}</p>
                  <p className="text-sm text-foreground tabular-nums">{money(payload.invoice.subtotal)}</p>
                </div>
                <div>
                  <p className="text-xs text-subtle-foreground">{t('vat')}</p>
                  <p className="text-sm text-foreground tabular-nums">{money(payload.invoice.vatTotal)}</p>
                </div>
                <div>
                  <p className="text-xs text-subtle-foreground">{t('total')}</p>
                  <p className="text-base font-semibold text-foreground tabular-nums">{money(payload.invoice.total)}</p>
                </div>
                <p className="text-xs text-subtle-foreground sm:col-span-3">{t('currency', { currency })}</p>
              </div>
            </Card>
          )}

          {payload && (
            <Card className="block p-4">
              <p className="text-xs font-medium tracking-wide uppercase text-subtle-foreground">{t('checks')}</p>
              <ul className="mt-3 space-y-1.5">
                {payload.checks.map((c) => (
                  <li key={c.id} className="flex items-start gap-2 text-sm">
                    <Badge variant={CHECK_TONE[c.status]}>{CHECK_ICON[c.status]}</Badge>
                    <span className="text-muted-foreground">{c.message}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {payload && (
            <Card className="block overflow-x-auto p-4">
              <p className="text-xs font-medium tracking-wide uppercase text-subtle-foreground">{t('lines')}</p>
              <table className="mt-3 w-full min-w-[560px] text-sm">
                <thead className="text-left text-xs text-subtle-foreground">
                  <tr>
                    <th className="py-1.5 pr-2 font-medium">{t('description')}</th>
                    <th className="py-1.5 pr-2 text-right font-medium">{t('amount')}</th>
                    <th className="py-1.5 font-medium">{t('debitAccount')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {lines.map((l) => (
                    <tr key={l.lineNo}>
                      <td className="py-2 pr-2 text-foreground">
                        {l.description}
                        <p className="text-xs text-subtle-foreground">{l.reason}</p>
                      </td>
                      <td className="py-2 pr-2 text-right text-foreground tabular-nums">{money(l.amount)}</td>
                      <td className="py-2">
                        <NativeSelect
                          size="sm"
                          disabled={!item.canEdit || busy}
                          aria-label={t('debitAccountFor', { line: String(l.lineNo) })}
                          className="w-48"
                          value={l.debitAccount}
                          onChange={(e) => setLineAccounts((prev) => ({ ...prev, [l.lineNo]: e.target.value }))}
                        >
                          {(accounts.data ?? [{ code: l.debitAccount, name: '', parentCode: null }]).map((a) => (
                            <NativeSelectOption key={a.code} value={a.code}>
                              {a.code} · {a.name}
                            </NativeSelectOption>
                          ))}
                        </NativeSelect>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}

          {payload && (
            <Card className="block p-4">
              <p className="text-xs font-medium tracking-wide uppercase text-subtle-foreground">{t('journal')}</p>
              <table className="mt-3 w-full text-sm">
                <thead className="text-left text-xs text-subtle-foreground">
                  <tr>
                    <th className="py-1.5 font-medium">{t('account')}</th>
                    <th className="py-1.5 text-right font-medium">{t('debit')}</th>
                    <th className="py-1.5 text-right font-medium">{t('credit')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {journal.map((j) => (
                    <tr key={`${j.accountCode}-${j.debit}-${j.credit}`}>
                      <td className="py-2 text-foreground">
                        <span className="font-mono">{j.accountCode}</span> <span className="text-subtle-foreground">{accountName(j.accountCode)}</span>
                      </td>
                      <td className="py-2 text-right text-foreground tabular-nums">{isZeroAmount(j.debit) ? '' : money(j.debit)}</td>
                      <td className="py-2 text-right text-foreground tabular-nums">{isZeroAmount(j.credit) ? '' : money(j.credit)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}
        </div>
        {/* A reversal has no source file; its card above shows the entry it reverses. */}
        {!reversal && (
          <div className="lg:col-span-2">
            <Card className="block p-4">
              <p className="mb-3 text-xs font-medium tracking-wide uppercase text-subtle-foreground">{t('original')}</p>
              {item.file ? <FilePreview fileId={item.file.id} contentType={item.file.contentType} filename={item.file.filename} /> : <p className="text-sm text-subtle-foreground">{t('noFile')}</p>}
            </Card>
          </div>
        )}
      </div>
    </>
  );
}
