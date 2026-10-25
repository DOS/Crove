import { useMutation, useQuery } from '@tanstack/react-query';
import { BLOCKING_CHECK_IDS, vietnamToday, type CashVoucherProposal, type JournalVoucherProposal } from '@crove/kernel-contract';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'use-intl';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Checkbox } from '@crove/ui/components/checkbox';
import { Input } from '@crove/ui/components/input';
import { Label } from '@crove/ui/components/label';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { DateInput } from '../components/date-input.tsx';
import { StepUpPrompt } from '../components/two-factor.tsx';
import { ErrorText, PageHeader, Spinner } from '../components/ui.tsx';
import { accountLabel, pickableAccounts } from '../lib/accounts.ts';
import { errorMessage, fetchFile, isStepUpRequired, orpc, queryClient } from '../lib/api.ts';
import { getConfig } from '../lib/auth.ts';
import { isZeroAmount, linesBalance, previewPurchaseJournal, previewSalesJournal } from '../lib/decimal.ts';
import { nextDay, postingDateAllowed } from '../lib/period-lock.ts';
import { useFormat } from '../i18n/provider.tsx';
import { invoiceCheckMessage } from '../lib/invoice-checks.ts';
import { parseExchangeRate } from '../lib/exchange-rate.ts';
import { reversalErrorMessage } from '../lib/reversal.ts';
import { journalVoucherProblem } from '../lib/journal-voucher.ts';
import { SM_UP, useMediaQuery } from '../lib/media.ts';
import { toast } from '../lib/toast.ts';
import { previewVoucherJournal, voucherProblem } from '../lib/vouchers.ts';
import { partySearch } from '../lib/parties.ts';
import { checksByConcern, nextPendingId, previousPendingId } from '../lib/review.ts';
import { useReviewShortcuts, type ReviewHandlers } from '../lib/review-shortcuts.ts';
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
          <p className="text-xs text-subtle-foreground">{t('reversalDate')}</p>
          <p className="mt-1 text-sm font-medium text-foreground">{f.date(reversal.entryDate)}</p>
        </div>
        <div className="sm:col-span-2">
          <p className="text-xs text-subtle-foreground">{t('reason')}</p>
          <p className="mt-1 text-sm whitespace-pre-wrap text-foreground">{reversal.reason}</p>
        </div>
      </div>
      {entry.isLoading ? (
        <Spinner />
      ) : entry.error ? (
        <ErrorText>{errorMessage(entry.error)}</ErrorText>
      ) : entry.data ? (
        <div>
          <p className="text-sm font-medium text-muted-foreground">
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
              {document.direction === 'sale'
                ? t('saleDocument', { document: `${document.series ? `${document.series}-` : ''}${document.number}`, customer: document.partyName })
                : t('purchaseDocument', { document: `${document.series ? `${document.series}-` : ''}${document.number}`, vendor: document.partyName })}{' '}
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

// A cash or bank voucher entered by hand (#327): what it says and the entry its approval posts. The number is given
// on approval; code is the one it was given, once approved.
function VoucherCard({ voucher, code, slug, accountName }: { voucher: CashVoucherProposal; code: string | null; slug: string; accountName: (code: string) => string }) {
  const t = useTranslations('inboxDetail');
  const f = useFormat();
  const journal = previewVoucherJournal(voucher);
  return (
    <Card className="block space-y-4 p-4">
      <div className="grid gap-4 sm:grid-cols-3">
        <div>
          <p className="text-xs tracking-wide uppercase text-subtle-foreground">{t('voucherCashAccount')}</p>
          <p className="mt-1 text-sm font-medium text-foreground">
            <span className="font-mono">{voucher.cashAccount}</span> <span className="text-subtle-foreground">{accountName(voucher.cashAccount)}</span>
          </p>
        </div>
        <div>
          <p className="text-xs tracking-wide uppercase text-subtle-foreground">{t('voucherParty')}</p>
          <p className="mt-1 text-sm text-foreground">{voucher.party ? voucher.party.name : t('notStated')}</p>
          {voucher.party?.taxCode && <p className="text-xs text-muted-foreground">{t('taxCode', { code: voucher.party.taxCode })}</p>}
        </div>
        <div>
          <p className="text-xs tracking-wide uppercase text-subtle-foreground">{t('voucherTotal')}</p>
          <p className="mt-1 text-base font-semibold text-foreground tabular-nums">{f.money(voucher.total)}</p>
        </div>
        <div className="sm:col-span-2">
          <p className="text-xs tracking-wide uppercase text-subtle-foreground">{t('voucherReason')}</p>
          <p className="mt-1 text-sm whitespace-pre-wrap text-foreground">{voucher.description}</p>
        </div>
        {voucher.personName && (
          <div>
            <p className="text-xs tracking-wide uppercase text-subtle-foreground">{t('voucherPerson')}</p>
            <p className="mt-1 text-sm text-foreground">{voucher.personName}</p>
          </div>
        )}
      </div>
      <div>
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
            {journal.map((j, i) => (
              <tr key={`${i}-${j.accountCode}`}>
                <td className="py-2 text-foreground">
                  <span className="font-mono">{j.accountCode}</span> <span className="text-subtle-foreground">{accountName(j.accountCode)}</span>
                  {j.memo && <p className="text-xs text-subtle-foreground">{j.memo}</p>}
                </td>
                <td className="py-2 text-right text-foreground tabular-nums">{isZeroAmount(j.debit) ? '' : f.money(j.debit)}</td>
                <td className="py-2 text-right text-foreground tabular-nums">{isZeroAmount(j.credit) ? '' : f.money(j.credit)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {code ? (
          <p className="mt-3 text-sm text-foreground">
            {t('voucherNumberGiven')} <span className="font-mono font-medium">{code}</span>
          </p>
        ) : (
          <p className="mt-3 text-xs text-subtle-foreground">{t('voucherNumberLater')}</p>
        )}
        <Link to="/o/$slug/vouchers" params={{ slug }} className="mt-2 inline-block text-sm text-link hover:underline">
          {t('viewVouchers')}
        </Link>
      </div>
    </Card>
  );
}

// A general journal voucher entered by hand (NVK, #888): its reason and the entry its approval posts, line by line with
// each line's party. The number is given on approval; code is the one it was given, once approved.
function JournalVoucherCard({ voucher, code, slug, accountName }: { voucher: JournalVoucherProposal; code: string | null; slug: string; accountName: (code: string) => string }) {
  const t = useTranslations('inboxDetail');
  const f = useFormat();
  return (
    <Card className="block space-y-4 p-4">
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="sm:col-span-2">
          <p className="text-xs tracking-wide uppercase text-subtle-foreground">{t('voucherReason')}</p>
          <p className="mt-1 text-sm whitespace-pre-wrap text-foreground">{voucher.description}</p>
        </div>
        <div>
          <p className="text-xs tracking-wide uppercase text-subtle-foreground">{t('voucherTotal')}</p>
          <p className="mt-1 text-base font-semibold text-foreground tabular-nums">{f.money(voucher.total)}</p>
        </div>
      </div>
      <div>
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
            {voucher.lines.map((l, i) => (
              <tr key={`${i}-${l.account}`}>
                <td className="py-2 text-foreground">
                  <span className="font-mono">{l.account}</span> <span className="text-subtle-foreground">{accountName(l.account)}</span>
                  {l.party && <p className="text-xs text-muted-foreground">{l.party.taxCode ? `${l.party.name} (${l.party.taxCode})` : l.party.name}</p>}
                  <p className="text-xs text-subtle-foreground">{l.memo ?? voucher.description}</p>
                </td>
                <td className="py-2 text-right text-foreground tabular-nums">{isZeroAmount(l.debit) ? '' : f.money(l.debit)}</td>
                <td className="py-2 text-right text-foreground tabular-nums">{isZeroAmount(l.credit) ? '' : f.money(l.credit)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {code ? (
          <p className="mt-3 text-sm text-foreground">
            {t('voucherNumberGiven')} <span className="font-mono font-medium">{code}</span>
          </p>
        ) : (
          <p className="mt-3 text-xs text-subtle-foreground">{t('voucherNumberLater')}</p>
        )}
        <Link to="/o/$slug/journal" params={{ slug }} className="mt-2 inline-block text-sm text-link hover:underline">
          {t('viewJournal')}
        </Link>
      </div>
    </Card>
  );
}

// One page per proposal: moving to the next one (J or N) mounts a fresh page, so no unsaved account, confirmation or
// approval idempotency key carries over from the previous proposal.
export function InboxDetailPage() {
  const { slug, id } = useParams({ strict: false }) as { slug: string; id: string };
  return <InboxDetail key={id} slug={slug} id={id} />;
}

function InboxDetail({ slug, id }: { slug: string; id: string }) {
  const locale = useLocale();
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
  // The chart of accounts is the finance module's; without it (CROVE_MODULES) the screen does not ask for it.
  const finance = getConfig().modules.includes('finance');
  const accounts = useQuery({ ...orpc.accounts.list.queryOptions(), enabled: finance });
  const [lineAccounts, setLineAccounts] = useState<Record<number, string>>({});
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  // The rate typed for a foreign-currency invoice read without one (#918).
  const [exchangeRate, setExchangeRate] = useState('');
  const enteredRate = parseExchangeRate(exchangeRate);
  const [acceptFailed, setAcceptFailed] = useState(false);
  // An invoice whose digital signature is unverified (#674): the approver confirms they checked the original first.
  // The confirmation holds for the revision it was given on: a new reading of the file (a new revision) asks again.
  const [acceptUnverifiedRevision, setAcceptUnverifiedRevision] = useState<number | null>(null);
  // A purchase invoice dated in a locked month (#478), or on or before the opening balances (#366): the approver may
  // post it on a later date, by choice only (unticked, the approval posts on the invoice date and the kernel refuses
  // it, as before). The date starts at the first day after both.
  const [postLate, setPostLate] = useState(false);
  const [postingDate, setPostingDate] = useState<string | null>(null);

  const payload = detail.data?.payload ?? null;
  const lines = useMemo(
    () => (payload?.lines ?? []).map((l) => ({ ...l, debitAccount: lineAccounts[l.lineNo] ?? l.debitAccount })),
    [payload, lineAccounts],
  );
  // A sale (issue #313): the org issued the invoice, the buyer is the customer, and the lines go to revenue.
  const sale = payload?.direction === 'sale';
  const lockState = useQuery({ ...orpc.periodLock.state.queryOptions(), enabled: finance && !!payload && !sale });
  const lockedThrough = lockState.data?.lockedThrough ?? null;
  const openingDate = lockState.data?.openingDate ?? null;
  const invoiceLocked = !!payload && !sale && lockedThrough !== null && payload.invoice.issueDate <= lockedThrough;
  const invoiceBeforeOpening = !!payload && !sale && openingDate !== null && payload.invoice.issueDate <= openingDate;
  // The last day nothing posts on: the later of the lock and the opening entry.
  const closedThrough = [lockedThrough, openingDate].filter((d): d is string => d !== null).sort().at(-1) ?? null;
  const firstOpenDay = closedThrough ? nextDay(closedThrough) : null;
  const chosenPostingDate = postingDate ?? firstOpenDay;
  const latePosting = (invoiceLocked || invoiceBeforeOpening) && postLate ? chosenPostingDate : null;
  const latePostingValid = latePosting === null || (closedThrough !== null && postingDateAllowed(latePosting, closedThrough, vietnamToday()));
  const journal = useMemo(
    () => (payload ? (payload.direction === 'sale' ? previewSalesJournal : previewPurchaseJournal)(lines, payload.invoice.vatTotal) : []),
    [payload, lines],
  );
  const accountName = (code: string) => accounts.data?.find((a) => a.code === code)?.name ?? '';

  const wide = useMediaQuery(SM_UP);
  // The decision is said on the Inbox the reviewer goes back to (#1384), in the verb of its button. The toast shows at
  // once and its time starts when the Inbox is the page (holdUntil), so a slow screen change does not use it up
  // (#1547), and a navigation another one supersedes cannot lose it. The queries refetch in the background: waiting for
  // this page's refetches first is what used to outlast the toast. The shell's counters refetch now.
  const done = async (said: string) => {
    void queryClient.invalidateQueries();
    const going = navigate({ to: '/o/$slug/inbox', params: { slug } });
    toast(said, 'success', { holdUntil: going });
    await going;
  };
  const partyName = () => (sale ? payload?.buyer.name : payload?.seller.name) || detail.data?.title || '';
  const approve = useMutation(orpc.inbox.approve.mutationOptions({ onSuccess: () => done(t('approvedToast', { name: partyName() })) }));
  const stepUp = isStepUpRequired(approve.error);
  const reject = useMutation(orpc.inbox.reject.mutationOptions({ onSuccess: () => done(t('rejectedToast', { name: partyName() })) }));
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
  // Asking again for an expired proposal (#876) makes a new pending proposal from the same source; the page opens it.
  const resubmit = useMutation(
    orpc.inbox.resubmit.mutationOptions({
      onSuccess: async (created) => {
        await queryClient.invalidateQueries();
        await navigate({ to: '/o/$slug/inbox/$id', params: { slug, id: created.proposalId } });
      },
    }),
  );
  const dirty = (payload?.lines ?? []).some((l) => (lineAccounts[l.lineNo] ?? l.debitAccount) !== l.debitAccount);
  const busy = approve.isPending || reject.isPending || edit.isPending || reextract.isPending || resubmit.isPending;

  const item = detail.data;
  const pending = item?.status === 'pending';
  const reversal = item?.reversal ?? null;
  // A voucher (#327) is approved as shown, like a reversal: no line accounts, no invoice checks.
  const voucher = item?.voucher ?? null;
  // The code the voucher was given when it was approved (PC00001 and the like).
  const voucherCode = (voucher && item?.status === 'executed' && item.result?.voucherCode) || null;
  // A general journal voucher (NVK, #888) is approved as shown too.
  const journalVoucher = item?.journalVoucher ?? null;
  const journalVoucherCode = (journalVoucher && item?.status === 'executed' && item.result?.voucherCode) || null;
  const plain = reversal !== null || voucher !== null || journalVoucher !== null;
  const failed = payload?.checks.filter((c) => c.status === 'fail').length ?? 0;
  const blocked = payload?.checks.some((c) => c.status === 'fail' && BLOCKING_CHECK_IDS.includes(c.id)) ?? false;
  // As the kernel decides (kernel.proposal.approve): an XML invoice whose signature is not verified, including one read
  // before #674, which has no verification stored.
  const unverified = item?.signatureStatus === 'unverified';
  const acceptUnverified = item !== undefined && acceptUnverifiedRevision === item.revision;
  const signatureCheck = payload?.checks.find((c) => c.id === 'signature');
  // The approve buttons are enabled exactly when this holds, and the A shortcut uses the same value.
  const approveReady =
    item !== undefined &&
    pending &&
    item.canApprove &&
    !busy &&
    (plain ? true : !dirty && !!payload && !blocked && (failed === 0 || acceptFailed) && (!unverified || acceptUnverified) && latePostingValid);
  const submitApproval = () => {
    if (!item) return;
    if (plain) {
      approve.mutate({ id, revision: item.revision, idempotencyKey });
      return;
    }
    approve.mutate({
      id,
      revision: item.revision,
      idempotencyKey,
      lineAccounts: lines.map((l) => ({ lineNo: l.lineNo, debitAccount: l.debitAccount })),
      ...(failed > 0 ? { acceptFailedChecks: acceptFailed } : {}),
      ...(unverified ? { acceptUnverifiedSignature: acceptUnverified } : {}),
      ...(latePosting ? { postingDate: latePosting } : {}),
    });
  };

  // Review shortcuts (issue #315): J or N the next pending proposal, A approve, E the first account to edit. Each one
  // does only what its button would do now (A never while the step-up prompt waits for a code). The handlers are
  // computed on each render and handed to the key listener Social posts share (#1230).
  const pendingList = useQuery(orpc.inbox.list.queryOptions({ input: { status: 'pending' } }));
  const linesRef = useRef<HTMLDivElement>(null);
  const nextId = pendingList.data ? nextPendingId(pendingList.data, id) : null;
  const previousId = pendingList.data ? previousPendingId(pendingList.data, id) : null;
  const handlers: ReviewHandlers = {
    ...(nextId && nextId !== id ? { next: () => void navigate({ to: '/o/$slug/inbox/$id', params: { slug, id: nextId } }) } : {}),
    ...(previousId ? { previous: () => void navigate({ to: '/o/$slug/inbox/$id', params: { slug, id: previousId } }) } : {}),
    ...(approveReady && !stepUp ? { approve: submitApproval } : {}),
    ...(pending && item?.canEdit && !busy && payload
      ? { edit: () => linesRef.current?.querySelector<HTMLSelectElement>('select:not(:disabled)')?.focus() }
      : {}),
  };
  useReviewShortcuts(handlers);

  if (detail.isLoading) return <Spinner />;
  if (detail.error) return <ErrorText>{errorMessage(detail.error)}</ErrorText>;
  if (!item) return null;
  // A foreign-currency invoice converted at a rate is shown in VND, its amounts as booked (#918).
  const foreign = payload?.invoice.foreign ?? null;
  const currency = foreign ? 'VND' : (payload?.invoice.currency ?? 'VND');
  // Still in its own currency and waiting for the rate the accountant enters (a new revision).
  const needsRate = !!payload && !foreign && payload.invoice.currency.toUpperCase() !== 'VND';
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
          const ask = pending
            ? t('confirmRereadPending')
            : item.voided
              ? t('confirmRereadVoided')
              : item.status === 'expired'
                ? t('confirmRereadExpired')
                : t('confirmRereadOther');
          if (!window.confirm(ask)) return;
          reextract.mutate({ fileId, idempotencyKey: crypto.randomUUID() });
        }}
      >
        {reextract.isPending ? <Spinner className="text-current" /> : null}
        {t('reread')}
      </Button>
    ) : null;
  const lastRun = item.extraction;
  const lastRunFailed = lastRun !== null && lastRun.status === 'failed' && lastRun.version !== lastRun.proposalVersion;
  // After a fresh code the step-up prompt repeats the refused request as sent, not the page as it is now: if someone
  // saved a new revision meanwhile, the kernel answers STALE_REVISION instead of approving what this user never saw.
  // The same idempotency key keeps it one approval.
  const refusedVoucher = voucherProblem(approve.error);
  const refusedJournalVoucher = journalVoucherProblem(approve.error);
  const retryApproval = () => {
    if (approve.variables) approve.mutate(approve.variables);
  };

  // The proposal's actions (#1409): in the header from sm up; on a phone, in a bar fixed to the bottom while it is
  // pending, so the reviewer acts where the entry was read. One placement is rendered, so each button is on the page once.
  const headerActions = (
    pending ? (
      <>
        {item.requestedByAgent && <Badge variant="proposal">{t('agentProposed', { name: item.requestedByAgent.name })}</Badge>}
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
            {edit.isPending ? <Spinner className="text-current" /> : null}
            {t('saveEdit')}
          </Button>
        )}
        {item.canApprove && reversal && (
          <Button size="lg" disabled={!approveReady} onClick={submitApproval}>
            {approve.isPending ? <Spinner className="text-current" /> : null}
            {t('approveReversal')}
          </Button>
        )}
        {item.canApprove && voucher && (
          <Button size="lg" disabled={!approveReady} onClick={submitApproval}>
            {approve.isPending ? <Spinner className="text-current" /> : null}
            {t('approveVoucher')}
          </Button>
        )}
        {item.canApprove && journalVoucher && (
          <Button size="lg" disabled={!approveReady} onClick={submitApproval}>
            {approve.isPending ? <Spinner className="text-current" /> : null}
            {t('approveJournalVoucher')}
          </Button>
        )}
        {item.canApprove && !plain && (
          <Button size="lg" disabled={!approveReady} onClick={submitApproval}>
            {approve.isPending ? <Spinner className="text-current" /> : null}
            {t('approve')}
          </Button>
        )}
      </>
    ) : (
      <>
        {item.requestedByAgent && <Badge variant="proposal">{t('agentProposed', { name: item.requestedByAgent.name })}</Badge>}
        {reextractButton}
        {item.canResubmit && (
          <Button
            size="lg"
            disabled={busy}
            onClick={() => {
              if (!window.confirm(t('confirmResubmit'))) return;
              resubmit.mutate({ id, idempotencyKey: crypto.randomUUID() });
            }}
          >
            {resubmit.isPending ? <Spinner className="text-current" /> : null}
            {t('resubmit')}
          </Button>
        )}
        <Badge variant={item.status === 'executed' ? 'success' : item.status === 'expired' ? 'warning' : 'secondary'}>
          {item.status === 'executed'
            ? t('executedAt', { at: f.dateTime(item.decidedAt) })
            : item.status === 'rejected'
              ? t('rejected')
              : item.status === 'expired'
                ? t('expired')
                : item.status}
        </Badge>
        {item.voided && <Badge variant="destructive">{t('voidedBadge')}</Badge>}
      </>
    )
  );

  return (
    <>
      <Link to="/o/$slug/inbox" params={{ slug }} className="text-sm text-subtle-foreground hover:text-muted-foreground">
        {t('back')}
      </Link>
      <div className="mt-3">
        <PageHeader
          title={(sale ? payload?.buyer.name || null : payload?.seller.name) ?? item.title}
          subtitle={
            payload
              ? payload.invoice.series
                ? t('invoiceWithSeries', { series: payload.invoice.series, number: payload.invoice.number, date: f.date(payload.invoice.issueDate) })
                : t('invoice', { number: payload.invoice.number, date: f.date(payload.invoice.issueDate) })
              : reversal
                ? t('reversalSubtitle')
                : voucher
                  ? voucherCode
                    ? t('voucherSubtitlePosted', { type: root(`vouchers.types.${voucher.type}`), code: voucherCode, date: f.date(voucher.date) })
                    : t('voucherSubtitle', { type: root(`vouchers.types.${voucher.type}`), date: f.date(voucher.date) })
                  : journalVoucher
                    ? journalVoucherCode
                      ? t('journalVoucherSubtitlePosted', { code: journalVoucherCode, date: f.date(journalVoucher.date) })
                      : t('journalVoucherSubtitle', { date: f.date(journalVoucher.date) })
                    : undefined
          }
          actions={wide || !pending ? headerActions : undefined}
        />
      </div>
      {stepUp && (
        <div className="mb-4">
          <StepUpPrompt action={reversal ? t('stepUpApproveReversal') : voucher ? t('stepUpApproveVoucher') : journalVoucher ? t('stepUpApproveJournalVoucher') : t('stepUpApprove')} onVerified={retryApproval} onCancel={() => approve.reset()} />
        </div>
      )}
      {((approve.error && !stepUp) || reject.error || edit.error || reextract.error || resubmit.error) && (
        <div className="mb-4">
          <ErrorText>
            {reversal && approve.error && !stepUp
              ? reversalErrorMessage(approve.error, root, locale)
              : voucher && approve.error && !stepUp && refusedVoucher
                ? root(`vouchers.problems.${refusedVoucher}`)
              : journalVoucher && approve.error && !stepUp && refusedJournalVoucher
                ? root(`journalVoucher.problems.${refusedJournalVoucher}`)
              : errorMessage((stepUp ? null : approve.error) ?? reject.error ?? edit.error ?? reextract.error ?? resubmit.error)}
          </ErrorText>
        </div>
      )}
      {/* An expired proposal (#876): why it expired, and what can be done with it. */}
      {item.status === 'expired' && (
        <div className="mb-4 space-y-1 text-sm text-muted-foreground" role="status">
          <p>{t('expiredNotice', { days: item.expiredAfterDays ?? 0, at: f.dateTime(item.decidedAt) })}</p>
          {item.resubmittedAs ? (
            <p>
              {t('resubmittedAs')}{' '}
              <Link to="/o/$slug/inbox/$id" params={{ slug, id: item.resubmittedAs }} className="text-link underline">
                {t('openResubmitted')}
              </Link>
            </p>
          ) : (
            <p>{item.canResubmit ? t('expiredResubmitHint') : t('expiredAuthorHint')}</p>
          )}
        </div>
      )}
      {item.resubmittedFrom && (
        <p className="mb-4 text-sm text-muted-foreground">
          {t('resubmittedFrom')}{' '}
          <Link to="/o/$slug/inbox/$id" params={{ slug, id: item.resubmittedFrom }} className="text-link underline">
            {t('openExpired')}
          </Link>
        </p>
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
      {voucher && (
        <div className="mb-6">
          {pending && !item.canApprove && item.approveReason === 'four_eyes' && <p className="mb-4 text-sm text-muted-foreground">{t('voucherFourEyes')}</p>}
          {pending && !item.canApprove && item.approveReason === 'not_eligible' && (
            <p className="mb-4 text-sm text-subtle-foreground">{t('voucherNotEligible')}</p>
          )}
          <VoucherCard voucher={voucher} code={voucherCode} slug={slug} accountName={accountName} />
        </div>
      )}
      {journalVoucher && (
        <div className="mb-6">
          {pending && !item.canApprove && item.approveReason === 'four_eyes' && <p className="mb-4 text-sm text-muted-foreground">{t('voucherFourEyes')}</p>}
          {pending && !item.canApprove && item.approveReason === 'not_eligible' && (
            <p className="mb-4 text-sm text-subtle-foreground">{t('voucherNotEligible')}</p>
          )}
          <JournalVoucherCard voucher={journalVoucher} code={journalVoucherCode} slug={slug} accountName={accountName} />
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
      {/* A phone has no keyboard for them (#1409). */}
      {wide && pending && (item.canApprove || item.canEdit) && <p className="mb-4 text-xs text-subtle-foreground">{t('shortcuts')}</p>}
      {pending && dirty && (
        <p className="mb-4 text-sm text-muted-foreground">{t('dirty')}</p>
      )}
      {pending && !plain && !dirty && item.approveReason === 'four_eyes' && (
        <p className="mb-4 text-sm text-muted-foreground">{t('fourEyes')}</p>
      )}
      {pending && !plain && !dirty && item.approveReason === 'not_eligible' && (
        <p className="mb-4 text-sm text-subtle-foreground">{t('notEligible')}</p>
      )}
      {pending && blocked && (
        <div className="mb-4">
          <ErrorText>
            {payload?.checks.some((c) => c.status === 'fail' && c.id === 'amount_scale')
              ? t('blockedBelowDong')
              : payload?.extractionMethod === 'einvoice_xml'
                ? t('blockedXml')
                : t('blockedAi')}
          </ErrorText>
        </div>
      )}
      {!plain && unverified && (
        <Card className="mb-4 block space-y-2 border border-destructive/60 p-4 ring-0" data-testid="signature-unverified">
          <p className="text-sm font-medium text-foreground">{t('signatureUnverifiedTitle')}</p>
          <p className="text-sm text-muted-foreground">{signatureCheck ? invoiceCheckMessage(signatureCheck, root, { money, date: f.date }) : t('signatureUnverifiedTitle')}</p>
          <p className="text-sm text-muted-foreground">{t('signatureUnverifiedHint')}</p>
          {pending && item.canApprove && (
            <Label className="font-normal text-muted-foreground">
              <Checkbox checked={acceptUnverified} onCheckedChange={(checked) => setAcceptUnverifiedRevision(checked ? item.revision : null)} />
              {t('acceptUnverified')}
            </Label>
          )}
        </Card>
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

      {pending && (invoiceLocked || invoiceBeforeOpening) && payload && firstOpenDay && (
        <Card className="mb-4 block space-y-3 border border-warning/60 p-4 ring-0" data-testid="late-posting">
          {invoiceLocked && lockedThrough ? (
            <>
              <p className="text-sm font-medium text-foreground">{t('lateTitle', { through: f.date(lockedThrough) })}</p>
              <p className="text-sm text-muted-foreground">{t('lateNotice', { date: f.date(payload.invoice.issueDate) })}</p>
            </>
          ) : (
            <>
              <p className="text-sm font-medium text-foreground">{t('lateTitleOpening', { date: f.date(openingDate ?? '') })}</p>
              <p className="text-sm text-muted-foreground">{t('lateNoticeOpening', { date: f.date(payload.invoice.issueDate) })}</p>
            </>
          )}
          {item.canApprove && (
            <Label className="font-normal text-muted-foreground">
              <Checkbox checked={postLate} disabled={busy} onCheckedChange={(checked) => setPostLate(checked)} />
              {invoiceLocked ? t('latePost') : t('latePostOpening')}
            </Label>
          )}
          {item.canApprove && postLate && (
            <div className="space-y-1">
              <Label htmlFor="posting-date">{t('lateDate')}</Label>
              <DateInput
                id="posting-date"
                className="w-44"
                min={firstOpenDay}
                max={vietnamToday()}
                disabled={busy}
                value={chosenPostingDate ?? ''}
                onChange={setPostingDate}
              />
              <p className="text-xs text-subtle-foreground">{t('lateHint', { date: f.date(payload.invoice.issueDate) })}</p>
              {!latePostingValid && <p className="text-sm text-destructive">{t('lateDateInvalid', { from: f.date(firstOpenDay) })}</p>}
            </div>
          )}
        </Card>
      )}
      {item.status === 'executed' && payload && item.result?.postingDate && (
        <p className="mb-4 text-sm text-muted-foreground" data-testid="late-posted">
          {t('latePosted', { date: f.date(item.result.postingDate), invoiceDate: f.date(payload.invoice.issueDate) })}
        </p>
      )}
      {sale && <p className="mb-4 text-sm text-muted-foreground">{t('saleNotice')}</p>}
      <div className="grid gap-6 lg:grid-cols-5">
        <div className="min-w-0 space-y-6 lg:col-span-3">
          {payload && (
            <Card className="grid gap-4 p-4 sm:grid-cols-2">
              <div>
                <p className="text-xs text-subtle-foreground">{sale ? t('sellerOwn') : t('seller')}</p>
                <p className="mt-1 text-sm font-medium text-foreground">{payload.seller.name}</p>
                <p className="text-xs text-muted-foreground">{t('taxCode', { code: payload.seller.taxCode ?? t('noTaxCode') })}</p>
                <p className="text-xs text-subtle-foreground">{payload.seller.address}</p>
              </div>
              <div>
                <p className="text-xs text-subtle-foreground">{sale ? t('customer') : t('buyer')}</p>
                <p className="mt-1 text-sm font-medium text-foreground">{payload.buyer.name || t('notStated')}</p>
                <p className="text-xs text-muted-foreground">{t('taxCode', { code: payload.buyer.taxCode ?? t('noTaxCode') })}</p>
                {/* The customer on the customers screen (#670), found by its tax code, else its name. */}
                {sale && partySearch(payload.buyer) && (
                  <Link to="/o/$slug/customers" params={{ slug }} search={{ q: partySearch(payload.buyer) }} className="mt-1 inline-block text-xs text-link hover:underline">
                    {t('viewCustomer')}
                  </Link>
                )}
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
                {foreign ? (
                  <p className="text-xs text-subtle-foreground sm:col-span-3">
                    {t(foreign.source === 'entered' ? 'foreignEntered' : 'foreignInvoice', {
                      currency: foreign.currency,
                      total: f.money(foreign.total, foreign.currency),
                      rate: f.number(foreign.rate),
                    })}
                  </p>
                ) : (
                  <p className="text-xs text-subtle-foreground sm:col-span-3">{t('currency', { currency })}</p>
                )}
                {needsRate && pending && item?.canEdit && (
                  <form
                    className="flex flex-wrap items-end gap-2 sm:col-span-3"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (!item || !enteredRate) return;
                      edit.mutate({ id, revision: item.revision, idempotencyKey: crypto.randomUUID(), exchangeRate: enteredRate });
                    }}
                  >
                    <Label className="text-xs">
                      {t('exchangeRate', { currency: payload.invoice.currency })}
                      <Input className="mt-1 w-40" inputMode="decimal" value={exchangeRate} onChange={(e) => setExchangeRate(e.target.value)} placeholder="25450" />
                    </Label>
                    <Button type="submit" variant="outline" size="sm" disabled={busy || !enteredRate}>
                      {t('saveExchangeRate')}
                    </Button>
                    {exchangeRate.trim() !== '' && (
                      <p className={enteredRate ? 'w-full text-xs text-muted-foreground' : 'w-full text-xs text-destructive'} aria-live="polite">
                        {enteredRate ? t('exchangeRateRead', { rate: f.number(enteredRate), currency: payload.invoice.currency }) : t('exchangeRateInvalid')}
                      </p>
                    )}
                    <p className="w-full text-xs text-subtle-foreground">{t('exchangeRateHint')}</p>
                  </form>
                )}
              </div>
            </Card>
          )}

          {payload && (
            <Card className="block p-4">
              <p className="text-sm font-medium text-muted-foreground">{t('checks')}</p>
              <ul className="mt-3 space-y-1.5">
                {checksByConcern(payload.checks).map((c) => (
                  <li key={c.id} className="flex items-start gap-2 text-sm">
                    <Badge variant={CHECK_TONE[c.status]}>{CHECK_ICON[c.status]}</Badge>
                    <span className="text-muted-foreground">{invoiceCheckMessage(c, root, { money, date: f.date })}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {payload && (
            <Card ref={linesRef} className="block overflow-x-auto p-4">
              <p className="text-sm font-medium text-muted-foreground">{t('lines')}</p>
              <table className="mt-3 w-full min-w-[560px] text-sm">
                <thead className="text-left text-xs text-subtle-foreground">
                  <tr>
                    <th className="py-1.5 pr-2 font-medium">{t('description')}</th>
                    <th className="py-1.5 pr-2 text-right font-medium">{t('amount')}</th>
                    <th className="py-1.5 font-medium">{sale ? t('revenueAccount') : t('debitAccount')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {lines.map((l) => (
                    <tr key={l.lineNo}>
                      <td className="py-2 pr-2 text-foreground">
                        {l.description}
                        {/* What chose the account (#1399): a learned rule, the vendor's default, the built-in keywords or a user. */}
                        <p className="text-xs text-subtle-foreground">
                          {l.accountRule && <Badge variant="secondary" className="mr-1.5">{t(`accountRuleSource.${l.accountRule.source}`)}</Badge>}
                          {l.accountRule?.source === 'user' ? null : l.reason}
                        </p>
                      </td>
                      <td className="py-2 pr-2 text-right text-foreground tabular-nums">{money(l.amount)}</td>
                      <td className="py-2">
                        <NativeSelect
                          size="sm"
                          disabled={!item.canEdit || busy}
                          aria-label={sale ? t('revenueAccountFor', { line: String(l.lineNo) }) : t('debitAccountFor', { line: String(l.lineNo) })}
                          className="w-48"
                          value={l.debitAccount}
                          onChange={(e) => setLineAccounts((prev) => ({ ...prev, [l.lineNo]: e.target.value }))}
                        >
                          {/* Accounts in use that fit the direction (#430), plus the line's own even if it was deactivated since (#319). */}
                          {pickableAccounts(accounts.data ?? [], l.debitAccount, sale ? 'sale' : 'purchase').map((a) => (
                            <NativeSelectOption key={a.code} value={a.code}>
                              {accountLabel(a)}
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
            <Card className={pending ? 'block border border-dashed border-proposal/60 p-4 ring-0' : 'block p-4'}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-medium text-muted-foreground">{t('journal')}</p>
                {pending && <Badge variant="proposal">{t('proposedNotPosted')}</Badge>}
              </div>
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
        {/* A reversal or a voucher has no source file; its card above shows what it posts. */}
        {!plain && (
          <div className="min-w-0 lg:col-span-2">
            <Card className="block p-4">
              <p className="mb-3 text-sm font-medium text-muted-foreground">{t('original')}</p>
              {item.file ? <FilePreview fileId={item.file.id} contentType={item.file.contentType} filename={item.file.filename} /> : <p className="text-sm text-subtle-foreground">{t('noFile')}</p>}
            </Card>
          </div>
        )}
      </div>
      <ProposalTimeline id={item.id} documentId={item.status === 'executed' ? (item.result?.documentId ?? null) : null} />
      {!wide && pending && (
        <>
          {/* Room for the bar below, so the last of the page is not hidden under it. */}
          <div aria-hidden="true" className="h-20" />
          <div className="fixed inset-x-0 bottom-0 z-20 flex flex-wrap items-center justify-end gap-2 border-t bg-sidebar px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            {headerActions}
          </div>
        </>
      )}
    </>
  );
}

// What happened to the document (#672): received, read, proposed, edited, approved or rejected, recorded, reversed,
// and the exports it went out in (#878), oldest first, with who did it. The stream's proposal hints refresh it with the
// rest of the Inbox.
function ProposalTimeline({ id, documentId }: { id: string; documentId: string | null }) {
  const t = useTranslations('inboxDetail');
  const f = useFormat();
  const timeline = useQuery(orpc.inbox.timeline.queryOptions({ input: { id } }));
  const exports = useQuery({ ...orpc.documents.exports.queryOptions({ input: { documentId: documentId ?? '' } }), enabled: documentId !== null && getConfig().modules.includes('finance') });
  const range = (from: string | null, to: string | null) =>
    from && to ? t('exportRange', { from: f.date(from), to: f.date(to) }) : from ? t('exportFrom', { from: f.date(from) }) : to ? t('exportTo', { to: f.date(to) }) : t('exportAll');
  const items = [
    ...(timeline.data?.items ?? []).map((e) => ({ id: e.id, at: e.at, summary: e.summary, actorType: e.actorType, actorName: e.actorName })),
    ...(exports.data ?? []).map((e) => ({
      id: `export:${e.id}`,
      at: e.at,
      summary: t('exported', { file: t(`exportFormats.${e.format}`), range: range(e.from, e.to) }),
      actorType: 'user' as const,
      actorName: e.actorName,
    })),
  ].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  return (
    <Card className="mt-6 block p-4" data-testid="timeline">
      <p className="mb-3 text-sm font-medium text-muted-foreground">{t('timeline')}</p>
      {timeline.isLoading ? (
        <Spinner />
      ) : timeline.error ? (
        <ErrorText>{errorMessage(timeline.error)}</ErrorText>
      ) : items.length === 0 ? (
        <p className="text-sm text-subtle-foreground">{t('timelineEmpty')}</p>
      ) : (
        <>
          {timeline.data?.more && <p className="mb-2 text-xs text-subtle-foreground">{t('timelineMore')}</p>}
          <ol className="space-y-2 border-l pl-4">
            {items.map((e) => (
              <li key={e.id} className="text-sm">
                <p className="text-foreground">{e.summary}</p>
                <p className="text-xs text-subtle-foreground">
                  {f.dateTime(e.at)} · {e.actorType === 'system' ? t('timelineSystem') : (e.actorName ?? t('timelineFormer'))}
                  {e.actorType === 'agent' ? ` (${t('timelineAgent')})` : ''}
                </p>
              </li>
            ))}
          </ol>
        </>
      )}
    </Card>
  );
}
