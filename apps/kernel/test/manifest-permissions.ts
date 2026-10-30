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
import { notesManifest } from '@crove/mod-notes';
import { socialManifest } from '@crove/mod-social';
import { loadConfig } from '../src/config.ts';
import { moduleDefinitions } from '../src/kernel.ts';
import { orgPurgeCommand } from '../src/org-purge.ts';
import { numberReseedCommand } from '../src/restore-report.ts';
import { stripSqlComments } from './manifest-entities.ts';

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
  notes: { manifest: notesManifest, file: 'modules/notes/src/manifest.ts' },
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
// or `/*` inside a string, such as a URL, stays. It does not parse regular expression literals: approval.ts has none
// with a quote or a comment marker in it, and in the app's sources (appPermissionUses) one with a quote (audit.ts) can
// put it out of step for the rest of that file, which can hide a check there rather than invent one.
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
  const commands = [...moduleDefinitions(config).commands, orgPurgeCommand({ store: {} as never }), numberReseedCommand()];
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

// The functions whose job is to check a permission their caller passes (#1641): their own comparison names no key.
const PERMISSION_CHECKERS: ReadonlySet<string> = new Set(['function crove_kernel.ctx_has_permission', 'function crove_kernel.ctx_permission_entities']);
// The quoted literals of a SQL fragment ('...'::text included), with doubled quotes undone.
const sqlLiterals = (fragment: string): string[] => [...fragment.matchAll(/'((?:[^']|'')*)'/g)].map((m) => (m[1] as string).replaceAll("''", "'"));
const SQL_IDENT = /^[a-z_][a-z0-9_$]*$/i;

// The permissions a database function's body or a row-level security policy names (#1630, #1641), and what it names
// in a form this cannot attribute (#1641). A key is read from:
//   crove_kernel.ctx_has_permission('<key>');
//   a comparison of a permission column (role_permission.permission, p.permission): = '<key>', IN ('<key>', ...),
//   = ANY (ARRAY['<key>', ...]) and = ANY ('{<key>,...}'), with or without ::text casts as PostgreSQL deparses them;
//   in each of these, a PL/pgSQL variable instead of the literal, when the body assigns it literals (v := '<key>',
//   v text := '<key>', v text[] := ARRAY['<key>', ...]).
//   A literal compared the other way round ('<key>' = p.permission) is read too.
// Anything else that hands ctx_has_permission or a permission column a value (a parameter, $1, a variable assigned from
// a query, a subquery, IS DISTINCT FROM, CASE ... WHEN, a LIKE or a regular expression) is a problem, so a key cannot
// slip past the manifests; the functions of PERMISSION_CHECKERS, which compare with their own parameter, are the
// exception. SQL comments are left out first, so prose in a function body names nothing.
export function sqlPermissionUses(by: string, source: string): { uses: PermissionUse[]; problems: string[] } {
  const uses: PermissionUse[] = [];
  const problems: string[] = [];
  const text = stripSqlComments(source);
  // The literals each PL/pgSQL variable is assigned, in a declaration (v text := ..., v text DEFAULT ...) or a
  // statement (v := ...); a variable also assigned anything else (an expression, a query) is unknown (null).
  const vars = new Map<string, string[] | null>();
  for (const m of text.matchAll(/(?::=|\bDEFAULT\b)\s*([^;]*);/gi)) {
    // The variable is the first word of the statement before the operator, after the last keyword that opens one
    // (`IF c THEN v := ...`, `DECLARE v text := ...`); a declaration's type follows it.
    const at = m.index ?? 0;
    const head = text.slice(Math.max(text.lastIndexOf(';', at - 1), text.lastIndexOf('\n', at - 1)) + 1, at);
    const words = head.trim().split(/\s+/);
    const opener = words.map((w) => w.toUpperCase()).findLastIndex((w) => ['DECLARE', 'BEGIN', 'THEN', 'ELSE', 'LOOP'].includes(w));
    const name = (words[opener + 1] ?? '').toLowerCase();
    if (!SQL_IDENT.test(name)) continue;
    const rhs = (m[1] as string).trim();
    const literals = /^(?:'(?:[^']|'')*'(?:::[a-z_ ]+)?|ARRAY\s*\[\s*'[^\]]*\](?:::[a-z_ [\]]+)?)$/i.test(rhs) ? sqlLiterals(rhs) : null;
    const before = vars.get(name);
    vars.set(name, before === null || literals === null ? null : [...(before ?? []), ...literals]);
  }
  // Any other write makes a variable unknown: SELECT or FETCH ... INTO, FOR v IN, GET DIAGNOSTICS, and v = ... (PL/pgSQL
  // takes = as an assignment too).
  const unknown = [
    ...[...text.matchAll(/\bINTO\s+(?:STRICT\s+)?([a-z_][a-z0-9_$]*(?:\s*,\s*[a-z_][a-z0-9_$]*)*)/gi)].flatMap((m) => (m[1] as string).split(',')),
    ...[...text.matchAll(/\bFOR\s+([a-z_][a-z0-9_$]*)\s+IN\b/gi)].map((m) => m[1] as string),
    ...[...text.matchAll(/\bGET\s+(?:STACKED\s+)?DIAGNOSTICS\s+([a-z_][a-z0-9_$]*)/gi)].map((m) => m[1] as string),
    ...[...text.matchAll(/(?:^|[;\n]|\bTHEN\b|\bELSE\b|\bLOOP\b|\bBEGIN\b)\s*([a-z_][a-z0-9_$]*)\s*=(?!=)/gim)].map((m) => m[1] as string),
  ];
  for (const name of unknown) vars.set(name.trim().toLowerCase(), null);

  // The items of a SQL list at its top level: commas inside quotes or parentheses do not split.
  const items = (list: string): string[] => {
    const out: string[] = [];
    let depth = 0;
    let quoted = false;
    let item = '';
    for (const ch of list) {
      if (ch === "'") quoted = !quoted;
      else if (!quoted && ch === '(') depth++;
      else if (!quoted && ch === ')') depth--;
      if (!quoted && depth === 0 && ch === ',') {
        out.push(item);
        item = '';
      } else item += ch;
    }
    return [...out, item].map((i) => i.trim()).filter((i) => i !== '');
  };
  // Every item must be a literal (casts aside) or a variable the body assigns only literals; one that is not makes the
  // whole value unattributable, whatever literals sit beside it.
  const resolve = (what: string, value: string) => {
    const keys: string[] = [];
    for (const raw of items(value)) {
      const item = raw.replace(/^\(+|\)+$/g, '').replace(/(?:\)?::[a-z_ [\]]+)+$/i, '').replace(/^\(+|\)+$/g, '').trim();
      if (/^'(?:[^']|'')*'$/.test(item)) {
        keys.push(...sqlLiterals(item));
        continue;
      }
      const known = SQL_IDENT.test(item) ? vars.get(item.toLowerCase()) : null;
      if (!known) {
        if (!PERMISSION_CHECKERS.has(by)) problems.push(`${by} names a permission through ${what} ${value.trim()}, which this check cannot attribute to a key: write the key as a literal`);
        return;
      }
      keys.push(...known);
    }
    for (const key of keys) uses.push({ permission: key, by });
  };

  for (const m of text.matchAll(/ctx_has_permission\s*\(\s*([^()]*(?:\([^()]*\)[^()]*)*)\)/g)) resolve('ctx_has_permission(...)', m[1] as string);
  // A permission column, as written or as PostgreSQL deparses it: p.permission, (p.permission)::text.
  const column = String.raw`\bpermission\)?(?:::[a-z_ ]+)?`;
  // Where a permission column a form below read stands; any other comparison of one is a problem (the last loop).
  const read = new Set<number>();
  // = ANY (...), and = ANY ((ARRAY[...])::text[]) as PostgreSQL deparses an IN list in a policy.
  for (const m of text.matchAll(new RegExp(`${column}\\s*(?:=|<>|!=)\\s*ANY\\s*\\(\\s*\\(?\\s*(ARRAY\\s*\\[[^\\]]*\\]|'[^']*'|[a-z_][a-z0-9_$]*)`, 'gi'))) {
    read.add(m.index ?? 0);
    const list = m[1] as string;
    if (list.startsWith("'")) for (const key of (sqlLiterals(list)[0] ?? '').replace(/^\{|\}$/g, '').split(',').map((k) => k.trim().replace(/^"|"$/g, '')).filter(Boolean)) uses.push({ permission: key, by });
    else if (/^ARRAY/i.test(list)) resolve('= ANY (ARRAY[...])', list.replace(/^ARRAY\s*\[|\]$/gi, ''));
    else resolve('= ANY (...)', list);
  }
  for (const m of text.matchAll(new RegExp(`${column}\\s*(?:=|<>|!=)\\s*(?!\\s*ANY\\b)('(?:[^']|'')*'|[a-z_][a-z0-9_$.]*)`, 'gi'))) {
    read.add(m.index ?? 0);
    resolve('a comparison with', m[1] as string);
  }
  for (const m of text.matchAll(new RegExp(`${column}\\s+(?:NOT\\s+)?IN\\s*\\(([^)]*)\\)`, 'gi'))) {
    read.add(m.index ?? 0);
    resolve('IN (...)', m[1] as string);
  }
  // The other way round: '<key>' = p.permission.
  for (const m of text.matchAll(/(?<![\w$.])('(?:[^']|'')*'(?:::[a-z_ ]+)?|[a-z_][a-z0-9_$]*)\s*(?:=|<>|!=)\s*\(*\s*(?:[a-z_][a-z0-9_$]*\.)?permission\b/gi)) {
    resolve('a comparison with', m[1] as string);
  }
  for (const m of text.matchAll(new RegExp(`${column}\\s*(?:(?:NOT\\s+)?(?:I?LIKE|SIMILAR\\s+TO)\\b|!?~~?\\*?)`, 'gi'))) {
    read.add(m.index ?? 0);
    problems.push(`${by} matches a permission column by pattern (${m[0].trim()}), which this check cannot attribute to a key: compare with literals`);
  }
  // Any other comparison of a permission column: = $1, = (SELECT ...), = ANY ($1), IS DISTINCT FROM, CASE ... WHEN.
  for (const m of text.matchAll(new RegExp(`${column}\\s*(?:=|<>|!=|<|>|\\bIS\\s+(?:NOT\\s+)?DISTINCT\\b|\\b(?:NOT\\s+)?IN\\b|\\bWHEN\\b)`, 'gi'))) {
    if (read.has(m.index ?? 0) || PERMISSION_CHECKERS.has(by)) continue;
    problems.push(`${by} compares a permission column in a form this check cannot read (${m[0].trim()} ...): compare with literals`);
  }
  return { uses, problems };
}

// What the app's screens gate on (#1641): every check of a member's permissions in apps/app/src
// (`permissions.includes(...)` or `.indexOf(...)` on a list named `permissions`, as the app's gates are written; a check
// written another way is not seen) must pass a permission constant @crove/kernel-contract exports, so a
// renamed or retired key fails here or at typecheck. Like the screens' route permissions they are display gates, not
// checks (the server decides), so they are kept apart from staticPermissionUses(). The name must be imported from
// @crove/kernel-contract in that file (an alias is followed) and not declared there again; `contract` is the module the
// constants are read from.
export function appPermissionUses(files: ReadonlyArray<{ file: string; source: string }>, contract: Record<string, unknown>): { uses: PermissionUse[]; problems: string[] } {
  const uses: PermissionUse[] = [];
  const problems: string[] = [];
  for (const { file, source } of files) {
    const code = stripComments(source);
    // The names this file imports from the contract, each to the name the contract exports it under.
    const imported = new Map<string, string>();
    for (const m of code.matchAll(/\bimport\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]@crove\/kernel-contract['"]/g)) {
      for (const spec of (m[1] as string).split(',')) {
        const parts = spec.trim().replace(/^type\s+/, '').split(/\s+as\s+/);
        const exported = parts[0]?.trim();
        const local = (parts[1] ?? parts[0])?.trim();
        if (exported && local) imported.set(local, exported);
      }
    }
    for (const m of code.matchAll(/\bpermissions\??\.(?:includes|indexOf)\(\s*([^),]*)/g)) {
      const arg = (m[1] as string).trim();
      const exported = /^[A-Z][A-Z0-9_]*$/.test(arg) ? imported.get(arg) : undefined;
      const shadowed = new RegExp(`\\b(?:const|let|var|function|class)\\s+${arg.replace(/[^A-Za-z0-9_]/g, '')}\\b`).test(code);
      const value = exported && !shadowed ? contract[exported] : undefined;
      if (typeof value !== 'string') {
        problems.push(`${file}: a permission check passes ${arg}; pass a permission constant imported from @crove/kernel-contract`);
        continue;
      }
      uses.push({ permission: value, by: `${file} (${arg})` });
    }
  }
  return { uses, problems };
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
