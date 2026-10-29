// Module manifests' permissions, unit part (plan §5.2, §10 G3, #1630): every permission a command or the approval policy
// names is declared in the manifest of the module its key names, with the risk of those commands, and the contract's
// ROLE_PERMISSIONS lists exactly the declared permissions a role grants. The seeded role_permission rows and the
// database's functions are checked in manifest.db.test.ts; the SQL forms the scan reads, and the app's permission
// checks (#1641), here. Planted mismatches show each check fails.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as contract from '@crove/kernel-contract';
import { ROLE_PERMISSIONS, columns, defineModule, type ModuleManifest } from '@crove/kernel-contract';
import {
  MODULE_MANIFESTS,
  appPermissionUses,
  approvalPolicyUses,
  permissionProblems,
  sqlPermissionUses,
  staticPermissionUses,
  stripComments,
  type Manifests,
  type PermissionUse,
} from './manifest-permissions.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

// The app's sources (apps/app/src), tests left out.
function appSources(dir = join(ROOT, 'apps/app/src'), out: Array<{ file: string; source: string }> = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) appSources(path, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push({ file: relative(ROOT, path).replaceAll('\\', '/'), source: readFileSync(path, 'utf8') });
  }
  return out;
}

describe('module manifests declare their permissions (#1630)', () => {
  it('declares every permission a command or the approval policy names, with the risk of its commands', () => {
    const { uses, problems } = staticPermissionUses();
    expect(problems).toEqual([]);
    // The three gates on main: kernel.proposal.approve and its bulk form, finance.period.unlock, and the ledger policy.
    expect(uses.map((u) => `${u.by}: ${u.permission}`).sort()).toEqual([
      'command finance.period.unlock: finance.period.unlock',
      'command kernel.proposal.approve: finance.proposal.approve',
      'command kernel.proposal.approve_many: finance.proposal.approve',
      'the approval policy (LEDGER_APPROVE_PERMISSION): finance.proposal.approve',
    ]);
    expect(permissionProblems(MODULE_MANIFESTS, { uses })).toEqual([]);
  });

  it('keeps the contract list of granted permissions equal to the declared ones a role grants', () => {
    const granted = Object.values(MODULE_MANIFESTS)
      .flatMap(({ manifest }) => manifest.permissions)
      .filter((p) => p.defaultRoles.length > 0)
      .map((p) => p.key)
      .sort();
    expect([...ROLE_PERMISSIONS].sort()).toEqual(granted);
  });
});

describe('permissionProblems() on planted mismatches', () => {
  const finance = (permissions: ModuleManifest['permissions']): Manifests => ({
    finance: { manifest: defineModule({ id: 'finance', dependsOn: ['kernel'], tables: { crove_finance: { t: columns(['id']) } }, permissions, routes: [], nav: [], entities: [] }), file: 'finance.ts' },
    kernel: { manifest: defineModule({ id: 'kernel', dependsOn: [], tables: {}, permissions: [], routes: [], nav: [], entities: [] }), file: 'kernel.ts' },
  });
  const unlock = { key: 'finance.period.unlock', risk: 'R3', defaultRoles: ['finance.chief_accountant'] } as const;
  const use: PermissionUse = { permission: 'finance.period.unlock', by: 'command finance.period.unlock', risk: 'R3' };
  const grant = { role_key: 'finance.chief_accountant', permission: 'finance.period.unlock' };

  it('passes when the declaration, the uses and the rows agree', () => {
    expect(permissionProblems(finance([unlock]), { uses: [use], grants: [grant] })).toEqual([]);
  });

  it('fails on a command, policy or function that names an undeclared permission', () => {
    expect(permissionProblems(finance([unlock]), { uses: [use, { permission: 'finance.invoice.post', by: 'command finance.invoice.post', risk: 'R3' }] })).toEqual([
      'command finance.invoice.post names finance.invoice.post, which no manifest declares: declare it in finance.ts',
    ]);
    expect(permissionProblems(finance([]), { uses: [{ permission: 'finance.period.unlock', by: 'the approval policy (X)' }] })).toEqual([
      'the approval policy (X) names finance.period.unlock, which no manifest declares: declare it in finance.ts',
    ]);
    expect(permissionProblems(finance([unlock]), { uses: [use, ...sqlPermissionUses('function crove_finance.f', "IF NOT crove_kernel.ctx_has_permission('finance.bank.export') THEN").uses] })).toEqual([
      'function crove_finance.f names finance.bank.export, which no manifest declares: declare it in finance.ts',
    ]);
    // A planted permission IN ('<undeclared>') in a function body (#1641).
    expect(
      permissionProblems(finance([unlock]), { uses: [use, ...sqlPermissionUses('function crove_finance.g', "WHERE p.permission IN ('finance.period.unlock', 'finance.ledger.erase')").uses] }),
    ).toEqual(['function crove_finance.g names finance.ledger.erase, which no manifest declares: declare it in finance.ts']);
  });

  it('fails on a seeded row of an undeclared permission, or default roles that differ from the rows', () => {
    expect(permissionProblems(finance([unlock]), { uses: [use], grants: [grant, { role_key: 'finance.accountant', permission: 'finance.bank.export' }] })).toEqual([
      'crove_kernel.role_permission (finance.accountant, finance.bank.export): no manifest declares finance.bank.export; declare it in finance.ts',
    ]);
    expect(permissionProblems(finance([unlock]), { uses: [use], grants: [grant, { role_key: 'finance.accountant', permission: 'finance.period.unlock' }] })).toEqual([
      'crove_kernel.role_permission (finance.accountant, finance.period.unlock): finance.ts does not list finance.accountant among the default roles of finance.period.unlock',
    ]);
    expect(permissionProblems(finance([unlock]), { uses: [use], grants: [] })).toEqual([
      'finance.ts: finance.period.unlock lists the default role finance.chief_accountant, but no crove_kernel.role_permission row grants it',
    ]);
  });

  it('fails on a declared risk other than its commands, a key outside its module, a duplicate, or a permission nothing checks', () => {
    expect(permissionProblems(finance([{ ...unlock, risk: 'R2' }]), { uses: [use] })).toEqual([
      'finance.ts: finance.period.unlock is declared R2, but the highest risk of the commands that name it is R3',
    ]);
    const kernelHoldsIt: Manifests = { ...finance([unlock]), kernel: { manifest: defineModule({ id: 'kernel', dependsOn: [], tables: {}, permissions: [unlock], routes: [], nav: [], entities: [] }), file: 'kernel.ts' } };
    expect(permissionProblems(kernelHoldsIt, { uses: [use] })).toEqual([
      'kernel.ts: finance.period.unlock belongs to the manifest of module finance, not kernel',
      'finance.period.unlock is declared in finance.ts and in kernel.ts',
    ]);
    expect(permissionProblems(finance([{ ...unlock, defaultRoles: ['finance.viewer', 'finance.chief_accountant'] }]), { uses: [use] })).toEqual([
      'finance.ts: finance.period.unlock: list each default role once, sorted',
    ]);
    expect(permissionProblems(finance([unlock]), { uses: [], grants: [grant] })).toEqual([
      'finance.ts: finance.period.unlock is declared, but no command, approval policy or database function checks it',
    ]);
  });

  it('reads every form a database function or policy names a permission in (#1641)', () => {
    const keys = (text: string) => {
      const read = sqlPermissionUses('f', text);
      expect(read.problems, text).toEqual([]);
      return read.uses.map((u) => u.permission);
    };
    expect(keys("crove_kernel.ctx_has_permission('finance.period.unlock'::text) AND p.permission = 'finance.proposal.approve'")).toEqual([
      'finance.period.unlock',
      'finance.proposal.approve',
    ]);
    expect(keys("p.permission IN ('a.b.c', 'a.b.d')")).toEqual(['a.b.c', 'a.b.d']);
    expect(keys("p.permission NOT IN ('a.b.c')")).toEqual(['a.b.c']);
    // As PostgreSQL deparses IN in a policy, and an array literal.
    expect(keys("((p.permission)::text = ANY ((ARRAY['a.b.c'::character varying, 'a.b.d'::character varying])::text[]))")).toEqual(['a.b.c', 'a.b.d']);
    expect(keys(`p.permission = ANY ('{a.b.c,"a.b.d"}'::text[])`)).toEqual(['a.b.c', 'a.b.d']);
    // Keys held in variables the body assigns literals.
    const body = [
      'DECLARE',
      "  v_unlock text := 'a.b.c';",
      "  v_keys text[] DEFAULT ARRAY['a.b.d', 'a.b.e'];",
      'BEGIN',
      "  IF x THEN v_unlock := 'a.b.f'; END IF;",
      '  IF crove_kernel.ctx_has_permission(v_unlock) THEN RETURN 1; END IF;',
      '  PERFORM 1 FROM crove_kernel.role_permission p WHERE p.permission = ANY (v_keys);',
      'END',
    ].join('\n');
    expect(keys(body).sort()).toEqual(['a.b.c', 'a.b.d', 'a.b.e', 'a.b.f']);
  });

  it('fails on a permission named in a form it cannot attribute to a key (#1641)', () => {
    const problems = (by: string, text: string) => sqlPermissionUses(by, text).problems;
    expect(problems('function crove_kernel.f', 'SELECT crove_kernel.ctx_has_permission(p_key)')).toEqual([
      'function crove_kernel.f names a permission through ctx_has_permission(...) p_key, which this check cannot attribute to a key: write the key as a literal',
    ]);
    expect(problems('function crove_kernel.f', 'DECLARE v text; BEGIN SELECT k INTO v FROM t; v := lower(v); PERFORM 1 WHERE p.permission = v; END')).toHaveLength(1);
    expect(problems('policy crove_finance.t.p', "p.permission LIKE 'finance.%'")).toEqual([
      'policy crove_finance.t.p matches a permission column by pattern (permission LIKE), which this check cannot attribute to a key: compare with literals',
    ]);
    expect(problems('function crove_kernel.f', 'p.permission IN (SELECT k FROM t)')).toHaveLength(1);
    // The checker itself compares with its parameter, by design.
    expect(problems('function crove_kernel.ctx_has_permission', 'p.permission = p_permission')).toEqual([]);
  });
});

describe("the app's permission checks (#1641)", () => {
  it('names only permission constants, all of them declared', () => {
    const { uses, problems } = appPermissionUses(appSources(), contract);
    expect(problems).toEqual([]);
    expect(uses.map((u) => u.permission).sort()).toEqual(['finance.period.unlock', 'finance.proposal.approve']);
    expect(permissionProblems(MODULE_MANIFESTS, { uses: [...staticPermissionUses().uses, ...uses] })).toEqual([]);
  });

  it('fails on a key written in the app, and on a constant of an undeclared key', () => {
    const literal = appPermissionUses([{ file: 'apps/app/src/lib/x.ts', source: "permissions.includes('finance.invoice.post')" }], contract);
    expect(literal.problems).toEqual(["apps/app/src/lib/x.ts: a permission check passes 'finance.invoice.post'; pass a permission constant @crove/kernel-contract exports"]);
    // A constant with a key no manifest declares (a stand-in for the contract module).
    const planted = appPermissionUses([{ file: 'apps/app/src/lib/y.ts', source: 'org.permissions?.includes(INVOICE_POST_PERMISSION)' }], { INVOICE_POST_PERMISSION: 'finance.invoice.post' });
    expect(planted.problems).toEqual([]);
    expect(permissionProblems(MODULE_MANIFESTS, { uses: [...staticPermissionUses().uses, ...planted.uses] })).toEqual([
      'apps/app/src/lib/y.ts (INVOICE_POST_PERMISSION) names finance.invoice.post, which no manifest declares: declare it in modules/finance/src/manifest.ts',
    ]);
    // A comment is not a check.
    expect(appPermissionUses([{ file: 'z.ts', source: "// permissions.includes('finance.invoice.post')" }], contract)).toEqual({ uses: [], problems: [] });
  });
});

describe('reading the approval policy source', () => {
  const policy = [
    'interface CommandPolicy {',
    '  permission: string | null;',
    '}',
    "const LEDGER: CommandPolicy = { roles: ['owner', 'admin'], permission: LEDGER_APPROVE_PERMISSION, fourEyes: true };",
    'const NOBODY: CommandPolicy = { roles: [], permission: null, fourEyes: true };',
  ].join('\n');
  const ledger = { permission: 'finance.proposal.approve', by: 'the approval policy (LEDGER_APPROVE_PERMISSION)' };

  it('does not count a permission in a comment', () => {
    const commented = [
      policy,
      "// const DRAFT: CommandPolicy = { roles: [], permission: 'finance.invoice.post', fourEyes: true };",
      "/* const OLD = { permission: 'finance.bank.export' }; */",
      "const LINK = 'https://example.test/a//b'; // permission: 'finance.after.url'",
    ].join('\n');
    expect(approvalPolicyUses(commented)).toEqual({ uses: [ledger], problems: [] });
  });

  it('counts a permission in code, in any field order or after a spread', () => {
    const more = [policy, "const P = { ...LEDGER, permission: 'finance.invoice.post' };", 'const Q = { fourEyes: true, permission: SOMETHING_UNEXPORTED, roles: [] };'].join('\n');
    expect(approvalPolicyUses(more)).toEqual({
      uses: [ledger, { permission: 'finance.invoice.post', by: "the approval policy ('finance.invoice.post')" }],
      problems: ["packages/kernel/src/approval.ts: a CommandPolicy's permission SOMETHING_UNEXPORTED is neither a string, null, nor a string constant @crove/kernel exports"],
    });
  });

  it('blanks comments but keeps strings and template literals that hold comment markers', () => {
    const source = ["a = 'x//y'; // gone", 'b = "/*keep*/"; /* gone', "too */ c = `t // ${d /* gone */ + '}'} //t`;"].join('\n');
    const stripped = stripComments(source);
    expect(stripped.split('\n')).toHaveLength(3);
    expect(stripped).toContain("a = 'x//y';");
    expect(stripped).toContain('b = "/*keep*/";');
    expect(stripped).toContain("c = `t // ${d            + '}'} //t`;");
    expect(stripped).not.toContain('gone');
  });
});
