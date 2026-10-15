import { useMutation, useQuery } from '@tanstack/react-query';
import { useRef, useState, type FormEvent } from 'react';
import { Badge, Button, Card, ErrorText, Input, PageHeader, Spinner } from '../components/ui.tsx';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';
import { formatDateTime } from '../lib/format.ts';
import { INVITE_ROLE_LABEL } from './invites.tsx';

const ROLE_LABEL = { owner: 'Chủ sở hữu', admin: 'Quản trị', member: 'Thành viên', viewer: 'Chỉ xem' } as const;
type Role = keyof typeof ROLE_LABEL;
const ROLES = Object.keys(ROLE_LABEL) as Role[];

interface MemberRow {
  userId: string;
  email: string;
  displayName: string | null;
  role: Role;
}

// Owner controls for one member: change the role, or remove them after an inline confirmation. The server
// enforces every rule (owners only, the org keeps an owner, no self-removal); the screen only hides what can never
// succeed. One idempotency key per confirmed removal, so a retried request is replayed, not repeated.
function MemberControls({ member }: { member: MemberRow }) {
  const [confirming, setConfirming] = useState(false);
  const [removeKey, setRemoveKey] = useState(() => crypto.randomUUID());
  const done = () => void queryClient.invalidateQueries();
  const changeRole = useMutation(orpc.org.changeMemberRole.mutationOptions({ onSuccess: done }));
  const remove = useMutation(
    orpc.org.removeMember.mutationOptions({
      onSuccess: () => {
        setConfirming(false);
        setRemoveKey(crypto.randomUUID());
        done();
      },
    }),
  );
  const busy = changeRole.isPending || remove.isPending;
  const error = changeRole.error ?? remove.error;
  const name = member.displayName ?? member.email;

  if (confirming) {
    return (
      <div className="max-w-xs space-y-2 rounded-lg border border-rose-500/30 bg-rose-500/5 p-3 text-sm" role="alertdialog" aria-label={`Xác nhận xóa ${name}`}>
        <p className="font-medium text-fg">Xóa {name} khỏi tổ chức?</p>
        <p className="text-fg-2">Người này mất quyền truy cập tổ chức ngay từ yêu cầu tiếp theo. Bạn có thể mời lại họ sau.</p>
        <div className="flex gap-2">
          <Button variant="danger" disabled={busy} onClick={() => remove.mutate({ userId: member.userId, idempotencyKey: removeKey })}>
            Xác nhận xóa
          </Button>
          <Button variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>
            Hủy
          </Button>
        </div>
        {remove.error && <ErrorText>{errorMessage(remove.error)}</ErrorText>}
      </div>
    );
  }
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        <select
          className="rounded-lg border border-line bg-surface-2 px-2 py-1 text-sm text-fg"
          value={member.role}
          disabled={busy}
          onChange={(e) => changeRole.mutate({ userId: member.userId, role: e.target.value as Role, idempotencyKey: crypto.randomUUID() })}
          aria-label={`Vai trò của ${name}`}
        >
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABEL[r]}
            </option>
          ))}
        </select>
        <Button
          variant="danger"
          className="px-2.5 py-1"
          disabled={busy}
          onClick={() => {
            remove.reset();
            setConfirming(true);
          }}
        >
          Xóa
        </Button>
      </div>
      {error && <ErrorText>{errorMessage(error)}</ErrorText>}
    </div>
  );
}

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

const INVITE_STATUS = {
  pending: { label: 'Đang chờ', tone: 'warn' },
  expired: { label: 'Hết hạn', tone: 'neutral' },
  declined: { label: 'Đã từ chối', tone: 'bad' },
} as const;

interface OrgInvite {
  inviteId: string;
  email: string;
  role: keyof typeof INVITE_ROLE_LABEL;
  status: keyof typeof INVITE_STATUS;
  invitedBy: string | null;
  expiresAt: string;
}

// One invite on the org's list. Owners revoke any invite and admins member and viewer invites; the server enforces
// it, the screen hides only what can never succeed.
function InviteListRow({ invite, isOwner }: { invite: OrgInvite; isOwner: boolean }) {
  const [revokeKey] = useState(() => crypto.randomUUID());
  const revoke = useMutation(orpc.org.revokeInvite.mutationOptions({ onSuccess: () => void queryClient.invalidateQueries() }));
  const status = INVITE_STATUS[invite.status];
  const canRevoke = invite.status !== 'declined' && (isOwner || invite.role !== 'admin');
  return (
    <li className="space-y-1 py-2 text-sm">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-fg">{invite.email}</p>
          <p className="text-xs text-fg-3">
            {INVITE_ROLE_LABEL[invite.role]}
            {invite.invitedBy ? ` · mời bởi ${invite.invitedBy}` : ''}
            {invite.status === 'pending' ? ` · hết hạn ${formatDateTime(invite.expiresAt)}` : ''}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Badge tone={status.tone}>{status.label}</Badge>
          {canRevoke && (
            <Button
              variant="ghost"
              className="px-2.5 py-1"
              disabled={revoke.isPending}
              onClick={() => revoke.mutate({ inviteId: invite.inviteId, idempotencyKey: revokeKey })}
            >
              Thu hồi
            </Button>
          )}
        </div>
      </div>
      {revoke.error && <ErrorText>{errorMessage(revoke.error)}</ErrorText>}
    </li>
  );
}

// Owners and admins invite by email; the person joins only after accepting, signed in with that email. Inviting an
// address again replaces its open invite. One idempotency key per address and role, so a retried submit is replayed.
function InviteMembers({ isOwner }: { isOwner: boolean }) {
  const invites = useQuery(orpc.org.invites.queryOptions());
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'admin' | 'member' | 'viewer'>('member');
  const [sent, setSent] = useState<string | null>(null);
  const attempt = useRef<{ email: string; role: string; key: string } | null>(null);
  const invite = useMutation(
    orpc.org.invite.mutationOptions({
      onSuccess: (result) => {
        setSent(result.email);
        setEmail('');
        attempt.current = null;
        void queryClient.invalidateQueries();
      },
    }),
  );

  function submit(event: FormEvent) {
    event.preventDefault();
    const normalized = email.trim().toLowerCase();
    if (attempt.current?.email !== normalized || attempt.current.role !== role) {
      attempt.current = { email: normalized, role, key: crypto.randomUUID() };
    }
    setSent(null);
    invite.mutate({ email: normalized, role, idempotencyKey: attempt.current.key });
  }

  return (
    <div className="mt-4 space-y-3 border-t border-line pt-4">
      <form className="space-y-2" onSubmit={submit}>
        <p className="text-xs text-fg-3">
          Mời bằng email. Người được mời chỉ trở thành thành viên sau khi đăng nhập bằng email này và chấp nhận lời mời (hết hạn sau 7 ngày).
        </p>
        <div className="flex gap-2">
          <Input
            type="email"
            required
            placeholder="email@congty.vn"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            aria-label="Email người được mời"
          />
          <select
            className="rounded-lg border border-line bg-surface-2 px-2 text-sm text-fg"
            value={role}
            onChange={(e) => setRole(e.target.value as typeof role)}
            aria-label="Vai trò"
          >
            {isOwner && <option value="admin">Quản trị</option>}
            <option value="member">Thành viên</option>
            <option value="viewer">Chỉ xem</option>
          </select>
          <Button type="submit" disabled={invite.isPending}>
            Mời
          </Button>
        </div>
        {sent && (
          <p className="text-sm text-fg-2" role="status">
            Đã gửi lời mời tới {sent}. Họ sẽ thấy lời mời khi đăng nhập vào Crove.
          </p>
        )}
        {invite.error && <ErrorText>{errorMessage(invite.error)}</ErrorText>}
      </form>
      {invites.error && <ErrorText>{errorMessage(invites.error)}</ErrorText>}
      {(invites.data?.length ?? 0) > 0 && (
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-fg-3">Lời mời</p>
          <ul className="mt-1 divide-y divide-[var(--line)]">
            {invites.data?.map((i) => (
              <InviteListRow key={i.inviteId} invite={i} isOwner={isOwner} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function SettingsPage() {
  const org = useQuery(orpc.org.get.queryOptions());
  const me = useQuery(orpc.me.get.queryOptions());

  if (org.isLoading) return <Spinner />;
  if (org.error) return <ErrorText>{errorMessage(org.error)}</ErrorText>;
  const canManage = org.data?.role === 'owner' || org.data?.role === 'admin';
  const isOwner = org.data?.role === 'owner';

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
              <li key={m.userId} className="flex items-center justify-between gap-3 py-2 text-sm">
                <span className="truncate text-fg">{m.displayName ?? m.email}</span>
                {isOwner && me.data && m.userId !== me.data.userId ? (
                  <MemberControls member={m} />
                ) : (
                  <Badge tone={m.role === 'owner' ? 'brand' : 'neutral'}>{ROLE_LABEL[m.role]}</Badge>
                )}
              </li>
            ))}
          </ul>
          {canManage && <InviteMembers isOwner={isOwner} />}
        </Card>
      </div>
    </>
  );
}
