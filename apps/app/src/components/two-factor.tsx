import { useQuery } from '@tanstack/react-query';
import { useId, useRef, useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import { brandName } from '../i18n/brand.ts';
import { auth, authErrorText, authFailure, type AuthFailure } from '../lib/auth.ts';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Input } from '@crove/ui/components/input';
import { Label } from '@crove/ui/components/label';
import { ConfirmDialog } from './confirm-dialog.tsx';
import { ErrorText, fieldControl, fieldErrorId, Notice, Spinner } from './ui.tsx';

interface Enrollment {
  factorId: string;
  qrCode: string;
  secret: string;
}

// A Supabase Auth error as a screen keeps it: by code or server message, worded at render (issue #215).
function failureOf(error: unknown): AuthFailure {
  return authFailure(error as { code?: string; message: string });
}

// The signed-in user's Supabase Auth MFA factors; `totp` lists the verified ones.
export function useFactors() {
  return useQuery({
    queryKey: ['auth', 'factors'],
    queryFn: async () => {
      const { data, error } = await auth().mfa.listFactors();
      if (error) throw error;
      return data;
    },
  });
}

// Verifies a code from the user's authenticator app, which raises the session to aal2.
export function MfaChallengeForm({ onVerified }: { onVerified: () => Promise<void> | void }) {
  const root = useTranslations();
  const t = useTranslations('twoFactor');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  // The code field names the error under it (#1515), and takes the focus back after a refused code.
  const codeId = useId();
  const codeInput = useRef<HTMLInputElement>(null);
  // A Supabase Auth failure, or 'noFactor'; worded at render.
  const [error, setError] = useState<AuthFailure | 'noFactor' | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { data: factors, error: listError } = await auth().mfa.listFactors();
      if (listError) return setError(authFailure(listError));
      const factor = factors.totp[0];
      if (!factor) return setError('noFactor');
      const { error: verifyError } = await auth().mfa.challengeAndVerify({ factorId: factor.id, code: code.trim() });
      if (verifyError) {
        setCode('');
        setError(authFailure(verifyError));
        codeInput.current?.focus();
        return;
      }
      await onVerified();
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="space-y-3" onSubmit={submit}>
      <Label className="flex-col items-stretch gap-1 font-normal">
        <span className="text-muted-foreground">{t('code')}</span>
        <Input
          ref={codeInput}
          {...fieldControl(codeId, { error: Boolean(error) })}
          required
          autoFocus
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}"
          maxLength={6}
          placeholder={t('codePlaceholder')}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
        />
      </Label>
      {error && <ErrorText id={fieldErrorId(codeId)}>{error === 'noFactor' ? t('noFactor') : authErrorText(error, root)}</ErrorText>}
      <Button type="submit" size="lg" className="w-full" disabled={busy}>
        {busy ? t('checking') : t('confirm')}
      </Button>
    </form>
  );
}

// TOTP enrollment for the signed-in user (Supabase Auth MFA). A verified factor makes the next sign-in aal2.
export function TwoFactorCard({ onEnabled }: { onEnabled?: () => void }) {
  const root = useTranslations();
  const t = useTranslations('twoFactor');
  const factors = useFactors();
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  // Kept as a code or message key and worded at render, so a language switch rewords them (issue #215).
  const [error, setError] = useState<AuthFailure | null>(null);
  // While the setup form is open, a refusal is about the code it asks for: the field names it (#1515).
  const codeId = useId();
  const [notice, setNotice] = useState<'enabled' | 'disabled' | null>(null);
  const verified = factors.data?.totp ?? [];

  async function run(action: () => Promise<AuthFailure | null>) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      setError(await action());
    } finally {
      setBusy(false);
      await factors.refetch();
    }
  }

  const start = () =>
    run(async () => {
      // An abandoned setup leaves an unverified factor behind; remove it so they do not pile up.
      for (const f of factors.data?.all ?? []) {
        if (f.factor_type === 'totp' && f.status !== 'verified') await auth().mfa.unenroll({ factorId: f.id });
      }
      const { data, error: e } = await auth().mfa.enroll({ factorType: 'totp', issuer: brandName() });
      if (e) return authFailure(e);
      setCode('');
      setEnrollment({ factorId: data.id, qrCode: data.totp.qr_code, secret: data.totp.secret });
      return null;
    });

  const confirm = (event: FormEvent) => {
    event.preventDefault();
    if (!enrollment) return;
    void run(async () => {
      const { error: e } = await auth().mfa.challengeAndVerify({ factorId: enrollment.factorId, code: code.trim() });
      if (e) return authFailure(e);
      setEnrollment(null);
      setNotice('enabled');
      onEnabled?.();
      return null;
    });
  };

  const cancel = () =>
    run(async () => {
      if (enrollment) await auth().mfa.unenroll({ factorId: enrollment.factorId });
      setEnrollment(null);
      return null;
    });

  // Asked first in a dialog (ConfirmDialog below).
  const disable = (factorId: string) => {
    void run(async () => {
      const { error: e } = await auth().mfa.unenroll({ factorId });
      if (e) return authFailure(e);
      setNotice('disabled');
      return null;
    });
  };

  return (
    <Card className="block p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium text-muted-foreground">{t('title')}</p>
        {factors.isSuccess && (verified.length > 0 ? <Badge variant="success">{t('on')}</Badge> : <Badge variant="secondary">{t('off')}</Badge>)}
      </div>
      <p className="mt-2 text-sm text-muted-foreground">{t('intro')}</p>
      <div className="mt-4 space-y-3">
        {factors.isLoading && <Spinner />}
        {factors.error && <ErrorText>{authErrorText(failureOf(factors.error), root)}</ErrorText>}
        {enrollment ? (
          <form className="space-y-3" onSubmit={confirm}>
            <p className="text-sm text-muted-foreground">{t('scan')}</p>
            {/* The QR code draws black modules on a transparent background: it needs a light backdrop in both themes. */}
            <img src={enrollment.qrCode} alt={t('qrAlt')} className="h-44 w-44 rounded-lg bg-primary-foreground p-2" />
            <div className="text-xs text-subtle-foreground">
              {t('manualKey')}
              <code className="mt-1 block break-all font-mono text-sm text-foreground" aria-label={t('setupKey')}>
                {enrollment.secret}
              </code>
            </div>
            <Label className="flex-col items-stretch gap-1 font-normal">
              <span className="text-muted-foreground">{t('code')}</span>
              <Input
                {...fieldControl(codeId, { error: Boolean(error) })}
                required
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
                placeholder={t('codePlaceholder')}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              />
            </Label>
            <div className="flex gap-2">
              <Button type="submit" disabled={busy}>
                {t('confirm')}
              </Button>
              <Button type="button" variant="ghost" disabled={busy} onClick={() => void cancel()}>
                {root('common.cancel')}
              </Button>
            </div>
          </form>
        ) : factors.isSuccess && verified.length > 0 ? (
          verified.map((f) => (
            <ConfirmDialog
              key={f.id}
              render={<Button variant="destructive" />}
              disabled={busy}
              title={t('disableTitle')}
              description={t('disableDescription')}
              confirm={t('disableConfirm')}
              destructive
              onConfirm={() => disable(f.id)}
            >
              {t('disable')}
            </ConfirmDialog>
          ))
        ) : (
          factors.isSuccess && (
            <Button disabled={busy} onClick={() => void start()}>
              {busy ? <Spinner /> : null}
              {t('enable')}
            </Button>
          )
        )}
        {error && <ErrorText id={enrollment ? fieldErrorId(codeId) : undefined}>{authErrorText(error, root)}</ErrorText>}
        {notice && <Notice>{t(notice)}</Notice>}
      </div>
    </Card>
  );
}

// Shown when the kernel answers STEP_UP_REQUIRED (policy P11): approving and other R3 work need a second factor
// verified in the last 5 minutes. With a factor, the user enters a fresh code; without one, they enable it here
// (or, where `enroll` is false, in the two-factor card on the same page). Either way `onVerified` repeats the request
// that was refused, which `action` names; `onCancel` drops it.
export function StepUpPrompt({
  action,
  onVerified,
  onCancel,
  enroll = true,
}: {
  action: string;
  onVerified: () => void;
  onCancel?: () => void;
  enroll?: boolean;
}) {
  const root = useTranslations();
  const t = useTranslations('twoFactor.stepUp');
  const factors = useFactors();
  if (factors.isLoading) return <Spinner />;
  if (factors.error) return <ErrorText>{authErrorText(failureOf(factors.error), root)}</ErrorText>;
  const pending = <p className="text-sm text-muted-foreground">{t('pending', { action })}</p>;
  const cancel = onCancel && (
    <Button type="button" variant="ghost" onClick={onCancel}>
      {t('cancel')}
    </Button>
  );
  if ((factors.data?.totp.length ?? 0) > 0) {
    return (
      <Card className="block max-w-sm space-y-3 p-4">
        <p className="text-sm font-medium text-foreground">{t('title')}</p>
        <p className="text-sm text-muted-foreground">{t('recent')}</p>
        {pending}
        <MfaChallengeForm onVerified={onVerified} />
        {cancel}
      </Card>
    );
  }
  return (
    <div className="max-w-md space-y-3">
      <p className="text-sm text-muted-foreground">{enroll ? t('enrollHere') : t('enrollBeside')}</p>
      {pending}
      {enroll && <TwoFactorCard onEnabled={onVerified} />}
      {cancel}
    </div>
  );
}
