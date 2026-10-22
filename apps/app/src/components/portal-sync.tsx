import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { PORTAL_CAPTCHA_MAX, PORTAL_PASSWORD_MAX, type PortalCaptchaView } from '@crove/kernel-contract';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Checkbox } from '@crove/ui/components/checkbox';
import { Input } from '@crove/ui/components/input';
import { Label } from '@crove/ui/components/label';
import { ErrorText, Spinner } from './ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { client, errorMessage } from '../lib/api.ts';
import { needsNewCaptcha, runPortalSync, type SyncProgress } from '../lib/portal-sync.ts';

type Phase = 'form' | 'working' | 'done';

// Downloads settled so far: fetched, already in Crove, or not on the portal.
const settled = (p: SyncProgress | null) => (p ? p.downloaded + p.duplicates + p.failed : 0);

// "Lấy danh sách từ cổng thuế" (issue #325): the accountant types the client's portal password and the CAPTCHA the
// portal shows, and Crove fetches the period's purchase list and invoice XML. The password lives in this form's state
// until the login request and is cleared right after it; the portal session the kernel answers is kept in a ref for
// this one sync and dropped when it ends or the panel closes.
export function PortalSyncPanel({ period, periodLabel, onChanged, onClose }: { period: string; periodLabel: string; onChanged: () => void; onClose: () => void }) {
  const t = useTranslations('portalList.sync');
  const f = useFormat();
  const [captcha, setCaptcha] = useState<PortalCaptchaView | null>(null);
  const [loadingCaptcha, setLoadingCaptcha] = useState(false);
  const [password, setPassword] = useState('');
  const [answer, setAnswer] = useState('');
  const [consent, setConsent] = useState(false);
  const [phase, setPhase] = useState<Phase>('form');
  const [step, setStep] = useState<'login' | 'list' | 'xml'>('login');
  const [progress, setProgress] = useState<SyncProgress | null>(null);
  const [error, setError] = useState<unknown>(null);
  const session = useRef<string | null>(null);

  const loadCaptcha = async () => {
    setLoadingCaptcha(true);
    setAnswer('');
    try {
      setCaptcha(await client.portalSync.captcha({ period }));
    } catch (e) {
      setCaptcha(null);
      setError(e);
    } finally {
      setLoadingCaptcha(false);
    }
  };

  useEffect(() => {
    void loadCaptcha();
    return () => {
      session.current = null;
    };
    // A new period starts over with a CAPTCHA of its own.
  }, [period]);

  const submit = async () => {
    if (!captcha) return;
    setError(null);
    setPhase('working');
    setStep('login');
    const typed = password;
    setPassword('');
    try {
      const login = await client.portalSync.login({ period, challenge: captcha.challenge, captcha: answer, password: typed, consent: true });
      session.current = login.session;
    } catch (e) {
      setError(e);
      setPhase('form');
      if (needsNewCaptcha((e as { code?: string } | null)?.code)) void loadCaptcha();
      return;
    }
    try {
      setStep('list');
      const result = await runPortalSync(
        {
          fetchList: () => client.portalSync.fetchList({ period, session: session.current ?? '' }),
          fetchXml: (listId) => client.portalSync.fetchXml({ period, session: session.current ?? '', listId }),
        },
        (p) => {
          setProgress(p);
          if (p.phase === 'xml') setStep('xml');
          onChanged();
        },
      );
      setProgress(result);
    } catch (e) {
      setError(e);
    } finally {
      session.current = null;
      setCaptcha(null);
      setPhase('done');
      onChanged();
    }
  };

  return (
    <Card className="block p-4" role="region" aria-label={t('title')}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold text-foreground">{t('title')}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t('intro', { period: periodLabel })}</p>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose} disabled={phase === 'working'}>
          {t('close')}
        </Button>
      </div>

      {phase === 'form' && (
        <form
          className="mt-4 space-y-3"
          autoComplete="off"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="portal-sync-username" className="text-xs">
                {t('username')}
              </Label>
              <Input id="portal-sync-username" value={captcha?.username ?? ''} readOnly autoComplete="off" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="portal-sync-password" className="text-xs">
                {t('password')}
              </Label>
              <Input
                id="portal-sync-password"
                name="portal-sync-secret"
                type="password"
                autoComplete="off"
                data-1p-ignore
                data-lpignore="true"
                maxLength={PORTAL_PASSWORD_MAX}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="portal-sync-captcha" className="text-xs">
              {t('captcha')}
            </Label>
            <div className="flex flex-wrap items-center gap-3">
              {captcha ? (
                <img src={captcha.image} alt={t('captchaImage')} className="h-12 rounded border border-border bg-image-surface px-2" />
              ) : loadingCaptcha ? (
                <Spinner />
              ) : null}
              <Button type="button" variant="outline" size="sm" onClick={() => void loadCaptcha()} disabled={loadingCaptcha}>
                {t('newCaptcha')}
              </Button>
              <Input id="portal-sync-captcha" className="w-40" autoComplete="off" maxLength={PORTAL_CAPTCHA_MAX} value={answer} onChange={(e) => setAnswer(e.target.value)} />
            </div>
            <p className="text-xs text-subtle-foreground">{t('captchaHint')}</p>
          </div>
          <label className="flex items-start gap-2 text-sm text-foreground">
            <Checkbox className="mt-0.5" checked={consent} onCheckedChange={(on) => setConsent(on === true)} aria-label={t('consent')} />
            <span>{t('consent')}</span>
          </label>
          <p className="text-xs text-subtle-foreground">{t('privacy')}</p>
          {Boolean(error) && <ErrorText>{errorMessage(error)}</ErrorText>}
          <Button type="submit" disabled={!captcha || !password || !answer.trim() || !consent}>
            {t('start')}
          </Button>
        </form>
      )}

      {phase === 'working' && (
        <div className="mt-4 flex items-center gap-2 text-sm text-foreground" role="status">
          <Spinner className="text-current" />
          <span>
            {step === 'login'
              ? t('steps.login')
              : step === 'list'
                ? t('steps.list')
                : t('steps.xml', { done: f.number(settled(progress)), total: f.number(settled(progress) + (progress?.remaining ?? 0)) })}
          </span>
          <span className="text-xs text-subtle-foreground">{t('keepOpen')}</span>
        </div>
      )}

      {phase === 'done' && (
        <div className="mt-4 space-y-2" role="status">
          {progress && (
            <>
              <p className="text-sm text-foreground">{progress.unchanged ? t('result.unchanged') : t('result.list', { count: progress.rows })}</p>
              {progress.skipped > 0 && <p className="text-sm text-warning">{t('result.skipped', { count: progress.skipped })}</p>}
              {progress.listPending ? (
                <p className="text-sm text-muted-foreground">{t('result.listPending')}</p>
              ) : settled(progress) > 0 ? (
                <p className="text-sm text-foreground">{t('result.xml', { downloaded: progress.downloaded, duplicates: progress.duplicates, failed: progress.failed })}</p>
              ) : (
                <p className="text-sm text-muted-foreground">{t('result.noXml')}</p>
              )}
              {progress.remaining > 0 && <p className="text-sm text-muted-foreground">{t('result.remaining', { count: progress.remaining })}</p>}
            </>
          )}
          {Boolean(error) && <ErrorText>{errorMessage(error)}</ErrorText>}
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setError(null);
              setProgress(null);
              setConsent(false);
              setPhase('form');
              void loadCaptcha();
            }}
          >
            {t('again')}
          </Button>
        </div>
      )}
    </Card>
  );
}
