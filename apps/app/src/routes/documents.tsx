import { useQuery } from '@tanstack/react-query';
import { useSearch } from '@tanstack/react-router';
import { useDeferredValue, useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';
import { Badge } from '@crove/ui/components/badge';
import { Input } from '@crove/ui/components/input';
import { TableCell, TableRow } from '@crove/ui/components/table';
import { DataTable, Empty, ErrorText, PageHeader, Spinner } from '../components/ui.tsx';
import { errorMessage, orpc } from '../lib/api.ts';
import { useFormat } from '../i18n/provider.tsx';
import { documentNumber, matchesDocument } from '../lib/search.ts';
import { InvoiceCorrections } from '../components/invoice-corrections.tsx';

export function DocumentsPage() {
  const t = useTranslations('documents');
  const f = useFormat();
  const docs = useQuery(orpc.documents.list.queryOptions({ input: {} }));
  // A filter over the documents shown, started by ?q= from a link (a document found by the command palette, #673).
  const search: { q?: string } = useSearch({ strict: false });
  const [q, setQ] = useState(search.q ?? '');
  useEffect(() => {
    if (search.q !== undefined) setQ(search.q);
  }, [search.q]);
  const term = useDeferredValue(q.trim());
  const shown = term ? docs.data?.filter((d) => matchesDocument(d, term)) : docs.data;
  return (
    <>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      {(docs.data?.length ?? 0) > 0 && (
        <div className="mb-4 max-w-sm">
          <Input placeholder={t('search')} aria-label={t('search')} value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      )}
      {docs.isLoading ? (
        <Spinner />
      ) : docs.error ? (
        <ErrorText>{errorMessage(docs.error)}</ErrorText>
      ) : (docs.data?.length ?? 0) === 0 ? (
        <Empty title={t('empty')} hint={t('emptyHint')} />
      ) : (shown?.length ?? 0) === 0 ? (
        <Empty title={t('noMatch')} />
      ) : (
        <DataTable
          numeric={[4, 5, 6]}
          head={[
            t('columns.issueDate'),
            t('columns.number'),
            t('columns.direction'),
            t('columns.party'),
            t('columns.subtotal'),
            t('columns.vat'),
            t('columns.total'),
            t('columns.status'),
          ]}
        >
          {shown?.map((d) => (
            <TableRow key={d.id} className={d.voided ? 'opacity-60' : undefined}>
              <TableCell className="px-4 py-3 text-muted-foreground">{f.date(d.issueDate)}</TableCell>
              <TableCell className="px-4 py-3 font-mono text-xs text-foreground">{documentNumber(d)}</TableCell>
              <TableCell className="px-4 py-3">
                <Badge variant={d.direction === 'sale' ? 'secondary' : 'outline'}>{t(d.direction === 'sale' ? 'direction.sale' : 'direction.purchase')}</Badge>
              </TableCell>
              <TableCell className="px-4 py-3 text-foreground">{d.partyName}</TableCell>
              <TableCell className="px-4 py-3 text-right text-muted-foreground tabular-nums">{f.money(d.subtotal)}</TableCell>
              <TableCell className="px-4 py-3 text-right text-muted-foreground tabular-nums">{f.money(d.vatAmount)}</TableCell>
              <TableCell className="px-4 py-3 text-right font-medium text-foreground tabular-nums">
                {f.money(d.total)}
                {d.foreign && (
                  <span className="block text-xs font-normal text-subtle-foreground">
                    {t('foreign', { total: f.money(d.foreign.total, d.foreign.currency), rate: f.number(d.foreign.rate) })}
                  </span>
                )}
              </TableCell>
              <TableCell className="px-4 py-3">
                {/* Voided by reversing its entry (#165): Crove no longer counts it; the supplier's invoice is unchanged. */}
                {d.voided ? (
                  <Badge variant="destructive" title={t('voidReason', { reason: d.voided.reason })}>
                    {t('status.voided')}
                  </Badge>
                ) : d.replacesDocumentId ? (
                  <Badge variant="secondary">{t('status.rerecorded')}</Badge>
                ) : (
                  <Badge variant="success">{t('status.recorded')}</Badge>
                )}
                <InvoiceCorrections corrects={d.corrects} correctedBy={d.correctedBy} />
              </TableCell>
            </TableRow>
          ))}
        </DataTable>
      )}
    </>
  );
}
