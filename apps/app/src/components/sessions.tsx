// Device sessions (ADR-0028 section 4, issue #89): the signed-in user's own sessions, and an owner's org-scoped revoke
// for a member. The server enforces who may see and revoke what; these screens only explain it.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { client, orpc, queryClient } from '../lib/api.ts';
import { accessToken, auth } from '../lib/auth.ts';
import { formatDateTime } from '../lib/format.ts';
import { forgetInvite } from '../lib/invite.ts';
import {
  describeUserAgent,
  otherActiveSessionIds,
  sessionErrorMessage,
  sessionIdFromToken,
  shortSessionId,
  sortSessions,
  type SessionRow,
} from '../lib/sessions.ts';
import { Badge, Button, Card, ErrorText, Input, Spinner } from './ui.tsx';

// Signs this tab out; auth-js tells the other tabs, and main.tsx sends every tab to /login.
function signOutHere(): void {
  forgetInvite();
  void auth().signOut({ scope: 'local' });
}

function useCurrentSessionId() {
  return useQuery({ queryKey: ['crove', 'current-session'], queryFn: async () => sessionIdFromToken(await accessToken()), staleTime: 60_000 });
}

function ConfirmBox({ title, children, actions }: { title: string; children?: ReactNode; actions: ReactNode }) {
  return (
    <div className="mt-3 space-y-2 rounded-lg border border-rose-500/30 bg-rose-500/5 p-3 text-sm" role="alertdialog" aria-label={title}>
      <p className="font-medium text-fg">{title}</p>
      {children}
      <div className="flex flex-wrap gap-2">{actions}</div>
    </div>
  );
}

function SessionLine({ session, label, current, action }: { session: SessionRow; label: string; current: boolean; action?: ReactNode }) {
  return (
    <li className="flex items-center justify-between gap-3 py-2 text-sm" data-testid="session-row">
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-2 text-fg">
          <span className="truncate">{label}</span>
          {current && <Badge tone="brand">Phiên hiện tại</Badge>}
          {session.status === 'revoked' && <Badge tone="bad">Đã thu hồi</Badge>}
        </p>
        <p className="text-xs text-fg-3">
          {session.status === 'revoked' && session.revokedAt
            ? `Thu hồi lúc ${formatDateTime(session.revokedAt)}`
            : `Hoạt động gần nhất ${formatDateTime(session.lastSeenAt)}`}
          {` · đăng nhập từ ${formatDateTime(session.firstSeenAt)}`}
        </p>
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </li>
  );
}

function RevokedList({ sessions, labelOf }: { sessions: SessionRow[]; labelOf: (s: SessionRow) => string }) {
  if (!sessions.length) return null;
  return (
    <details className="mt-2 text-sm">
      <summary className="cursor-pointer text-xs text-fg-3">Đã thu hồi ({sessions.length})</summary>
      <ul className="mt-1 divide-y divide-[var(--line)]">
        {sessions.map((s) => (
          <SessionLine key={s.sessionId} session={s} label={labelOf(s)} current={false} />
        ))}
      </ul>
    </details>
  );
}

type MyConfirm = { kind: 'one'; sessionId: string } | { kind: 'others' } | { kind: 'all' } | null;

// "Thiết bị đang đăng nhập" for the signed-in user. Revoking is global (every org) and the server also signs the
// session out in Supabase Auth. Revoking the current session, or every session, signs this browser out.
export function MySessions({ userId }: { userId: string }) {
  const sessions = useQuery(orpc.sessions.list.queryOptions({ input: { userId } }));
  const current = useCurrentSessionId();
  const [confirm, setConfirm] = useState<MyConfirm>(null);
  const currentId = current.data ?? null;

  const done = (revoked: string[]) => {
    setConfirm(null);
    if (currentId && revoked.includes(currentId)) {
      signOutHere();
      return;
    }
    void queryClient.invalidateQueries({ queryKey: orpc.sessions.key() });
  };
  // Signing out this session ends here even if the server had already revoked it and lists nothing.
  const revokeOne = useMutation(
    orpc.sessions.revoke.mutationOptions({
      onSuccess: (result, input) => done(input.sessionId && input.sessionId === currentId ? [currentId] : result.revoked),
    }),
  );
  const revokeAll = useMutation(
    orpc.sessions.revoke.mutationOptions({
      onSuccess: () => {
        // "Everywhere" includes this browser, whatever the answer lists.
        setConfirm(null);
        signOutHere();
      },
    }),
  );
  const revokeOthers = useMutation({
    mutationFn: async (ids: string[]) => {
      const results = await Promise.all(ids.map((sessionId) => client.sessions.revoke({ userId, sessionId })));
      return results.flatMap((r) => r.revoked);
    },
    onSuccess: done,
    onSettled: () => void queryClient.invalidateQueries({ queryKey: orpc.sessions.key() }),
  });
  const busy = revokeOne.isPending || revokeAll.isPending || revokeOthers.isPending;
  const error = revokeOne.error ?? revokeAll.error ?? revokeOthers.error;

  const thisDevice = describeUserAgent(typeof navigator === 'undefined' ? null : navigator.userAgent);
  const labelOf = (s: SessionRow) =>
    s.sessionId === currentId ? `Thiết bị này${thisDevice ? ` (${thisDevice})` : ''}` : `Phiên đăng nhập ${shortSessionId(s.sessionId)}`;
  const sorted = sortSessions(sessions.data ?? [], currentId);
  const active = sorted.filter((s) => s.status === 'active');
  const revoked = sorted.filter((s) => s.status === 'revoked');
  const others = otherActiveSessionIds(sorted, currentId);

  const ask = (next: MyConfirm) => {
    revokeOne.reset();
    revokeAll.reset();
    revokeOthers.reset();
    setConfirm(next);
  };
  const cancel = (
    <Button variant="ghost" disabled={busy} onClick={() => setConfirm(null)}>
      Hủy
    </Button>
  );

  return (
    <Card className="p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-fg-3">Thiết bị đang đăng nhập</p>
      <p className="mt-1 text-xs text-fg-3">
        Các phiên đăng nhập Crove đã thấy từ tài khoản của bạn. Thu hồi một phiên sẽ đăng xuất thiết bị đó khỏi mọi tổ chức ngay từ yêu cầu tiếp
        theo.
      </p>
      {sessions.isLoading || current.isLoading ? (
        <div className="mt-3">
          <Spinner />
        </div>
      ) : sessions.error ? (
        <div className="mt-3">
          <ErrorText>{sessionErrorMessage(sessions.error, 'self')}</ErrorText>
        </div>
      ) : (
        <>
          <ul className="mt-3 divide-y divide-[var(--line)]">
            {active.map((s) => (
              <SessionLine
                key={s.sessionId}
                session={s}
                label={labelOf(s)}
                current={s.sessionId === currentId}
                action={
                  <Button variant="ghost" disabled={busy} onClick={() => ask({ kind: 'one', sessionId: s.sessionId })}>
                    {s.sessionId === currentId ? 'Đăng xuất' : 'Thu hồi'}
                  </Button>
                }
              />
            ))}
            {!active.length && <li className="py-2 text-sm text-fg-3">Không có phiên nào đang hoạt động.</li>}
          </ul>
          <RevokedList sessions={revoked} labelOf={labelOf} />

          {confirm?.kind === 'one' && (
            <ConfirmBox
              title={confirm.sessionId === currentId ? 'Đăng xuất thiết bị này?' : 'Thu hồi phiên đăng nhập này?'}
              actions={
                <>
                  <Button variant="danger" disabled={busy} onClick={() => revokeOne.mutate({ userId, sessionId: confirm.sessionId })}>
                    {confirm.sessionId === currentId ? 'Xác nhận đăng xuất' : 'Xác nhận thu hồi'}
                  </Button>
                  {cancel}
                </>
              }
            >
              <p className="text-fg-2">
                {confirm.sessionId === currentId
                  ? 'Bạn sẽ được đưa về trang đăng nhập, ở mọi tab đang mở.'
                  : 'Thiết bị đó sẽ bị đăng xuất khỏi mọi tổ chức và phải đăng nhập lại.'}
              </p>
            </ConfirmBox>
          )}
          {confirm?.kind === 'others' && (
            <ConfirmBox
              title={`Đăng xuất ${others.length} thiết bị khác?`}
              actions={
                <>
                  <Button variant="danger" disabled={busy} onClick={() => revokeOthers.mutate(others)}>
                    Xác nhận đăng xuất
                  </Button>
                  {cancel}
                </>
              }
            >
              <p className="text-fg-2">Thiết bị này vẫn đăng nhập; mọi thiết bị khác phải đăng nhập lại.</p>
            </ConfirmBox>
          )}
          {confirm?.kind === 'all' && (
            <ConfirmBox
              title="Đăng xuất khỏi mọi nơi?"
              actions={
                <>
                  <Button variant="danger" disabled={busy} onClick={() => revokeAll.mutate({ userId, all: true })}>
                    Đăng xuất khỏi mọi nơi
                  </Button>
                  {cancel}
                </>
              }
            >
              <p className="text-fg-2">
                Mọi phiên đăng nhập của bạn, kể cả thiết bị này, bị thu hồi ngay. Hãy dùng khi nghi ngờ tài khoản bị lộ, rồi đổi mật khẩu.
              </p>
            </ConfirmBox>
          )}

          {!confirm && (
            <div className="mt-3 flex flex-wrap gap-2">
              {others.length > 0 && (
                <Button disabled={busy} onClick={() => ask({ kind: 'others' })}>
                  Đăng xuất các thiết bị khác
                </Button>
              )}
              <Button variant="danger" disabled={busy} onClick={() => ask({ kind: 'all' })}>
                Đăng xuất khỏi mọi nơi
              </Button>
            </div>
          )}
          {error && (
            <div className="mt-2">
              <ErrorText>{sessionErrorMessage(error, 'self')}</ErrorText>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

type MemberTarget = { sessionId: string } | 'all' | null;

function MemberSessionsPanel({ userId, name, onClose }: { userId: string; name: string; onClose: () => void }) {
  const sessions = useQuery(orpc.sessions.list.queryOptions({ input: { userId } }));
  const [target, setTarget] = useState<MemberTarget>(null);
  const [reason, setReason] = useState('');
  const revoke = useMutation(
    orpc.sessions.revoke.mutationOptions({
      onSuccess: () => {
        setTarget(null);
        setReason('');
      },
      onSettled: () => void queryClient.invalidateQueries({ queryKey: orpc.sessions.list.key({ input: { userId } }) }),
    }),
  );
  const sorted = sortSessions(sessions.data ?? [], null);
  const active = sorted.filter((s) => s.status === 'active');
  const revoked = sorted.filter((s) => s.status === 'revoked');
  const labelOf = (s: SessionRow) => `Phiên đăng nhập ${shortSessionId(s.sessionId)}`;
  const ask = (next: MemberTarget) => {
    revoke.reset();
    setTarget(next);
  };
  const submit = () => {
    if (!target) return;
    const trimmed = reason.trim();
    const base = { userId, ...(trimmed ? { reason: trimmed } : {}) };
    revoke.mutate(target === 'all' ? { ...base, all: true } : { ...base, sessionId: target.sessionId });
  };

  return (
    <div className="mt-2 rounded-lg border border-line bg-surface-2 p-3 text-sm" role="region" aria-label={`Phiên đăng nhập của ${name}`}>
      <div className="flex items-start justify-between gap-2">
        <p className="text-fg-2">
          Thu hồi phiên chỉ chặn {name} truy cập <strong className="text-fg">tổ chức này</strong>. Họ vẫn dùng được các tổ chức khác và không bị
          đăng xuất khỏi tài khoản. Muốn cắt hẳn quyền truy cập, hãy xóa họ khỏi tổ chức.
        </p>
        <Button variant="ghost" className="shrink-0 px-2 py-1" onClick={onClose}>
          Đóng
        </Button>
      </div>
      {sessions.isLoading ? (
        <div className="mt-2">
          <Spinner />
        </div>
      ) : sessions.error ? (
        <div className="mt-2">
          <ErrorText>{sessionErrorMessage(sessions.error, 'member')}</ErrorText>
        </div>
      ) : (
        <>
          <ul className="mt-2 divide-y divide-[var(--line)]">
            {active.map((s) => (
              <SessionLine
                key={s.sessionId}
                session={s}
                label={labelOf(s)}
                current={false}
                action={
                  <Button variant="ghost" disabled={revoke.isPending} onClick={() => ask({ sessionId: s.sessionId })}>
                    Thu hồi
                  </Button>
                }
              />
            ))}
            {!active.length && <li className="py-2 text-fg-3">Không có phiên nào đang hoạt động trong tổ chức này.</li>}
          </ul>
          <RevokedList sessions={revoked} labelOf={labelOf} />
          {target ? (
            <ConfirmBox
              title={target === 'all' ? `Thu hồi mọi phiên của ${name} trong tổ chức này?` : `Thu hồi phiên này của ${name}?`}
              actions={
                <>
                  <Button variant="danger" disabled={revoke.isPending} onClick={submit}>
                    Xác nhận thu hồi
                  </Button>
                  <Button variant="ghost" disabled={revoke.isPending} onClick={() => setTarget(null)}>
                    Hủy
                  </Button>
                </>
              }
            >
              <p className="text-fg-2">Từ yêu cầu tiếp theo, phiên bị thu hồi không vào được tổ chức này nữa. Thao tác được ghi vào nhật ký.</p>
              <label className="block text-xs text-fg-3">
                Lý do (không bắt buộc)
                <Input className="mt-1" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ví dụ: máy bị mất" />
              </label>
            </ConfirmBox>
          ) : (
            active.length > 0 && (
              <div className="mt-2">
                <Button variant="danger" disabled={revoke.isPending} onClick={() => ask('all')}>
                  Thu hồi mọi phiên trong tổ chức này
                </Button>
              </div>
            )
          )}
          {revoke.error && (
            <div className="mt-2">
              <ErrorText>{sessionErrorMessage(revoke.error, 'member')}</ErrorText>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// Owner only (the server answers 403 to everyone else, admins included): a member's sessions seen in this org.
export function MemberSessions({ userId, name }: { userId: string; name: string }) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <Button variant="ghost" className="px-2.5 py-1 text-xs" onClick={() => setOpen(true)}>
        Thu hồi phiên
      </Button>
    );
  }
  return <MemberSessionsPanel userId={userId} name={name} onClose={() => setOpen(false)} />;
}

