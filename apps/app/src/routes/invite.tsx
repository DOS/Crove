import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { useTranslations } from 'use-intl';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { ErrorText, Logo, Spinner } from '../components/ui.tsx';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';
import { signOut } from '../lib/session-actions.ts';
import { useFormat } from '../i18n/provider.tsx';
import { forgetInvite, pendingInvite } from '../lib/invite.ts';

function errorCode(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : null;
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-full items-center justify-center bg-background px-4 py-16">
      <Card className="block w-full max-w-md p-6">
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
  const t = useTranslations('invite');
  const tc = useTranslations('common');
  const f = useFormat();
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
        <h1 className="mt-6 text-lg font-semibold text-foreground">{t('noInviteTitle')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('noInviteBody')}</p>
        <Button variant="outline" size="lg" className="mt-6" onClick={() => void navigate({ to: '/' })}>
          {tc('backHome')}
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
        <h1 className="mt-6 text-lg font-semibold text-foreground">{t('openFailed')}</h1>
        <ErrorText>{errorMessage(preview.error)}</ErrorText>
        {mismatch && me.data && <p className="mt-2 text-sm text-muted-foreground">{t('signedInAs', { email: me.data.email })}</p>}
        <div className="mt-6 flex flex-wrap gap-2">
          {mismatch && (
            // The token stays in storage, so after signing in with the invited email the user comes back here.
            <Button size="lg" onClick={() => void signOut({ keepInvite: true })}>
              {t('signOutOther')}
            </Button>
          )}
          <Button variant="ghost" size="lg" onClick={leave}>
            {tc('backHome')}
          </Button>
        </div>
      </Shell>
    );
  }

  const invite = preview.data;
  if (!invite) return null;
  return (
    <Shell>
      <h1 className="mt-6 text-lg font-semibold text-foreground">{t('title', { org: invite.orgName })}</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        {t.rich('body', {
          invitedBy: invite.invitedBy,
          org: invite.orgName,
          role: t(`role.${invite.role}`),
          strong: (chunks) => <span className="font-medium text-foreground">{chunks}</span>,
        })}
      </p>
      <p className="mt-2 text-xs text-subtle-foreground">
        {t('expires', { at: f.dateTime(invite.expiresAt) })}{' '}
        {me.data?.email ? t('visibility', { email: me.data.email }) : t('visibilityNoEmail')}
      </p>
      {accept.error && <ErrorText>{errorMessage(accept.error)}</ErrorText>}
      <div className="mt-6 flex flex-wrap gap-2">
        <Button size="lg" disabled={accept.isPending} onClick={() => accept.mutate({ token })}>
          {accept.isPending ? tc('processing') : t('accept')}
        </Button>
        <Button variant="ghost" size="lg" disabled={accept.isPending} onClick={leave}>
          {t('decline')}
        </Button>
      </div>
    </Shell>
  );
}
