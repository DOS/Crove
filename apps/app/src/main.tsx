import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from './i18n/provider.tsx';
import { activeLocale, translator } from './i18n/runtime.ts';
import { queryClient } from './lib/api.ts';
import { auth, loadConfig } from './lib/auth.ts';
import './styles.css';

const root = createRoot(document.getElementById('root') as HTMLElement);
document.documentElement.lang = activeLocale();

async function start() {
  try {
    await loadConfig();
  } catch {
    root.render(<p className="p-8 text-sm text-rose-300">{translator()('common.serverUnreachable')}</p>);
    return;
  }
  const { router } = await import('./router.tsx');
  auth().onAuthStateChange((event: string) => {
    if (event === 'SIGNED_OUT') {
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
