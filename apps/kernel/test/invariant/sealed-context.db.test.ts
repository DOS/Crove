// Sealed request context (plan §1 principle 3, §4.5 item 5, External-tenant gate T11) on a real PostgreSQL 17: the
// context that RLS and the definers read is the one enter_context / enter_system_context derived and sealed, and
// nothing a login role writes with set_config changes it. Set CROVE_TEST_ADMIN_URL to a superuser URL; the run
// creates and drops its own database.
// Part of the invariant suite: CI runs this file from the base branch on protected-path PRs (AGENTS.md).
import { createHmac, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime, toDomainError } from '@crove/kernel-runtime';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const SEAL_INVALID = { code: '42501', message: 'CONTEXT_SEAL_INVALID' };

const suite = ADMIN ? describe : describe.skip;

suite('sealed request context on PostgreSQL (§4.5 item 5, T11)', () => {
  const dbName = `crove_test_seal_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let workerUrl = '';
  let pool: pg.Pool;
  const users = { owner: '', other: '' };
  let orgA = '';
  let orgB = '';
  const clients: pg.Client[] = [];

  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });

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

  // Runs fn in one transaction on c and always rolls back, so a raised error never leaks into the next case.
  async function inTx<T>(c: pg.Client, fn: () => Promise<T>, begin: 'BEGIN' | 'BEGIN READ ONLY' = 'BEGIN'): Promise<T> {
    await c.query(begin);
    try {
      return await fn();
    } finally {
      await c.query('ROLLBACK');
    }
  }

  const enter = (c: pg.Client, userId: string, orgId: string) =>
    c.query('SELECT crove_kernel.enter_context($1::uuid, $2::uuid)', [userId, orgId]);
  const enterSystem = (c: pg.Client, orgId: string) => c.query('SELECT crove_kernel.enter_system_context($1::uuid)', [orgId]);

  async function settings(c: pg.Client) {
    const { rows } = await c.query<{ ctx: string; seal: string }>(
      `SELECT current_setting('crove.ctx', true) AS ctx, current_setting('crove.ctx_seal', true) AS seal`,
    );
    return rows[0] as { ctx: string; seal: string };
  }

  // Replaces fields of the stored context, keeping its seal: the text is re-rendered by jsonb, so only the named
  // fields differ from what enter_context wrote.
  const forgeFields = (c: pg.Client, patch: Record<string, unknown>) =>
    c.query(`SELECT set_config('crove.ctx', (current_setting('crove.ctx')::jsonb || $1::jsonb)::text, true)`, [JSON.stringify(patch)]);
  const setRaw = (c: pg.Client, name: string, value: string) => c.query('SELECT set_config($1, $2, true)', [name, value]);

  async function helpers(c: pg.Client) {
    const { rows } = await c.query<{
      org: string | null;
      user: string | null;
      actor: string | null;
      scope: string[] | null;
      allowed: boolean;
      flag: boolean;
    }>(
      `SELECT crove_kernel.ctx_org_id() AS org, crove_kernel.ctx_user_id() AS user, crove_kernel.ctx_actor_type() AS actor,
              crove_kernel.ctx_le_scope() AS scope, crove_kernel.ctx_le_allowed($1::uuid) AS allowed,
              crove_kernel.ctx_has_flag('salary') AS flag`,
      [randomUUID()],
    );
    return rows[0];
  }

  // Every path that reads the context: each helper, an RLS read, an RLS write and the two kinds of definer
  // (emit() is owned by the migration runner, post_journal_entry() by crove_definer_tenant).
  const USER_ACCOUNT_READ = 'SELECT count(*) FROM crove_kernel.user_account';
  const READS = [
    'SELECT crove_kernel.ctx_org_id()',
    'SELECT crove_kernel.ctx_user_id()',
    'SELECT crove_kernel.ctx_actor_type()',
    'SELECT crove_kernel.ctx_le_scope()',
    `SELECT crove_kernel.ctx_le_allowed('00000000-0000-0000-0000-000000000000'::uuid)`,
    `SELECT crove_kernel.ctx_has_flag('salary')`,
    'SELECT count(*) FROM crove_kernel.party',
    USER_ACCOUNT_READ,
  ];

  // A READ ONLY transaction refuses the INSERT before RLS runs; the definers still read the context first.
  async function readOnly(c: pg.Client): Promise<boolean> {
    const { rows } = await c.query<{ ro: string }>('SELECT current_setting($1) AS ro', ['transaction_read_only']);
    return rows[0]?.ro === 'on';
  }

  async function expectRefused(c: pg.Client, orgId: string) {
    const ro = await readOnly(c);
    for (const text of READS) {
      await c.query('SAVEPOINT probe');
      const error = await c.query(text).then(() => null, (e: unknown) => e);
      // Step 2 of #169 (#222) revokes the direct SELECT on user_account (tenant code reads it through
      // member_profiles): the read is then refused before any policy runs, which is just as closed.
      if (text === USER_ACCOUNT_READ && (error as { message?: string } | null)?.message === 'permission denied for table user_account') {
        expect(error, text).toMatchObject({ code: '42501' });
      } else {
        expect(error, text).toMatchObject(SEAL_INVALID);
      }
      await c.query('ROLLBACK TO SAVEPOINT probe');
    }
    for (const [text, values] of [
      [`INSERT INTO crove_kernel.party (org_id, name) VALUES ($1::uuid, 'forged')`, [orgId]],
      [`SELECT crove_kernel.emit('forged', '{}'::jsonb, NULL)`, []],
      [
        `SELECT crove_finance.post_journal_entry(current_date, 'forged', 'manual', NULL,
           '[{"line_no":1,"account_code":"111","debit":"1"},{"line_no":2,"account_code":"511","credit":"1"}]'::jsonb)`,
        [],
      ],
    ] as const) {
      await c.query('SAVEPOINT probe');
      if (ro && text.startsWith('INSERT')) await expect(c.query(text, [...values]), text).rejects.toThrow(/read-only transaction/);
      else await expect(c.query(text, [...values]), text).rejects.toMatchObject(SEAL_INVALID);
      await c.query('ROLLBACK TO SAVEPOINT probe');
    }
  }

  // No context at all: the helpers return NULL / false, reads see 0 rows and writes fail.
  async function expectNoAccess(c: pg.Client, orgId: string) {
    const ro = await readOnly(c);
    expect(await helpers(c)).toEqual({ org: null, user: null, actor: null, scope: null, allowed: false, flag: false });
    const { rows } = await c.query<{ n: string }>('SELECT count(*) AS n FROM crove_kernel.party');
    expect(rows[0]?.n).toBe('0');
    for (const [text, error] of [
      [`INSERT INTO crove_kernel.party (org_id, name) VALUES ('${orgId}'::uuid, 'forged')`, /row-level security/],
      [`SELECT crove_kernel.emit('forged', '{}'::jsonb, NULL)`, /NO_CONTEXT/],
      [
        `SELECT crove_finance.post_journal_entry(current_date, 'forged', 'manual', NULL,
           '[{"line_no":1,"account_code":"111","debit":"1"},{"line_no":2,"account_code":"511","credit":"1"}]'::jsonb)`,
        /NO_CONTEXT/,
      ],
    ] as const) {
      await c.query('SAVEPOINT probe');
      await expect(c.query(text), text).rejects.toThrow(ro && text.startsWith('INSERT') ? /read-only transaction/ : error);
      await c.query('ROLLBACK TO SAVEPOINT probe');
    }
  }

  beforeAll(async () => {
    const base = new URL(ADMIN as string);
    const admin = new pg.Client({ connectionString: ADMIN });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();
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
    appUrl = loginUrl('crove_app', 'test-app-pw');
    workerUrl = loginUrl('crove_worker', 'test-worker-pw');
    pool = createPool({ connectionString: appUrl, max: 1 });
    const db = createDb(pool);
    const runtime = new Runtime(db).register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: 'in.test' }) });
    users.owner = await upsertIdentity(db, { issuer: 'test', subject: 'seal-owner', email: 'owner@seal.test', name: null });
    users.other = await upsertIdentity(db, { issuer: 'test', subject: 'seal-other', email: 'other@seal.test', name: null });
    orgA = (await createOrg(runtime, asUser(users.owner), 'Seal A')).orgId;
    orgB = (await createOrg(runtime, asUser(users.other), 'Seal B')).orgId;
    await withAdmin((a) => a.query(`INSERT INTO crove_kernel.party (org_id, name) VALUES ($1, 'party of A'), ($2, 'party of B')`, [orgA, orgB]));
  });

  afterAll(async () => {
    for (const c of clients) await c.end().catch(() => {});
    await pool?.end();
    if (!ADMIN) return;
    const admin = new pg.Client({ connectionString: ADMIN });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  });

  it('seals the whole derived context with an HMAC bound to the backend and the transaction', async () => {
    const app = await connect(appUrl);
    const sealed = await inTx(app, async () => {
      await enter(app, users.owner, orgA);
      const { rows } = await app.query<{ pid: number; us: string }>(
        `SELECT pg_backend_pid() AS pid, ((extract(epoch FROM transaction_timestamp()) * 1000000)::bigint)::text AS us`,
      );
      return { ...(await settings(app)), ...rows[0], helpers: await helpers(app) };
    });
    expect(JSON.parse(sealed.ctx)).toEqual({
      v: 1,
      org: orgA,
      actor: 'user',
      user: users.owner,
      role: 'owner',
      le_scope: ['*'],
      flags: [],
    });
    expect(sealed.helpers).toEqual({ org: orgA, user: users.owner, actor: 'user', scope: ['*'], allowed: true, flag: false });

    // Recompute the seal outside the database from the stored key (only the owner can read it).
    const key = await withAdmin(async (a) => {
      const { rows } = await a.query<{ k_ipad: Buffer }>('SELECT k_ipad FROM crove_kernel.context_key WHERE id = 1');
      return Buffer.from((rows[0] as { k_ipad: Buffer }).k_ipad.map((b) => b ^ 0x36));
    });
    expect(key.length).toBe(64);
    const message = ['crove.ctx.v1', String(sealed.pid), sealed.us, sealed.ctx].join('\x1f');
    expect(sealed.seal).toMatch(/^[0-9a-f]{64}$/);
    expect(sealed.seal).toBe(createHmac('sha256', key).update(message, 'utf8').digest('hex'));

    // The system context carries no user and the same shape.
    const worker = await connect(workerUrl);
    const system = await inTx(worker, async () => {
      await enterSystem(worker, orgB);
      return { ctx: JSON.parse((await settings(worker)).ctx) as unknown, helpers: await helpers(worker) };
    });
    expect(system).toEqual({
      ctx: { v: 1, org: orgB, actor: 'system', user: null, role: null, le_scope: ['*'], flags: [] },
      helpers: { org: orgB, user: null, actor: 'system', scope: ['*'], allowed: true, flag: false },
    });
  });

  it('keeps the key and the seal functions out of reach of every Crove role', async () => {
    const { tables, functions } = await withAdmin(async (a) => {
      const t = await a.query<{ rolname: string }>(
        `SELECT r.rolname FROM pg_roles r
         WHERE r.rolname LIKE 'crove\\_%' AND NOT r.rolsuper
           AND (has_table_privilege(r.oid, 'crove_kernel.context_key', 'SELECT')
                OR has_table_privilege(r.oid, 'crove_kernel.context_key', 'INSERT')
                OR has_table_privilege(r.oid, 'crove_kernel.context_key', 'UPDATE'))
           AND r.rolname IN ('crove_app', 'crove_worker', 'crove_tenant', 'crove_definer_tenant', 'crove_auth_reader')`,
      );
      const f = await a.query<{ fn: string; role: string }>(
        `SELECT f AS fn, r AS role FROM unnest($1::text[]) f CROSS JOIN unnest($2::text[]) r
         WHERE has_function_privilege(r, f, 'EXECUTE')`,
        [
          ['crove_kernel.ctx_mac(text)', 'crove_kernel.ctx_write(jsonb)'],
          ['crove_app', 'crove_worker', 'crove_tenant', 'crove_definer_tenant', 'crove_auth_reader'],
        ],
      );
      return { tables: t.rows, functions: f.rows };
    });
    expect(tables).toEqual([]);
    expect(functions).toEqual([]);

    const app = await connect(appUrl);
    await expect(app.query('SELECT * FROM crove_kernel.context_key')).rejects.toThrow(/permission denied/);
    await expect(app.query(`SELECT crove_kernel.ctx_mac('{}')`)).rejects.toThrow(/permission denied/);
    await expect(app.query(`SELECT crove_kernel.ctx_write('{}'::jsonb)`)).rejects.toThrow(/permission denied/);
    const worker = await connect(workerUrl);
    await expect(worker.query('SELECT * FROM crove_kernel.context_key')).rejects.toThrow(/permission denied/);
    await expect(worker.query(`SELECT crove_kernel.ctx_mac('{}')`)).rejects.toThrow(/permission denied/);
  });

  it('refuses a context forged after a valid enter_context: org, legal entity, user, flags, actor, role', async () => {
    const app = await connect(appUrl);
    for (const patch of [
      { org: orgB },
      { le_scope: [randomUUID()] },
      { le_scope: ['*', randomUUID()] },
      { user: users.other },
      { user: null },
      { flags: ['salary'] },
      { flags: ['salary', 'national_id'] },
      { actor: 'system' },
      { role: 'admin' },
      { v: 2 },
    ]) {
      for (const begin of ['BEGIN', 'BEGIN READ ONLY'] as const) {
        await inTx(
          app,
          async () => {
            await enter(app, users.owner, orgA);
            await forgeFields(app, patch);
            await expectRefused(app, orgA);
          },
          begin,
        );
      }
    }
  });

  it('refuses an edited, removed or half-reset seal', async () => {
    const app = await connect(appUrl);
    const cases: Array<(c: pg.Client, s: { ctx: string; seal: string }) => Promise<unknown>> = [
      (c) => setRaw(c, 'crove.ctx_seal', '0'.repeat(64)),
      (c, s) => setRaw(c, 'crove.ctx_seal', `${s.seal.slice(0, 63)}${s.seal.endsWith('0') ? '1' : '0'}`),
      (c, s) => setRaw(c, 'crove.ctx_seal', s.seal.toUpperCase()),
      (c) => setRaw(c, 'crove.ctx_seal', ''),
      (c) => setRaw(c, 'crove.ctx', ''),
      // The same JSON, rendered differently: the seal covers the exact text.
      (c, s) => setRaw(c, 'crove.ctx', JSON.stringify(JSON.parse(s.ctx))),
      // RESET ALL clears the seal but not a context written after it.
      async (c) => {
        await c.query('RESET ALL');
        await setRaw(c, 'crove.ctx', JSON.stringify({ v: 1, org: orgB }));
      },
    ];
    for (const forge of cases) {
      await inTx(app, async () => {
        await enter(app, users.owner, orgA);
        await forge(app, await settings(app));
        await expectRefused(app, orgA);
      });
    }
  });

  it('ignores the retired plain settings: forging crove.org_id or crove.user_id grants nothing', async () => {
    const app = await connect(appUrl);
    // After a valid entry the sealed context still decides.
    await inTx(app, async () => {
      await enter(app, users.owner, orgA);
      await setRaw(app, 'crove.org_id', orgB);
      await setRaw(app, 'crove.user_id', users.other);
      expect(await helpers(app)).toMatchObject({ org: orgA, user: users.owner });
      const { rows } = await app.query<{ name: string }>('SELECT name FROM crove_kernel.party ORDER BY name');
      expect(rows.map((r) => r.name)).toEqual(['party of A']);
    });
    // Without any entry they are no context at all, as crove_app and as crove_worker.
    const worker = await connect(workerUrl);
    for (const c of [app, worker]) {
      for (const begin of ['BEGIN', 'BEGIN READ ONLY'] as const) {
        await inTx(
          c,
          async () => {
            await setRaw(c, 'crove.org_id', orgB);
            await setRaw(c, 'crove.user_id', users.other);
            await expectNoAccess(c, orgB);
          },
          begin,
        );
      }
    }
  });

  it('refuses a context written without enter_context, as crove_app and as crove_worker', async () => {
    const app = await connect(appUrl);
    const worker = await connect(workerUrl);
    const forged = (org: string, extra: Record<string, unknown> = {}) =>
      JSON.stringify({ v: 1, org, actor: 'user', user: users.other, role: 'owner', le_scope: ['*'], flags: ['salary'], ...extra });
    for (const c of [app, worker]) {
      for (const [ctx, seal] of [
        [forged(orgB), ''],
        [forged(orgB), 'f'.repeat(64)],
        ['', 'f'.repeat(64)],
        [forged(orgB, { actor: 'system', user: null, role: null }), '0'.repeat(64)],
        ['not json', '0'.repeat(64)],
      ] as const) {
        await inTx(c, async () => {
          if (ctx) await setRaw(c, 'crove.ctx', ctx);
          if (seal) await setRaw(c, 'crove.ctx_seal', seal);
          await expectRefused(c, orgB);
        });
      }
    }
  });

  it('refuses a seal replayed into a later transaction or onto another connection', async () => {
    const app = await connect(appUrl);
    // Captured in a committed transaction, then a rolled-back one.
    await app.query('BEGIN');
    await enter(app, users.owner, orgA);
    const committed = await settings(app);
    await app.query('COMMIT');
    const rolledBack = await inTx(app, async () => {
      await enter(app, users.owner, orgA);
      return settings(app);
    });
    for (const captured of [committed, rolledBack]) {
      for (const begin of ['BEGIN', 'BEGIN READ ONLY'] as const) {
        await inTx(
          app,
          async () => {
            await setRaw(app, 'crove.ctx', captured.ctx);
            await setRaw(app, 'crove.ctx_seal', captured.seal);
            await expectRefused(app, orgA);
          },
          begin,
        );
      }
    }
    // Session-level settings left over from an earlier transaction do not verify either.
    await app.query(`SELECT set_config('crove.ctx', $1, false), set_config('crove.ctx_seal', $2, false)`, [committed.ctx, committed.seal]);
    try {
      await inTx(app, () => expectRefused(app, orgA));
    } finally {
      await app.query(`RESET crove.ctx; RESET crove.ctx_seal`);
    }

    // A live seal of one connection, copied onto another connection (same role, same org) during its transaction.
    const other = await connect(appUrl);
    await app.query('BEGIN');
    try {
      await enter(app, users.owner, orgA);
      const live = await settings(app);
      await inTx(other, async () => {
        await setRaw(other, 'crove.ctx', live.ctx);
        await setRaw(other, 'crove.ctx_seal', live.seal);
        await expectRefused(other, orgA);
      });
      // The original keeps working.
      expect(await helpers(app)).toMatchObject({ org: orgA, user: users.owner });
    } finally {
      await app.query('ROLLBACK');
    }

    // A worker's system seal copied onto an API connection.
    const worker = await connect(workerUrl);
    await worker.query('BEGIN');
    try {
      await enterSystem(worker, orgB);
      const live = await settings(worker);
      await inTx(app, async () => {
        await setRaw(app, 'crove.ctx', live.ctx);
        await setRaw(app, 'crove.ctx_seal', live.seal);
        await expectRefused(app, orgB);
      });
    } finally {
      await worker.query('ROLLBACK');
    }
  });

  it('refuses forged fields on a system context', async () => {
    const worker = await connect(workerUrl);
    for (const patch of [{ org: orgA }, { user: users.owner }, { actor: 'user' }, { le_scope: [randomUUID()] }, { flags: ['salary'] }]) {
      for (const begin of ['BEGIN', 'BEGIN READ ONLY'] as const) {
        await inTx(
          worker,
          async () => {
            await enterSystem(worker, orgB);
            await forgeFields(worker, patch);
            await expectRefused(worker, orgB);
          },
          begin,
        );
      }
    }
  });

  it('refuses a forged context in the session and inbound rotation definers, with no effect', async () => {
    const app = await connect(appUrl);
    const definers = [
      ['crove_kernel.session_list', `SELECT * FROM crove_kernel.session_list($1::uuid)`, () => [users.owner]],
      ['crove_kernel.session_revoke', `SELECT * FROM crove_kernel.session_revoke($1::uuid, NULL, 'forged')`, () => [users.owner]],
      ['crove_kernel.inbound_rotate', `SELECT crove_kernel.inbound_rotate()`, () => []],
    ] as const;
    // The org-less self revoke (#184) refuses any context, so it is checked only against forged ones below.
    const orgless = [
      ['crove_kernel.session_revoke_orgless', `SELECT * FROM crove_kernel.session_revoke_orgless($1::uuid, $2::uuid, NULL, 'forged')`, () => [users.owner, randomUUID()]],
    ] as const;
    const forgeable = [...definers, ...orgless];
    const state = () =>
      withAdmin(async (a) => {
        const tokens = await a.query<{ org_id: string; inbound_token: string }>(
          'SELECT org_id, inbound_token FROM crove_kernel.tenant WHERE org_id = ANY($1::uuid[]) ORDER BY org_id',
          [[orgA, orgB]],
        );
        const addresses = await a.query<{ n: string }>(
          'SELECT count(*) AS n FROM crove_kernel.inbound_address WHERE org_id = ANY($1::uuid[])',
          [[orgA, orgB]],
        );
        const revoked = await a.query<{ n: string }>(
          `SELECT (SELECT count(*) FROM crove_kernel.auth_session_org WHERE status = 'revoked')
                + (SELECT count(*) FROM crove_kernel.auth_session WHERE status = 'revoked') AS n`,
        );
        return { tokens: tokens.rows, addresses: addresses.rows[0]?.n, revoked: revoked.rows[0]?.n };
      });

    // With the sealed context of the owner of org A, each definer runs (rolled back, nothing kept).
    for (const [name, text, args] of definers) {
      await inTx(app, async () => {
        await enter(app, users.owner, orgA);
        await expect(app.query(text, [...args()]), name).resolves.toBeDefined();
      });
    }

    const before = await state();
    for (const patch of [{ org: orgB }, { user: users.other }, { org: orgB, user: users.other, role: 'owner' }]) {
      for (const [name, text, args] of forgeable) {
        // The transaction is committed when the call succeeds: a refusal must leave nothing behind.
        await app.query('BEGIN');
        try {
          await enter(app, users.owner, orgA);
          await forgeFields(app, patch);
          await expect(app.query(text, [...args()]), name).rejects.toMatchObject(SEAL_INVALID);
        } finally {
          await app.query('COMMIT');
        }
      }
    }
    // Without any entry, a context written by hand is refused the same way.
    for (const [name, text, args] of forgeable) {
      await app.query('BEGIN');
      try {
        await setRaw(app, 'crove.ctx', JSON.stringify({ v: 1, org: orgB, actor: 'user', user: users.other, role: 'owner', le_scope: ['*'], flags: [] }));
        await setRaw(app, 'crove.ctx_seal', '0'.repeat(64));
        await expect(app.query(text, [...args()]), name).rejects.toMatchObject(SEAL_INVALID);
      } finally {
        await app.query('COMMIT');
      }
    }
    expect(await state()).toEqual(before);
  });

  it('evaluates the context once per statement in the tenant policy (InitPlan, not a per-row call)', async () => {
    const app = await connect(appUrl);
    await inTx(app, async () => {
      await enter(app, users.owner, orgA);
      for (const table of ['crove_kernel.party', 'crove_kernel.file']) {
        const { rows } = await app.query<{ 'QUERY PLAN': string }>(`EXPLAIN (VERBOSE, COSTS OFF) SELECT * FROM ${table}`);
        const plan = rows.map((r) => r['QUERY PLAN']);
        expect(plan.some((line) => /InitPlan/.test(line)), plan.join('\n')).toBe(true);
        expect(plan.some((line) => /Output: crove_kernel\.ctx_org_id\(\)/.test(line)), plan.join('\n')).toBe(true);
        // The row filter compares against the InitPlan result; the helper itself never appears in a Filter.
        expect(plan.filter((line) => /Filter:/.test(line) && /ctx_/.test(line)), plan.join('\n')).toEqual([]);
      }
    });
  });

  it('fails closed after RESET ALL: no context, no access, and no second entry', async () => {
    const app = await connect(appUrl);
    await inTx(app, async () => {
      await enter(app, users.owner, orgA);
      await app.query('RESET ALL');
      await expectNoAccess(app, orgA);
      await expect(enter(app, users.owner, orgB)).rejects.toMatchObject({ code: '42501', message: 'CONTEXT_REENTRY' });
    });
  });

  it('refuses to seal without the key, and keeps the key when the migration runs again', async () => {
    await withAdmin(async (a) => {
      const before = await a.query<{ k: string }>(`SELECT encode(k_ipad || k_opad, 'hex') AS k FROM crove_kernel.context_key`);
      expect(before.rows).toHaveLength(1);
      // Applied files are idempotent: running this one again keeps the key.
      const file = readdirSync(MIGRATIONS).find((n) => n.endsWith('_crove_kernel_sealed_context.sql')) as string;
      await a.query('BEGIN');
      try {
        await a.query(readFileSync(join(MIGRATIONS, file), 'utf8'));
        const after = await a.query<{ k: string }>(`SELECT encode(k_ipad || k_opad, 'hex') AS k FROM crove_kernel.context_key`);
        expect(after.rows).toEqual(before.rows);
        // Without the key nothing can be sealed: entering fails instead of writing an unsealed context.
        await a.query('DELETE FROM crove_kernel.context_key');
        await expect(a.query('SELECT crove_kernel.enter_context($1::uuid, $2::uuid)', [users.owner, orgA])).rejects.toMatchObject({
          code: '55000',
          message: 'CONTEXT_KEY_MISSING',
        });
      } finally {
        await a.query('ROLLBACK');
      }
    });
  });

  it('refuses to enter over a context or seal that is already set, and maps a bad seal to an internal error', async () => {
    const app = await connect(appUrl);
    for (const name of ['crove.ctx', 'crove.ctx_seal']) {
      await inTx(app, async () => {
        await setRaw(app, name, 'x');
        await expect(enter(app, users.owner, orgA)).rejects.toMatchObject({ code: '42501', message: 'CONTEXT_REENTRY' });
      });
    }
    // A forged seal is tampering or a bug: INTERNAL (logged), never a 403 that tells the caller what it hit.
    const error = await inTx(app, async () => {
      await enter(app, users.owner, orgA);
      await forgeFields(app, { org: orgB });
      return app.query('SELECT count(*) FROM crove_kernel.party').catch((e: unknown) => e);
    });
    expect(error).toMatchObject(SEAL_INVALID);
    expect(toDomainError(error)).toMatchObject({ code: 'INTERNAL', status: 500 });
  });

  // Session state that survives COMMIT and blocks the context for whoever gets the connection next (#117).
  const POISON = [
    `SELECT set_config('crove.ctx', '{"v":1}', false)`,
    `SELECT set_config('crove.ctx_seal', '${'0'.repeat(64)}', false)`,
    `SELECT set_config('crove.org_id', '00000000-0000-0000-0000-000000000000', false)`,
    `SELECT set_config('crove.user_id', '00000000-0000-0000-0000-000000000000', false)`,
    // The context lock of the re-entry guard (T10), held at session level.
    'SELECT pg_advisory_lock(1129467734, pg_backend_pid())',
    'SET ROLE crove_tenant',
    'SET search_path = public',
    'SET default_transaction_read_only = on',
  ];

  async function enterOnPooled(client: pg.PoolClient) {
    await client.query('BEGIN');
    try {
      await enter(client, users.owner, orgA);
      const { rows } = await client.query<{ name: string; who: string; org: string }>(
        `SELECT p.name, current_user AS who, crove_kernel.ctx_org_id()::text AS org FROM crove_kernel.party p ORDER BY p.name`,
      );
      await client.query('COMMIT');
      return rows;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }
  }

  it('resets the session of a pooled connection on release, so leftover settings deny no later checkout (#117)', async () => {
    const pid = async (c: pg.PoolClient) => (await c.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;

    // Without the reset (a plain pg.Pool), one session-level setting denies every later transaction on the backend.
    const plain = new pg.Pool({ connectionString: appUrl, max: 1 });
    try {
      const first = await plain.connect();
      await first.query(POISON[0] as string);
      first.release();
      const next = await plain.connect();
      try {
        await expect(enterOnPooled(next)).rejects.toMatchObject({ code: '42501', message: 'CONTEXT_REENTRY' });
        await expect(next.query('SELECT crove_kernel.ctx_org_id()')).rejects.toMatchObject(SEAL_INVALID);
      } finally {
        next.release(true);
      }
    } finally {
      await plain.end();
    }

    // createPool resets on release: the same backend (max 1) enters normally after each kind of leftover state.
    const pooled = createPool({ connectionString: appUrl, max: 1 });
    try {
      for (const poison of [...POISON, POISON.join('; ')]) {
        const first = await pooled.connect();
        const backend = await pid(first);
        await first.query(poison);
        first.release();
        const next = await pooled.connect();
        try {
          expect(await pid(next), poison).toBe(backend);
          const { rows } = await next.query<{ ctx: string; ro: string; sp: string; st: string; app: string }>(
            `SELECT current_setting('crove.ctx', true) AS ctx, current_setting('default_transaction_read_only') AS ro,
                    current_setting('search_path') AS sp, current_setting('statement_timeout') AS st,
                    current_setting('application_name') AS app`,
          );
          // Startup values (statement_timeout, application_name) survive the reset.
          expect(rows[0], poison).toEqual({ ctx: '', ro: 'off', sp: 'pg_catalog, pg_temp', st: '15s', app: 'crove' });
          expect(await enterOnPooled(next), poison).toEqual([{ name: 'party of A', who: 'crove_app', org: orgA }]);
        } finally {
          next.release();
        }
      }

      // pool.query() checks out and releases the same way.
      await pooled.query(`SELECT set_config('crove.ctx', 'x', false)`);
      const after = await pooled.connect();
      try {
        expect(await enterOnPooled(after)).toEqual([{ name: 'party of A', who: 'crove_app', org: orgA }]);
      } finally {
        after.release();
      }

      // A connection released inside a transaction is closed, not pooled: a RESET there would roll back with it.
      const open = await pooled.connect();
      const openPid = await pid(open);
      await open.query('BEGIN');
      await open.query(POISON[0] as string);
      open.release();
      const fresh = await pooled.connect();
      try {
        expect(await pid(fresh)).not.toBe(openPid);
        expect(await enterOnPooled(fresh)).toEqual([{ name: 'party of A', who: 'crove_app', org: orgA }]);
      } finally {
        fresh.release();
      }
      // Releasing twice still throws, as pg.Pool does.
      const twice = await pooled.connect();
      twice.release();
      expect(() => twice.release()).toThrow(/already been released/);
    } finally {
      await pooled.end();
    }
  });

  it('closes a pooled connection whose reset fails or that a late BEGIN left in a transaction (#117)', async () => {
    const pid = async (c: pg.PoolClient) => (await c.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
    const pooled = createPool({ connectionString: appUrl, max: 1 });
    try {
      // The backend dies while the reset waits behind a running query: the reset fails, the client is destroyed,
      // and the lost connection does not surface as an unhandled 'error' event (vitest fails the run on one).
      const dying = await pooled.connect();
      const dyingPid = await pid(dying);
      const sleeping = dying.query('SELECT pg_sleep(5)').catch((error: unknown) => error);
      dying.release();
      await withAdmin((a) => a.query('SELECT pg_terminate_backend($1)', [dyingPid]));
      expect(await sleeping).toBeInstanceOf(Error);
      const afterDeath = await pooled.connect();
      try {
        expect(await pid(afterDeath)).not.toBe(dyingPid);
        expect(await enterOnPooled(afterDeath)).toEqual([{ name: 'party of A', who: 'crove_app', org: orgA }]);
      } finally {
        afterDeath.release();
      }

      // A BEGIN still in flight at release runs before the reset; the check after the reset sees the open
      // transaction and closes the connection instead of pooling it mid-transaction.
      const late = await pooled.connect();
      const latePid = await pid(late);
      const begin = late.query('BEGIN');
      late.release();
      await begin;
      const afterLate = await pooled.connect();
      try {
        expect(await pid(afterLate)).not.toBe(latePid);
        expect(afterLate.getTransactionStatus()).toBe('I');
        expect(await enterOnPooled(afterLate)).toEqual([{ name: 'party of A', who: 'crove_app', org: orgA }]);
      } finally {
        afterLate.release();
      }
    } finally {
      await pooled.end();
    }
  });

  it('closes a connection that hit a context error instead of pooling it, with the reset turned off (#117)', async () => {
    const pid = async (c: pg.PoolClient) => (await c.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const pooled = createPool({ connectionString: appUrl, max: 1, resetOnRelease: false });
    const poison = async (statement = POISON[0] as string) => {
      const c = await pooled.connect();
      const backend = await pid(c);
      await c.query(statement);
      c.release();
      return backend;
    };
    try {
      // Without the reset a clean checkout goes back as is, and the poison reaches the next checkout.
      const backend = await poison();
      const second = await pooled.connect();
      expect(await pid(second)).toBe(backend);
      await expect(enterOnPooled(second)).rejects.toMatchObject({ code: '42501', message: 'CONTEXT_REENTRY' });
      second.release();
      // That checkout was tainted: its connection is closed, logged once with the code only.
      expect(logged.mock.calls.map((call) => String(call[0]))).toEqual(['[db] closing a pooled connection after CONTEXT_REENTRY']);
      const third = await pooled.connect();
      try {
        expect(await pid(third)).not.toBe(backend);
        expect(await enterOnPooled(third)).toEqual([{ name: 'party of A', who: 'crove_app', org: orgA }]);
      } finally {
        third.release();
      }

      // CONTEXT_SEAL_INVALID taints the same way, outside any transaction.
      const sealBackend = await poison();
      const reader = await pooled.connect();
      expect(await pid(reader)).toBe(sealBackend);
      await expect(reader.query('SELECT crove_kernel.ctx_org_id()')).rejects.toMatchObject(SEAL_INVALID);
      reader.release();
      const afterSeal = await pooled.connect();
      try {
        expect(await pid(afterSeal)).not.toBe(sealBackend);
      } finally {
        afterSeal.release();
      }

      // Through Kysely, which releases with no argument after its ROLLBACK.
      const db = createDb(pooled);
      const kyselyBackend = await poison();
      await expect(
        db.transaction().execute((trx) => sql`SELECT crove_kernel.enter_context(${users.owner}::uuid, ${orgA}::uuid)`.execute(trx)),
      ).rejects.toMatchObject({ code: '42501', message: 'CONTEXT_REENTRY' });
      const afterKysely = await pooled.connect();
      try {
        expect(await pid(afterKysely)).not.toBe(kyselyBackend);
        expect(await enterOnPooled(afterKysely)).toEqual([{ name: 'party of A', who: 'crove_app', org: orgA }]);
      } finally {
        afterKysely.release();
      }

      // A session-level lock on the re-entry guard's key (T10) left behind is recovered the same way (#105).
      expect(POISON[4]).toContain('pg_advisory_lock(1129467734');
      const lockBackend = await poison(POISON[4]);
      const locked = await pooled.connect();
      expect(await pid(locked)).toBe(lockBackend);
      await expect(enterOnPooled(locked)).rejects.toMatchObject({ code: '42501', message: 'CONTEXT_REENTRY' });
      locked.release();
      const afterLock = await pooled.connect();
      try {
        expect(await pid(afterLock)).not.toBe(lockBackend);
        expect(await enterOnPooled(afterLock)).toEqual([{ name: 'party of A', who: 'crove_app', org: orgA }]);
      } finally {
        afterLock.release();
      }
      expect(logged.mock.calls.map((call) => String(call[0]))).toEqual([
        '[db] closing a pooled connection after CONTEXT_REENTRY',
        '[db] closing a pooled connection after CONTEXT_SEAL_INVALID',
        '[db] closing a pooled connection after CONTEXT_REENTRY',
        '[db] closing a pooled connection after CONTEXT_REENTRY',
      ]);
    } finally {
      logged.mockRestore();
      await pooled.end();
    }
  });

  // Documented residual (T11, T10): ROLLBACK TO SAVEPOINT restores whatever the settings held at the savepoint, and
  // after it the re-entry lock taken since the savepoint is gone. What verifies afterwards can only be a context
  // that enter_context itself derived and sealed in this same transaction, never an edited or foreign one.
  it('lets ROLLBACK TO SAVEPOINT bring back only a context enter_context derived in the same transaction', async () => {
    const app = await connect(appUrl);
    const verified = async () => {
      await app.query('SAVEPOINT v');
      try {
        const { rows } = await app.query<{ ctx: unknown }>('SELECT crove_kernel.ctx_verified() AS ctx');
        await app.query('RELEASE SAVEPOINT v');
        return rows[0]?.ctx ?? null;
      } catch (error) {
        await app.query('ROLLBACK TO SAVEPOINT v');
        expect(error).toMatchObject(SEAL_INVALID);
        return 'refused';
      }
    };
    const derivedA = { v: 1, org: orgA, actor: 'user', user: users.owner, role: 'owner', le_scope: ['*'], flags: [] };
    const derivedB = { v: 1, org: orgB, actor: 'user', user: users.other, role: 'owner', le_scope: ['*'], flags: [] };

    // A forgery after a savepoint is refused, and rolling it back restores exactly the context entered before.
    await inTx(app, async () => {
      await enter(app, users.owner, orgA);
      for (const forge of [
        () => forgeFields(app, { org: orgB }),
        () => setRaw(app, 'crove.ctx_seal', '0'.repeat(64)),
        () => app.query('RESET ALL'),
      ]) {
        await app.query('SAVEPOINT s');
        await forge();
        expect(await verified()).not.toEqual(derivedA);
        await app.query('ROLLBACK TO SAVEPOINT s');
        expect(await verified()).toEqual(derivedA);
      }
    });

    // Entered after the savepoint and rolled back: no context at all, then a clean first entry (T10 accepts this).
    await inTx(app, async () => {
      await app.query('SAVEPOINT s');
      await enter(app, users.owner, orgA);
      const sealedA = await settings(app);
      await app.query('ROLLBACK TO SAVEPOINT s');
      expect(await verified()).toBeNull();
      // A non-member is never derived: enter_context refuses before it seals anything.
      await app.query('SAVEPOINT n');
      await expect(enter(app, users.other, orgA)).rejects.toMatchObject({ code: '42501', message: 'NOT_A_MEMBER' });
      await app.query('ROLLBACK TO SAVEPOINT n');
      expect(await verified()).toBeNull();
      await enter(app, users.other, orgB);
      expect(await verified()).toEqual(derivedB);
      // Writing back the context sealed earlier in this transaction: at most that derived context verifies.
      await app.query('SAVEPOINT w');
      await setRaw(app, 'crove.ctx', sealedA.ctx);
      await setRaw(app, 'crove.ctx_seal', sealedA.seal);
      expect([derivedA, 'refused']).toContainEqual(await verified());
      // Any edit of it is refused; the context written by the latest entry comes back with the savepoint.
      await forgeFields(app, { org: orgB });
      expect(await verified()).toBe('refused');
      await app.query('ROLLBACK TO SAVEPOINT w');
      expect(await verified()).toEqual(derivedB);
    });

    // A context derived in another transaction never verifies, whatever savepoints this one rolls back.
    const earlier = await inTx(app, async () => {
      await enter(app, users.owner, orgA);
      return settings(app);
    });
    await inTx(app, async () => {
      await app.query('SAVEPOINT s');
      await setRaw(app, 'crove.ctx', earlier.ctx);
      await setRaw(app, 'crove.ctx_seal', earlier.seal);
      expect(await verified()).toBe('refused');
      await app.query('ROLLBACK TO SAVEPOINT s');
      expect(await verified()).toBeNull();
    });
  });

  it('stops verifying seals made with the old key once the key is rotated (runbook context-key-rotation)', async () => {
    const readKey = () =>
      withAdmin(async (a) => {
        const { rows } = await a.query<{ k_ipad: Buffer }>('SELECT k_ipad FROM crove_kernel.context_key');
        expect(rows).toHaveLength(1);
        return Buffer.from((rows[0] as { k_ipad: Buffer }).k_ipad.map((b) => b ^ 0x36));
      });
    const hmac = (key: Buffer, pid: number, us: string, ctx: string) =>
      createHmac('sha256', key).update(['crove.ctx.v1', String(pid), us, ctx].join('\x1f'), 'utf8').digest('hex');

    // No Crove login role can rotate.
    for (const url of [appUrl, workerUrl]) {
      const c = await connect(url);
      await expect(c.query('SELECT crove_kernel.context_key_rotate()')).rejects.toThrow(/permission denied for function context_key_rotate/);
    }

    const oldKey = await readKey();
    const app = await connect(appUrl);
    await app.query('BEGIN');
    try {
      await enter(app, users.owner, orgA);
      const { rows } = await app.query<{ pid: number; us: string }>(
        `SELECT pg_backend_pid() AS pid, ((extract(epoch FROM transaction_timestamp()) * 1000000)::bigint)::text AS us`,
      );
      const { pid, us } = rows[0] as { pid: number; us: string };
      const before = await settings(app);
      expect(before.seal).toBe(hmac(oldKey, pid, us, before.ctx));
      expect(await helpers(app)).toMatchObject({ org: orgA, user: users.owner });

      // Rotation as the migration runner (the key's owner), committed while this transaction is still open.
      await withAdmin((a) => a.query('SELECT crove_kernel.context_key_rotate()'));
      const newKey = await readKey();
      expect(newKey.equals(oldKey)).toBe(false);
      expect(newKey.subarray(32).equals(Buffer.alloc(32))).toBe(true);
      expect(before.seal).not.toBe(hmac(newKey, pid, us, before.ctx));

      // The seal made with the old key no longer verifies: the next statement of the open transaction is refused.
      await expectRefused(app, orgA);
    } finally {
      await app.query('ROLLBACK');
    }

    // New transactions seal with the new key, and a seal made with the old key does not verify in them either.
    const fresh = await inTx(app, async () => {
      await enter(app, users.owner, orgA);
      const { rows } = await app.query<{ pid: number; us: string }>(
        `SELECT pg_backend_pid() AS pid, ((extract(epoch FROM transaction_timestamp()) * 1000000)::bigint)::text AS us`,
      );
      const { pid, us } = rows[0] as { pid: number; us: string };
      const s = await settings(app);
      const ok = await helpers(app);
      await setRaw(app, 'crove.ctx_seal', hmac(oldKey, pid, us, s.ctx));
      await expectRefused(app, orgA);
      return { s, ok, pid, us };
    });
    expect(fresh.s.seal).toBe(hmac(await readKey(), fresh.pid, fresh.us, fresh.s.ctx));
    expect(fresh.ok).toMatchObject({ org: orgA, user: users.owner });

    // A database restored without the key row (pg_dump --exclude-table-data) gets one from the same call.
    await withAdmin(async (a) => {
      await a.query('BEGIN');
      try {
        await a.query('DELETE FROM crove_kernel.context_key');
        await a.query('SELECT crove_kernel.context_key_rotate()');
        const { rows } = await a.query<{ n: string }>('SELECT count(*) AS n FROM crove_kernel.context_key');
        expect(rows[0]?.n).toBe('1');
        await expect(a.query('SELECT crove_kernel.enter_context($1::uuid, $2::uuid)', [users.owner, orgA])).resolves.toBeDefined();
      } finally {
        await a.query('ROLLBACK');
      }
    });
  });
});
