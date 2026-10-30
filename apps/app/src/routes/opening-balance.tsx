import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useId, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { OPENING_BALANCE_MAX_ROWS, type OpeningBalanceRow } from '@crove/kernel-contract';
import { Alert, AlertDescription } from '@crove/ui/components/alert';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Input } from '@crove/ui/components/input';
import { TableCell, TableRow } from '@crove/ui/components/table';
import { DateInput } from '../components/date-input.tsx';
import { useChosenEntity } from '../components/entity-switcher.tsx';
import { StepUpPrompt } from '../components/two-factor.tsx';
import { DataTable, ErrorText, fieldErrorId, fieldHintId, Notice, PageHeader, PageSkeleton, Spinner } from '../components/ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { errorMessage, getCurrentOrg, isStepUpRequired, orpc, queryClient } from '../lib/api.ts';
import { buildTemplate, canImportOpeningBalance, sheetToRows, type SheetProblem } from '../lib/opening-balance.ts';
import { readFirstSheet, XlsxError } from '../lib/xlsx.ts';

type FileState =
  | { status: 'none' }
  | { status: 'reading' }
  | { status: 'read'; name: string; rows: OpeningBalanceRow[]; extraColumns: boolean }
  | { status: 'problem'; problem: SheetProblem | XlsxError['reason'] };

function saveBytes(bytes: Uint8Array, filename: string) {
  const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// Opening balances from Excel (#320): download the template, fill it, pick it with the date, read the kernel's check
// row by row, then post it as the org's one opening entry (R3: a fresh second factor).
export function OpeningBalancePage() {
  // A file picked for one legal entity is not carried over to another: switching entities starts the form afresh.
  const entity = useChosenEntity();
  return <OpeningBalanceForm key={entity.legalEntityId ?? ''} />;
}

function OpeningBalanceForm() {
  const t = useTranslations('openingBalance');
  const f = useFormat();
  const { slug } = useParams({ strict: false }) as { slug: string };
  const org = useQuery(orpc.org.get.queryOptions());
  const accounts = useQuery(orpc.accounts.list.queryOptions());
  const [asOf, setAsOf] = useState('');
  const [file, setFile] = useState<FileState>({ status: 'none' });
  // One key per checked sheet: a retry after the step-up is the same posting.
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const allowed = canImportOpeningBalance(org.data?.role);
  // The file's problem and the missing date are linked to their fields (#1515).
  const fieldIds = useId();
  const asOfId = `${fieldIds}-as-of`;
  const fileId = `${fieldIds}-file`;
  const needsDate = file.status === 'read' && !asOf;

  // Each entity has its own opening entry (#1280): checked and posted for the one chosen in the shell.
  const entity = useChosenEntity();
  const input = file.status === 'read' && asOf && entity.ready ? { asOf, rows: file.rows, legalEntityId: entity.legalEntityId } : null;
  const post = useMutation(orpc.openingBalance.post.mutationOptions({ onSuccess: () => void queryClient.invalidateQueries() }));
  // Once posted, the check is not run again (the invalidation after posting may still refresh it once).
  const preview = useQuery({
    ...orpc.openingBalance.preview.queryOptions({ input: input ?? { asOf: '2000-01-01', rows: [] } }),
    enabled: input !== null && allowed && !post.data,
  });
  const stepUp = isStepUpRequired(post.error);

  // The latest file picked: a slower read of an earlier pick never replaces it.
  const pick = useRef(0);
  const choose = async (picked: File | undefined) => {
    const current = ++pick.current;
    post.reset();
    setIdempotencyKey(crypto.randomUUID());
    if (!picked) {
      setFile({ status: 'none' });
      return;
    }
    setFile({ status: 'reading' });
    try {
      const result = sheetToRows(await readFirstSheet(new Uint8Array(await picked.arrayBuffer())));
      if (current !== pick.current) return;
      setFile(result.ok ? { status: 'read', name: picked.name, rows: result.rows, extraColumns: result.extraColumns } : { status: 'problem', problem: result.problem });
    } catch (error) {
      if (current !== pick.current) return;
      setFile({ status: 'problem', problem: error instanceof XlsxError ? error.reason : 'not_xlsx' });
    }
  };

  // The accounts in use (#319): the TT133 chart and the org's active sub-accounts.
  const download = () =>
    saveBytes(buildTemplate((accounts.data ?? []).filter((a) => a.active)), t('templateFile', { org: getCurrentOrg() ?? 'org' }));

  if (org.isLoading) return <PageSkeleton body="list" />;
  if (!allowed) {
    return (
      <>
        <PageHeader title={t('title')} subtitle={t('subtitle')} />
        <ErrorText>{t('notAllowed')}</ErrorText>
      </>
    );
  }

  const data = preview.data;
  const shown = data?.rows.filter((r) => !r.skipped) ?? [];
  const skipped = (data?.rows.length ?? 0) - shown.length;
  const rowsWithErrors = shown.filter((r) => r.errors.length > 0).length;
  const sendPost = () => {
    if (input) post.mutate({ ...input, idempotencyKey });
  };

  return (
    <>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      <div className="space-y-4">
        <Card className="block p-4">
          <h2 className="text-sm font-medium text-foreground">{t('stepTemplate')}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t('templateHint')}</p>
          <Button className="mt-3" variant="outline" onClick={download} disabled={!accounts.data}>
            {t('downloadTemplate')}
          </Button>
        </Card>

        <Card className="block p-4">
          <h2 className="text-sm font-medium text-foreground">{t('stepFile')}</h2>
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <label className="text-xs">
              <span className="text-subtle-foreground">{t('asOf')}</span>
              <DateInput
                aria-describedby={needsDate ? fieldHintId(asOfId) : undefined}
                value={asOf}
                onChange={(next) => {
                  post.reset();
                  setIdempotencyKey(crypto.randomUUID());
                  setAsOf(next);
                }}
                className="mt-1 w-44"
              />
            </label>
            <label className="text-xs">
              <span className="text-subtle-foreground">{t('file')}</span>
              <Input
                aria-invalid={file.status === 'problem' || undefined}
                aria-describedby={file.status === 'problem' ? fieldErrorId(fileId) : undefined}
                type="file"
                accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                onChange={(e) => void choose(e.target.files?.[0])}
                className="mt-1 w-72"
              />
            </label>
          </div>
          {file.status === 'reading' && <p className="mt-3 text-sm text-muted-foreground">{t('reading')}</p>}
          {file.status === 'problem' && (
            <div className="mt-3">
              <ErrorText id={fieldErrorId(fileId)}>{t(`fileProblems.${file.problem}`, { max: OPENING_BALANCE_MAX_ROWS })}</ErrorText>
            </div>
          )}
          {file.status === 'read' && file.extraColumns && (
            <div className="mt-3">
              <Notice>{t('extraColumns')}</Notice>
            </div>
          )}
          {needsDate && (
            <p id={fieldHintId(asOfId)} className="mt-3 text-sm text-muted-foreground">
              {t('chooseDate')}
            </p>
          )}
        </Card>

        {input && (
          <Card className="block p-4">
            <h2 className="text-sm font-medium text-foreground">{t('stepPreview')}</h2>
            {preview.isLoading ? (
              <p className="mt-3 text-sm text-muted-foreground">{t('checking')}</p>
            ) : preview.error ? (
              <div className="mt-3">
                <ErrorText>{errorMessage(preview.error)}</ErrorText>
              </div>
            ) : data ? (
              <div className="mt-3 space-y-3">
                {/* Once posted, a check that ran again would report the entry just posted as the one in force. */}
                {!post.data &&
                  data.errors.map((code) => (
                    <ErrorText key={code}>
                      {t(`entryErrors.${code}`, { date: f.date(code === 'OPENING_EXISTS' ? data.openingEntry?.entryDate : data.firstEntryDate) })}{' '}
                      {code === 'OPENING_EXISTS' && data.openingEntry && (
                        <Link to="/o/$slug/journal" params={{ slug }} hash={`entry-${data.openingEntry.id}`} className="text-link underline">
                          {t('viewEntry')}
                        </Link>
                      )}
                    </ErrorText>
                  ))}
                <p className="text-sm text-foreground">
                  {t('totals', { debit: f.money(data.totals.debit), credit: f.money(data.totals.credit) })}{' '}
                  {data.totals.difference !== '0' && <span className="text-destructive">{t('difference', { difference: f.money(data.totals.difference) })}</span>}
                </p>
                {skipped > 0 && <p className="text-xs text-subtle-foreground">{t('skipped', { count: skipped })}</p>}
                {rowsWithErrors > 0 && <p className="text-sm text-destructive">{t('rowsWithErrors', { count: rowsWithErrors })}</p>}
                {shown.length > 0 && (
                  <DataTable numeric={[2, 3]} head={[t('columns.row'), t('columns.account'), t('columns.debit'), t('columns.credit'), t('columns.status')]}>
                    {shown.map((r) => (
                      <TableRow key={r.rowNo} className="hover:bg-transparent">
                        <TableCell className="px-4 text-subtle-foreground tabular-nums">{r.rowNo}</TableCell>
                        <TableCell className="px-4">
                          <span className="font-mono text-foreground">{r.accountCode}</span> <span className="text-muted-foreground">{r.accountName}</span>
                          {(r.partyTaxCode || r.partyName) && (
                            <span className="block text-xs text-subtle-foreground">
                              {[r.partyTaxCode, r.partyName].filter(Boolean).join(' · ')}
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="px-4 text-right tabular-nums">{r.debit && r.debit !== '0' ? f.money(r.debit) : ''}</TableCell>
                        <TableCell className="px-4 text-right tabular-nums">{r.credit && r.credit !== '0' ? f.money(r.credit) : ''}</TableCell>
                        <TableCell className="px-4">
                          {r.errors.length === 0 ? (
                            <Badge variant="secondary">{t('rowOk')}</Badge>
                          ) : (
                            <ul className="space-y-0.5 text-xs text-destructive">
                              {r.errors.map((code) => (
                                <li key={code}>{t(`rowErrors.${code}`)}</li>
                              ))}
                            </ul>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </DataTable>
                )}
                {post.data ? (
                  <Notice>
                    {t('posted')}{' '}
                    <Link to="/o/$slug/journal" params={{ slug }} hash={`entry-${post.data.journalEntryId}`} className="underline">
                      {t('viewEntry')}
                    </Link>
                  </Notice>
                ) : (
                  data.ok && (
                    <Alert>
                      <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
                        <span>{t('ready', { lines: data.lines })}</span>
                        <Button onClick={sendPost} disabled={post.isPending}>
                          {post.isPending ? <Spinner className="text-current" /> : null}
                          {t('post')}
                        </Button>
                      </AlertDescription>
                    </Alert>
                  )
                )}
                {/* After a fresh code, the refused request is sent again as it was, under the same idempotency key. */}
                {stepUp && <StepUpPrompt action={t('stepUp')} onVerified={() => post.variables && post.mutate(post.variables)} onCancel={() => post.reset()} />}
                {post.error && !stepUp && <ErrorText>{errorMessage(post.error)}</ErrorText>}
              </div>
            ) : null}
          </Card>
        )}
      </div>
    </>
  );
}
