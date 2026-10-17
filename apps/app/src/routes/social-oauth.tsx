// Where a provider's OAuth dialog sends the browser back (/channels/oauth/:provider/callback). The code and state are
// taken out of the address bar at once, then the attempt is finished for the org it was started in.
import { useMutation } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { Card } from '@crove/ui/components/card';
import { ErrorText, Spinner } from '../components/ui.tsx';
import { client, errorMessage, queryClient, setCurrentOrg } from '../lib/api.ts';
import { takeOAuthAttempt } from '../lib/oauth.ts';
import { providerName } from '../lib/social.ts';

type Callback = { kind: 'finish'; slug: string; state: string; code: string } | { kind: 'cancelled'; slug: string | null } | { kind: 'lost' };

// Read once per page load: the address bar is cleaned right after, so a reload never replays the code.
function readCallback(): Callback {
  const params = new URLSearchParams(window.location.search);
  window.history.replaceState(null, '', window.location.pathname);
  const state = params.get('state') ?? '';
  const slug = state ? takeOAuthAttempt(state) : null;
  if (params.get('error')) return { kind: 'cancelled', slug };
  const code = params.get('code');
  if (!slug || !code) return { kind: 'lost' };
  return { kind: 'finish', slug, state, code };
}

export function OAuthCallbackPage() {
  const { provider } = useParams({ strict: false }) as { provider: string };
  const t = useTranslations('social');
  // Read in an effect, not during render: reading takes the entry out of sessionStorage and cleans the address bar.
  // The ref keeps the first read when Strict Mode runs the effect twice.
  const read = useRef<Callback | null>(null);
  const [callback, setCallback] = useState<Callback | null>(null);
  useEffect(() => {
    read.current ??= readCallback();
    setCallback(read.current);
  }, []);
  const started = useRef(false);
  const finish = useMutation({
    mutationFn: (c: Extract<Callback, { kind: 'finish' }>) => {
      setCurrentOrg(c.slug);
      // The oauth providers are a fixed list in the contract; the server refuses any other.
      return client.channels.oauthFinish({ provider: provider as 'facebook_page', state: c.state, code: c.code });
    },
    onSuccess: () => void queryClient.invalidateQueries(),
  });
  useEffect(() => {
    if (callback?.kind !== 'finish' || started.current) return;
    started.current = true;
    finish.mutate(callback);
  }, [callback, finish]);

  const slug = !callback || callback.kind === 'lost' ? null : callback.slug;
  // Waiting for the first read or for the server.
  const busy = !callback || (callback.kind === 'finish' && (finish.isPending || finish.isIdle));
  const back = slug ? (
    <Link to="/o/$slug/social/channels" params={{ slug }} className="text-sm font-medium text-primary hover:underline">
      {t('backToChannels')}
    </Link>
  ) : (
    <Link to="/" className="text-sm font-medium text-primary hover:underline">
      {t('backToChannels')}
    </Link>
  );

  return (
    <main className="flex min-h-full items-center justify-center bg-background px-4">
      <Card className="block w-full max-w-md space-y-4 p-6">
        <h1 className="text-lg font-semibold text-foreground">
          {t('oauthTitle')}: {providerName(provider)}
        </h1>
        {callback?.kind === 'cancelled' && <p className="text-sm text-muted-foreground">{t('oauthCancelled')}</p>}
        {callback?.kind === 'lost' && <ErrorText>{t('oauthLost')}</ErrorText>}
        {busy && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner /> {t('oauthFinishing')}
          </div>
        )}
        {finish.data && <p className="text-sm text-foreground">{t('oauthConnected', { list: finish.data.connections.map((c) => c.displayName).join(', ') })}</p>}
        {finish.error && <ErrorText>{errorMessage(finish.error)}</ErrorText>}
        {!busy && back}
      </Card>
    </main>
  );
}
