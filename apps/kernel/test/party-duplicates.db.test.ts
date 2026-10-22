// Duplicate parties on PostgreSQL 17 (#887): the hints, marking a duplicate and undoing it, who may, the one-level rule
// (in the commands and in the table's trigger), and what a mark changes: the vendor list and search show the kept party
// with its duplicate's documents, and the payables report adds the duplicate's balance into it. Nothing is deleted:
// the journal lines keep their own party. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity, type DuplicateHint } from '@crove/kernel';
import type { Party } from '@crove/kernel-contract';
import { Runtime } from '@crove/kernel-runtime';
import { financeCommands, financeQueries } from '@crove/mod-finance';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

// Checksum-invalid tax codes on purpose (#157).
const KEPT_TAX_CODE = '0309876546';

suite('duplicate parties (#887)', () => {
  const dbName = `crove_test_party_dup_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  let o: { orgId: string; owner: string; admin: string; member: string };
  let kept = '';
  let duplicate = '';
  let other = '';
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal2' as const, mfaAt: Math.floor(Date.now() / 1000) });

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  const person = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@dup.test`, name: null });
  const execute = <T>(name: string, input: unknown, user = o.owner) => rt.execute<T>(name, input, { actor: asUser(user), orgId: o.orgId, idempotencyKey: randomUUID() });
  const query = <T>(name: string, input: unknown, user = o.owner) => rt.query<T>(name, input, { actor: asUser(user), orgId: o.orgId });
  const vendors = () => query<Party[]>('finance.vendors.list', {});
  const payables = async () =>
    (await query<{ payables: { rows: Array<{ partyId: string | null; opening: string }> } }>('finance.ledger.period', { period: '2026-01' })).payables.rows.map((r) => [r.partyId, r.opening]);

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
    rt = new Runtime(db).register({ commands: [...kernelCommands, ...financeCommands], queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries] });

    const owner = await person('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    o = { orgId, owner, admin: await person('admin'), member: await person('member') };
    for (const role of ['admin', 'member'] as const) {
      await admin((c) => c.query('INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, $3)', [orgId, o[role], role]));
    }
    // Two payables for what is one vendor, entered once with its tax code and once by name only, and a third vendor.
    await execute('finance.opening_balance.post', {
      asOf: '2025-12-31',
      rows: [
        { rowNo: 2, accountCode: '112', accountName: 'Tiền gửi', debit: '60000000', credit: '' },
        { rowNo: 3, accountCode: '331', accountName: 'Phải trả', debit: '', credit: '30000000', partyTaxCode: KEPT_TAX_CODE, partyName: 'Công ty TNHH Dịch vụ Mẫu' },
        { rowNo: 4, accountCode: '331', accountName: 'Phải trả', debit: '', credit: '20000000', partyName: 'CONG TY TNHH DICH VU MAU' },
        { rowNo: 5, accountCode: '331', accountName: 'Phải trả', debit: '', credit: '10000000', partyName: 'Nước sạch Sông Đà' },
      ],
    });
    const ids = await admin(async (c) => (await c.query<{ id: string; name: string }>('SELECT id, name FROM crove_kernel.party WHERE org_id = $1', [orgId])).rows);
    const idOf = (name: string) => String(ids.find((p) => p.name === name)?.id);
    kept = idOf('Công ty TNHH Dịch vụ Mẫu');
    duplicate = idOf('CONG TY TNHH DICH VU MAU');
    other = idOf('Nước sạch Sông Đà');
  });

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('hints the pair, keeping the party with the tax code', async () => {
    expect(await query<DuplicateHint[]>('kernel.party.duplicate_hints', {}, o.member)).toEqual([
      { keep: { id: kept, name: 'Công ty TNHH Dịch vụ Mẫu', taxCode: KEPT_TAX_CODE }, duplicate: { id: duplicate, name: 'CONG TY TNHH DICH VU MAU', taxCode: null }, reasons: ['name'] },
    ]);
    expect(await payables()).toEqual([
      [duplicate, '20000000'],
      [kept, '30000000'],
      [other, '10000000'],
    ]);
  });

  it('lets owners and admins mark a duplicate; the list, search and payables then show the kept party alone', async () => {
    await expect(execute('kernel.party.mark_duplicate', { partyId: duplicate, keepId: kept }, o.member)).rejects.toMatchObject({ status: 403 });
    expect(await execute('kernel.party.mark_duplicate', { partyId: duplicate, keepId: kept }, o.admin)).toEqual({ partyId: duplicate, keepId: kept });

    const list = await vendors();
    expect(list.map((v) => [v.name, v.duplicates])).toEqual([
      ['Công ty TNHH Dịch vụ Mẫu', [{ id: duplicate, name: 'CONG TY TNHH DICH VU MAU', taxCode: null }]],
      ['Nước sạch Sông Đà', []],
    ]);
    // The duplicate's name still finds the vendor list's kept party; search lists the kept party only.
    expect((await query<Party[]>('finance.vendors.list', { q: 'cong ty tnhh dich' })).map((v) => v.id)).toEqual([kept]);
    expect((await query<{ parties: Array<{ id: string }> }>('finance.search', { q: 'dich vu mau' })).parties.map((p) => p.id)).toEqual([kept]);
    expect(await payables()).toEqual([
      [kept, '50000000'],
      [other, '10000000'],
    ]);
    expect(await query<DuplicateHint[]>('kernel.party.duplicate_hints', {})).toEqual([]);

    // Nothing moved: the lines keep their party, and the mark is audited and in the activity feed.
    const lines = await admin(async (c) => (await c.query(`SELECT count(*)::int AS n FROM crove_finance.journal_line WHERE org_id = $1 AND party_id = $2`, [o.orgId, duplicate])).rows);
    expect(lines).toEqual([{ n: 1 }]);
    const audit = await admin(
      async (c) => (await c.query(`SELECT actor_id, detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.party.mark_duplicate' AND outcome = 'ok'`, [o.orgId])).rows,
    );
    expect(audit).toEqual([{ actor_id: o.admin, detail: expect.objectContaining({ partyId: duplicate, keepId: kept, name: 'CONG TY TNHH DICH VU MAU', keepName: 'Công ty TNHH Dịch vụ Mẫu' }) }]);
    const activity = await admin(async (c) => (await c.query(`SELECT summary FROM crove_kernel.activity WHERE org_id = $1 AND record_id = $2 AND kind = 'party.marked_duplicate'`, [o.orgId, duplicate])).rows);
    expect(activity).toEqual([{ summary: 'Gộp CONG TY TNHH DICH VU MAU vào Công ty TNHH Dịch vụ Mẫu' }]);
    // Marking the same pair again changes nothing.
    expect(await execute('kernel.party.mark_duplicate', { partyId: duplicate, keepId: kept })).toEqual({ partyId: duplicate, keepId: kept });
  });

  it('keeps duplicates one level deep, in the commands and in the table', async () => {
    const refused = (partyId: string, keepId: string) => execute('kernel.party.mark_duplicate', { partyId, keepId });
    await expect(refused(other, other)).rejects.toMatchObject({ code: 'SAME_PARTY' });
    await expect(refused(duplicate, other)).rejects.toMatchObject({ code: 'PARTY_ALREADY_DUPLICATE', status: 409 });
    await expect(refused(other, duplicate)).rejects.toMatchObject({ code: 'PARTY_IS_DUPLICATE', status: 422, details: { keepId: kept } });
    await expect(refused(kept, other)).rejects.toMatchObject({ code: 'PARTY_HAS_DUPLICATES', status: 422 });
    await expect(refused(randomUUID(), kept)).rejects.toMatchObject({ code: 'PARTY_NOT_FOUND', status: 404 });
    // Any writer, not only the commands: the trigger refuses a chain.
    await expect(admin((c) => c.query('UPDATE crove_kernel.party SET duplicate_of = $2 WHERE org_id = $1 AND id = $3', [o.orgId, duplicate, other]))).rejects.toThrow(/PARTY_DUPLICATE_CHAIN/);
    await expect(admin((c) => c.query('UPDATE crove_kernel.party SET duplicate_of = $2 WHERE org_id = $1 AND id = $3', [o.orgId, other, kept]))).rejects.toThrow(/PARTY_DUPLICATE_CHAIN/);
    await expect(admin((c) => c.query('UPDATE crove_kernel.party SET duplicate_of = id WHERE org_id = $1 AND id = $2', [o.orgId, other]))).rejects.toThrow(/party_duplicate_not_self/);
  });

  it('separates them again, which undoes the mark', async () => {
    await expect(execute('kernel.party.unmark_duplicate', { partyId: duplicate }, o.member)).rejects.toMatchObject({ status: 403 });
    expect(await execute('kernel.party.unmark_duplicate', { partyId: duplicate })).toEqual({ partyId: duplicate });
    expect((await vendors()).map((v) => v.name)).toEqual(['CONG TY TNHH DICH VU MAU', 'Công ty TNHH Dịch vụ Mẫu', 'Nước sạch Sông Đà']);
    expect(await payables()).toEqual([
      [duplicate, '20000000'],
      [kept, '30000000'],
      [other, '10000000'],
    ]);
    const activity = await admin(async (c) => (await c.query(`SELECT summary FROM crove_kernel.activity WHERE org_id = $1 AND record_id = $2 AND kind = 'party.unmarked_duplicate'`, [o.orgId, duplicate])).rows);
    expect(activity).toEqual([{ summary: 'Tách CONG TY TNHH DICH VU MAU khỏi Công ty TNHH Dịch vụ Mẫu' }]);
    // Unmarking a party that is not a duplicate changes nothing.
    expect(await execute('kernel.party.unmark_duplicate', { partyId: duplicate })).toEqual({ partyId: duplicate });
  });

  it('lists vendors by name regardless of case, then by name and id (#999)', async () => {
    await admin((c) =>
      c.query(
        `INSERT INTO crove_kernel.party (org_id, name) VALUES ($1, 'xưởng in Bình An'), ($1, 'Xưởng in Bình An'), ($1, 'XƯỞNG IN BÌNH AN 2')`,
        [o.orgId],
      ),
    );
    const names = (await vendors()).map((v) => v.name).filter((n) => n.toLowerCase().startsWith('xưởng in'));
    expect(names).toHaveLength(3);
    // Equal ignoring case: then by the name as stored, so the order is stable between calls.
    expect(names[2]).toBe('XƯỞNG IN BÌNH AN 2');
    expect(names.slice(0, 2).sort()).toEqual(['Xưởng in Bình An', 'xưởng in Bình An'].sort());
    expect((await vendors()).map((v) => v.name)).toEqual((await vendors()).map((v) => v.name));
  });
});
