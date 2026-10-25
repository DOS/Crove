import { useNavigate } from '@tanstack/react-router';
import { useEffect, useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import { MfaChallengeForm } from '../components/two-factor.tsx';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Input } from '@crove/ui/components/input';
import { ErrorText, Field, focusFirstInvalid, Logo, Spinner, useFieldErrors } from '../components/ui.tsx';
import { auth, authErrorText, authFailure, needsSecondFactor, type AuthFailure } from '../lib/auth.ts';

export function ResetPasswordPage() {
  const navigate = useNavigate();
  const root = useTranslations();
  const t = useTranslations('resetPassword');
  // A recovery link alone does not get past a second factor: verify the code first.
  const [needsCode, setNeedsCode] = useState<boolean | null>(null);
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);
  // A Supabase Auth failure, worded at render (issue #215).
  const [error, setError] = useState<AuthFailure | null>(null);
  // Each field's own problem sits under it (#1515); a repeat that differs is the repeat field's.
  const fields = useFieldErrors<'password' | 'repeat'>((field) => {
    if (field === 'password') return !password ? t('passwordRequired') : password.length < 8 ? t('passwordShort') : null;
    return !repeat ? t('repeatRequired') : repeat !== password ? t('mismatch') : null;
  });

  useEffect(() => {
    void needsSecondFactor().then(setNeedsCode);
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!fields.checkAll(['password', 'repeat'])) {
      focusFirstInvalid(event.currentTarget);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { error: e } = await auth().updateUser({ password });
      if (e) return setError(authFailure(e));
      await navigate({ to: '/' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-full items-center justify-center bg-background px-4 py-16">
      <Card className="relative block w-full max-w-sm p-6">
        <Logo />
        <h1 className="mt-6 text-lg font-semibold text-foreground">{t('title')}</h1>
        {needsCode === null ? (
          <div className="mt-6">
            <Spinner />
          </div>
        ) : needsCode ? (
          <>
            <p className="mt-1 text-sm text-muted-foreground">{t('needsCode')}</p>
            <div className="mt-6">
              <MfaChallengeForm onVerified={() => setNeedsCode(false)} />
            </div>
          </>
        ) : (
          <form className="mt-6 space-y-3" noValidate onSubmit={submit}>
            <Field label={t('newPassword')} error={fields.of('password')}>
              {(control) => (
                <Input
                  {...control}
                  type="password"
                  required
                  minLength={8}
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    fields.edit('password');
                  }}
                  onBlur={(e) => fields.blur('password', e.target.value)}
                />
              )}
            </Field>
            <Field label={t('repeat')} error={fields.of('repeat')}>
              {(control) => (
                <Input
                  {...control}
                  type="password"
                  required
                  minLength={8}
                  autoComplete="new-password"
                  value={repeat}
                  onChange={(e) => {
                    setRepeat(e.target.value);
                    fields.edit('repeat');
                  }}
                  onBlur={(e) => fields.blur('repeat', e.target.value)}
                />
              )}
            </Field>
            {error && <ErrorText>{authErrorText(error, root)}</ErrorText>}
            <Button type="submit" size="lg" className="w-full" disabled={busy}>
              {busy ? t('saving') : t('save')}
            </Button>
          </form>
        )}
      </Card>
    </main>
  );
}
