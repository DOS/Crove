// Bank statements (issue #326): import a bank's Excel or CSV export into one bank account's statement lines, checked
// line by line before anything is stored (new, already there, needs a look, unreadable), then read the account's lines
// per month. Each line shows its voucher (stage 2a): none yet, a báo Có or báo Nợ waiting for approval, or the posted
// one; "Enter voucher" opens the voucher form prefilled from the line, with the party Crove suggests.
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useParams, useSearch } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import type { BankImportResult, BankLine, BankLineStatus, BankLineVoucher, BankRowError } from '@crove/kernel-contract';
import { Alert, AlertDescription } from '@crove/ui/components/alert';
import { Badge } from '@crove/ui/components/badge';
import { Button, buttonVariants } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Input } from '@crove/ui/components/input';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { TableCell, TableRow } from '@crove/ui/components/table';
import { useChosenEntity } from '../components/entity-switcher.tsx';
import { DateInput } from '../components/date-input.tsx';
import { DataTable, Empty, ErrorText, Notice, PageHeader, Spinner, TableSkeleton } from '../components/ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';
import { VoucherFormCard } from './vouchers.tsx';
import {
  MAX_STATEMENT_BYTES,
  STATEMENT_COLUMNS,
  findColumns,
  headerLabels,
  readStatementFile,
  statementRows,
  type StatementColumn,
  type StatementMapping,
} from '../lib/bank-statement.ts';
import type { SheetRows } from '../lib/xlsx.ts';

const NUM = 'px-4 py-3 text-right tabular-nums';
// The preview lists this many rows; the counts cover them all.
const PREVIEW_ROWS = 300;

type FileState =
  | { status: 'none' }
  | { status: 'reading' }
  | { status: 'read'; name: string; rows: SheetRows }
  | { status: 'problem'; problem: 'too_large' | 'unreadable' | 'no_columns' | 'too_many' | 'no_lines' };

// 'YYYY-MM' of today in Vietnam, as the kernel counts months.
function thisMonth(): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit' }).formatToParts(new Date());
  return `${parts.find((p) => p.type === 'year')?.value}-${parts.find((p) => p.type === 'month')?.value}`;
}

const STATUS_VARIANT: Record<BankLineStatus, 'success' | 'secondary' | 'warning'> = { new: 'success', duplicate: 'secondary', ambiguous: 'warning' };

function StatementImport({ bankAccount, onImported }: { bankAccount: string; onImported: (result: BankImportResult, to: string | null) => void }) {
  const t = useTranslations('bank');
  const f = useFormat();
  const [file, setFile] = useState<FileState>({ status: 'none' });
  const [mapping, setMapping] = useState<StatementMapping | null>(null);
  // One key per checked file: a retry is the same import.
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const pick = useRef(0);

  const statement = file.status === 'read' && mapping ? statementRows(file.rows, mapping) : null;
  // The lines go to the books of the entity chosen in the shell (#1280).
  const entity = useChosenEntity();
  const input = statement && statement.length > 0 && entity.ready ? { bankAccount, filename: file.status === 'read' ? file.name : '', rows: statement, legalEntityId: entity.legalEntityId } : null;
  const imported = useMutation(
    orpc.bank.import.mutationOptions({
      onSuccess: (result) => {
        void queryClient.invalidateQueries();
        onImported(result, preview.data?.to ?? null);
      },
    }),
  );
  const preview = useQuery({
    ...orpc.bank.preview.queryOptions({ input: input ?? { bankAccount, filename: '', rows: [{ rowNo: 1, date: '', description: '', moneyIn: '', moneyOut: '', balance: '', reference: '' }] } }),
    enabled: input !== null && !imported.data,
  });

  const choose = async (picked: File | undefined) => {
    const current = ++pick.current;
    imported.reset();
    setIdempotencyKey(crypto.randomUUID());
    setMapping(null);
    if (!picked) return setFile({ status: 'none' });
    if (picked.size > MAX_STATEMENT_BYTES) return setFile({ status: 'problem', problem: 'too_large' });
    setFile({ status: 'reading' });
    try {
      const rows = await readStatementFile(new Uint8Array(await picked.arrayBuffer()), picked.name);
      if (current !== pick.current) return;
      const found = findColumns(rows);
      if (!found) return setFile({ status: 'problem', problem: 'no_columns' });
      const lines = statementRows(rows, found);
      if (lines === null) return setFile({ status: 'problem', problem: 'too_many' });
      if (lines.length === 0) return setFile({ status: 'problem', problem: 'no_lines' });
      setMapping(found);
      setFile({ status: 'read', name: picked.name, rows });
    } catch {
      if (current === pick.current) setFile({ status: 'problem', problem: 'unreadable' });
    }
  };

  const setColumn = (field: StatementColumn, value: string) => {
    if (!mapping) return;
    setMapping({ ...mapping, columns: { ...mapping.columns, [field]: value === '' ? null : Number(value) } });
    setIdempotencyKey(crypto.randomUUID());
  };

  const data = preview.data;
  const toStore = data ? data.counts.new + data.counts.ambiguous : 0;

  return (
    <Card className="mb-6 block space-y-4 p-4">
      <div>
        <h2 className="text-sm font-semibold text-foreground">{t('importTitle')}</h2>
        <p className="text-sm text-muted-foreground">{t('importHint')}</p>
      </div>
      <label className="block text-xs">
        <span className="text-subtle-foreground">{t('file')}</span>
        <Input type="file" aria-label={t('file')} className="mt-1 max-w-md" accept=".xlsx,.csv,text/csv" onChange={(e) => void choose(e.target.files?.[0])} />
      </label>
      {file.status === 'reading' && <Spinner />}
      {file.status === 'problem' && <ErrorText>{t(`problems.${file.problem}`)}</ErrorText>}
      {file.status === 'read' && mapping && (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-3">
            {STATEMENT_COLUMNS.map((field) => (
              <label key={field} className="text-xs">
                <span className="text-subtle-foreground">{t(`columns.${field}`)}</span>
                <NativeSelect aria-label={t(`columns.${field}`)} className="mt-1 w-44" value={mapping.columns[field] ?? ''} onChange={(e) => setColumn(field, e.target.value)}>
                  <NativeSelectOption value="">{t('noColumn')}</NativeSelectOption>
                  {headerLabels(file.rows, mapping.headerRow).map((h) => (
                    <NativeSelectOption key={h.col} value={h.col}>
                      {h.label}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </label>
            ))}
          </div>
          {statement && statement.length === 0 && <Notice>{t('problems.no_lines')}</Notice>}
          {preview.isLoading && <Spinner />}
          {preview.error && <ErrorText>{errorMessage(preview.error)}</ErrorText>}
          {data && !imported.data && (
            <div className="space-y-3">
              <p className="text-sm text-foreground">
                {t('summary', { ...data.counts, from: data.from ? f.date(data.from) : '', to: data.to ? f.date(data.to) : '' })}
                {data.order === 'newest_first' && ` ${t('newestFirst')}`}
              </p>
              {data.counts.ambiguous > 0 && <Notice>{t('ambiguousNote')}</Notice>}
              {data.breaks.length > 0 && (
                <Alert className="border-warning/30 bg-warning/10 text-warning" role="note">
                  <AlertDescription className="text-warning">
                    {t('breaks', { count: data.breaks.length, date: f.date(data.breaks[0]?.date ?? ''), expected: f.money(data.breaks[0]?.expected ?? '0'), balance: f.money(data.breaks[0]?.balance ?? '0') })}
                  </AlertDescription>
                </Alert>
              )}
              <DataTable head={[t('columns.row'), t('columns.date'), t('columns.reference'), t('columns.description'), t('columns.moneyIn'), t('columns.moneyOut'), t('columns.balance'), t('columns.status')]}>
                {data.rows.slice(0, PREVIEW_ROWS).map((row) => {
                  const out = row.amount?.startsWith('-') ?? false;
                  return (
                    <TableRow key={row.rowNo}>
                      <TableCell className="px-4 py-3 text-muted-foreground">{row.rowNo}</TableCell>
                      <TableCell className="px-4 py-3">{row.date ? f.date(row.date) : ''}</TableCell>
                      <TableCell className="px-4 py-3 font-mono text-xs">{row.reference ?? ''}</TableCell>
                      <TableCell className="px-4 py-3 text-foreground">{row.description}</TableCell>
                      <TableCell className={NUM}>{row.amount && !out ? f.money(row.amount) : ''}</TableCell>
                      <TableCell className={NUM}>{row.amount && out ? f.money(row.amount.slice(1)) : ''}</TableCell>
                      <TableCell className={NUM}>{row.balance ? f.money(row.balance) : ''}</TableCell>
                      <TableCell className="px-4 py-3">
                        {row.status ? (
                          <Badge variant={STATUS_VARIANT[row.status]}>{t(`status.${row.status}`)}</Badge>
                        ) : (
                          <span className="text-destructive">{row.errors.map((e: BankRowError) => t(`errors.${e}`)).join(', ')}</span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </DataTable>
              {data.rows.length > PREVIEW_ROWS && <p className="text-xs text-subtle-foreground">{t('moreRows', { count: data.rows.length - PREVIEW_ROWS })}</p>}
              <Button size="lg" disabled={!data.ok || toStore === 0 || imported.isPending} onClick={() => input && imported.mutate({ ...input, idempotencyKey })}>
                {imported.isPending ? <Spinner className="text-current" /> : null}
                {t('import', { count: toStore })}
              </Button>
              {!data.ok && <p className="text-sm text-destructive">{t('fixRows')}</p>}
            </div>
          )}
          {imported.error && <ErrorText>{errorMessage(imported.error)}</ErrorText>}
          {imported.data && <Notice>{t('imported', { ...imported.data.counts, stored: imported.data.counts.new + imported.data.counts.ambiguous })}</Notice>}
        </div>
      )}
    </Card>
  );
}

// The voucher form for one line, once Crove has read what the line makes.
function LineVoucher({ slug, line, onClose }: { slug: string; line: BankLine; onClose: () => void }) {
  const t = useTranslations('vouchers');
  const made = useQuery(orpc.bank.lineVoucher.queryOptions({ input: { bankLineId: line.id } }));
  if (made.isLoading) return <Spinner />;
  if (made.error) return <ErrorText>{errorMessage(made.error)}</ErrorText>;
  if (!made.data) return null;
  if (!made.data.voucher) {
    return (
      <Alert className="mb-6">
        <AlertDescription>
          {t('form.noVoucher')}{' '}
          <button type="button" className="text-link underline" onClick={onClose}>
            {t('form.close')}
          </button>
        </AlertDescription>
      </Alert>
    );
  }
  return <VoucherFormCard slug={slug} onClose={onClose} fromLine={made.data} />;
}

function LineState({ slug, line, canEnter, onEnter }: { slug: string; line: BankLine; canEnter: boolean; onEnter: () => void }) {
  const t = useTranslations('bank');
  const f = useFormat();
  if (line.state.status === 'matched') {
    return <Badge variant="success">{line.state.code}</Badge>;
  }
  if (line.state.status === 'proposed') {
    return (
      <Link to="/o/$slug/inbox/$id" params={{ slug, id: line.state.proposalId }} className="text-link underline">
        {t('state.proposed')}
      </Link>
    );
  }
  if (!canEnter) return <span className="text-subtle-foreground">{t('state.open')}</span>;
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      aria-label={t('makeVoucherFor', { date: f.date(line.date), amount: f.money(line.amount.replace(/^-/, '')) })}
      onClick={onEnter}
    >
      {t('makeVoucher')}
    </Button>
  );
}

interface ProposeRun {
  sending: boolean;
  done: number;
  failed: Array<{ date: string; message: string }>;
}

// Asks for the voucher of every open line whose party its description names (by tax code, or by an invoice of the
// amount), one inbox.request each, as entering them one by one would (#326, stage 2b). Each stays a proposal for an
// owner or admin to approve; a line refused (another voucher took it meanwhile, say) does not stop the others.
function ProposeMatched({ bankAccount, month }: { bankAccount: string; month: string }) {
  const t = useTranslations('bank');
  const f = useFormat();
  const suggestions = useQuery(orpc.bank.suggestions.queryOptions({ input: { bankAccount, period: month } }));
  const [run, setRun] = useState<ProposeRun | null>(null);
  const items = suggestions.data ?? [];

  const proposeAll = async (list: readonly BankLineVoucher[]) => {
    const state: ProposeRun = { sending: true, done: 0, failed: [] };
    setRun({ ...state });
    for (const item of list) {
      const voucher = item.voucher;
      const party = item.suggested?.party;
      if (!voucher || !party) continue;
      try {
        await client.inbox.request({
          command: 'finance.voucher.record',
          idempotencyKey: crypto.randomUUID(),
          input: {
            type: voucher.type,
            date: voucher.date,
            cashAccount: item.bankAccount,
            partyId: party.id,
            description: voucher.description,
            lines: [{ account: voucher.counterAccount, amount: voucher.amount }],
            bankLineId: item.line.id,
          },
        });
        state.done += 1;
      } catch (error) {
        state.failed.push({ date: voucher.date, message: errorMessage(error) });
      }
      setRun({ ...state, failed: [...state.failed] });
    }
    setRun({ ...state, sending: false, failed: [...state.failed] });
    await queryClient.invalidateQueries();
  };

  if (run) {
    return (
      <Alert className="mb-4">
        <AlertDescription>
          {run.sending ? <Spinner className="mr-2 inline-block text-current" /> : null}
          {t('proposedAll', { done: run.done })}
          {run.failed.map((failure, i) => (
            <span key={i} className="block text-destructive">
              {t('proposeFailed', { date: f.date(failure.date), message: failure.message })}
            </span>
          ))}
          {!run.sending && (
            <button type="button" className="ml-2 text-link underline" onClick={() => setRun(null)}>
              {t('proposeClose')}
            </button>
          )}
        </AlertDescription>
      </Alert>
    );
  }
  if (items.length === 0) return null;
  return (
    <Card className="mb-4 flex flex-wrap items-center justify-between gap-3 p-4">
      <p className="text-sm text-muted-foreground">{t('proposeAllHint')}</p>
      <Button type="button" onClick={() => void proposeAll(items)}>
        {t('proposeAll', { count: items.length })}
      </Button>
    </Card>
  );
}

export function BankPage() {
  const t = useTranslations('bank');
  const f = useFormat();
  const { slug } = useParams({ strict: false }) as { slug: string };
  const search: { account?: string; month?: string } = useSearch({ strict: false });
  const org = useQuery(orpc.org.get.queryOptions());
  const accounts = useQuery(orpc.accounts.list.queryOptions());
  // The org's bank accounts: TT133 accounts under 112 and its sub-accounts rolling up to one (the 112 group itself
  // holds none).
  const bankAccounts = (accounts.data ?? []).filter((a) => a.rootCode.startsWith('112') && a.code !== '112');
  const [picked, setPicked] = useState<string | null>(search.account ?? null);
  const account = picked ?? bankAccounts.find((a) => a.active)?.code ?? null;
  const current = bankAccounts.find((a) => a.code === account);
  const [month, setMonth] = useState(() => search.month ?? thisMonth());
  // A link to another account or month while the page is open (back and forward between two of them) moves it there.
  useEffect(() => {
    if (search.account) setPicked(search.account);
  }, [search.account]);
  useEffect(() => {
    if (search.month) setMonth(search.month);
  }, [search.month]);
  const canImport = org.data?.role === 'owner' || org.data?.role === 'admin' || org.data?.role === 'member';
  // Bank accounts are sub-accounts of 112 in the chart of accounts, which owners and admins keep (#319).
  const canManageAccounts = org.data?.role === 'owner' || org.data?.role === 'admin';
  const lines = useQuery({ ...orpc.bank.lines.queryOptions({ input: { bankAccount: account ?? '1121', period: month } }), enabled: account !== null && /^\d{4}-\d{2}$/.test(month) });
  // The line whose voucher is being entered.
  const [entering, setEntering] = useState<BankLine | null>(null);

  return (
    <>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      {accounts.isLoading ? (
        <TableSkeleton columns={5} />
      ) : accounts.error ? (
        <ErrorText>{errorMessage(accounts.error)}</ErrorText>
      ) : account === null ? (
        <Empty
          title={t('noAccounts')}
          hint={t('noAccountsHint')}
          action={
            canManageAccounts ? (
              <Link to="/o/$slug/settings" params={{ slug }} className={buttonVariants({ variant: 'outline' })}>
                {t('openSettings')}
              </Link>
            ) : undefined
          }
        />
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-end gap-3">
            <label className="text-xs">
              <span className="text-subtle-foreground">{t('account')}</span>
              <NativeSelect aria-label={t('account')} className="mt-1 w-80 max-w-full" value={account} onChange={(e) => setPicked(e.target.value)}>
                {bankAccounts.map((a) => (
                  <NativeSelectOption key={a.code} value={a.code}>
                    {`${a.code} ${a.name}${a.active ? '' : ` (${t('inactive')})`}`}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </label>
            <label className="text-xs">
              <span className="text-subtle-foreground">{t('month')}</span>
              <DateInput kind="month" aria-label={t('month')} className="mt-1 w-44" value={month} onChange={setMonth} />
            </label>
          </div>
          {canImport && current?.active && (
            <StatementImport key={account} bankAccount={account} onImported={(_result, to) => to && setMonth(to.slice(0, 7))} />
          )}
          {canImport && /^\d{4}-\d{2}$/.test(month) && <ProposeMatched key={`${account}:${month}`} bankAccount={account} month={month} />}
          {entering && <LineVoucher key={entering.id} slug={slug} line={entering} onClose={() => setEntering(null)} />}
          {lines.isLoading ? (
            <TableSkeleton columns={5} />
          ) : lines.error ? (
            <ErrorText>{errorMessage(lines.error)}</ErrorText>
          ) : lines.data && lines.data.lines.length === 0 ? (
            <Empty title={t('empty')} hint={canImport ? t('emptyHint') : undefined} />
          ) : lines.data ? (
            <DataTable
              head={[t('columns.date'), t('columns.reference'), t('columns.description'), t('columns.moneyIn'), t('columns.moneyOut'), t('columns.balance'), t('voucherColumn')]}
            >
              {lines.data.lines.map((line) => (
                <TableRow key={line.id}>
                  <TableCell className="px-4 py-3 text-muted-foreground">{f.date(line.date)}</TableCell>
                  <TableCell className="px-4 py-3 font-mono text-xs">{line.reference ?? ''}</TableCell>
                  <TableCell className="px-4 py-3 text-foreground">
                    {line.description}
                    {line.ambiguous && (
                      <Badge variant="warning" className="ml-2">
                        {t('status.ambiguous')}
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className={NUM}>{line.amount.startsWith('-') ? '' : f.money(line.amount)}</TableCell>
                  <TableCell className={NUM}>{line.amount.startsWith('-') ? f.money(line.amount.slice(1)) : ''}</TableCell>
                  <TableCell className={NUM}>{line.balance === null ? '' : f.money(line.balance)}</TableCell>
                  <TableCell className="px-4 py-3 text-xs">
                    <LineState slug={slug} line={line} canEnter={canImport} onEnter={() => setEntering(line)} />
                  </TableCell>
                </TableRow>
              ))}
              <TableRow className="font-medium">
                <TableCell className="px-4 py-3 text-foreground" colSpan={3}>
                  {t('total')}
                </TableCell>
                <TableCell className={NUM}>{f.money(lines.data.moneyIn)}</TableCell>
                <TableCell className={NUM}>{f.money(lines.data.moneyOut)}</TableCell>
                <TableCell className="px-4 py-3" />
                <TableCell className="px-4 py-3" />
              </TableRow>
            </DataTable>
          ) : null}
        </>
      )}
    </>
  );
}
