import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { Badge, Button, Card, Empty, ErrorText, Logo, PageHeader, Spinner } from '../components/ui.tsx';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';
import { formatDateTime } from '../lib/format.ts';

export const INVITE_ROLE_LABEL = { admin: 'Quản trị', member: 'Thành viên', viewer: 'Chỉ xem' } as const;

interface MyInvite {
  orgId: string;
  inviteId: string;
  orgName: string;
  role: keyof typeof INVITE_ROLE_LABEL;
  invitedBy: string;
  expiresAt: string;
}

// One pending invite: accept joins the org and opens it; decline closes the invite for good (the inviter sees it).
// One idempotency key per accept, so a retried click joins once.
function InviteRow({ invite }: { invite: MyInvite }) {
  const navigate = useNavigate();
  const [acceptKey] = useState(() => crypto.randomUUID());
  const accept = useMutation(
    orpc.invites.accept.mutationOptions({
      onSuccess: async (org) => {
        await queryClient.invalidateQueries();
        await navigate({ to: '/o/$slug/inbox', params: { slug: org.slug } });
      },
    }),
  );
  const decline = useMutation(orpc.invites.decline.mutationOptions({ onSuccess: () => void queryClient.invalidateQueries() }));
  const busy = accept.isPending || decline.isPending;
  const error = accept.error ?? decline.error;
  return (
    <li className="space-y-2 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-fg">{invite.orgName}</p>
          <p className="text-xs text-fg-3">
            {invite.invitedBy} mời bạn tham gia với vai trò <Badge>{INVITE_ROLE_LABEL[invite.role]}</Badge> · hết hạn {formatDateTime(invite.expiresAt)}
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="primary"
            disabled={busy}
            onClick={() => accept.mutate({ orgId: invite.orgId, inviteId: invite.inviteId, idempotencyKey: acceptKey })}
          >
            {accept.isPending ? 'Đang tham gia…' : 'Tham gia'}
          </Button>
          <Button variant="ghost" disabled={busy} onClick={() => decline.mutate({ orgId: invite.orgId, inviteId: invite.inviteId })}>
            Từ chối
          </Button>
        </div>
      </div>
      {error && <ErrorText>{errorMessage(error)}</ErrorText>}
    </li>
  );
}

// The signed-in user's pending invites. Renders nothing while there are none, unless `showEmpty`.
export function MyInvites({ showEmpty = false }: { showEmpty?: boolean }) {
  const invites = useQuery(orpc.invites.mine.queryOptions());
  if (invites.isLoading) return showEmpty ? <Spinner /> : null;
  if (invites.error) return <ErrorText>{errorMessage(invites.error)}</ErrorText>;
  const list = invites.data ?? [];
  if (list.length === 0) {
    return showEmpty ? <Empty title="Bạn không có lời mời nào đang chờ" hint="Lời mời được gửi tới email bạn dùng để đăng nhập." /> : null;
  }
  return (
    <Card className="p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-fg-3">Lời mời đang chờ bạn</p>
      <ul className="mt-1 divide-y divide-[var(--line)]">
        {list.map((invite) => (
          <InviteRow key={invite.inviteId} invite={invite} />
        ))}
      </ul>
    </Card>
  );
}

export function InvitesPage() {
  const me = useQuery(orpc.me.get.queryOptions());
  const first = me.data?.orgs[0];
  return (
    <main className="min-h-full bg-canvas px-4 py-10">
      <div className="mx-auto w-full max-w-2xl">
        <div className="mb-8 flex items-center justify-between">
          <Logo />
          {first ? (
            <Link to="/o/$slug/inbox" params={{ slug: first.slug }} className="text-sm text-fg-2 hover:text-fg">
              Về tổ chức của bạn
            </Link>
          ) : (
            <Link to="/onboarding" className="text-sm text-fg-2 hover:text-fg">
              Tạo tổ chức
            </Link>
          )}
        </div>
        <PageHeader title="Lời mời" subtitle={me.data ? `Gửi tới ${me.data.email}` : undefined} />
        <MyInvites showEmpty />
      </div>
    </main>
  );
}
