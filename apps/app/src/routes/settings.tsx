import { useMutation, useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Badge, Button, Card, ErrorText, Input, PageHeader, Spinner } from '../components/ui.tsx';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';

const ROLE_LABEL = { owner: 'Chủ sở hữu', admin: 'Quản trị', member: 'Thành viên', viewer: 'Chỉ xem' } as const;

// Owner only. One idempotency key per confirmation, so a retried request never rotates twice.
function RotateInboundAddress() {
  const [confirming, setConfirming] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [rotated, setRotated] = useState<string | null>(null);
  const rotate = useMutation(
    orpc.org.rotateInbound.mutationOptions({
      onSuccess: (result) => {
        setConfirming(false);
        setRotated(result.inboundAddress);
        setIdempotencyKey(crypto.randomUUID());
        void queryClient.invalidateQueries();
      },
    }),
  );

  if (!confirming) {
    return (
      <div className="mt-4 space-y-2">
        {rotated && (
          <div className="rounded-lg border border-line bg-surface-2 p-3 text-sm" role="status">
            <p className="text-fg-2">Đã đổi địa chỉ. Địa chỉ mới:</p>
            <p className="mt-1 break-all font-mono text-fg">{rotated}</p>
          </div>
        )}
        <Button
          variant="danger"
          onClick={() => {
            rotate.reset();
            setConfirming(true);
          }}
        >
          Đổi địa chỉ email nhận hóa đơn
        </Button>
      </div>
    );
  }
  return (
    <div className="mt-4 space-y-3 rounded-lg border border-rose-500/30 bg-rose-500/5 p-3 text-sm" role="alertdialog" aria-label="Xác nhận đổi địa chỉ">
      <p className="font-medium text-fg">Đổi địa chỉ email nhận hóa đơn?</p>
      <p className="text-fg-2">
        Địa chỉ hiện tại sẽ ngừng nhận thư ngay lập tức và không bao giờ được cấp lại. Thư gửi tới địa chỉ cũ sẽ bị bỏ qua mà không báo lỗi cho
        người gửi, vì vậy hãy gửi địa chỉ mới cho các nhà cung cấp.
      </p>
      <div className="flex gap-2">
        <Button variant="danger" disabled={rotate.isPending} onClick={() => rotate.mutate({ idempotencyKey })}>
          Xác nhận đổi địa chỉ
        </Button>
        <Button variant="ghost" disabled={rotate.isPending} onClick={() => setConfirming(false)}>
          Hủy
        </Button>
      </div>
      {rotate.error && <ErrorText>{errorMessage(rotate.error)}</ErrorText>}
    </div>
  );
}

export function SettingsPage() {
  const org = useQuery(orpc.org.get.queryOptions());
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'admin' | 'member' | 'viewer'>('member');
  const add = useMutation(
    orpc.org.addMember.mutationOptions({
      onSuccess: () => {
        setEmail('');
        void queryClient.invalidateQueries();
      },
    }),
  );

  if (org.isLoading) return <Spinner />;
  if (org.error) return <ErrorText>{errorMessage(org.error)}</ErrorText>;
  const canManage = org.data?.role === 'owner' || org.data?.role === 'admin';

  function submit(event: FormEvent) {
    event.preventDefault();
    add.mutate({ email, role });
  }

  return (
    <>
      <PageHeader title="Cài đặt" subtitle={org.data?.name} />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-fg-3">Tổ chức</p>
          <dl className="mt-3 space-y-2 text-sm">
            <div>
              <dt className="text-fg-3">Tên</dt>
              <dd className="text-fg">{org.data?.name}</dd>
            </div>
            <div>
              <dt className="text-fg-3">Mã rút gọn</dt>
              <dd className="font-mono text-fg">{org.data?.slug}</dd>
            </div>
            <div>
              <dt className="text-fg-3">Địa chỉ nhận hóa đơn qua email</dt>
              <dd className="break-all font-mono text-fg">{org.data?.inboundAddress ?? 'Máy chủ chưa bật nhận email'}</dd>
            </div>
          </dl>
          {org.data?.role === 'owner' && org.data.inboundAddress && <RotateInboundAddress />}
        </Card>
        <Card className="p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-fg-3">Thành viên</p>
          <ul className="mt-3 divide-y divide-[var(--line)]">
            {org.data?.members.map((m) => (
              <li key={m.userId} className="flex items-center justify-between py-2 text-sm">
                <span className="truncate text-fg">{m.displayName ?? m.email}</span>
                <Badge tone={m.role === 'owner' ? 'brand' : 'neutral'}>{ROLE_LABEL[m.role]}</Badge>
              </li>
            ))}
          </ul>
          {canManage && (
            <form className="mt-4 space-y-2" onSubmit={submit}>
              <p className="text-xs text-fg-3">Thêm người đã có tài khoản Crove</p>
              <div className="flex gap-2">
                <Input type="email" required placeholder="email@congty.vn" value={email} onChange={(e) => setEmail(e.target.value)} />
                <select
                  className="rounded-lg border border-line bg-surface-2 px-2 text-sm text-fg"
                  value={role}
                  onChange={(e) => setRole(e.target.value as typeof role)}
                  aria-label="Vai trò"
                >
                  <option value="admin">Quản trị</option>
                  <option value="member">Thành viên</option>
                  <option value="viewer">Chỉ xem</option>
                </select>
                <Button type="submit" disabled={add.isPending}>
                  Thêm
                </Button>
              </div>
              {add.error && <ErrorText>{errorMessage(add.error)}</ErrorText>}
            </form>
          )}
        </Card>
      </div>
    </>
  );
}
