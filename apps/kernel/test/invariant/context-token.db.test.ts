// Context tokens (#1822, ADR-0028 section 9) on a real PostgreSQL 17: crove_kernel.enter_user_context seals a
// user's context only from a token the kernel signed with the deployment's key, so raw SQL on crove_app cannot name
// the user it acts as. A forged, re-signed, expired or other-org token is refused, a revoked session is refused, a
// rotation keeps exactly one previous key, and the key itself is out of reach of every login role. Set
// CROVE_TEST_ADMIN_URL to a superuser URL; the run creates and drops its own database.
// Part of the invariant suite: CI runs this file from the base branch on protected-path PRs (AGENTS.md).
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { contextTokenKeyBytes as runnerKeyBytes, installContextTokenKey, migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { contextTokenKeyBytes, mintContextToken, Runtime } from '@crove/kernel-runtime';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
// The key the migration runner installed (vitest.invariant.config.ts).
const KEY = process.env.CROVE_CONTEXT_TOKEN_KEY ?? '';
const LOGIN_ROLES = ['crove_app', 'crove_worker', 'crove_tenant', 'crove_definer_tenant', 'crove_auth_reader'];

const suite = ADMIN && KEY ? describe : describe.skip;

suite('context tokens: enter_user_context on PostgreSQL (#1822, ADR-0028 section 9)', () => {
  const dbName = `crove_test_ctxtok_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let workerUrl = '';
  const pools: pg.Pool[] = [];
  const clients: pg.Client[] = [];
  const users = { owner: '', other: '' };
  let orgA = '';
  let orgB = '';

  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const token = (userId: string, orgId: string, extra: { sessionId?: string; nowMs?: number; key?: string } = {}) =>
    mintContextToken(extra.key ?? KEY, { userId, orgId, sessionId: extra.sessionId ?? null, aal: 'aal1', mfaAt: null }, extra.nowMs);

  async function connect(url: string): Promise<pg.Client> {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    clients.push(client);
    return client;
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

  // Enters with the token in a transaction that always rolls back, and answers the sealed user (or throws).
  async function enter(c: pg.Client, orgId: string, tok: string): Promise<string | null> {
    await c.query('BEGIN');
    try {
      await c.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [orgId, tok]);
      const { rows } = await c.query<{ user: string | null }>('SELECT crove_kernel.ctx_user_id() AS user');
      return rows[0]?.user ?? null;
    } finally {
      await c.query('ROLLBACK');
    }
  }

  const install = (key: string) =>
    withAdmin(async (a) => (await a.query<{ r: string }>('SELECT crove_kernel.context_token_key_install($1::bytea) AS r', [runnerKeyBytes(key)])).rows[0]?.r);

  beforeAll(async () => {
    const base = new URL(ADMIN as string);
    const admin = new pg.Client({ connectionString: ADMIN });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS, contextTokenKey: KEY });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    const loginUrl = (username: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = username;
      url.password = password;
      return url.toString();
    };
    appUrl = loginUrl('crove_app', 'test-app-pw');
    workerUrl = loginUrl('crove_worker', 'test-worker-pw');
    const pool = createPool({ connectionString: appUrl, max: 1 });
    pools.push(pool);
    const db = createDb(pool);
    const runtime = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: 'in.test' }) });
    users.owner = await upsertIdentity(db, { issuer: 'test', subject: 'ctxtok-owner', email: 'owner@ctxtok.test', name: null });
    users.other = await upsertIdentity(db, { issuer: 'test', subject: 'ctxtok-other', email: 'other@ctxtok.test', name: null });
    orgA = (await createOrg(runtime, asUser(users.owner), 'Token A')).orgId;
    orgB = (await createOrg(runtime, asUser(users.other), 'Token B')).orgId;
  });

  afterAll(async () => {
    await Promise.all(clients.map((c) => c.end().catch(() => {})));
    await Promise.all(pools.map((p) => p.end().catch(() => {})));
    if (!adminUrl) return;
    const admin = new pg.Client({ connectionString: ADMIN });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => {});
    await admin.end();
  });

  it('seals the context of the user the token names, in the org it was made for', async () => {
    const app = await connect(appUrl);
    expect(await enter(app, orgA, token(users.owner, orgA))).toBe(users.owner);
    expect(await enter(app, orgB, token(users.other, orgB))).toBe(users.other);
  });

  it('refuses a token whose signature does not verify: a changed claim, a changed signature, another key, none', async () => {
    const app = await connect(appUrl);
    const good = token(users.owner, orgA);
    const cut = good.lastIndexOf('.');
    const message = good.slice(0, cut);
    const signature = good.slice(cut + 1);
    const flip = (s: string, i: number) => s.slice(0, i) + (s[i] === '0' ? '1' : '0') + s.slice(i + 1);
    const forged = [
      // The other member's id over the owner's signature.
      `${message.replace(users.owner.toLowerCase(), users.other.toLowerCase())}.${signature}`,
      // A later expiry over the same signature.
      `${message.replace(/\.(\d+)$/, (_, exp: string) => `.${Number(exp) + 1}`)}.${signature}`,
      `${message}.${flip(signature, 0)}`,
      `${message}.${flip(signature, 63)}`,
      `${message}.${signature.toUpperCase()}`,
      `${message}.${'0'.repeat(64)}`,
      token(users.owner, orgA, { key: randomBytes(32).toString('base64') }),
      message,
      '',
      `v2.${good.slice(3)}`,
    ];
    for (const tok of forged) {
      await expect(enter(app, orgA, tok), tok).rejects.toMatchObject({ code: '42501', message: 'CONTEXT_TOKEN_INVALID' });
    }
    await expect(enter(app, orgA, 'x'.repeat(401))).rejects.toMatchObject({ code: '42501', message: 'CONTEXT_TOKEN_INVALID' });
  });

  it('refuses a token made for another org', async () => {
    const app = await connect(appUrl);
    await expect(enter(app, orgB, token(users.owner, orgA))).rejects.toMatchObject({ code: '42501', message: 'CONTEXT_TOKEN_ORG' });
  });

  it('refuses a token past its expiry, and one dated more than 30 seconds ahead of the database clock', async () => {
    const app = await connect(appUrl);
    const now = Date.now();
    // Expiry is the kernel's clock plus 60 seconds: minted 45 seconds ago (or by a kernel clock 45 seconds behind) it
    // has 15 seconds left.
    expect(await enter(app, orgA, token(users.owner, orgA, { nowMs: now - 45_000 }))).toBe(users.owner);
    // Minted 75 seconds ago it expired 15 seconds ago: no grace after the expiry.
    await expect(enter(app, orgA, token(users.owner, orgA, { nowMs: now - 75_000 }))).rejects.toMatchObject({ code: '42501', message: 'CONTEXT_TOKEN_EXPIRED' });
    // Minted 20 seconds in the future (a kernel clock ahead of the database's): accepted.
    expect(await enter(app, orgA, token(users.owner, orgA, { nowMs: now + 20_000 }))).toBe(users.owner);
    // Minted 40 seconds in the future, expiring 100 seconds from now: more than 90 seconds ahead, refused.
    await expect(enter(app, orgA, token(users.owner, orgA, { nowMs: now + 40_000 }))).rejects.toMatchObject({ code: '42501', message: 'CONTEXT_TOKEN_EXPIRED' });
  });

  it('still checks membership: a valid token of a user outside the org enters nothing', async () => {
    const app = await connect(appUrl);
    await expect(enter(app, orgA, token(users.other, orgA))).rejects.toMatchObject({ code: '42501', message: 'NOT_A_MEMBER' });
  });

  it('refuses a token naming a session revoked for good or in this org', async () => {
    const app = await connect(appUrl);
    const revoked = randomUUID();
    const revokedInA = randomUUID();
    const live = randomUUID();
    await withAdmin(async (a) => {
      await a.query(
        `INSERT INTO crove_kernel.auth_session (user_id, session_id, status, revoked_at) VALUES ($1, $2, 'revoked', now()), ($1, $3, 'active', NULL), ($1, $4, 'active', NULL)`,
        [users.owner, revoked, revokedInA, live],
      );
      await a.query(`INSERT INTO crove_kernel.auth_session_org (org_id, user_id, session_id, status, revoked_at) VALUES ($1, $2, $3, 'revoked', now())`, [
        orgA,
        users.owner,
        revokedInA,
      ]);
    });
    await expect(enter(app, orgA, token(users.owner, orgA, { sessionId: revoked }))).rejects.toMatchObject({ code: '28000', message: 'SESSION_REVOKED' });
    await expect(enter(app, orgA, token(users.owner, orgA, { sessionId: revokedInA }))).rejects.toMatchObject({ code: '28000', message: 'SESSION_REVOKED_IN_ORG' });
    expect(await enter(app, orgA, token(users.owner, orgA, { sessionId: live }))).toBe(users.owner);
    // A session the database has not seen yet (the kernel records it on first use) is not refused here.
    expect(await enter(app, orgA, token(users.owner, orgA, { sessionId: randomUUID() }))).toBe(users.owner);
  });

  it('keeps the key out of reach of every login role', async () => {
    const { tables, functions } = await withAdmin(async (a) => {
      // Every role that can log in, apart from superusers and the table's owner (the migration runner's role).
      const t = await a.query<{ rolname: string }>(
        `SELECT r.rolname FROM pg_catalog.pg_roles r
         WHERE (r.rolcanlogin OR r.rolname = ANY($1::text[])) AND NOT r.rolsuper
           AND r.oid <> (SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = 'crove_kernel.context_token_key'::regclass)
           AND (has_table_privilege(r.oid, 'crove_kernel.context_token_key', 'SELECT')
                OR has_table_privilege(r.oid, 'crove_kernel.context_token_key', 'INSERT')
                OR has_table_privilege(r.oid, 'crove_kernel.context_token_key', 'UPDATE')
                OR has_table_privilege(r.oid, 'crove_kernel.context_token_key', 'DELETE')
                OR has_table_privilege(r.oid, 'crove_kernel.context_token_key', 'TRUNCATE')
                OR has_any_column_privilege(r.oid, 'crove_kernel.context_token_key', 'SELECT'))`,
        [LOGIN_ROLES],
      );
      const f = await a.query<{ fn: string; role: string }>(
        `SELECT f AS fn, r AS role FROM unnest($1::text[]) f CROSS JOIN unnest($2::text[]) r
         WHERE has_function_privilege(r, f, 'EXECUTE')`,
        [
          [
            'crove_kernel.context_token_key_install(bytea)',
            'crove_kernel.context_token_signed(text,text,boolean)',
            'crove_kernel.context_token_key_matches(text)',
            'crove_kernel.context_token_valid(text)',
            'crove_kernel.enter_user_context(uuid,text)',
          ],
          LOGIN_ROLES,
        ],
      );
      return { tables: t.rows, functions: f.rows };
    });
    expect(tables).toEqual([]);
    // The API's login alone enters a user's context and checks its key at boot; nobody else calls any of them.
    expect(functions).toEqual([
      { fn: 'crove_kernel.context_token_valid(text)', role: 'crove_app' },
      { fn: 'crove_kernel.enter_user_context(uuid,text)', role: 'crove_app' },
    ]);

    const app = await connect(appUrl);
    const worker = await connect(workerUrl);
    for (const c of [app, worker]) {
      await expect(c.query('SELECT * FROM crove_kernel.context_token_key')).rejects.toThrow(/permission denied/);
      await expect(c.query('SELECT crove_kernel.context_token_key_install($1::bytea)', [randomBytes(32)])).rejects.toThrow(/permission denied/);
      await expect(c.query(`SELECT crove_kernel.context_token_signed('m', $1, true)`, ['0'.repeat(64)])).rejects.toThrow(/permission denied/);
      await expect(c.query('SELECT crove_kernel.context_token_key_matches($1)', ['0'.repeat(64)])).rejects.toThrow(/permission denied/);
    }
    await expect(worker.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [orgA, token(users.owner, orgA)])).rejects.toThrow(/permission denied/);
    // The boot check answers only whether a token verifies.
    const valid = async (tok: string) => (await app.query<{ v: boolean }>('SELECT crove_kernel.context_token_valid($1) AS v', [tok])).rows[0]?.v;
    expect(await valid(token(users.owner, orgA))).toBe(true);
    expect(await valid(token(users.owner, orgA, { key: randomBytes(32).toString('base64') }))).toBe(false);
  });

  it('keeps the key out of the token and of the key errors', () => {
    const tok = token(users.owner, orgA);
    const bytes = contextTokenKeyBytes(KEY);
    expect(tok).not.toContain(KEY);
    expect(tok).not.toContain(bytes.toString('hex'));
    expect(tok.split('.')).toHaveLength(8);
    // A key of the wrong length is refused by both readers without echoing it.
    const short = Buffer.from('a short secret value').toString('base64');
    for (const read of [contextTokenKeyBytes, runnerKeyBytes]) {
      let message = '';
      try {
        read(short);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).not.toBe('');
      expect(message).not.toContain(short);
    }
  });

  it('runs the runtime through tokens once it has a key, and through enter_context without one', async () => {
    const keyed = createPool({ connectionString: appUrl, max: 1 });
    const keyless = createPool({ connectionString: appUrl, max: 1 });
    const wrong = createPool({ connectionString: appUrl, max: 1 });
    pools.push(keyed, keyless, wrong);
    const make = (pool: pg.Pool, contextTokenKey: string | null) =>
      new Runtime(createDb(pool), { manifests: TEST_MANIFESTS, contextTokenKey }).register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: 'in.test' }) });
    const ctx = { actor: asUser(users.owner), orgId: orgA };
    await expect(make(keyed, KEY).query('kernel.task.list', {}, ctx)).resolves.toBeDefined();
    await expect(make(keyless, null).query('kernel.task.list', {}, ctx)).resolves.toBeDefined();
    // A key the database does not hold: the token path is taken, and the database refuses it.
    await expect(make(wrong, randomBytes(32).toString('base64')).query('kernel.task.list', {}, ctx)).rejects.toMatchObject({ code: 'INTERNAL' });
  });

  // Last: it rotates the installed key, and puts the suite's key back as the current one at the end.
  it('keeps exactly one previous key across a rotation, for 10 minutes', async () => {
    const app = await connect(appUrl);
    const second = randomBytes(32).toString('base64');
    const third = randomBytes(48).toString('base64');
    expect(await install(KEY)).toBe('unchanged');
    const signedFirst = token(users.owner, orgA);

    expect(await install(second)).toBe('installed');
    // The first key is now the previous one: a token it signed within the TTL still enters.
    expect(await enter(app, orgA, signedFirst)).toBe(users.owner);
    expect(await enter(app, orgA, token(users.owner, orgA, { key: second }))).toBe(users.owner);

    expect(await install(third)).toBe('installed');
    // Two rotations later the first key is gone.
    await expect(enter(app, orgA, signedFirst)).rejects.toMatchObject({ code: '42501', message: 'CONTEXT_TOKEN_INVALID' });
    expect(await enter(app, orgA, token(users.owner, orgA, { key: second }))).toBe(users.owner);
    expect(await enter(app, orgA, token(users.owner, orgA, { key: third }))).toBe(users.owner);
    const slots = await withAdmin(async (a) => (await a.query<{ slot: string }>('SELECT slot FROM crove_kernel.context_token_key ORDER BY slot')).rows.map((r) => r.slot));
    expect(slots).toEqual(['current', 'previous']);
    // The boot check takes the current key only: a kernel left with the previous one stops at boot.
    const valid = async (tok: string) => (await app.query<{ v: boolean }>('SELECT crove_kernel.context_token_valid($1) AS v', [tok])).rows[0]?.v;
    expect(await valid(token(users.owner, orgA, { key: third }))).toBe(true);
    expect(await valid(token(users.owner, orgA, { key: second }))).toBe(false);

    // Ten minutes after the current key was installed, the previous one signs nothing any more.
    await withAdmin((a) => a.query(`UPDATE crove_kernel.context_token_key SET installed_at = installed_at - interval '11 minutes' WHERE slot = 'current'`));
    await expect(enter(app, orgA, token(users.owner, orgA, { key: second }))).rejects.toMatchObject({ code: '42501', message: 'CONTEXT_TOKEN_INVALID' });
    expect(await enter(app, orgA, token(users.owner, orgA, { key: third }))).toBe(users.owner);

    // A key outside 32 to 64 bytes is refused.
    await expect(withAdmin((a) => a.query('SELECT crove_kernel.context_token_key_install($1::bytea)', [randomBytes(31)]))).rejects.toMatchObject({
      message: 'CONTEXT_TOKEN_KEY_LENGTH',
    });
    await expect(withAdmin((a) => a.query('SELECT crove_kernel.context_token_key_install($1::bytea)', [randomBytes(65)]))).rejects.toMatchObject({
      message: 'CONTEXT_TOKEN_KEY_LENGTH',
    });

    // The runner sends a key only when the database holds another one; it puts the suite's key back.
    const log: string[] = [];
    await withAdmin((a) => installContextTokenKey(a, KEY, (m) => log.push(m)));
    await withAdmin((a) => installContextTokenKey(a, KEY, (m) => log.push(m)));
    expect(log).toEqual(['context token key installed', 'context token key unchanged']);
    expect(await enter(app, orgA, token(users.owner, orgA))).toBe(users.owner);
  });
});
