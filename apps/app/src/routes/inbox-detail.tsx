import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useEffect, useMemo, useState } from 'react';
import { Badge, Button, Card, ErrorText, PageHeader, Spinner } from '../components/ui.tsx';
import { apiFetch, errorMessage, orpc, queryClient } from '../lib/api.ts';
import { previewPurchaseJournal } from '../lib/decimal.ts';
import { formatDate, formatDateTime, formatMoney } from '../lib/format.ts';

const CHECK_TONE = { pass: 'good', warn: 'warn', fail: 'bad' } as const;
const CHECK_ICON = { pass: '✓', warn: '!', fail: '✕' } as const;

function FilePreview({ fileId, contentType, filename }: { fileId: string; contentType: string; filename: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let revoked: string | null = null;
    apiFetch(`/api/files/${fileId}`)
      .then((r) => r.blob())
      .then((blob) => {
        revoked = URL.createObjectURL(blob);
        setUrl(revoked);
      })
      .catch((e: unknown) => setError(errorMessage(e)));
    return () => {
      if (revoked) URL.revokeObjectURL(revoked);
    };
  }, [fileId]);
  if (error) return <ErrorText>{error}</ErrorText>;
  if (!url) return <Spinner />;
  if (contentType.startsWith('image/')) return <img src={url} alt={filename} className="w-full rounded-lg border border-line" />;
  if (contentType === 'application/pdf')
    return (
      <div className="rounded-lg border border-line bg-surface-2 p-4 text-sm">
        <p className="text-fg">{filename}</p>
        <a href={url} target="_blank" rel="noopener noreferrer" className="mt-3 inline-block text-brand-300 hover:underline">
          Mở PDF trong tab mới
        </a>
      </div>
    );
  return (
    <div className="rounded-lg border border-line bg-surface-2 p-4 text-sm">
      <p className="text-fg">Tệp XML hóa đơn điện tử</p>
      <p className="mt-1 text-xs text-fg-3">Dữ liệu được đọc trực tiếp từ XML, không qua AI.</p>
      <a href={url} download={filename} className="mt-3 inline-block text-brand-300 hover:underline">
        Tải {filename}
      </a>
    </div>
  );
}

export function InboxDetailPage() {
  const { slug, id } = useParams({ strict: false }) as { slug: string; id: string };
  const navigate = useNavigate();
  const detail = useQuery(orpc.inbox.get.queryOptions({ input: { id } }));
  const accounts = useQuery(orpc.accounts.list.queryOptions());
  const [lineAccounts, setLineAccounts] = useState<Record<number, string>>({});
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [acceptFailed, setAcceptFailed] = useState(false);

  const payload = detail.data?.payload ?? null;
  const lines = useMemo(
    () => (payload?.lines ?? []).map((l) => ({ ...l, debitAccount: lineAccounts[l.lineNo] ?? l.debitAccount })),
    [payload, lineAccounts],
  );
  const journal = useMemo(() => (payload ? previewPurchaseJournal(lines, payload.invoice.vatTotal) : []), [payload, lines]);
  const accountName = (code: string) => accounts.data?.find((a) => a.code === code)?.name ?? '';

  const done = async () => {
    await queryClient.invalidateQueries();
    await navigate({ to: '/o/$slug/inbox', params: { slug } });
  };
  const approve = useMutation(orpc.inbox.approve.mutationOptions({ onSuccess: done }));
  const reject = useMutation(orpc.inbox.reject.mutationOptions({ onSuccess: done }));

  if (detail.isLoading) return <Spinner />;
  if (detail.error) return <ErrorText>{errorMessage(detail.error)}</ErrorText>;
  const item = detail.data;
  if (!item) return null;
  const pending = item.status === 'pending';
  const failed = payload?.checks.filter((c) => c.status === 'fail').length ?? 0;
  const currency = payload?.invoice.currency ?? 'VND';
  const money = (value: string | null | undefined) => formatMoney(value, currency);

  return (
    <>
      <Link to="/o/$slug/inbox" params={{ slug }} className="text-sm text-fg-3 hover:text-fg-2">
        ← Hộp thư chứng từ
      </Link>
      <div className="mt-3">
        <PageHeader
          title={payload?.seller.name ?? item.title}
          subtitle={payload ? `Hóa đơn ${payload.invoice.series ? `${payload.invoice.series} · ` : ''}số ${payload.invoice.number} · ngày ${formatDate(payload.invoice.issueDate)}` : undefined}
          actions={
            pending ? (
              <>
                <Button
                  variant="danger"
                  disabled={reject.isPending || approve.isPending}
                  onClick={() => {
                    const reason = window.prompt('Lý do từ chối (không bắt buộc)');
                    if (reason === null) return;
                    reject.mutate({ id, ...(reason.trim() ? { reason: reason.trim().slice(0, 500) } : {}) });
                  }}
                >
                  Từ chối
                </Button>
                <Button
                  variant="primary"
                  disabled={approve.isPending || reject.isPending || !payload || (failed > 0 && !acceptFailed)}
                  onClick={() =>
                    approve.mutate({
                      id,
                      revision: item.revision,
                      idempotencyKey,
                      lineAccounts: lines.map((l) => ({ lineNo: l.lineNo, debitAccount: l.debitAccount })),
                      ...(failed > 0 ? { acceptFailedChecks: acceptFailed } : {}),
                    })
                  }
                >
                  {approve.isPending ? <Spinner /> : null}
                  Duyệt và ghi sổ
                </Button>
              </>
            ) : (
              <Badge tone={item.status === 'executed' ? 'good' : 'neutral'}>
                {item.status === 'executed' ? `Đã ghi sổ ${formatDateTime(item.decidedAt)}` : item.status === 'rejected' ? 'Đã từ chối' : item.status}
              </Badge>
            )
          }
        />
      </div>
      {(approve.error || reject.error) && (
        <div className="mb-4">
          <ErrorText>{errorMessage(approve.error ?? reject.error)}</ErrorText>
        </div>
      )}
      {pending && failed > 0 && (
        <div className="mb-4 space-y-2">
          <ErrorText>Có {failed} kiểm tra không đạt. Hãy đối chiếu với chứng từ gốc trước khi duyệt.</ErrorText>
          <label className="flex items-center gap-2 text-sm text-fg-2">
            <input type="checkbox" checked={acceptFailed} onChange={(e) => setAcceptFailed(e.target.checked)} />
            Tôi đã đối chiếu chứng từ gốc và vẫn muốn ghi sổ
          </label>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-5">
        <div className="space-y-6 lg:col-span-3">
          {payload && (
            <Card className="grid gap-4 p-4 sm:grid-cols-2">
              <div>
                <p className="text-xs uppercase tracking-wide text-fg-3">Người bán</p>
                <p className="mt-1 text-sm font-medium text-fg">{payload.seller.name}</p>
                <p className="text-xs text-fg-2">MST {payload.seller.taxCode ?? 'không có'}</p>
                <p className="text-xs text-fg-3">{payload.seller.address}</p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-wide text-fg-3">Người mua</p>
                <p className="mt-1 text-sm font-medium text-fg">{payload.buyer.name || 'Không ghi'}</p>
                <p className="text-xs text-fg-2">MST {payload.buyer.taxCode ?? 'không có'}</p>
              </div>
              <div className="grid grid-cols-3 gap-2 sm:col-span-2">
                <div>
                  <p className="text-xs text-fg-3">Trước thuế</p>
                  <p className="tabular text-sm text-fg">{money(payload.invoice.subtotal)}</p>
                </div>
                <div>
                  <p className="text-xs text-fg-3">Thuế GTGT</p>
                  <p className="tabular text-sm text-fg">{money(payload.invoice.vatTotal)}</p>
                </div>
                <div>
                  <p className="text-xs text-fg-3">Tổng thanh toán</p>
                  <p className="tabular text-base font-semibold text-fg">{money(payload.invoice.total)}</p>
                </div>
                <p className="text-xs text-fg-3 sm:col-span-3">Đơn vị tiền: {currency}</p>
              </div>
            </Card>
          )}

          {payload && (
            <Card className="p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-fg-3">Kiểm tra tự động</p>
              <ul className="mt-3 space-y-1.5">
                {payload.checks.map((c) => (
                  <li key={c.id} className="flex items-start gap-2 text-sm">
                    <Badge tone={CHECK_TONE[c.status]}>{CHECK_ICON[c.status]}</Badge>
                    <span className="text-fg-2">{c.message}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {payload && (
            <Card className="overflow-x-auto p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-fg-3">Dòng hàng hóa, dịch vụ</p>
              <table className="mt-3 w-full min-w-[560px] text-sm">
                <thead className="text-left text-xs text-fg-3">
                  <tr>
                    <th className="py-1.5 pr-2 font-medium">Diễn giải</th>
                    <th className="py-1.5 pr-2 text-right font-medium">Thành tiền</th>
                    <th className="py-1.5 font-medium">TK Nợ</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--line)]">
                  {lines.map((l) => (
                    <tr key={l.lineNo}>
                      <td className="py-2 pr-2 text-fg">
                        {l.description}
                        <p className="text-xs text-fg-3">{l.reason}</p>
                      </td>
                      <td className="tabular py-2 pr-2 text-right text-fg">{money(l.amount)}</td>
                      <td className="py-2">
                        <select
                          disabled={!pending}
                          aria-label={`Tài khoản nợ cho dòng ${l.lineNo}`}
                          className="w-48 rounded-lg border border-line bg-surface-2 px-2 py-1 text-sm text-fg"
                          value={l.debitAccount}
                          onChange={(e) => setLineAccounts((prev) => ({ ...prev, [l.lineNo]: e.target.value }))}
                        >
                          {(accounts.data ?? [{ code: l.debitAccount, name: '', parentCode: null }]).map((a) => (
                            <option key={a.code} value={a.code}>
                              {a.code} · {a.name}
                            </option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}

          {payload && (
            <Card className="p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-fg-3">Bút toán đề xuất (TT133)</p>
              <table className="mt-3 w-full text-sm">
                <thead className="text-left text-xs text-fg-3">
                  <tr>
                    <th className="py-1.5 font-medium">Tài khoản</th>
                    <th className="py-1.5 text-right font-medium">Nợ</th>
                    <th className="py-1.5 text-right font-medium">Có</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--line)]">
                  {journal.map((j) => (
                    <tr key={`${j.accountCode}-${j.debit}-${j.credit}`}>
                      <td className="py-2 text-fg">
                        <span className="font-mono">{j.accountCode}</span> <span className="text-fg-3">{accountName(j.accountCode)}</span>
                      </td>
                      <td className="tabular py-2 text-right text-fg">{j.debit !== '0' ? money(j.debit) : ''}</td>
                      <td className="tabular py-2 text-right text-fg">{j.credit !== '0' ? money(j.credit) : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}
        </div>
        <div className="lg:col-span-2">
          <Card className="p-4">
            <p className="mb-3 text-xs font-medium uppercase tracking-wide text-fg-3">Chứng từ gốc</p>
            {item.file ? <FilePreview fileId={item.file.id} contentType={item.file.contentType} filename={item.file.filename} /> : <p className="text-sm text-fg-3">Không có tệp</p>}
          </Card>
        </div>
      </div>
    </>
  );
}
