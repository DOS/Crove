import { useMutation, useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import { MemberSessions, MySessions } from '../components/sessions.tsx';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Input } from '@crove/ui/components/input';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { ErrorText, PageHeader, Spinner } from '../components/ui.tsx';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';
import { getConfig } from '../lib/auth.ts';
import { useFormat } from '../i18n/provider.tsx';
import { ROLES, roleChangeConfirmation, type Role, type RoleChangeConfirmation } from '../lib/members.ts';

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
  const root = useTranslations();
  const t = useTranslations('settings');
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
  const name = member.displayName ?? member.email;

  const ask = (next: Pending) => {
    changeRole.reset();
    remove.reset();
    setConfirmKey(crypto.randomUUID());
    setPending(next);
  };
  const pickRole = (role: Role) => {
    const confirmation = roleChangeConfirmation({ name, from: member.role, to: role, self }, root);
    if (confirmation) ask({ kind: 'role', role, confirmation });
    else if (role !== member.role) changeRole.mutate({ userId: member.userId, role, idempotencyKey: crypto.randomUUID() });
  };

  if (pending) {
    const text =
      pending.kind === 'remove'
        ? { title: t('removeTitle', { name }), body: t('removeBody'), action: t('confirmRemove') }
        : pending.confirmation;
    const confirm = () =>
      pending.kind === 'remove'
        ? remove.mutate({ userId: member.userId, idempotencyKey: confirmKey })
        : changeRole.mutate({ userId: member.userId, role: pending.role, idempotencyKey: confirmKey });
    const error = pending.kind === 'remove' ? remove.error : changeRole.error;
    return (
      <div className="max-w-xs space-y-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm" role="alertdialog" aria-label={text.title}>
        <p className="font-medium text-foreground">{text.title}</p>
        <p className="text-muted-foreground">{text.body}</p>
        <div className="flex gap-2">
          <Button variant="destructive" disabled={busy} onClick={confirm}>
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
            {root('common.cancel')}
          </Button>
        </div>
        {error && <ErrorText>{errorMessage(error)}</ErrorText>}
      </div>
    );
  }
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        <NativeSelect
          size="sm"
          value={member.role}
          disabled={busy}
          onChange={(e) => pickRole(e.target.value as Role)}
          aria-label={self ? t('yourRole') : t('roleOf', { name })}
        >
          {ROLES.map((r) => (
            <NativeSelectOption key={r} value={r}>
              {root(`roles.${r}`)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        {!self && (
          <Button variant="destructive" size="sm" disabled={busy} onClick={() => ask({ kind: 'remove' })}>
            {t('remove')}
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
  const t = useTranslations('settings');
  const tc = useTranslations('common');
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
          <div className="rounded-lg border bg-muted p-3 text-sm" role="status">
            <p className="text-muted-foreground">{t('rotated')}</p>
            <p className="mt-1 break-all font-mono text-foreground">{rotated}</p>
          </div>
        )}
        <Button
          variant="destructive"
          onClick={() => {
            rotate.reset();
            setConfirming(true);
          }}
        >
          {t('rotate')}
        </Button>
      </div>
    );
  }
  return (
    <div className="mt-4 space-y-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm" role="alertdialog" aria-label={t('rotateLabel')}>
      <p className="font-medium text-foreground">{t('rotateTitle')}</p>
      <p className="text-muted-foreground">{t('rotateBody')}</p>
      <p className="text-subtle-foreground">{t('rotateMfa')}</p>
      <div className="flex gap-2">
        <Button variant="destructive" disabled={rotate.isPending} onClick={() => rotate.mutate({ idempotencyKey })}>
          {t('rotateConfirm')}
        </Button>
        <Button variant="ghost" disabled={rotate.isPending} onClick={() => setConfirming(false)}>
          {tc('cancel')}
        </Button>
      </div>
      {rotate.error && <ErrorText>{errorMessage(rotate.error)}</ErrorText>}
    </div>
  );
}

type InviteRole = 'admin' | 'member' | 'viewer';

// The accept link is shown once, right after the invite is created: the server keeps only a hash of its token.
function CreatedInvite({ invite, onDone }: { invite: { email: string; expiresAt: string; acceptPath: string }; onDone: () => void }) {
  const t = useTranslations('settings');
  const tc = useTranslations('common');
  const f = useFormat();
  const link = `${window.location.origin}${invite.acceptPath}`;
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-4 space-y-2 rounded-lg border bg-muted p-3 text-sm" role="status">
      <p className="text-foreground">{t('inviteCreated', { email: invite.email })}</p>
      <p className="text-muted-foreground">
        {getConfig().mailEnabled ? t('inviteMailSent') : t('inviteMailOff')} {t('inviteRules', { at: f.dateTime(invite.expiresAt) })}
      </p>
      <p className="break-all rounded border bg-card px-2 py-1 font-mono text-xs text-foreground">{link}</p>
      <div className="flex gap-2">
        <Button
          variant="outline"
          onClick={() =>
            void navigator.clipboard.writeText(link).then(
              () => setCopied(true),
              () => setCopied(false),
            )
          }
        >
          {copied ? t('copied') : t('copyLink')}
        </Button>
        <Button variant="ghost" onClick={onDone}>
          {tc('close')}
        </Button>
      </div>
    </div>
  );
}

function InviteMember({ isOwner }: { isOwner: boolean }) {
  const root = useTranslations();
  const t = useTranslations('settings');
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
        <p className="text-xs text-subtle-foreground">{t('inviteHint')}</p>
        <div className="flex gap-2">
          <Input type="email" required maxLength={320} placeholder={t('emailPlaceholder')} value={email} onChange={(e) => setEmail(e.target.value)} />
          <NativeSelect className="shrink-0" value={role} onChange={(e) => setRole(e.target.value as InviteRole)} aria-label={t('role')}>
            {isOwner && <NativeSelectOption value="admin">{root('roles.admin')}</NativeSelectOption>}
            <NativeSelectOption value="member">{root('roles.member')}</NativeSelectOption>
            <NativeSelectOption value="viewer">{root('roles.viewer')}</NativeSelectOption>
          </NativeSelect>
          <Button type="submit" variant="outline" disabled={invite.isPending}>
            {t('invite')}
          </Button>
        </div>
        {invite.error && <ErrorText>{errorMessage(invite.error)}</ErrorText>}
      </form>
      {invite.data && <CreatedInvite invite={invite.data} onDone={() => invite.reset()} />}
    </>
  );
}

function PendingInvites() {
  const root = useTranslations();
  const t = useTranslations('settings');
  const f = useFormat();
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
      <p className="text-xs font-medium tracking-wide uppercase text-subtle-foreground">{t('pendingInvites')}</p>
      <ul className="mt-2 divide-y">
        {invites.data.map((i) => (
          <li key={i.id} className="flex items-center justify-between gap-2 py-2 text-sm">
            <div className="min-w-0">
              <p className="truncate text-foreground">{i.email}</p>
              <p className="text-xs text-subtle-foreground">
                {i.status === 'expired' ? t('expired') : t('expiresAt', { at: f.dateTime(i.expiresAt) })}
                {i.invitedBy ? ` · ${t('invitedBy', { name: i.invitedBy })}` : ''}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Badge variant={i.status === 'expired' ? 'warning' : 'secondary'}>{root(`roles.${i.role}`)}</Badge>
              <Button variant="ghost" disabled={revoke.isPending} onClick={() => revoke.mutate({ inviteId: i.id })}>
                {t('revoke')}
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
  const root = useTranslations();
  const t = useTranslations('settings');
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
      <PageHeader title={t('title')} subtitle={org.data?.name} />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="block p-4">
          <p className="text-xs font-medium tracking-wide uppercase text-subtle-foreground">{t('org')}</p>
          <dl className="mt-3 space-y-2 text-sm">
            <div>
              <dt className="text-subtle-foreground">{t('name')}</dt>
              <dd className="text-foreground">{org.data?.name}</dd>
            </div>
            <div>
              <dt className="text-subtle-foreground">{t('slug')}</dt>
              <dd className="font-mono text-foreground">{org.data?.slug}</dd>
            </div>
            <div>
              <dt className="text-subtle-foreground">{t('inboundAddress')}</dt>
              <dd className="break-all font-mono text-foreground">{org.data?.inboundAddress ?? t('inboundOff')}</dd>
              {/* Mail to an address retired in the last 30 days is dropped without a bounce; only the count is kept (#139). */}
              {(org.data?.inboundDroppedCount ?? 0) > 0 && (
                <dd className="mt-1 text-xs text-warning" role="status">
                  {t('inboundDropped', { count: org.data?.inboundDroppedCount ?? 0 })}
                </dd>
              )}
            </div>
          </dl>
          {org.data?.role === 'owner' && org.data.inboundAddress && <RotateInboundAddress />}
        </Card>
        <Card className="block p-4">
          <p className="text-xs font-medium tracking-wide uppercase text-subtle-foreground">{t('members')}</p>
          <ul className="mt-3 divide-y">
            {org.data?.members.map((m) => (
              <li key={m.userId} className="py-2 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <span className="truncate text-foreground">{m.displayName ?? m.email}</span>
                  {controlsFor(m.userId) ? (
                    <MemberControls member={m} self={m.userId === me.data?.userId} />
                  ) : (
                    <Badge variant={m.role === 'owner' ? 'default' : 'secondary'}>{root(`roles.${m.role}`)}</Badge>
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
