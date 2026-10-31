// The modules' screens against the app's router (plan §5.2 `routes` and `nav`, ADR-0031 §3, #1652): every route under
// /o/$slug belongs to exactly one module's manifest and every declared screen is a route, every menu item is a screen
// of its own module with its label in Vietnamese and English, and a screen of a module the deployment leaves out
// redirects to the inbox, whichever module it is.
import { MODULE_SCREENS, type ModuleScreens } from '@crove/kernel-contract';
import { createMemoryHistory, createRouter, isNotFound } from '@tanstack/react-router';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { en } from '../src/i18n/messages/en.ts';
import { vi as viMessages } from '../src/i18n/messages/vi.ts';
import { ADMIN_ITEMS, ALL_NAV, APPS, appOfPath, installedApps, isHeadedGroup } from '../src/lib/apps.ts';
import { moduleOfOutsideRoute, moduleOfPath, outsideInstalled, screenInstalled } from '../src/lib/modules.ts';

// What the org route's guard reads: a signed-in session and the modules of /api/config, set per test.
const session = vi.hoisted(() => ({ modules: ['kernel'] as string[], token: 'token' as string | null }));
vi.mock('../src/lib/auth.ts', async (original) => ({
  ...(await original<typeof import('../src/lib/auth.ts')>()),
  accessToken: async () => session.token,
  needsSecondFactor: async () => false,
  getConfig: () => ({ modules: session.modules }),
}));

type Router = (typeof import('../src/router.tsx'))['router'];
let router: Router;

// The router's modules read window and storage when they load; the unit tests run in Node.
beforeAll(async () => {
  const store = new Map<string, string>();
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
  vi.stubGlobal('window', { location: { origin: 'http://localhost', hash: '', pathname: '/', search: '' }, addEventListener() {}, removeEventListener() {}, localStorage: storage, sessionStorage: storage });
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('sessionStorage', storage);
  ({ router } = await import('../src/router.tsx'));
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

// The router's routes outside /o/$slug, as it writes them ('/' for the landing redirect).
function outsideRoutes(r: Router): string[] {
  const out = new Set<string>();
  for (const [id, route] of Object.entries(r.routesById)) {
    if (id === '__root__') continue;
    const path = route.fullPath === '/' ? '/' : route.fullPath.replace(/\/+$/, '');
    if (path !== '/o/$slug' && !path.startsWith('/o/$slug/')) out.add(path);
  }
  return [...out].sort();
}

// What differs between the router's routes outside /o/$slug and the manifests' `outside`, one line each (#1660).
function outsideProblems(routes: readonly string[], modules: ReadonlyArray<readonly [string, ModuleScreens]>): string[] {
  const problems: string[] = [];
  const owners = new Map<string, string[]>();
  for (const [module, { outside }] of modules) for (const route of outside ?? []) owners.set(route.path, [...(owners.get(route.path) ?? []), module]);
  for (const path of routes) {
    const by = owners.get(path) ?? [];
    if (by.length === 0) problems.push(`route ${path} has no manifest entry: add it to the outside routes of its module in packages/kernel-contract/src/screens.ts`);
    if (by.length > 1) problems.push(`route ${path} is declared by ${by.join(' and ')}`);
  }
  for (const [path, by] of owners) if (!routes.includes(path)) problems.push(`${by.join(', ')} declares ${path}, which the router does not have`);
  return problems;
}

describe('module screens against the router (#1652)', () => {
  it('declares every route outside /o/$slug in exactly one module (#1660)', () => {
    const routes = outsideRoutes(router);
    expect(routes).toEqual([
      '/',
      '/-/b/$org/$type',
      '/-/invite',
      '/-/report',
      '/-/review',
      '/-/share',
      '/calendar/oauth/$provider/callback',
      '/channels/oauth/$provider/callback',
      '/clients',
      '/login',
      '/mfa',
      '/onboarding',
      '/reset-password',
    ]);
    expect(outsideProblems(routes, MODULES)).toEqual([]);
    expect(outsideProblems([...routes, '/-/quote'], MODULES)).toEqual([
      'route /-/quote has no manifest entry: add it to the outside routes of its module in packages/kernel-contract/src/screens.ts',
    ]);
    expect(Object.fromEntries(routes.map((r) => [r, moduleOfOutsideRoute(r)]))).toMatchObject({
      '/-/share': 'social',
      '/channels/oauth/$provider/callback': 'social',
      '/-/review': 'social',
      '/-/report': 'social',
      '/-/b/$org/$type': 'crm',
      '/login': 'kernel',
    });
  });

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
      ['home', [['work', ['/o/$slug/overview', '/o/$slug/inbox', '/o/$slug/notifications', '/o/$slug/tasks', '/o/$slug/notes', '/o/$slug/my-work']]]],
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
      'overview', 'inbox', 'alerts', 'tasks', 'notes', 'myWork', 'documents', 'journal', 'vouchers', 'bank', 'fixedAssets', 'ledger', 'vat', 'portalList', 'customers', 'vendors', 'social', 'notifications', 'bookings', 'agents', 'settings',
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
    // The router matches without regard to case or percent-encoding, so the guard does too.
    expect(moduleOfPath('/o/acme/JOURNAL')).toBe('finance');
    expect(moduleOfPath('/O/acme/Social/New')).toBe('social');
    expect(moduleOfPath('/o/acme/%62ookings')).toBe('crm');
    expect(screenInstalled(['kernel'], '/o/acme/Bookings')).toBe(false);
    for (const path of ['/o/acme', '/o/acme/', '/clients', '/o/acme/nowhere', '/o/acme/inbox/1/2']) expect(moduleOfPath(path), path).toBeNull();
  });

  it('hides the menus of crm and social and keeps the rest', () => {
    const apps = installedApps(['kernel', 'finance']);
    expect(apps.map((a) => a.id)).toEqual(['home', 'accounting']);
    expect(installedApps(['kernel']).map((a) => a.id)).toEqual(['home']);
    expect(installedApps(['kernel', 'social']).map((a) => a.id)).toEqual(['home', 'social']);
    expect(appOfPath('/o/acme/guide')).toBe('accounting');
  });

  // Where the router lands after loading an address: a router of the app's own route tree on a memory history, so the
  // address goes through the router's matching (case, parameters) before the org route's guard sees it. isServer: the
  // tests run in Node, where the router would otherwise skip loading.
  const landing = async (address: string) => {
    const r = createRouter({ routeTree: router.routeTree, history: createMemoryHistory({ initialEntries: [address] }), isServer: false });
    await r.load();
    return r.state.location.pathname;
  };

  it('sends every screen of crm, social and notes to the inbox through the router, and opens the others', async () => {
    session.modules = ['kernel', 'finance'];
    for (const path of [...addresses('crm'), ...addresses('social'), ...addresses('notes')]) {
      expect(screenInstalled(session.modules, path), path).toBe(false);
      expect(await landing(path), path).toBe('/o/acme/inbox');
    }
    for (const path of [...addresses('kernel'), ...addresses('finance')]) expect(await landing(path), path).toBe(path);
    // The router matches without regard to case, and so does the guard.
    for (const path of ['/o/acme/Bookings', '/o/acme/SOCIAL/new', '/o/acme/Print/Social-Plan']) expect(await landing(path), path).toBe('/o/acme/inbox');
    session.modules = ['kernel'];
    for (const path of [...addresses('finance'), '/o/acme/JOURNAL']) expect(await landing(path), path).toBe('/o/acme/inbox');
    session.modules = ['kernel', 'finance', 'social', 'crm', 'notes'];
    for (const [module] of MODULES) {
      for (const path of addresses(module as keyof typeof MODULE_SCREENS)) {
        expect(screenInstalled(session.modules, path), path).toBe(true);
        expect(await landing(path), path).toBe(path);
      }
    }
  });
});

describe('a module turned off, outside /o/$slug (ADR-0031 §3, #1660)', () => {
  // The router's answer for an address: the path it ends on, and whether that is a not-found page.
  const answer = async (address: string) => {
    const r = createRouter({ routeTree: router.routeTree, history: createMemoryHistory({ initialEntries: [address] }), isServer: false });
    await r.load();
    // A notFound() thrown in a beforeLoad lands on the match whose notFoundComponent shows it: the root's.
    return { path: r.state.location.pathname, notFound: r.state.matches.some((m) => isNotFound(m.error)) };
  };
  const SOCIAL = ['/-/share', '/channels/oauth/x/callback', '/-/review', '/-/report'];
  const BOOKING = '/-/b/acme/tu-van';

  it('answers the screens of social and crm not found, as the API does, and opens them where they run', async () => {
    session.token = 'token';
    session.modules = ['kernel', 'finance'];
    for (const address of [...SOCIAL, BOOKING]) expect(await answer(address), address).toEqual({ path: address, notFound: true });
    expect(outsideInstalled(session.modules, '/-/b/$org/$type')).toBe(false);
    session.modules = ['kernel', 'social'];
    for (const address of SOCIAL) expect(await answer(address), address).toEqual({ path: address, notFound: false });
    expect(await answer(BOOKING)).toEqual({ path: BOOKING, notFound: true });
    session.modules = ['kernel', 'crm'];
    expect(await answer(BOOKING)).toEqual({ path: BOOKING, notFound: false });
    // The kernel's own screens open whatever the modules.
    session.modules = ['kernel'];
    expect(outsideInstalled(session.modules, '/clients')).toBe(true);
    expect(await answer('/clients')).toEqual({ path: '/clients', notFound: false });
  });

  it('shows the not-found page at the root outside an org, and inside the org frame for a mistyped org address', async () => {
    session.modules = ['kernel'];
    const shownBy = async (address: string) => {
      const r = createRouter({ routeTree: router.routeTree, history: createMemoryHistory({ initialEntries: [address] }), isServer: false });
      await r.load();
      return r.state.matches.filter((m) => (m as { _notFound?: boolean })._notFound === true || isNotFound(m.error)).map((m) => m.routeId);
    };
    expect(await shownBy('/-/review')).toEqual(['__root__']);
    expect(await shownBy('/nowhere')).toEqual(['__root__']);
    expect(await shownBy('/o/acme/nope')).toEqual(['/o/$slug']);
  });

  it('keeps public links public: no sign-in asked, installed or not', async () => {
    session.token = null;
    try {
      const publicRoutes = (Object.values(MODULE_SCREENS) as ModuleScreens[]).flatMap((m) => (m.outside ?? []).filter((r) => r.public).map((r) => r.path)).sort();
      expect(publicRoutes).toEqual(['/-/b/$org/$type', '/-/report', '/-/review']);
      session.modules = ['kernel', 'social', 'crm'];
      for (const address of ['/-/review', '/-/report', BOOKING]) expect(await answer(address), address).toEqual({ path: address, notFound: false });
      session.modules = ['kernel'];
      for (const address of ['/-/review', '/-/report', BOOKING]) expect(await answer(address), address).toEqual({ path: address, notFound: true });
      // A signed-in screen still asks for a sign-in where its module runs.
      session.modules = ['kernel', 'social'];
      expect((await answer('/channels/oauth/x/callback')).path).toBe('/login');
    } finally {
      session.token = 'token';
    }
  });
});
