// Device sessions (ADR-0028 section 4, issue #89): the signed-in user's own sessions, and an owner's org-scoped revoke
// for a member. The server enforces who may see and revoke what; these screens only explain it.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { useTranslations } from 'use-intl';
import { useFormat } from '../i18n/provider.tsx';
import { client, orpc, queryClient } from '../lib/api.ts';
import { accessToken, auth } from '../lib/auth.ts';
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
  const t = useTranslations('sessions');
  const f = useFormat();
  return (
    <li className="flex items-center justify-between gap-3 py-2 text-sm" data-testid="session-row">
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-2 text-fg">
          <span className="truncate">{label}</span>
          {current && <Badge tone="brand">{t('current')}</Badge>}
          {session.status === 'revoked' && <Badge tone="bad">{t('revoked')}</Badge>}
        </p>
        <p className="text-xs text-fg-3">
          {session.status === 'revoked' && session.revokedAt
            ? t('revokedAt', { at: f.dateTime(session.revokedAt) })
            : t('lastSeen', { at: f.dateTime(session.lastSeenAt) })}
          {` · ${t('firstSeen', { at: f.dateTime(session.firstSeenAt) })}`}
        </p>
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </li>
  );
}

function RevokedList({ sessions, labelOf }: { sessions: SessionRow[]; labelOf: (s: SessionRow) => string }) {
  const t = useTranslations('sessions');
  if (!sessions.length) return null;
  return (
    <details className="mt-2 text-sm">
      <summary className="cursor-pointer text-xs text-fg-3">{t('revokedList', { count: sessions.length })}</summary>
      <ul className="mt-1 divide-y divide-[var(--line)]">
        {sessions.map((s) => (
          <SessionLine key={s.sessionId} session={s} label={labelOf(s)} current={false} />
        ))}
      </ul>
    </details>
  );
}

type MyConfirm = { kind: 'one'; sessionId: string } | { kind: 'others' } | { kind: 'all' } | null;

// "Signed-in devices" for the signed-in user. Revoking is global (every org) and the server also signs the
// session out in Supabase Auth. Revoking the current session, or every session, signs this browser out.
export function MySessions({ userId }: { userId: string }) {
  const root = useTranslations();
  const t = useTranslations('sessions');
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

  const thisDevice = describeUserAgent(typeof navigator === 'undefined' ? null : navigator.userAgent, root);
  const labelOf = (s: SessionRow) =>
    s.sessionId === currentId
      ? thisDevice
        ? t('thisDeviceNamed', { device: thisDevice })
        : t('thisDevice')
      : t('session', { id: shortSessionId(s.sessionId) });
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
      {root('common.cancel')}
    </Button>
  );

  return (
    <Card className="p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-fg-3">{t('title')}</p>
      <p className="mt-1 text-xs text-fg-3">{t('intro')}</p>
      {sessions.isLoading || current.isLoading ? (
        <div className="mt-3">
          <Spinner />
        </div>
      ) : sessions.error ? (
        <div className="mt-3">
          <ErrorText>{sessionErrorMessage(sessions.error, 'self', root)}</ErrorText>
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
                    {s.sessionId === currentId ? root('common.signOut') : t('revoke')}
                  </Button>
                }
              />
            ))}
            {!active.length && <li className="py-2 text-sm text-fg-3">{t('noneActive')}</li>}
          </ul>
          <RevokedList sessions={revoked} labelOf={labelOf} />

          {confirm?.kind === 'one' && (
            <ConfirmBox
              title={confirm.sessionId === currentId ? t('signOutThisTitle') : t('revokeOneTitle')}
              actions={
                <>
                  <Button variant="danger" disabled={busy} onClick={() => revokeOne.mutate({ userId, sessionId: confirm.sessionId })}>
                    {confirm.sessionId === currentId ? t('confirmSignOut') : t('confirmRevoke')}
                  </Button>
                  {cancel}
                </>
              }
            >
              <p className="text-fg-2">
                {confirm.sessionId === currentId ? t('signOutThisBody') : t('revokeOneBody')}
              </p>
            </ConfirmBox>
          )}
          {confirm?.kind === 'others' && (
            <ConfirmBox
              title={t('othersTitle', { count: others.length })}
              actions={
                <>
                  <Button variant="danger" disabled={busy} onClick={() => revokeOthers.mutate(others)}>
                    {t('confirmSignOut')}
                  </Button>
                  {cancel}
                </>
              }
            >
              <p className="text-fg-2">{t('othersBody')}</p>
            </ConfirmBox>
          )}
          {confirm?.kind === 'all' && (
            <ConfirmBox
              title={t('allTitle')}
              actions={
                <>
                  <Button variant="danger" disabled={busy} onClick={() => revokeAll.mutate({ userId, all: true })}>
                    {t('all')}
                  </Button>
                  {cancel}
                </>
              }
            >
              <p className="text-fg-2">{t('allBody')}</p>
            </ConfirmBox>
          )}

          {!confirm && (
            <div className="mt-3 flex flex-wrap gap-2">
              {others.length > 0 && (
                <Button disabled={busy} onClick={() => ask({ kind: 'others' })}>
                  {t('signOutOthers')}
                </Button>
              )}
              <Button variant="danger" disabled={busy} onClick={() => ask({ kind: 'all' })}>
                {t('all')}
              </Button>
            </div>
          )}
          {error && (
            <div className="mt-2">
              <ErrorText>{sessionErrorMessage(error, 'self', root)}</ErrorText>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

type MemberTarget = { sessionId: string } | 'all' | null;

function MemberSessionsPanel({ userId, name, onClose }: { userId: string; name: string; onClose: () => void }) {
  const root = useTranslations();
  const t = useTranslations('sessions');
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
  const labelOf = (s: SessionRow) => t('session', { id: shortSessionId(s.sessionId) });
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
    <div className="mt-2 rounded-lg border border-line bg-surface-2 p-3 text-sm" role="region" aria-label={t('memberPanel', { name })}>
      <div className="flex items-start justify-between gap-2">
        <p className="text-fg-2">{t.rich('memberIntro', { name, strong: (chunks) => <strong className="text-fg">{chunks}</strong> })}</p>
        <Button variant="ghost" className="shrink-0 px-2 py-1" onClick={onClose}>
          {root('common.close')}
        </Button>
      </div>
      {sessions.isLoading ? (
        <div className="mt-2">
          <Spinner />
        </div>
      ) : sessions.error ? (
        <div className="mt-2">
          <ErrorText>{sessionErrorMessage(sessions.error, 'member', root)}</ErrorText>
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
                    {t('revoke')}
                  </Button>
                }
              />
            ))}
            {!active.length && <li className="py-2 text-fg-3">{t('memberNoneActive')}</li>}
          </ul>
          <RevokedList sessions={revoked} labelOf={labelOf} />
          {target ? (
            <ConfirmBox
              title={target === 'all' ? t('memberAllTitle', { name }) : t('memberOneTitle', { name })}
              actions={
                <>
                  <Button variant="danger" disabled={revoke.isPending} onClick={submit}>
                    {t('confirmRevoke')}
                  </Button>
                  <Button variant="ghost" disabled={revoke.isPending} onClick={() => setTarget(null)}>
                    {root('common.cancel')}
                  </Button>
                </>
              }
            >
              <p className="text-fg-2">{t('memberRevokeBody')}</p>
              <label className="block text-xs text-fg-3">
                {t('reason')}
                <Input className="mt-1" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t('reasonPlaceholder')} />
              </label>
            </ConfirmBox>
          ) : (
            active.length > 0 && (
              <div className="mt-2">
                <Button variant="danger" disabled={revoke.isPending} onClick={() => ask('all')}>
                  {t('memberRevokeAll')}
                </Button>
              </div>
            )
          )}
          {revoke.error && (
            <div className="mt-2">
              <ErrorText>{sessionErrorMessage(revoke.error, 'member', root)}</ErrorText>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// Owner only (the server answers 403 to everyone else, admins included): a member's sessions seen in this org.
export function MemberSessions({ userId, name }: { userId: string; name: string }) {
  const t = useTranslations('sessions');
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <Button variant="ghost" className="px-2.5 py-1 text-xs" onClick={() => setOpen(true)}>
        {t('memberOpen')}
      </Button>
    );
  }
  return <MemberSessionsPanel userId={userId} name={name} onClose={() => setOpen(false)} />;
}

