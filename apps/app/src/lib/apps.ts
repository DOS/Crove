// The apps of the shell (issue #1528; plan item 11: "App" in the product UI, with an app switcher in the shell). Each
// app has its own short menu, in groups; the switcher lists the apps whose module this deployment runs (CROVE_MODULES,
// ADR-0031), and an item of a module that is not installed is left out of its app. The org's own screens (the chart
// and AI, Settings) belong to no app: they sit at the foot of the switcher.
import { installedItems } from './modules.ts';

export const APPS = [
  {
    id: 'home',
    module: 'kernel',
    groups: [
      {
        id: 'work',
        items: [
          // What waits for the user in this org today (#1249).
          { to: '/o/$slug/overview', label: 'overview', module: 'kernel' },
          { to: '/o/$slug/inbox', label: 'inbox', module: 'kernel' },
          // In-app notifications of the kernel and finance (#671), with the unread count.
          { to: '/o/$slug/notifications', label: 'alerts', module: 'kernel' },
          { to: '/o/$slug/tasks', label: 'tasks', module: 'kernel' },
        ],
      },
    ],
  },
  {
    id: 'accounting',
    module: 'finance',
    groups: [
      {
        id: 'books',
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
    ],
  },
  {
    id: 'social',
    module: 'social',
    groups: [
      {
        id: 'social',
        items: [
          { to: '/o/$slug/social', label: 'social', module: 'social' },
          { to: '/o/$slug/social/notifications', label: 'notifications', module: 'social' },
        ],
      },
    ],
  },
  {
    id: 'crm',
    module: 'crm',
    groups: [
      {
        id: 'crm',
        items: [
          // Bookings of the public booking page (#1320).
          { to: '/o/$slug/bookings', label: 'bookings', module: 'crm' },
        ],
      },
    ],
  },
] as const;

// The org's own screens, under every app.
export const ADMIN_ITEMS = [
  { to: '/o/$slug/agents', label: 'agents', module: 'kernel' },
  { to: '/o/$slug/settings', label: 'settings', module: 'kernel' },
] as const;

export type App = (typeof APPS)[number];
export type AppId = App['id'];
export type AppGroupId = App['groups'][number]['id'];
export type NavItem = App['groups'][number]['items'][number] | (typeof ADMIN_ITEMS)[number];
// The groups after an app's first, which carry a heading in the menu.
export type HeadedGroupId = 'tax' | 'parties';
export function isHeadedGroup(id: AppGroupId): id is HeadedGroupId {
  return id === 'tax' || id === 'parties';
}
export type NavLabel = NavItem['label'];

// Every screen of the menus, apps first, for the command palette (Ctrl K searches all of them, whatever the app).
export const ALL_NAV: readonly NavItem[] = [...APPS.flatMap((a) => a.groups.flatMap((g): readonly NavItem[] => g.items)), ...ADMIN_ITEMS];

export interface InstalledApp {
  id: AppId;
  // The first screen of the app, where the switcher goes.
  home: NavItem['to'];
  groups: readonly { id: AppGroupId; items: readonly NavItem[] }[];
}

// The apps this deployment runs, each with its installed items; an app left with no item is not listed.
export function installedApps(modules: readonly string[]): InstalledApp[] {
  return APPS.flatMap((app) => {
    if (!modules.includes(app.module) && app.module !== 'kernel') return [];
    const groups = app.groups.map((g) => ({ id: g.id, items: installedItems<NavItem>(modules, g.items) })).filter((g) => g.items.length > 0);
    const first = groups[0]?.items[0];
    return first ? [{ id: app.id, home: first.to, groups }] : [];
  });
}

// Screens reached from inside an app rather than from its menu.
const INNER_SCREENS: Readonly<Record<string, AppId>> = { guide: 'accounting' };

// The app a path (/o/<slug>/<screen>/...) belongs to, so a deep link opens with its app selected; null for the org's
// own screens (the chart, Settings, the audit log) and for paths outside an org.
export function appOfPath(pathname: string): AppId | null {
  const [, o, , screen] = pathname.split('/');
  if (o !== 'o' || !screen) return null;
  for (const app of APPS) {
    for (const group of app.groups) {
      if (group.items.some((item) => item.to.split('/')[3] === screen)) return app.id;
    }
  }
  return INNER_SCREENS[screen] ?? null;
}
