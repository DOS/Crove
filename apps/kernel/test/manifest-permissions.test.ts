// Module manifests' permissions, unit part (plan §5.2, §10 G3, #1630): every permission a command or the approval policy
// names is declared in the manifest of the module its key names, with the risk of those commands, and the contract's
// ROLE_PERMISSIONS lists exactly the declared permissions a role grants. The seeded role_permission rows and the
// database's functions are checked in manifest.db.test.ts. Planted mismatches show each check fails.
import { describe, expect, it } from 'vitest';
import { ROLE_PERMISSIONS, columns, defineModule, type ModuleManifest } from '@crove/kernel-contract';
import { MODULE_MANIFESTS, approvalPolicyUses, permissionProblems, sqlPermissionUses, staticPermissionUses, stripComments, type Manifests, type PermissionUse } from './manifest-permissions.ts';

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
    finance: { manifest: defineModule({ id: 'finance', tables: { crove_finance: { t: columns(['id']) } }, permissions }), file: 'finance.ts' },
    kernel: { manifest: defineModule({ id: 'kernel', tables: {}, permissions: [] }), file: 'kernel.ts' },
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
    expect(permissionProblems(finance([unlock]), { uses: [use, ...sqlPermissionUses('function crove_finance.f', "IF NOT crove_kernel.ctx_has_permission('finance.bank.export') THEN")] })).toEqual([
      'function crove_finance.f names finance.bank.export, which no manifest declares: declare it in finance.ts',
    ]);
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
    const kernelHoldsIt: Manifests = { ...finance([unlock]), kernel: { manifest: defineModule({ id: 'kernel', tables: {}, permissions: [unlock] }), file: 'kernel.ts' } };
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

  it('reads both forms a database function names a permission in', () => {
    expect(sqlPermissionUses('f', "crove_kernel.ctx_has_permission('finance.period.unlock'::text) AND p.permission = 'finance.proposal.approve'").map((u) => u.permission)).toEqual([
      'finance.period.unlock',
      'finance.proposal.approve',
    ]);
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
