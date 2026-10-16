// Retention purges (issue #38, plan §4.9) on a real PostgreSQL 17: only expired rows of the TTL tables go, never an
// audit, outbox or ledger row. Who may run it is an invariant (test/invariant/offboarding.db.test.ts).
// Set CROVE_TEST_ADMIN_URL to a superuser URL; the run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { runRetention } from '../src/retention.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));

const suite = ADMIN ? describe : describe.skip;

suite('retention purges on PostgreSQL (#38)', () => {
  const dbName = `crove_test_retention_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let db: Db;
  let workerDb: Db;
  let runtime: Runtime;
  let orgId = '';
  let owner = '';
  const silent = { log: () => {}, error: () => {} };

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  const count = (table: string, where = 'true') =>
    admin(async (c) => Number((await c.query<{ n: string }>(`SELECT count(*) AS n FROM ${table} WHERE ${where}`)).rows[0]?.n));

  // Everything retention must never touch, counted as the database owner.
  const untouchable = async () => ({
    audit: await count('crove_kernel.audit_event'),
    outbox: await count('crove_kernel.outbox_event'),
    entries: await count('crove_finance.journal_entry'),
    lines: await count('crove_finance.journal_line'),
    documents: await count('crove_finance.purchase_document'),
    files: await count('crove_kernel.file'),
    tenants: await count('crove_kernel.tenant'),
  });

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
    const loginUrl = (username: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = username;
      url.password = password;
      return url.toString();
    };
    pool = createPool({ connectionString: loginUrl('crove_app', 'test-app-pw'), max: 2 });
    workerPool = createPool({ connectionString: loginUrl('crove_worker', 'test-worker-pw'), max: 2 });
    db = createDb(pool);
    workerDb = createDb(workerPool);
    runtime = new Runtime(db).register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: 'in.test' }) });
    owner = await upsertIdentity(db, { issuer: 'test', subject: `owner-${randomUUID()}`, email: 'owner@example.com', name: null });
    orgId = (await createOrg(runtime, { type: 'user', userId: owner, aal: 'aal1' }, 'Công ty Lưu trữ', randomUUID())).orgId;

    // Seed, as the database owner: expired and live rows of each TTL table, and old rows of the stores that are kept.
    await admin(async (c) => {
      await c.query('BEGIN');
      for (let i = 0; i < 5; i++) {
        await c.query(
          `INSERT INTO crove_kernel.idempotency_key (org_id, actor_key, key, command, request_sha256, created_at)
           VALUES ($1, 'user:x', $2, 'kernel.test', 'h', now() - interval '8 days')`,
          [orgId, `old-${i}`],
        );
      }
      await c.query(
        `INSERT INTO crove_kernel.idempotency_key (org_id, actor_key, key, command, request_sha256, created_at)
         VALUES ($1, 'user:x', 'fresh', 'kernel.test', 'h', now() - interval '6 days')`,
        [orgId],
      );
      await c.query(
        `INSERT INTO crove_kernel.inbound_drop (org_id, address_id, first_dropped_at, last_dropped_at) VALUES
           ($1, $2, now() - interval '40 days', now() - interval '31 days'),
           ($1, $3, now() - interval '40 days', now() - interval '29 days')`,
        [orgId, randomUUID(), randomUUID()],
      );
      // Invites: expired 91 days ago (purged), revoked 100 days ago (purged), expired 80 days ago (kept), pending (kept).
      await c.query(
        `INSERT INTO crove_kernel.member_invite (org_id, email, role, invited_by, created_at, expires_at, status, revoked_at, revoked_by) VALUES
           ($1, 'a@example.com', 'member', $2, now() - interval '98 days', now() - interval '91 days', 'pending', NULL, NULL),
           ($1, 'b@example.com', 'member', $2, now() - interval '101 days', now() - interval '94 days', 'revoked', now() - interval '100 days', $2),
           ($1, 'c@example.com', 'member', $2, now() - interval '87 days', now() - interval '80 days', 'pending', NULL, NULL),
           ($1, 'd@example.com', 'member', $2, now(), now() + interval '7 days', 'pending', NULL, NULL)`,
        [orgId, owner],
      );
      // Staged upload grants (#223): used 8 days ago and expired unused 8 days ago (purged), used 6 days ago and
      // open now (kept). Past the insert trigger, which would set the clock, as only a superuser can.
      await c.query('SET LOCAL session_replication_role = replica');
      const stagingKey = () => `staging/${randomUUID().replaceAll('-', '')}${randomUUID().replaceAll('-', '')}`;
      for (const [age, used] of [
        ['8 days', true],
        ['8 days', false],
        ['6 days', true],
        ['0 days', false],
      ] as const) {
        await c.query(
          `INSERT INTO crove_kernel.file_upload (org_id, staging_key, created_by, max_bytes, created_at, expires_at, used_at)
           VALUES ($1, $2, $3, 1024, now() - $4::interval, now() - $4::interval + interval '5 minutes',
                   CASE WHEN $5 THEN now() - $4::interval + interval '1 minute' END)`,
          [orgId, stagingKey(), owner, age, used],
        );
      }
      await c.query('SET LOCAL session_replication_role = origin');
      // Kept for good: an audit row, an outbox event and a balanced ledger entry, all years old.
      await c.query(
        `INSERT INTO crove_kernel.audit_event (org_id, occurred_at, actor_type, command, command_id, outcome, input_sha256)
         VALUES ($1, now() - interval '3 years', 'system', 'kernel.test', $2, 'ok', 'h')`,
        [orgId, randomUUID()],
      );
      await c.query(
        `INSERT INTO crove_kernel.outbox_event (org_id, type, payload, created_at) VALUES ($1, 'kernel.test', '{}', now() - interval '3 years')`,
        [orgId],
      );
      const entry = randomUUID();
      await c.query(
        `INSERT INTO crove_finance.journal_entry (org_id, id, entry_date, description, source_type, source_id, created_at)
         VALUES ($1, $2, '2023-01-01', 'old', 'retention.test', $3, now() - interval '3 years')`,
        [orgId, entry, randomUUID()],
      );
      await c.query(
        `INSERT INTO crove_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit) VALUES
           ($1, $2, 1, '6422', '100', '0'), ($1, $2, 2, '331', '0', '100')`,
        [orgId, entry],
      );
      await c.query('COMMIT');
    });
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

  it('deletes only expired rows, in batches, and never an audit, outbox or ledger row', async () => {
    const before = await untouchable();
    // One row per table per batch: the loop keeps calling until nothing expired is left.
    const result = await runRetention(workerDb, 1, silent);
    expect(result).toEqual({
      deleted: { 'kernel.idempotency_key': 5, 'kernel.inbound_drop': 1, 'kernel.member_invite': 2, 'kernel.file_upload': 2 },
      remaining: [],
    });
    expect(await count('crove_kernel.idempotency_key', `org_id = '${orgId}' AND command = 'kernel.test'`)).toBe(1);
    expect(await count('crove_kernel.idempotency_key', `key = 'fresh'`)).toBe(1);
    expect(await count('crove_kernel.inbound_drop')).toBe(1);
    expect(
      await admin(async (c) => (await c.query<{ email: string }>(`SELECT email FROM crove_kernel.member_invite ORDER BY email`)).rows.map((r) => r.email)),
    ).toEqual(['c@example.com', 'd@example.com']);
    expect(await untouchable()).toEqual(before);
    // Grants: the two older than 7 days went; the recent used one and the open one stay.
    expect(await count('crove_kernel.file_upload', "created_at < now() - interval '7 days'")).toBe(0);
    expect(await count('crove_kernel.file_upload')).toBe(2);
    expect(await count('crove_kernel.file_upload', 'used_at IS NULL')).toBe(1);

    // A second run finds nothing to do.
    const again = await sql<{ store: string; deleted: number; more: boolean }>`SELECT * FROM crove_kernel.retention_purge(10000)`.execute(workerDb);
    expect(again.rows.every((r) => r.deleted === 0 && !r.more)).toBe(true);
    expect(await untouchable()).toEqual(before);
  });
});
