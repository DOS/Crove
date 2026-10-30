// The lock order of an org's member rows and its tenant row (#1943, from the review of #1939). Every membership change (a
// role revoke, a member's removal or demotion) locks the member's row and the assignment FOR UPDATE, then the chief
// accountant keep guard locks the tenant row FOR NO KEY UPDATE (#1922, #1933); purchase postings hold the tenant row FOR
// SHARE (modules/finance/src/record.ts) and tenant-setting commands UPDATE it. So: after a lock of the tenant row
// stronger than KEY SHARE (FOR SHARE, NO KEY UPDATE, UPDATE, or an UPDATE of it), a transaction takes no lock stronger
// than FOR SHARE on a member, role assignment or position row. FOR SHARE is let through on purpose: the membership
// commands take the org's chart lock first (lockChartChanges, #1858), and after their guard the stranded-task reroute
// (task_reroute) reads positions and their holders' member rows FOR SHARE, which waits on no other reader. This pins it
// where the locks are taken:
// - SQL: the newest definition of every function in supabase/migrations takes no FOR UPDATE or NO KEY UPDATE of, and
//   no UPDATE or DELETE of, a tenant_member, role_assignment or position row after it locks or updates the tenant row,
//   but the functions on SQL_AFTER_TENANT with their reason;
// - TypeScript: every source that locks or updates the tenant row (through Kysely or a raw sql template) is on
//   TS_TENANT_LOCKS, with a reason that says why it takes no such lock afterwards, so a new one is read against this
//   order before it lands.
// What it does not see: a lock taken in another function or trigger the first one calls after the tenant row.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const MIGRATIONS = join(ROOT, 'supabase', 'migrations');

// Functions allowed to lock a member, assignment or position row after the tenant row, each with its reason.
const SQL_AFTER_TENANT: Readonly<Record<string, string>> = {
  'crove_kernel.org_purge':
    "locks the tenant row FOR UPDATE, then deletes an offboarding org's chart and members; the keep guard lets every org that is not active through before its lock, so no member change waits on the tenant row there (#1933)",
};

// Sources that lock or update the tenant row, with why no member, assignment or position row is locked after it.
const TS_TENANT_LOCKS: Readonly<Record<string, string>> = {
  'packages/kernel/src/approval-preset.ts': 'the preset switch locks the tenant row FOR UPDATE, then only reads the chief accountants (no lock) and updates the tenant row',
  'packages/kernel/src/offboarding.ts': 'offboarding locks and updates the tenant row; it touches no member or position row',
  'packages/kernel/src/org-address.ts': "the org's address and contact email: an UPDATE of the tenant row only",
  'packages/kernel/src/tax-code.ts': "the org's tax code and VAT filing period: an UPDATE of the tenant row only",
  'modules/finance/src/missing-invoices.ts': "the missing-invoice reminder day: an UPDATE of the tenant row only",
  'modules/finance/src/record.ts': "a purchase posting reads the org's tax code FOR SHARE; it writes ledger rows, never a member or position row",
  'packages/kernel/src/personal-data.ts': "an erasure clears the org's contact email (a raw UPDATE of the tenant row); its only row lock, the parties FOR UPDATE, comes before, and it touches no member or position row",
};

const DEFINITION = /CREATE (?:OR REPLACE )?FUNCTION\s+([a-z_]+\.[a-z_0-9]+)\s*\(([^)]*)\)[\s\S]*?\$\$([\s\S]*?)\$\$/gi;

// The newest definition of each SQL function (name and argument list) across the migrations, with its file.
function newestFunctions(files: ReadonlyArray<{ name: string; text: string }>): Map<string, { file: string; body: string }> {
  const out = new Map<string, { file: string; body: string }>();
  const definition = DEFINITION;
  for (const { name, text } of files) {
    for (const m of text.matchAll(definition)) {
      const args = (m[2] as string).replace(/\s+/g, ' ').trim();
      out.set(`${m[1] as string}(${args})`, { file: name, body: m[3] as string });
    }
  }
  return out;
}

const TENANT_LOCK = /(?:FROM|JOIN)\s+crove_kernel\.tenant\b(?:(?!;)[\s\S])*?FOR\s+(?:NO\s+KEY\s+UPDATE|UPDATE|SHARE)\b|UPDATE\s+crove_kernel\.tenant\b/gi;
const MEMBER_TABLES = 'crove_kernel\\.(?:tenant_member|role_assignment|position)\\b';
const MEMBER_LOCK = new RegExp(
  `(?:FROM|JOIN)\\s+${MEMBER_TABLES}(?:(?!;)[\\s\\S])*?FOR\\s+(?:NO\\s+KEY\\s+UPDATE|UPDATE)\\b|(?:UPDATE|DELETE\\s+FROM)\\s+${MEMBER_TABLES}`,
  'gi',
);

// The statement that locks a member, assignment or position row after the first lock of the tenant row in a function
// body, or null.
function memberLockAfterTenant(body: string): string | null {
  const code = body.replace(/--[^\n]*/g, '');
  TENANT_LOCK.lastIndex = 0;
  const tenant = TENANT_LOCK.exec(code);
  if (!tenant) return null;
  MEMBER_LOCK.lastIndex = tenant.index + tenant[0].length;
  const member = MEMBER_LOCK.exec(code);
  return member ? member[0].replace(/\s+/g, ' ') : null;
}

// Whether a TypeScript source locks or updates the tenant row, through Kysely (aliased or not) or a raw sql template.
function locksTenantRow(source: string): boolean {
  const table = "'crove_kernel\\.tenant(?: as \\w+)?'";
  const update = new RegExp(`updateTable\\(${table}\\)`).test(source);
  const lock = [...source.matchAll(new RegExp(`(?:selectFrom|innerJoin|leftJoin)\\(${table}[\\s\\S]*?\\.execute`, 'g'))].some((m) =>
    /\.for(?:Update|NoKeyUpdate|Share)\(\)/.test(m[0]),
  );
  const raw = [...source.matchAll(/sql(?:<[^>]*>)?`([^`]*)`/g)].some((m) => {
    const text = m[1] as string;
    return /UPDATE\s+crove_kernel\.tenant\b/i.test(text) || /crove_kernel\.tenant\b[^;]*?FOR\s+(?:NO\s+KEY\s+UPDATE|UPDATE|SHARE)\b/i.test(text);
  });
  return update || lock || raw;
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

  it('reads every function definition, each body on its own', () => {
    // A body quoted otherwise than with $$ would be read as part of the next definition; none is today.
    const written = migrations.reduce((n, { text }) => n + (text.match(/CREATE (?:OR REPLACE )?FUNCTION\s/gi)?.length ?? 0), 0);
    const read = migrations.reduce((n, { text }) => n + [...text.matchAll(DEFINITION)].length, 0);
    expect(read).toBe(written);
    for (const [fn, { body }] of newestFunctions(migrations)) expect(/CREATE (?:OR REPLACE )?FUNCTION\s/i.test(body), fn).toBe(false);
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
    // An assignment, and a tenant row locked through a join.
    expect(memberLockAfterTenant('PERFORM 1 FROM crove_kernel.party p JOIN crove_kernel.tenant t ON t.org_id = p.org_id FOR UPDATE;\n  DELETE FROM crove_kernel.role_assignment a;')).toBe(
      'DELETE FROM crove_kernel.role_assignment',
    );
    // FOR SHARE of a member row after the tenant row waits on no reader: the reroute's order, let through.
    expect(memberLockAfterTenant('PERFORM 1 FROM crove_kernel.tenant t FOR NO KEY UPDATE;\n  PERFORM 1 FROM crove_kernel.tenant_member m FOR SHARE;')).toBeNull();
    // The order this test keeps: member rows first.
    expect(memberLockAfterTenant('PERFORM 1 FROM crove_kernel.tenant_member m WHERE m.org_id = v_org FOR UPDATE;\n  PERFORM 1 FROM crove_kernel.tenant t WHERE t.org_id = v_org FOR NO KEY UPDATE;')).toBeNull();
    // A lock in a comment, and a KEY SHARE of the tenant row, which waits on no member change, are no locks here.
    expect(memberLockAfterTenant('-- UPDATE crove_kernel.tenant\n  PERFORM 1 FROM crove_kernel.tenant t FOR KEY SHARE;\n  DELETE FROM crove_kernel.tenant_member;')).toBeNull();
  });

  it('flags a planted command source that locks the tenant row', () => {
    expect(locksTenantRow("await ctx.trx.selectFrom('crove_kernel.tenant').select('x').where('org_id', '=', id).forNoKeyUpdate().executeTakeFirst();")).toBe(true);
    expect(locksTenantRow("await ctx.trx.updateTable('crove_kernel.tenant').set({ x: 1 }).execute();")).toBe(true);
    expect(locksTenantRow("await ctx.trx.selectFrom('crove_kernel.tenant as t').select('t.x').forShare().executeTakeFirst();")).toBe(true);
    expect(locksTenantRow('await sql`UPDATE crove_kernel.tenant t SET x = 1 WHERE t.org_id = ${id}`.execute(ctx.trx);')).toBe(true);
    expect(locksTenantRow('await sql`SELECT 1 FROM crove_kernel.tenant t WHERE t.org_id = ${id} FOR NO KEY UPDATE`.execute(ctx.trx);')).toBe(true);
    expect(locksTenantRow("await ctx.trx.selectFrom('crove_kernel.tenant').select('x').executeTakeFirst();")).toBe(false);
    expect(locksTenantRow('await sql`SELECT 1 FROM crove_kernel.tenant_member m FOR UPDATE`.execute(ctx.trx);')).toBe(false);
  });
});
