// The lock order of an org's member rows and its tenant row (#1943, from the review of #1939): member rows first, then
// the tenant row. Every membership change (a role revoke, a member's removal or demotion) locks the member's row, then
// the chief accountant keep guard locks the tenant row FOR NO KEY UPDATE (#1922, #1933); purchase postings hold the
// tenant row FOR SHARE (modules/finance/src/record.ts) and tenant-setting commands UPDATE it. No cycle exists while
// nothing locks a member or position row after the tenant row in one transaction. This pins it where the locks are
// taken:
// - SQL: the newest definition of every function in supabase/migrations locks no tenant_member or position row (FOR
//   UPDATE, NO KEY UPDATE, SHARE, KEY SHARE, or an INSERT, UPDATE or DELETE of one) after it locks or updates the
//   tenant row, but for the functions on SQL_AFTER_TENANT with their reason;
// - TypeScript: every command source that locks or updates the tenant row is on TS_TENANT_LOCKS, with a reason that
//   says why it locks no member or position row afterwards, so a new one is read against this order before it lands.
// What it does not see: a lock taken in another function or trigger the first one calls after the tenant row.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const MIGRATIONS = join(ROOT, 'supabase', 'migrations');

// Functions allowed to lock a member or position row after the tenant row, each with its reason.
const SQL_AFTER_TENANT: Readonly<Record<string, string>> = {
  'crove_kernel.org_purge':
    "locks the tenant row FOR UPDATE, then deletes an offboarding org's chart and members; the keep guard lets every org that is not active through before its lock, so no member change waits on the tenant row there (#1933)",
};

// Command sources that lock or update the tenant row, with why no member or position row is locked after it.
const TS_TENANT_LOCKS: Readonly<Record<string, string>> = {
  'packages/kernel/src/approval-preset.ts': 'the preset switch locks the tenant row FOR UPDATE, then only reads the chief accountants (no lock) and updates the tenant row',
  'packages/kernel/src/offboarding.ts': 'offboarding locks and updates the tenant row; it touches no member or position row',
  'packages/kernel/src/org-address.ts': "the org's address and contact email: an UPDATE of the tenant row only",
  'packages/kernel/src/tax-code.ts': "the org's tax code and VAT filing period: an UPDATE of the tenant row only",
  'modules/finance/src/missing-invoices.ts': "the missing-invoice reminder day: an UPDATE of the tenant row only",
  'modules/finance/src/record.ts': "a purchase posting reads the org's tax code FOR SHARE; it writes ledger rows, never a member or position row",
};

// The newest definition of each SQL function (name and argument list) across the migrations, with its file.
function newestFunctions(files: ReadonlyArray<{ name: string; text: string }>): Map<string, { file: string; body: string }> {
  const out = new Map<string, { file: string; body: string }>();
  const definition = /CREATE (?:OR REPLACE )?FUNCTION\s+([a-z_]+\.[a-z_0-9]+)\s*\(([^)]*)\)[\s\S]*?\$\$([\s\S]*?)\$\$/gi;
  for (const { name, text } of files) {
    for (const m of text.matchAll(definition)) {
      const args = (m[2] as string).replace(/\s+/g, ' ').trim();
      out.set(`${m[1] as string}(${args})`, { file: name, body: m[3] as string });
    }
  }
  return out;
}

const TENANT_LOCK = /FROM\s+crove_kernel\.tenant\b(?:(?!;)[\s\S])*?FOR\s+(?:NO\s+KEY\s+UPDATE|UPDATE|SHARE)\b|UPDATE\s+crove_kernel\.tenant\b/gi;
const MEMBER_LOCK =
  /FROM\s+crove_kernel\.(?:tenant_member|position)\b(?:(?!;)[\s\S])*?FOR\s+(?:NO\s+KEY\s+UPDATE|UPDATE|SHARE|KEY\s+SHARE)\b|(?:UPDATE|DELETE\s+FROM|INSERT\s+INTO)\s+crove_kernel\.(?:tenant_member|position)\b/gi;

// The statement that locks a member or position row after the first lock of the tenant row in a function body, or null.
function memberLockAfterTenant(body: string): string | null {
  const code = body.replace(/--[^\n]*/g, '');
  TENANT_LOCK.lastIndex = 0;
  const tenant = TENANT_LOCK.exec(code);
  if (!tenant) return null;
  MEMBER_LOCK.lastIndex = tenant.index + tenant[0].length;
  const member = MEMBER_LOCK.exec(code);
  return member ? member[0].replace(/\s+/g, ' ') : null;
}

// Whether a TypeScript source locks or updates the tenant row through Kysely.
function locksTenantRow(source: string): boolean {
  const update = /updateTable\('crove_kernel\.tenant'\)/.test(source);
  const lock = [...source.matchAll(/selectFrom\('crove_kernel\.tenant'\)([\s\S]*?)\.execute/g)].some((m) => /\.for(?:Update|NoKeyUpdate|Share)\(\)/.test(m[1] as string));
  return update || lock;
}

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'generated' || name === 'node_modules' ? [] : sources(path);
    return /\.ts$/.test(name) && !name.endsWith('.d.ts') ? [path] : [];
  });
}

const sourceRoots = (): string[] =>
  ['packages', 'modules'].flatMap((top) =>
    readdirSync(join(ROOT, top))
      .map((pkg) => join(ROOT, top, pkg, 'src'))
      .filter((dir) => statSync(dir, { throwIfNoEntry: false })?.isDirectory()),
  ).concat([join(ROOT, 'apps', 'kernel', 'src')]);

describe('lock order: member rows, then the tenant row (#1943)', () => {
  const migrations = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => ({ name, text: readFileSync(join(MIGRATIONS, name), 'utf8') }));

  it('no SQL function locks a member or position row after the tenant row, but those listed', () => {
    const found: string[] = [];
    for (const [fn, { file, body }] of newestFunctions(migrations)) {
      const statement = memberLockAfterTenant(body);
      const name = fn.slice(0, fn.indexOf('('));
      if (statement && !Object.hasOwn(SQL_AFTER_TENANT, name)) found.push(`${fn} (${file}) locks a member or position row after the tenant row: ${statement}`);
    }
    expect(found).toEqual([]);
  });

  it('lists only functions that still lock in that order', () => {
    const functions = newestFunctions(migrations);
    const stale = Object.keys(SQL_AFTER_TENANT).filter(
      (name) => ![...functions].some(([fn, { body }]) => fn.startsWith(`${name}(`) && memberLockAfterTenant(body) !== null),
    );
    expect(stale).toEqual([]);
  });

  it('lists every command source that locks or updates the tenant row, and only those', () => {
    const locking = sourceRoots()
      .flatMap(sources)
      .filter((path) => locksTenantRow(readFileSync(path, 'utf8')))
      .map((path) => relative(ROOT, path).split('\\').join('/'))
      .sort();
    expect(locking).toEqual(Object.keys(TS_TENANT_LOCKS).sort());
  });

  it('flags a planted function that locks a member row after the tenant row, in either form', () => {
    expect(memberLockAfterTenant('PERFORM 1 FROM crove_kernel.tenant t WHERE t.org_id = v_org FOR NO KEY UPDATE;\n  PERFORM 1 FROM crove_kernel.tenant_member m WHERE m.org_id = v_org FOR UPDATE;')).toMatch(
      /tenant_member .* FOR UPDATE/,
    );
    expect(memberLockAfterTenant("UPDATE crove_kernel.tenant SET name = 'x' WHERE org_id = v_org;\n  DELETE FROM crove_kernel.position p WHERE p.org_id = v_org;")).toBe(
      'DELETE FROM crove_kernel.position',
    );
    // The order this test keeps: member rows first.
    expect(memberLockAfterTenant('PERFORM 1 FROM crove_kernel.tenant_member m WHERE m.org_id = v_org FOR UPDATE;\n  PERFORM 1 FROM crove_kernel.tenant t WHERE t.org_id = v_org FOR NO KEY UPDATE;')).toBeNull();
    // A lock in a comment, and a KEY SHARE of the tenant row, which waits on no member change, are no locks here.
    expect(memberLockAfterTenant('-- UPDATE crove_kernel.tenant\n  PERFORM 1 FROM crove_kernel.tenant t FOR KEY SHARE;\n  DELETE FROM crove_kernel.tenant_member;')).toBeNull();
  });

  it('flags a planted command source that locks the tenant row', () => {
    expect(locksTenantRow("await ctx.trx.selectFrom('crove_kernel.tenant').select('x').where('org_id', '=', id).forNoKeyUpdate().executeTakeFirst();")).toBe(true);
    expect(locksTenantRow("await ctx.trx.updateTable('crove_kernel.tenant').set({ x: 1 }).execute();")).toBe(true);
    expect(locksTenantRow("await ctx.trx.selectFrom('crove_kernel.tenant').select('x').executeTakeFirst();")).toBe(false);
  });
});
