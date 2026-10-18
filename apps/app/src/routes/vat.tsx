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
import { apiFetch, errorMessage, getCurrentOrg, orpc } from '../lib/api.ts';
import { defaultPeriod, periodKey, switchKind, yearOptions, type PeriodChoice, type PeriodKind } from '../lib/vat.ts';

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

export function VatPage() {
  const t = useTranslations('vat');
  const f = useFormat();
  const [choice, setChoice] = useState<PeriodChoice>(() => defaultPeriod('month'));
  const period = periodKey(choice);
  const report = useQuery(orpc.vat.period.queryOptions({ input: { period } }));
  const data = report.data;

  const exportXlsx = useMutation({
    mutationFn: async () => {
      const response = await apiFetch(`/api/export/vat.xlsx?${new URLSearchParams({ period })}`);
      const url = URL.createObjectURL(await response.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = t('exportFile', { period, org: getCurrentOrg() ?? 'org' });
      a.click();
      URL.revokeObjectURL(url);
    },
  });

  const indexes = choice.kind === 'month' ? Array.from({ length: 12 }, (_, i) => i + 1) : [1, 2, 3, 4];
  const rateRows = data ? data.input.totals.byRate.map((input, i) => ({ input, output: data.output.totals.byRate[i] })) : [];

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
      {exportXlsx.error && (
        <div className="mb-4">
          <ErrorText>{errorMessage(exportXlsx.error)}</ErrorText>
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
          </section>

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
              <Empty title={t('emptyInput')} />
            ) : (
              <InvoiceTable invoices={data.input.documents} partyLabel={t('columns.seller')} />
            )}
          </section>
        </div>
      ) : null}
    </>
  );
}
