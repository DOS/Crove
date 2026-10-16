import { useMutation, useQuery } from '@tanstack/react-query';
import { BLOCKING_CHECK_IDS } from '@crove/kernel-contract';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'use-intl';
import { Badge, Button, Card, ErrorText, PageHeader, Spinner } from '../components/ui.tsx';
import { errorMessage, fetchFile, orpc, queryClient } from '../lib/api.ts';
import { previewPurchaseJournal } from '../lib/decimal.ts';
import { useFormat } from '../i18n/provider.tsx';

const CHECK_TONE = { pass: 'good', warn: 'warn', fail: 'bad' } as const;
const CHECK_ICON = { pass: '✓', warn: '!', fail: '✕' } as const;

function FilePreview({ fileId, contentType, filename }: { fileId: string; contentType: string; filename: string }) {
  const t = useTranslations('inboxDetail');
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let revoked: string | null = null;
    fetchFile(fileId)
      .then((blob) => {
        revoked = URL.createObjectURL(blob);
        setUrl(revoked);
      })
      .catch((e: unknown) => setError(errorMessage(e)));
    return () => {
      if (revoked) URL.revokeObjectURL(revoked);
    };
  }, [fileId]);
  if (error) return <ErrorText>{error}</ErrorText>;
  if (!url) return <Spinner />;
  if (contentType.startsWith('image/')) return <img src={url} alt={filename} className="w-full rounded-lg border border-line" />;
  if (contentType === 'application/pdf')
    return (
      <div className="rounded-lg border border-line bg-surface-2 p-4 text-sm">
        <p className="text-fg">{filename}</p>
        <a href={url} target="_blank" rel="noopener noreferrer" className="mt-3 inline-block text-brand-300 hover:underline">
          {t('openPdf')}
        </a>
      </div>
    );
  return (
    <div className="rounded-lg border border-line bg-surface-2 p-4 text-sm">
      <p className="text-fg">{t('xmlFile')}</p>
      <p className="mt-1 text-xs text-fg-3">{t('xmlHint')}</p>
      <a href={url} download={filename} className="mt-3 inline-block text-brand-300 hover:underline">
        {t('download', { filename })}
      </a>
    </div>
  );
}

export function InboxDetailPage() {
  const { slug, id } = useParams({ strict: false }) as { slug: string; id: string };
  const navigate = useNavigate();
  const t = useTranslations('inboxDetail');
  const f = useFormat();
  // While the file is being read again, poll until the new reading (or its failure) arrives.
  const detail = useQuery({
    ...orpc.inbox.get.queryOptions({ input: { id } }),
    refetchInterval: (query) => (query.state.data?.extraction?.inFlight ? 2000 : false),
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
  const failed = payload?.checks.filter((c) => c.status === 'fail').length ?? 0;
  const blocked = payload?.checks.some((c) => c.status === 'fail' && BLOCKING_CHECK_IDS.includes(c.id)) ?? false;
  const currency = payload?.invoice.currency ?? 'VND';
  const money = (value: string | null | undefined) => f.money(value, currency);
  const reading = item.extraction?.inFlight ?? false;
  const fileId = item.file?.id;
  const reextractButton =
    item.canReextract && fileId ? (
      <Button
        disabled={busy}
        onClick={() => {
          const ask = pending ? t('confirmRereadPending') : t('confirmRereadOther');
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
      <Link to="/o/$slug/inbox" params={{ slug }} className="text-sm text-fg-3 hover:text-fg-2">
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
              : undefined
          }
          actions={
            pending ? (
              <>
                {reextractButton}
                {item.canReject && (
                  <Button
                    variant="danger"
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
                {item.canApprove && (
                  <Button
                    variant="primary"
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
                <Badge tone={item.status === 'executed' ? 'good' : 'neutral'}>
                  {item.status === 'executed'
                    ? t('executedAt', { at: f.dateTime(item.decidedAt) })
                    : item.status === 'rejected'
                      ? t('rejected')
                      : item.status}
                </Badge>
              </>
            )
          }
        />
      </div>
      {(approve.error || reject.error || edit.error || reextract.error) && (
        <div className="mb-4">
          <ErrorText>{errorMessage(approve.error ?? reject.error ?? edit.error ?? reextract.error)}</ErrorText>
        </div>
      )}
      {reading && (
        <p className="mb-4 flex items-center gap-2 text-sm text-brand-300">
          <Spinner />
          {t('reading', { version: lastRun?.version ?? '' })}
        </p>
      )}
      {!reading && lastRunFailed && (
        <div className="mb-4">
          <ErrorText>
            {t('lastRunFailed', { version: lastRun?.version ?? '', error: lastRun?.error ?? t('lastRunUnknownError') })}
            {pending ? ` ${t('lastRunKept')}` : ''}
          </ErrorText>
        </div>
      )}
      {pending && dirty && (
        <p className="mb-4 text-sm text-fg-2">{t('dirty')}</p>
      )}
      {pending && !dirty && item.approveReason === 'four_eyes' && (
        <p className="mb-4 text-sm text-fg-2">{t('fourEyes')}</p>
      )}
      {pending && !dirty && item.approveReason === 'not_eligible' && (
        <p className="mb-4 text-sm text-fg-3">{t('notEligible')}</p>
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
          <label className="flex items-center gap-2 text-sm text-fg-2">
            <input type="checkbox" checked={acceptFailed} onChange={(e) => setAcceptFailed(e.target.checked)} />
            {t('acceptFailed')}
          </label>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-5">
        <div className="space-y-6 lg:col-span-3">
          {payload && (
            <Card className="grid gap-4 p-4 sm:grid-cols-2">
              <div>
                <p className="text-xs uppercase tracking-wide text-fg-3">{t('seller')}</p>
                <p className="mt-1 text-sm font-medium text-fg">{payload.seller.name}</p>
                <p className="text-xs text-fg-2">{t('taxCode', { code: payload.seller.taxCode ?? t('noTaxCode') })}</p>
                <p className="text-xs text-fg-3">{payload.seller.address}</p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-wide text-fg-3">{t('buyer')}</p>
                <p className="mt-1 text-sm font-medium text-fg">{payload.buyer.name || t('notStated')}</p>
                <p className="text-xs text-fg-2">{t('taxCode', { code: payload.buyer.taxCode ?? t('noTaxCode') })}</p>
              </div>
              <div className="grid grid-cols-3 gap-2 sm:col-span-2">
                <div>
                  <p className="text-xs text-fg-3">{t('subtotal')}</p>
                  <p className="tabular text-sm text-fg">{money(payload.invoice.subtotal)}</p>
                </div>
                <div>
                  <p className="text-xs text-fg-3">{t('vat')}</p>
                  <p className="tabular text-sm text-fg">{money(payload.invoice.vatTotal)}</p>
                </div>
                <div>
                  <p className="text-xs text-fg-3">{t('total')}</p>
                  <p className="tabular text-base font-semibold text-fg">{money(payload.invoice.total)}</p>
                </div>
                <p className="text-xs text-fg-3 sm:col-span-3">{t('currency', { currency })}</p>
              </div>
            </Card>
          )}

          {payload && (
            <Card className="p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-fg-3">{t('checks')}</p>
              <ul className="mt-3 space-y-1.5">
                {payload.checks.map((c) => (
                  <li key={c.id} className="flex items-start gap-2 text-sm">
                    <Badge tone={CHECK_TONE[c.status]}>{CHECK_ICON[c.status]}</Badge>
                    <span className="text-fg-2">{c.message}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {payload && (
            <Card className="overflow-x-auto p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-fg-3">{t('lines')}</p>
              <table className="mt-3 w-full min-w-[560px] text-sm">
                <thead className="text-left text-xs text-fg-3">
                  <tr>
                    <th className="py-1.5 pr-2 font-medium">{t('description')}</th>
                    <th className="py-1.5 pr-2 text-right font-medium">{t('amount')}</th>
                    <th className="py-1.5 font-medium">{t('debitAccount')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--line)]">
                  {lines.map((l) => (
                    <tr key={l.lineNo}>
                      <td className="py-2 pr-2 text-fg">
                        {l.description}
                        <p className="text-xs text-fg-3">{l.reason}</p>
                      </td>
                      <td className="tabular py-2 pr-2 text-right text-fg">{money(l.amount)}</td>
                      <td className="py-2">
                        <select
                          disabled={!item.canEdit || busy}
                          aria-label={t('debitAccountFor', { line: l.lineNo })}
                          className="w-48 rounded-lg border border-line bg-surface-2 px-2 py-1 text-sm text-fg"
                          value={l.debitAccount}
                          onChange={(e) => setLineAccounts((prev) => ({ ...prev, [l.lineNo]: e.target.value }))}
                        >
                          {(accounts.data ?? [{ code: l.debitAccount, name: '', parentCode: null }]).map((a) => (
                            <option key={a.code} value={a.code}>
                              {a.code} · {a.name}
                            </option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}

          {payload && (
            <Card className="p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-fg-3">{t('journal')}</p>
              <table className="mt-3 w-full text-sm">
                <thead className="text-left text-xs text-fg-3">
                  <tr>
                    <th className="py-1.5 font-medium">{t('account')}</th>
                    <th className="py-1.5 text-right font-medium">{t('debit')}</th>
                    <th className="py-1.5 text-right font-medium">{t('credit')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--line)]">
                  {journal.map((j) => (
                    <tr key={`${j.accountCode}-${j.debit}-${j.credit}`}>
                      <td className="py-2 text-fg">
                        <span className="font-mono">{j.accountCode}</span> <span className="text-fg-3">{accountName(j.accountCode)}</span>
                      </td>
                      <td className="tabular py-2 text-right text-fg">{j.debit !== '0' ? money(j.debit) : ''}</td>
                      <td className="tabular py-2 text-right text-fg">{j.credit !== '0' ? money(j.credit) : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}
        </div>
        <div className="lg:col-span-2">
          <Card className="p-4">
            <p className="mb-3 text-xs font-medium uppercase tracking-wide text-fg-3">{t('original')}</p>
            {item.file ? <FilePreview fileId={item.file.id} contentType={item.file.contentType} filename={item.file.filename} /> : <p className="text-sm text-fg-3">{t('noFile')}</p>}
          </Card>
        </div>
      </div>
    </>
  );
}
