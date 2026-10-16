import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'use-intl';
import { Empty, ErrorText, PageHeader, Spinner, Table } from '../components/ui.tsx';
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
        <Table
          head={[
            t('columns.issueDate'),
            t('columns.number'),
            t('columns.vendor'),
            t('columns.subtotal'),
            t('columns.vat'),
            t('columns.total'),
          ]}
        >
          {docs.data?.map((d) => (
            <tr key={d.id}>
              <td className="px-4 py-3 text-fg-2">{f.date(d.issueDate)}</td>
              <td className="px-4 py-3 font-mono text-xs text-fg">
                {d.series ? `${d.series}-` : ''}
                {d.number}
              </td>
              <td className="px-4 py-3 text-fg">{d.partyName}</td>
              <td className="tabular px-4 py-3 text-fg-2">{f.money(d.subtotal)}</td>
              <td className="tabular px-4 py-3 text-fg-2">{f.money(d.vatAmount)}</td>
              <td className="tabular px-4 py-3 font-medium text-fg">{f.money(d.total)}</td>
            </tr>
          ))}
        </Table>
      )}
    </>
  );
}
