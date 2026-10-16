import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'use-intl';
import { Badge } from '@crove/ui/components/badge';
import { TableCell, TableRow } from '@crove/ui/components/table';
import { DataTable, Empty, ErrorText, PageHeader, Spinner } from '../components/ui.tsx';
import { errorMessage, orpc } from '../lib/api.ts';
import { useFormat } from '../i18n/provider.tsx';

export function DocumentsPage() {
  const t = useTranslations('documents');
  const f = useFormat();
  const docs = useQuery(orpc.documents.list.queryOptions({ input: {} }));
  return (
    <>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      {docs.isLoading ? (
        <Spinner />
      ) : docs.error ? (
        <ErrorText>{errorMessage(docs.error)}</ErrorText>
      ) : (docs.data?.length ?? 0) === 0 ? (
        <Empty title={t('empty')} hint={t('emptyHint')} />
      ) : (
        <DataTable
          head={[
            t('columns.issueDate'),
            t('columns.number'),
            t('columns.vendor'),
            t('columns.subtotal'),
            t('columns.vat'),
            t('columns.total'),
            t('columns.status'),
          ]}
        >
          {docs.data?.map((d) => (
            <TableRow key={d.id} className={d.voided ? 'opacity-60' : undefined}>
              <TableCell className="px-4 py-3 text-muted-foreground">{f.date(d.issueDate)}</TableCell>
              <TableCell className="px-4 py-3 font-mono text-xs text-foreground">
                {d.series ? `${d.series}-` : ''}
                {d.number}
              </TableCell>
              <TableCell className="px-4 py-3 text-foreground">{d.partyName}</TableCell>
              <TableCell className="px-4 py-3 text-muted-foreground tabular-nums">{f.money(d.subtotal)}</TableCell>
              <TableCell className="px-4 py-3 text-muted-foreground tabular-nums">{f.money(d.vatAmount)}</TableCell>
              <TableCell className="px-4 py-3 font-medium text-foreground tabular-nums">{f.money(d.total)}</TableCell>
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
              </TableCell>
            </TableRow>
          ))}
        </DataTable>
      )}
    </>
  );
}
