// Idempotent posting under concurrency (issue #1283, ADR-0021 decision 5, red-team S32) on a real PostgreSQL 17:
// crove_finance.post_journal_entry() serializes the calls for one source on a transaction advisory lock, so 50 clients
// posting the same source revision at the same moment leave exactly one entry and all get its id back, and 50 clients
// posting it with 50 different payloads leave one entry and 49 IDEMPOTENCY_CONFLICT refusals. The revision-keyed unique
// constraint backs the lock up for every writer, the database owner included. The posting function with the revision
// stays a pinned definer owned by crove_definer_tenant, and the payload hash helper is out of every login role's reach.
// The revision rules in one session are ordinary DB tests (apps/kernel/test/finance-source-revision.db.test.ts).
// Set CROVE_TEST_ADMIN_URL to a superuser URL; the run creates and drops its own database.
// Part of the invariant suite: CI runs this file from the base branch on protected-path PRs (AGENTS.md).
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const CLIENTS = 50;
const ROLES = ['crove_app', 'crove_worker', 'crove_tenant', 'crove_definer_tenant', 'crove_auth_reader'];
const POST_7 = 'crove_finance.post_journal_entry(date,text,text,uuid,jsonb,uuid,integer)';
const HASH = 'crove_finance.journal_payload_sha256(date,text,uuid,jsonb)';

type Line = { line_no: number; account_code: string; debit: string; credit: string };
const pair = (amount: string): Line[] => [
  { line_no: 1, account_code: '6422', debit: amount, credit: '0' },
  { line_no: 2, account_code: '331', debit: '0', credit: amount },
];

const suite = ADMIN ? describe : describe.skip;

suite('idempotent posting under concurrency (#1283)', () => {
  const dbName = `crove_test_source_lock_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let pool: pg.Pool;
  let userId = '';
  let orgId = '';

  async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }
  const withAdmin = <T>(fn: (c: pg.Client) => Promise<T>) => withClient(adminUrl, fn);

  const entriesOf = (sourceId: string) =>
    withAdmin(async (c) =>
      (
        await c.query<{ id: string; lines: number }>(
          `SELECT e.id, (SELECT count(*)::int FROM crove_finance.journal_line l WHERE l.org_id = e.org_id AND l.entry_id = e.id) AS lines
           FROM crove_finance.journal_entry e WHERE e.org_id = $1 AND e.source_id = $2`,
          [orgId, sourceId],
        )
      ).rows,
    );

  // CLIENTS API connections, each in its own transaction in the org's context, post revision 1 of one source with the
  // lines linesFor(i) gives, all released at once: the database owner holds the source's lock until every client
  // waits on it. Each client commits as soon as its call returns. Returns each call's id or error.
  async function race(sourceId: string, linesFor: (i: number) => Line[]): Promise<Array<{ id: string } | { error: { code?: string; message: string } }>> {
    const clients: pg.Client[] = [];
    const gate = new pg.Client({ connectionString: adminUrl });
    await gate.connect();
    try {
      for (let i = 0; i < CLIENTS; i++) {
        const c = new pg.Client({ connectionString: appUrl });
        await c.connect();
        clients.push(c);
        await c.query('BEGIN');
        await c.query('SELECT crove_kernel.enter_context($1::uuid, $2::uuid)', [userId, orgId]);
      }
      const key = `crove_finance.journal_entry.source:${orgId}:test.race:${sourceId}`;
      await gate.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [key]);
      const pids = await Promise.all(clients.map(async (c) => (await c.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid ?? 0));
      const calls = clients.map(async (c, i) => {
        try {
          const { rows } = await c.query<{ id: string }>(
            `SELECT crove_finance.post_journal_entry('2026-10-01'::date, 'race', 'test.race', $1::uuid, $2::jsonb, NULL::uuid, 1) AS id`,
            [sourceId, JSON.stringify(linesFor(i))],
          );
          await c.query('COMMIT');
          return { id: rows[0]?.id ?? '' };
        } catch (error) {
          await c.query('ROLLBACK').catch(() => {});
          return { error: error as { code?: string; message: string } };
        }
      });
      // Every client waits on the source's advisory lock before any of them may go on.
      let waiting = 0;
      for (let i = 0; i < 400 && waiting < CLIENTS; i++) {
        const { rows } = await gate.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid = ANY($1::int[]) AND wait_event_type = 'Lock' AND wait_event = 'advisory'`,
          [pids],
        );
        waiting = rows[0]?.n ?? 0;
        if (waiting < CLIENTS) await new Promise((r) => setTimeout(r, 25));
      }
      expect(waiting).toBe(CLIENTS);
      await gate.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [key]);
      return await Promise.all(calls);
    } finally {
      await gate.end().catch(() => {});
      await Promise.all(clients.map((c) => c.end().catch(() => {})));
    }
  }

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
    const url = new URL(adminUrl);
    url.username = 'crove_app';
    url.password = 'test-app-pw';
    appUrl = url.toString();
    pool = createPool({ connectionString: appUrl, max: 1 });
    const db = createDb(pool);
    const runtime = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: 'in.test' }) });
    userId = await upsertIdentity(db, { issuer: 'test', subject: 'source-lock', email: 'lock@source.test', name: null });
    orgId = (await createOrg(runtime, { type: 'user', userId, aal: 'aal1' }, 'Source lock')).orgId;
  });

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it(`leaves one entry when ${CLIENTS} clients replay the same source revision at once, and returns its id to all`, async () => {
    const sourceId = randomUUID();
    const results = await race(sourceId, () => pair('110000'));
    const entries = await entriesOf(sourceId);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.lines).toBe(2);
    expect(results).toEqual(Array.from({ length: CLIENTS }, () => ({ id: entries[0]?.id })));
  });

  it(`leaves one entry when ${CLIENTS} clients post the same source revision with different payloads, and refuses the rest`, async () => {
    const sourceId = randomUUID();
    const results = await race(sourceId, (i) => pair(String(1000 + i)));
    const entries = await entriesOf(sourceId);
    expect(entries).toHaveLength(1);
    const posted = results.filter((r): r is { id: string } => 'id' in r);
    expect(posted).toEqual([{ id: entries[0]?.id }]);
    const refused = results.filter((r): r is { error: { code?: string; message: string } } => 'error' in r);
    expect(refused).toHaveLength(CLIENTS - 1);
    for (const r of refused) expect(r.error).toMatchObject({ code: '23505', message: 'IDEMPOTENCY_CONFLICT' });
  });

  it('refuses a second entry for one source revision from any writer, the database owner included', async () => {
    const sourceId = randomUUID();
    const insert = (revision: number) =>
      withAdmin(async (c) => {
        await c.query('BEGIN');
        try {
          const { rows } = await c.query<{ id: string }>(
            `INSERT INTO crove_finance.journal_entry (org_id, entry_date, description, source_type, source_id, source_revision)
             VALUES ($1, '2026-10-01', 'direct', 'test.direct', $2, $3) RETURNING id`,
            [orgId, sourceId, revision],
          );
          await c.query(
            `INSERT INTO crove_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit) VALUES ($1, $2, 1, '111', 500, 0), ($1, $2, 2, '511', 0, 500)`,
            [orgId, rows[0]?.id],
          );
          await c.query('COMMIT');
          return null;
        } catch (error) {
          await c.query('ROLLBACK').catch(() => {});
          return error as { code?: string; constraint?: string };
        }
      });
    expect(await insert(1)).toBeNull();
    expect(await insert(1)).toMatchObject({ code: '23505', constraint: 'journal_entry_source_revision_key' });
    expect(await insert(0)).toMatchObject({ code: '23514', constraint: 'journal_entry_source_revision_positive' });
  });

  it('keeps the posting function with the revision a pinned definer, and the payload hash out of every login role', async () => {
    const { grants, shape } = await withAdmin(async (a) => {
      const g = await a.query<{ fn: string; role: string }>(
        `SELECT f AS fn, r AS role FROM unnest($1::text[]) f CROSS JOIN unnest($2::text[]) r
         WHERE has_function_privilege(r, f, 'EXECUTE') ORDER BY 1, 2`,
        [[POST_7, HASH], ROLES],
      );
      const s = await a.query<{ fn: string; owner: string; definer: boolean; config: string[]; public: boolean }>(
        `SELECT p.oid::regprocedure::text AS fn, pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS definer, p.proconfig AS config,
                EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x WHERE x.grantee = 0) AS public
         FROM pg_proc p WHERE p.oid IN ($1::regprocedure, $2::regprocedure) ORDER BY 1`,
        [POST_7, HASH],
      );
      return { grants: g.rows, shape: s.rows };
    });
    expect(grants).toEqual([
      { fn: HASH, role: 'crove_definer_tenant' },
      { fn: POST_7, role: 'crove_app' },
      { fn: POST_7, role: 'crove_definer_tenant' },
      { fn: POST_7, role: 'crove_tenant' },
      { fn: POST_7, role: 'crove_worker' },
    ]);
    expect(shape).toEqual([
      { fn: 'crove_finance.journal_payload_sha256(date,text,uuid,jsonb)', owner: expect.any(String), definer: false, config: ['search_path=pg_catalog, pg_temp'], public: false },
      { fn: POST_7, owner: 'crove_definer_tenant', definer: true, config: ['search_path=pg_catalog, pg_temp'], public: false },
    ]);
    const app = new pg.Client({ connectionString: appUrl });
    await app.connect();
    try {
      await expect(app.query(`SELECT crove_finance.journal_payload_sha256(current_date, 'VND', NULL, '[]'::jsonb)`)).rejects.toThrow(/permission denied/);
    } finally {
      await app.end();
    }
  });
});
