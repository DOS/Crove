import { useEffect, useId, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, Outlet, useNavigate, useParams } from '@tanstack/react-router';
import { useTranslations } from 'use-intl';
import { Label } from '@crove/ui/components/label';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { CommandPalette, type PaletteEntry } from '../components/command-palette.tsx';
import { ThemeSwitcher } from '../components/theme-switcher.tsx';
import { StatusLink } from '../components/status-link.tsx';
import { SupportLink } from '../components/support-link.tsx';
import { Logo, OrgLeftNotice } from '../components/ui.tsx';
import { LOCALE_NAMES, LOCALES } from '../i18n/locale.ts';
import { LocaleSwitcher, useFormat, useLocaleSetting } from '../i18n/provider.tsx';
import { orpc } from '../lib/api.ts';
import { getConfig } from '../lib/auth.ts';
import { installedItems } from '../lib/modules.ts';
import { isPaletteShortcut, searchTerm } from '../lib/palette.ts';
import { documentNumber } from '../lib/search.ts';
import { proposalName } from '../lib/review.ts';
import { THEMES } from '../lib/theme.ts';
import { useThemeSetting } from '../lib/theme-runtime.ts';
import { signOut } from '../lib/session-actions.ts';
import { SAFETY_POLL_MS, pollEvery, useInvalidationStream, useStreamLive } from '../lib/stream-hook.ts';
import { unreadLabel } from '../lib/social-notifications.ts';
import { useNotifications } from './social-notifications.tsx';

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
  { to: '/o/$slug/social/notifications', label: 'notifications', module: 'social' },
  { to: '/o/$slug/settings', label: 'settings', module: 'kernel' },
] as const;

// The value, once it has stayed the same for `ms`: the palette's search (#673) waits for a pause in the typing.
function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

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
  // Social posts waiting for the viewer's review (#749) count toward the inbox, where Social runs.
  const socialOn = NAV.some((n) => n.module === 'social');
  const reviews = useQuery({ ...orpc.social.reviewInbox.queryOptions({ input: {} }), enabled: socialOn, refetchInterval: pollEvery(live, 30_000, SAFETY_POLL_MS) });
  // And what needs a person there (#771): channels to reconnect, posts that did not go out.
  const attention = useQuery({ ...orpc.social.attentionInbox.queryOptions({ input: {} }), enabled: socialOn, refetchInterval: pollEvery(live, 30_000, SAFETY_POLL_MS) });
  const inboxCount = (pending.data?.length ?? 0) + (reviews.data?.total ?? 0) + (attention.data?.total ?? 0);
  // The member's unread notifications (#637), where Social runs.
  const notifications = useNotifications(NAV.some((n) => n.module === 'social'));
  const unread = unreadLabel(notifications.data?.unread ?? 0);
  const org = me.data?.orgs.find((o) => o.slug === slug);
  const orgSelectId = useId();
  const tp = useTranslations('palette');
  const f = useFormat();
  const { locale, setLocale } = useLocaleSetting();
  const [theme, setTheme] = useThemeSetting();
  const [paletteOpen, setPaletteOpen] = useState(false);
  // The org's search (#673): parties, documents and journal entries for what is typed in the palette, where finance runs.
  const financeOn = NAV.some((n) => n.module === 'finance');
  const [paletteQuery, setPaletteQuery] = useState('');
  const typed = financeOn && paletteOpen ? searchTerm(paletteQuery) : null;
  const term = useSettled(typed, 250);
  const found = useQuery({ ...orpc.search.query.queryOptions({ input: { q: term ?? '' } }), enabled: term !== null && term === typed, staleTime: 30_000 });
  const searchState = typed === null ? 'idle' : found.isError ? 'failed' : term !== typed || found.isFetching ? 'searching' : 'idle';
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
      ...(reviews.data?.items ?? []).map((item) => ({
        id: `social-review:${item.postId}`,
        group: 'proposals' as const,
        label: item.title || item.excerpt,
        detail: item.channels.map((c) => c.displayName).join(', '),
        run: () => void navigate({ to: '/o/$slug/social/$id', params: { slug, id: item.postId } }),
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
    [NAV, pending.data, reviews.data, me.data, slug, locale, theme, t, tp, tc, f, navigate, setLocale, setTheme],
  );
  const foundEntries = useMemo<PaletteEntry[]>(() => {
    const data = typed !== null && term === typed ? found.data : undefined;
    if (!data) return [];
    return [
      ...data.parties.map((p) => ({
        id: `party:${p.id}`,
        group: 'parties' as const,
        label: p.name,
        ...(p.taxCode ? { detail: tp('taxCode', { code: p.taxCode }) } : {}),
        // A customer that never sold to the org is not among the vendors: its invoices are with the documents.
        run: () =>
          void (p.customerOnly
            ? navigate({ to: '/o/$slug/documents', params: { slug }, search: { q: p.name } })
            : navigate({ to: '/o/$slug/vendors', params: { slug }, search: { q: p.taxCode ?? p.name } })),
      })),
      ...data.documents.map((d) => ({
        id: `document:${d.id}`,
        group: 'documents' as const,
        label: documentNumber(d),
        detail: [
          d.direction === 'sale' ? tp('saleDocument') : null,
          d.voided ? tp('voidedDocument') : null,
          tp('documentDetail', { party: d.partyName, date: f.date(d.issueDate), total: f.money(d.total) }),
        ]
          .filter(Boolean)
          .join(', '),
        // The approved proposal shows the invoice with its file; a document without one opens in the list.
        run: () =>
          void (d.proposalId
            ? navigate({ to: '/o/$slug/inbox/$id', params: { slug, id: d.proposalId } })
            : navigate({ to: '/o/$slug/documents', params: { slug }, search: { q: d.number } })),
      })),
      ...data.entries.map((e) => ({
        id: `entry:${e.id}`,
        group: 'entries' as const,
        label: e.description,
        detail: tp('entryDetail', { date: f.date(e.entryDate), amount: f.money(e.amount) }),
        run: () => void navigate({ to: '/o/$slug/journal', params: { slug }, search: { from: e.entryDate, to: e.entryDate }, hash: `entry-${e.id}` }),
      })),
    ];
  }, [found.data, typed, term, slug, tp, f, navigate]);

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
          {/* A firm adds its next client company from here (issue #324). */}
          <Link to="/onboarding" className="mt-1 inline-block text-xs text-link">
            {t('addOrg')}
          </Link>
        </div>
        <button
          type="button"
          onClick={() => setPaletteOpen(true)}
          className="mt-4 flex items-center justify-between gap-1.5 rounded-lg border bg-background px-2.5 py-1.5 text-left text-sm text-subtle-foreground hover:text-foreground"
        >
          <span className="min-w-0 truncate">{tp('open')}</span>
          <kbd className="shrink-0 rounded-sm border px-1 font-mono text-[11px] whitespace-nowrap">{paletteKeys}</kbd>
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
              {item.to === '/o/$slug/inbox' && inboxCount > 0 && (
                <span className="rounded-full bg-primary px-1.5 text-xs text-primary-foreground">{inboxCount}</span>
              )}
              {item.to === '/o/$slug/social/notifications' && unread && <span className="rounded-full bg-primary px-1.5 text-xs text-primary-foreground">{unread}</span>}
            </Link>
          ))}
        </nav>
        <div className="mt-3 shrink-0 border-t px-2 pt-3 text-xs text-subtle-foreground">
          <SupportLink className="mb-2 block text-sm text-link" />
          <StatusLink className="mb-2 block text-sm text-link" />
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
            // The item whose path is the longest start of the current one (Social and its notifications share a start).
            value={NAV.filter((n) => window.location.pathname.startsWith(n.to.replace('$slug', slug))).sort((a, b) => b.to.length - a.to.length)[0]?.to ?? '/o/$slug/inbox'}
            onChange={(e) => void navigate({ to: e.target.value as (typeof ALL_NAV)[number]['to'], params: { slug } })}
          >
            {NAV.map((n) => (
              <NativeSelectOption key={n.to} value={n.to}>
                {t(n.label)}
                {n.to === '/o/$slug/social/notifications' && unread ? ` (${unread})` : ''}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </header>
        <main className="mx-auto w-full max-w-6xl px-4 py-6 md:px-8 md:py-8">
          <OrgLeftNotice />
          {me.isSuccess && !org ? <p className="text-sm text-destructive">{t('notMember')}</p> : <Outlet />}
        </main>
        <CommandPalette
          entries={paletteEntries}
          found={foundEntries}
          search={searchState}
          onQueryChange={setPaletteQuery}
          open={paletteOpen}
          onOpenChange={setPaletteOpen}
        />
      </div>
    </div>
  );
}
