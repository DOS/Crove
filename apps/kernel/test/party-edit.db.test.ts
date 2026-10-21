// Editing a party, a vendor or a customer, on PostgreSQL 17 (issue #887): who may edit, the version check that refuses
// an edit made over someone else's, the tax code that can be added but never changed, the field checks, the org
// boundary, and what the audit row and the activity feed keep. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run
// makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

interface Edit {
  partyId: string;
  version: number;
  name: string;
  taxCode: string | null;
  address: string | null;
  email: string | null;
  phone: string | null;
}

suite('editing a party (#887)', () => {
  const dbName = `crove_test_party_edit_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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

  async function person(name: string) {
    return upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@party.test`, name: null });
  }

  async function org() {
    const owner = await person('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    const roles: Record<'admin' | 'member' | 'viewer', string> = { admin: await person('admin'), member: await person('member'), viewer: await person('viewer') };
    for (const [role, id] of Object.entries(roles)) {
      await admin((c) => c.query('INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, $3)', [orgId, id, role]));
    }
    return { orgId, owner, ...roles };
  }

  async function party(orgId: string, values: { name: string; taxCode?: string | null; address?: string | null }) {
    const { rows } = await admin((c) =>
      c.query<{ id: string }>(
        `INSERT INTO crove_kernel.party (org_id, name, tax_code, address, source_trust) VALUES ($1, $2, $3, $4, 'external') RETURNING id`,
        [orgId, values.name, values.taxCode ?? null, values.address ?? null],
      ),
    );
    return String(rows[0]?.id);
  }

  const stored = (orgId: string, id: string) =>
    admin(async (c) => (await c.query('SELECT name, tax_code, address, email, phone, version, source_trust FROM crove_kernel.party WHERE org_id = $1 AND id = $2', [orgId, id])).rows[0]);

  const edit = (o: { orgId: string }, user: string, input: Edit) =>
    rt.execute<{ partyId: string; version: number }>('kernel.party.update', input, { actor: asUser(user), orgId: o.orgId });

  const base = (partyId: string, version = 1): Edit => ({ partyId, version, name: 'Công ty Mẫu', taxCode: null, address: null, email: null, phone: null });

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
    rt = new Runtime(db).register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) });
  });

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('lets a member correct the name and contact details, audited without the email or phone values', async () => {
    const o = await org();
    const id = await party(o.orgId, { name: 'CONG TY MAU', address: 'Hà Nội' });
    const result = await edit(o, o.member, {
      ...base(id),
      name: '  Công ty   TNHH Mẫu ',
      address: '1 Tràng Tiền,\nHoàn Kiếm, Hà Nội',
      email: 'ketoan@mau.example',
      phone: '+84 24 1234 5678',
    });
    expect(result).toEqual({ partyId: id, version: 2 });
    expect(await stored(o.orgId, id)).toEqual({
      name: 'Công ty TNHH Mẫu',
      tax_code: null,
      address: '1 Tràng Tiền, Hoàn Kiếm, Hà Nội',
      email: 'ketoan@mau.example',
      phone: '+84 24 1234 5678',
      version: 2,
      source_trust: 'user',
    });
    const [audit] = await admin(
      async (c) =>
        (await c.query<{ actor_id: string; detail: Record<string, unknown> }>(`SELECT actor_id, detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.party.update' AND outcome = 'ok'`, [o.orgId]))
          .rows,
    );
    expect(audit?.actor_id).toBe(o.member);
    expect(audit?.detail).toMatchObject({
      partyId: id,
      changed: ['name', 'address', 'email', 'phone'],
      previous: { name: 'CONG TY MAU', address: 'Hà Nội' },
      next: { name: 'Công ty TNHH Mẫu', address: '1 Tràng Tiền, Hoàn Kiếm, Hà Nội' },
    });
    expect(JSON.stringify(audit?.detail)).not.toContain('ketoan@mau.example');
    expect(JSON.stringify(audit?.detail)).not.toContain('1234 5678');
    const activity = await admin(
      async (c) => (await c.query(`SELECT kind, summary, actor_id FROM crove_kernel.activity WHERE org_id = $1 AND record_type = 'kernel.party' AND record_id = $2`, [o.orgId, id])).rows,
    );
    expect(activity).toEqual([{ kind: 'party.updated', summary: 'Đổi tên CONG TY MAU thành Công ty TNHH Mẫu', actor_id: o.member }]);
  });

  it('refuses an edit from a version someone else has already saved over, and changes nothing', async () => {
    const o = await org();
    const id = await party(o.orgId, { name: 'Công ty Mẫu' });
    await edit(o, o.admin, { ...base(id), phone: '0241234567' });
    await expect(edit(o, o.owner, { ...base(id), name: 'Tên khác' })).rejects.toMatchObject({ code: 'PARTY_CHANGED', status: 409, details: { version: 2 } });
    expect(await stored(o.orgId, id)).toMatchObject({ name: 'Công ty Mẫu', phone: '0241234567', version: 2 });
  });

  it('keeps the version and writes no activity when nothing changes', async () => {
    const o = await org();
    const id = await party(o.orgId, { name: 'Công ty Mẫu' });
    expect(await edit(o, o.owner, base(id))).toEqual({ partyId: id, version: 1 });
    const activity = await admin(async (c) => (await c.query(`SELECT 1 FROM crove_kernel.activity WHERE org_id = $1 AND record_id = $2`, [o.orgId, id])).rowCount);
    expect(activity).toBe(0);
  });

  it('refuses a viewer, and a party of another org reads as not found', async () => {
    const o = await org();
    const id = await party(o.orgId, { name: 'Công ty Mẫu' });
    await expect(edit(o, o.viewer, { ...base(id), name: 'Tên khác' })).rejects.toMatchObject({ status: 403 });
    const other = await org();
    await expect(edit(other, other.owner, { ...base(id), name: 'Tên khác' })).rejects.toMatchObject({ code: 'PARTY_NOT_FOUND', status: 404 });
    expect(await stored(o.orgId, id)).toMatchObject({ name: 'Công ty Mẫu', version: 1 });
  });

  it('adds a tax code to a party without one, and never changes or removes a tax code once set', async () => {
    const o = await org();
    const without = await party(o.orgId, { name: 'Hộ kinh doanh Mẫu' });
    expect(await edit(o, o.member, { ...base(without), name: 'Hộ kinh doanh Mẫu', taxCode: '0101 234 564' })).toEqual({ partyId: without, version: 2 });
    expect(await stored(o.orgId, without)).toMatchObject({ tax_code: '0101234564' });

    const withCode = await party(o.orgId, { name: 'Công ty Có Mã', taxCode: '0309876546' });
    for (const taxCode of ['0312345670', null]) {
      await expect(edit(o, o.owner, { ...base(withCode), name: 'Công ty Có Mã', taxCode })).rejects.toMatchObject({ code: 'PARTY_TAX_CODE_LOCKED', status: 422 });
    }
    expect(await edit(o, o.owner, { ...base(withCode), name: 'Công ty Có Mã', taxCode: '0309876546', address: 'TP.HCM' })).toEqual({ partyId: withCode, version: 2 });

    // A tax code another party already holds: the two are one party, merged by marking a duplicate.
    const third = await party(o.orgId, { name: 'Công ty Trùng' });
    await expect(edit(o, o.owner, { ...base(third), name: 'Công ty Trùng', taxCode: '0309876546' })).rejects.toMatchObject({
      code: 'PARTY_TAX_CODE_TAKEN',
      status: 409,
      details: { partyId: withCode },
    });
    await expect(edit(o, o.owner, { ...base(third), name: 'Công ty Trùng', taxCode: '12345' })).rejects.toMatchObject({ code: 'INVALID_TAX_CODE' });
  });

  it('refuses a blank or multi-thousand-character name, and an email or phone that is not one', async () => {
    const o = await org();
    const id = await party(o.orgId, { name: 'Công ty Mẫu' });
    await expect(edit(o, o.owner, { ...base(id), name: '   ' })).rejects.toMatchObject({ code: 'INVALID_PARTY_NAME' });
    await expect(edit(o, o.owner, { ...base(id), name: 'x'.repeat(301) })).rejects.toMatchObject({ code: 'INVALID_PARTY_NAME' });
    await expect(edit(o, o.owner, { ...base(id), email: 'not an email' })).rejects.toMatchObject({ code: 'INVALID_EMAIL' });
    await expect(edit(o, o.owner, { ...base(id), phone: 'call me' })).rejects.toMatchObject({ code: 'INVALID_PHONE' });
    await expect(edit(o, o.owner, { ...base(id), address: 'a\u0007b' })).rejects.toMatchObject({ code: 'INVALID_ADDRESS' });
    expect(await stored(o.orgId, id)).toMatchObject({ version: 1 });
  });
});
