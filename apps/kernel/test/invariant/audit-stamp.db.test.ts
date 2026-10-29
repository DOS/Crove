// Audit rows stamped from the sealed context (issue #1482, plan §4.10) on a real PostgreSQL 17: whoever inserts an
// audit_event row, it names the actor of the session's own sealed context (a user, or the system with no actor id) and
// is dated now; a row forged for another member, for the system, or backdated becomes the session's own, undated; no
// context, or another org's, writes nothing; an agent keeps its own stricter rule; staff are not stamped. The runtime's
// own rows are unchanged by it.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; the run creates and drops its own database.
// Part of the invariant suite: CI runs this file from the base branch on protected-path PRs (AGENTS.md).
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';
import { contextToken } from './fixtures/context-token.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

interface Row {
  actor_type: string;
  actor_id: string | null;
  recent: boolean;
}

suite('audit rows stamped from the sealed context on PostgreSQL (#1482)', () => {
  const dbName = `crove_test_audit_stamp_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let workerUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let runtime: Runtime;
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });

  async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  async function org() {
    const person = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@stamp.test`, name: null });
    const owner = await person('owner');
    const member = await person('member');
    const { orgId } = await createOrg(runtime, asUser(owner), `Stamp ${randomUUID().slice(0, 6)}`);
    await withClient(adminUrl, (c) => c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')", [orgId, member]));
    return { orgId, owner, member };
  }

  // Inserts one audit row claiming `claim` and dated a year ago, in the given context, and reads back what was stored.
  async function forge(
    login: string,
    enter: { sql: string; params: unknown[] } | null,
    orgId: string,
    claim: { actorType: string; actorId: string | null },
  ): Promise<Row | undefined> {
    const command = randomUUID();
    await withClient(login, async (c) => {
      await c.query('BEGIN');
      try {
        if (enter) await c.query(enter.sql, enter.params);
        await c.query(
          `INSERT INTO crove_kernel.audit_event (org_id, actor_type, actor_id, command, command_id, outcome, input_sha256, occurred_at)
           VALUES ($1, $2, $3, 'kernel.org.set_tax_code', $4, 'ok', repeat('0', 64), now() - interval '1 year')`,
          [orgId, claim.actorType, claim.actorId, command],
        );
        await c.query('COMMIT');
      } catch (error) {
        await c.query('ROLLBACK').catch(() => {});
        throw error;
      }
    });
    return withClient(
      adminUrl,
      async (c) =>
        (
          await c.query<Row>(
            `SELECT actor_type, actor_id, occurred_at > now() - interval '1 hour' AS recent FROM crove_kernel.audit_event WHERE org_id = $1 AND command_id = $2`,
            [orgId, command],
          )
        ).rows[0],
    );
  }
  const userContext = (userId: string, orgId: string) => ({ sql: 'SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', params: [orgId, contextToken(userId, orgId)] });
  const systemContext = (orgId: string) => ({ sql: 'SELECT crove_kernel.enter_system_context($1::uuid)', params: [orgId] });

  beforeAll(async () => {
    await withClient(ADMIN as string, (c) => c.query(`CREATE DATABASE ${dbName}`));
    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    const login = (user: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = user;
      url.password = password;
      return url.toString();
    };
    appUrl = login('crove_app', 'test-app-pw');
    workerUrl = login('crove_worker', 'test-worker-pw');
    pool = createPool({ connectionString: appUrl, max: 4 });
    db = createDb(pool);
    runtime = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    await withClient(ADMIN, (c) => c.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`));
  });

  it('names the context\'s own user, dated now, whatever a member\'s session claims', async () => {
    const o = await org();
    for (const claim of [
      { actorType: 'user', actorId: o.owner },
      { actorType: 'system', actorId: null },
      { actorType: 'user', actorId: randomUUID() },
    ]) {
      await expect(forge(appUrl, userContext(o.member, o.orgId), o.orgId, claim)).resolves.toEqual({ actor_type: 'user', actor_id: o.member, recent: true });
    }
  });

  it('names the system, with no actor, in a system context, whatever it claims', async () => {
    const o = await org();
    await expect(forge(workerUrl, systemContext(o.orgId), o.orgId, { actorType: 'user', actorId: o.owner })).resolves.toEqual({
      actor_type: 'system',
      actor_id: null,
      recent: true,
    });
  });

  it('writes nothing without a context or for another org, and leaves staff rows as written', async () => {
    const o = await org();
    const other = await org();
    await expect(forge(appUrl, null, o.orgId, { actorType: 'user', actorId: o.owner })).rejects.toThrow();
    await expect(forge(appUrl, userContext(other.owner, other.orgId), o.orgId, { actorType: 'user', actorId: other.owner })).rejects.toThrow();
    await expect(forge(adminUrl, null, o.orgId, { actorType: 'user', actorId: o.owner })).resolves.toEqual({ actor_type: 'user', actor_id: o.owner, recent: false });
  });

  it('keeps the runtime\'s own rows as it writes them', async () => {
    const o = await org();
    await runtime.execute('kernel.org.set_tax_code', { taxCode: '0312345678' }, { actor: asUser(o.owner), orgId: o.orgId });
    const rows = await withClient(adminUrl, async (c) =>
      (
        await c.query<{ actor_type: string; actor_id: string; recent: boolean }>(
          `SELECT actor_type, actor_id, occurred_at > now() - interval '1 hour' AS recent FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.org.set_tax_code'`,
          [o.orgId],
        )
      ).rows,
    );
    expect(rows).toEqual([{ actor_type: 'user', actor_id: o.owner, recent: true }]);
    // A member's raw change of the tax code, with a row forged for the owner, still fails: the row became the member's.
    await expect(
      withClient(appUrl, async (c) => {
        await c.query('BEGIN');
        try {
          await c.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [o.orgId, contextToken(o.member, o.orgId)]);
          await c.query(
            `INSERT INTO crove_kernel.audit_event (org_id, actor_type, actor_id, command, command_id, outcome, input_sha256, detail)
             VALUES ($1, 'user', $2, 'kernel.org.set_tax_code', gen_random_uuid(), 'ok', repeat('0', 64), $3::jsonb)`,
            [o.orgId, o.owner, JSON.stringify({ taxCode: '0398765432' })],
          );
          await c.query("UPDATE crove_kernel.tenant SET tax_code = '0398765432' WHERE org_id = $1", [o.orgId]);
          await c.query('COMMIT');
        } catch (error) {
          await c.query('ROLLBACK').catch(() => {});
          throw error;
        }
      }),
    ).rejects.toThrow(/TAX_CODE_FORBIDDEN/);
  });
});
