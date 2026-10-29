// Invariant suite (Decision 7): inbound address rotation (issue #37, plan §7.6). Only the owner rotates, with a
// fresh second factor (R3 since #113), only the API login role may call the rotation definer, every token ever
// issued stays in the ledger, a retired token never routes mail and is never issued again, even when the generator
// returns it. Keep this directory self-contained:
// import package code under test, never helpers from outside test/invariant/. Set CROVE_TEST_ADMIN_URL to a
// superuser URL; each run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { sql, type RawBuilder } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { financeCommands, financeQueries } from '@crove/mod-finance';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';
import { contextToken } from './fixtures/context-token.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const TOKEN = /^[0-9a-f]{24}$/;

const suite = ADMIN ? describe : describe.skip;

suite('inbound address rotation invariants on PostgreSQL', () => {
  const dbName = `crove_test_rotinv_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let runtime: Runtime;
  let workerPool: pg.Pool;
  let workerDb: Db;
  const users = { owner: '', admin: '', member: '', viewer: '', other: '' };
  let org = { orgId: '', slug: '' };
  let otherOrg = '';

  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const asMfa = (userId: string) => ({
    type: 'user' as const,
    userId,
    aal: 'aal2' as const,
    sessionId: '0f6c3a52-8d3b-4c1e-9a77-5b2f0e9d1c00',
    mfaAt: Math.floor(Date.now() / 1000),
  });

  // Members join by accepting an invite (issue #35): the inviter invites the email, the user signed in with it accepts.
  async function join(orgId: string, inviter: string, userId: string, email: string, role: 'admin' | 'member' | 'viewer') {
    const { acceptPath } = await runtime.execute<{ acceptPath: string }>('kernel.member.invite.create', { email, role }, { actor: asMfa(inviter), orgId });
    await runtime.executeOrgless('kernel.member.invite.accept', { token: acceptPath.split('#')[1] }, { actor: asUser(userId) });
  }

  async function withAdmin<T>(fn: (admin: pg.Client) => Promise<T>): Promise<T> {
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      return await fn(admin);
    } finally {
      await admin.end();
    }
  }

  const tokenOf = (orgId: string) =>
    withAdmin(async (admin) => {
      const { rows } = await admin.query<{ inbound_token: string }>('SELECT inbound_token FROM crove_kernel.tenant WHERE org_id = $1', [orgId]);
      return rows[0]?.inbound_token ?? '';
    });

  const ledger = (orgId: string) =>
    withAdmin(async (admin) => {
      const { rows } = await admin.query<{ token: string; retired: boolean }>(
        'SELECT token, retired_at IS NOT NULL AS retired FROM crove_kernel.inbound_address WHERE org_id = $1 ORDER BY created_at, id',
        [orgId],
      );
      return rows;
    });

  const rotateAudits = (orgId: string) =>
    withAdmin(async (admin) => {
      const { rows } = await admin.query<{ actor_id: string; outcome: string; detail: Record<string, unknown> }>(
        `SELECT actor_id, outcome, detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.inbound.rotate' ORDER BY occurred_at, id`,
        [orgId],
      );
      return rows;
    });

  const count = (query: string, params: unknown[]) =>
    withAdmin(async (admin) => Number((await admin.query<{ n: string }>(query, params)).rows[0]?.n ?? 0));

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
    const loginUrl = (username: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = username;
      url.password = password;
      return url.toString();
    };
    const register = (target: Db) =>
      new Runtime(target, { manifests: TEST_MANIFESTS }).register({
        commands: [...kernelCommands, ...financeCommands],
        queries: [...kernelQueries({ inboundDomain: 'in.test' }), ...financeQueries],
      });
    pool = createPool({ connectionString: loginUrl('crove_app', 'test-app-pw'), max: 4 });
    db = createDb(pool);
    runtime = register(db);
    workerPool = createPool({ connectionString: loginUrl('crove_worker', 'test-worker-pw'), max: 4 });
    workerDb = createDb(workerPool);
    for (const name of Object.keys(users) as Array<keyof typeof users>) {
      users[name] = await upsertIdentity(db, { issuer: 'test', subject: `rot-${name}`, email: `rot-${name}@example.com`, name: null });
    }
    const created = await createOrg(runtime, asUser(users.owner), 'Rotation Org');
    org = { orgId: created.orgId, slug: created.slug };
    otherOrg = (await createOrg(runtime, asUser(users.other), 'Other Org')).orgId;
    for (const role of ['admin', 'member', 'viewer'] as const) {
      await join(org.orgId, users.owner, users[role], `rot-${role}@example.com`, role);
    }
  });

  afterAll(async () => {
    await pool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('registers every new org token in the ledger as its one active address', async () => {
    for (const orgId of [org.orgId, otherOrg]) {
      const token = await tokenOf(orgId);
      expect(token).toMatch(TOKEN);
      expect(await ledger(orgId)).toEqual([{ token, retired: false }]);
    }
  });

  it('routes mail only to the active token: a retired token resolves like one that never existed', async () => {
    const resolve = (token: string) =>
      workerDb.transaction().execute(async (trx) => {
        const { rows } = await sql<{ org_id: string | null }>`SELECT crove_kernel.org_by_inbound_token(${token}) AS org_id`.execute(trx);
        return rows[0]?.org_id ?? null;
      });
    const oldToken = await tokenOf(org.orgId);
    expect(await resolve(oldToken)).toBe(org.orgId);
    // With a fresh second factor, so this holds whether rotation is R2 or R3 (step-up, #113).
    const { inboundToken } = await runtime.execute<{ inboundToken: string }>('kernel.inbound.rotate', {}, {
      actor: asMfa(users.owner),
      orgId: org.orgId,
      idempotencyKey: randomUUID(),
    });
    expect(inboundToken).toMatch(TOKEN);
    expect(inboundToken).not.toBe(oldToken);
    expect(await tokenOf(org.orgId)).toBe(inboundToken);
    expect(await ledger(org.orgId)).toEqual([
      { token: oldToken, retired: true },
      { token: inboundToken, retired: false },
    ]);
    expect(await resolve(inboundToken)).toBe(org.orgId);
    expect(await resolve(inboundToken.toUpperCase())).toBe(org.orgId);
    expect(await resolve(oldToken)).toBeNull();
    expect(await resolve('0123456789abcdef01234567')).toBeNull();
    // The audit row names the actor and carries no token (as R3 it also records the assurance used).
    const audits = await rotateAudits(org.orgId);
    expect(audits.at(-1)).toMatchObject({ actor_id: users.owner, outcome: 'ok' });
    const detail = JSON.stringify(audits.at(-1)?.detail);
    expect(detail).not.toContain(inboundToken);
    expect(detail).not.toContain(oldToken);
  });

  it('lets only the owner rotate: admins, members and viewers are refused by the command and by the definer', async () => {
    const before = await tokenOf(org.orgId);
    const audits = (await rotateAudits(org.orgId)).length;
    for (const role of ['admin', 'member', 'viewer'] as const) {
      await expect(
        runtime.execute('kernel.inbound.rotate', {}, { actor: asUser(users[role]), orgId: org.orgId, idempotencyKey: randomUUID() }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    }
    // A member of another org cannot rotate this one.
    await expect(runtime.execute('kernel.inbound.rotate', {}, { actor: asUser(users.other), orgId: org.orgId })).rejects.toMatchObject({
      code: 'NOT_A_MEMBER',
    });
    expect(await tokenOf(org.orgId)).toBe(before);
    const refused = (await rotateAudits(org.orgId)).slice(audits);
    expect(refused.map((r) => [r.actor_id, r.outcome, r.detail.code])).toEqual([
      [users.admin, 'denied', 'FORBIDDEN'],
      [users.member, 'denied', 'FORBIDDEN'],
      [users.viewer, 'denied', 'FORBIDDEN'],
    ]);

    // The API login role calling the definer directly as an admin is refused by the definer itself.
    await expect(
      db.transaction().execute(async (trx) => {
        await sql`SELECT crove_kernel.enter_user_context(${org.orgId}::uuid, ${contextToken(users.admin, org.orgId)}::text)`.execute(trx);
        await sql`SELECT crove_kernel.inbound_rotate()`.execute(trx);
      }),
    ).rejects.toThrow(/INBOUND_ROTATE_OWNER_ONLY/);
    expect(await tokenOf(org.orgId)).toBe(before);

    // EXECUTE matrix: only the API login role may call the rotation definer; the triggers are callable by nobody.
    const functions = [
      'crove_kernel.inbound_rotate()',
      'crove_kernel.inbound_address_guard()',
      'crove_kernel.tenant_pick_inbound_token()',
      'crove_kernel.tenant_register_inbound_token()',
      'crove_kernel.tenant_inbound_token_active()',
    ];
    const roles = ['crove_app', 'crove_worker', 'crove_tenant', 'crove_definer_tenant'];
    const matrix = await withAdmin(async (admin) => {
      const { rows } = await admin.query<{ fn: string; role: string; can: boolean }>(
        `SELECT f AS fn, r AS role, has_function_privilege(r, f, 'EXECUTE') AS can FROM unnest($1::text[]) f CROSS JOIN unnest($2::text[]) r`,
        [functions, roles],
      );
      const owner = await admin.query<{ owner: string }>(`SELECT pg_get_userbyid(proowner) AS owner FROM pg_proc WHERE oid = 'crove_kernel.inbound_rotate()'::regprocedure`);
      const table = await admin.query<{ role: string; privileges: string[] }>(
        `SELECT r AS role, ARRAY(SELECT p FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) p
           WHERE has_table_privilege(r, 'crove_kernel.inbound_address', p)) AS privileges
         FROM unnest($1::text[]) r`,
        [roles],
      );
      return {
        execute: Object.fromEntries(functions.map((f) => [f, roles.filter((r) => rows.some((row) => row.fn === f && row.role === r && row.can))])),
        owner: owner.rows[0]?.owner,
        table: Object.fromEntries(table.rows.map((r) => [r.role, r.privileges])),
      };
    });
    expect(matrix).toEqual({
      execute: {
        // crove_definer_tenant is the NOLOGIN owner; no login role is a member of it.
        'crove_kernel.inbound_rotate()': ['crove_app', 'crove_definer_tenant'],
        'crove_kernel.inbound_address_guard()': [],
        'crove_kernel.tenant_pick_inbound_token()': [],
        'crove_kernel.tenant_register_inbound_token()': [],
        'crove_kernel.tenant_inbound_token_active()': [],
      },
      owner: 'crove_definer_tenant',
      // UPDATE here is the column grant on retired_at only (has_table_privilege reports any column grant as false).
      table: { crove_app: [], crove_worker: [], crove_tenant: [], crove_definer_tenant: ['SELECT', 'INSERT'] },
    });
    await expect(
      workerDb.transaction().execute((trx) => sql`SELECT crove_kernel.inbound_rotate()`.execute(trx)),
    ).rejects.toThrow(/permission denied for function inbound_rotate/);
  });

  it('needs a fresh second factor to rotate (R3, P11, #113): an aal1 or stale owner session is refused and audited', async () => {
    const before = await tokenOf(org.orgId);
    const ledgerBefore = await ledger(org.orgId);
    const audits = (await rotateAudits(org.orgId)).length;
    const stale = { ...asMfa(users.owner), mfaAt: Math.floor(Date.now() / 1000) - 600 };
    const noTimestamp = { type: 'user' as const, userId: users.owner, aal: 'aal2' as const, sessionId: '0f6c3a52-8d3b-4c1e-9a77-5b2f0e9d1c00' };
    for (const actor of [asUser(users.owner), stale, noTimestamp]) {
      await expect(runtime.execute('kernel.inbound.rotate', {}, { actor, orgId: org.orgId, idempotencyKey: randomUUID() })).rejects.toMatchObject({
        code: 'STEP_UP_REQUIRED',
        status: 403,
      });
    }
    // Nothing changed: same token, same ledger. Each refusal is audited with its code.
    expect(await tokenOf(org.orgId)).toBe(before);
    expect(await ledger(org.orgId)).toEqual(ledgerBefore);
    const refused = (await rotateAudits(org.orgId)).slice(audits);
    expect(refused.map((r) => [r.actor_id, r.outcome, r.detail.code])).toEqual([
      [users.owner, 'denied', 'STEP_UP_REQUIRED'],
      [users.owner, 'denied', 'STEP_UP_REQUIRED'],
      [users.owner, 'denied', 'STEP_UP_REQUIRED'],
    ]);

    // With a second factor in the last 5 minutes the owner rotates, and the audit row records the assurance used.
    const fresh = asMfa(users.owner);
    const { inboundToken } = await runtime.execute<{ inboundToken: string }>('kernel.inbound.rotate', {}, {
      actor: fresh,
      orgId: org.orgId,
      idempotencyKey: randomUUID(),
    });
    expect(await tokenOf(org.orgId)).toBe(inboundToken);
    expect((await rotateAudits(org.orgId)).at(-1)).toEqual({
      actor_id: users.owner,
      outcome: 'ok',
      detail: { aal: 'aal2', sessionId: fresh.sessionId, mfaAt: fresh.mfaAt },
    });
  });

  it('never issues a token that ever existed, even when the generator returns one (forced collision)', async () => {
    const retired = (await ledger(org.orgId)).find((r) => r.retired)?.token ?? '';
    const active = await tokenOf(otherOrg);
    expect(retired).toMatch(TOKEN);

    await withAdmin(async (admin) => {
      // The UNIQUE constraint spans active and retired tokens, in every org.
      for (const token of [retired, active]) {
        await expect(admin.query('INSERT INTO crove_kernel.inbound_address (org_id, token) VALUES ($1, $2)', [otherOrg, token])).rejects.toMatchObject({
          code: '23505',
          constraint: 'inbound_address_token_uq',
        });
      }
      // Tombstones are never deleted, revived or rewritten, not even by a superuser.
      await expect(admin.query('DELETE FROM crove_kernel.inbound_address WHERE token = $1', [retired])).rejects.toThrow(/INBOUND_ADDRESS_TOMBSTONE/);
      await expect(admin.query('UPDATE crove_kernel.inbound_address SET retired_at = NULL WHERE token = $1', [retired])).rejects.toThrow(
        /INBOUND_ADDRESS_TOMBSTONE/,
      );
      await expect(
        admin.query(`UPDATE crove_kernel.inbound_address SET token = '00000000000000000000000a' WHERE token = $1`, [active]),
      ).rejects.toThrow(/INBOUND_ADDRESS_TOMBSTONE/);
      await expect(admin.query('TRUNCATE crove_kernel.inbound_address')).rejects.toThrow(/append-only/);
      // Pointing a tenant back at a retired token, or at one the ledger never issued, fails at commit.
      for (const token of [retired, '00000000000000000000000b']) {
        await expect(admin.query('UPDATE crove_kernel.tenant SET inbound_token = $1 WHERE org_id = $2', [token, otherOrg])).rejects.toThrow(
          /INBOUND_TOKEN_NOT_ISSUED/,
        );
      }
    });
    expect(await tokenOf(otherOrg)).toBe(active);

    // The same attempts by the API login role, inside a valid context as the org's owner. Tenant roles may update
    // their tenant row, so pointing it elsewhere is stopped by the constraints; the ledger is not theirs at all.
    const ownToken = await tokenOf(org.orgId);
    const asOwnerApp = (statement: RawBuilder<unknown>) =>
      db.transaction().execute(async (trx) => {
        await sql`SELECT crove_kernel.enter_user_context(${org.orgId}::uuid, ${contextToken(users.owner, org.orgId)}::text)`.execute(trx);
        await statement.execute(trx);
      });
    const attempts: Array<[string, RawBuilder<unknown>, string]> = [
      // Checked at commit by the deferred constraint trigger (INBOUND_TOKEN_NOT_ISSUED).
      ['tenant -> own retired token', sql`UPDATE crove_kernel.tenant SET inbound_token = ${retired} WHERE org_id = ${org.orgId}::uuid`, '42501'],
      ['tenant -> unissued token', sql`UPDATE crove_kernel.tenant SET inbound_token = '00000000000000000000000c' WHERE org_id = ${org.orgId}::uuid`, '42501'],
      // Another org's active token collides with the tenant's own UNIQUE (inbound_token).
      ['tenant -> other org token', sql`UPDATE crove_kernel.tenant SET inbound_token = ${active} WHERE org_id = ${org.orgId}::uuid`, '23505'],
      ['delete tombstone', sql`DELETE FROM crove_kernel.inbound_address WHERE token = ${retired}`, '42501'],
      ['truncate ledger', sql`TRUNCATE crove_kernel.inbound_address`, '42501'],
      ['un-retire tombstone', sql`UPDATE crove_kernel.inbound_address SET retired_at = NULL WHERE token = ${retired}`, '42501'],
      ['insert ledger row', sql`INSERT INTO crove_kernel.inbound_address (org_id, token) VALUES (${org.orgId}::uuid, '00000000000000000000000d')`, '42501'],
    ];
    const outcomes: Array<[string, string | undefined]> = [];
    for (const [name, statement] of attempts) {
      const error = await asOwnerApp(statement).then(
        () => undefined,
        (e: unknown) => e as { code?: string },
      );
      outcomes.push([name, error?.code]);
    }
    expect(outcomes).toEqual(attempts.map(([name, , code]) => [name, code]));
    expect(await tokenOf(org.orgId)).toBe(ownToken);
    expect(await count('SELECT count(*) AS n FROM crove_kernel.inbound_address WHERE token = $1 AND retired_at IS NOT NULL', [retired])).toBe(1);

    // Replace the generator (rolled back) so its first draws return tokens that exist: the retired one, and another
    // org's active one, which tenant RLS hides inside the rotation definer. Rotation and org creation both skip the
    // collisions and issue a fresh token; when every draw collides, nothing is issued.
    const rigged = async <T>(taken: string[], fn: (admin: pg.Client) => Promise<T>) =>
      withAdmin(async (admin) => {
        await admin.query('BEGIN');
        try {
          await admin.query(`
            CREATE OR REPLACE FUNCTION crove_kernel.random_token() RETURNS text
            LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, pg_temp AS $fn$
            DECLARE n int := coalesce(nullif(current_setting('crove_test.draws', true), ''), '0')::int;
            BEGIN
              PERFORM set_config('crove_test.draws', (n + 1)::text, true);
              IF n < ${taken.length} THEN RETURN (ARRAY[${taken.map((t) => `'${t}'`).join(', ')}]::text[])[n + 1]; END IF;
              RETURN substr(md5(random()::text || clock_timestamp()::text), 1, 24);
            END $fn$`);
          return await fn(admin);
        } finally {
          await admin.query('ROLLBACK');
        }
      });
    const rotateAsOwner = async (admin: pg.Client) => {
      await admin.query('SET LOCAL ROLE crove_app');
      await admin.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [org.orgId, contextToken(users.owner, org.orgId)]);
      const { rows } = await admin.query<{ token: string }>('SELECT crove_kernel.inbound_rotate() AS token');
      return rows[0]?.token ?? '';
    };

    const fresh = await rigged([retired, active], rotateAsOwner);
    expect(fresh).toMatch(TOKEN);
    expect([retired, active]).not.toContain(fresh);
    await expect(rigged([retired, active, retired, active, retired], rotateAsOwner)).rejects.toThrow(/INBOUND_TOKEN_EXHAUSTED/);

    const newOrgToken = await rigged([retired, active], async (admin) => {
      const { rows } = await admin.query<{ inbound_token: string }>(
        `INSERT INTO crove_kernel.tenant (slug, name, created_by) VALUES ('rigged-org', 'Rigged', $1) RETURNING inbound_token`,
        [users.owner],
      );
      return rows[0]?.inbound_token ?? '';
    });
    expect(newOrgToken).toMatch(TOKEN);
    expect([retired, active]).not.toContain(newOrgToken);

    // All rolled back: the retired token is still retired and nobody else holds it.
    expect(await count('SELECT count(*) AS n FROM crove_kernel.inbound_address WHERE token = $1 AND retired_at IS NOT NULL', [retired])).toBe(1);
    expect(await count('SELECT count(*) AS n FROM crove_kernel.tenant WHERE inbound_token = $1', [retired])).toBe(0);
  });
});
