import { useMutation, useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { MemberSessions, MySessions } from '../components/sessions.tsx';
import { Badge, Button, Card, ErrorText, Input, PageHeader, Spinner } from '../components/ui.tsx';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';
import { formatDateTime } from '../lib/format.ts';
import { ROLES, ROLE_LABEL, roleChangeConfirmation, type Role, type RoleChangeConfirmation } from '../lib/members.ts';

interface MemberRow {
  userId: string;
  email: string;
  displayName: string | null;
  role: Role;
}

type Pending = { kind: 'remove' } | { kind: 'role'; role: Role; confirmation: RoleChangeConfirmation };

// Owner controls for one member, the owner themself included: change the role, or remove another member. Removal and
// every change that gives or takes owner rights (promotion to owner, demoting an owner, the owner's own role) wait
// for an inline confirmation (#119). The server enforces every rule (owners only, the org keeps an owner, no
// self-removal, fresh MFA); the screen only hides what can never succeed. One idempotency key per confirmation, so a
// retried request is replayed, not repeated.
function MemberControls({ member, self }: { member: MemberRow; self: boolean }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [confirmKey, setConfirmKey] = useState(() => crypto.randomUUID());
  const settled = () => {
    setPending(null);
    setConfirmKey(crypto.randomUUID());
    void queryClient.invalidateQueries();
  };
  const changeRole = useMutation(orpc.org.changeMemberRole.mutationOptions({ onSuccess: settled }));
  const remove = useMutation(orpc.org.removeMember.mutationOptions({ onSuccess: settled }));
  const busy = changeRole.isPending || remove.isPending;
  const name = self ? 'bạn' : (member.displayName ?? member.email);

  const ask = (next: Pending) => {
    changeRole.reset();
    remove.reset();
    setConfirmKey(crypto.randomUUID());
    setPending(next);
  };
  const pickRole = (role: Role) => {
    const confirmation = roleChangeConfirmation({ name, from: member.role, to: role, self });
    if (confirmation) ask({ kind: 'role', role, confirmation });
    else if (role !== member.role) changeRole.mutate({ userId: member.userId, role, idempotencyKey: crypto.randomUUID() });
  };

  if (pending) {
    const text =
      pending.kind === 'remove'
        ? { title: `Xóa ${name} khỏi tổ chức?`, body: 'Người này mất quyền truy cập tổ chức ngay từ yêu cầu tiếp theo. Bạn có thể mời lại họ sau.', action: 'Xác nhận xóa' }
        : pending.confirmation;
    const confirm = () =>
      pending.kind === 'remove'
        ? remove.mutate({ userId: member.userId, idempotencyKey: confirmKey })
        : changeRole.mutate({ userId: member.userId, role: pending.role, idempotencyKey: confirmKey });
    const error = pending.kind === 'remove' ? remove.error : changeRole.error;
    return (
      <div className="max-w-xs space-y-2 rounded-lg border border-rose-500/30 bg-rose-500/5 p-3 text-sm" role="alertdialog" aria-label={text.title}>
        <p className="font-medium text-fg">{text.title}</p>
        <p className="text-fg-2">{text.body}</p>
        <div className="flex gap-2">
          <Button variant="danger" disabled={busy} onClick={confirm}>
            {text.action}
          </Button>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => {
              changeRole.reset();
              remove.reset();
              setPending(null);
            }}
          >
            Hủy
          </Button>
        </div>
        {error && <ErrorText>{errorMessage(error)}</ErrorText>}
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
          onChange={(e) => pickRole(e.target.value as Role)}
          aria-label={self ? 'Vai trò của bạn' : `Vai trò của ${name}`}
        >
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABEL[r]}
            </option>
          ))}
        </select>
        {!self && (
          <Button variant="danger" className="px-2.5 py-1" disabled={busy} onClick={() => ask({ kind: 'remove' })}>
            Xóa
          </Button>
        )}
      </div>
      {changeRole.error && <ErrorText>{errorMessage(changeRole.error)}</ErrorText>}
    </div>
  );
}

// Owner only. One idempotency key per confirmation, so a retried request never rotates twice. R3 (#113): without a
// second factor in the last 5 minutes the server answers STEP_UP_REQUIRED, shown below the buttons like any error;
// the key is kept until a rotation succeeds, so a retry after a refusal can still rotate at most once. The fresh
// MFA challenge screen (StepUpPrompt) lands with the SPA MFA flows (#32).
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
      <p className="text-fg-3">Việc này cần xác thực hai lớp (MFA) trong 5 phút gần nhất. Mỗi tổ chức chỉ đổi được vài lần mỗi ngày.</p>
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

type InviteRole = 'admin' | 'member' | 'viewer';

// The accept link is shown once, right after the invite is created: the server keeps only a hash of its token.
function CreatedInvite({ invite, onDone }: { invite: { email: string; expiresAt: string; acceptPath: string }; onDone: () => void }) {
  const link = `${window.location.origin}${invite.acceptPath}`;
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-4 space-y-2 rounded-lg border border-line bg-surface-2 p-3 text-sm" role="status">
      <p className="text-fg">Đã tạo lời mời cho {invite.email}.</p>
      <p className="text-fg-2">
        Crove chưa tự gửi email mời. Hãy gửi liên kết dưới đây cho người được mời; chỉ người đăng nhập bằng đúng email này mới chấp nhận được.
        Liên kết chỉ hiện một lần, dùng được một lần và hết hạn lúc {formatDateTime(invite.expiresAt)}.
      </p>
      <p className="break-all rounded border border-line bg-surface px-2 py-1 font-mono text-xs text-fg">{link}</p>
      <div className="flex gap-2">
        <Button
          onClick={() =>
            void navigator.clipboard.writeText(link).then(
              () => setCopied(true),
              () => setCopied(false),
            )
          }
        >
          {copied ? 'Đã sao chép' : 'Sao chép liên kết'}
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Đóng
        </Button>
      </div>
    </div>
  );
}

function InviteMember({ isOwner }: { isOwner: boolean }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<InviteRole>('member');
  const invite = useMutation(
    orpc.org.invite.mutationOptions({
      onSuccess: () => {
        setEmail('');
        void queryClient.invalidateQueries({ queryKey: orpc.org.listInvites.key() });
      },
    }),
  );

  function submit(event: FormEvent) {
    event.preventDefault();
    invite.mutate({ email, role });
  }

  return (
    <>
      <form className="mt-4 space-y-2" onSubmit={submit}>
        <p className="text-xs text-fg-3">Mời thành viên qua email. Người được mời phải chấp nhận thì mới vào tổ chức.</p>
        <div className="flex gap-2">
          <Input type="email" required maxLength={320} placeholder="email@congty.vn" value={email} onChange={(e) => setEmail(e.target.value)} />
          <select
            className="rounded-lg border border-line bg-surface-2 px-2 text-sm text-fg"
            value={role}
            onChange={(e) => setRole(e.target.value as InviteRole)}
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
        {invite.error && <ErrorText>{errorMessage(invite.error)}</ErrorText>}
      </form>
      {invite.data && <CreatedInvite invite={invite.data} onDone={() => invite.reset()} />}
    </>
  );
}

function PendingInvites() {
  const invites = useQuery(orpc.org.listInvites.queryOptions());
  const revoke = useMutation(
    orpc.org.revokeInvite.mutationOptions({
      onSuccess: () => void queryClient.invalidateQueries({ queryKey: orpc.org.listInvites.key() }),
    }),
  );
  if (invites.isLoading) return <Spinner />;
  if (invites.error) return <ErrorText>{errorMessage(invites.error)}</ErrorText>;
  if (!invites.data?.length) return null;
  return (
    <div className="mt-4">
      <p className="text-xs font-medium uppercase tracking-wide text-fg-3">Lời mời đang chờ</p>
      <ul className="mt-2 divide-y divide-[var(--line)]">
        {invites.data.map((i) => (
          <li key={i.id} className="flex items-center justify-between gap-2 py-2 text-sm">
            <div className="min-w-0">
              <p className="truncate text-fg">{i.email}</p>
              <p className="text-xs text-fg-3">
                {i.status === 'expired' ? 'Đã hết hạn' : `Hết hạn ${formatDateTime(i.expiresAt)}`}
                {i.invitedBy ? ` · mời bởi ${i.invitedBy}` : ''}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Badge tone={i.status === 'expired' ? 'warn' : 'neutral'}>{ROLE_LABEL[i.role]}</Badge>
              <Button variant="ghost" disabled={revoke.isPending} onClick={() => revoke.mutate({ inviteId: i.id })}>
                Thu hồi
              </Button>
            </div>
          </li>
        ))}
      </ul>
      {revoke.error && <ErrorText>{errorMessage(revoke.error)}</ErrorText>}
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
  // An owner may change their own role only while another owner remains (otherwise the server refuses LAST_OWNER).
  const owners = org.data?.members.filter((m) => m.role === 'owner').length ?? 0;
  const controlsFor = (userId: string) => isOwner && !!me.data && (userId !== me.data.userId || owners > 1);

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
              <li key={m.userId} className="py-2 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <span className="truncate text-fg">{m.displayName ?? m.email}</span>
                  {controlsFor(m.userId) ? (
                    <MemberControls member={m} self={m.userId === me.data?.userId} />
                  ) : (
                    <Badge tone={m.role === 'owner' ? 'brand' : 'neutral'}>{ROLE_LABEL[m.role]}</Badge>
                  )}
                </div>
                {isOwner && me.data && m.userId !== me.data.userId && <MemberSessions userId={m.userId} name={m.displayName ?? m.email} />}
              </li>
            ))}
          </ul>
          {canManage && (
            <>
              <InviteMember isOwner={isOwner} />
              <PendingInvites />
            </>
          )}
        </Card>
        {me.data && <MySessions userId={me.data.userId} />}
      </div>
    </>
  );
}
