import { useNavigate } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import { Button, Card, ErrorText, Input, Logo } from '../components/ui.tsx';
import { LocaleSwitcher } from '../i18n/provider.tsx';
import { auth, authErrorMessage } from '../lib/auth.ts';

type Mode = 'login' | 'signup' | 'reset';

export function AuthPage() {
  const navigate = useNavigate();
  const root = useTranslations();
  const t = useTranslations('auth');
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (mode === 'login') {
        const { error: e } = await auth().signInWithPassword({ email, password });
        if (e) return setError(authErrorMessage(e, root));
        await navigate({ to: '/' });
      } else if (mode === 'signup') {
        const { data, error: e } = await auth().signUp({ email, password, options: { emailRedirectTo: `${window.location.origin}/` } });
        if (e) return setError(authErrorMessage(e, root));
        if (data.session) await navigate({ to: '/' });
        else setNotice(t('signupSent'));
      } else {
        const { error: e } = await auth().resetPasswordForEmail(email, { redirectTo: `${window.location.origin}/` });
        if (e) return setError(authErrorMessage(e, root));
        setNotice(t('resetSent'));
      }
    } finally {
      setBusy(false);
    }
  }

  const titles: Record<Mode, string> = { login: t('login'), signup: t('signup'), reset: t('reset') };

  return (
    <main className="flex min-h-full items-center justify-center bg-canvas px-4 py-16">
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(ellipse_at_top,rgba(124,58,237,0.18),transparent_60%)]" />
      <Card className="relative w-full max-w-sm p-6">
        <div className="flex items-center justify-between gap-2">
          <Logo />
          <LocaleSwitcher />
        </div>
        <h1 className="mt-6 text-lg font-semibold text-fg">{titles[mode]}</h1>
        <p className="mt-1 text-sm text-fg-2">{t('tagline')}</p>
        <form className="mt-6 space-y-3" onSubmit={submit}>
          <label className="block text-sm">
            <span className="mb-1 block text-fg-2">{t('email')}</span>
            <Input type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          {mode !== 'reset' && (
            <label className="block text-sm">
              <span className="mb-1 block text-fg-2">{t('password')}</span>
              <Input
                type="password"
                required
                minLength={8}
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
          )}
          {error && <ErrorText>{error}</ErrorText>}
          {notice && <p className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">{notice}</p>}
          <Button type="submit" variant="primary" className="w-full" disabled={busy}>
            {busy ? root('common.processing') : titles[mode]}
          </Button>
        </form>
        <div className="mt-4 flex justify-between text-sm">
          {mode === 'login' ? (
            <>
              <button className="text-brand-300 hover:underline" onClick={() => setMode('signup')}>
                {t('signup')}
              </button>
              <button className="text-fg-3 hover:text-fg-2" onClick={() => setMode('reset')}>
                {t('forgotLink')}
              </button>
            </>
          ) : (
            <button className="text-brand-300 hover:underline" onClick={() => setMode('login')}>
              {t('haveAccount')}
            </button>
          )}
        </div>
      </Card>
    </main>
  );
}
