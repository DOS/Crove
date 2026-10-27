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

type Risk = PermissionDeclaration['risk'];
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

// The source with every comment blanked out (newlines kept), so a `permission:` in a comment is not read as code. A
// small scanner rather than a regex: it skips string and template literals (and the code inside `${...}`), so a `//`
// or `/*` inside a string, such as a URL, stays. It does not parse regular expression literals; approval.ts has none
// with a quote or a comment marker in it.
export function stripComments(source: string): string {
  let out = '';
  // Open template literals and, inside each `${`, the depth of braces since it opened.
  const stack: Array<'template' | number> = [];
  const blank = (text: string) => text.replace(/[^\n]/g, ' ');
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    const next = source[i + 1];
    const top = stack.at(-1);
    if (top === 'template') {
      if (ch === '\\') {
        out += source.slice(i, i + 2);
        i += 2;
      } else if (ch === '`') {
        stack.pop();
        out += ch;
        i += 1;
      } else if (ch === '$' && next === '{') {
        stack.push(0);
        out += '${';
        i += 2;
      } else {
        out += ch;
        i += 1;
      }
      continue;
    }
    if (ch === '/' && next === '/') {
      const stop = source.indexOf('\n', i);
      const until = stop === -1 ? source.length : stop;
      out += blank(source.slice(i, until));
      i = until;
    } else if (ch === '/' && next === '*') {
      const stop = source.indexOf('*/', i + 2);
      const until = stop === -1 ? source.length : stop + 2;
      out += blank(source.slice(i, until));
      i = until;
    } else if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < source.length && source[j] !== ch && source[j] !== '\n') j += source[j] === '\\' ? 2 : 1;
      out += source.slice(i, j + 1);
      i = j + 1;
    } else if (ch === '`') {
      stack.push('template');
      out += ch;
      i += 1;
    } else {
      if (typeof top === 'number') {
        if (ch === '{') stack[stack.length - 1] = top + 1;
        else if (ch === '}') {
          if (top === 0) stack.pop();
          else stack[stack.length - 1] = top - 1;
        }
      }
      out += ch;
      i += 1;
    }
  }
  return out;
}

// What names a permission in TypeScript: every command the deployment registers with every module on (and the purge
// command the kernel registers on its own), and every CommandPolicy of the approval policy (approvalPolicyUses()).
export function staticPermissionUses(): { uses: PermissionUse[]; problems: string[] } {
  const uses: PermissionUse[] = [];
  const config = loadConfig({ DATABASE_URL: 'postgres://localhost/x', AUTH_JWT_SECRET: 'unit-test-jwt-secret-0123456789abcdef', AUTH_ISSUER: 'crove-auth' });
  const commands = [...moduleDefinitions(config).commands, orgPurgeCommand({ store: {} as never })];
  for (const c of commands) if (c.permission !== undefined) uses.push({ permission: c.permission, by: `command ${c.name}`, risk: c.risk });
  const policy = approvalPolicyUses(readFileSync(APPROVAL_SOURCE, 'utf8'));
  return { uses: [...uses, ...policy.uses], problems: policy.problems };
}

// The permissions the approval policy's source names. The policy table is not exported (approval.ts is a protected
// path), so its source is read: every `permission:` in its code (comments are skipped), in any field order or after a
// spread, is the type `string` (the interface field and a parameter), null, a quoted key or a string constant
// @crove/kernel exports; anything else is a problem, so a new one cannot slip past.
export function approvalPolicyUses(source: string): { uses: PermissionUse[]; problems: string[] } {
  const uses: PermissionUse[] = [];
  const problems: string[] = [];
  const values = [...stripComments(source).matchAll(/\bpermission:\s*([^\s,;)}]+)/g)].map((m) => m[1] as string).filter((v) => v !== 'string');
  if (values.length < 2) problems.push(`packages/kernel/src/approval.ts: found ${values.length} CommandPolicy permissions, expected the ledger's and NOBODY's; update staticPermissionUses()`);
  for (const value of values) {
    if (value === 'null') continue;
    const quoted = /^'([^']*)'$/.exec(value);
    const resolved = quoted ? quoted[1] : (kernel as Record<string, unknown>)[value];
    if (typeof resolved !== 'string') {
      problems.push(`packages/kernel/src/approval.ts: a CommandPolicy's permission ${value} is neither a string, null, nor a string constant @crove/kernel exports`);
      continue;
    }
    uses.push({ permission: resolved, by: `the approval policy (${value})` });
  }
  if (!uses.some((u) => u.permission === LEDGER_APPROVE_PERMISSION)) {
    problems.push(`packages/kernel/src/approval.ts: no CommandPolicy names LEDGER_APPROVE_PERMISSION (${LEDGER_APPROVE_PERMISSION}); update staticPermissionUses()`);
  }
  return { uses, problems };
}

// The permissions the manifests' screens name (#1652): a screen that needs one beyond membership. They are not
// checks (the server checks every query and command the screen calls), so they stay out of staticPermissionUses(), where
// they would count as a use of a permission nothing enforces.
export function routePermissionUses(manifests: Manifests): PermissionUse[] {
  return Object.values(manifests).flatMap(({ manifest }) =>
    manifest.routes.flatMap((route) => (route.permission === undefined ? [] : [{ permission: route.permission, by: `screen /o/$slug/${route.path} of ${manifest.id}` }])),
  );
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
