import { useQuery } from '@tanstack/react-query';
import { useDeferredValue, useState } from 'react';
import { Empty, ErrorText, Input, PageHeader, Spinner, Table } from '../components/ui.tsx';
import { errorMessage, orpc } from '../lib/api.ts';

export function VendorsPage() {
  const [q, setQ] = useState('');
  const term = useDeferredValue(q.trim());
  const vendors = useQuery(orpc.parties.list.queryOptions({ input: term ? { q: term } : {} }));
  return (
    <>
      <PageHeader title="Nhà cung cấp" subtitle="Tự tạo từ hóa đơn đã duyệt; nhận diện theo mã số thuế." />
      <div className="mb-4 max-w-sm">
        <Input placeholder="Tìm theo tên hoặc MST" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {vendors.isLoading ? (
        <Spinner />
      ) : vendors.error ? (
        <ErrorText>{errorMessage(vendors.error)}</ErrorText>
      ) : (vendors.data?.length ?? 0) === 0 ? (
        <Empty title="Chưa có nhà cung cấp" />
      ) : (
        <Table head={['Tên', 'Mã số thuế', 'Địa chỉ', 'Chứng từ']}>
          {vendors.data?.map((v) => (
            <tr key={v.id}>
              <td className="px-4 py-3 font-medium text-fg">{v.name}</td>
              <td className="px-4 py-3 font-mono text-xs text-fg-2">{v.taxCode}</td>
              <td className="px-4 py-3 text-fg-3">{v.address}</td>
              <td className="tabular px-4 py-3 text-fg-2">{v.documentCount}</td>
            </tr>
          ))}
        </Table>
      )}
    </>
  );
}
