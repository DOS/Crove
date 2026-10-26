import { useNavigate } from '@tanstack/react-router';
import { useEffect, useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Input } from '@crove/ui/components/input';
import { ErrorText, Field, focusFirstInvalid, isEmailAddress, Logo, Notice, useFieldErrors } from '../components/ui.tsx';
import { LocaleSwitcher } from '../i18n/provider.tsx';
import { auth, authErrorText, authFailure, callbackNoticeText, clearCallbackNotice, peekCallbackNotice, type AuthFailure, type CallbackNotice } from '../lib/auth.ts';
import { LegalConsent } from '../components/legal-consent.tsx';
import { SupportLink } from '../components/support-link.tsx';

type Mode = 'login' | 'signup' | 'reset';
// The notices the screen shows after sending an email, by message key: state holds no translated text (issue #215).
type SentNotice = 'signupSent' | 'resetSent';

export function AuthPage() {
  const navigate = useNavigate();
  const root = useTranslations();
  const t = useTranslations('auth');
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AuthFailure | null>(null);
  const [notice, setNotice] = useState<SentNotice | null>(null);
  // The outcome of an email link the app was opened with, if any (see settleCallback). Kept as a code and worded at
  // render, like the errors above.
  const [callback, setCallback] = useState<CallbackNotice | null>(peekCallbackNotice);
  useEffect(clearCallbackNotice, []);
  // Checked by the form itself, so each error sits under its field (#1515); the server checks again.
  const fields = useFieldErrors<'email' | 'password'>((field) => {
    if (field === 'email') return !email.trim() ? t('emailRequired') : isEmailAddress(email) ? null : t('emailInvalid');
    return !password ? t('passwordRequired') : password.length < 8 ? t('passwordShort') : null;
  });
  const switchTo = (next: Mode) => {
    fields.reset();
    setMode(next);
  };

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!fields.checkAll(mode === 'reset' ? ['email'] : ['email', 'password'])) {
      focusFirstInvalid(event.currentTarget);
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    setCallback(null);
    try {
      if (mode === 'login') {
        const { error: e } = await auth().signInWithPassword({ email, password });
        if (e) return setError(authFailure(e));
        await navigate({ to: '/' });
      } else if (mode === 'signup') {
        const { data, error: e } = await auth().signUp({ email, password, options: { emailRedirectTo: `${window.location.origin}/` } });
        if (e) return setError(authFailure(e));
        if (data.session) await navigate({ to: '/' });
        else setNotice('signupSent');
      } else {
        const { error: e } = await auth().resetPasswordForEmail(email, { redirectTo: `${window.location.origin}/reset-password` });
        if (e) return setError(authFailure(e));
        setNotice('resetSent');
      }
    } finally {
      setBusy(false);
    }
  }

  const titles: Record<Mode, string> = { login: t('login'), signup: t('signup'), reset: t('reset') };

  return (
    <main className="flex min-h-full flex-col items-center justify-center bg-background px-4 py-16">
      <Card className="relative block w-full max-w-sm p-6">
        <div className="flex items-center justify-between gap-2">
          <Logo />
          <LocaleSwitcher />
        </div>
        <h1 className="mt-6 text-lg font-semibold text-foreground">{titles[mode]}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('tagline')}</p>
        <form className="mt-6 space-y-3" noValidate onSubmit={submit}>
          <Field label={t('email')} error={fields.of('email')}>
            {(control) => (
              <Input
                {...control}
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  fields.edit('email');
                }}
                onBlur={(e) => fields.blur('email', e.target.value)}
              />
            )}
          </Field>
          {mode !== 'reset' && (
            <Field label={t('password')} error={fields.of('password')}>
              {(control) => (
                <Input
                  {...control}
                  type="password"
                  required
                  minLength={8}
                  autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    fields.edit('password');
                  }}
                  onBlur={(e) => fields.blur('password', e.target.value)}
                />
              )}
            </Field>
          )}
          {error && <ErrorText>{authErrorText(error, root)}</ErrorText>}
          {callback?.error && <ErrorText>{callbackNoticeText(callback, root)}</ErrorText>}
          {notice && <Notice>{t(notice)}</Notice>}
          {callback && !callback.error && <Notice>{callbackNoticeText(callback, root)}</Notice>}
          <Button type="submit" size="lg" className="w-full" disabled={busy}>
            {busy ? root('common.processing') : titles[mode]}
          </Button>
          {mode === 'signup' && <LegalConsent />}
        </form>
        <div className="mt-4 flex justify-between text-sm">
          {mode === 'login' ? (
            <>
              <button className="text-link hover:underline" onClick={() => switchTo('signup')}>
                {t('signup')}
              </button>
              <button className="text-subtle-foreground hover:text-muted-foreground" onClick={() => switchTo('reset')}>
                {t('forgotLink')}
              </button>
            </>
          ) : (
            <button className="text-link hover:underline" onClick={() => switchTo('login')}>
              {t('haveAccount')}
            </button>
          )}
        </div>
      </Card>
      {/* Help in the same place as on every screen of the app (DESIGN.md §7, 3.2.6; #1516). */}
      <SupportLink className="mt-4 text-sm text-link" />
    </main>
  );
}
