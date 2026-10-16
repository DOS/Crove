import { useQuery } from '@tanstack/react-query';
import { Link, Outlet, useNavigate, useParams } from '@tanstack/react-router';
import { useTranslations } from 'use-intl';
import { Logo, cx } from '../components/ui.tsx';
import { LocaleSwitcher } from '../i18n/provider.tsx';
import { orpc } from '../lib/api.ts';
import { getConfig } from '../lib/auth.ts';
import { installedItems } from '../lib/modules.ts';
import { signOut } from '../lib/session-actions.ts';

// Each item belongs to a module; the menu shows only the modules this deployment runs (CROVE_MODULES).
const ALL_NAV = [
  { to: '/o/$slug/inbox', label: 'inbox', module: 'kernel' },
  { to: '/o/$slug/documents', label: 'documents', module: 'finance' },
  { to: '/o/$slug/vendors', label: 'vendors', module: 'finance' },
  { to: '/o/$slug/journal', label: 'journal', module: 'finance' },
  { to: '/o/$slug/settings', label: 'settings', module: 'kernel' },
] as const;

export function OrgLayout() {
  const NAV = installedItems(getConfig().modules, ALL_NAV);
  const { slug } = useParams({ strict: false }) as { slug: string };
  const navigate = useNavigate();
  const t = useTranslations('nav');
  const tc = useTranslations('common');
  const me = useQuery(orpc.me.get.queryOptions());
  const pending = useQuery({ ...orpc.inbox.list.queryOptions({ input: { status: 'pending' } }), refetchInterval: 30_000 });
  const org = me.data?.orgs.find((o) => o.slug === slug);

  return (
    <div className="flex min-h-full bg-canvas">
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-line bg-surface px-3 py-4 md:flex">
        <div className="px-2">
          <Logo />
        </div>
        <label className="mt-6 block px-2 text-xs text-fg-3">
          {t('org')}
          <select
            className="mt-1 w-full rounded-lg border border-line bg-surface-2 px-2 py-1.5 text-sm text-fg"
            value={slug}
            onChange={(e) => void navigate({ to: '/o/$slug/inbox', params: { slug: e.target.value } })}
          >
            {me.data?.orgs.map((o) => (
              <option key={o.orgId} value={o.slug}>
                {o.name}
              </option>
            ))}
          </select>
        </label>
        <nav className="mt-6 flex flex-col gap-0.5">
          {NAV.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              params={{ slug }}
              className="flex items-center justify-between rounded-lg px-3 py-2 text-sm text-fg-2 hover:bg-surface-2 hover:text-fg"
              activeProps={{ className: 'bg-brand-600/15 !text-fg' }}
            >
              {t(item.label)}
              {item.to === '/o/$slug/inbox' && (pending.data?.length ?? 0) > 0 && (
                <span className="rounded-full bg-brand-600 px-1.5 text-xs text-white">{pending.data?.length}</span>
              )}
            </Link>
          ))}
        </nav>
        <div className="mt-auto border-t border-line px-2 pt-3 text-xs text-fg-3">
          <p className="truncate">{me.data?.email}</p>
          <div className="mt-1 flex items-center justify-between gap-2">
            <button className="hover:text-fg-2" onClick={() => void signOut()}>
              {tc('signOut')}
            </button>
            <LocaleSwitcher />
          </div>
        </div>
      </aside>
      <div className="min-w-0 flex-1">
        <header className="flex items-center justify-between border-b border-line bg-surface px-4 py-3 md:hidden">
          <Logo />
          <LocaleSwitcher />
          <select
            className="rounded-lg border border-line bg-surface-2 px-2 py-1 text-sm text-fg"
            value={NAV.find((n) => window.location.pathname.endsWith(n.to.split('/').pop() ?? ''))?.to ?? '/o/$slug/inbox'}
            onChange={(e) => void navigate({ to: e.target.value as (typeof ALL_NAV)[number]['to'], params: { slug } })}
          >
            {NAV.map((n) => (
              <option key={n.to} value={n.to}>
                {t(n.label)}
              </option>
            ))}
          </select>
        </header>
        <main className={cx('mx-auto w-full max-w-6xl px-4 py-6 md:px-8 md:py-8')}>
          {me.isSuccess && !org ? <p className="text-sm text-rose-300">{t('notMember')}</p> : <Outlet />}
        </main>
      </div>
    </div>
  );
}
