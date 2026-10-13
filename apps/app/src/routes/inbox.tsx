import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useRef, useState, type DragEvent } from 'react';
import { Badge, Button, Card, Empty, ErrorText, PageHeader, Spinner, Table, cx } from '../components/ui.tsx';
import { errorMessage, orpc, queryClient, uploadFiles } from '../lib/api.ts';
import { getConfig } from '../lib/auth.ts';
import { formatDate, formatDateTime, formatMoney } from '../lib/format.ts';

type Tab = 'pending' | 'executed' | 'rejected';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'pending', label: 'Chờ duyệt' },
  { id: 'executed', label: 'Đã ghi sổ' },
  { id: 'rejected', label: 'Đã từ chối' },
];

const FILE_STATUS: Record<string, { label: string; tone: 'neutral' | 'good' | 'warn' | 'bad' | 'brand' }> = {
  processing: { label: 'Đang đọc', tone: 'brand' },
  proposed: { label: 'Đã có đề xuất', tone: 'good' },
  duplicate: { label: 'Trùng hóa đơn', tone: 'warn' },
  failed: { label: 'Không đọc được', tone: 'bad' },
};

export function InboxPage() {
  const { slug } = useParams({ strict: false }) as { slug: string };
  const [tab, setTab] = useState<Tab>('pending');
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const config = getConfig();

  const org = useQuery(orpc.org.get.queryOptions());
  const files = useQuery({
    ...orpc.files.recent.queryOptions(),
    refetchInterval: (query) => ((query.state.data ?? []).some((f) => f.status === 'processing') ? 2000 : 30_000),
  });
  const items = useQuery({ ...orpc.inbox.list.queryOptions({ input: { status: tab } }), refetchInterval: 5000 });

  const upload = useMutation({
    mutationFn: uploadFiles,
    onSuccess: () => void queryClient.invalidateQueries(),
  });

  function onDrop(event: DragEvent) {
    event.preventDefault();
    setDragging(false);
    const dropped = [...event.dataTransfer.files];
    if (dropped.length) upload.mutate(dropped);
  }

  const processing = (files.data ?? []).filter((f) => f.status === 'processing').length;

  return (
    <>
      <PageHeader
        title="Hộp thư chứng từ"
        subtitle="Gửi hóa đơn vào đây. AI đề xuất bút toán, bạn chỉ việc kiểm tra và duyệt."
        actions={
          <Button variant="primary" onClick={() => inputRef.current?.click()} disabled={upload.isPending}>
            {upload.isPending ? <Spinner /> : null}
            Tải chứng từ lên
          </Button>
        }
      />
      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        accept=".xml,.pdf,image/jpeg,image/png,image/webp"
        onChange={(e) => {
          const chosen = [...(e.target.files ?? [])];
          if (chosen.length) upload.mutate(chosen);
          e.target.value = '';
        }}
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={cx(
            'flex flex-col items-center justify-center rounded-xl border border-dashed px-6 py-8 text-center transition-colors lg:col-span-2',
            dragging ? 'border-brand-500 bg-brand-600/10' : 'border-line bg-surface',
          )}
        >
          <p className="text-sm font-medium text-fg">Kéo thả hóa đơn vào đây</p>
          <p className="mt-1 text-xs text-fg-3">
            XML hóa đơn điện tử{config.aiEnabled ? ', PDF hoặc ảnh chụp' : ''} · tối đa 25 MB mỗi tệp
          </p>
          {!config.aiEnabled && (
            <p className="mt-3 text-xs text-amber-300">Chưa cấu hình AI: hiện chỉ đọc được tệp XML hóa đơn điện tử.</p>
          )}
          {upload.error && (
            <div className="mt-3">
              <ErrorText>{errorMessage(upload.error)}</ErrorText>
            </div>
          )}
        </div>
        <Card className="p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-fg-3">Forward hóa đơn qua email</p>
          {org.data?.inboundAddress ? (
            <>
              <p className="mt-2 break-all font-mono text-sm text-fg">{org.data.inboundAddress}</p>
              <Button className="mt-3" onClick={() => void navigator.clipboard.writeText(org.data?.inboundAddress ?? '')}>
                Chép địa chỉ
              </Button>
            </>
          ) : (
            <p className="mt-2 text-sm text-fg-2">Máy chủ này chưa bật nhận email. Bạn vẫn có thể tải tệp lên.</p>
          )}
        </Card>
      </div>

      {(files.data?.length ?? 0) > 0 && (
        <div className="mt-6">
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-fg-3">
            Tệp mới nhận {processing > 0 && <span className="ml-1 normal-case text-brand-300">· đang đọc {processing} tệp</span>}
          </p>
          <div className="flex flex-wrap gap-2">
            {files.data?.slice(0, 8).map((f) => (
              <span key={f.id} className="inline-flex max-w-full items-center gap-2 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-xs" title={f.error ?? undefined}>
                <span className="max-w-[16rem] truncate text-fg-2">{f.filename}</span>
                <Badge tone={FILE_STATUS[f.status]?.tone ?? 'neutral'}>{FILE_STATUS[f.status]?.label ?? f.status}</Badge>
              </span>
            ))}
          </div>
          {files.data?.find((f) => f.status === 'failed')?.error && (
            <p className="mt-2 text-xs text-rose-300">{files.data.find((f) => f.status === 'failed')?.error}</p>
          )}
        </div>
      )}

      <div className="mt-8 flex gap-1 border-b border-line">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={cx('-mb-px border-b-2 px-3 py-2 text-sm', tab === t.id ? 'border-brand-500 text-fg' : 'border-transparent text-fg-3 hover:text-fg-2')}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="mt-4">
        {items.isLoading ? (
          <Spinner />
        ) : (items.data?.length ?? 0) === 0 ? (
          <Empty title={tab === 'pending' ? 'Không có đề xuất nào chờ duyệt' : 'Chưa có mục nào'} hint={tab === 'pending' ? 'Tải hóa đơn lên để bắt đầu.' : undefined} />
        ) : (
          <Table head={['Chứng từ', 'Ngày HĐ', 'Tổng tiền', 'Kiểm tra', 'Nhận lúc']}>
            {items.data?.map((item) => (
              <tr key={item.id} className="hover:bg-surface-2">
                <td className="px-4 py-3">
                  <Link to="/o/$slug/inbox/$id" params={{ slug, id: item.id }} className="font-medium text-fg hover:text-brand-300">
                    {item.sellerName ?? item.title}
                  </Link>
                  <p className="text-xs text-fg-3">{item.title}</p>
                </td>
                <td className="px-4 py-3 text-fg-2">{formatDate(item.issueDate)}</td>
                <td className="tabular px-4 py-3 text-fg">{formatMoney(item.total)}</td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap gap-1">
                    {item.duplicateOf && <Badge tone="warn">Có thể trùng</Badge>}
                    {item.failedChecks > 0 && <Badge tone="bad">{item.failedChecks} lỗi</Badge>}
                    {item.warnChecks > 0 && <Badge tone="warn">{item.warnChecks} lưu ý</Badge>}
                    {item.failedChecks === 0 && item.warnChecks === 0 && !item.duplicateOf && <Badge tone="good">Khớp</Badge>}
                  </div>
                </td>
                <td className="px-4 py-3 text-xs text-fg-3">{formatDateTime(item.createdAt)}</td>
              </tr>
            ))}
          </Table>
        )}
      </div>
    </>
  );
}
