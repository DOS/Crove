// Inbound address rotation (issue #37, plan §7.6) against a real PostgreSQL 17. Set CROVE_TEST_ADMIN_URL to a
// superuser URL; each run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime, type BlobStore } from '@crove/kernel-runtime';
import { financeCommands, financeQueries } from '@crove/mod-finance';
import type { AuthUser } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { migrateJobs, startWorker } from '../src/worker.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const FIXTURE = readFileSync(new URL('../../../packages/l10n-vn/test/fixtures/einvoice-basic.xml', import.meta.url), 'utf8');
const TOKEN = /^[0-9a-f]{24}$/;
const INBOUND_SECRET = 'test-only-inbound-secret-0123456789abcdef';

class MemoryStore implements BlobStore {
  private readonly blobs = new Map<string, Uint8Array>();
  async put(key: string, bytes: Uint8Array) {
    this.blobs.set(key, bytes);
  }
  async get(key: string) {
    const b = this.blobs.get(key);
    if (!b) throw new Error('missing blob');
    return b;
  }
  async delete(key: string) {
    this.blobs.delete(key);
  }
  keys(prefix: string) {
    return [...this.blobs.keys()].filter((k) => k.startsWith(prefix));
  }
}

const suite = ADMIN ? describe : describe.skip;

suite('inbound address rotation on PostgreSQL', () => {
  const dbName = `crove_test_rot_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let workerUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let runtime: Runtime;
  let workerPool: pg.Pool;
  let workerDb: Db;
  let workerRuntime: Runtime;
  const store = new MemoryStore();
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
      new Runtime(target).register({
        commands: [...kernelCommands, ...financeCommands],
        queries: [...kernelQueries({ inboundDomain: 'in.test' }), ...financeQueries],
      });
    pool = createPool({ connectionString: loginUrl('crove_app', 'test-app-pw'), max: 4 });
    db = createDb(pool);
    runtime = register(db);
    workerUrl = loginUrl('crove_worker', 'test-worker-pw');
    workerPool = createPool({ connectionString: workerUrl, max: 4 });
    workerDb = createDb(workerPool);
    workerRuntime = register(workerDb);
    for (const name of Object.keys(users) as Array<keyof typeof users>) {
      users[name] = await upsertIdentity(db, { issuer: 'test', subject: `rot-${name}`, email: `rot-${name}@example.com`, name: null });
    }
    const created = await createOrg(runtime, asUser(users.owner), 'Rotation Org');
    org = { orgId: created.orgId, slug: created.slug };
    otherOrg = (await createOrg(runtime, asUser(users.other), 'Other Org')).orgId;
    for (const role of ['admin', 'member', 'viewer'] as const) {
      await runtime.execute('kernel.member.add', { email: `rot-${role}@example.com`, role }, { actor: asMfa(users.owner), orgId: org.orgId });
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

  it('rotates as owner through the RPC procedure, once per idempotency key, and only the new address receives mail', { timeout: 90_000 }, async () => {
    const config = loadConfig({
      DATABASE_URL: 'postgres://unused@localhost/unused',
      AUTH_JWT_SECRET: 'test-only-jwt-secret-for-rotation-0123456789',
      AUTH_ISSUER: 'test-auth',
      INBOUND_DOMAIN: 'in.test',
      INBOUND_SECRET,
      WEB_DIST: '/nonexistent',
    });
    let caller = users.owner;
    const app = createHttpApp({
      config,
      runtime,
      store,
      authenticate: async (): Promise<AuthUser> => ({
        userId: caller,
        email: 'rot@example.com',
        name: null,
        aal: 'aal1',
        sessionId: randomUUID(),
        mfaAt: null,
      }),
      pool,
      aiEnabled: false,
    });
    const rotate = (idempotencyKey: string) =>
      app.request('/api/rpc/org/rotateInbound', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-crove-org': org.slug },
        body: JSON.stringify({ json: { idempotencyKey } }),
      });

    const oldToken = await tokenOf(org.orgId);
    const key = randomUUID();
    const first = await rotate(key);
    expect(first.status).toBe(200);
    const { json: result } = (await first.json()) as { json: { inboundAddress: string } };
    const newToken = result.inboundAddress.replace(/@in\.test$/, '');
    expect(result.inboundAddress).toBe(`${newToken}@in.test`);
    expect(newToken).toMatch(TOKEN);
    expect(newToken).not.toBe(oldToken);
    expect(await tokenOf(org.orgId)).toBe(newToken);
    expect(await ledger(org.orgId)).toEqual([
      { token: oldToken, retired: true },
      { token: newToken, retired: false },
    ]);
    expect(await rotateAudits(org.orgId)).toEqual([{ actor_id: users.owner, outcome: 'ok', detail: {} }]);
    await expect(runtime.query('kernel.org.get', {}, { actor: asUser(users.owner), orgId: org.orgId })).resolves.toMatchObject({
      inboundAddress: `${newToken}@in.test`,
    });

    // A replayed key returns the same address and rotates nothing, also when the retries race.
    const replays = await Promise.all([rotate(key), rotate(key)]);
    for (const replay of replays) {
      expect(replay.status).toBe(200);
      expect(await replay.json()).toEqual({ json: result });
    }
    expect(await tokenOf(org.orgId)).toBe(newToken);
    expect(await ledger(org.orgId)).toHaveLength(2);
    expect(await rotateAudits(org.orgId)).toHaveLength(1);

    // A viewer calling the procedure is refused.
    caller = users.viewer;
    expect((await rotate(randomUUID())).status).toBe(403);
    expect(await tokenOf(org.orgId)).toBe(newToken);

    // Mail to the new address and to the retired one: the API answers 202 to both (no oracle).
    const mime = (token: string, number: string) =>
      [
        'From: Nha cung cap <ketoan@vendor.example>',
        `To: ${token}@in.test`,
        `Subject: Hoa don ${number}`,
        `Message-ID: <rot-${number}@vendor.example>`,
        'MIME-Version: 1.0',
        'Content-Type: multipart/mixed; boundary="b1"',
        '',
        '--b1',
        'Content-Type: application/xml; name="hd.xml"',
        'Content-Disposition: attachment; filename="hd.xml"',
        'Content-Transfer-Encoding: base64',
        '',
        Buffer.from(FIXTURE.replace('<SHDon>1234</SHDon>', `<SHDon>${number}</SHDon>`))
          .toString('base64')
          .replace(/.{76}/g, '$&\r\n'),
        '--b1--',
        '',
      ].join('\r\n');
    const deliver = (token: string, number: string) =>
      app.request('/api/inbound/email', {
        method: 'POST',
        headers: { authorization: `Bearer ${INBOUND_SECRET}`, 'content-type': 'message/rfc822', 'x-crove-recipient': `${token}@in.test` },
        body: mime(token, number),
      });
    expect((await deliver(oldToken, '7701')).status).toBe(202);
    expect((await deliver(newToken, '7702')).status).toBe(202);
    // A token that never existed gets the same answer.
    expect((await deliver('0123456789abcdef01234567', '7703')).status).toBe(202);

    const messages = (id: string) => count('SELECT count(*) AS n FROM crove_kernel.inbound_message WHERE message_id LIKE $1', [`%${id}%`]);
    const pending = () => count('SELECT count(*) AS n FROM crove_kernel.inbound_pending', []);
    const until = async (check: () => Promise<boolean>) => {
      const deadline = Date.now() + 60_000;
      while (!(await check())) {
        if (Date.now() > deadline) throw new Error('timed out waiting for the worker');
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    };

    await migrateJobs(adminUrl);
    const stop = await startWorker({ connectionString: workerUrl, workerDb, runtime: workerRuntime, store, extractor: null, inboundDomain: 'in.test' });
    try {
      // The new address files the invoice, and its extraction job turns it into a proposal in the org.
      const emailProposals = () =>
        count(
          `SELECT count(*) AS n FROM crove_kernel.proposal p JOIN crove_kernel.file f ON f.org_id = p.org_id AND f.id = p.source_file_id
           WHERE p.org_id = $1 AND f.source = 'email'`,
          [org.orgId],
        );
      await until(async () => (await emailProposals()) === 1);
      // All three messages are handled: nothing pending, every raw message deleted.
      await until(async () => (await pending()) === 0 && store.keys('inbound/').length === 0);
      expect(await messages('rot-7702@')).toBe(1);
      // The retired address is dropped exactly like the unknown one: no message, no audit, blob deleted.
      expect(await messages('rot-7701@')).toBe(0);
      expect(await messages('rot-7703@')).toBe(0);
      expect(
        await count(`SELECT count(*) AS n FROM crove_kernel.audit_event WHERE command = 'kernel.inbound.receive'`, []),
      ).toBe(1);
    } finally {
      await stop();
    }

    // The worker's resolver itself knows only the active token.
    const resolve = (token: string) =>
      workerDb.transaction().execute(async (trx) => {
        const { rows } = await sql<{ org_id: string | null }>`SELECT crove_kernel.org_by_inbound_token(${token}) AS org_id`.execute(trx);
        return rows[0]?.org_id ?? null;
      });
    expect(await resolve(newToken)).toBe(org.orgId);
    expect(await resolve(newToken.toUpperCase())).toBe(org.orgId);
    expect(await resolve(oldToken)).toBeNull();
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
        await sql`SELECT crove_kernel.enter_context(${users.admin}::uuid, ${org.orgId}::uuid)`.execute(trx);
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
      await admin.query('SELECT crove_kernel.enter_context($1::uuid, $2::uuid)', [users.owner, org.orgId]);
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
