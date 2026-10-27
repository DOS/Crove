// The modules' screens against the app's router (plan §5.2 `routes` and `nav`, ADR-0031 §3, #1652): every route under
// /o/$slug belongs to exactly one module's manifest and every declared screen is a route, every menu item is a screen
// of its own module with its label in Vietnamese and English, and a screen of a module the deployment leaves out
// redirects to the inbox, whichever module it is.
import { MODULE_SCREENS, type ModuleScreens } from '@crove/kernel-contract';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { en } from '../src/i18n/messages/en.ts';
import { vi as viMessages } from '../src/i18n/messages/vi.ts';
import { ADMIN_ITEMS, ALL_NAV, APPS, appOfPath, installedApps, isHeadedGroup } from '../src/lib/apps.ts';
import { moduleOfPath, screenInstalled } from '../src/lib/modules.ts';

// What the org route's guard reads: a signed-in session and the modules of /api/config, set per test.
const session = vi.hoisted(() => ({ modules: ['kernel'] as string[] }));
vi.mock('../src/lib/auth.ts', async (original) => ({
  ...(await original<typeof import('../src/lib/auth.ts')>()),
  accessToken: async () => 'token',
  needsSecondFactor: async () => false,
  getConfig: () => ({ modules: session.modules }),
}));

type Router = (typeof import('../src/router.tsx'))['router'];
type OrgRoute = (typeof import('../src/router.tsx'))['orgRoute'];
let router: Router;
let orgRoute: OrgRoute;

// The router's modules read window and storage when they load; the unit tests run in Node.
beforeAll(async () => {
  const store = new Map<string, string>();
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
  vi.stubGlobal('window', { location: { origin: 'http://localhost', hash: '', pathname: '/', search: '' }, addEventListener() {}, removeEventListener() {}, localStorage: storage, sessionStorage: storage });
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('sessionStorage', storage);
  ({ router, orgRoute } = await import('../src/router.tsx'));
});

const MODULES = Object.entries(MODULE_SCREENS) as Array<[string, ModuleScreens]>;

// The paths under /o/$slug of the router's routes ('/o/$slug/social/' and its layout '/o/$slug/social' are one screen;
// the org's index only redirects).
function routerScreens(fullPaths: readonly string[]): string[] {
  const out = new Set<string>();
  for (const full of fullPaths) {
    const path = full.replace(/\/+$/, '');
    if (path.startsWith('/o/$slug/')) out.add(path.slice('/o/$slug/'.length));
  }
  return [...out].sort();
}

// What differs between the router's screens and the manifests' routes, one line each.
function screenProblems(screens: readonly string[], modules: ReadonlyArray<readonly [string, ModuleScreens]>): string[] {
  const problems: string[] = [];
  const owners = new Map<string, string[]>();
  for (const [module, { routes }] of modules) for (const route of routes) owners.set(route.path, [...(owners.get(route.path) ?? []), module]);
  for (const path of screens) {
    const by = owners.get(path) ?? [];
    if (by.length === 0) problems.push(`route /o/$slug/${path} has no manifest entry: add it to the routes of its module in packages/kernel-contract/src/screens.ts`);
    if (by.length > 1) problems.push(`route /o/$slug/${path} is declared by ${by.join(' and ')}`);
  }
  for (const [path, by] of owners) if (!screens.includes(path)) problems.push(`${by.join(', ')} declares /o/$slug/${path}, which the router does not have`);
  return problems;
}

describe('module screens against the router (#1652)', () => {
  it('declares every /o/$slug route in exactly one module', () => {
    const screens = routerScreens(Object.values(router.routesById).map((r) => r.fullPath));
    expect(screens.length).toBeGreaterThan(30);
    expect(screenProblems(screens, MODULES)).toEqual([]);
  });

  it('fails on a planted route without its manifest line, one declared twice, or a declared screen with no route', () => {
    const screens = routerScreens([...Object.values(router.routesById).map((r) => r.fullPath), '/o/$slug/invoices']);
    expect(screenProblems(screens, MODULES)).toEqual([
      'route /o/$slug/invoices has no manifest entry: add it to the routes of its module in packages/kernel-contract/src/screens.ts',
    ]);
    const twice = [...MODULES, ['crm2', { routes: [{ path: 'bookings' }, { path: 'deals' }], nav: [] }] as const];
    expect(screenProblems(routerScreens(Object.values(router.routesById).map((r) => r.fullPath)), twice)).toEqual([
      'route /o/$slug/bookings is declared by crm and crm2',
      'crm2 declares /o/$slug/deals, which the router does not have',
    ]);
  });

  it('puts each menu item on a screen of its own module, once, with its label in Vietnamese and English', () => {
    const seen = new Set<string>();
    for (const [module, { routes, nav }] of MODULES) {
      for (const item of nav) {
        expect(routes.map((r) => r.path), `${module} menu item ${item.path}`).toContain(item.path);
        expect(seen.has(item.path), item.path).toBe(false);
        seen.add(item.path);
        expect(viMessages.nav, `vi nav.${item.label}`).toHaveProperty(item.label);
        expect(en.nav, `en nav.${item.label}`).toHaveProperty(item.label);
      }
      for (const route of routes) if (route.app !== undefined) expect(APPS.map((a) => a.id), `${module} ${route.path}`).toContain(route.app);
    }
    for (const app of APPS) {
      for (const messages of [viMessages.nav, en.nav]) {
        expect(messages.apps, `nav.apps.${app.id}`).toHaveProperty(app.id);
        expect(messages.appNames, `nav.appNames.${app.id}`).toHaveProperty(app.id);
      }
      // A group after an app's first carries a heading in the menu, in both languages.
      for (const group of app.groups.slice(1)) {
        expect(isHeadedGroup(group.id), `group ${group.id} of ${app.id}`).toBe(true);
        expect(viMessages.nav.groups).toHaveProperty(group.id);
        expect(en.nav.groups).toHaveProperty(group.id);
      }
    }
  });

  it('keeps the menus users know, in their order', () => {
    expect(APPS.map((a) => [a.id, a.groups.map((g) => [g.id, g.items.map((i) => i.to)])])).toEqual([
      ['home', [['work', ['/o/$slug/overview', '/o/$slug/inbox', '/o/$slug/notifications', '/o/$slug/tasks']]]],
      [
        'accounting',
        [
          ['books', ['/o/$slug/documents', '/o/$slug/journal', '/o/$slug/vouchers', '/o/$slug/bank', '/o/$slug/fixed-assets', '/o/$slug/ledger']],
          ['tax', ['/o/$slug/vat', '/o/$slug/portal-invoices']],
          ['parties', ['/o/$slug/customers', '/o/$slug/vendors']],
        ],
      ],
      ['social', [['social', ['/o/$slug/social', '/o/$slug/social/notifications']]]],
      ['crm', [['crm', ['/o/$slug/bookings']]]],
    ]);
    expect(ADMIN_ITEMS.map((i) => [i.to, i.label])).toEqual([
      ['/o/$slug/agents', 'agents'],
      ['/o/$slug/settings', 'settings'],
    ]);
    expect(ALL_NAV.map((i) => i.label)).toEqual([
      'overview', 'inbox', 'alerts', 'tasks', 'documents', 'journal', 'vouchers', 'bank', 'fixedAssets', 'ledger', 'vat', 'portalList', 'customers', 'vendors', 'social', 'notifications', 'bookings', 'agents', 'settings',
    ]);
  });
});

describe('a module turned off (ADR-0031 §3, #1652)', () => {
  // A concrete address of each declared screen of a module.
  const addresses = (module: keyof typeof MODULE_SCREENS) => MODULE_SCREENS[module].routes.map((r) => `/o/acme/${r.path.replaceAll(/\$[a-z]+/gi, '0190-abc')}`);

  it('finds the module of every screen, a parameter matching any one segment', () => {
    for (const [module] of MODULES) for (const path of addresses(module as keyof typeof MODULE_SCREENS)) expect(moduleOfPath(path), path).toBe(module);
    expect(moduleOfPath('/o/acme/social/new')).toBe('social');
    expect(moduleOfPath('/o/acme/journal/')).toBe('finance');
    for (const path of ['/o/acme', '/o/acme/', '/clients', '/o/acme/nowhere', '/o/acme/inbox/1/2']) expect(moduleOfPath(path), path).toBeNull();
  });

  it('hides the menus of crm and social and keeps the rest', () => {
    const apps = installedApps(['kernel', 'finance']);
    expect(apps.map((a) => a.id)).toEqual(['home', 'accounting']);
    expect(installedApps(['kernel']).map((a) => a.id)).toEqual(['home']);
    expect(installedApps(['kernel', 'social']).map((a) => a.id)).toEqual(['home', 'social']);
    expect(appOfPath('/o/acme/guide')).toBe('accounting');
  });

  it('sends every screen of crm and social to the inbox, through the org route, and opens the others', async () => {
    session.modules = ['kernel', 'finance'];
    const beforeLoad = orgRoute.options.beforeLoad as unknown as (ctx: { params: { slug: string }; location: { pathname: string } }) => Promise<void>;
    const outcome = async (pathname: string) => {
      try {
        await beforeLoad({ params: { slug: 'acme' }, location: { pathname } });
        return 'open';
      } catch (thrown) {
        const r = thrown as { options?: { to?: string; params?: { slug?: string } } };
        return `${r.options?.to} ${r.options?.params?.slug}`;
      }
    };
    for (const path of [...addresses('crm'), ...addresses('social')]) {
      expect(screenInstalled(session.modules, path), path).toBe(false);
      // The print route of social sits outside the org's frame, with the same guard.
      if (path.startsWith('/o/acme/print/')) continue;
      expect(await outcome(path), path).toBe('/o/$slug/inbox acme');
    }
    for (const path of [...addresses('kernel'), ...addresses('finance')]) expect(await outcome(path), path).toBe('open');
    session.modules = ['kernel'];
    for (const path of addresses('finance')) expect(await outcome(path), path).toBe('/o/$slug/inbox acme');
    session.modules = ['kernel', 'finance', 'social', 'crm'];
    for (const [module] of MODULES) for (const path of addresses(module as keyof typeof MODULE_SCREENS)) expect(screenInstalled(session.modules, path), path).toBe(true);
  });

  it('guards the printed social plan the same way', async () => {
    session.modules = ['kernel'];
    const print = router.routesById['/o/$slug/print/social-plan'];
    const beforeLoad = print.options.beforeLoad as unknown as (ctx: { params: { slug: string }; location: { pathname: string } }) => Promise<void>;
    await expect(beforeLoad({ params: { slug: 'acme' }, location: { pathname: '/o/acme/print/social-plan' } })).rejects.toMatchObject({ options: { to: '/o/$slug/inbox' } });
    session.modules = ['kernel', 'social'];
    await expect(beforeLoad({ params: { slug: 'acme' }, location: { pathname: '/o/acme/print/social-plan' } })).resolves.toBeUndefined();
  });
});
