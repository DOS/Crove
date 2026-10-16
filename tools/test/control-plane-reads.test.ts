// The join rule (plan §3.6, Decision 14; issue #169): a tenant transaction reaches control-plane tables only through
// SECURITY DEFINER functions (member_profiles, enter_context, session_check, identity_resolve, my_orgs and the
// like), which a multi-cell setup can reimplement as a call to the control plane. No TypeScript source of the API,
// the worker, the modules or the packages may name a control-plane table, whether through Kysely (selectFrom, a
// join, withSchema) or raw SQL. crove_kernel.user_account also has no Kysely type (packages/db/src/schema.ts).
// The database enforces the same rule once the tenant roles lose their direct grants (step 2 of #169, #222).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCANNED = ['apps/kernel/src', 'modules', 'packages'];
// Files that may name a control-plane table, each with its reason. Keep it empty: add a definer instead.
const ALLOWED: string[] = [];

// Control-plane tables (plan §3.6): identity, a user's sessions across orgs, inbound routing and the per-client
// email budget in front of Supabase Auth. staff and kill_switch join this list when they are built (§4.12).
const CONTROL_PLANE = ['user_account', 'auth_session', 'inbound_address', 'inbound_pending', 'auth_email_send'];
const NAMES = CONTROL_PLANE.join('|');
// Schema-qualified anywhere (Kysely table names, raw SQL, sql.table), optionally quoted; or the bare name as a whole
// string literal (withSchema('crove_kernel').selectFrom('user_account'), sql.id(...)). auth_session_org is tenant
// data and does not match.
const REFERENCE = new RegExp(`\\bcrove_kernel"?\\s*\\.\\s*"?(${NAMES})\\b|(['"\`])(${NAMES})\\2`);

// Comments may name the tables; code may not. Block comments and whole-line // comments are dropped (a trailing //
// comment stays, so a URL in a string never hides the rest of its line).
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'test' || name === 'dist') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(name)) out.push(path);
  }
  return out;
}

describe('tenant code reaches control-plane tables only through definers', () => {
  it('no API, worker, module or package source names a control-plane table', () => {
    const offenders = SCANNED.flatMap((dir) => sources(join(ROOT, dir)))
      .map((path) => relative(ROOT, path).replace(/\\/g, '/'))
      .filter((path) => !ALLOWED.includes(path))
      .flatMap((path) =>
        code(readFileSync(join(ROOT, path), 'utf8'))
          .split('\n')
          .filter((line) => REFERENCE.test(line))
          .map((line) => `${path}: ${line.trim()}`),
      );
    expect(ALLOWED).toEqual([]);
    expect(offenders).toEqual([]);
  });

  it('the scan recognizes direct reads', () => {
    for (const line of [
      "await trx.selectFrom('crove_kernel.user_account').select('email')",
      ".innerJoin('crove_kernel.user_account as u', 'u.id', 'm.user_id')",
      ".leftJoin('crove_kernel.user_account as u', 'u.id', 'i.invited_by')",
      'sql`SELECT email FROM crove_kernel.user_account WHERE id = ${id}`',
      'SELECT 1 FROM crove_kernel."user_account" u',
      "trx.withSchema('crove_kernel').selectFrom('user_account')",
      "sql.table('crove_kernel.auth_session')",
      'JOIN crove_kernel.inbound_address a ON a.token = t.inbound_token',
      "deleteFrom('crove_kernel.inbound_pending')",
      'INSERT INTO crove_kernel.auth_email_send (client_key) VALUES ($1)',
    ]) {
      expect(REFERENCE.test(code(line)), line).toBe(true);
    }
    for (const line of [
      // Definers, tenant tables and look-alike names are fine.
      'SELECT user_id, email FROM crove_kernel.member_profiles(${ids}::uuid[])',
      "selectFrom('crove_kernel.auth_session_org')",
      "selectFrom('crove_kernel.tenant_member')",
      'inbound_pending: number;',
      '// Reads crove_kernel.user_account only through member_profiles.',
      '/* JOIN crove_kernel.user_account */ SELECT 1',
    ]) {
      expect(REFERENCE.test(code(line)), line).toBe(false);
    }
  });
});
