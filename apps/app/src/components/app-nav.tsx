import { useEffect, useId, useRef, type ReactNode } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useTranslations } from 'use-intl';
import { Label } from '@crove/ui/components/label';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { NavIcon } from '@crove/ui/components/nav-icon';
import { LocaleSwitcher } from '../i18n/provider.tsx';
import { signOut } from '../lib/session-actions.ts';
import { StatusLink } from './status-link.tsx';
import { SupportLink } from './support-link.tsx';
import { EntitySwitcher } from './entity-switcher.tsx';
import { ThemeSwitcher } from './theme-switcher.tsx';
import { Logo } from './ui.tsx';

// The org menu (issue #1245), in groups a bookkeeper reads top to bottom: what waits for them, the books, tax, the
// parties, Social, then the org itself. Each item belongs to a module; the shell shows only the modules this deployment
// runs (CROVE_MODULES, ADR-0031), and a group whose items are all missing is left out.
export const NAV_GROUPS = [
  {
    id: 'work',
    items: [
      // What waits for the user in this org today (#1249).
      { to: '/o/$slug/overview', label: 'overview', module: 'kernel' },
      { to: '/o/$slug/inbox', label: 'inbox', module: 'kernel' },
      // In-app notifications of the kernel and finance (#671), with the unread count.
      { to: '/o/$slug/notifications', label: 'alerts', module: 'kernel' },
      { to: '/o/$slug/tasks', label: 'tasks', module: 'kernel' },
      // Bookings of the public booking page (#1320).
      { to: '/o/$slug/bookings', label: 'bookings', module: 'crm' },
    ],
  },
  {
    id: 'accounting',
    items: [
      { to: '/o/$slug/documents', label: 'documents', module: 'finance' },
      { to: '/o/$slug/journal', label: 'journal', module: 'finance' },
      { to: '/o/$slug/vouchers', label: 'vouchers', module: 'finance' },
      { to: '/o/$slug/bank', label: 'bank', module: 'finance' },
      { to: '/o/$slug/fixed-assets', label: 'fixedAssets', module: 'finance' },
      { to: '/o/$slug/ledger', label: 'ledger', module: 'finance' },
    ],
  },
  {
    id: 'tax',
    items: [
      { to: '/o/$slug/vat', label: 'vat', module: 'finance' },
      { to: '/o/$slug/portal-invoices', label: 'portalList', module: 'finance' },
    ],
  },
  {
    id: 'parties',
    items: [
      { to: '/o/$slug/customers', label: 'customers', module: 'finance' },
      { to: '/o/$slug/vendors', label: 'vendors', module: 'finance' },
    ],
  },
  {
    id: 'social',
    items: [
      { to: '/o/$slug/social', label: 'social', module: 'social' },
      { to: '/o/$slug/social/notifications', label: 'notifications', module: 'social' },
    ],
  },
  {
    id: 'admin',
    items: [
      { to: '/o/$slug/agents', label: 'agents', module: 'kernel' },
      { to: '/o/$slug/settings', label: 'settings', module: 'kernel' },
    ],
  },
] as const;

export type NavItem = (typeof NAV_GROUPS)[number]['items'][number];
export type NavLabel = NavItem['label'];
export type NavGroupId = (typeof NAV_GROUPS)[number]['id'];
export const ALL_NAV: readonly NavItem[] = NAV_GROUPS.flatMap((g): readonly NavItem[] => g.items);

// Shorter or clearer names inside the menu: the work notifications fit the sidebar's width next to their count, and
// Social's say what they are about, since the Social group has no heading (its first item names it). Neither may
// contain another item's name: a link is found by its name (e2e), and a name inside another matches both.
const IN_MENU_LABEL: Partial<Record<NavLabel, 'alertsShort' | 'socialNotifications'>> = {
  alerts: 'alertsShort',
  notifications: 'socialNotifications',
};
// Groups that need no heading: the top of the menu (what waits for the user), and Social, whose first item already
// reads "Mạng xã hội".
const NO_HEADING: ReadonlySet<NavGroupId> = new Set(['work', 'social']);

export interface ShellNavProps {
  slug: string;
  groups: readonly { id: NavGroupId; items: readonly NavItem[] }[];
  // The count shown on an item (pending proposals on the inbox, unread notifications).
  badges: Partial<Record<NavLabel, string | number | null | undefined>>;
  orgs: readonly { orgId: string; slug: string; name: string }[];
  email: string | undefined;
  onOpenPalette: () => void;
  paletteKeys: string;
  // Called after a link or the org switch navigates: the phone drawer closes then.
  onNavigate?: () => void;
}

// What the sidebar and the phone drawer both hold: the org switch, the palette button, the grouped menu and the
// account menu. Every control is at least 44px tall in the phone drawer (below md) and 24px in the sidebar.
export function ShellNav({ slug, groups, badges, orgs, email, onOpenPalette, paletteKeys, onNavigate }: ShellNavProps) {
  const t = useTranslations('nav');
  const tp = useTranslations('palette');
  const navigate = useNavigate();
  const orgSelectId = useId();
  return (
    <>
      <div className="px-2">
        {orgs.length > 1 && (
          <Link to="/clients" onClick={onNavigate} className="mb-3 flex min-h-11 items-center text-sm text-link hover:underline md:min-h-6">
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
          onChange={(e) => {
            onNavigate?.();
            void navigate({ to: '/o/$slug/inbox', params: { slug: e.target.value } });
          }}
        >
          {orgs.map((o) => (
            <NativeSelectOption key={o.orgId} value={o.slug}>
              {o.name}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        {/* The legal entity of the finance books (#1486), when the caller sees more than one. */}
        <EntitySwitcher slug={slug} />
        {/* A firm adds its next client company from here (issue #324). */}
        <Link to="/onboarding" onClick={onNavigate} className="mt-1 inline-flex min-h-11 items-center text-xs text-link md:min-h-6">
          {t('addOrg')}
        </Link>
      </div>
      <button
        type="button"
        onClick={onOpenPalette}
        className="mt-4 flex min-h-11 items-center justify-between gap-1.5 rounded-lg border bg-background px-2.5 py-1.5 text-left text-sm text-subtle-foreground hover:text-foreground md:min-h-0"
      >
        <span className="min-w-0 truncate">{tp('open')}</span>
        <kbd className="shrink-0 rounded-sm border px-1 font-mono text-[11px] whitespace-nowrap">{paletteKeys}</kbd>
      </button>
      {/* The menu scrolls on a short window, so the account menu below it always stays on screen. */}
      <nav aria-label={t('menu')} className="mt-3 flex min-h-0 flex-1 flex-col overflow-y-auto">
        {groups.map((group, index) => {
          const labelId = `${orgSelectId}-${group.id}`;
          return (
            // A group without a visible heading still has a name for screen readers.
            <section
              key={group.id}
              className={index === 0 ? '' : 'mt-3'}
              {...(NO_HEADING.has(group.id) ? { 'aria-label': t(`groups.${group.id}`) } : { 'aria-labelledby': labelId })}
            >
              {!NO_HEADING.has(group.id) && (
                // A label, not a heading: the page's own heading stays the only one with a screen's name ("Khách hàng").
                <p id={labelId} className="px-3 pb-1 text-xs font-medium text-subtle-foreground">
                  {t(`groups.${group.id}`)}
                </p>
              )}
              <ul className="flex flex-col gap-0.5">
                {group.items.map((item) => {
                  const badge = badges[item.label];
                  return (
                    <li key={item.to}>
                      <Link
                        to={item.to}
                        params={{ slug }}
                        onClick={onNavigate}
                        className="flex min-h-11 items-center gap-2.5 rounded-lg px-3 py-1.5 text-sm text-muted-foreground hover:bg-sidebar-accent hover:text-foreground md:min-h-0"
                        activeProps={{ className: 'bg-primary/15 !text-foreground' }}
                      >
                        <NavIcon name={item.label} />
                        <span className="min-w-0 flex-1 truncate">{t(IN_MENU_LABEL[item.label] ?? item.label)}</span>
                        {badge ? <span className="rounded-full bg-primary px-1.5 text-xs text-primary-foreground tabular-nums">{badge}</span> : null}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </nav>
      <AccountMenu email={email} />
    </>
  );
}

// The account at the foot of the menu: the support link (#310) stays in view, the email opens status, language and
// theme, and sign out stays in view (#516) under it.
function AccountMenu({ email }: { email: string | undefined }) {
  const t = useTranslations('nav');
  const tc = useTranslations('common');
  return (
    <div className="mt-3 shrink-0 border-t pt-2">
      <SupportLink className="mb-1 flex min-h-11 items-center px-2 text-sm text-link md:min-h-6" />
      <details className="group">
        <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-lg px-2 py-1.5 md:min-h-0 text-sm text-muted-foreground hover:bg-sidebar-accent hover:text-foreground [&::-webkit-details-marker]:hidden">
          <span className="sr-only">{t('account')}: </span>
          <span className="min-w-0 flex-1 truncate">{email}</span>
          <NavIcon name="expand" className="transition-transform group-open:rotate-180 motion-reduce:transition-none" />
        </summary>
        <div className="mt-2 flex flex-col gap-2 px-2 pb-1 text-xs text-subtle-foreground">
          <StatusLink className="flex min-h-11 items-center text-sm text-link md:min-h-6" />
          {/* One per row: side by side, both names were cut off at the sidebar's width. */}
          <LocaleSwitcher className="w-full text-muted-foreground" />
          <ThemeSwitcher className="w-full text-muted-foreground" />
        </div>
      </details>
      <button type="button" className="mt-1 inline-flex min-h-11 items-center px-2 text-xs text-subtle-foreground hover:text-muted-foreground md:min-h-6" onClick={() => void signOut()}>
        {tc('signOut')}
      </button>
    </div>
  );
}

// The phone's menu (issue #1245): a modal drawer from the left with the same content as the sidebar. Esc and a click
// on the backdrop close it; the browser returns focus to the menu button.
export function NavDrawer({ open, onOpenChange, children }: { open: boolean; onOpenChange: (open: boolean) => void; children: ReactNode }) {
  const t = useTranslations('nav');
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    else if (!open && el.open) el.close();
  }, [open]);
  // Leaving the org layout with the drawer open closes it first, so the browser ends the modal state cleanly.
  useEffect(() => {
    const el = dialog.current;
    return () => {
      if (el?.open) el.close();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      aria-label={t('menu')}
      onClose={() => onOpenChange(false)}
      onClick={(e) => {
        if (e.target === e.currentTarget) onOpenChange(false);
      }}
      className="m-0 h-dvh max-h-none w-[min(18rem,85vw)] max-w-none overflow-hidden bg-sidebar p-0 text-foreground backdrop:bg-foreground/30"
    >
      <div className="flex h-full flex-col px-3 pt-[max(1rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))]">
        <div className="mb-4 flex items-center justify-between px-2">
          <Logo />
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="grid size-11 place-items-center rounded-lg text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
            aria-label={t('closeMenu')}
          >
            <NavIcon name="close" className="size-5" />
          </button>
        </div>
        {open && children}
      </div>
    </dialog>
  );
}
