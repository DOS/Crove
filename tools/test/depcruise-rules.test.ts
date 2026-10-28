import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXCEPTIONS, buildRules, checkModuleGraph, readPackages } from '../depcruise-rules.mjs';

const kernel = { id: 'kernel', dir: 'packages/kernel', dependsOn: [] };
const finance = { id: 'finance', dir: 'modules/finance', dependsOn: ['kernel'] };
const crm = { id: 'crm', dir: 'modules/crm', dependsOn: ['kernel'] };
const packages = [
  { dir: 'packages/kernel', name: '@crove/kernel', exports: ['./src/index.ts'] },
  { dir: 'packages/db', name: '@crove/db', exports: ['./src/index.ts', './src/migrate.ts'] },
  { dir: 'packages/ui', name: '@crove/ui', exports: ['./src/components/*.tsx'] },
  { dir: 'modules/finance', name: '@crove/mod-finance', exports: ['./src/index.ts'] },
  { dir: 'modules/crm', name: '@crove/mod-crm', exports: ['./src/index.ts', './src/contract.ts'] },
  { dir: 'apps/app', name: '@crove/app', exports: [] },
];

describe('depcruise rules from the manifests (#1651)', () => {
  it('refuses a dependsOn that names no module, the module itself, or closes a cycle', () => {
    expect(() => checkModuleGraph([kernel, { ...finance, dependsOn: ['kernel', 'ledger'] }])).toThrow('depends on ledger, which is no module');
    expect(() => checkModuleGraph([kernel, { ...finance, dependsOn: ['finance'] }])).toThrow('depends on itself');
    expect(() => checkModuleGraph([{ ...kernel, dependsOn: ['crm'] }, finance, { ...crm, dependsOn: ['finance'] }])).toThrow(/cycle: (kernel -> crm -> finance -> kernel|crm -> finance -> kernel -> crm|finance -> kernel -> crm -> finance)/);
    expect(() => checkModuleGraph([kernel, finance, { ...crm, dependsOn: ['kernel', 'finance'] }])).toThrow('is not sorted or repeats a module');
    expect(() => checkModuleGraph([kernel, finance, { ...crm, dependsOn: ['kernel', 'kernel'] }])).toThrow('is not sorted or repeats a module');
    expect(() => checkModuleGraph([kernel, finance, { ...crm, dependsOn: ['finance', 'kernel'] }])).not.toThrow();
  });

  it('gives each module a rule against every module its manifest does not list', () => {
    const rules = buildRules([kernel, finance, crm], packages, []);
    expect(rules.find((r) => r.name === 'module-dag-crm')).toMatchObject({ from: { path: '^modules/crm/' }, to: { path: '^(modules/finance)/' } });
    expect(rules.find((r) => r.name === 'module-dag-kernel')?.to.path).toBe('^(modules/finance|modules/crm)/');
    // A module that lists every other one gets no rule of its own.
    const all = buildRules([kernel, finance, { ...crm, dependsOn: ['finance', 'kernel'] }], packages, []);
    expect(all.some((r) => r.name === 'module-dag-crm')).toBe(false);
  });

  it('lets other packages reach only the exported files, with a wildcard export matching any file under it', () => {
    const deep = buildRules([kernel, finance, crm], packages, []).find((r) => r.name === 'no-deep-import' && r.to.pathNot);
    const allowed = (path: string) => deep!.to.pathNot.slice(1).some((re: string) => new RegExp(re).test(path));
    expect(allowed('modules/crm/src/contract.ts')).toBe(true);
    expect(allowed('packages/ui/src/components/button.tsx')).toBe(true);
    expect(allowed('packages/db/src/migrate.ts')).toBe(true);
    expect(allowed('modules/crm/src/bookings.ts')).toBe(false);
    expect(allowed('packages/db/src/context/index.ts')).toBe(false);
    expect(allowed('apps/app/src/main.tsx')).toBe(false);
  });

  it('reads the exported files of each package, a null target (a forbidden path) pointing nowhere', () => {
    const root = mkdtempSync(join(tmpdir(), 'depcruise-'));
    try {
      const pkg = (dir: string, json: object) => {
        mkdirSync(join(root, dir), { recursive: true });
        writeFileSync(join(root, dir, 'package.json'), JSON.stringify(json));
      };
      for (const parent of ['apps', 'packages', 'modules']) mkdirSync(join(root, parent));
      pkg('packages/a', { name: '@crove/a', exports: { '.': { import: './src/index.ts', default: null }, './private/*': null } });
      pkg('modules/b', { name: '@crove/mod-b', exports: null });
      pkg('e2e', { name: '@crove/e2e' });
      expect(readPackages(root).sort((x, y) => x.dir.localeCompare(y.dir))).toEqual([
        { dir: 'e2e', name: '@crove/e2e', exports: [] },
        { dir: 'modules/b', name: '@crove/mod-b', exports: [] },
        { dir: 'packages/a', name: '@crove/a', exports: ['./src/index.ts'] },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('exempts only the listed files, each with the union of its exceptions, and keeps the rule for every other file', () => {
    const exceptions = [
      { rule: 'domain-pure', from: ['modules/finance/src/domain/a.ts', 'modules/finance/src/domain/b.ts'], to: '^x/', reason: 'one' },
      { rule: 'domain-pure', from: ['modules/finance/src/domain/b.ts'], to: '^y/', reason: 'two' },
    ];
    const [base, a, b, ...rest] = buildRules([kernel, finance, crm], packages, exceptions).filter((r) => r.name === 'domain-pure');
    expect([a?.from.path, rest]).toEqual(['^(modules/finance)/src/domain/a\\.ts$', []]);
    expect(base!.from.pathNot).toEqual(['^modules/finance/src/domain/a\\.ts$', '^modules/finance/src/domain/b\\.ts$']);
    expect(b!.from.path).toBe('^(modules/finance)/src/domain/b\\.ts$');
    expect(b!.to.pathNot.slice(-2)).toEqual(['^x/', '^y/']);
    expect(b!.comment).toContain('Exception: one two');
  });

  it('refuses an exception with no reason or to a rule that does not exist', () => {
    expect(() => buildRules([kernel, finance], packages, [{ rule: 'domain-pure', from: ['a.ts'], to: '^x/', reason: '' }])).toThrow('has no reason');
    expect(() => buildRules([kernel, finance], packages, [{ rule: 'no-such-rule', from: ['a.ts'], to: '^x/', reason: 'r' }])).toThrow('which is no rule');
    // An exception for a file the rule does not cover would apply the rule to it.
    expect(() => buildRules([kernel, finance], packages, [{ rule: 'app-no-server', from: ['apps/kernel/src/http.ts'], to: '^x/', reason: 'r' }])).toThrow('which the rule does not cover');
  });

  it('gives every listed exception a reason and an exact file list', () => {
    for (const e of EXCEPTIONS) {
      expect(e.reason.length).toBeGreaterThan(40);
      for (const f of e.from) expect(f).toMatch(/^(apps|packages|modules|e2e)\/[\w./-]+\.tsx?$/);
    }
  });
});
