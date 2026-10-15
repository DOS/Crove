import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { Button, Card, ErrorText, Logo, Spinner } from '../components/ui.tsx';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';
import { signOut } from '../lib/session-actions.ts';
import { formatDateTime } from '../lib/format.ts';
import { forgetInvite, pendingInvite } from '../lib/invite.ts';

const ROLE_LABEL = { admin: 'quản trị', member: 'thành viên', viewer: 'chỉ xem' } as const;

function errorCode(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : null;
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-full items-center justify-center bg-canvas px-4 py-16">
      <Card className="w-full max-w-md p-6">
        <Logo />
        {children}
      </Card>
    </main>
  );
}

// The invitee's consent screen. The router put the token from the link into storage and made sure the user is
// signed in; the kernel checks that the signed-in email is the invited one before showing or accepting anything.
export function InvitePage() {
  const navigate = useNavigate();
  const token = pendingInvite();
  const me = useQuery(orpc.me.get.queryOptions());
  const preview = useQuery({ ...orpc.invites.peek.queryOptions({ input: { token: token ?? '' } }), enabled: token !== null, retry: false });
  const accept = useMutation(
    orpc.invites.accept.mutationOptions({
      onSuccess: async (org) => {
        forgetInvite();
        await queryClient.invalidateQueries();
        await navigate({ to: '/o/$slug/inbox', params: { slug: org.slug } });
      },
    }),
  );

  function leave() {
    forgetInvite();
    void navigate({ to: '/' });
  }

  if (!token) {
    return (
      <Shell>
        <h1 className="mt-6 text-lg font-semibold text-fg">Không có lời mời</h1>
        <p className="mt-1 text-sm text-fg-2">Liên kết mời không đúng hoặc đã được dùng. Hãy mở lại liên kết trong thư mời.</p>
        <Button className="mt-6" onClick={() => void navigate({ to: '/' })}>
          Về trang chính
        </Button>
      </Shell>
    );
  }

  if (preview.isLoading) {
    return (
      <Shell>
        <Spinner />
      </Shell>
    );
  }

  if (preview.error) {
    const mismatch = errorCode(preview.error) === 'INVITE_EMAIL_MISMATCH';
    return (
      <Shell>
        <h1 className="mt-6 text-lg font-semibold text-fg">Không mở được lời mời</h1>
        <ErrorText>{errorMessage(preview.error)}</ErrorText>
        {mismatch && me.data && <p className="mt-2 text-sm text-fg-2">Bạn đang đăng nhập bằng {me.data.email}.</p>}
        <div className="mt-6 flex flex-wrap gap-2">
          {mismatch && (
            // The token stays in storage, so after signing in with the invited email the user comes back here.
            <Button variant="primary" onClick={() => void signOut()}>
              Đăng xuất để dùng email khác
            </Button>
          )}
          <Button variant="ghost" onClick={leave}>
            Về trang chính
          </Button>
        </div>
      </Shell>
    );
  }

  const invite = preview.data;
  if (!invite) return null;
  return (
    <Shell>
      <h1 className="mt-6 text-lg font-semibold text-fg">Lời mời tham gia {invite.orgName}</h1>
      <p className="mt-2 text-sm text-fg-2">
        {invite.invitedBy} mời bạn tham gia tổ chức <span className="font-medium text-fg">{invite.orgName}</span> với vai trò{' '}
        <span className="font-medium text-fg">{ROLE_LABEL[invite.role]}</span>.
      </p>
      <p className="mt-2 text-xs text-fg-3">
        Lời mời hết hạn lúc {formatDateTime(invite.expiresAt)}. Khi chấp nhận, thành viên của tổ chức sẽ thấy tên và email {me.data?.email ?? 'của bạn'}.
      </p>
      {accept.error && <ErrorText>{errorMessage(accept.error)}</ErrorText>}
      <div className="mt-6 flex flex-wrap gap-2">
        <Button variant="primary" disabled={accept.isPending} onClick={() => accept.mutate({ token })}>
          {accept.isPending ? 'Đang xử lý…' : 'Chấp nhận lời mời'}
        </Button>
        <Button variant="ghost" disabled={accept.isPending} onClick={leave}>
          Từ chối
        </Button>
      </div>
    </Shell>
  );
}
