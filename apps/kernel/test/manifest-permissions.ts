// Module manifests' permissions against what grants and checks them (plan §5.2, §10 G3, #1630). permissionProblems() is
// pure: manifest-permissions.test.ts feeds it the commands and the approval policy, and planted mismatches;
// manifest.db.test.ts adds the role_permission rows the migrations seed and the permissions the database's functions and
// policies name. Each problem is one line naming what to change.
import { readFileSync } from 'node:fs';
import * as kernel from '@crove/kernel';
import { LEDGER_APPROVE_PERMISSION, kernelManifest } from '@crove/kernel';
import type { ModuleManifest, PermissionDeclaration } from '@crove/kernel-contract';
import { crmManifest } from '@crove/mod-crm';
import { financeManifest } from '@crove/mod-finance';
import { socialManifest } from '@crove/mod-social';
import { loadConfig } from '../src/config.ts';
import { moduleDefinitions } from '../src/kernel.ts';
import { orgPurgeCommand } from '../src/org-purge.ts';

export type Risk = PermissionDeclaration['risk'];
const RANK: Record<Risk, number> = { R0: 0, R1: 1, R2: 2, R3: 3 };
// The shape crove_kernel.role_permission's CHECK and the runtime's register() accept.
const KEY = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

export type Manifests = Record<string, { manifest: ModuleManifest; file: string }>;

export const MODULE_MANIFESTS: Manifests = {
  kernel: { manifest: kernelManifest, file: 'packages/kernel/src/manifest.ts' },
  finance: { manifest: financeManifest, file: 'modules/finance/src/manifest.ts' },
  social: { manifest: socialManifest, file: 'modules/social/src/manifest.ts' },
  crm: { manifest: crmManifest, file: 'modules/crm/src/manifest.ts' },
};

// Something that checks a permission: a command (with its risk), the approval policy, a database function or policy.
export interface PermissionUse {
  permission: string;
  by: string;
  risk?: Risk;
}

export interface Grant {
  role_key: string;
  permission: string;
}

const APPROVAL_SOURCE = new URL('../../../packages/kernel/src/approval.ts', import.meta.url);

// What names a permission in TypeScript: every command the deployment registers with every module on (and the purge
// command the kernel registers on its own), and every CommandPolicy literal of the approval policy. The policy table is
// not exported (approval.ts is a protected path), so its literals are read from the source: each permission there is
// null or an exported constant of @crove/kernel; anything else is a problem, so a new one cannot slip past.
export function staticPermissionUses(): { uses: PermissionUse[]; problems: string[] } {
  const uses: PermissionUse[] = [];
  const problems: string[] = [];
  const config = loadConfig({ DATABASE_URL: 'postgres://localhost/x', AUTH_JWT_SECRET: 'unit-test-jwt-secret-0123456789abcdef', AUTH_ISSUER: 'crove-auth' });
  const commands = [...moduleDefinitions(config).commands, orgPurgeCommand({ store: {} as never })];
  for (const c of commands) if (c.permission !== undefined) uses.push({ permission: c.permission, by: `command ${c.name}`, risk: c.risk });

  const source = readFileSync(APPROVAL_SOURCE, 'utf8');
  const literals = [...source.matchAll(/\broles:\s*\[[^\]]*\],\s*permission:\s*([^,}\s]+)/g)].map((m) => m[1] as string);
  if (literals.length < 2) problems.push(`packages/kernel/src/approval.ts: found ${literals.length} CommandPolicy literals ({ roles: [...], permission: ... }), expected the ledger's and NOBODY; update staticPermissionUses()`);
  for (const value of literals) {
    if (value === 'null') continue;
    const quoted = /^'([^']*)'$/.exec(value);
    const resolved = quoted ? quoted[1] : (kernel as Record<string, unknown>)[value];
    if (typeof resolved !== 'string') {
      problems.push(`packages/kernel/src/approval.ts: a CommandPolicy's permission ${value} is neither a string, null, nor a string constant @crove/kernel exports`);
      continue;
    }
    uses.push({ permission: resolved, by: `the approval policy (${value})` });
  }
  if (!uses.some((u) => u.permission === LEDGER_APPROVE_PERMISSION && u.by.startsWith('the approval policy'))) {
    problems.push(`packages/kernel/src/approval.ts: no CommandPolicy literal names LEDGER_APPROVE_PERMISSION (${LEDGER_APPROVE_PERMISSION}); update staticPermissionUses()`);
  }
  return { uses, problems };
}

// The permissions a database function's body or a row-level security policy names, through
// crove_kernel.ctx_has_permission('...') or a comparison with role_permission.permission.
export function sqlPermissionUses(by: string, text: string): PermissionUse[] {
  const out: PermissionUse[] = [];
  for (const m of text.matchAll(/ctx_has_permission\(\s*'([^']+)'/g)) out.push({ permission: m[1] as string, by });
  for (const m of text.matchAll(/\bpermission\s*=\s*'([^']+)'/g)) out.push({ permission: m[1] as string, by });
  return out;
}

// The problems between the manifests and what uses or grants their permissions:
// - a declaration whose key is malformed, does not start with its module's id, is declared twice, or whose default
//   roles are unsorted or repeated, or a manifest whose permissions are not sorted by key;
// - a use (command, approval policy, database function) of a permission no manifest declares;
// - a declared risk other than the highest risk of the commands that name the permission;
// - with `grants` (the seeded role_permission rows): a row of an undeclared permission, a row the declaration does not
//   list, or a default role with no row; and a declared permission nothing checks.
export function permissionProblems(manifests: Manifests, input: { uses: readonly PermissionUse[]; grants?: readonly Grant[] }): string[] {
  const problems: string[] = [];
  const declared = new Map<string, { decl: PermissionDeclaration; module: string; file: string }>();
  for (const [module, { manifest, file }] of Object.entries(manifests)) {
    const keys = manifest.permissions.map((p) => p.key);
    if (keys.join('\n') !== [...keys].sort().join('\n')) problems.push(`${file}: sort permissions by key`);
    for (const decl of manifest.permissions) {
      if (!KEY.test(decl.key)) problems.push(`${file}: ${decl.key} is not <module>.<name>`);
      else if (decl.key.split('.')[0] !== manifest.id) problems.push(`${file}: ${decl.key} belongs to the manifest of module ${decl.key.split('.')[0]}, not ${manifest.id}`);
      const roles = [...decl.defaultRoles];
      if (roles.join('\n') !== [...new Set(roles)].sort().join('\n')) problems.push(`${file}: ${decl.key}: list each default role once, sorted`);
      const earlier = declared.get(decl.key);
      if (earlier) problems.push(`${decl.key} is declared in ${earlier.file} and in ${file}`);
      else declared.set(decl.key, { decl, module, file });
    }
  }
  const owner = (permission: string) => manifests[permission.split('.')[0] as string]?.file ?? `the manifest of module ${permission.split('.')[0]}`;

  for (const use of input.uses) {
    if (!declared.has(use.permission)) problems.push(`${use.by} names ${use.permission}, which no manifest declares: declare it in ${owner(use.permission)}`);
  }
  for (const [key, { decl, file }] of declared) {
    const risks = input.uses.filter((u) => u.permission === key && u.risk !== undefined).map((u) => u.risk as Risk);
    if (risks.length === 0) continue;
    const highest = risks.reduce((a, b) => (RANK[b] > RANK[a] ? b : a));
    if (decl.risk !== highest) problems.push(`${file}: ${key} is declared ${decl.risk}, but the highest risk of the commands that name it is ${highest}`);
  }

  if (input.grants) {
    const seeded = new Set(input.grants.map((g) => `${g.role_key} ${g.permission}`));
    for (const g of input.grants) {
      const entry = declared.get(g.permission);
      if (!entry) problems.push(`crove_kernel.role_permission (${g.role_key}, ${g.permission}): no manifest declares ${g.permission}; declare it in ${owner(g.permission)}`);
      else if (!(entry.decl.defaultRoles as readonly string[]).includes(g.role_key)) problems.push(`crove_kernel.role_permission (${g.role_key}, ${g.permission}): ${entry.file} does not list ${g.role_key} among the default roles of ${g.permission}`);
    }
    for (const [key, { decl, file }] of declared) {
      for (const role of decl.defaultRoles) if (!seeded.has(`${role} ${key}`)) problems.push(`${file}: ${key} lists the default role ${role}, but no crove_kernel.role_permission row grants it`);
      if (!input.uses.some((u) => u.permission === key)) problems.push(`${file}: ${key} is declared, but no command, approval policy or database function checks it`);
    }
  }
  return problems;
}
