// Security properties of OAuth connect attempts (Social plan §3.5, S6.1, issue #370) on a real PostgreSQL 17:
// - crove_kernel.oauth_state is definer-only: no Crove role reads or writes it, and only the API role runs the
//   oauth_state_* definers;
// - only the state's hash is stored, and an attempt is finished once: the second finish is refused and the PKCE
//   verifier is wiped by the first;
// - an attempt is finished only by the member who started it, in the org it was started in, for its provider, and
//   while that member is still an owner or admin; any other caller cannot tell it apart from no attempt at all;
// - an expired attempt cannot be finished.
// Part of the invariant suite: CI runs this file from the base branch on protected-path PRs (AGENTS.md). Set
// CROVE_TEST_ADMIN_URL to a superuser URL; each run creates and drops its own database.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('OAuth connect attempts on PostgreSQL (S6.1)', () => {
  const dbName = `crove_test_oauth_state_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appPool: pg.Pool;
  let api: Runtime;
  let appDb: Db;
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  async function person(name: string) {
    return upsertIdentity(appDb, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@oauth-state.test`, name: null });
  }

  async function orgWith(roles: Array<'admin' | 'member' | 'viewer'>) {
    const owner = await person('owner');
    const { orgId } = await createOrg(api, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    const others: string[] = [];
    for (const role of roles) {
      const id = await person(role);
      await admin((c) => c.query('INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, $3)', [orgId, id, role]));
      others.push(id);
    }
    return { orgId, owner, others };
  }

  // Runs SQL as a login role in a member's context, the way the runtime enters it, skipping the commands.
  async function asMemberSql<T extends pg.QueryResultRow>(role: 'crove_app' | 'crove_worker', userId: string, orgId: string, text: string, values: unknown[]): Promise<pg.QueryResult<T>> {
    const u = new URL(adminUrl);
    u.username = role;
    u.password = role === 'crove_app' ? 'test-app-pw' : 'test-worker-pw';
    const client = new pg.Client({ connectionString: u.toString() });
    await client.connect();
    try {
      await client.query('BEGIN');
      if (role === 'crove_app') await client.query('SELECT crove_kernel.enter_context($1::uuid, $2::uuid)', [userId, orgId]);
      return await client.query<T>(text, values);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      await client.end();
    }
  }

  const newAttempt = () => {
    const state = randomBytes(32).toString('base64url');
    return { state, stateHash: `sha256:${createHash('sha256').update(state).digest('hex')}`, codeVerifier: randomBytes(48).toString('base64url') };
  };
  const begin = (orgId: string, userId: string, a: ReturnType<typeof newAttempt>, provider = 'facebook_page') =>
    api.execute<{ attemptId: string; expiresAt: string }>('kernel.channel.oauth_begin', { provider, stateHash: a.stateHash, codeVerifier: a.codeVerifier }, { actor: asUser(userId), orgId });
  const consume = (orgId: string, userId: string, stateHash: string, provider = 'facebook_page') =>
    api.execute<{ codeVerifier: string | null }>('kernel.channel.oauth_consume', { provider, stateHash }, { actor: asUser(userId), orgId });

  beforeAll(async () => {
    const base = new URL(ADMIN as string);
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    const u = new URL(adminUrl);
    u.username = 'crove_app';
    u.password = 'test-app-pw';
    appPool = createPool({ connectionString: u.toString(), max: 4 });
    appDb = createDb(appPool);
    api = new Runtime(appDb, { manifests: TEST_MANIFESTS }).register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) });
  });

  afterAll(async () => {
    await appPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('gives no Crove role access to the table, and only the API role runs the definers', async () => {
    const tables = await admin((c) =>
      c.query<{ role: string; op: string }>(
        `SELECT r AS role, p AS op FROM unnest(ARRAY['crove_app', 'crove_worker', 'crove_tenant', 'crove_definer_tenant']) r,
                unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) p
         WHERE has_table_privilege(r, 'crove_kernel.oauth_state', p)`,
      ),
    );
    expect(tables.rows).toEqual([]);
    const fns = await admin((c) =>
      c.query<{ fn: string; role: string; can: boolean }>(
        `SELECT f AS fn, r AS role, has_function_privilege(r, f, 'EXECUTE') AS can
         FROM unnest(ARRAY['crove_kernel.oauth_state_create(text, text, text, integer)', 'crove_kernel.oauth_state_consume(text, text)']) f,
              unnest(ARRAY['crove_app', 'crove_worker', 'crove_tenant', 'crove_definer_tenant', 'public']) r
         ORDER BY 1, 2`,
      ),
    );
    expect(fns.rows.filter((r) => r.can).map((r) => `${r.fn} ${r.role}`)).toEqual([
      'crove_kernel.oauth_state_consume(text, text) crove_app',
      'crove_kernel.oauth_state_create(text, text, text, integer) crove_app',
    ]);
    const defs = await admin((c) =>
      c.query<{ definer: boolean; config: string[] }>(
        `SELECT p.prosecdef AS definer, p.proconfig AS config FROM pg_proc p
         WHERE p.oid IN ('crove_kernel.oauth_state_create(text,text,text,integer)'::regprocedure, 'crove_kernel.oauth_state_consume(text,text)'::regprocedure)`,
      ),
    );
    expect(defs.rows).toEqual([
      { definer: true, config: ['search_path=pg_catalog, pg_temp'] },
      { definer: true, config: ['search_path=pg_catalog, pg_temp'] },
    ]);
  });

  it('stores only the hash, finishes an attempt once and wipes its verifier', async () => {
    const { orgId, owner } = await orgWith([]);
    const a = newAttempt();
    const { attemptId } = await begin(orgId, owner, a);
    const row = await admin((c) => c.query('SELECT row_to_json(s)::text AS t FROM crove_kernel.oauth_state s WHERE id = $1', [attemptId]));
    expect(row.rows[0]?.t).toContain(a.stateHash);
    expect(row.rows[0]?.t).not.toContain(a.state);
    expect(await consume(orgId, owner, a.stateHash)).toEqual({ codeVerifier: a.codeVerifier });
    await expect(consume(orgId, owner, a.stateHash)).rejects.toMatchObject({ code: 'OAUTH_STATE_USED' });
    const after = await admin((c) => c.query<{ code_verifier: string | null; consumed_at: Date | null }>('SELECT code_verifier, consumed_at FROM crove_kernel.oauth_state WHERE id = $1', [attemptId]));
    expect(after.rows[0]?.code_verifier).toBeNull();
    expect(after.rows[0]?.consumed_at).not.toBeNull();
    // Neither the state, its hash nor the verifier reaches an audit row.
    const audit = await admin((c) => c.query<{ t: string }>("SELECT string_agg(detail::text || coalesce(input_sha256, ''), ' ') AS t FROM crove_kernel.audit_event WHERE org_id = $1", [orgId]));
    for (const secret of [a.state, a.stateHash, a.codeVerifier]) expect(audit.rows[0]?.t ?? '').not.toContain(secret);
  });

  it('is finished only by the member who started it, in its org, for its provider', async () => {
    const { orgId, owner, others } = await orgWith(['admin']);
    const otherAdmin = others[0] as string;
    const foreign = await orgWith([]);
    const a = newAttempt();
    await begin(orgId, owner, a);
    // Another admin of the same org, the owner of another org and another provider all get the same answer as for an
    // attempt that does not exist.
    await expect(consume(orgId, otherAdmin, a.stateHash)).rejects.toMatchObject({ code: 'OAUTH_STATE_INVALID' });
    await expect(consume(foreign.orgId, foreign.owner, a.stateHash)).rejects.toMatchObject({ code: 'OAUTH_STATE_INVALID' });
    await expect(consume(orgId, owner, a.stateHash, 'zalo_oa')).rejects.toMatchObject({ code: 'OAUTH_STATE_INVALID' });
    await expect(consume(orgId, owner, newAttempt().stateHash)).rejects.toMatchObject({ code: 'OAUTH_STATE_INVALID' });
    // None of them used it up.
    expect(await consume(orgId, owner, a.stateHash)).toEqual({ codeVerifier: a.codeVerifier });
  });

  it('refuses members and viewers, also through the definers directly, and a starter who lost the role', async () => {
    const { orgId, owner, others } = await orgWith(['member', 'viewer', 'admin']);
    const [member, viewer, demoted] = others as [string, string, string];
    for (const who of [member, viewer]) {
      await expect(begin(orgId, who, newAttempt())).rejects.toMatchObject({ status: 403 });
      await expect(
        asMemberSql('crove_app', who, orgId, 'SELECT crove_kernel.oauth_state_create($1, $2, NULL, 600)', ['facebook_page', newAttempt().stateHash]),
      ).rejects.toThrow(/OAUTH_FORBIDDEN/);
    }
    const a = newAttempt();
    await begin(orgId, demoted, a);
    await admin((c) => c.query("UPDATE crove_kernel.tenant_member SET role = 'member' WHERE org_id = $1 AND user_id = $2", [orgId, demoted]));
    await expect(asMemberSql('crove_app', demoted, orgId, 'SELECT * FROM crove_kernel.oauth_state_consume($1, $2)', ['facebook_page', a.stateHash])).rejects.toThrow(/OAUTH_FORBIDDEN/);
    // The worker's login role cannot run the definers at all.
    await expect(asMemberSql('crove_worker', owner, orgId, 'SELECT * FROM crove_kernel.oauth_state_consume($1, $2)', ['facebook_page', a.stateHash])).rejects.toThrow(/permission denied/);
  });

  it('refuses an expired attempt and bounds open attempts per member', async () => {
    const { orgId, owner } = await orgWith([]);
    const a = newAttempt();
    const { attemptId } = await begin(orgId, owner, a);
    await admin((c) => c.query("UPDATE crove_kernel.oauth_state SET expires_at = now() - interval '1 second' WHERE id = $1", [attemptId]));
    await expect(consume(orgId, owner, a.stateHash)).rejects.toMatchObject({ code: 'OAUTH_STATE_EXPIRED' });
    for (let i = 0; i < 20; i++) await begin(orgId, owner, newAttempt());
    await expect(begin(orgId, owner, newAttempt())).rejects.toMatchObject({ code: 'OAUTH_TOO_MANY' });
    // A lifetime outside 60 to 900 seconds and a malformed hash are refused by the definer.
    await expect(asMemberSql('crove_app', owner, orgId, 'SELECT crove_kernel.oauth_state_create($1, $2, NULL, 86400)', ['facebook_page', newAttempt().stateHash])).rejects.toThrow(/OAUTH_INVALID/);
    await expect(asMemberSql('crove_app', owner, orgId, 'SELECT crove_kernel.oauth_state_create($1, $2, NULL, 600)', ['facebook_page', 'plain-state'])).rejects.toThrow(/OAUTH_INVALID/);
  });
});
