import { useEffect, useId, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, Outlet, useNavigate, useParams } from '@tanstack/react-router';
import { useTranslations } from 'use-intl';
import { Label } from '@crove/ui/components/label';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { CommandPalette, type PaletteEntry } from '../components/command-palette.tsx';
import { ThemeSwitcher } from '../components/theme-switcher.tsx';
import { SupportLink } from '../components/support-link.tsx';
import { Logo, OrgLeftNotice } from '../components/ui.tsx';
import { LOCALE_NAMES, LOCALES } from '../i18n/locale.ts';
import { LocaleSwitcher, useFormat, useLocaleSetting } from '../i18n/provider.tsx';
import { orpc } from '../lib/api.ts';
import { getConfig } from '../lib/auth.ts';
import { installedItems } from '../lib/modules.ts';
import { isPaletteShortcut } from '../lib/palette.ts';
import { proposalName } from '../lib/review.ts';
import { THEMES } from '../lib/theme.ts';
import { useThemeSetting } from '../lib/theme-runtime.ts';
import { signOut } from '../lib/session-actions.ts';
import { SAFETY_POLL_MS, pollEvery, useInvalidationStream, useStreamLive } from '../lib/stream-hook.ts';

// Each item belongs to a module; the menu shows only the modules this deployment runs (CROVE_MODULES).
const ALL_NAV = [
  { to: '/o/$slug/inbox', label: 'inbox', module: 'kernel' },
  { to: '/o/$slug/documents', label: 'documents', module: 'finance' },
  { to: '/o/$slug/vendors', label: 'vendors', module: 'finance' },
  { to: '/o/$slug/journal', label: 'journal', module: 'finance' },
  { to: '/o/$slug/vouchers', label: 'vouchers', module: 'finance' },
  { to: '/o/$slug/vat', label: 'vat', module: 'finance' },
  { to: '/o/$slug/portal-invoices', label: 'portalList', module: 'finance' },
  { to: '/o/$slug/ledger', label: 'ledger', module: 'finance' },
  { to: '/o/$slug/bank', label: 'bank', module: 'finance' },
  { to: '/o/$slug/agents', label: 'agents', module: 'kernel' },
  { to: '/o/$slug/tasks', label: 'tasks', module: 'kernel' },
  { to: '/o/$slug/social', label: 'social', module: 'social' },
  { to: '/o/$slug/settings', label: 'settings', module: 'kernel' },
] as const;

export function OrgLayout() {
  const NAV = useMemo(() => installedItems(getConfig().modules, ALL_NAV), []);
  const { slug } = useParams({ strict: false }) as { slug: string };
  const navigate = useNavigate();
  const t = useTranslations('nav');
  const tc = useTranslations('common');
  const me = useQuery(orpc.me.get.queryOptions());
  // Hints of this org's changes (issue #69); the counts below poll only while the stream is down.
  useInvalidationStream(slug);
  const live = useStreamLive();
  const pending = useQuery({
    ...orpc.inbox.list.queryOptions({ input: { status: 'pending' } }),
    refetchInterval: pollEvery(live, 30_000, SAFETY_POLL_MS),
  });
  const org = me.data?.orgs.find((o) => o.slug === slug);
  const orgSelectId = useId();
  const tp = useTranslations('palette');
  const f = useFormat();
  const { locale, setLocale } = useLocaleSetting();
  const [theme, setTheme] = useThemeSetting();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const paletteKeys = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.userAgent) ? '⌘ K' : 'Ctrl K';

  // Ctrl K (Cmd K on a Mac) opens or closes the command palette from any screen of the org.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isPaletteShortcut(event)) return;
      event.preventDefault();
      setPaletteOpen((open) => !open);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const paletteEntries = useMemo<PaletteEntry[]>(
    () => [
      ...NAV.map((item) => ({
        id: `go:${item.to}`,
        group: 'go' as const,
        label: t(item.label),
        run: () => void navigate({ to: item.to, params: { slug } }),
      })),
      ...(pending.data ?? []).map((item) => ({
        id: `proposal:${item.id}`,
        group: 'proposals' as const,
        label: proposalName(item),
        detail: `${item.title}, ${f.money(item.total)}`,
        run: () => void navigate({ to: '/o/$slug/inbox/$id', params: { slug, id: item.id } }),
      })),
      ...(me.data?.orgs ?? [])
        .filter((o) => o.slug !== slug)
        .map((o) => ({
          id: `org:${o.slug}`,
          group: 'orgs' as const,
          label: tp('switchOrg', { name: o.name }),
          run: () => void navigate({ to: '/o/$slug/inbox', params: { slug: o.slug } }),
        })),
      ...LOCALES.filter((l) => l !== locale).map((l) => ({
        id: `locale:${l}`,
        group: 'actions' as const,
        label: tp('switchLocale', { name: LOCALE_NAMES[l] }),
        keywords: 'language ngon ngu',
        run: () => setLocale(l),
      })),
      ...THEMES.filter((th) => th !== theme).map((th) => ({
        id: `theme:${th}`,
        group: 'actions' as const,
        label: tp('switchTheme', { name: tc(`themes.${th}`) }),
        keywords: 'theme giao dien sang toi dark light',
        run: () => setTheme(th),
      })),
      { id: 'sign-out', group: 'actions' as const, label: tc('signOut'), run: () => void signOut() },
    ],
    [NAV, pending.data, me.data, slug, locale, theme, t, tp, tc, f, navigate, setLocale, setTheme],
  );

  return (
    <div className="flex min-h-full bg-background">
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r bg-sidebar px-3 py-4 md:flex">
        <div className="px-2">
          <Logo />
        </div>
        <div className="mt-6 px-2">
          {(me.data?.orgs.length ?? 0) > 1 && (
            <Link to="/clients" className="mb-3 block text-sm text-link hover:underline">
              {t('allClients')}
            </Link>
          )}
          <Label htmlFor={orgSelectId} className="text-xs font-normal text-subtle-foreground">
            {t('org')}
          </Label>
          <NativeSelect
            id={orgSelectId}
            className="mt-1 w-full"
            value={slug}
            onChange={(e) => void navigate({ to: '/o/$slug/inbox', params: { slug: e.target.value } })}
          >
            {me.data?.orgs.map((o) => (
              <NativeSelectOption key={o.orgId} value={o.slug}>
                {o.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <button
          type="button"
          onClick={() => setPaletteOpen(true)}
          className="mx-2 mt-4 flex items-center justify-between gap-2 rounded-lg border bg-background px-3 py-1.5 text-left text-sm text-subtle-foreground hover:text-foreground"
        >
          {tp('open')}
          <kbd className="rounded-sm border px-1 font-mono text-[11px]">{paletteKeys}</kbd>
        </button>
        {/* The menu scrolls on a short window, so the account footer below it always stays on screen. */}
        <nav className="mt-4 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
          {NAV.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              params={{ slug }}
              className="flex items-center justify-between rounded-lg px-3 py-2 text-sm text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
              activeProps={{ className: 'bg-primary/15 !text-foreground' }}
            >
              {t(item.label)}
              {item.to === '/o/$slug/inbox' && (pending.data?.length ?? 0) > 0 && (
                <span className="rounded-full bg-primary px-1.5 text-xs text-primary-foreground">{pending.data?.length}</span>
              )}
            </Link>
          ))}
        </nav>
        <div className="mt-3 shrink-0 border-t px-2 pt-3 text-xs text-subtle-foreground">
          <SupportLink className="mb-2 block text-sm text-link" />
          <p className="truncate">{me.data?.email}</p>
          <div className="mt-1 flex items-center justify-between gap-2">
            <button className="hover:text-muted-foreground" onClick={() => void signOut()}>
              {tc('signOut')}
            </button>
            <LocaleSwitcher />
          </div>
          {/* Its own row: next to the language switch both labels were cut off at the sidebar's width. */}
          <ThemeSwitcher className="mt-2 w-full text-muted-foreground" />
        </div>
      </aside>
      <div className="min-w-0 flex-1">
        <header className="flex flex-wrap items-center justify-between gap-2 border-b bg-sidebar px-4 py-3 md:hidden">
          <Logo />
          {(me.data?.orgs.length ?? 0) > 1 && (
            <Link to="/clients" className="text-xs text-link">
              {t('allClients')}
            </Link>
          )}
          <button type="button" onClick={() => setPaletteOpen(true)} className="rounded-lg border px-2 py-1 text-xs text-subtle-foreground">
            {tp('open')}
          </button>
          <SupportLink className="text-xs text-link" />
          <LocaleSwitcher />
          <ThemeSwitcher />
          <NativeSelect
            size="sm"
            value={NAV.find((n) => window.location.pathname.split('/')[3] === n.to.split('/').pop())?.to ?? '/o/$slug/inbox'}
            onChange={(e) => void navigate({ to: e.target.value as (typeof ALL_NAV)[number]['to'], params: { slug } })}
          >
            {NAV.map((n) => (
              <NativeSelectOption key={n.to} value={n.to}>
                {t(n.label)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </header>
        <main className="mx-auto w-full max-w-6xl px-4 py-6 md:px-8 md:py-8">
          <OrgLeftNotice />
          {me.isSuccess && !org ? <p className="text-sm text-destructive">{t('notMember')}</p> : <Outlet />}
        </main>
        <CommandPalette entries={paletteEntries} open={paletteOpen} onOpenChange={setPaletteOpen} />
      </div>
    </div>
  );
}
