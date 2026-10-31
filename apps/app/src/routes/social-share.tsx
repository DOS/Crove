import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslations } from 'use-intl';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { ErrorText, Logo, ScreenTitle, Spinner } from '../components/ui.tsx';
import { errorMessage, orpc } from '../lib/api.ts';
import { getConfig } from '../lib/auth.ts';
import { forgetShare, pendingShare, shareFragment, type PendingShare } from '../lib/social-share.ts';

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

// Where a shared page lands (#1235): the router kept the share in this tab while the person signed in; here it goes to
// the composer of the org it names (the bookmarklet's), of the only org, or of the org the person picks.
export function SocialSharePage() {
  const t = useTranslations('social.share');
  const tc = useTranslations('common');
  const navigate = useNavigate();
  const [shared] = useState<PendingShare | null>(() => pendingShare());
  const me = useQuery(orpc.me.get.queryOptions());
  const socialOn = getConfig().modules.includes('social');
  const orgs = me.data?.orgs ?? [];
  const named = shared?.org ? orgs.find((o) => o.slug === shared.org) : undefined;
  const target = named ?? (orgs.length === 1 ? orgs[0] : undefined);

  const opened = useRef(false);
  const open = (slug: string) => {
    if (!shared || opened.current) return;
    opened.current = true;
    forgetShare();
    void navigate({ to: '/o/$slug/social/new', params: { slug }, hash: shareFragment(shared), replace: true });
  };
  useEffect(() => {
    if (socialOn && target) open(target.slug);
  }, [socialOn, target?.slug]); // eslint-disable-line react-hooks/exhaustive-deps

  const leave = () => {
    forgetShare();
    void navigate({ to: '/' });
  };

  if (!shared || !socialOn) {
    return (
      <Shell>
        <ScreenTitle name={t(socialOn ? 'nothingTitle' : 'offTitle')} />
        <h1 className="mt-6 text-lg font-semibold text-foreground">{t(socialOn ? 'nothingTitle' : 'offTitle')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t(socialOn ? 'nothingBody' : 'offBody')}</p>
        <Button variant="outline" size="lg" className="mt-6" onClick={leave}>
          {tc('backHome')}
        </Button>
      </Shell>
    );
  }
  if (me.isLoading || target) {
    return (
      <Shell>
        <Spinner />
      </Shell>
    );
  }
  if (me.error) {
    return (
      <Shell>
        <ErrorText>{errorMessage(me.error)}</ErrorText>
      </Shell>
    );
  }
  return (
    <Shell>
      <ScreenTitle name={t('pickTitle')} />
      <h1 className="mt-6 text-lg font-semibold text-foreground">{t('pickTitle')}</h1>
      <p className="mt-1 text-sm text-muted-foreground">{orgs.length === 0 ? t('noOrgs') : t('pickBody')}</p>
      {shared.link && <p className="mt-3 truncate text-xs text-subtle-foreground">{shared.link}</p>}
      <div className="mt-4 space-y-2">
        {orgs.map((o) => (
          <Button key={o.slug} variant="outline" size="lg" className="w-full justify-start" onClick={() => open(o.slug)}>
            <span className="truncate">{o.name}</span>
          </Button>
        ))}
      </div>
      <Button variant="ghost" size="lg" className="mt-4" onClick={leave}>
        {t('cancel')}
      </Button>
    </Shell>
  );
}
