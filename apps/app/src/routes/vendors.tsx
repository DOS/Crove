import { useQuery } from '@tanstack/react-query';
import { useDeferredValue, useState } from 'react';
import { useTranslations } from 'use-intl';
import { Input } from '@crove/ui/components/input';
import { TableCell, TableRow } from '@crove/ui/components/table';
import { DataTable, Empty, ErrorText, PageHeader, Spinner } from '../components/ui.tsx';
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
        <DataTable head={[t('columns.name'), t('columns.taxCode'), t('columns.address'), t('columns.documents')]}>
          {vendors.data?.map((v) => (
            <TableRow key={v.id}>
              <TableCell className="px-4 py-3 font-medium text-foreground">{v.name}</TableCell>
              <TableCell className="px-4 py-3 font-mono text-xs text-muted-foreground">{v.taxCode}</TableCell>
              <TableCell className="px-4 py-3 text-subtle-foreground">{v.address}</TableCell>
              <TableCell className="px-4 py-3 text-muted-foreground tabular-nums">{f.number(v.documentCount)}</TableCell>
            </TableRow>
          ))}
        </DataTable>
      )}
    </>
  );
}
