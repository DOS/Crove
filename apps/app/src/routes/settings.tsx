import { useMutation, useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { MemberSessions, MySessions } from '../components/sessions.tsx';
import { Badge, Button, Card, ErrorText, Input, PageHeader, Spinner } from '../components/ui.tsx';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';
import { formatDateTime } from '../lib/format.ts';

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
        <p className="text-fg-2">Người này mất quyền truy cập tổ chức ngay từ yêu cầu tiếp theo. Bạn có thể thêm lại họ sau.</p>
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
                  {isOwner && me.data && m.userId !== me.data.userId ? (
                    <MemberControls member={m} />
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
