// Ledger reports (issue #321): for a month, quarter or year, the trial balance, the general ledger of one account and
// the receivables and payables per party, from posted entries, with one Excel workbook of all of them. The period
// lock (#329) sits above the reports. The financial statements tab (issue #154) shows the DRAFT B01-DNN and B02-DNN
// of the same period, with a workbook of its own.
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { Alert } from '@crove/ui/components/alert';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { TableCell, TableRow } from '@crove/ui/components/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@crove/ui/components/tabs';
import { PeriodLockPanel } from '../components/period-lock.tsx';
import { DataTable, Empty, ErrorText, Notice, PageHeader, Spinner } from '../components/ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { apiFetch, errorMessage, getCurrentOrg, orpc } from '../lib/api.ts';
import { partySearch } from '../lib/parties.ts';
import { balanceSide, defaultLedgerPeriod, ledgerPeriodKey, switchLedgerKind, type LedgerPeriodChoice, type LedgerPeriodKind } from '../lib/ledger.ts';
import { yearOptions } from '../lib/vat.ts';

type Tab = 'trialBalance' | 'generalLedger' | 'parties' | 'statements';
const TABS: Tab[] = ['trialBalance', 'generalLedger', 'parties', 'statements'];

interface PartyRow {
  partyId: string | null;
  partyName: string | null;
  partyTaxCode: string | null;
  opening: string;
  increase: string;
  decrease: string;
  closing: string;
}

interface PartyLedger {
  rows: PartyRow[];
  totals: { opening: string; increase: string; decrease: string; closing: string };
}

const NUM = 'px-4 py-3 text-right tabular-nums';

function Balance({ value }: { value: string }) {
  const t = useTranslations('ledger');
  const f = useFormat();
  const { side, amount } = balanceSide(value);
  if (side === null) return <>{f.money('0')}</>;
  return <>{side === 'debit' ? t('balanceDebit', { amount: f.money(amount) }) : t('balanceCredit', { amount: f.money(amount) })}</>;
}

// customers: each party's name opens it on the customers screen (#670).
function PartyTable({ ledger, partyLabel, customers = false }: { ledger: PartyLedger; partyLabel: string; customers?: boolean }) {
  const t = useTranslations('ledger');
  const f = useFormat();
  const { slug } = useParams({ strict: false }) as { slug: string };
  if (ledger.rows.length === 0) return <Empty title={t('partiesEmpty')} />;
  return (
    <DataTable numeric={[2, 3, 4, 5]} head={[t('columns.taxCode'), partyLabel, t('columns.opening'), t('columns.increase'), t('columns.decrease'), t('columns.closing')]}>
      {ledger.rows.map((row) => (
        <TableRow key={row.partyId ?? 'none'}>
          <TableCell className="px-4 py-3 font-mono text-xs text-muted-foreground">{row.partyTaxCode ?? ''}</TableCell>
          <TableCell className="px-4 py-3 text-foreground">
            {row.partyId === null ? (
              t('noParty')
            ) : customers ? (
              <Link to="/o/$slug/customers" params={{ slug }} search={{ q: partySearch({ taxCode: row.partyTaxCode, name: row.partyName }) }} className="text-link hover:underline">
                {row.partyName ?? ''}
              </Link>
            ) : (
              (row.partyName ?? '')
            )}
          </TableCell>
          <TableCell className={NUM}>{f.money(row.opening)}</TableCell>
          <TableCell className={NUM}>{f.money(row.increase)}</TableCell>
          <TableCell className={NUM}>{f.money(row.decrease)}</TableCell>
          <TableCell className={`${NUM} font-medium text-foreground`}>{f.money(row.closing)}</TableCell>
        </TableRow>
      ))}
      <TableRow className="font-medium">
        <TableCell className="px-4 py-3" />
        <TableCell className="px-4 py-3 text-foreground">{t('total')}</TableCell>
        <TableCell className={NUM}>{f.money(ledger.totals.opening)}</TableCell>
        <TableCell className={NUM}>{f.money(ledger.totals.increase)}</TableCell>
        <TableCell className={NUM}>{f.money(ledger.totals.decrease)}</TableCell>
        <TableCell className={NUM}>{f.money(ledger.totals.closing)}</TableCell>
      </TableRow>
    </DataTable>
  );
}

function AccountLedger({ period, accountCode }: { period: string; accountCode: string }) {
  const t = useTranslations('ledger');
  const f = useFormat();
  const query = useQuery(orpc.ledger.account.queryOptions({ input: { period, accountCode } }));
  if (query.isLoading) return <Spinner />;
  if (query.error) return <ErrorText>{errorMessage(query.error)}</ErrorText>;
  const ledger = query.data;
  if (!ledger) return null;
  return (
    <DataTable
      numeric={[6, 7, 8]}
      head={[
        t('columns.date'),
        t('columns.reference'),
        t('columns.description'),
        t('columns.lineAccount'),
        t('columns.counter'),
        t('columns.party'),
        t('columns.debit'),
        t('columns.credit'),
        t('columns.balance'),
      ]}>
      <TableRow>
        <TableCell className="px-4 py-3" colSpan={8}>
          <span className="text-muted-foreground">{t('openingRow')}</span>
        </TableCell>
        <TableCell className={NUM}>
          <Balance value={ledger.opening} />
        </TableCell>
      </TableRow>
      {ledger.lines.map((line, i) => (
        <TableRow key={`${line.entryId}-${i}`}>
          <TableCell className="px-4 py-3 text-muted-foreground">{f.date(line.entryDate)}</TableCell>
          <TableCell className="px-4 py-3 font-mono text-xs text-foreground">{line.reference ?? ''}</TableCell>
          <TableCell className="px-4 py-3 text-foreground">
            {line.description}
            {line.reversal && (
              <Badge variant="warning" className="ml-2">
                {t('reversalBadge')}
              </Badge>
            )}
          </TableCell>
          <TableCell className="px-4 py-3 font-mono text-xs">{line.accountCode}</TableCell>
          <TableCell className="px-4 py-3 font-mono text-xs text-muted-foreground">{line.counterAccounts.join(', ')}</TableCell>
          <TableCell className="px-4 py-3 text-muted-foreground">{line.partyName ?? ''}</TableCell>
          <TableCell className={NUM}>{line.debit === '0' ? '' : f.money(line.debit)}</TableCell>
          <TableCell className={NUM}>{line.credit === '0' ? '' : f.money(line.credit)}</TableCell>
          <TableCell className={NUM}>
            <Balance value={line.balance} />
          </TableCell>
        </TableRow>
      ))}
      {ledger.lines.length === 0 && (
        <TableRow>
          <TableCell className="px-4 py-3 text-subtle-foreground" colSpan={9}>
            {t('ledgerEmpty')}
          </TableCell>
        </TableRow>
      )}
      <TableRow className="font-medium">
        <TableCell className="px-4 py-3 text-foreground" colSpan={6}>
          {t('turnoverRow')}
        </TableCell>
        <TableCell className={NUM}>{f.money(ledger.debit)}</TableCell>
        <TableCell className={NUM}>{f.money(ledger.credit)}</TableCell>
        <TableCell className="px-4 py-3" />
      </TableRow>
      <TableRow className="font-medium">
        <TableCell className="px-4 py-3 text-foreground" colSpan={8}>
          {t('closingRow')}
        </TableCell>
        <TableCell className={NUM}>
          <Balance value={ledger.closing} />
        </TableCell>
      </TableRow>
    </DataTable>
  );
}

interface StatementLine {
  code: string;
  label: string;
  amount: string;
  // A line that adds up earlier ones, bold as on the form.
  total: boolean;
}

interface UnmappedRow {
  accountCode: string;
  accountName: string | null;
  partyName: string | null;
  amount: string;
}

// One statement: its lines with the codes of the form, totals in bold, then the balances no line reads.
function StatementTable({ title, lines, unmapped }: { title: string; lines: StatementLine[]; unmapped: UnmappedRow[] }) {
  const t = useTranslations('ledger');
  const f = useFormat();
  return (
    <section className="space-y-3">
      <h2 className="text-base font-semibold text-foreground">{title}</h2>
      {unmapped.length > 0 && (
        <Alert className="border-warning/30 bg-warning/10 text-warning" role="note">
          <p className="font-medium">{t('unmappedTitle')}</p>
          <ul className="mt-1 space-y-0.5 text-sm">
            {/* One row per account and party; two parties may share a name, so the position keeps keys apart. */}
            {unmapped.map((u, index) => (
              <li key={`${index}-${u.accountCode}`}>
                <span className="font-mono">{u.accountCode}</span> {[u.accountName, u.partyName].filter(Boolean).join(', ')}: <Balance value={u.amount} />
              </li>
            ))}
          </ul>
        </Alert>
      )}
      <DataTable head={[t('columns.item'), t('columns.lineCode'), t('columns.amount')]}>
        {lines.map((line) => (
          <TableRow key={line.code} className={line.total ? 'font-medium' : ''}>
            <TableCell className="px-4 py-3 text-foreground">{line.label}</TableCell>
            <TableCell className="px-4 py-3 font-mono text-xs text-muted-foreground">{line.code}</TableCell>
            <TableCell className={NUM}>{f.money(line.amount)}</TableCell>
          </TableRow>
        ))}
      </DataTable>
    </section>
  );
}

// A year's statements as HTKK XML (#920): what the file would get wrong or leave out, said before the download; the
// file is still written, the accountant decides.
function HtkkStatements({ year }: { year: number }) {
  const t = useTranslations('ledger');
  const check = useQuery(orpc.ledger.statementsHtkkCheck.queryOptions({ input: { year } }));
  const exportXml = useMutation({
    mutationFn: async () => {
      const response = await apiFetch(`/api/export/statements-htkk.xml?${new URLSearchParams({ year: String(year) })}`);
      const url = URL.createObjectURL(await response.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = t('htkkFile', { year: String(year), org: getCurrentOrg() ?? 'org' });
      a.click();
      URL.revokeObjectURL(url);
    },
  });
  const warnings = check.data?.warnings ?? [];
  return (
    <section className="space-y-3 rounded-xl border bg-card p-4" aria-label={t('htkkTitle', { year: String(year) })}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">{t('htkkTitle', { year: String(year) })}</h2>
          <p className="mt-1 max-w-3xl text-xs text-subtle-foreground">{t('htkkIntro')}</p>
        </div>
        <Button variant="outline" onClick={() => exportXml.mutate()} disabled={exportXml.isPending || check.isLoading}>
          {exportXml.isPending ? <Spinner className="text-current" /> : null}
          {t('htkkExport')}
        </Button>
      </div>
      {check.error && <ErrorText>{errorMessage(check.error)}</ErrorText>}
      {warnings.length > 0 && (
        <Alert className="border-warning/30 bg-warning/10 text-warning" role="status">
          <ul className="list-disc space-y-1 pl-4">
            {warnings.map((w) => (
              <li key={w}>{w === 'F01_UNCOVERED' ? t('htkkWarnings.F01_UNCOVERED', { accounts: (check.data?.uncovered ?? []).join(', ') }) : t(`htkkWarnings.${w}`)}</li>
            ))}
          </ul>
        </Alert>
      )}
      {exportXml.error && <ErrorText>{errorMessage(exportXml.error)}</ErrorText>}
    </section>
  );
}

function Statements({ period }: { period: string }) {
  const t = useTranslations('ledger');
  const f = useFormat();
  const query = useQuery(orpc.ledger.statements.queryOptions({ input: { period } }));
  const exportXlsx = useMutation({
    mutationFn: async () => {
      const response = await apiFetch(`/api/export/statements.xlsx?${new URLSearchParams({ period })}`);
      const url = URL.createObjectURL(await response.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = t('statementsFile', { period, org: getCurrentOrg() ?? 'org' });
      a.click();
      URL.revokeObjectURL(url);
    },
  });
  if (query.isLoading) return <Spinner />;
  if (query.error) return <ErrorText>{errorMessage(query.error)}</ErrorText>;
  const data = query.data;
  if (!data) return null;
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <Alert className="max-w-3xl flex-1 border-warning/30 bg-warning/10 text-warning" role="note">
          {t('statementsDraft')}
        </Alert>
        <Button variant="outline" onClick={() => exportXlsx.mutate()} disabled={exportXlsx.isPending}>
          {exportXlsx.isPending ? <Spinner className="text-current" /> : null}
          {t('statementsExport')}
        </Button>
      </div>
      {exportXlsx.error && <ErrorText>{errorMessage(exportXlsx.error)}</ErrorText>}
      {/^\d{4}$/.test(period) && <HtkkStatements year={Number(period)} />}
      {!data.b01.balanced && (
        <Alert className="border-warning/30 bg-warning/10 text-warning" role="status">
          {t('statementsUnbalanced')}
        </Alert>
      )}
      <StatementTable title={t('b01Title', { date: f.date(data.b01.asOf) })} lines={data.b01.lines} unmapped={data.b01.unmapped} />
      <StatementTable
        title={t('b02Title', { from: f.date(data.b02.from), to: f.date(data.b02.to) })}
        lines={data.b02.lines}
        unmapped={data.b02.unmapped}
      />
    </div>
  );
}

export function LedgerPage() {
  const t = useTranslations('ledger');
  const f = useFormat();
  const [choice, setChoice] = useState<LedgerPeriodChoice>(() => defaultLedgerPeriod());
  const [tab, setTab] = useState<Tab>('trialBalance');
  const [picked, setPicked] = useState<string | null>(null);
  const period = ledgerPeriodKey(choice);
  const report = useQuery(orpc.ledger.period.queryOptions({ input: { period } }));
  const data = report.data;
  // The trial balance, general ledger and party tabs wait for this report. The statements tab runs its own query, so a
  // period too large for the ledger report (PERIOD_TOO_LARGE) still gets its statements.
  const reportStatus = report.isLoading ? <Spinner /> : report.error ? <ErrorText>{errorMessage(report.error)}</ErrorText> : null;
  const rows = data?.trialBalance.rows ?? [];
  // The account the general ledger shows: the one picked if the period has it, else the first one.
  const account = rows.find((r) => r.accountCode === picked)?.accountCode ?? rows[0]?.accountCode ?? null;

  const exportXlsx = useMutation({
    mutationFn: async () => {
      const response = await apiFetch(`/api/export/ledger.xlsx?${new URLSearchParams({ period })}`);
      const url = URL.createObjectURL(await response.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = t('exportFile', { period, org: getCurrentOrg() ?? 'org' });
      a.click();
      URL.revokeObjectURL(url);
    },
  });

  const indexes = choice.kind === 'month' ? Array.from({ length: 12 }, (_, i) => i + 1) : [1, 2, 3, 4];

  return (
    <>
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        actions={
          <Button size="lg" onClick={() => exportXlsx.mutate()} disabled={exportXlsx.isPending || !data}>
            {exportXlsx.isPending ? <Spinner className="text-current" /> : null}
            {t('export')}
          </Button>
        }
      />
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <label className="text-xs">
          <span className="text-subtle-foreground">{t('kind')}</span>
          <NativeSelect
            aria-label={t('kind')}
            className="mt-1 w-32"
            value={choice.kind}
            onChange={(e) => setChoice(switchLedgerKind(choice, e.target.value as LedgerPeriodKind))}>
            <NativeSelectOption value="month">{t('month')}</NativeSelectOption>
            <NativeSelectOption value="quarter">{t('quarter')}</NativeSelectOption>
            <NativeSelectOption value="year">{t('year')}</NativeSelectOption>
          </NativeSelect>
        </label>
        {choice.kind !== 'year' && (
          <label className="text-xs">
            <span className="text-subtle-foreground">{choice.kind === 'month' ? t('month') : t('quarter')}</span>
            <NativeSelect
              aria-label={choice.kind === 'month' ? t('month') : t('quarter')}
              className="mt-1 w-28"
              value={choice.index}
              onChange={(e) => setChoice({ ...choice, index: Number(e.target.value) })}>
              {indexes.map((n) => (
                <NativeSelectOption key={n} value={n}>
                  {choice.kind === 'month' ? t('monthOption', { n: String(n) }) : t('quarterOption', { n: String(n) })}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </label>
        )}
        <label className="text-xs">
          <span className="text-subtle-foreground">{t('year')}</span>
          <NativeSelect aria-label={t('year')} className="mt-1 w-28" value={choice.year} onChange={(e) => setChoice({ ...choice, year: Number(e.target.value) })}>
            {yearOptions().map((y) => (
              <NativeSelectOption key={y} value={y}>
                {y}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </label>
        {data && <p className="pb-1.5 text-sm text-muted-foreground">{t('range', { from: f.date(data.period.from), to: f.date(data.period.to) })}</p>}
      </div>
      <PeriodLockPanel />
      {exportXlsx.error && (
        <div className="mb-4">
          <ErrorText>{errorMessage(exportXlsx.error)}</ErrorText>
        </div>
      )}
      <Tabs className="gap-4" value={tab} onValueChange={(value) => setTab(value as Tab)}>
        {/* Four tabs are wider than a phone: the row scrolls inside its own box instead of the page (issue #615), with
            room below for the active tab's underline. */}
        <div className="-mb-1 overflow-x-auto pb-1">
          <TabsList variant="line" className="w-max min-w-full justify-start border-b">
            {TABS.map((id) => (
              <TabsTrigger key={id} value={id} className="flex-none px-3">
                {t(`tabs.${id}`)}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        <TabsContent value="trialBalance">
          {data ? (
            <>
              {!data.trialBalance.balanced && (
                <div className="mb-4">
                  <Notice>{t('unbalanced')}</Notice>
                </div>
              )}
              {rows.length === 0 ? (
                <Empty title={t('trialBalanceEmpty')} />
              ) : (
                <DataTable
                  numeric={[2, 3, 4, 5, 6, 7]}
                  head={[
                    t('columns.code'),
                    t('columns.name'),
                    t('columns.openingDebit'),
                    t('columns.openingCredit'),
                    t('columns.debit'),
                    t('columns.credit'),
                    t('columns.closingDebit'),
                    t('columns.closingCredit'),
                  ]}>
                  {rows.map((row) => (
                    <TableRow key={row.accountCode} className={row.level === 0 ? 'font-medium' : ''}>
                      <TableCell className="px-4 py-3 font-mono text-xs text-foreground">{row.accountCode}</TableCell>
                      <TableCell className="px-4 py-3 text-foreground" style={{ paddingLeft: `${1 + row.level * 1.25}rem` }}>
                        {row.accountName}
                      </TableCell>
                      <TableCell className={NUM}>{f.money(row.openingDebit)}</TableCell>
                      <TableCell className={NUM}>{f.money(row.openingCredit)}</TableCell>
                      <TableCell className={NUM}>{f.money(row.debit)}</TableCell>
                      <TableCell className={NUM}>{f.money(row.credit)}</TableCell>
                      <TableCell className={NUM}>{f.money(row.closingDebit)}</TableCell>
                      <TableCell className={NUM}>{f.money(row.closingCredit)}</TableCell>
                    </TableRow>
                  ))}
                  <TableRow className="font-semibold">
                    <TableCell className="px-4 py-3" />
                    <TableCell className="px-4 py-3 text-foreground">{t('total')}</TableCell>
                    <TableCell className={NUM}>{f.money(data.trialBalance.totals.openingDebit)}</TableCell>
                    <TableCell className={NUM}>{f.money(data.trialBalance.totals.openingCredit)}</TableCell>
                    <TableCell className={NUM}>{f.money(data.trialBalance.totals.debit)}</TableCell>
                    <TableCell className={NUM}>{f.money(data.trialBalance.totals.credit)}</TableCell>
                    <TableCell className={NUM}>{f.money(data.trialBalance.totals.closingDebit)}</TableCell>
                    <TableCell className={NUM}>{f.money(data.trialBalance.totals.closingCredit)}</TableCell>
                  </TableRow>
                </DataTable>
              )}
            </>
          ) : (
            reportStatus
          )}
        </TabsContent>
        <TabsContent value="generalLedger">
          {data ? (
            <>
              {account === null ? (
                <Empty title={t('trialBalanceEmpty')} />
              ) : (
                <div className="space-y-4">
                  <label className="block text-xs">
                    <span className="text-subtle-foreground">{t('account')}</span>
                    <NativeSelect aria-label={t('account')} className="mt-1 w-96 max-w-full" value={account} onChange={(e) => setPicked(e.target.value)}>
                      {rows.map((row) => (
                        <NativeSelectOption key={row.accountCode} value={row.accountCode}>
                          {`${' '.repeat(row.level * 4)}${row.accountCode} ${row.accountName}`}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                  </label>
                  <AccountLedger period={period} accountCode={account} />
                </div>
              )}
            </>
          ) : (
            reportStatus
          )}
        </TabsContent>
        <TabsContent value="parties">
          {data ? (
            <>
              <div className="space-y-8">
                <section>
                  <h2 className="mb-2 text-base font-semibold text-foreground">{t('receivablesTitle')}</h2>
                  <PartyTable ledger={data.receivables} partyLabel={t('columns.customer')} customers />
                </section>
                <section>
                  <h2 className="mb-2 text-base font-semibold text-foreground">{t('payablesTitle')}</h2>
                  <PartyTable ledger={data.payables} partyLabel={t('columns.vendor')} />
                </section>
                <p className="text-xs text-subtle-foreground">{t('partiesNote')}</p>
              </div>
            </>
          ) : (
            reportStatus
          )}
        </TabsContent>
        <TabsContent value="statements">
          <Statements period={period} />
        </TabsContent>
      </Tabs>
    </>
  );
}
