import { useQuery } from '@tanstack/react-query';
import { Empty, ErrorText, PageHeader, Spinner, Table } from '../components/ui.tsx';
import { errorMessage, orpc } from '../lib/api.ts';
import { formatDate, formatMoney } from '../lib/format.ts';

export function DocumentsPage() {
  const docs = useQuery(orpc.documents.list.queryOptions({ input: {} }));
  return (
    <>
      <PageHeader title="Chứng từ mua" subtitle="Hóa đơn đầu vào đã được duyệt và ghi sổ." />
      {docs.isLoading ? (
        <Spinner />
      ) : docs.error ? (
        <ErrorText>{errorMessage(docs.error)}</ErrorText>
      ) : (docs.data?.length ?? 0) === 0 ? (
        <Empty title="Chưa có chứng từ nào được ghi sổ" hint="Duyệt đề xuất trong Hộp thư chứng từ để ghi sổ." />
      ) : (
        <Table head={['Ngày HĐ', 'Số HĐ', 'Nhà cung cấp', 'Trước thuế', 'Thuế GTGT', 'Tổng']}>
          {docs.data?.map((d) => (
            <tr key={d.id}>
              <td className="px-4 py-3 text-fg-2">{formatDate(d.issueDate)}</td>
              <td className="px-4 py-3 font-mono text-xs text-fg">
                {d.series ? `${d.series}-` : ''}
                {d.number}
              </td>
              <td className="px-4 py-3 text-fg">{d.partyName}</td>
              <td className="tabular px-4 py-3 text-fg-2">{formatMoney(d.subtotal)}</td>
              <td className="tabular px-4 py-3 text-fg-2">{formatMoney(d.vatAmount)}</td>
              <td className="tabular px-4 py-3 font-medium text-fg">{formatMoney(d.total)}</td>
            </tr>
          ))}
        </Table>
      )}
    </>
  );
}
