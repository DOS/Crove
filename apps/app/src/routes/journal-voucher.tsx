import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Fragment, useId, useState } from 'react';
import { flushSync } from 'react-dom';
import { useTranslations } from 'use-intl';
import { JOURNAL_VOUCHER_MAX_LINES, needsParty } from '@crove/kernel-contract';
import { Alert, AlertDescription } from '@crove/ui/components/alert';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Input } from '@crove/ui/components/input';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { AmountInput } from '../components/amount-input.tsx';
import { DateInput } from '../components/date-input.tsx';
import { useChosenEntity } from '../components/entity-switcher.tsx';
import { ErrorText, FieldError, fieldControl, fieldErrorId, focusFirstInvalid, Spinner } from '../components/ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { accountLabel, pickableAccounts } from '../lib/accounts.ts';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';
import { journalAmount, journalFormProblem, journalLineProblem, journalTotals, journalVoucherProblem } from '../lib/journal-voucher.ts';
import { localToday } from '../lib/reversal.ts';

interface Line {
  key: string;
  account: string;
  partyId: string;
  debit: string;
  credit: string;
  memo: string;
}

const newLine = (account = ''): Line => ({ key: crypto.randomUUID(), account, partyId: '', debit: '', credit: '', memo: '' });

// Enters a phiếu kế toán khác, NVK (#888): a balanced entry by hand, for accruals, salaries, depreciation and the like.
// It becomes a proposal; an owner or admin approves it in the Inbox (R3, four-eyes, fresh MFA), which numbers it
// NVK00001 ... and posts its entry.
export function JournalVoucherFormCard({ slug, onClose }: { slug: string; onClose: () => void }) {
  const root = useTranslations();
  const t = useTranslations('journalVoucher');
  const f = useFormat();
  const accounts = useQuery(orpc.accounts.list.queryOptions());
  const parties = useQuery(orpc.parties.list.queryOptions({ input: { all: true } }));
  const [date, setDate] = useState(() => localToday());
  const [description, setDescription] = useState('');
  const [lines, setLines] = useState<Line[]>(() => [newLine(), newLine()]);
  const [touched, setTouched] = useState(false);
  // Lines whose amounts the user left with something typed: their problem shows under them before the submit (#1515).
  const [checked, setChecked] = useState<ReadonlySet<string>>(() => new Set());
  const ids = useId();
  // One key per form: a retry of the same request returns the same proposal.
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const request = useMutation(orpc.inbox.request.mutationOptions({ onSettled: () => void queryClient.invalidateQueries() }));
  // The voucher goes to the books of the entity chosen in the shell (#1280).
  const entity = useChosenEntity();

  const chart = accounts.data ?? [];
  // The first account of the chart until the user picks one.
  const account = (l: Line) => l.account || chart[0]?.code || '';
  const form = { date, description, lines: lines.map((l) => ({ account: account(l), partyId: l.partyId, debit: l.debit, credit: l.credit })) };
  const problem = journalFormProblem(form);
  const totals = journalTotals(form.lines);
  const refused = journalVoucherProblem(request.error);
  const setLine = (key: string, patch: Partial<Line>) => setLines((current) => current.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const check = (key: string, on: boolean) =>
    setChecked((current) => {
      if (current.has(key) === on) return current;
      const next = new Set(current);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  // Each problem sits under the field or the line it is about; only the count of lines and the totals stay below them.
  const descriptionId = `${ids}-description`;
  const descriptionInvalid = touched && problem === 'description';
  const formLevel = touched && (problem === 'lines' || problem === 'unbalanced') ? problem : null;

  if (request.data) {
    return (
      <Alert className="mb-6">
        <AlertDescription>
          {t('created')}{' '}
          <Link to="/o/$slug/inbox/$id" params={{ slug, id: request.data.proposalId }} className="text-link underline">
            {t('viewProposal')}
          </Link>{' '}
          <button
            type="button"
            className="text-link underline"
            onClick={() => {
              request.reset();
              setIdempotencyKey(crypto.randomUUID());
              setDescription('');
              setLines([newLine(), newLine()]);
              setTouched(false);
              setChecked(new Set());
            }}
          >
            {t('another')}
          </button>
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <Card className="mb-6 block p-4">
      <form
        className="space-y-4"
        aria-label={t('title')}
        onSubmit={(event) => {
          event.preventDefault();
          flushSync(() => setTouched(true));
          if (problem) focusFirstInvalid(event.currentTarget);
          if (problem || !entity.ready) return;
          request.mutate({
            command: 'finance.journal_voucher.record',
            idempotencyKey,
            input: {
              date,
              description: description.trim(),
              lines: lines.map((l) => ({
                account: account(l),
                partyId: l.partyId || null,
                debit: journalAmount(l.debit),
                credit: journalAmount(l.credit),
                ...(l.memo.trim() ? { memo: l.memo.trim() } : {}),
              })),
              legalEntityId: entity.legalEntityId,
            },
          });
        }}
      >
        <p className="text-sm text-muted-foreground">{t('intro')}</p>
        <div className="grid gap-4 sm:grid-cols-[12rem_minmax(0,1fr)]">
          <label className="block text-xs">
            <span className="text-subtle-foreground">{t('date')}</span>
            <DateInput required value={date} onChange={setDate} className="mt-1 w-full" />
          </label>
          <div>
            <label className="block text-xs">
              <span className="text-subtle-foreground">{t('description')}</span>
              <Input
                {...fieldControl(descriptionId, { error: descriptionInvalid })}
                required
                maxLength={300}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={t('descriptionPlaceholder')}
                className="mt-1 w-full"
              />
            </label>
            <FieldError id={descriptionId} className="mt-1">
              {descriptionInvalid ? t('formProblems.description') : null}
            </FieldError>
          </div>
        </div>

        <div>
          <p className="text-xs font-medium tracking-wide uppercase text-subtle-foreground">{t('lines')}</p>
          <div className="mt-2 space-y-2">
            {lines.map((l, i) => {
              const line = String(i + 1);
              const lineId = `${ids}-line-${l.key}`;
              const lineProblem = touched || checked.has(l.key) ? journalLineProblem(form.lines[i] ?? l) : null;
              const amountInvalid = lineProblem === 'amount' || lineProblem === 'side';
              const linked = (invalid: boolean) => ({ 'aria-invalid': invalid || undefined, 'aria-describedby': invalid ? fieldErrorId(lineId) : undefined });
              return (
                <Fragment key={l.key}>
                  <div className="grid gap-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,2fr)_auto]">
                    <NativeSelect aria-label={t('lineAccount', { line })} className="w-full" value={account(l)} onChange={(e) => setLine(l.key, { account: e.target.value })}>
                      {pickableAccounts(chart, account(l)).map((a) => (
                        <NativeSelectOption key={a.code} value={a.code}>
                          {accountLabel(a)}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                    <NativeSelect {...linked(lineProblem === 'party')} aria-label={t('lineParty', { line })} className="w-full" value={l.partyId} onChange={(e) => setLine(l.key, { partyId: e.target.value })}>
                      <NativeSelectOption value="">{needsParty(account(l)) ? t('chooseParty') : t('noParty')}</NativeSelectOption>
                      {(parties.data ?? []).map((p) => (
                        <NativeSelectOption key={p.id} value={p.id}>
                          {p.taxCode ? `${p.name} (${p.taxCode})` : p.name}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                    <AmountInput
                      {...linked(amountInvalid)}
                      aria-label={t('lineDebit', { line })}
                      placeholder={t('debit')}
                      value={l.debit}
                      onChange={(debit) => {
                        setLine(l.key, { debit });
                        check(l.key, false);
                      }}
                      onBlur={(e) => e.target.value.trim() && check(l.key, true)}
                      className="w-full text-right tabular-nums"
                    />
                    <AmountInput
                      {...linked(amountInvalid)}
                      aria-label={t('lineCredit', { line })}
                      placeholder={t('credit')}
                      value={l.credit}
                      onChange={(credit) => {
                        setLine(l.key, { credit });
                        check(l.key, false);
                      }}
                      onBlur={(e) => e.target.value.trim() && check(l.key, true)}
                      className="w-full text-right tabular-nums"
                    />
                    <Input
                      maxLength={300}
                      aria-label={t('lineMemo', { line })}
                      placeholder={t('memoPlaceholder')}
                      value={l.memo}
                      onChange={(e) => setLine(l.key, { memo: e.target.value })}
                      className="w-full"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={lines.length <= 2}
                      aria-label={t('removeLine', { line })}
                      onClick={() => setLines((current) => current.filter((x) => x.key !== l.key))}
                    >
                      ✕
                    </Button>
                  </div>
                  <FieldError id={lineId}>{lineProblem ? t(`formProblems.${lineProblem}`) : null}</FieldError>
                </Fragment>
              );
            })}
          </div>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
            <Button type="button" variant="outline" disabled={lines.length >= JOURNAL_VOUCHER_MAX_LINES} onClick={() => setLines((current) => [...current, newLine()])}>
              {t('addLine')}
            </Button>
            <p className="text-sm font-medium text-foreground tabular-nums">{t('totals', { debit: f.money(totals.debit), credit: f.money(totals.credit) })}</p>
          </div>
        </div>

        {formLevel && <ErrorText>{t(`formProblems.${formLevel}`)}</ErrorText>}
        {request.error && <ErrorText>{refused ? t(`problems.${refused}`) : errorMessage(request.error)}</ErrorText>}
        <div className="flex gap-2">
          <Button type="submit" disabled={request.isPending}>
            {request.isPending ? <Spinner className="text-current" /> : null}
            {t('submit')}
          </Button>
          <Button type="button" variant="ghost" onClick={onClose} disabled={request.isPending}>
            {root('common.cancel')}
          </Button>
        </div>
      </form>
    </Card>
  );
}
