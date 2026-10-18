import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { VOUCHER_MAX_LINES, VOUCHER_TYPES, cashRootOf, defaultCounterAccount, isInflow, type VoucherType } from '@crove/kernel-contract';
import { Alert, AlertDescription } from '@crove/ui/components/alert';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Input } from '@crove/ui/components/input';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { TableCell, TableRow } from '@crove/ui/components/table';
import { DataTable, Empty, ErrorText, PageHeader, Spinner } from '../components/ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';
import { accountLabel, pickableAccounts } from '../lib/accounts.ts';
import { isZeroAmount } from '../lib/decimal.ts';
import { localToday } from '../lib/reversal.ts';
import {
  canEnterVoucher,
  cashAccountChoices,
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
// four-eyes, fresh MFA), which numbers it and posts its entry.
function VoucherFormCard({ slug, onClose }: { slug: string; onClose: () => void }) {
  const root = useTranslations();
  const t = useTranslations('vouchers');
  const f = useFormat();
  const accounts = useQuery(orpc.accounts.list.queryOptions());
  const parties = useQuery(orpc.parties.list.queryOptions({ input: { all: true } }));
  const [type, setType] = useState<VoucherType>('cash_payment');
  const [date, setDate] = useState(localToday);
  const [cashAccount, setCashAccount] = useState('');
  const [partyId, setPartyId] = useState('');
  const [personName, setPersonName] = useState('');
  const [description, setDescription] = useState('');
  const [lines, setLines] = useState<Line[]>(() => [newLine(defaultCounterAccount('cash_payment'))]);
  const [touched, setTouched] = useState(false);
  // One key per form: a retry of the same request returns the same proposal.
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const request = useMutation(orpc.inbox.request.mutationOptions({ onSettled: () => void queryClient.invalidateQueries() }));

  const chart = accounts.data ?? [];
  const cashChoices = cashAccountChoices(chart, type);
  // The first cash or bank account in use until the user picks one.
  const cash = cashChoices.some((a) => a.code === cashAccount) ? cashAccount : (cashChoices[0]?.code ?? '');
  const form: VoucherForm = { type, date, cashAccount: cash, partyId, description, lines: lines.map((l) => ({ account: l.account, amount: l.amount })) };
  const problem = voucherFormError(form, root);
  const total = voucherTotal(form.lines);
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
          if (problem) return;
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
            },
          });
        }}
      >
        <p className="text-sm text-muted-foreground">{t('form.intro')}</p>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <label className="block text-xs">
            <span className="text-subtle-foreground">{t('form.type')}</span>
            <NativeSelect className="mt-1 w-full" value={type} onChange={(e) => changeType(e.target.value as VoucherType)}>
              {VOUCHER_TYPES.map((v) => (
                <NativeSelectOption key={v} value={v}>
                  {t(`types.${v}`)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <span className="mt-1 block text-subtle-foreground">{t(`typeHints.${type}`)}</span>
          </label>
          <label className="block text-xs">
            <span className="text-subtle-foreground">{t('form.date')}</span>
            <Input type="date" required value={date} onChange={(e) => setDate(e.target.value)} className="mt-1 w-full" />
          </label>
          <label className="block text-xs">
            <span className="text-subtle-foreground">{cashRootOf(type) === '111' ? t('form.cashAccountCash') : t('form.cashAccountBank')}</span>
            <NativeSelect className="mt-1 w-full" value={cash} onChange={(e) => setCashAccount(e.target.value)}>
              {cashChoices.map((a) => (
                <NativeSelectOption key={a.code} value={a.code}>
                  {accountLabel(a)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            {accounts.data && cashChoices.length === 0 && <span className="mt-1 block text-warning">{t('form.noCashAccount', { root: cashRootOf(type) })}</span>}
          </label>
          <label className="block text-xs">
            <span className="text-subtle-foreground">{t('form.party')}</span>
            <NativeSelect className="mt-1 w-full" value={partyId} onChange={(e) => setPartyId(e.target.value)}>
              <NativeSelectOption value="">{t('form.noParty')}</NativeSelectOption>
              {(parties.data ?? []).map((p) => (
                <NativeSelectOption key={p.id} value={p.id}>
                  {p.taxCode ? `${p.name} (${p.taxCode})` : p.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <span className="mt-1 block text-subtle-foreground">{t('form.partyHint')}</span>
          </label>
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
                <Input
                  inputMode="numeric"
                  aria-label={t('form.lineAmountFor', { line: String(i + 1) })}
                  placeholder={t('form.lineAmount')}
                  value={l.amount}
                  onChange={(e) => setLine(l.key, { amount: e.target.value })}
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
        {request.error && <ErrorText>{refusedProblem ? t(`problems.${refusedProblem as 'PARTY_REQUIRED'}`) : errorMessage(request.error)}</ErrorText>}
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
  const vouchers = useQuery(orpc.vouchers.list.queryOptions({ input: { ...(from ? { from } : {}), ...(to ? { to } : {}), ...(type ? { type } : {}) } }));
  const allowed = canEnterVoucher(org.data?.role);

  return (
    <>
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        actions={
          allowed && !entering ? (
            <Button size="lg" onClick={() => setEntering(true)}>
              {t('new')}
            </Button>
          ) : undefined
        }
      />
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
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="mt-1 w-44" />
        </label>
        <label className="text-xs">
          <span className="text-subtle-foreground">{t('to')}</span>
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="mt-1 w-44" />
        </label>
      </div>
      {vouchers.isLoading ? (
        <Spinner />
      ) : vouchers.error ? (
        <ErrorText>{errorMessage(vouchers.error)}</ErrorText>
      ) : (vouchers.data?.length ?? 0) === 0 ? (
        <Empty title={t('empty')} />
      ) : (
        <DataTable
          head={[t('columns.number'), t('columns.date'), t('columns.party'), t('columns.description'), t('columns.account'), t('columns.amount'), t('columns.status')]}
        >
          {vouchers.data?.map((v) => (
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
      )}
    </>
  );
}
