import './share-boot.ts';
import './zod-jitless.ts';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { useTranslations } from 'use-intl';
import { brandName, setBrandName } from './i18n/brand.ts';
import { I18nProvider } from './i18n/provider.tsx';
import { startLocaleSync } from './i18n/runtime.ts';
import { startThemeSync } from './lib/theme-runtime.ts';
import { queryClient } from './lib/api.ts';
import { forgetShare } from './lib/social-share.ts';
import { forgetPushDevice } from './lib/push.ts';
import { auth, loadConfig, settleCallback } from './lib/auth.ts';
import './styles.css';

const root = createRoot(document.getElementById('root') as HTMLElement);
startLocaleSync();
startThemeSync();

function ServerUnreachable() {
  const t = useTranslations('common');
  return <p className="p-8 text-sm text-destructive">{t('serverUnreachable')}</p>;
}

async function start() {
  try {
    // The product name (issue #1040) fills every message from the first render on; index.html says "Crove" until then.
    setBrandName((await loadConfig()).brandName);
    document.title = brandName();
  } catch {
    root.render(
      <I18nProvider>
        <ServerUnreachable />
      </I18nProvider>,
    );
    return;
  }
  await settleCallback();
  const { router } = await import('./router.tsx');
  auth().onAuthStateChange((event: string) => {
    if (event === 'SIGNED_OUT') {
      // Signed out here, in another tab or by expiry: a share waiting in this tab is not the next person's.
      forgetShare();
      // Nor are this browser's push notices (#1238); the session is gone, so only the browser's subscription ends.
      void forgetPushDevice();
      queryClient.clear();
      void router.navigate({ to: '/login' });
    }
  });
  root.render(
    <StrictMode>
      <I18nProvider>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </I18nProvider>
    </StrictMode>,
  );
}

void start();
