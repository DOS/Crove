// Per-client email budget for Supabase Auth (#190) on a real PostgreSQL 17: only crove_app may reserve or release
// a slot, nobody reads the table, and the definer caps one client bucket per rolling hour and one recipient per
// interval, writes nothing when it refuses, holds the limit for concurrent requests and sweeps expired rows. Part
// of the invariant suite: CI runs this file from the base branch on protected-path PRs (AGENTS.md). Set
// CROVE_TEST_ADMIN_URL to a superuser URL; the run creates and drops its own database.
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate, setRolePasswords } from '@crove/db/migrate';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const PINNED = ['search_path=pg_catalog, pg_temp'];
const RESERVE = 'crove_kernel.auth_email_reserve(text,text,integer,integer)';
const RELEASE = 'crove_kernel.auth_email_release(bigint,text)';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
let seq = 0;
const fresh = (label: string) => hash(`${label}:${Date.now()}:${++seq}:${Math.random()}`);

type Row = { reserved_id: string | null; rule: string | null; retry_after_seconds: number | null };

const suite = ADMIN ? describe : describe.skip;

suite('auth email budget (#190)', () => {
  const dbName = `crove_test_authemail_inv_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let admin: pg.Client;
  let app: pg.Pool;
  const clients: pg.Client[] = [];

  const loginUrl = (user: string, password: string) => {
    const url = new URL(adminUrl);
    url.username = user;
    url.password = password;
    return url.toString();
  };

  async function connect(url: string): Promise<pg.Client> {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    clients.push(client);
    return client;
  }

  const reserve = async (client: string, target: string | null, limit = 3, interval = 60): Promise<Row> =>
    (await app.query<Row>('SELECT reserved_id::text, rule, retry_after_seconds FROM crove_kernel.auth_email_reserve($1, $2, $3, $4)', [client, target, limit, interval]))
      .rows[0] as Row;

  const rowsOf = async (client: string) =>
    Number((await admin.query<{ n: string }>('SELECT count(*) AS n FROM crove_kernel.auth_email_send WHERE client_hash = $1', [client])).rows[0]?.n);

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw', crove_prober: 'test-prober-pw' });
    admin = await connect(adminUrl);
    app = new pg.Pool({ connectionString: loginUrl('crove_app', 'test-app-pw'), max: 8 });
  });

  afterAll(async () => {
    await app?.end().catch(() => {});
    for (const client of clients) await client.end().catch(() => {});
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('lets only crove_app execute the definers, which pin search_path (EXECUTE matrix)', async () => {
    const { rows } = await admin.query<{ fn: string; role: string }>(
      `SELECT f.fn, r.rolname AS role
       FROM unnest(ARRAY[$1, $2]) AS f(fn)
       CROSS JOIN pg_roles r
       WHERE r.rolname IN ('crove_app', 'crove_worker', 'crove_tenant', 'crove_prober', 'crove_definer_tenant', 'anon', 'authenticated')
         AND has_function_privilege(r.oid, f.fn::regprocedure, 'EXECUTE')
       ORDER BY 1, 2`,
      [RESERVE, RELEASE],
    );
    expect(rows).toEqual([
      { fn: RELEASE, role: 'crove_app' },
      { fn: RESERVE, role: 'crove_app' },
    ]);
    const { rows: acl } = await admin.query<{ fn: string; public: boolean }>(
      `SELECT p.oid::regprocedure::text AS fn,
              EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0) AS public
       FROM pg_proc p WHERE p.oid IN ($1::regprocedure, $2::regprocedure) ORDER BY 1`,
      [RESERVE, RELEASE],
    );
    expect(acl.every((a) => !a.public)).toBe(true);
    const { rows: defs } = await admin.query<{ fn: string; prosecdef: boolean; proconfig: string[] }>(
      `SELECT p.oid::regprocedure::text AS fn, p.prosecdef, p.proconfig
       FROM pg_proc p WHERE p.oid IN ($1::regprocedure, $2::regprocedure) ORDER BY 1`,
      [RESERVE, RELEASE],
    );
    expect(defs).toEqual([
      { fn: 'crove_kernel.auth_email_release(bigint,text)', prosecdef: true, proconfig: PINNED },
      { fn: 'crove_kernel.auth_email_reserve(text,text,integer,integer)', prosecdef: true, proconfig: PINNED },
    ]);
  });

  it('keeps the table closed: RLS on, no policy, no grants', async () => {
    const { rows } = await admin.query<{ rls: boolean; policies: number; acl: string[] | null }>(
      `SELECT c.relrowsecurity AS rls, (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies, c.relacl::text[] AS acl
       FROM pg_class c WHERE c.oid = 'crove_kernel.auth_email_send'::regclass`,
    );
    expect(rows[0]?.rls).toBe(true);
    expect(rows[0]?.policies).toBe(0);
    const grantees = (rows[0]?.acl ?? []).map((entry) => entry.split('=')[0]);
    const { rows: owner } = await admin.query<{ owner: string }>(
      "SELECT pg_get_userbyid(relowner) AS owner FROM pg_class WHERE oid = 'crove_kernel.auth_email_send'::regclass",
    );
    expect(grantees.filter((g) => g !== owner[0]?.owner)).toEqual([]);
    for (const [user, password] of [
      ['crove_app', 'test-app-pw'],
      ['crove_worker', 'test-worker-pw'],
    ] as const) {
      const login = await connect(loginUrl(user, password));
      await expect(login.query('SELECT count(*) FROM crove_kernel.auth_email_send')).rejects.toMatchObject({ code: '42501' });
      await expect(login.query(`INSERT INTO crove_kernel.auth_email_send (client_hash) VALUES ('${hash('x')}')`)).rejects.toMatchObject({ code: '42501' });
    }
    const worker = clients.at(-1) as pg.Client;
    await expect(worker.query(`SELECT * FROM crove_kernel.auth_email_reserve('${hash('w')}', NULL, 5, 60)`)).rejects.toMatchObject({ code: '42501' });
  });

  it('caps one client bucket per rolling hour without blocking another, and writes nothing when it refuses', async () => {
    const a = fresh('client-a');
    const b = fresh('client-b');
    for (let n = 0; n < 3; n++) expect((await reserve(a, fresh('to'))).reserved_id).not.toBeNull();
    const refused = await reserve(a, fresh('to'));
    expect(refused).toMatchObject({ reserved_id: null, rule: 'auth_email_per_client' });
    expect(refused.retry_after_seconds).toBeGreaterThan(3500);
    expect(refused.retry_after_seconds).toBeLessThanOrEqual(3600);
    expect(await rowsOf(a)).toBe(3);
    expect((await reserve(b, fresh('to'))).reserved_id).not.toBeNull();
    // A slot an hour old frees up.
    await admin.query(
      `UPDATE crove_kernel.auth_email_send SET reserved_at = reserved_at - interval '61 minutes'
       WHERE id = (SELECT min(id) FROM crove_kernel.auth_email_send WHERE client_hash = $1)`,
      [a],
    );
    expect((await reserve(a, fresh('to'))).reserved_id).not.toBeNull();
  });

  it('allows one email per recipient per interval, whichever client asks', async () => {
    const target = fresh('victim');
    expect((await reserve(fresh('c1'), target)).reserved_id).not.toBeNull();
    const refused = await reserve(fresh('c2'), target);
    expect(refused).toMatchObject({ reserved_id: null, rule: 'auth_email_per_address' });
    expect(refused.retry_after_seconds).toBeGreaterThan(50);
    expect(refused.retry_after_seconds).toBeLessThanOrEqual(60);
    // Interval 0 turns the per-recipient rule off; no recipient is never limited by it.
    expect((await reserve(fresh('c3'), target, 3, 0)).reserved_id).not.toBeNull();
    const c4 = fresh('c4');
    expect((await reserve(c4, null)).reserved_id).not.toBeNull();
    expect((await reserve(c4, null)).reserved_id).not.toBeNull();
  });

  it('releases a reservation only for the client that holds it', async () => {
    const a = fresh('rel-a');
    const first = await reserve(a, fresh('to'), 1);
    expect((await reserve(a, fresh('to'), 1)).rule).toBe('auth_email_per_client');
    await app.query('SELECT crove_kernel.auth_email_release($1, $2)', [first.reserved_id, fresh('someone-else')]);
    expect(await rowsOf(a)).toBe(1);
    await app.query('SELECT crove_kernel.auth_email_release($1, $2)', [first.reserved_id, a]);
    expect(await rowsOf(a)).toBe(0);
    expect((await reserve(a, fresh('to'), 1)).reserved_id).not.toBeNull();
  });

  it('lets exactly the limit through when one client fires concurrently', async () => {
    const a = fresh('burst');
    const results = await Promise.all(Array.from({ length: 12 }, () => reserve(a, fresh('to'), 4)));
    expect(results.filter((r) => r.reserved_id !== null)).toHaveLength(4);
    expect(results.filter((r) => r.rule === 'auth_email_per_client')).toHaveLength(8);
    expect(await rowsOf(a)).toBe(4);
  });

  it('sweeps rows older than an hour', async () => {
    const old = fresh('old');
    await admin.query(
      `INSERT INTO crove_kernel.auth_email_send (client_hash, reserved_at) SELECT $1, now() - interval '2 hours' FROM generate_series(1, 150)`,
      [old],
    );
    await reserve(fresh('sweeper'), null);
    expect(await rowsOf(old)).toBe(50);
    await reserve(fresh('sweeper'), null);
    expect(await rowsOf(old)).toBe(0);
  });

  it('refuses malformed arguments', async () => {
    const bad = [
      ['not-a-hash', null, 5, 60],
      [hash('a'), 'not-a-hash', 5, 60],
      [hash('a'), null, 0, 60],
      [hash('a'), null, 5, 3601],
      [hash('a'), null, null, 60],
    ];
    for (const args of bad) {
      await expect(app.query('SELECT * FROM crove_kernel.auth_email_reserve($1, $2, $3, $4)', args)).rejects.toMatchObject({
        code: '22023',
        message: 'AUTH_EMAIL_LIMIT_INVALID',
      });
    }
  });
});
