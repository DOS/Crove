import { keepPreviousData, useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import {
  VOUCHER_MAX_LINES,
  VOUCHER_TYPES,
  cashRootOf,
  defaultCounterAccount,
  isInflow,
  type BankLineVoucher,
  type VoucherCursor,
  type VoucherType,
} from '@crove/kernel-contract';
import { Alert, AlertDescription } from '@crove/ui/components/alert';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Input } from '@crove/ui/components/input';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { TableCell, TableRow } from '@crove/ui/components/table';
import { AmountInput } from '../components/amount-input.tsx';
import { DateInput } from '../components/date-input.tsx';
import { useChosenEntity } from '../components/entity-switcher.tsx';
import { DataTable, Empty, ErrorText, PageHeader, Spinner, TableSkeleton } from '../components/ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { apiFetch, errorMessage, getCurrentOrg, orpc, queryClient } from '../lib/api.ts';
import { exportQuery } from '../lib/legal-entity-choice.ts';
import { accountLabel, pickableAccounts } from '../lib/accounts.ts';
import { isZeroAmount } from '../lib/decimal.ts';
import { localToday } from '../lib/reversal.ts';
import {
  canEnterVoucher,
  cashAccountChoices,
  nextVoucherCursor,
  normalizeAmount,
  previewVoucherJournal,
  voucherFormError,
  voucherProblem,
  voucherTotal,
  type VoucherForm,
} from '../lib/vouchers.ts';

interface Line {
  key: string;
  account: string;
  amount: string;
  memo: string;
}

const newLine = (account: string): Line => ({ key: crypto.randomUUID(), account, amount: '', memo: '' });

// Enters a phiếu thu, phiếu chi, báo Có or báo Nợ (#327) as a proposal; an owner or admin approves it in the Inbox (R3,
// four-eyes, fresh MFA), which numbers it and posts its entry. From a bank statement line (#326, fromLine: what
// finance.bank.line_voucher answered), the form is a báo Có or báo Nợ whose type, date, bank account and total follow the
// line, with the suggested party chosen; the proposal names the line.
export function VoucherFormCard({ slug, onClose, fromLine }: { slug: string; onClose: () => void; fromLine?: BankLineVoucher }) {
  const root = useTranslations();
  const t = useTranslations('vouchers');
  const f = useFormat();
  const accounts = useQuery(orpc.accounts.list.queryOptions());
  const parties = useQuery(orpc.parties.list.queryOptions({ input: { all: true } }));
  const prefill = fromLine?.voucher ?? null;
  const [type, setType] = useState<VoucherType>(prefill?.type ?? 'cash_payment');
  const [date, setDate] = useState(() => prefill?.date ?? localToday());
  const [cashAccount, setCashAccount] = useState(prefill ? (fromLine?.bankAccount ?? '') : '');
  const [partyId, setPartyId] = useState(fromLine?.suggested?.party.id ?? '');
  const [personName, setPersonName] = useState('');
  const [description, setDescription] = useState(prefill?.description ?? '');
  const [lines, setLines] = useState<Line[]>(() =>
    prefill ? [{ ...newLine(prefill.counterAccount), amount: prefill.amount }] : [newLine(defaultCounterAccount('cash_payment'))],
  );
  const [touched, setTouched] = useState(false);
  // One key per form: a retry of the same request returns the same proposal.
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const request = useMutation(orpc.inbox.request.mutationOptions({ onSettled: () => void queryClient.invalidateQueries() }));
  // The voucher goes to the books of the entity chosen in the shell (#1280); one from a statement line is in the
  // line's entity, the one its list was read in.
  const entity = useChosenEntity();

  const chart = accounts.data ?? [];
  // A voucher from a statement line keeps the line's bank account, even one no longer in use.
  const cashChoices = prefill ? chart.filter((a) => a.code === cashAccount) : cashAccountChoices(chart, type);
  // The first cash or bank account in use until the user picks one.
  const cash = prefill ? cashAccount : cashChoices.some((a) => a.code === cashAccount) ? cashAccount : (cashChoices[0]?.code ?? '');
  const form: VoucherForm = { type, date, cashAccount: cash, partyId, description, lines: lines.map((l) => ({ account: l.account, amount: l.amount })) };
  const total = voucherTotal(form.lines);
  const problem = voucherFormError(form, root) ?? (prefill && total !== prefill.amount ? t('form.lineTotal', { amount: f.money(prefill.amount) }) : null);
  const journal = previewVoucherJournal(form);
  const accountName = (code: string) => chart.find((a) => a.code === code)?.name ?? '';
  const inflow = isInflow(type);
  const refusedProblem = voucherProblem(request.error);

  const changeType = (next: VoucherType) => {
    // The usual counter account follows the type while the user has not changed it.
    setLines((current) => current.map((l) => (l.account === defaultCounterAccount(type) ? { ...l, account: defaultCounterAccount(next) } : l)));
    setType(next);
  };
  const setLine = (key: string, patch: Partial<Line>) => setLines((current) => current.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  if (request.data) {
    return (
      <Alert className="mb-6">
        <AlertDescription>
          {t('form.created', { type: t(`types.${type}`) })}{' '}
          <Link to="/o/$slug/inbox/$id" params={{ slug, id: request.data.proposalId }} className="text-link underline">
            {t('form.viewProposal')}
          </Link>{' '}
          {fromLine ? (
            // One voucher per statement line: the bank screen now shows it as waiting for approval.
            <button type="button" className="text-link underline" onClick={onClose}>
              {t('form.close')}
            </button>
          ) : (
            <button
              type="button"
              className="text-link underline"
              onClick={() => {
                request.reset();
                setIdempotencyKey(crypto.randomUUID());
                setDescription('');
                setPersonName('');
                setLines([newLine(defaultCounterAccount(type))]);
                setTouched(false);
              }}
            >
              {t('form.another')}
            </button>
          )}
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <Card className="mb-6 block p-4">
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          setTouched(true);
          if (problem || !entity.ready) return;
          request.mutate({
            command: 'finance.voucher.record',
            idempotencyKey,
            input: {
              type,
              date,
              cashAccount: cash,
              partyId: partyId || null,
              ...(personName.trim() ? { personName: personName.trim() } : {}),
              description: description.trim(),
              lines: lines.map((l) => ({ account: l.account, amount: normalizeAmount(l.amount), ...(l.memo.trim() ? { memo: l.memo.trim() } : {}) })),
              ...(fromLine ? { bankLineId: fromLine.line.id } : {}),
              legalEntityId: entity.legalEntityId,
            },
          });
        }}
      >
        <p className="text-sm text-muted-foreground">{t('form.intro')}</p>
        {fromLine && prefill && (
          <p className="text-sm text-foreground">{t('form.fromLine', { date: f.date(prefill.date), amount: f.money(fromLine.line.amount.replace(/^-/, '')) })}</p>
        )}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <div className="text-xs">
            <label className="block">
              <span className="text-subtle-foreground">{t('form.type')}</span>
              <NativeSelect className="mt-1 w-full" value={type} disabled={prefill !== null} onChange={(e) => changeType(e.target.value as VoucherType)}>
                {VOUCHER_TYPES.map((v) => (
                  <NativeSelectOption key={v} value={v}>
                    {t(`types.${v}`)}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </label>
            <p className="mt-1 text-subtle-foreground">{t(`typeHints.${type}`)}</p>
          </div>
          <label className="block text-xs">
            <span className="text-subtle-foreground">{t('form.date')}</span>
            <DateInput required value={date} disabled={prefill !== null} onChange={setDate} className="mt-1 w-full" />
          </label>
          <div className="text-xs">
            <label className="block">
              <span className="text-subtle-foreground">{cashRootOf(type) === '111' ? t('form.cashAccountCash') : t('form.cashAccountBank')}</span>
              <NativeSelect className="mt-1 w-full" value={cash} disabled={prefill !== null} onChange={(e) => setCashAccount(e.target.value)}>
                {cashChoices.map((a) => (
                  <NativeSelectOption key={a.code} value={a.code}>
                    {accountLabel(a)}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </label>
            {accounts.data && cashChoices.length === 0 && <p className="mt-1 text-warning">{t('form.noCashAccount', { root: cashRootOf(type) })}</p>}
          </div>
          <div className="text-xs">
            <label className="block">
              <span className="text-subtle-foreground">{t('form.party')}</span>
              <NativeSelect className="mt-1 w-full" value={partyId} onChange={(e) => setPartyId(e.target.value)}>
                <NativeSelectOption value="">{t('form.noParty')}</NativeSelectOption>
                {(parties.data ?? []).map((p) => (
                  <NativeSelectOption key={p.id} value={p.id}>
                    {p.taxCode ? `${p.name} (${p.taxCode})` : p.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </label>
            <p className="mt-1 text-subtle-foreground">{t('form.partyHint')}</p>
            {fromLine?.suggested ? (
              <p className="mt-1 text-foreground">
                {t('form.suggested', {
                  name: fromLine.suggested.party.name,
                  reason: t(`reasons.${fromLine.suggested.reason}`, { number: fromLine.suggested.invoice?.number ?? '' }),
                })}
              </p>
            ) : fromLine && fromLine.candidates.length > 1 ? (
              <p className="mt-1 text-foreground">{t('form.candidates', { names: fromLine.candidates.map((c) => c.party.name).join(', ') })}</p>
            ) : null}
          </div>
          <label className="block text-xs">
            <span className="text-subtle-foreground">{inflow ? t('form.personPayer') : t('form.personPayee')}</span>
            <Input maxLength={200} value={personName} onChange={(e) => setPersonName(e.target.value)} placeholder={t('form.personHint')} className="mt-1 w-full" />
          </label>
          <label className="block text-xs">
            <span className="text-subtle-foreground">{inflow ? t('form.descriptionReceipt') : t('form.descriptionPayment')}</span>
            <Input
              required
              maxLength={300}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('form.descriptionPlaceholder')}
              className="mt-1 w-full"
            />
          </label>
        </div>

        <div>
          <p className="text-xs font-medium tracking-wide uppercase text-subtle-foreground">{t('form.lines')}</p>
          <div className="mt-2 space-y-2">
            {lines.map((l, i) => (
              <div key={l.key} className="grid gap-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,2fr)_auto]">
                <NativeSelect
                  aria-label={t('form.lineAccountFor', { line: String(i + 1) })}
                  className="w-full"
                  value={l.account}
                  onChange={(e) => setLine(l.key, { account: e.target.value })}
                >
                  {pickableAccounts(chart, l.account).map((a) => (
                    <NativeSelectOption key={a.code} value={a.code}>
                      {accountLabel(a)}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
                <AmountInput
                  aria-label={t('form.lineAmountFor', { line: String(i + 1) })}
                  placeholder={t('form.lineAmount')}
                  value={l.amount}
                  onChange={(amount) => setLine(l.key, { amount })}
                  className="w-full text-right tabular-nums"
                />
                <Input
                  maxLength={300}
                  aria-label={t('form.lineMemoFor', { line: String(i + 1) })}
                  placeholder={t('form.lineMemoPlaceholder')}
                  value={l.memo}
                  onChange={(e) => setLine(l.key, { memo: e.target.value })}
                  className="w-full"
                />
                <Button
                  type="button"
                  variant="ghost"
                  disabled={lines.length === 1}
                  aria-label={t('form.removeLine', { line: String(i + 1) })}
                  onClick={() => setLines((current) => current.filter((x) => x.key !== l.key))}
                >
                  ✕
                </Button>
              </div>
            ))}
          </div>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={lines.length >= VOUCHER_MAX_LINES}
              onClick={() => setLines((current) => [...current, newLine(defaultCounterAccount(type))])}
            >
              {t('form.addLine')}
            </Button>
            <p className="text-sm font-medium text-foreground tabular-nums">{t('form.total', { amount: f.money(total) })}</p>
          </div>
        </div>

        {!problem && (
          <div>
            <p className="text-xs font-medium tracking-wide uppercase text-subtle-foreground">{t('form.preview')}</p>
            <table className="mt-2 w-full text-sm">
              <tbody className="divide-y">
                {journal.map((j, i) => (
                  <tr key={`${i}-${j.accountCode}`}>
                    <td className="py-1.5 text-foreground">
                      <span className="font-mono">{j.accountCode}</span> <span className="text-subtle-foreground">{accountName(j.accountCode)}</span>
                    </td>
                    <td className="w-36 py-1.5 text-right tabular-nums">{isZeroAmount(j.debit) ? '' : f.money(j.debit)}</td>
                    <td className="w-36 py-1.5 text-right tabular-nums">{isZeroAmount(j.credit) ? '' : f.money(j.credit)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {touched && problem && <ErrorText>{problem}</ErrorText>}
        {request.error && <ErrorText>{refusedProblem ? t(`problems.${refusedProblem}`) : errorMessage(request.error)}</ErrorText>}
        <div className="flex gap-2">
          <Button type="submit" disabled={request.isPending}>
            {request.isPending ? <Spinner className="text-current" /> : null}
            {t('form.submit')}
          </Button>
          <Button type="button" variant="ghost" onClick={onClose} disabled={request.isPending}>
            {root('common.cancel')}
          </Button>
        </div>
      </form>
    </Card>
  );
}

// The cash and bank vouchers of the org (#327): every posted phiếu thu, phiếu chi, báo Có and báo Nợ, newest first.
export function VouchersPage() {
  const t = useTranslations('vouchers');
  const f = useFormat();
  const { slug } = useParams({ strict: false }) as { slug: string };
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [type, setType] = useState<VoucherType | ''>('');
  const [entering, setEntering] = useState(false);
  const org = useQuery(orpc.org.get.queryOptions());
  // The vouchers of the entity chosen in the shell (#1280).
  const entity = useChosenEntity();
  const filters = { ...(from ? { from } : {}), ...(to ? { to } : {}), ...(type ? { type } : {}), legalEntityId: entity.legalEntityId };
  // A page at a time (the server sends at most VOUCHER_PAGE_SIZE); Load more asks for the vouchers after the last one.
  const vouchers = useInfiniteQuery({
    ...orpc.vouchers.list.infiniteOptions({
      input: (before: VoucherCursor | undefined) => ({ ...filters, ...(before ? { before } : {}) }),
      initialPageParam: undefined as VoucherCursor | undefined,
      getNextPageParam: nextVoucherCursor,
      placeholderData: keepPreviousData,
    }),
    enabled: entity.ready,
  });
  const rows = vouchers.data?.pages.flatMap((p) => p.items) ?? [];
  const allowed = canEnterVoucher(org.data?.role);
  // Cash receipts and payments of the chosen dates in MISA SME's import templates, one file per type (#657).
  const exportMisa = useMutation({
    mutationFn: async (kind: 'receipts' | 'payments') => {
      const params = exportQuery({ ...(from ? { from } : {}), ...(to ? { to } : {}) }, entity.legalEntityId);
      const response = await apiFetch(`/api/export/misa/${kind}.xlsx?${params}`);
      const url = URL.createObjectURL(await response.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = t(kind === 'receipts' ? 'exportReceiptsFile' : 'exportPaymentsFile', { org: getCurrentOrg() ?? 'org' });
      a.click();
      URL.revokeObjectURL(url);
    },
  });

  return (
    <>
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button size="lg" variant="outline" onClick={() => exportMisa.mutate('receipts')} disabled={exportMisa.isPending}>
              {exportMisa.isPending && exportMisa.variables === 'receipts' ? <Spinner className="text-current" /> : null}
              {t('exportReceipts')}
            </Button>
            <Button size="lg" variant="outline" onClick={() => exportMisa.mutate('payments')} disabled={exportMisa.isPending}>
              {exportMisa.isPending && exportMisa.variables === 'payments' ? <Spinner className="text-current" /> : null}
              {t('exportPayments')}
            </Button>
            {allowed && !entering && (
              <Button size="lg" onClick={() => setEntering(true)}>
                {t('new')}
              </Button>
            )}
          </div>
        }
      />
      {exportMisa.error && (
        <div className="mb-4">
          <ErrorText>{errorMessage(exportMisa.error)}</ErrorText>
        </div>
      )}
      {entering && <VoucherFormCard slug={slug} onClose={() => setEntering(false)} />}
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <label className="text-xs">
          <span className="text-subtle-foreground">{t('filterType')}</span>
          <NativeSelect className="mt-1 w-48" value={type} onChange={(e) => setType(e.target.value as VoucherType | '')}>
            <NativeSelectOption value="">{t('allTypes')}</NativeSelectOption>
            {VOUCHER_TYPES.map((v) => (
              <NativeSelectOption key={v} value={v}>
                {t(`types.${v}`)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </label>
        <label className="text-xs">
          <span className="text-subtle-foreground">{t('from')}</span>
          <DateInput value={from} onChange={setFrom} className="mt-1 w-44" />
        </label>
        <label className="text-xs">
          <span className="text-subtle-foreground">{t('to')}</span>
          <DateInput value={to} onChange={setTo} className="mt-1 w-44" />
        </label>
      </div>
      {vouchers.isPending ? (
        <TableSkeleton columns={5} />
      ) : vouchers.error && rows.length === 0 ? (
        <ErrorText>{errorMessage(vouchers.error)}</ErrorText>
      ) : rows.length === 0 ? (
        <Empty title={t('empty')} hint={t('emptyHint')} />
      ) : (
        <>
          <DataTable
            head={[t('columns.number'), t('columns.date'), t('columns.party'), t('columns.description'), t('columns.account'), t('columns.amount'), t('columns.status')]}
          >
            {rows.map((v) => (
              <TableRow key={v.id}>
                <TableCell className="px-4 py-3">
                  <span className="font-mono font-medium text-foreground">{v.code}</span>
                  <p className="text-xs text-subtle-foreground">{t(`types.${v.type}`)}</p>
                </TableCell>
                <TableCell className="px-4 py-3 text-muted-foreground">{f.date(v.date)}</TableCell>
                <TableCell className="px-4 py-3 text-foreground">
                  {v.party?.name ?? ''}
                  {v.personName && <p className="text-xs text-subtle-foreground">{v.personName}</p>}
                </TableCell>
                <TableCell className="px-4 py-3 text-foreground">{v.description}</TableCell>
                <TableCell className="px-4 py-3 font-mono text-muted-foreground">{v.cashAccount}</TableCell>
                <TableCell className="px-4 py-3 text-right text-foreground tabular-nums">{f.money(v.amount)}</TableCell>
                <TableCell className="px-4 py-3">
                  {v.reversal ? (
                    <Badge variant="warning">{t('reversed', { date: f.date(v.reversal.entryDate) })}</Badge>
                  ) : (
                    <Badge variant="success">{t('posted')}</Badge>
                  )}
                  {v.journalEntryId && (
                    <Link to="/o/$slug/journal" params={{ slug }} hash={`entry-${v.journalEntryId}`} className="mt-1 block text-xs text-link hover:underline">
                      {t('viewEntry')}
                    </Link>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </DataTable>
          {/* A failed page or background refetch keeps the vouchers already shown; its error shows here, by Load more. */}
          {vouchers.error && (
            <div className="mt-3">
              <ErrorText>{errorMessage(vouchers.error)}</ErrorText>
            </div>
          )}
          {vouchers.hasNextPage && (
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <p className="text-xs text-muted-foreground">{t('more', { count: rows.length })}</p>
              <Button variant="outline" size="sm" disabled={vouchers.isFetchingNextPage} onClick={() => void vouchers.fetchNextPage()}>
                {t('loadMore')}
              </Button>
            </div>
          )}
        </>
      )}
    </>
  );
}
