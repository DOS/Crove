// The modules' screens in their manifests (plan §5.2 `routes` and `nav`, #1652): every module manifest names exactly its
// entry of MODULE_SCREENS, the list the app's shell builds its menus and module guard from, so the shell and the
// manifests cannot drift; and every permission a screen names is declared (#1630). The router side, that every route
// under /o/$slug has one entry and every label a message, is apps/app/test/module-screens.test.ts.
import { describe, expect, it } from 'vitest';
import { MODULE_SCREENS, columns, defineModule, type ModuleScreens } from '@crove/kernel-contract';
import { MODULE_MANIFESTS, permissionProblems, routePermissionUses, type Manifests } from './manifest-permissions.ts';

describe('module manifests declare their screens (#1652)', () => {
  it('gives every manifest its own entry of MODULE_SCREENS, and every entry a manifest', () => {
    expect(Object.keys(MODULE_SCREENS).sort()).toEqual(Object.keys(MODULE_MANIFESTS).sort());
    for (const [id, { manifest }] of Object.entries(MODULE_MANIFESTS)) {
      const screens: ModuleScreens = MODULE_SCREENS[id as keyof typeof MODULE_SCREENS];
      expect(manifest.routes, id).toBe(screens.routes);
      expect(manifest.nav, id).toBe(screens.nav);
      expect(manifest.outside, id).toBe(screens.outside);
    }
  });

  it('writes each screen as a path under /o/$slug, once across the modules', () => {
    const paths = Object.values(MODULE_MANIFESTS).flatMap(({ manifest }) => manifest.routes.map((r) => r.path));
    for (const path of paths) expect(path, path).toMatch(/^[a-z][a-z0-9-]*(\/([a-z][a-z0-9-]*|\$[a-zA-Z]+))*$/);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('writes each screen outside /o/$slug as a full path, once across the modules (#1660)', () => {
    const paths = Object.values(MODULE_MANIFESTS).flatMap(({ manifest }) => (manifest.outside ?? []).map((r) => r.path));
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) {
      expect(path, path).toMatch(/^\/(([a-z-]+|\$[a-zA-Z]+)(\/([a-z][a-z0-9-]*|\$[a-zA-Z]+))*)?$/);
      expect(path === '/o/$slug' || path.startsWith('/o/'), path).toBe(false);
    }
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('declares every permission a screen names', () => {
    expect(permissionProblems(MODULE_MANIFESTS, { uses: routePermissionUses(MODULE_MANIFESTS) })).toEqual([]);
  });

  it('fails on a planted screen that names an undeclared permission', () => {
    const manifests: Manifests = {
      finance: {
        manifest: defineModule({
          id: 'finance',
          dependsOn: ['kernel'],
          tables: { crove_finance: { t: columns(['id']) } },
          permissions: [{ key: 'finance.period.unlock', risk: 'R3', defaultRoles: ['finance.chief_accountant'] }],
          routes: [{ path: 'periods', permission: 'finance.period.unlock' }, { path: 'payroll', permission: 'finance.payroll.read' }],
          nav: [],
          entities: [],
        }),
        file: 'finance.ts',
      },
    };
    expect(permissionProblems(manifests, { uses: routePermissionUses(manifests) })).toEqual([
      'screen /o/$slug/payroll of finance names finance.payroll.read, which no manifest declares: declare it in finance.ts',
    ]);
  });
});
