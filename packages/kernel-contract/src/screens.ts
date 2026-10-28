// Each module's screens in the app and its menu items (plan §5.2 `routes` and `nav`, DESIGN.md §9, ADR-0031, #1652).
// Every module's manifest names its entry here (`...MODULE_SCREENS.crm`), and the app's shell builds its apps, menus,
// command palette and module guard from this list, so the shell names no module's screen itself. They live in
// @crove/kernel-contract because the app's bundle already reads it and it carries no server code.
// apps/app/test/module-screens.test.ts fails when a route of the app's router under /o/$slug has no entry or two, or a
// label has no message in Vietnamese or English; apps/kernel/test/manifest-screens.test.ts fails when a manifest drifts
// from its entry or a route names an undeclared permission. Modules are in the order of the app switcher.
import type { ModuleScreens } from './manifest.ts';

const KERNEL_SCREENS = {
  routes: [
    // What waits for the user in this org today (#1249), first in the menu; opening an org still lands on its Inbox.
    { path: 'overview' },
    { path: 'inbox' },
    { path: 'inbox/$id' },
    // In-app notifications of the kernel and finance (#671), with the unread count.
    { path: 'notifications' },
    // AI agents and tasks (ADR-0029) belong to the kernel, so every deployment has them.
    { path: 'tasks' },
    { path: 'tasks/$id' },
    { path: 'agents' },
    { path: 'settings' },
    // The audit log (#672): owners and admins only, which the page checks and the server enforces.
    { path: 'audit' },
    { path: 'personal-data' },
  ],
  nav: [
    { app: 'home', group: 'work', path: 'overview', label: 'overview' },
    { app: 'home', group: 'work', path: 'inbox', label: 'inbox' },
    { app: 'home', group: 'work', path: 'notifications', label: 'alerts' },
    { app: 'home', group: 'work', path: 'tasks', label: 'tasks' },
    // The org's own screens, under every app.
    { app: null, path: 'agents', label: 'agents' },
    { app: null, path: 'settings', label: 'settings' },
  ],
} as const satisfies ModuleScreens;

const FINANCE_SCREENS = {
  routes: [
    { path: 'documents' },
    { path: 'journal' },
    // Opening balances from Excel (#320), reached from the journal.
    { path: 'journal/opening-balances' },
    { path: 'vouchers' },
    { path: 'bank' },
    { path: 'fixed-assets' },
    { path: 'ledger' },
    { path: 'vat' },
    { path: 'portal-invoices' },
    { path: 'customers' },
    { path: 'vendors' },
    // The Vietnamese quick guide (issue #310), linked from the empty Inbox; it walks through finance screens.
    { path: 'guide', app: 'accounting' },
  ],
  nav: [
    { app: 'accounting', group: 'books', path: 'documents', label: 'documents' },
    { app: 'accounting', group: 'books', path: 'journal', label: 'journal' },
    { app: 'accounting', group: 'books', path: 'vouchers', label: 'vouchers' },
    { app: 'accounting', group: 'books', path: 'bank', label: 'bank' },
    { app: 'accounting', group: 'books', path: 'fixed-assets', label: 'fixedAssets' },
    { app: 'accounting', group: 'books', path: 'ledger', label: 'ledger' },
    { app: 'accounting', group: 'tax', path: 'vat', label: 'vat' },
    { app: 'accounting', group: 'tax', path: 'portal-invoices', label: 'portalList' },
    { app: 'accounting', group: 'parties', path: 'customers', label: 'customers' },
    { app: 'accounting', group: 'parties', path: 'vendors', label: 'vendors' },
  ],
} as const satisfies ModuleScreens;

const SOCIAL_SCREENS = {
  routes: [
    { path: 'social' },
    { path: 'social/new' },
    { path: 'social/channels' },
    { path: 'social/import' },
    { path: 'social/snippets' },
    { path: 'social/labels' },
    { path: 'social/ideas' },
    { path: 'social/feeds' },
    { path: 'social/bio' },
    { path: 'social/notifications' },
    { path: 'social/$id' },
    // The content plan to print (#978), outside the org's frame so only the plan reaches the paper.
    { path: 'print/social-plan' },
  ],
  nav: [
    { app: 'social', group: 'social', path: 'social', label: 'social' },
    { app: 'social', group: 'social', path: 'social/notifications', label: 'notifications' },
  ],
} as const satisfies ModuleScreens;

const CRM_SCREENS = {
  // Bookings of the public booking page (#1320).
  routes: [{ path: 'bookings' }],
  nav: [{ app: 'crm', group: 'crm', path: 'bookings', label: 'bookings' }],
} as const satisfies ModuleScreens;

// Notes and personal to-dos (#1671): the notes screen and its menu item come with the module's screens (step N2's UI).
const NOTES_SCREENS = {
  routes: [],
  nav: [],
} as const satisfies ModuleScreens;

export const MODULE_SCREENS = {
  kernel: KERNEL_SCREENS,
  finance: FINANCE_SCREENS,
  social: SOCIAL_SCREENS,
  crm: CRM_SCREENS,
  notes: NOTES_SCREENS,
} as const;
