import { useQuery } from '@tanstack/react-query';
import { useDeferredValue, useState } from 'react';
import { useTranslations } from 'use-intl';
import { Empty, ErrorText, Input, PageHeader, Spinner, Table } from '../components/ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { errorMessage, orpc } from '../lib/api.ts';

export function VendorsPage() {
  const t = useTranslations('vendors');
  const f = useFormat();
  const [q, setQ] = useState('');
  const term = useDeferredValue(q.trim());
  const vendors = useQuery(orpc.parties.list.queryOptions({ input: term ? { q: term } : {} }));
  return (
    <>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      <div className="mb-4 max-w-sm">
        <Input placeholder={t('search')} value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {vendors.isLoading ? (
        <Spinner />
      ) : vendors.error ? (
        <ErrorText>{errorMessage(vendors.error)}</ErrorText>
      ) : (vendors.data?.length ?? 0) === 0 ? (
        <Empty title={t('empty')} />
      ) : (
        <Table head={[t('columns.name'), t('columns.taxCode'), t('columns.address'), t('columns.documents')]}>
          {vendors.data?.map((v) => (
            <tr key={v.id}>
              <td className="px-4 py-3 font-medium text-fg">{v.name}</td>
              <td className="px-4 py-3 font-mono text-xs text-fg-2">{v.taxCode}</td>
              <td className="px-4 py-3 text-fg-3">{v.address}</td>
              <td className="tabular px-4 py-3 text-fg-2">{f.number(v.documentCount)}</td>
            </tr>
          ))}
        </Table>
      )}
    </>
  );
}
