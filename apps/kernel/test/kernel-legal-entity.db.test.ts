// The kernel projections per legal entity (#1280 part 3) on PostgreSQL 17: extractions and notifications written
// before the migration move to the org's default entity, the entity never changes, and a member limited to one entity
// sees and writes only that entity's rows, in the notification list as in raw SQL. Proposals are scoped by #1538
// (proposal-legal-entity.db.test.ts). Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime, type InputHashMode } from '@crove/kernel-runtime';
import { TEST_MANIFESTS } from './manifests.ts';
import { enterUser } from './context-token.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const THIS_VERSION = '20261102230000';
const suite = ADMIN ? describe : describe.skip;

suite('kernel projections per legal entity on PostgreSQL (#1280 part 3)', () => {
  const dbName = `crove_test_kernel_le_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let before = '';
  let pool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  let owner = '';
  let accountant = '';
  let orgId = '';
  let defaultEntity = '';
  let branch = '';
  const legacy = { file: randomUUID(), extraction: randomUUID(), notification: randomUUID() };
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

  // The database starts before the keyed input hash's migration (20261103180000_crove_kernel_input_hash.sql), where
  // crove_kernel.command_input_hash does not exist yet: the runtime that seeds it writes the plain hash (#1741).
  function connect(inputHash: InputHashMode = 'keyed') {
    pool = createPool({ connectionString: appUrl, max: 4 });
    db = createDb(pool);
    // No context token key: the database starts at a version before enter_user_context (#1822).
    rt = new Runtime(db, { manifests: TEST_MANIFESTS, contextTokenKey: null, inputHash }).register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) });
  }

  // A file and its reading, written as the database owner, the reading in the given entity or none.
  async function filed(c: pg.Client, ids: { file: string; extraction: string }, entity?: string) {
    const sha = randomUUID().replaceAll('-', '').padEnd(64, '0');
    await c.query(
      `INSERT INTO crove_kernel.file (org_id, id, sha256, storage_key, filename, content_type, size_bytes, source)
       VALUES ($1, $2, $3, $4, 'hd.pdf', 'application/pdf', 10, 'upload')`,
      [orgId, ids.file, sha, `org/${orgId}/${sha}`],
    );
    // Without an entity the column is not named, so this also runs before the migration.
    await c.query(
      entity
        ? `INSERT INTO crove_kernel.extraction (org_id, id, file_id, method, status, checks, legal_entity_id) VALUES ($1, $2, $3, 'pdf_text_ai', 'done', '[]', $4)`
        : `INSERT INTO crove_kernel.extraction (org_id, id, file_id, method, status, checks) VALUES ($1, $2, $3, 'pdf_text_ai', 'done', '[]')`,
      entity ? [orgId, ids.extraction, ids.file, entity] : [orgId, ids.extraction, ids.file],
    );
  }

  const entityOf = async (table: string, id: string) =>
    (await admin((c) => c.query<{ legal_entity_id: string }>(`SELECT legal_entity_id FROM crove_kernel.${table} WHERE org_id = $1 AND id = $2`, [orgId, id]))).rows[0]
      ?.legal_entity_id;

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    // The database as it was before this migration.
    before = mkdtempSync(join(tmpdir(), 'crove-kernel-le-before-'));
    for (const name of readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql') && n.slice(0, 14) < THIS_VERSION)) {
      copyFileSync(join(MIGRATIONS, name), join(before, name));
    }
    await migrate({ adminUrl, dir: before });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    const app = new URL(adminUrl);
    app.username = 'crove_app';
    app.password = 'test-app-pw';
    appUrl = app.toString();
    connect('sha256');
    owner = await upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: 'owner@kernel-le.test', name: null });
    accountant = await upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: 'accountant@kernel-le.test', name: null });
    ({ orgId } = await createOrg(rt, asUser(owner), 'Hai pháp nhân'));
    // Rows written before this migration, with no entity.
    await admin(async (c) => {
      await filed(c, legacy);
      await c.query(`INSERT INTO crove_kernel.notification (org_id, id, user_id, kind, dedupe_key) VALUES ($1, $2, $3, 'kernel.approval_waiting', 'legacy')`, [
        orgId,
        legacy.notification,
        owner,
      ]);
    });

    await migrate({ adminUrl, dir: MIGRATIONS });
    // Connections opened before the migration may hold plans of the tables as they were.
    await pool.end();
    connect();

    await admin(async (c) => {
      defaultEntity = (await c.query<{ id: string }>('SELECT id FROM crove_kernel.legal_entity WHERE org_id = $1 AND is_default', [orgId])).rows[0]?.id as string;
      branch = (await c.query<{ id: string }>(`INSERT INTO crove_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhánh', 'branch', $2) RETURNING id`, [orgId, owner]))
        .rows[0]?.id as string;
      // The accountant keeps the branch's books only (an entity-scoped assignment narrows the context's le_scope).
      await c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')`, [orgId, accountant]);
      await c.query(`INSERT INTO crove_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by) VALUES ($1, $2, 'external_accountant', $3, $4)`, [
        orgId,
        accountant,
        branch,
        owner,
      ]);
    });
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    if (before) rmSync(before, { recursive: true, force: true });
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it("gives every extraction and notification written before the migration its org's default entity", async () => {
    expect(await entityOf('extraction', legacy.extraction)).toBe(defaultEntity);
    expect(await entityOf('notification', legacy.notification)).toBe(defaultEntity);
  });

  it('keeps the entity an extraction was written with, and never changes it', async () => {
    const ids = { file: randomUUID(), extraction: randomUUID() };
    await admin((c) => filed(c, ids, branch));
    expect(await entityOf('extraction', ids.extraction)).toBe(branch);
    await expect(admin((c) => c.query('UPDATE crove_kernel.extraction SET legal_entity_id = $3 WHERE org_id = $1 AND id = $2', [orgId, ids.extraction, defaultEntity]))).rejects.toThrow(
      /LEGAL_ENTITY_IMMUTABLE/,
    );
    // Proposals carry the le_scope policy too since #1538.
    const proposalPolicies = await admin((c) =>
      c.query("SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid = 'crove_kernel.proposal'::regclass AND polname = 'le_scope'"),
    );
    expect(proposalPolicies.rowCount).toBe(1);
  });

  it('shows a member limited to one entity only that entity in the notification list', async () => {
    await admin((c) =>
      c.query(
        `INSERT INTO crove_kernel.notification (org_id, user_id, kind, dedupe_key, legal_entity_id) VALUES ($1, $2, 'kernel.approval_waiting', 'branch', $3), ($1, $2, 'kernel.approval_waiting', 'default', $4)`,
        [orgId, accountant, branch, defaultEntity],
      ),
    );
    const bell = await rt.query<{ items: Array<{ id: string }> }>('kernel.notification.list', {}, { actor: asUser(accountant), orgId });
    const keys = await admin((c) =>
      c.query<{ id: string; dedupe_key: string }>('SELECT id, dedupe_key FROM crove_kernel.notification WHERE org_id = $1 AND user_id = $2', [orgId, accountant]),
    );
    expect(bell.items.map((n) => n.id)).toEqual([keys.rows.find((r) => r.dedupe_key === 'branch')?.id]);
  });

  it('keeps a member limited to one entity out of the other entities in the database too', async () => {
    const theirs = { file: randomUUID(), extraction: randomUUID() };
    await admin((c) => filed(c, theirs));
    const client = new pg.Client({ connectionString: appUrl });
    await client.connect();
    const asAccountant = async (sql: string, params: unknown[] = []) => {
      await client.query('BEGIN');
      try {
        await enterUser(client, accountant, orgId);
        return await client.query(sql, params);
      } finally {
        await client.query('ROLLBACK');
      }
    };
    try {
      for (const table of ['extraction', 'notification']) {
        const { rows } = await asAccountant(`SELECT DISTINCT legal_entity_id FROM crove_kernel.${table}`);
        expect(rows).toEqual([{ legal_entity_id: branch }]);
      }
      // A notification naming the default entity, or none (no default entity in scope leaves it null), fails le_scope.
      const insert = `INSERT INTO crove_kernel.notification (org_id, user_id, kind, dedupe_key, legal_entity_id) VALUES ($1, $2, 'kernel.approval_waiting', $3, $4)`;
      await expect(asAccountant(insert, [orgId, accountant, 'x', defaultEntity])).rejects.toThrow(/row-level security/);
      await expect(asAccountant(insert, [orgId, accountant, 'y', null])).rejects.toThrow(/row-level security/);
      // The default entity's readings are out of reach for updates too.
      expect((await asAccountant(`UPDATE crove_kernel.extraction SET error = 'x' WHERE org_id = $1 AND id = $2`, [orgId, theirs.extraction])).rowCount).toBe(0);
    } finally {
      await client.end();
    }
  });
});
