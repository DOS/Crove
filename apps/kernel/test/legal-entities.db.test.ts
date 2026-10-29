// Legal entities (#1278) on PostgreSQL 17: the default entity every org gets with it and the backfill for older orgs,
// who lists, adds and changes entities, the default entity's tax code kept equal to the org's, and the database's own
// rules (one default, its tax code the org's, a tax code once per org, no parent cycle, no delete). Set CROVE_TEST_ADMIN_URL to
// a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import type { LegalEntity } from '@crove/kernel-contract';
import { Runtime } from '@crove/kernel-runtime';
import { TEST_MANIFESTS } from './manifests.ts';
import { contextToken } from './context-token.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const MIGRATION = readFileSync(new URL('../../../supabase/migrations/20261030001000_crove_kernel_legal_entity.sql', import.meta.url), 'utf8');
const SYNC_MIGRATION = readFileSync(new URL('../../../supabase/migrations/20261101110000_crove_kernel_default_entity_tax_sync.sql', import.meta.url), 'utf8');
const suite = ADMIN ? describe : describe.skip;

suite('legal entities on PostgreSQL (#1278)', () => {
  const dbName = `crove_test_legal_entity_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let rt: Runtime;
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

  const person = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@le.test`, name: null });

  async function org(name = `Công ty ${randomUUID().slice(0, 6)}`) {
    const owner = await person('owner');
    const { orgId } = await createOrg(rt, asUser(owner), name);
    const adminUser = await person('admin');
    const member = await person('member');
    const viewer = await person('viewer');
    await admin((c) =>
      c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'viewer')", [orgId, adminUser, member, viewer]),
    );
    const exec = <T>(user: string, command: string, input: unknown) => rt.execute<T>(command, input, { actor: asUser(user), orgId });
    const list = (user: string) => rt.query<LegalEntity[]>('kernel.legal_entity.list', {}, { actor: asUser(user), orgId });
    const tenantTaxCode = async () => (await admin((c) => c.query<{ tax_code: string | null }>('SELECT tax_code FROM crove_kernel.tenant WHERE org_id = $1', [orgId]))).rows[0]?.tax_code;
    return { orgId, name, owner, admin: adminUser, member, viewer, exec, list, tenantTaxCode };
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
    const app = new URL(adminUrl);
    app.username = 'crove_app';
    app.password = 'test-app-pw';
    pool = createPool({ connectionString: app.toString(), max: 4 });
    db = createDb(pool);
    rt = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) });
  });

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('gives a new org its default entity, named as the org, and lists entities to owners and admins only', async () => {
    const o = await org('Công ty TNHH Mặc Định');
    const entities = await o.list(o.owner);
    expect(entities).toEqual([expect.objectContaining({ name: 'Công ty TNHH Mặc Định', kind: 'company', taxCode: null, parentId: null, isDefault: true })]);
    expect(await o.list(o.admin)).toEqual(entities);
    for (const user of [o.member, o.viewer]) {
      await expect(o.list(user)).rejects.toMatchObject({ status: 403 });
      await expect(o.exec(user, 'kernel.legal_entity.create', { name: 'Chi nhánh', kind: 'branch', taxCode: null, parentId: null })).rejects.toMatchObject({ status: 403 });
      await expect(
        o.exec(user, 'kernel.legal_entity.update', { legalEntityId: entities[0]!.id, name: 'Đổi', kind: 'company', taxCode: null, parentId: null }),
      ).rejects.toMatchObject({ status: 403 });
    }
  });

  it('adds and changes entities, audited, with a tax code once per org and a parent of the same org', async () => {
    const o = await org();
    const other = await org();
    const [main] = await o.list(o.owner);
    const branch = await o.exec<LegalEntity>(o.admin, 'kernel.legal_entity.create', { name: '  Chi nhánh\nHà Nội ', kind: 'branch', taxCode: ' 0101234567 001 ', parentId: main!.id });
    expect(branch).toMatchObject({ name: 'Chi nhánh Hà Nội', kind: 'branch', taxCode: '0101234567-001', parentId: main!.id, isDefault: false });
    expect((await o.list(o.owner)).map((e) => e.id)).toEqual([main!.id, branch.id]);

    // The same code again in this org is refused; another org may hold it.
    await expect(o.exec(o.owner, 'kernel.legal_entity.create', { name: 'Trùng', kind: 'branch', taxCode: '0101234567-001', parentId: null })).rejects.toMatchObject({
      status: 409,
      code: 'LEGAL_ENTITY_TAX_CODE_TAKEN',
    });
    await expect(other.exec(other.owner, 'kernel.legal_entity.create', { name: 'Khác', kind: 'branch', taxCode: '0101234567-001', parentId: null })).resolves.toMatchObject({
      taxCode: '0101234567-001',
    });
    // Bad input, and a parent from another org.
    await expect(o.exec(o.owner, 'kernel.legal_entity.create', { name: 'Sai', kind: 'company', taxCode: '12345', parentId: null })).rejects.toMatchObject({ status: 422, code: 'INVALID_TAX_CODE' });
    await expect(o.exec(o.owner, 'kernel.legal_entity.create', { name: '   ', kind: 'company', taxCode: null, parentId: null })).rejects.toMatchObject({ status: 422, code: 'INVALID_LEGAL_ENTITY_NAME' });
    const [otherMain] = await other.list(other.owner);
    await expect(o.exec(o.owner, 'kernel.legal_entity.create', { name: 'Lạc', kind: 'branch', taxCode: null, parentId: otherMain!.id })).rejects.toMatchObject({
      status: 422,
      code: 'LEGAL_ENTITY_PARENT_NOT_FOUND',
    });
    await expect(
      o.exec(o.owner, 'kernel.legal_entity.update', { legalEntityId: otherMain!.id, name: 'Lạc', kind: 'company', taxCode: null, parentId: null }),
    ).rejects.toMatchObject({ status: 404, code: 'LEGAL_ENTITY_NOT_FOUND' });

    const renamed = await o.exec<LegalEntity>(o.owner, 'kernel.legal_entity.update', { legalEntityId: branch.id, name: 'Chi nhánh Hà Nội 2', kind: 'branch', taxCode: '0101234567-001', parentId: null });
    expect(renamed).toMatchObject({ name: 'Chi nhánh Hà Nội 2', parentId: null, taxCode: '0101234567-001' });

    const audit = await admin(async (c) =>
      (
        await c.query<{ command: string; detail: Record<string, unknown> }>(
          `SELECT command, detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command LIKE 'kernel.legal_entity.%' AND outcome = 'ok' ORDER BY occurred_at, id`,
          [o.orgId],
        )
      ).rows,
    );
    expect(audit).toEqual([
      { command: 'kernel.legal_entity.create', detail: expect.objectContaining({ legalEntityId: branch.id, entity: { name: { redacted: 'pii' }, kind: 'branch', taxCode: { redacted: 'national_id_if_individual' }, parentId: main!.id } }) },
      {
        command: 'kernel.legal_entity.update',
        detail: expect.objectContaining({
          legalEntityId: branch.id,
          isDefault: false,
          changed: ['name', 'parentId'],
          previous: { name: { redacted: 'pii' }, parentId: main!.id },
          values: { name: { redacted: 'pii' }, parentId: null },
        }),
      },
    ]);
    // The name and the tax code are classified (#1626): the rows keep a marker naming the class, never the value.
    for (const value of ['Chi nhánh Hà Nội', '0101234567']) expect(JSON.stringify(audit)).not.toContain(value);
    // The refusals are audited as refused, not as done.
    const refused = await admin(async (c) =>
      (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM crove_kernel.audit_event WHERE org_id = $1 AND command LIKE 'kernel.legal_entity.%' AND outcome <> 'ok'`, [o.orgId])).rows[0]?.n,
    );
    expect(refused).toBeGreaterThan(0);
  });

  it('refuses a parent cycle', async () => {
    const o = await org();
    const [main] = await o.list(o.owner);
    const a = await o.exec<LegalEntity>(o.owner, 'kernel.legal_entity.create', { name: 'A', kind: 'branch', taxCode: null, parentId: main!.id });
    const b = await o.exec<LegalEntity>(o.owner, 'kernel.legal_entity.create', { name: 'B', kind: 'branch', taxCode: null, parentId: a.id });
    await expect(o.exec(o.owner, 'kernel.legal_entity.update', { legalEntityId: main!.id, name: main!.name, kind: 'company', taxCode: null, parentId: b.id })).rejects.toMatchObject({
      status: 422,
      code: 'LEGAL_ENTITY_CYCLE',
    });
    await expect(o.exec(o.owner, 'kernel.legal_entity.update', { legalEntityId: a.id, name: 'A', kind: 'branch', taxCode: null, parentId: a.id })).rejects.toMatchObject({ status: 422 });
    expect((await o.list(o.owner)).find((e) => e.id === main!.id)?.parentId).toBeNull();
  });

  it('keeps the default entity tax code equal to the org tax code, which only kernel.org.set_tax_code changes', async () => {
    const o = await org();
    await o.exec(o.owner, 'kernel.org.set_tax_code', { taxCode: '0101234564' });
    const [main] = await o.list(o.owner);
    expect(main).toMatchObject({ isDefault: true, taxCode: '0101234564' });
    await o.exec(o.admin, 'kernel.org.set_tax_code', { taxCode: null });
    expect((await o.list(o.owner))[0]).toMatchObject({ isDefault: true, taxCode: null });

    // The default entity's own command keeps its code, but changes the rest.
    await expect(
      o.exec(o.admin, 'kernel.legal_entity.update', { legalEntityId: main!.id, name: main!.name, kind: 'company', taxCode: '0312345670', parentId: null }),
    ).rejects.toMatchObject({ status: 422, code: 'LEGAL_ENTITY_DEFAULT_TAX_CODE' });
    await expect(o.exec(o.admin, 'kernel.legal_entity.update', { legalEntityId: main!.id, name: 'Tên pháp lý', kind: 'household', taxCode: null, parentId: null })).resolves.toMatchObject({
      name: 'Tên pháp lý',
      kind: 'household',
      taxCode: null,
    });
    expect(await o.tenantTaxCode()).toBeNull();

    // A code another entity of the org holds is refused, and nothing changes.
    await o.exec(o.owner, 'kernel.legal_entity.create', { name: 'Chi nhánh', kind: 'branch', taxCode: '0101234564-001', parentId: main!.id });
    await expect(o.exec(o.owner, 'kernel.org.set_tax_code', { taxCode: '0101234564-001' })).rejects.toMatchObject({ status: 409, code: 'LEGAL_ENTITY_TAX_CODE_TAKEN' });
    expect(await o.tenantTaxCode()).toBeNull();
    expect((await o.list(o.owner))[0]).toMatchObject({ isDefault: true, taxCode: null });
  });

  it('moves the default entity with a staff change of the tenant tax code, so the default stays editable (#1316)', async () => {
    const o = await org();
    await o.exec(o.owner, 'kernel.org.set_tax_code', { taxCode: '0101234564' });
    const [main] = await o.list(o.owner);
    const defaultRow = async () =>
      (
        await admin((c) =>
          c.query<{ tax_code: string | null; updated_by: string | null }>('SELECT tax_code, updated_by FROM crove_kernel.legal_entity WHERE org_id = $1 AND is_default', [
            o.orgId,
          ]),
        )
      ).rows[0];
    // kernel.org.set_tax_code still keeps both, the database writing the default entity in the caller's name.
    expect(await defaultRow()).toEqual({ tax_code: '0101234564', updated_by: o.owner });

    // A support fix straight on the tenant row (staff, the path tenant_tax_code_guard leaves open).
    await admin((c) => c.query(`UPDATE crove_kernel.tenant SET tax_code = '0312345670' WHERE org_id = $1`, [o.orgId]));
    expect(await o.tenantTaxCode()).toBe('0312345670');
    expect(await defaultRow()).toEqual({ tax_code: '0312345670', updated_by: null });

    // The default entity can be renamed afterwards (before #1316 this failed: its old code was not the tenant's).
    await expect(
      o.exec(o.admin, 'kernel.legal_entity.update', { legalEntityId: main!.id, name: 'Tên mới', kind: 'company', taxCode: '0312345670', parentId: null }),
    ).resolves.toMatchObject({ name: 'Tên mới', taxCode: '0312345670', isDefault: true });
    expect(await o.tenantTaxCode()).toBe('0312345670');

    // Staff clear it: the default entity follows.
    await admin((c) => c.query('UPDATE crove_kernel.tenant SET tax_code = NULL WHERE org_id = $1', [o.orgId]));
    expect(await defaultRow()).toMatchObject({ tax_code: null });

    // A code another entity of the org holds fails the staff change itself, and nothing changes.
    await o.exec(o.owner, 'kernel.legal_entity.create', { name: 'Chi nhánh', kind: 'branch', taxCode: '0312345670-001', parentId: main!.id });
    await expect(admin((c) => c.query(`UPDATE crove_kernel.tenant SET tax_code = '0312345670-001' WHERE org_id = $1`, [o.orgId]))).rejects.toMatchObject({
      code: '23505',
      constraint: 'legal_entity_tax_code_uq',
    });
    await expect(o.exec(o.owner, 'kernel.org.set_tax_code', { taxCode: '0312345670-001' })).rejects.toMatchObject({ status: 409, code: 'LEGAL_ENTITY_TAX_CODE_TAKEN' });
    expect(await o.tenantTaxCode()).toBeNull();
    expect(await defaultRow()).toMatchObject({ tax_code: null });

    // The guard's rules stand: a member's own write of the tenant code is refused before the default entity moves, and
    // an admin's write outside kernel.org.set_tax_code (no audit row) is refused at commit with it.
    const app = new URL(adminUrl);
    app.username = 'crove_app';
    app.password = 'test-app-pw';
    const c = new pg.Client({ connectionString: app.toString() });
    await c.connect();
    try {
      for (const [user, error] of [
        [o.member, /TAX_CODE_FORBIDDEN/],
        [o.admin, /TAX_CODE_UNAUDITED/],
      ] as const) {
        await c.query('BEGIN');
        try {
          await c.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [o.orgId, contextToken(user, o.orgId)]);
          await expect(
            (async () => {
              await c.query(`UPDATE crove_kernel.tenant SET tax_code = '0101234564' WHERE org_id = $1`, [o.orgId]);
              await c.query('COMMIT');
            })(),
          ).rejects.toThrow(error);
        } finally {
          await c.query('ROLLBACK');
        }
      }
    } finally {
      await c.end();
    }
    expect(await o.tenantTaxCode()).toBeNull();
    expect(await defaultRow()).toMatchObject({ tax_code: null });
  });

  it('repairs a default entity left on an old code, unless another entity holds the org code (#1316)', async () => {
    const drifted = await org();
    const blocked = await org();
    const [blockedMain] = await blocked.list(blocked.owner);
    await blocked.exec(blocked.owner, 'kernel.legal_entity.create', { name: 'Chi nhánh', kind: 'branch', taxCode: '0101234564-001', parentId: blockedMain!.id });
    // A staff change from before this fix: the tenant row moved alone.
    await admin(async (c) => {
      await c.query("SET session_replication_role = 'replica'");
      await c.query(`UPDATE crove_kernel.tenant SET tax_code = '0312345670' WHERE org_id = $1`, [drifted.orgId]);
      await c.query(`UPDATE crove_kernel.tenant SET tax_code = '0101234564-001' WHERE org_id = $1`, [blocked.orgId]);
    });
    const codeOf = async (o: { orgId: string }) =>
      (await admin((c) => c.query<{ tax_code: string | null }>('SELECT tax_code FROM crove_kernel.legal_entity WHERE org_id = $1 AND is_default', [o.orgId]))).rows[0]
        ?.tax_code;
    expect(await codeOf(drifted)).toBeNull();

    await admin(async (c) => {
      for (let run = 0; run < 2; run += 1) {
        await c.query('BEGIN');
        await c.query(SYNC_MIGRATION);
        await c.query('COMMIT');
      }
    });
    expect(await codeOf(drifted)).toBe('0312345670');
    expect(await codeOf(blocked)).toBeNull();
    expect(await blocked.tenantTaxCode()).toBe('0101234564-001');
  });

  it('holds one default per org, no delete and no change of the default flag for tenant code', async () => {
    const o = await org();
    const [main] = await o.list(o.owner);
    // As the API's tenant role in the owner's context, bypassing the commands.
    const app = new URL(adminUrl);
    app.username = 'crove_app';
    app.password = 'test-app-pw';
    const c = new pg.Client({ connectionString: app.toString() });
    await c.connect();
    try {
      const inContext = async (sql: string, params: unknown[]) => {
        await c.query('BEGIN');
        try {
          await c.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [o.orgId, contextToken(o.owner, o.orgId)]);
          return await c.query(sql, params);
        } finally {
          await c.query('ROLLBACK');
        }
      };
      await expect(inContext('DELETE FROM crove_kernel.legal_entity WHERE org_id = $1', [o.orgId])).rejects.toThrow(/permission denied/);
      await expect(inContext('UPDATE crove_kernel.legal_entity SET is_default = false WHERE org_id = $1', [o.orgId])).rejects.toThrow(/permission denied/);
      await expect(
        inContext(`INSERT INTO crove_kernel.legal_entity (org_id, name, is_default, created_by) VALUES ($1, 'Thứ hai', true, $2)`, [o.orgId, o.owner]),
      ).rejects.toMatchObject({ code: '23505', constraint: 'legal_entity_default_uq' });
      await expect(inContext('UPDATE crove_kernel.legal_entity SET parent_id = id WHERE org_id = $1 AND id = $2', [o.orgId, main!.id])).rejects.toThrow(/LEGAL_ENTITY_CYCLE/);
      await expect(inContext(`UPDATE crove_kernel.legal_entity SET tax_code = '0101234564' WHERE org_id = $1 AND id = $2`, [o.orgId, main!.id])).rejects.toThrow(
        /LEGAL_ENTITY_DEFAULT_TAX_CODE/,
      );
    } finally {
      await c.end();
    }
  });

  it('renames the org with its default entity, and never with another entity (#1317)', async () => {
    const o = await org('Công ty Tên Cũ');
    const tenantName = async () => (await admin((c) => c.query<{ name: string }>('SELECT name FROM crove_kernel.tenant WHERE org_id = $1', [o.orgId]))).rows[0]?.name;
    const [main] = await o.list(o.owner);
    const branch = await o.exec<LegalEntity>(o.owner, 'kernel.legal_entity.create', { name: 'Chi nhánh Một', kind: 'branch', taxCode: null, parentId: main!.id });
    const audits = async () =>
      (
        await admin((c) =>
          c.query<{ detail: Record<string, unknown> }>(
            "SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.legal_entity.update' AND outcome = 'ok' ORDER BY occurred_at, id",
            [o.orgId],
          ),
        )
      ).rows.map((r) => r.detail);
    const activity = async () =>
      (await admin((c) => c.query<{ kind: string }>("SELECT kind FROM crove_kernel.activity WHERE org_id = $1 AND kind = 'org.renamed'", [o.orgId]))).rows;

    // Another entity's new name leaves the org's alone.
    await o.exec(o.admin, 'kernel.legal_entity.update', { legalEntityId: branch.id, name: 'Chi nhánh Hai', kind: 'branch', taxCode: null, parentId: main!.id });
    expect(await tenantName()).toBe('Công ty Tên Cũ');
    // The default entity's new name is the org's, in the same command: one audit row says so, and the feed shows it.
    await o.exec(o.admin, 'kernel.legal_entity.update', { legalEntityId: main!.id, name: 'Công ty Tên Mới', kind: 'company', taxCode: null, parentId: null });
    expect(await tenantName()).toBe('Công ty Tên Mới');
    expect((await o.list(o.owner)).find((e) => e.isDefault)?.name).toBe('Công ty Tên Mới');
    const [first, second] = await audits();
    expect(first).not.toHaveProperty('renamesOrg');
    expect(second).toMatchObject({ legalEntityId: main!.id, isDefault: true, changed: ['name'], renamesOrg: true });
    expect(await activity()).toHaveLength(1);
    // A change of the default entity that keeps its name leaves the org's name as it is.
    await o.exec(o.admin, 'kernel.legal_entity.update', { legalEntityId: main!.id, name: 'Công ty Tên Mới', kind: 'household', taxCode: null, parentId: null });
    expect(await tenantName()).toBe('Công ty Tên Mới');
    expect((await audits())[2]).not.toHaveProperty('renamesOrg');
    expect(await activity()).toHaveLength(1);
  });

  it('makes the default entity a household business for a 12-digit tax code, unless its kind was chosen (#1317)', async () => {
    const kindOf = async (o: { orgId: string }) =>
      (await admin((c) => c.query<{ kind: string }>('SELECT kind FROM crove_kernel.legal_entity WHERE org_id = $1 AND is_default', [o.orgId]))).rows[0]?.kind;
    const taxAudits = async (o: { orgId: string }) =>
      (
        await admin((c) =>
          c.query<{ detail: Record<string, unknown> }>(
            "SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.org.set_tax_code' AND outcome = 'ok' ORDER BY occurred_at, id",
            [o.orgId],
          ),
        )
      ).rows.map((r) => r.detail);

    // A 10-digit code says nothing about the kind; a 12-digit one makes the untouched default a household, audited.
    const household = await org('Hộ kinh doanh Mới');
    await household.exec(household.owner, 'kernel.org.set_tax_code', { taxCode: '0101234564' });
    expect(await kindOf(household)).toBe('company');
    await household.exec(household.owner, 'kernel.org.set_tax_code', { taxCode: '079091001235' });
    expect(await kindOf(household)).toBe('household');
    // Again, or with another 12-digit code: nothing more changes, and the audit says so only once.
    await household.exec(household.owner, 'kernel.org.set_tax_code', { taxCode: '079091001235' });
    await household.exec(household.owner, 'kernel.org.set_tax_code', { taxCode: '079091001236' });
    expect(await kindOf(household)).toBe('household');
    expect((await taxAudits(household)).map((d) => d.defaultEntityKind ?? null)).toEqual([null, 'household', null, null]);
    // Back to a 10-digit code: the kind stays what it became.
    await household.exec(household.owner, 'kernel.org.set_tax_code', { taxCode: '0101234564' });
    expect(await kindOf(household)).toBe('household');

    // An owner who chose the kind keeps it: a company the owner set back after the 12-digit code, and a branch.
    const chosen = await org('Công ty Đã Chọn');
    const [main] = await chosen.list(chosen.owner);
    await chosen.exec(chosen.owner, 'kernel.legal_entity.update', { legalEntityId: main!.id, name: main!.name, kind: 'branch', taxCode: null, parentId: null });
    await chosen.exec(chosen.owner, 'kernel.legal_entity.update', { legalEntityId: main!.id, name: main!.name, kind: 'company', taxCode: null, parentId: null });
    await chosen.exec(chosen.owner, 'kernel.org.set_tax_code', { taxCode: '079091001237' });
    expect(await kindOf(chosen)).toBe('company');
    expect((await taxAudits(chosen))[0]).not.toHaveProperty('defaultEntityKind');
    // A rename alone is no choice of kind.
    const renamed = await org('Hộ Đổi Tên');
    const [renamedMain] = await renamed.list(renamed.owner);
    await renamed.exec(renamed.owner, 'kernel.legal_entity.update', { legalEntityId: renamedMain!.id, name: 'Hộ Đổi Tên Hai', kind: 'company', taxCode: null, parentId: null });
    await renamed.exec(renamed.owner, 'kernel.org.set_tax_code', { taxCode: '079091001238' });
    expect(await kindOf(renamed)).toBe('household');
  });

  it('backfills a default entity from the tenant row for an org without one, once, and changes nothing else', async () => {
    const legacy = await org('Hộ kinh doanh Cũ');
    const modern = await org();
    await legacy.exec(legacy.owner, 'kernel.org.set_tax_code', { taxCode: '012345678901' });
    // An org from before #1278: no entity at all.
    await admin((c) => c.query('DELETE FROM crove_kernel.legal_entity WHERE org_id = $1', [legacy.orgId]));
    const tenantBefore = await admin(async (c) => (await c.query('SELECT * FROM crove_kernel.tenant WHERE org_id = $1', [legacy.orgId])).rows[0]);
    const modernBefore = await modern.list(modern.owner);

    await admin(async (c) => {
      for (let run = 0; run < 2; run += 1) {
        await c.query('BEGIN');
        await c.query(MIGRATION);
        await c.query('COMMIT');
      }
    });
    const created = await admin(async (c) => (await c.query<{ created_at: Date }>('SELECT created_at FROM crove_kernel.tenant WHERE org_id = $1', [legacy.orgId])).rows[0]!.created_at);
    expect(await legacy.list(legacy.owner)).toEqual([
      expect.objectContaining({ name: 'Hộ kinh doanh Cũ', kind: 'company', taxCode: '012345678901', parentId: null, isDefault: true, createdAt: created.toISOString() }),
    ]);
    expect(await admin(async (c) => (await c.query('SELECT * FROM crove_kernel.tenant WHERE org_id = $1', [legacy.orgId])).rows[0])).toEqual(tenantBefore);
    expect(await modern.list(modern.owner)).toEqual(modernBefore);
  });
});
