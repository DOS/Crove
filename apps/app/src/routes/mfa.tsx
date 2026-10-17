import { useNavigate } from '@tanstack/react-router';
import { useTranslations } from 'use-intl';
import { MfaChallengeForm } from '../components/two-factor.tsx';
import { Card } from '@crove/ui/components/card';
import { Logo } from '../components/ui.tsx';
import { signOut } from '../lib/session-actions.ts';

export function MfaPage() {
  const navigate = useNavigate();
  const root = useTranslations();
  const t = useTranslations('twoFactor');
  return (
    <main className="flex min-h-full items-center justify-center bg-background px-4 py-16">
      <Card className="relative block w-full max-w-sm p-6">
        <Logo />
        <h1 className="mt-6 text-lg font-semibold text-foreground">{t('title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('signInIntro')}</p>
        <div className="mt-6">
          <MfaChallengeForm onVerified={() => navigate({ to: '/' })} />
        </div>
        <button className="mt-4 text-sm text-subtle-foreground hover:text-muted-foreground" onClick={() => void signOut()}>
          {root('common.signOut')}
        </button>
      </Card>
    </main>
  );
}
