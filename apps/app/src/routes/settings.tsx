import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useSearch } from '@tanstack/react-router';
import { useId, useState, type FormEvent } from 'react';
import { useLocale, useTranslations } from 'use-intl';
import { MemberSessions, MySessions } from '../components/sessions.tsx';
import { Badge } from '@crove/ui/components/badge';
import { Button, buttonVariants } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Checkbox } from '@crove/ui/components/checkbox';
import { PROFILE_OBLIGATIONS, type TaxProfile } from '@crove/kernel-contract';
import { Input } from '@crove/ui/components/input';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { StepUpPrompt, TwoFactorCard } from '../components/two-factor.tsx';
import { ChartOfAccountsCard } from './accounts.tsx';
import { AccountRulesCard } from './account-rules.tsx';
import { ApprovalPresetCard, MEMBERS_CARD_ID } from './approval-preset.tsx';
import { LegalEntitiesCard } from './legal-entities.tsx';
import { MemberRolesRow } from './member-roles.tsx';
import { WorkingHoursCard } from './working-hours.tsx';
import { EventTypesCard } from './event-types.tsx';
import { ErrorText, PageHeader, Spinner } from '../components/ui.tsx';
import { apiFetch, errorMessage, isStepUpRequired, orpc, queryClient } from '../lib/api.ts';
import { getConfig } from '../lib/auth.ts';
import { useFormat } from '../i18n/provider.tsx';
import { ROLES, roleChangeConfirmation, roleChangeKind, type Role, type RoleChangeKind } from '../lib/members.ts';
import { exportFileName, exportPhase, formatBytes, offboardErrorMessage, slugConfirmed } from '../lib/offboarding.ts';

interface MemberRow {
  userId: string;
  email: string;
  displayName: string | null;
  role: Role;
}

// What waits for confirmation. It holds the change, not its words, which are made at render (issue #215).
type Pending = { kind: 'remove' } | { kind: 'role'; role: Role; reason: RoleChangeKind };

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
    const reason = roleChangeKind({ from: member.role, to: role, self });
    if (reason) ask({ kind: 'role', role, reason });
    else if (role !== member.role) changeRole.mutate({ userId: member.userId, role, idempotencyKey: crypto.randomUUID() });
  };

  if (pending) {
    const text =
      pending.kind === 'remove'
        ? { title: t('removeTitle', { name }), body: t('removeBody'), action: t('confirmRemove') }
        : roleChangeConfirmation(pending.reason, { name, to: pending.role }, root);
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
        {error &&
          (isStepUpRequired(error) ? (
            // R3: after a fresh second factor the confirmed request runs again with its key.
            <StepUpPrompt
              enroll={false}
              action={pending.kind === 'remove' ? t('stepUpRemove', { name }) : t('stepUpRole', { name, role: root(`roles.${pending.role}`) })}
              onVerified={confirm}
            />
          ) : (
            <ErrorText>{errorMessage(error)}</ErrorText>
          ))}
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
      {changeRole.error &&
        (isStepUpRequired(changeRole.error) ? (
          // R3: after a fresh second factor the same request runs again (a refused request stores no key).
          <StepUpPrompt
            enroll={false}
            action={t('stepUpRole', { name, role: root(`roles.${changeRole.variables?.role ?? member.role}`) })}
            onVerified={() => changeRole.variables && changeRole.mutate(changeRole.variables)}
            onCancel={() => changeRole.reset()}
          />
        ) : (
          <ErrorText>{errorMessage(changeRole.error)}</ErrorText>
        ))}
    </div>
  );
}

// Owner only. One idempotency key per confirmation, so a retried request never rotates twice. R3 (#113): without a
// second factor in the last 5 minutes the server answers STEP_UP_REQUIRED and the step-up prompt asks for one; the
// key is kept until a rotation succeeds, so the retry after the code can still rotate at most once.
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
  const rotateNow = () => rotate.mutate({ idempotencyKey });

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
        <Button variant="destructive" disabled={rotate.isPending} onClick={rotateNow}>
          {t('rotateConfirm')}
        </Button>
        <Button
          variant="ghost"
          disabled={rotate.isPending}
          onClick={() => {
            rotate.reset();
            setConfirming(false);
          }}
        >
          {tc('cancel')}
        </Button>
      </div>
      {rotate.error &&
        (isStepUpRequired(rotate.error) ? (
          <StepUpPrompt enroll={false} action={t('stepUpRotate')} onVerified={rotateNow} />
        ) : (
          <ErrorText>{errorMessage(rotate.error)}</ErrorText>
        ))}
    </div>
  );
}

// Owner only (issue #212). Starts offboarding (kernel.org.offboard, R3): the owner types the org's slug, and without a
// second factor in the last 5 minutes the server answers STEP_UP_REQUIRED and the step-up prompt asks for one (#32);
// after the code the refused request runs again as sent, with its key. One idempotency key per confirmation.
// Then shows the export's state, polling while it is made, and the downloads of the manifest and of each table.
function Offboarding({ name, slug }: { name: string; slug: string }) {
  const root = useTranslations();
  const locale = useLocale();
  const t = useTranslations('offboarding');
  const tc = useTranslations('common');
  const f = useFormat();
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState('');
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const state = useQuery({
    ...orpc.org.export.queryOptions(),
    // While an export is being made, look again every 10 seconds.
    refetchInterval: (query) => (query.state.data && exportPhase(query.state.data).phase === 'pending' ? 10_000 : false),
  });
  const offboard = useMutation(
    orpc.org.offboard.mutationOptions({
      onSuccess: () => {
        setConfirming(false);
        setTyped('');
        setIdempotencyKey(crypto.randomUUID());
        void queryClient.invalidateQueries({ queryKey: orpc.org.export.key() });
      },
    }),
  );
  const download = useMutation({
    mutationFn: async (part: string) => {
      const response = await apiFetch(`/api/org-export/${encodeURIComponent(part)}`);
      const url = URL.createObjectURL(await response.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = exportFileName(slug, part);
      a.click();
      // Revoked a little later: some browsers cancel a download whose URL is revoked at once.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    },
  });

  if (state.isLoading) return <Spinner />;
  if (state.error) return <ErrorText>{errorMessage(state.error)}</ErrorText>;
  const data = state.data;
  if (!data) return null;
  const { phase, downloadable } = exportPhase(data);
  const exported = data.export;

  return (
    <Card className="block p-4 lg:col-span-2">
      <p className="text-sm font-medium text-muted-foreground">{t('title')}</p>
      <p className="mt-3 text-sm text-muted-foreground">{t('intro')}</p>
      {data.status === 'offboarding' && (
        <p className="mt-3 text-sm text-warning" role="status">
          {t('offboarding')}
        </p>
      )}
      {data.status === 'closed' && <p className="mt-3 text-sm text-muted-foreground">{t('closed')}</p>}
      {phase === 'pending' && (
        <p className="mt-3 text-sm text-foreground" role="status">
          {t('pending', { at: f.dateTime(data.requestedAt) })}
        </p>
      )}
      {exported?.expired && (
        <p className="mt-3 text-sm text-muted-foreground">{t('expired', { at: f.dateTime(exported.createdAt), expires: f.dateTime(exported.expiresAt) })}</p>
      )}
      {exported && downloadable && (
        <div className="mt-3 space-y-2 text-sm">
          <p className="text-foreground">{t('ready', { at: f.dateTime(exported.createdAt), expires: f.dateTime(exported.expiresAt) })}</p>
          <p className="text-subtle-foreground">
            {exported.encryption === 'aes-256-gcm' ? t('encrypted') : t('unencrypted')} {t('files', { count: exported.fileCount })}
          </p>
          <Button variant="outline" size="sm" disabled={download.isPending} onClick={() => download.mutate('manifest')}>
            {t('manifest')}
          </Button>
          <ul className="divide-y">
            {exported.tables.map((table) => (
              <li key={table.table} className="flex items-center justify-between gap-3 py-2">
                <div className="min-w-0">
                  <p className="truncate font-mono text-foreground">{table.table}</p>
                  <p className="text-xs text-subtle-foreground">{t('tableRows', { rows: f.number(table.rows), size: formatBytes(table.bytes, f.number) })}</p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={download.isPending}
                  onClick={() => download.mutate(table.table)}
                  aria-label={`${t('download')} ${table.table}`}
                >
                  {download.isPending && download.variables === table.table ? t('downloading') : t('download')}
                </Button>
              </li>
            ))}
          </ul>
          {download.error && <ErrorText>{errorMessage(download.error)}</ErrorText>}
        </div>
      )}
      {data.status !== 'closed' && !confirming && (
        <div className="mt-4">
          <Button
            variant={data.status === 'active' ? 'destructive' : 'outline'}
            disabled={phase === 'pending'}
            onClick={() => {
              offboard.reset();
              setTyped('');
              setConfirming(true);
            }}
          >
            {data.status === 'active' ? t('start') : t('requestAgain')}
          </Button>
        </div>
      )}
      {confirming && (
        <form
          className="mt-4 space-y-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm"
          role="alertdialog"
          aria-label={t('confirmLabel')}
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            if (slugConfirmed(typed, slug)) offboard.mutate({ confirmSlug: typed.trim(), idempotencyKey });
          }}
        >
          <p className="font-medium text-foreground">{t('confirmTitle', { name })}</p>
          <p className="text-muted-foreground">{t('confirmBody', { slug })}</p>
          <Input value={typed} maxLength={48} placeholder={t('confirmPlaceholder')} onChange={(e) => setTyped(e.target.value)} aria-label={t('confirmPlaceholder')} autoComplete="off" />
          <p className="text-subtle-foreground">{t('confirmMfa')}</p>
          <div className="flex gap-2">
            <Button type="submit" variant="destructive" disabled={offboard.isPending || !slugConfirmed(typed, slug)}>
              {t('confirm')}
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={offboard.isPending}
              onClick={() => {
                offboard.reset();
                setConfirming(false);
              }}
            >
              {tc('cancel')}
            </Button>
          </div>
          {offboard.error && !isStepUpRequired(offboard.error) && <ErrorText>{offboardErrorMessage(offboard.error, root, locale)}</ErrorText>}
        </form>
      )}
      {confirming && isStepUpRequired(offboard.error) && (
        // Outside the form above: the prompt has a form of its own.
        <div className="mt-4">
          <StepUpPrompt
            enroll={false}
            action={t('stepUpAction', { name })}
            onVerified={() => offboard.variables && offboard.mutate(offboard.variables)}
            onCancel={() => offboard.reset()}
          />
        </div>
      )}
    </Card>
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

// `initialEmail`: the contact onboarding asked to invite (?invite=, issue #324).
function InviteMember({ isOwner, initialEmail }: { isOwner: boolean; initialEmail?: string | undefined }) {
  const root = useTranslations();
  const t = useTranslations('settings');
  const [email, setEmail] = useState(initialEmail ?? '');
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
        {invite.error && !isStepUpRequired(invite.error) && <ErrorText>{errorMessage(invite.error)}</ErrorText>}
      </form>
      {isStepUpRequired(invite.error) && (
        // Inviting is R3. Outside the form above: the prompt has a form of its own.
        <div className="mt-4">
          <StepUpPrompt
            enroll={false}
            action={t('stepUpInvite', { email: invite.variables?.email ?? email, role: root(`roles.${invite.variables?.role ?? role}`) })}
            onVerified={() => invite.variables && invite.mutate(invite.variables)}
            onCancel={() => invite.reset()}
          />
        </div>
      )}
      {invite.data && <CreatedInvite invite={invite.data} onDone={() => invite.reset()} />}
    </>
  );
}

// Mail outcomes the inviter should act on (#539): the address bounced or is stopped, or the mail did not go out.
const INVITE_MAIL_PROBLEMS: ReadonlySet<string> = new Set(['bounced', 'complained', 'suppressed', 'failed', 'ambiguous']);

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
      <p className="text-sm font-medium text-muted-foreground">{t('pendingInvites')}</p>
      <ul className="mt-2 divide-y">
        {invites.data.map((i) => (
          <li key={i.id} className="flex items-center justify-between gap-2 py-2 text-sm">
            <div className="min-w-0">
              <p className="truncate text-foreground">{i.email}</p>
              <p className="text-xs text-subtle-foreground">
                {i.status === 'expired' ? t('expired') : t('expiresAt', { at: f.dateTime(i.expiresAt) })}
                {i.invitedBy ? ` · ${t('invitedBy', { name: i.invitedBy })}` : ''}
              </p>
              {i.mail && (
                <p className={`text-xs ${INVITE_MAIL_PROBLEMS.has(i.mail) ? 'text-destructive' : 'text-subtle-foreground'}`}>
                  {t(`inviteMail.${i.mail}`)}
                </p>
              )}
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

// The org's own tax code (MST, issue #313): an e-invoice whose seller has it is read as a sale. Owners and admins edit
// it; everyone else sees it.
function TaxCodeField({ taxCode, canManage }: { taxCode: string | null; canManage: boolean }) {
  const t = useTranslations('settings');
  const tc = useTranslations('common');
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(taxCode ?? '');
  const save = useMutation(
    orpc.org.setTaxCode.mutationOptions({
      onSuccess: async () => {
        setEditing(false);
        await queryClient.invalidateQueries({ queryKey: orpc.org.get.key() });
        // The default legal entity has the org's tax code (#1278).
        await queryClient.invalidateQueries({ queryKey: orpc.legalEntities.list.key() });
      },
    }),
  );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate({ taxCode: value.trim() ? value.trim() : null });
  };
  return (
    <div>
      <dt className="text-subtle-foreground">{t('taxCode')}</dt>
      {editing ? (
        <form onSubmit={submit} aria-label={t('taxCode')} className="mt-1 flex flex-wrap items-center gap-2">
          <Input value={value} onChange={(e) => setValue(e.target.value)} maxLength={20} placeholder="0101234567" aria-label={t('taxCode')} className="w-48 font-mono" />
          <Button type="submit" size="sm" disabled={save.isPending}>
            {save.isPending ? <Spinner className="text-current" /> : null}
            {t('taxCodeSave')}
          </Button>
          <Button type="button" size="sm" variant="outline" 
            onClick={() => {
              setEditing(false);
              setValue(taxCode ?? '');
              save.reset();
            }}
          >
            {tc('cancel')}
          </Button>
        </form>
      ) : (
        <dd className="flex flex-wrap items-center gap-2">
          <span className={taxCode ? 'font-mono text-foreground' : 'text-subtle-foreground'}>{taxCode ?? t('taxCodeUnset')}</span>
          {canManage && (
            <Button type="button" size="sm" variant="outline" onClick={() => setEditing(true)}>
              {taxCode ? t('taxCodeChange') : t('taxCodeSet')}
            </Button>
          )}
        </dd>
      )}
      <dd className="mt-1 text-xs text-subtle-foreground">{t('taxCodeHint')}</dd>
      {save.error && <ErrorText>{errorMessage(save.error)}</ErrorText>}
    </div>
  );
}

// How often the org files its VAT return (issue #318), for the deadline on the multi-client home screen. Owners and
// admins choose it; everyone else sees it.
function VatFilingPeriodField({ period, canManage }: { period: 'month' | 'quarter' | null; canManage: boolean }) {
  const t = useTranslations('settings');
  const id = useId();
  const save = useMutation(
    orpc.org.setVatFilingPeriod.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: orpc.org.get.key() });
        await queryClient.invalidateQueries({ queryKey: orpc.me.clients.key() });
      },
    }),
  );
  const label = (value: 'month' | 'quarter' | null) => (value === 'month' ? t('vatFilingMonth') : value === 'quarter' ? t('vatFilingQuarter') : t('vatFilingUnset'));
  return (
    <div>
      <dt className="text-subtle-foreground">
        <label htmlFor={id}>{t('vatFilingPeriod')}</label>
      </dt>
      <dd className="mt-1 flex flex-wrap items-center gap-2">
        {canManage ? (
          <>
            <NativeSelect
              id={id}
              size="sm"
              value={period ?? ''}
              disabled={save.isPending}
              onChange={(e) => save.mutate({ vatFilingPeriod: e.target.value === 'month' || e.target.value === 'quarter' ? e.target.value : null })}
            >
              <NativeSelectOption value="">{t('vatFilingUnset')}</NativeSelectOption>
              <NativeSelectOption value="month">{t('vatFilingMonth')}</NativeSelectOption>
              <NativeSelectOption value="quarter">{t('vatFilingQuarter')}</NativeSelectOption>
            </NativeSelect>
            {save.isPending && <Spinner />}
          </>
        ) : (
          <span id={id} className={period ? 'text-foreground' : 'text-subtle-foreground'}>
            {label(period)}
          </span>
        )}
      </dd>
      <dd className="mt-1 text-xs text-subtle-foreground">{t('vatFilingHint')}</dd>
      {save.error && <ErrorText>{errorMessage(save.error)}</ErrorText>}
    </div>
  );
}

// The tax calendar (issue #921): which recurring obligations apply to the org besides the VAT return, its PIT
// withholding frequency and the last month of its fiscal year, for the home screen's list of what is due. Owners and
// admins choose; everyone else sees the setting.
function TaxCalendarField({ canManage }: { canManage: boolean }) {
  const t = useTranslations('settings');
  const tt = useTranslations('taxCalendar');
  const profile = useQuery(orpc.org.taxProfile.queryOptions());
  const [draft, setDraft] = useState<TaxProfile | null>(null);
  const save = useMutation(
    orpc.org.setTaxProfile.mutationOptions({
      onSuccess: async () => {
        setDraft(null);
        await queryClient.invalidateQueries({ queryKey: orpc.org.taxProfile.key() });
        await queryClient.invalidateQueries({ queryKey: orpc.me.clients.key() });
      },
    }),
  );
  const pitId = useId();
  const fyId = useId();
  // The stored calendar is not shown as empty while it loads.
  if (profile.isLoading) {
    return (
      <div>
        <dt className="text-subtle-foreground">{t('taxCalendar')}</dt>
        <dd className="mt-1">
          <Spinner />
        </dd>
      </div>
    );
  }
  const stored: TaxProfile = profile.data
    ? { obligations: profile.data.obligations, pitFilingPeriod: profile.data.pitFilingPeriod, fiscalYearEndMonth: profile.data.fiscalYearEndMonth }
    : { obligations: [], pitFilingPeriod: null, fiscalYearEndMonth: 12 };
  const current = draft ?? stored;
  const toggle = (o: TaxProfile['obligations'][number], on: boolean) =>
    setDraft({ ...current, obligations: on ? [...current.obligations, o] : current.obligations.filter((x) => x !== o) });
  return (
    <div>
      <dt className="text-subtle-foreground">{t('taxCalendar')}</dt>
      <dd className="mt-1 space-y-2">
        <ul className="space-y-1">
          {PROFILE_OBLIGATIONS.map((o) => (
            <li key={o} className="flex items-center gap-2">
              {canManage ? (
                <label className="flex items-center gap-2">
                  <Checkbox checked={current.obligations.includes(o)} disabled={save.isPending} onCheckedChange={(checked) => toggle(o, checked)} />
                  <span>{tt(`obligations.${o}`)}</span>
                </label>
              ) : (
                <span className={current.obligations.includes(o) ? 'text-foreground' : 'text-subtle-foreground line-through'}>{tt(`obligations.${o}`)}</span>
              )}
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {current.obligations.includes('pit_withholding') && (
            <span className="flex items-center gap-2">
              <label htmlFor={pitId} className="text-muted-foreground">
                {t('pitFilingPeriod')}
              </label>
              <NativeSelect
                id={pitId}
                size="sm"
                value={current.pitFilingPeriod ?? ''}
                disabled={!canManage || save.isPending}
                onChange={(e) => setDraft({ ...current, pitFilingPeriod: e.target.value === 'month' || e.target.value === 'quarter' ? e.target.value : null })}
              >
                <NativeSelectOption value="">{t('vatFilingUnset')}</NativeSelectOption>
                <NativeSelectOption value="month">{t('vatFilingMonth')}</NativeSelectOption>
                <NativeSelectOption value="quarter">{t('vatFilingQuarter')}</NativeSelectOption>
              </NativeSelect>
            </span>
          )}
          <span className="flex items-center gap-2">
            <label htmlFor={fyId} className="text-muted-foreground">
              {t('fiscalYearEnd')}
            </label>
            <NativeSelect
              id={fyId}
              size="sm"
              value={String(current.fiscalYearEndMonth)}
              disabled={!canManage || save.isPending}
              onChange={(e) => setDraft({ ...current, fiscalYearEndMonth: Number(e.target.value) })}
            >
              {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                <NativeSelectOption key={m} value={String(m)}>
                  {t('fiscalYearEndMonth', { month: String(m) })}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </span>
          {canManage && draft && (
            <Button size="sm" onClick={() => save.mutate(current)} disabled={save.isPending}>
              {save.isPending ? <Spinner className="text-current" /> : null}
              {t('taxCalendarSave')}
            </Button>
          )}
        </div>
      </dd>
      <dd className="mt-1 text-xs text-subtle-foreground">{t('taxCalendarHint')}</dd>
      {profile.error && <ErrorText>{errorMessage(profile.error)}</ErrorText>}
      {save.error && <ErrorText>{errorMessage(save.error)}</ErrorText>}
    </div>
  );
}

// Approval reminders (issue #676): after how many days a pending proposal reminds the people who may approve it, and
// after how many its owners are told. Expiry (#876): after how many days a proposal still pending expires; it needs the
// owners' escalation and comes after it, so only longer choices are offered. Owners and admins choose; everyone else
// sees the setting.
const REMIND_DAYS = [1, 2, 3, 5, 7] as const;
const ESCALATE_DAYS = [2, 3, 5, 7, 14] as const;
const EXPIRE_DAYS = [7, 14, 30, 60, 90] as const;
type PolicyField = 'remindAfterDays' | 'escalateAfterDays' | 'expireAfterDays';

function ProposalRemindersField({ canManage }: { canManage: boolean }) {
  const t = useTranslations('settings');
  const remindId = useId();
  const escalateId = useId();
  const expireId = useId();
  // Set when a change of the escalation turned expiry off with it, so the user is told.
  const [expiryTurnedOff, setExpiryTurnedOff] = useState(false);
  const policy = useQuery(orpc.org.proposalPolicy.queryOptions());
  const save = useMutation(
    orpc.org.setProposalPolicy.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: orpc.org.proposalPolicy.key() });
      },
    }),
  );
  const current = save.isPending && save.variables ? save.variables : (policy.data ?? { remindAfterDays: null, escalateAfterDays: null, expireAfterDays: null });
  const off = (field: PolicyField) => (field === 'expireAfterDays' ? t('expireOff') : t('reminderOff'));
  const label = (field: PolicyField, days: number | null) => (days === null ? off(field) : t('reminderDays', { days: String(days) }));
  const choose = (field: PolicyField, raw: string) => {
    const next = { ...current, [field]: raw === '' ? null : Number(raw) };
    // Expiry comes after the escalation: turning the escalation off, or past the expiry, turns expiry off with it.
    const turnsOff = next.expireAfterDays !== null && (next.escalateAfterDays === null || next.expireAfterDays <= next.escalateAfterDays);
    if (turnsOff) next.expireAfterDays = null;
    setExpiryTurnedOff(turnsOff);
    save.mutate(next);
  };
  const escalation = current.escalateAfterDays;
  const expireOptions = escalation === null ? [] : EXPIRE_DAYS.filter((d) => d > escalation);
  const select = (id: string, field: PolicyField, options: readonly number[]) =>
    canManage ? (
      <NativeSelect
        id={id}
        size="sm"
        value={current[field] === null ? '' : String(current[field])}
        disabled={save.isPending || policy.isLoading || (field === 'expireAfterDays' && escalation === null)}
        onChange={(e) => choose(field, e.target.value)}
      >
        <NativeSelectOption value="">{off(field)}</NativeSelectOption>
        {options.map((d) => (
          <NativeSelectOption key={d} value={String(d)}>
            {t('reminderDays', { days: String(d) })}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    ) : (
      <span id={id} className={current[field] === null ? 'text-subtle-foreground' : 'text-foreground'}>
        {label(field, current[field])}
      </span>
    );
  return (
    <div>
      <dt className="text-subtle-foreground">{t('proposalReminders')}</dt>
      <dd className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="flex items-center gap-2">
          <label htmlFor={remindId} className="text-muted-foreground">
            {t('remindAfter')}
          </label>
          {select(remindId, 'remindAfterDays', REMIND_DAYS)}
        </span>
        <span className="flex items-center gap-2">
          <label htmlFor={escalateId} className="text-muted-foreground">
            {t('escalateAfter')}
          </label>
          {select(escalateId, 'escalateAfterDays', ESCALATE_DAYS)}
        </span>
        <span className="flex items-center gap-2">
          <label htmlFor={expireId} className="text-muted-foreground">
            {t('expireAfter')}
          </label>
          {select(expireId, 'expireAfterDays', expireOptions)}
        </span>
        {save.isPending && <Spinner />}
      </dd>
      <dd className="mt-1 text-xs text-subtle-foreground">{t('proposalRemindersHint')}</dd>
      <dd className="mt-1 text-xs text-subtle-foreground">{t('proposalExpiryHint')}</dd>
      {expiryTurnedOff && (
        <dd className="mt-1 text-xs text-warning" role="status">
          {t('expiryTurnedOff')}
        </dd>
      )}
      {policy.error && <ErrorText>{errorMessage(policy.error)}</ErrorText>}
      {save.error && <ErrorText>{errorMessage(save.error)}</ErrorText>}
    </div>
  );
}

// The org's address as the tax registry records it (issue #324). Owners and admins edit it; everyone else sees it.
function AddressField({ address, canManage }: { address: string | null; canManage: boolean }) {
  const t = useTranslations('settings');
  const tc = useTranslations('common');
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(address ?? '');
  const save = useMutation(
    orpc.org.setAddress.mutationOptions({
      onSuccess: async () => {
        setEditing(false);
        await queryClient.invalidateQueries({ queryKey: orpc.org.get.key() });
      },
    }),
  );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate({ address: value.trim() ? value.trim() : null });
  };
  return (
    <div>
      <dt className="text-subtle-foreground">{t('address')}</dt>
      {editing ? (
        <form onSubmit={submit} aria-label={t('address')} className="mt-1 flex flex-wrap items-center gap-2">
          <Input value={value} onChange={(e) => setValue(e.target.value)} maxLength={500} aria-label={t('address')} className="min-w-64 flex-1" />
          <Button type="submit" size="sm" disabled={save.isPending}>
            {save.isPending ? <Spinner className="text-current" /> : null}
            {t('addressSave')}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              setEditing(false);
              setValue(address ?? '');
              save.reset();
            }}
          >
            {tc('cancel')}
          </Button>
        </form>
      ) : (
        <dd className="flex flex-wrap items-center gap-2">
          <span className={address ? 'text-foreground' : 'text-subtle-foreground'}>{address ?? t('addressUnset')}</span>
          {canManage && (
            <Button type="button" size="sm" variant="outline" onClick={() => setEditing(true)}>
              {address ? t('addressChange') : t('addressSet')}
            </Button>
          )}
        </dd>
      )}
      {save.error && <ErrorText>{errorMessage(save.error)}</ErrorText>}
    </div>
  );
}

// The org's contact email (issue #669): where Crove sends the requests for missing purchase invoices. Owners and admins
// edit it; everyone else sees it.
function ContactEmailField({ email, canManage }: { email: string | null; canManage: boolean }) {
  const t = useTranslations('settings');
  const tc = useTranslations('common');
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(email ?? '');
  const save = useMutation(
    orpc.org.setContactEmail.mutationOptions({
      onSuccess: async () => {
        setEditing(false);
        // The reconciliation screen's request card reads the contact email from its own query.
        await Promise.all([queryClient.invalidateQueries({ queryKey: orpc.org.get.key() }), queryClient.invalidateQueries({ queryKey: orpc.missingInvoices.status.key() })]);
      },
    }),
  );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate({ email: value.trim() ? value.trim() : null });
  };
  return (
    <div>
      <dt className="text-subtle-foreground">{t('contactEmail')}</dt>
      {editing ? (
        <form onSubmit={submit} aria-label={t('contactEmail')} className="mt-1 flex flex-wrap items-center gap-2">
          <Input type="email" value={value} onChange={(e) => setValue(e.target.value)} maxLength={320} aria-label={t('contactEmail')} className="min-w-64 flex-1" />
          <Button type="submit" size="sm" disabled={save.isPending}>
            {save.isPending ? <Spinner className="text-current" /> : null}
            {t('contactEmailSave')}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              setEditing(false);
              setValue(email ?? '');
              save.reset();
            }}
          >
            {tc('cancel')}
          </Button>
        </form>
      ) : (
        <dd className="flex flex-wrap items-center gap-2">
          <span className={email ? 'break-all text-foreground' : 'text-subtle-foreground'}>{email ?? t('contactEmailUnset')}</span>
          {canManage && (
            <Button type="button" size="sm" variant="outline" onClick={() => setEditing(true)}>
              {email ? t('contactEmailChange') : t('contactEmailSet')}
            </Button>
          )}
        </dd>
      )}
      <dd className="mt-1 text-xs text-subtle-foreground">{t('contactEmailHint')}</dd>
      {save.error && <ErrorText>{errorMessage(save.error)}</ErrorText>}
    </div>
  );
}

export function SettingsPage() {
  const root = useTranslations();
  const t = useTranslations('settings');
  const org = useQuery(orpc.org.get.queryOptions());
  const me = useQuery(orpc.me.get.queryOptions());
  const search: { invite?: string } = useSearch({ strict: false });
  // Role assignments (#1279): owners and admins see who holds which role; owners give and take them back.
  const managesMembers = org.data?.role === 'owner' || org.data?.role === 'admin';
  const memberRoles = useQuery({ ...orpc.org.memberRoles.queryOptions(), enabled: managesMembers });
  const entities = useQuery({ ...orpc.legalEntities.list.queryOptions(), enabled: managesMembers });

  if (org.isLoading) return <Spinner />;
  if (org.error) return <ErrorText>{errorMessage(org.error)}</ErrorText>;
  const canManage = org.data?.role === 'owner' || org.data?.role === 'admin';
  const isOwner = org.data?.role === 'owner';
  // An owner may change their own role only while another owner remains (otherwise the server refuses LAST_OWNER).
  const owners = org.data?.members.filter((m) => m.role === 'owner').length ?? 0;
  const controlsFor = (userId: string) => isOwner && !!me.data && (userId !== me.data.userId || owners > 1);

  return (
    <>
      <PageHeader
        title={t('title')}
        subtitle={org.data?.name}
        actions={
          canManage &&
          org.data && (
            <div className="flex flex-wrap gap-2">
              <Link to="/o/$slug/personal-data" params={{ slug: org.data.slug }} className={buttonVariants({ variant: 'outline', size: 'lg' })}>
                {root('personalData.open')}
              </Link>
              <Link to="/o/$slug/audit" params={{ slug: org.data.slug }} className={buttonVariants({ variant: 'outline', size: 'lg' })}>
                {root('audit.open')}
              </Link>
            </div>
          )
        }
      />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="block p-4">
          <p className="text-sm font-medium text-muted-foreground">{t('org')}</p>
          <dl className="mt-3 space-y-2 text-sm">
            <div>
              <dt className="text-subtle-foreground">{t('name')}</dt>
              <dd className="text-foreground">{org.data?.name}</dd>
            </div>
            <div>
              <dt className="text-subtle-foreground">{t('slug')}</dt>
              <dd className="font-mono text-foreground">{org.data?.slug}</dd>
            </div>
            {/* Keyed by org too: a value typed in one org must not stay in the form when the page shows another. */}
            {getConfig().modules.includes('finance') && (
              <TaxCodeField key={`${org.data?.slug}:${org.data?.taxCode ?? ''}`} taxCode={org.data?.taxCode ?? null} canManage={canManage} />
            )}
            {getConfig().modules.includes('finance') && <VatFilingPeriodField period={org.data?.vatFilingPeriod ?? null} canManage={canManage} />}
            {getConfig().modules.includes('finance') && <TaxCalendarField key={org.data?.slug} canManage={canManage} />}
            <AddressField key={`${org.data?.slug}:${org.data?.address ?? ''}`} address={org.data?.address ?? null} canManage={canManage} />
            {getConfig().modules.includes('finance') && (
              <ContactEmailField key={`${org.data?.slug}:${org.data?.contactEmail ?? ''}`} email={org.data?.contactEmail ?? null} canManage={canManage} />
            )}
            {getConfig().modules.includes('finance') && <ProposalRemindersField key={org.data?.slug} canManage={canManage} />}
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
        {/* Focusable, so the approval rule's refusal can take the reader to the role assignments (#1425). */}
        <Card id={MEMBERS_CARD_ID} tabIndex={-1} className="block scroll-mt-20 p-4 outline-none">
          <p className="text-sm font-medium text-muted-foreground">{t('members')}</p>
          <ul className="mt-3 divide-y">
            {org.data?.members.map((m) => (
              <li key={m.userId} className="py-2 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <span className="truncate text-foreground">{m.displayName ?? m.email}</span>
                  {controlsFor(m.userId) ? (
                    <MemberControls member={m} self={m.userId === me.data?.userId} />
                  ) : (
                    <Badge variant={m.role === 'owner' ? 'brand' : 'secondary'}>{root(`roles.${m.role}`)}</Badge>
                  )}
                </div>
                {memberRoles.data && (
                  <MemberRolesRow
                    userId={m.userId}
                    name={m.displayName ?? m.email}
                    baseRole={m.role}
                    data={memberRoles.data}
                    entities={entities.data ?? []}
                    isOwner={isOwner}
                  />
                )}
                {isOwner && me.data && m.userId !== me.data.userId && <MemberSessions userId={m.userId} name={m.displayName ?? m.email} />}
              </li>
            ))}
          </ul>
          {/* The roles could not be read: say so with a retry, instead of showing members as holding none (#1279). */}
          {(memberRoles.error || entities.error) && (
            <div className="mt-2 flex flex-wrap items-center gap-2" role="alert">
              <ErrorText>{root('memberRoles.loadFailed', { reason: errorMessage(memberRoles.error ?? entities.error) })}</ErrorText>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  if (memberRoles.error) void memberRoles.refetch();
                  if (entities.error) void entities.refetch();
                }}
              >
                {root('memberRoles.retry')}
              </Button>
            </div>
          )}
          {canManage && (
            <>
              <InviteMember isOwner={isOwner} initialEmail={search.invite} />
              <PendingInvites />
            </>
          )}
        </Card>
        {/* Who approves the ledger's proposals (#1425), with the finance module; every member sees it, owners switch it. */}
        {getConfig().modules.includes('finance') && org.data && (
          <ApprovalPresetCard key={`${org.data.slug}:${org.data.approvalPreset}`} preset={org.data.approvalPreset} isOwner={isOwner} />
        )}
        {/* The member's own working hours and days off (#1313). */}
        {org.data && <WorkingHoursCard key={org.data.slug} canEdit={org.data.role !== 'viewer'} />}
        {/* The booking pages' event types (#1314), with the crm module. */}
        {getConfig().modules.includes('crm') && org.data && me.data && (
          <EventTypesCard key={org.data.slug} members={org.data.members} me={me.data.userId} role={org.data.role} />
        )}
        {/* The legal entities the books are kept for (#1278), with the finance module; owners and admins only. */}
        {getConfig().modules.includes('finance') && canManage && <LegalEntitiesCard key={org.data?.slug} />}
        {/* The chart of accounts belongs to the finance module (#319). */}
        {getConfig().modules.includes('finance') && <ChartOfAccountsCard canManage={canManage} />}
        {/* The account rules learned from approvals, and keyword rules (#1399). */}
        {getConfig().modules.includes('finance') && org.data && <AccountRulesCard key={org.data.slug} canManage={canManage} />}
        <TwoFactorCard />
        {me.data && <MySessions userId={me.data.userId} />}
        {isOwner && org.data && <Offboarding name={org.data.name} slug={org.data.slug} />}
      </div>
    </>
  );
}
