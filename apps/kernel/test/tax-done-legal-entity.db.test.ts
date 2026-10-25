// Tax obligations marked done per legal entity (#1496) on PostgreSQL 17: the backfill of older marks to the org's
// default entity, a mark per entity, the org's obligation done only once every entity it sees has marked it, and a
// member limited to one entity marking and seeing only that entity's. Set CROVE_TEST_ADMIN_URL to a superuser URL; each
// run makes its own database.
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
import type { TaxDueView } from '@crove/kernel-contract';
import { Runtime } from '@crove/kernel-runtime';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const THIS_VERSION = '20261102170000';
const suite = ADMIN ? describe : describe.skip;

suite('tax obligations done per legal entity on PostgreSQL (#1496)', () => {
  const dbName = `crove_test_tax_done_le_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let before = '';
  let pool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  let owner = '';
  let accountant = '';
  let orgId = '';
  let legacyOrgId = '';
  let defaultEntity = '';
  let branch = '';
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

  function connect() {
    pool = createPool({ connectionString: appUrl, max: 4 });
    db = createDb(pool);
    rt = new Runtime(db).register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) });
  }

  const exec = <T>(user: string, command: string, input: unknown) => rt.execute<T>(command, input, { actor: asUser(user), orgId });
  const dues = async (user: string) => (await rt.query<{ taxDues: TaxDueView[] }>('kernel.org.overview', {}, { actor: asUser(user), orgId })).taxDues;
  const listed = async (user: string, due: TaxDueView) => (await dues(user)).some((d) => d.obligation === due.obligation && d.period === due.period);

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    // The database as it was before this migration.
    before = mkdtempSync(join(tmpdir(), 'crove-tax-le-before-'));
    for (const name of readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql') && n.slice(0, 14) < THIS_VERSION)) {
      copyFileSync(join(MIGRATIONS, name), join(before, name));
    }
    await migrate({ adminUrl, dir: before });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    const app = new URL(adminUrl);
    app.username = 'crove_app';
    app.password = 'test-app-pw';
    appUrl = app.toString();
    connect();
    owner = await upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: 'owner@tax-le.test', name: null });
    accountant = await upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: 'accountant@tax-le.test', name: null });
    ({ orgId: legacyOrgId } = await createOrg(rt, asUser(owner), 'Sổ cũ'));
    // A mark written before this migration, with no entity.
    await admin((c) => c.query(`INSERT INTO crove_kernel.tax_obligation_done (org_id, obligation, period, done_by) VALUES ($1, 'license_fee', '2026', $2)`, [legacyOrgId, owner]));

    await migrate({ adminUrl, dir: MIGRATIONS });
    // Connections opened before the migration may hold plans of the table as it was.
    await pool.end();
    connect();

    ({ orgId } = await createOrg(rt, asUser(owner), 'Hai pháp nhân'));
    await admin(async (c) => {
      await c.query(`UPDATE crove_kernel.tenant SET vat_filing_period = 'month' WHERE org_id = $1`, [orgId]);
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

  it("gives every mark written before the migration its org's default entity", async () => {
    const rows = await admin((c) =>
      c.query<{ is_default: boolean }>(
        `SELECT e.is_default FROM crove_kernel.tax_obligation_done d
         JOIN crove_kernel.legal_entity e ON e.org_id = d.org_id AND e.id = d.legal_entity_id WHERE d.org_id = $1`,
        [legacyOrgId],
      ),
    );
    expect(rows.rows).toEqual([{ is_default: true }]);
  });

  it("keeps the org's obligation due until every legal entity has marked it", async () => {
    const [due] = await dues(owner);
    expect(due).toBeDefined();
    const mark = { obligation: due!.obligation, period: due!.period };

    // No entity named: the default entity's mark. The branch has not filed, so the org's obligation is still due.
    expect(await exec(owner, 'kernel.tax_obligation.done', mark)).toEqual({ ...mark, legalEntityId: defaultEntity, done: true });
    expect(await listed(owner, due!)).toBe(true);
    // Marking it again is a no-op.
    expect(await exec(owner, 'kernel.tax_obligation.done', { ...mark, legalEntityId: defaultEntity })).toEqual({ ...mark, legalEntityId: defaultEntity, done: true });

    // Both entities done: done.
    expect(await exec(owner, 'kernel.tax_obligation.done', { ...mark, legalEntityId: branch })).toEqual({ ...mark, legalEntityId: branch, done: true });
    expect(await listed(owner, due!)).toBe(false);
    const rows = await admin((c) =>
      c.query<{ legal_entity_id: string }>('SELECT legal_entity_id FROM crove_kernel.tax_obligation_done WHERE org_id = $1 AND obligation = $2 AND period = $3', [
        orgId,
        mark.obligation,
        mark.period,
      ]),
    );
    expect(rows.rows.map((r) => r.legal_entity_id).sort()).toEqual([defaultEntity, branch].sort());

    // Taking one entity's mark back makes the org's obligation due again; the other mark stays.
    expect(await exec(owner, 'kernel.tax_obligation.undo', { ...mark, legalEntityId: branch })).toEqual({ ...mark, legalEntityId: branch, done: false });
    expect(await listed(owner, due!)).toBe(true);
    expect(await exec(owner, 'kernel.tax_obligation.undo', mark)).toEqual({ ...mark, legalEntityId: defaultEntity, done: false });
    expect((await admin((c) => c.query('SELECT 1 FROM crove_kernel.tax_obligation_done WHERE org_id = $1', [orgId]))).rowCount).toBe(0);
  });

  it('lets a member limited to one entity mark and see only that entity', async () => {
    const [due] = await dues(accountant);
    expect(due).toBeDefined();
    const mark = { obligation: due!.obligation, period: due!.period };

    // The default entity is outside the accountant's scope, whether named or implied, and so is an unknown one.
    for (const input of [mark, { ...mark, legalEntityId: defaultEntity }, { ...mark, legalEntityId: randomUUID() }]) {
      await expect(exec(accountant, 'kernel.tax_obligation.done', input)).rejects.toMatchObject({ status: 422, code: 'LEGAL_ENTITY_NOT_FOUND' });
      await expect(exec(accountant, 'kernel.tax_obligation.undo', input)).rejects.toMatchObject({ status: 422, code: 'LEGAL_ENTITY_NOT_FOUND' });
    }

    // The branch's mark is the accountant's whole calendar for the period; the owner still sees the default entity due.
    expect(await exec(accountant, 'kernel.tax_obligation.done', { ...mark, legalEntityId: branch })).toEqual({ ...mark, legalEntityId: branch, done: true });
    expect(await listed(accountant, due!)).toBe(false);
    expect(await listed(owner, due!)).toBe(true);

    // The default entity's mark is the owner's; the accountant taking back the branch's leaves it in place.
    await exec(owner, 'kernel.tax_obligation.done', mark);
    expect(await listed(owner, due!)).toBe(false);
    await exec(accountant, 'kernel.tax_obligation.undo', { ...mark, legalEntityId: branch });
    expect(await listed(accountant, due!)).toBe(true);
    const left = await admin((c) => c.query<{ legal_entity_id: string }>('SELECT legal_entity_id FROM crove_kernel.tax_obligation_done WHERE org_id = $1', [orgId]));
    expect(left.rows).toEqual([{ legal_entity_id: defaultEntity }]);
  });

  it('keeps a member limited to one entity out of the other entities in the database too', async () => {
    const client = new pg.Client({ connectionString: appUrl });
    await client.connect();
    const asAccountant = async (sql: string, params: unknown[] = []) => {
      await client.query('BEGIN');
      try {
        await client.query('SELECT crove_kernel.enter_context($1::uuid, $2::uuid)', [accountant, orgId]);
        return await client.query(sql, params);
      } finally {
        await client.query('ROLLBACK');
      }
    };
    try {
      // The owner's mark of the default entity (left by the previous test) is invisible to the accountant.
      expect((await asAccountant('SELECT legal_entity_id FROM crove_kernel.tax_obligation_done')).rows).toEqual([]);
      // Naming the default entity fails le_scope, and so does naming none (no default entity in scope leaves it null).
      const insert = `INSERT INTO crove_kernel.tax_obligation_done (org_id, legal_entity_id, obligation, period, done_by) VALUES ($1, $2, 'license_fee', '2027', $3)`;
      await expect(asAccountant(insert, [orgId, defaultEntity, accountant])).rejects.toThrow(/row-level security/);
      await expect(asAccountant(insert, [orgId, null, accountant])).rejects.toThrow(/row-level security/);
      expect((await asAccountant(`${insert} RETURNING legal_entity_id`, [orgId, branch, accountant])).rows).toEqual([{ legal_entity_id: branch }]);
      expect((await asAccountant('DELETE FROM crove_kernel.tax_obligation_done')).rowCount).toBe(0);
    } finally {
      await client.end();
    }
  });

  it("refuses a write that changes a mark's entity", async () => {
    await expect(admin((c) => c.query('UPDATE crove_kernel.tax_obligation_done SET legal_entity_id = $2 WHERE org_id = $1', [orgId, branch]))).rejects.toThrow(
      /LEGAL_ENTITY_IMMUTABLE/,
    );
  });
});
