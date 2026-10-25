import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Outlet, useNavigate, useParams } from '@tanstack/react-router';
import { useTranslations } from 'use-intl';
import { NavIcon } from '@crove/ui/components/nav-icon';
import { ALL_NAV, NAV_GROUPS, NavDrawer, ShellNav, type NavItem } from '../components/app-nav.tsx';
import { CommandPalette, type PaletteEntry } from '../components/command-palette.tsx';
import { useChosenEntity } from '../components/entity-switcher.tsx';
import { Toaster } from '../components/toaster.tsx';
import { Logo, OrgLeftNotice } from '../components/ui.tsx';
import { LOCALE_NAMES, LOCALES } from '../i18n/locale.ts';
import { useFormat, useLocaleSetting } from '../i18n/provider.tsx';
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
import { useWorkNotifications } from './notifications.tsx';

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
  const groups = useMemo(
    () => NAV_GROUPS.map((g) => ({ id: g.id, items: installedItems<NavItem>(getConfig().modules, g.items) })).filter((g) => g.items.length > 0),
    [],
  );
  const [menuOpen, setMenuOpen] = useState(false);
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
  // The kernel's and finance's (#671).
  const work = useWorkNotifications();
  const workUnread = unreadLabel(work.data?.unread ?? 0);
  const org = me.data?.orgs.find((o) => o.slug === slug);
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
  // Documents and journal entries of the entity chosen in the shell (#1280), where the results link to.
  const entity = useChosenEntity();
  const found = useQuery({
    ...orpc.search.query.queryOptions({ input: { q: term ?? '', legalEntityId: entity.legalEntityId } }),
    enabled: entity.ready && term !== null && term === typed,
    staleTime: 30_000,
  });
  const searchState = typed === null ? 'idle' : found.isError ? 'failed' : term !== typed || !entity.ready || found.isFetching ? 'searching' : 'idle';
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

  const shellNav = (onNavigate?: () => void) => (
    <ShellNav
      slug={slug}
      groups={groups}
      badges={{ inbox: inboxCount > 0 ? inboxCount : null, alerts: workUnread, notifications: unread }}
      orgs={me.data?.orgs ?? []}
      email={me.data?.email}
      onOpenPalette={() => {
        onNavigate?.();
        setPaletteOpen(true);
      }}
      paletteKeys={paletteKeys}
      {...(onNavigate ? { onNavigate } : {})}
    />
  );

  return (
    <div className="flex min-h-full bg-background">
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r bg-sidebar px-3 py-4 md:flex">
        <div className="mb-6 px-2">
          <Logo />
        </div>
        {shellNav()}
      </aside>
      <div className="min-w-0 flex-1">
        {/* The phone's header (issue #1245): the menu button, the org's name and the palette; the rest is in the drawer. */}
        <header className="sticky top-0 z-10 flex items-center gap-2 border-b bg-sidebar px-3 py-2 md:hidden">
          <button
            type="button"
            onClick={() => setMenuOpen(true)}
            aria-label={t('openMenu')}
            className="relative grid size-11 place-items-center rounded-lg text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
          >
            <NavIcon name="menu" className="size-5" />
            {inboxCount > 0 && <span className="absolute top-2 right-2 size-2 rounded-full bg-primary" aria-hidden="true" />}
          </button>
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{org?.name ?? <Logo />}</span>
          <button type="button" onClick={() => setPaletteOpen(true)} className="min-h-11 rounded-lg border px-2 text-xs text-subtle-foreground">
            {tp('open')}
          </button>
        </header>
        <NavDrawer open={menuOpen} onOpenChange={setMenuOpen}>
          {shellNav(() => setMenuOpen(false))}
        </NavDrawer>
        <main className="mx-auto w-full max-w-6xl px-4 py-6 md:px-8 md:py-8">
          <OrgLeftNotice />
          {me.isSuccess && !org ? <p className="text-sm text-destructive">{t('notMember')}</p> : <Outlet />}
        </main>
        <Toaster />
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
