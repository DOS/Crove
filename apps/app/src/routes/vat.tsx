import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import type { VAT_RATES, VAT_WARNINGS } from '@crove/kernel-contract';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { TableCell, TableRow } from '@crove/ui/components/table';
import { DataTable, Empty, ErrorText, PageHeader, Spinner } from '../components/ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { apiFetch, client, errorMessage, getCurrentOrg, orpc, queryClient } from '../lib/api.ts';
import { isZeroAmount } from '../lib/decimal.ts';
import { DEDUCT_CHOICES, canMarkPayment, deductParams, defaultPeriod, periodKey, switchKind, yearOptions, type DeductChoice, type PeriodChoice, type PeriodKind } from '../lib/vat.ts';

type Rate = (typeof VAT_RATES)[number];
type Warning = (typeof VAT_WARNINGS)[number];

interface Invoice {
  id: string;
  issueDate: string;
  series: string;
  number: string;
  partyName: string;
  partyTaxCode: string | null;
  rates: Array<{ rate: Rate; taxable: string; vat: string }>;
  warnings: Warning[];
}

function InvoiceTable({ invoices, partyLabel }: { invoices: Invoice[]; partyLabel: string }) {
  const t = useTranslations('vat');
  const f = useFormat();
  return (
    <DataTable head={[t('columns.issueDate'), t('columns.number'), partyLabel, t('columns.rate'), t('columns.taxable'), t('columns.vat'), t('columns.notes')]}>
      {invoices.flatMap((invoice) =>
        invoice.rates.map((rate, i) => (
          <TableRow key={`${invoice.id}-${rate.rate}`}>
            <TableCell className="px-4 py-3 text-muted-foreground">{i === 0 ? f.date(invoice.issueDate) : ''}</TableCell>
            <TableCell className="px-4 py-3 font-mono text-xs text-foreground">
              {i === 0 ? `${invoice.series ? `${invoice.series}-` : ''}${invoice.number}` : ''}
            </TableCell>
            <TableCell className="px-4 py-3 text-foreground">
              {i === 0 && (
                <>
                  {invoice.partyName}
                  {invoice.partyTaxCode && <span className="block font-mono text-xs text-subtle-foreground">{invoice.partyTaxCode}</span>}
                </>
              )}
            </TableCell>
            <TableCell className="px-4 py-3 text-muted-foreground">{t(`rates.${rate.rate}`)}</TableCell>
            <TableCell className="px-4 py-3 text-foreground tabular-nums">{f.money(rate.taxable)}</TableCell>
            <TableCell className="px-4 py-3 text-foreground tabular-nums">{f.money(rate.vat)}</TableCell>
            <TableCell className="px-4 py-3">
              {i === 0 && (
                <div className="flex flex-wrap gap-1">
                  {invoice.warnings.map((w) => (
                    <Badge key={w} variant="warning">
                      {t(`warnings.${w}`)}
                    </Badge>
                  ))}
                </div>
              )}
            </TableCell>
          </TableRow>
        )),
      )}
    </DataTable>
  );
}

type VatReport = Awaited<ReturnType<typeof client.vat.period>>;
type PaymentCheck = VatReport['paymentChecks']['items'][number];

// Input invoices that need proof of non-cash payment before their VAT is deducted (#917), with the accountant's marks.
function PaymentChecks({ data, canMark }: { data: VatReport; canMark: boolean }) {
  const t = useTranslations('vat.payment');
  const f = useFormat();
  const checks = data.paymentChecks;
  const byId = new Map(data.input.documents.map((d) => [d.id, d]));
  // The org's bank payment vouchers (báo Nợ), to name the one that paid an invoice. The newest page is enough to pick from.
  const vouchers = useQuery({ ...orpc.vouchers.list.queryOptions({ input: { type: 'bank_debit' } }), enabled: canMark && checks.items.length > 0 });
  const [voucherFor, setVoucherFor] = useState<Record<string, string>>({});
  const mark = useMutation({
    mutationFn: (v: { documentId: string; outcome: 'paid_by_bank' | 'not_deductible' | 'cleared'; voucherId?: string | null }) => client.vat.markPayment(v),
    onSettled: () => queryClient.invalidateQueries({ queryKey: orpc.vat.period.key() }),
  });
  const status = (item: PaymentCheck) => (item.mark ? t(`outcome.${item.mark.outcome}`) : t('unchecked'));
  return (
    <section>
      <h2 className="mb-1 text-base font-semibold text-foreground">{t('title', { count: checks.items.length })}</h2>
      <p className="mb-2 text-xs text-subtle-foreground">{t('hint')}</p>
      {checks.items.length === 0 ? (
        <Empty title={t('empty')} />
      ) : (
        <>
          <DataTable head={[t('columns.invoice'), t('columns.seller'), t('columns.total'), t('columns.vat'), t('columns.method'), t('columns.status'), ...(canMark ? [t('columns.actions')] : [])]}>
            {checks.items.map((item) => {
              const doc = byId.get(item.documentId);
              const busy = mark.isPending && mark.variables?.documentId === item.documentId;
              return (
                <TableRow key={item.documentId}>
                  <TableCell className="px-4 py-3 text-foreground">
                    <span className="font-mono text-xs">{doc ? `${doc.series ? `${doc.series}-` : ''}${doc.number}` : ''}</span>
                    {doc && <span className="block text-xs text-subtle-foreground">{f.date(doc.issueDate)}</span>}
                  </TableCell>
                  <TableCell className="px-4 py-3 text-foreground">{doc?.partyName ?? ''}</TableCell>
                  <TableCell className="px-4 py-3 tabular-nums">{f.money(item.total)}</TableCell>
                  <TableCell className="px-4 py-3 tabular-nums">{f.money(item.vatAmount)}</TableCell>
                  <TableCell className="px-4 py-3 text-muted-foreground">{item.paymentMethod ?? t('methodMissing')}</TableCell>
                  <TableCell className="px-4 py-3">
                    <Badge variant={item.mark?.outcome === 'paid_by_bank' ? 'success' : 'warning'}>{status(item)}</Badge>
                    {item.mark?.voucherId && <span className="block text-xs text-subtle-foreground">{t('withVoucher')}</span>}
                  </TableCell>
                  {canMark && (
                    <TableCell className="space-y-2 px-4 py-3">
                      {(vouchers.data?.items.length ?? 0) > 0 && (
                        <NativeSelect
                          aria-label={t('voucher')}
                          className="w-48"
                          value={voucherFor[item.documentId] ?? ''}
                          onChange={(e) => setVoucherFor({ ...voucherFor, [item.documentId]: e.target.value })}>
                          <NativeSelectOption value="">{t('noVoucher')}</NativeSelectOption>
                          {vouchers.data?.items
                            .filter((v) => !v.reversal)
                            .map((v) => (
                              <NativeSelectOption key={v.id} value={v.id}>
                                {`${v.code} · ${f.date(v.date)} · ${f.money(v.amount)}`}
                              </NativeSelectOption>
                            ))}
                        </NativeSelect>
                      )}
                      <div className="flex flex-wrap gap-1">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() => mark.mutate({ documentId: item.documentId, outcome: 'paid_by_bank', voucherId: voucherFor[item.documentId] || null })}>
                          {t('markBank')}
                        </Button>
                        <Button size="sm" variant="outline" disabled={busy} onClick={() => mark.mutate({ documentId: item.documentId, outcome: 'not_deductible' })}>
                          {t('markNotDeductible')}
                        </Button>
                        {item.mark && (
                          <Button size="sm" variant="ghost" disabled={busy} onClick={() => mark.mutate({ documentId: item.documentId, outcome: 'cleared' })}>
                            {t('clear')}
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  )}
                </TableRow>
              );
            })}
          </DataTable>
          <p className="mt-2 text-sm text-muted-foreground">
            {t('summary', { atRisk: f.money(checks.vatAtRisk), notDeductible: f.money(checks.notDeductibleVat), unchecked: checks.unchecked })}
          </p>
        </>
      )}
      {mark.error && <ErrorText>{errorMessage(mark.error)}</ErrorText>}
    </section>
  );
}

export function VatPage() {
  const t = useTranslations('vat');
  const f = useFormat();
  // The org's tax code goes into the HTKK file (#332); without one the server refuses it, so the button waits for it.
  const org = useQuery(orpc.org.get.queryOptions());
  const taxCode = org.data?.taxCode ?? null;
  // The org's filing period (#318) picks the kind the screen opens on, until the user picks another one.
  const filing = org.data?.vatFilingPeriod ?? null;
  const [picked, setPicked] = useState<PeriodChoice | null>(null);
  const choice = picked ?? defaultPeriod(filing ?? 'month');
  const setChoice = setPicked;
  const period = periodKey(choice);
  const report = useQuery(orpc.vat.period.queryOptions({ input: { period } }));
  const data = report.data;
  // The XML is a filing, so the server refuses the other kind (PERIOD_KIND_MISMATCH); the button says why first.
  const wrongKind = filing !== null && filing !== choice.kind;

  // What [25] holds in the XML (#692, #917): 0 by default, the accountant's choice per download.
  const [deduct, setDeduct] = useState<DeductChoice>('none');
  const download = async (path: string, filename: string, extra: Record<string, string> = {}) => {
    const response = await apiFetch(`${path}?${new URLSearchParams({ period, ...extra })}`);
    const url = URL.createObjectURL(await response.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };
  const exportXlsx = useMutation({
    mutationFn: () => download('/api/export/vat.xlsx', t('exportFile', { period, org: getCurrentOrg() ?? 'org' })),
  });
  const exportXml = useMutation({
    mutationFn: () => download('/api/export/vat-01gtgt.xml', t('exportXmlFile', { period, org: getCurrentOrg() ?? 'org' }), deductParams(deduct)),
  });
  const exportError = exportXlsx.error ?? exportXml.error;

  const wrongKindText = t('exportXmlWrongKind', {
    kind: filing === 'quarter' ? t('filingQuarterly') : t('filingMonthly'),
    kindOne: filing === 'quarter' ? t('kindQuarter') : t('kindMonth'),
  });
  const indexes = choice.kind === 'month' ? Array.from({ length: 12 }, (_, i) => i + 1) : [1, 2, 3, 4];
  const rateRows = data ? data.input.totals.byRate.map((input, i) => ({ input, output: data.output.totals.byRate[i] })) : [];
  // Sales at a rate Crove cannot place count in the totals but in no form indicator (issue #358).
  const otherSales = data?.output.totals.byRate.find((r) => r.rate === 'other')?.taxable ?? '0';

  return (
    <>
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button
              size="lg"
              variant="outline"
              onClick={() => exportXml.mutate()}
              disabled={exportXml.isPending || !data || !taxCode || wrongKind}
              title={org.data && !taxCode ? t('exportXmlNeedsTaxCode') : wrongKind ? wrongKindText : undefined}>
              {exportXml.isPending ? <Spinner className="text-current" /> : null}
              {t('exportXml')}
            </Button>
            <Button size="lg" onClick={() => exportXlsx.mutate()} disabled={exportXlsx.isPending || !data}>
              {exportXlsx.isPending ? <Spinner className="text-current" /> : null}
              {t('export')}
            </Button>
          </div>
        }
      />
      {org.data && !taxCode && <p className="mb-4 text-sm text-muted-foreground">{t('exportXmlNeedsTaxCode')}</p>}
      {org.data && taxCode && wrongKind && <p className="mb-4 text-sm text-muted-foreground">{wrongKindText}</p>}
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <label className="text-xs">
          <span className="text-subtle-foreground">{t('kind')}</span>
          <NativeSelect aria-label={t('kind')} className="mt-1 w-32" value={choice.kind} onChange={(e) => setChoice(switchKind(choice, e.target.value as PeriodKind))}>
            <NativeSelectOption value="month">{t('month')}</NativeSelectOption>
            <NativeSelectOption value="quarter">{t('quarter')}</NativeSelectOption>
          </NativeSelect>
        </label>
        <label className="text-xs">
          <span className="text-subtle-foreground">{choice.kind === 'month' ? t('month') : t('quarter')}</span>
          <NativeSelect
            aria-label={choice.kind === 'month' ? t('month') : t('quarter')}
            className="mt-1 w-28"
            value={choice.index} onChange={(e) => setChoice({ ...choice, index: Number(e.target.value) })}>
            {indexes.map((n) => (
              <NativeSelectOption key={n} value={n}>
                {choice.kind === 'month' ? t('monthOption', { n: String(n) }) : t('quarterOption', { n: String(n) })}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </label>
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
      {exportError && (
        <div className="mb-4">
          <ErrorText>{errorMessage(exportError)}</ErrorText>
        </div>
      )}
      {report.isLoading ? (
        <Spinner />
      ) : report.error ? (
        <ErrorText>{errorMessage(report.error)}</ErrorText>
      ) : data ? (
        <div className="space-y-8">
          <section>
            <h2 className="mb-2 text-base font-semibold text-foreground">{t('indicatorsTitle')}</h2>
            <DataTable head={[t('columns.indicator'), t('columns.description'), t('columns.amount')]}>
              {data.indicators.map((indicator) => (
                <TableRow key={indicator.code}>
                  <TableCell className="px-4 py-3 font-mono text-xs text-foreground">[{indicator.code}]</TableCell>
                  <TableCell className="px-4 py-3 text-muted-foreground">{indicator.label}</TableCell>
                  <TableCell className="px-4 py-3 font-medium text-foreground tabular-nums">{f.money(indicator.amount)}</TableCell>
                </TableRow>
              ))}
            </DataTable>
            <p className="mt-2 text-xs text-subtle-foreground">{t('indicatorsNote')}</p>
            <p className="mt-1 text-xs text-subtle-foreground">{t('xmlNote')}</p>
            <label className="mt-2 block text-xs">
              <span className="text-subtle-foreground">{t('xmlDeduct')}</span>
              <NativeSelect aria-label={t('xmlDeduct')} className="mt-1 w-full max-w-md" value={deduct} onChange={(e) => setDeduct(e.target.value as DeductChoice)}>
                {DEDUCT_CHOICES.map((c) => (
                  <NativeSelectOption key={c} value={c}>
                    {c === 'suggested' ? t('xmlDeductSuggested', { amount: f.money(data.paymentChecks.suggested25) }) : t(c === 'all' ? 'xmlDeductAll' : 'xmlDeductNone')}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </label>
            {deduct === 'suggested' && data.paymentChecks.unchecked > 0 && (
              <p className="mt-1 text-xs text-warning">{t('xmlDeductUnchecked', { count: data.paymentChecks.unchecked })}</p>
            )}
            {!isZeroAmount(otherSales) && <p className="mt-2 text-sm text-warning">{t('otherSales', { amount: f.money(otherSales) })}</p>}
          </section>

          <PaymentChecks data={data} canMark={canMarkPayment(org.data?.role)} />

          <section>
            <h2 className="mb-2 text-base font-semibold text-foreground">{t('ratesTitle')}</h2>
            <DataTable head={[t('columns.rate'), t('columns.outputTaxable'), t('columns.outputVat'), t('columns.inputTaxable'), t('columns.inputVat')]}>
              {rateRows.map(({ input, output }) => (
                <TableRow key={input.rate}>
                  <TableCell className="px-4 py-3 text-foreground">{t(`rates.${input.rate}`)}</TableCell>
                  <TableCell className="px-4 py-3 tabular-nums">{f.money(output?.taxable ?? '0')}</TableCell>
                  <TableCell className="px-4 py-3 tabular-nums">{f.money(output?.vat ?? '0')}</TableCell>
                  <TableCell className="px-4 py-3 tabular-nums">{f.money(input.taxable)}</TableCell>
                  <TableCell className="px-4 py-3 tabular-nums">{f.money(input.vat)}</TableCell>
                </TableRow>
              ))}
              <TableRow className="font-medium">
                <TableCell className="px-4 py-3 text-foreground">{t('total')}</TableCell>
                <TableCell className="px-4 py-3 tabular-nums">{f.money(data.output.totals.taxable)}</TableCell>
                <TableCell className="px-4 py-3 tabular-nums">{f.money(data.output.totals.vat)}</TableCell>
                <TableCell className="px-4 py-3 tabular-nums">{f.money(data.input.totals.taxable)}</TableCell>
                <TableCell className="px-4 py-3 tabular-nums">{f.money(data.input.totals.vat)}</TableCell>
              </TableRow>
            </DataTable>
          </section>

          <section>
            <h2 className="mb-2 text-base font-semibold text-foreground">{t('outputTitle', { count: f.number(data.output.documents.length) })}</h2>
            {!data.output.available ? (
              <Empty title={t('outputUnavailable')} hint={t('outputUnavailableHint')} />
            ) : data.output.documents.length === 0 ? (
              <Empty title={t('emptyOutput')} hint={t('emptyOutputHint')} />
            ) : (
              <InvoiceTable invoices={data.output.documents} partyLabel={t('columns.buyer')} />
            )}
          </section>

          <section>
            <h2 className="mb-2 text-base font-semibold text-foreground">{t('inputTitle', { count: f.number(data.input.documents.length) })}</h2>
            {data.input.documents.length === 0 ? (
              <Empty title={t('emptyInput')} hint={t('emptyInputHint')} />
            ) : (
              <InvoiceTable invoices={data.input.documents} partyLabel={t('columns.seller')} />
            )}
          </section>
        </div>
      ) : null}
    </>
  );
}
