// SPDX-License-Identifier: AGPL-3.0-only
// Invariant suite (Decision 7): task comments and Social post approvals stay append-only for everyone but the org purge
// (issues #1032, #2011). Their append_only_row trigger, crove_kernel.purge_append_only_guard, refuses every UPDATE,
// and a DELETE unless it runs as the owner of crove_kernel.org_purge with the purge's mark naming the row's org, on
// the worker login, in that org's system context, while the org offboards. This suite reaches the guard as that owner
// through a probe definer created and rolled back inside each transaction, so a refusal comes from the guard and not
// from a missing grant, and checks each condition on its own against a probe that passes. It also holds that the
// guard sits on these two tables only, and that no function but org_purge deletes from them: the guard's first check
// means "running as org_purge's owner", which owns most definers. Keep this directory self-contained: import code under
// test, never helpers from outside test/invariant/. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run creates and
// drops its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';
import { contextToken } from './fixtures/context-token.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const GUARDED = ['crove_kernel.task_comment', 'crove_social.post_approval'];
const APPEND_ONLY = /is append-only/;

type Org = { orgId: string; owner: string };
// Who runs the probe: the session's login role and the context it enters before the call.
type Session = { login: 'crove_worker' | 'crove_app'; context: { system: string } | { user: Org } | null };

const suite = ADMIN ? describe : describe.skip;

suite('the org purge alone deletes task comments and post approvals (#1032, #2011)', () => {
  const dbName = `crove_test_purgeappend_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let runtime: Runtime;

  async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  // An org with one task comment and one approved post's approval, moved to the given status as staff.
  async function seeded(status: 'active' | 'offboarding'): Promise<Org> {
    const tag = randomUUID().slice(0, 8);
    const owner = await upsertIdentity(createDb(pool), { issuer: 'test', subject: `owner-${tag}`, email: `owner-${tag}@purge.test`, name: null });
    const org = await createOrg(runtime, { type: 'user', userId: owner, aal: 'aal1' }, `Công ty ${tag}`);
    await withClient(adminUrl, async (c) => {
      const task = (await c.query<{ id: string }>(`INSERT INTO crove_kernel.task (org_id, title, source, created_by_type) VALUES ($1, 'Việc', 'human', 'system') RETURNING id`, [org.orgId]))
        .rows[0]?.id;
      await c.query(`INSERT INTO crove_kernel.task_comment (org_id, task_id, body, author_type) VALUES ($1, $2, 'Đã xem', 'system')`, [org.orgId, task]);
      const connection = randomUUID();
      await c.query(
        'INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, $3, $4, $5, $6)',
        [org.orgId, connection, 'sandbox', `acct-${tag}`, 'Kênh', owner],
      );
      const post = (await c.query<{ id: string }>(`INSERT INTO crove_social.post (org_id, body, author_user_id) VALUES ($1, 'Bài', $2) RETURNING id`, [org.orgId, owner])).rows[0]?.id;
      const hash = `sha256:${'a'.repeat(64)}`;
      const variant = (
        await c.query<{ id: string }>(
          `INSERT INTO crove_social.post_variant (org_id, post_id, channel_connection_id, provider, content_hash, status) VALUES ($1, $2, $3, 'sandbox', $4, 'approved') RETURNING id`,
          [org.orgId, post, connection, hash],
        )
      ).rows[0]?.id;
      await c.query(
        `INSERT INTO crove_social.post_approval (org_id, post_id, variant_id, revision, content_hash, decision, decided_by, snapshot) VALUES ($1, $2, $3, 1, $4, 'approved', $5, '{}')`,
        [org.orgId, post, variant, hash, owner],
      );
      if (status === 'offboarding') {
        await c.query('BEGIN');
        await c.query('SET LOCAL session_replication_role = replica');
        await c.query(`UPDATE crove_kernel.tenant SET status = 'offboarding' WHERE org_id = $1`, [org.orgId]);
        await c.query('COMMIT');
      }
    });
    return { orgId: org.orgId, owner };
  }

  // Runs `statement` ($1 = the target org, none when null) inside a probe definer owned by org_purge's owner, with the purge's mark set
  // to `mark` (or cleared), from the given session, in one transaction rolled back afterwards. Returns the rows the
  // statement changed, or the error's message.
  async function probe(session: Session, mark: string | null, statement: string, target: string | null): Promise<string> {
    return withClient(adminUrl, async (c) => {
      await c.query('BEGIN');
      try {
        await c.query(`CREATE FUNCTION crove_kernel.t2011_probe(p_mark text, p_sql text, p_org uuid) RETURNS bigint
          LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
          DECLARE v_n bigint;
          BEGIN
            PERFORM pg_catalog.set_config('crove.org_purge', coalesce(p_mark, ''), true);
            IF p_org IS NULL THEN EXECUTE p_sql; ELSE EXECUTE p_sql USING p_org; END IF;
            GET DIAGNOSTICS v_n = ROW_COUNT;
            RETURN v_n;
          END $$`);
        const owner = (await c.query<{ owner: string }>(`SELECT proowner::regrole::text AS owner FROM pg_proc WHERE oid = 'crove_kernel.org_purge(integer)'::regprocedure`)).rows[0]?.owner;
        await c.query(`ALTER FUNCTION crove_kernel.t2011_probe(text, text, uuid) OWNER TO ${owner}`);
        await c.query(`GRANT EXECUTE ON FUNCTION crove_kernel.t2011_probe(text, text, uuid) TO ${session.login}`);
        await c.query(`SET SESSION AUTHORIZATION ${session.login}`);
        const context = session.context;
        if (context && 'system' in context) await c.query('SELECT crove_kernel.enter_system_context($1)', [context.system]);
        else if (context) await c.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [context.user.orgId, contextToken(context.user.owner, context.user.orgId)]);
        const { rows } = await c.query<{ n: string }>('SELECT crove_kernel.t2011_probe($1, $2, $3) AS n', [mark, statement, target]);
        return `${rows[0]?.n} row(s)`;
      } catch (e) {
        return (e as Error).message;
      } finally {
        await c.query('ROLLBACK');
      }
    });
  }

  const remove = (table: string) => `DELETE FROM ${table} WHERE org_id = $1`;
  const change = (table: string) =>
    table === 'crove_kernel.task_comment' ? `UPDATE ${table} SET body = 'x' WHERE org_id = $1` : `UPDATE ${table} SET comment = 'x' WHERE org_id = $1`;
  const counts = (orgId: string) =>
    withClient(adminUrl, async (c) => {
      const out: Record<string, number> = {};
      for (const table of GUARDED) out[table] = Number((await c.query<{ n: string }>(`SELECT count(*) AS n FROM ${table} WHERE org_id = $1`, [orgId])).rows[0]?.n);
      return out;
    });

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    const app = new URL(adminUrl);
    app.username = 'crove_app';
    app.password = 'test-app-pw';
    pool = createPool({ connectionString: app.toString(), max: 2 });
    runtime = new Runtime(createDb(pool), { manifests: TEST_MANIFESTS }).register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('lets a DELETE through only as the purge, for its org, on the worker login, in that org system context, while it offboards', async () => {
    const a = await seeded('offboarding');
    const b = await seeded('offboarding');
    const live = await seeded('active');
    const before = { a: await counts(a.orgId), b: await counts(b.orgId), live: await counts(live.orgId) };
    const worker = (orgId: string): Session => ({ login: 'crove_worker', context: { system: orgId } });

    for (const table of GUARDED) {
      // The probe passes when every condition holds, so each refusal below is the guard's.
      expect([table, await probe(worker(a.orgId), a.orgId, remove(table), a.orgId)]).toEqual([table, '1 row(s)']);

      const refused: Array<[string, Session, string | null, string, string]> = [
        ['no mark', worker(a.orgId), null, remove(table), a.orgId],
        ['a mark naming another org', worker(a.orgId), b.orgId, remove(table), a.orgId],
        ["another org's rows, under its mark, from this org's context", worker(a.orgId), b.orgId, remove(table), b.orgId],
        ["another org's rows, under this org's mark", worker(a.orgId), a.orgId, remove(table), b.orgId],
        ['the worker outside a context', { login: 'crove_worker', context: null }, a.orgId, remove(table), a.orgId],
        ["the API login in the owner's context", { login: 'crove_app', context: { user: a } }, a.orgId, remove(table), a.orgId],
        ['the API login outside a context', { login: 'crove_app', context: null }, a.orgId, remove(table), a.orgId],
        ['an org that is not offboarding', worker(live.orgId), live.orgId, remove(table), live.orgId],
        ['an UPDATE under every other condition', worker(a.orgId), a.orgId, change(table), a.orgId],
      ];
      for (const [label, session, mark, statement, target] of refused) {
        expect([table, label, await probe(session, mark, statement, target)]).toEqual([table, label, expect.stringMatching(APPEND_ONLY)]);
      }
    }

    // Nothing committed.
    expect({ a: await counts(a.orgId), b: await counts(b.orgId), live: await counts(live.orgId) }).toEqual(before);
    for (const n of [...Object.values(before.a), ...Object.values(before.live)]) expect(n).toBe(1);
  });

  it('keeps TRUNCATE refused, and the guard on these two tables only', async () => {
    const { guarded, truncate, shape } = await withClient(adminUrl, async (c) => {
      const guarded = (
        await c.query<{ t: string; name: string }>(
          `SELECT t.tgrelid::regclass::text AS t, t.tgname AS name FROM pg_trigger t
           WHERE t.tgfoid = 'crove_kernel.purge_append_only_guard()'::regprocedure ORDER BY 1`,
        )
      ).rows.map((r) => `${r.t} ${r.name}`);
      const truncate = (
        await c.query<{ t: string }>(
          `SELECT t.tgrelid::regclass::text AS t FROM pg_trigger t
           WHERE t.tgname = 'append_only_truncate' AND t.tgrelid = ANY ($1::text[]::regclass[]) AND t.tgenabled = 'O' ORDER BY 1`,
          [GUARDED],
        )
      ).rows.map((r) => r.t);
      const shape = (
        await c.query<{ definer: boolean; config: string[]; public: boolean }>(
          `SELECT p.prosecdef AS definer, p.proconfig AS config,
                  EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x WHERE x.grantee = 0) AS public
           FROM pg_proc p WHERE p.oid = 'crove_kernel.purge_append_only_guard()'::regprocedure`,
        )
      ).rows;
      return { guarded, truncate, shape };
    });
    expect(guarded).toEqual(GUARDED.map((t) => `${t} append_only_row`).sort());
    expect(truncate).toEqual([...GUARDED].sort());
    expect(shape).toEqual([{ definer: false, config: ['search_path=pg_catalog, pg_temp'], public: false }]);

    const org = await seeded('offboarding');
    for (const table of GUARDED) {
      expect(await probe({ login: 'crove_worker', context: { system: org.orgId } }, org.orgId, `TRUNCATE ${table}`, null)).toMatch(APPEND_ONLY);
    }
  });

  it('has no function but org_purge delete from task comments or post approvals', async () => {
    const deleters = await withClient(adminUrl, async (c) =>
      (
        await c.query<{ fn: string }>(
          `SELECT p.oid::regprocedure::text AS fn FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND p.prosrc IS NOT NULL
             AND p.prosrc ~* $1
           ORDER BY 1`,
          [`delete\\s+from\\s+(only\\s+)?"?(crove_kernel"?\\s*\\.\\s*"?task_comment|crove_social"?\\s*\\.\\s*"?post_approval)\\M`],
        )
      ).rows.map((r) => r.fn),
    );
    expect(deleters).toEqual(['crove_kernel.org_purge(integer)']);
  });
});
