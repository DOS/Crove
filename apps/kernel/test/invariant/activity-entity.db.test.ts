// Activity rows about one legal entity whose record names none (issues #1725 and #1728) on a real PostgreSQL 17: month
// locks and unlocks, year archives and missing-invoice mails carry the entity they were for, so a member limited to
// one entity reads none of another entity's, and org-level rows stay visible to every member.
//   - Through the commands: finance.period.lock and unlock, finance.archive.build (one row per entity whose books the
//     package holds).
//   - Through SQL in each context: a row of those record types must name its entity (activity_entity_named); a writer
//     limited to one entity cannot name another (le_scope); a named entity other than the record's is still refused
//     for a record type the trigger maps (LEGAL_ENTITY_MISMATCH); a mapped type whose record is not there keeps the
//     entity the writer names (a bank import with no new line, #1728).
// Part of the invariant suite; it imports package code under test, never helpers from outside test/invariant/. Set
// CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { financeCommands, financeQueries } from '@crove/mod-finance';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

interface Row {
  record_type: string;
  kind: string;
  legal_entity_id: string | null;
}

suite('activity rows of one legal entity whose record names none (#1725, #1728)', () => {
  const dbName = `crove_test_activity_entity_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appPool: pg.Pool;
  let kyselyPool: pg.Pool;
  let runtime: Runtime;
  let orgId = '';
  let owner = '';
  // Limited to the branch by an external_accountant assignment.
  let member = '';
  let defaultEntity = '';
  let branch = '';
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const asMfa = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal2' as const, sessionId: randomUUID(), mfaAt: Math.floor(Date.now() / 1000) });

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }
  const login = (user: string, password: string) => {
    const url = new URL(adminUrl);
    url.username = user;
    url.password = password;
    return url.toString();
  };
  // One transaction as crove_app in userId's context; committed when commit is set, else rolled back.
  async function asApp<T>(userId: string, fn: (c: pg.PoolClient) => Promise<T>, commit = false): Promise<T> {
    const c = await appPool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT crove_kernel.enter_context($1::uuid, $2::uuid)', [userId, orgId]);
      const result = await fn(c);
      await c.query(commit ? 'COMMIT' : 'ROLLBACK');
      return result;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }
  // The activity rows of these record types a user reads in their own context.
  const readAs = (userId: string, types: string[]) =>
    asApp(userId, async (c) =>
      (
        await c.query<Row>(
          'SELECT record_type, kind, legal_entity_id FROM crove_kernel.activity WHERE record_type = ANY($1::text[]) ORDER BY occurred_at, id',
          [types],
        )
      ).rows,
    );
  // A row written in userId's context as ctx.activity writes it; rolled back unless commit is set.
  const write = (userId: string, recordType: string, recordId: string, entity: string | null, commit = false) =>
    asApp(
      userId,
      (c) =>
        c.query(
          `INSERT INTO crove_kernel.activity (org_id, record_type, record_id, kind, summary, actor_id, legal_entity_id)
           VALUES ($1, $2, $3, 'test.row', 'Dòng thử', $4, $5) RETURNING legal_entity_id`,
          [orgId, recordType, recordId, userId, entity],
        ),
      commit,
    );

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
    appPool = new pg.Pool({ connectionString: login('crove_app', 'test-app-pw'), max: 3 });
    kyselyPool = createPool({ connectionString: login('crove_app', 'test-app-pw'), max: 3 });
    const db = createDb(kyselyPool);
    runtime = new Runtime(db).register({
      commands: [...kernelCommands, ...financeCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries],
    });
    owner = await upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: 'owner@activity-entity.test', name: null });
    member = await upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: 'member@activity-entity.test', name: null });
    ({ orgId } = await createOrg(runtime, asUser(owner), 'Nhật ký hai pháp nhân'));
    await admin(async (a) => {
      defaultEntity = (await a.query<{ id: string }>('SELECT id FROM crove_kernel.legal_entity WHERE org_id = $1 AND is_default', [orgId])).rows[0]?.id as string;
      branch = (
        await a.query<{ id: string }>(`INSERT INTO crove_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhánh Cần Thơ', 'branch', $2) RETURNING id`, [orgId, owner])
      ).rows[0]?.id as string;
      await a.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')`, [orgId, member]);
      await a.query(`INSERT INTO crove_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by) VALUES ($1, $2, 'external_accountant', $3, $4)`, [
        orgId,
        member,
        branch,
        owner,
      ]);
    });
    // An entry of the branch in 2025, so the 2025 package holds the books of both entities.
    await asApp(
      owner,
      (c) =>
        c.query(`SELECT crove_finance.post_journal_entry('2025-06-15'::date, 'activity entity', 'test.activity', $1::uuid, $2::jsonb, NULL, 1, $3::uuid)`, [
          randomUUID(),
          JSON.stringify([
            { line_no: 1, account_code: '6422', debit: '100000', credit: '0' },
            { line_no: 2, account_code: '331', debit: '0', credit: '100000' },
          ]),
          branch,
        ]),
      true,
    );
  }, 300_000);

  afterAll(async () => {
    await appPool?.end();
    await kyselyPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it("shows a member limited to one entity its own month locks, archive and unlock, and none of another entity's", async () => {
    for (const entity of [defaultEntity, branch]) {
      for (let month = 1; month <= 12; month++) {
        await runtime.execute('finance.period.lock', { month: `2025-${String(month).padStart(2, '0')}`, legalEntityId: entity }, { actor: asUser(owner), orgId });
      }
    }
    await runtime.execute('finance.archive.build', { year: 2025 }, { actor: asMfa(owner), orgId });
    await runtime.execute('finance.period.unlock', { month: '2025-12', reason: 'Sửa bút toán', legalEntityId: defaultEntity }, { actor: asMfa(owner), orgId });

    const types = ['finance.period', 'finance.archive'];
    const ownerRows = await readAs(owner, types);
    // Every row names its entity: 24 locks, one archive request per entity of the package, one unlock.
    expect(ownerRows.filter((r) => r.legal_entity_id === null)).toEqual([]);
    expect(ownerRows.filter((r) => r.kind === 'period.locked').map((r) => r.legal_entity_id)).toEqual([...Array(12).fill(defaultEntity), ...Array(12).fill(branch)]);
    expect(ownerRows.filter((r) => r.kind === 'archive.requested').map((r) => r.legal_entity_id).sort()).toEqual([defaultEntity, branch].sort());
    expect(ownerRows.filter((r) => r.kind === 'period.unlocked').map((r) => r.legal_entity_id)).toEqual([defaultEntity]);

    const memberRows = await readAs(member, types);
    expect(memberRows.length).toBe(13);
    expect(memberRows.every((r) => r.legal_entity_id === branch)).toBe(true);
    expect(memberRows.filter((r) => r.kind === 'archive.requested')).toHaveLength(1);
    expect(memberRows.some((r) => r.kind === 'period.unlocked')).toBe(false);
  });

  it('keeps org-level rows visible to every member', async () => {
    await write(owner, 'kernel.tenant', orgId, null, true);
    const seen = await readAs(member, ['kernel.tenant']);
    expect(seen).toEqual([{ record_type: 'kernel.tenant', kind: 'test.row', legal_entity_id: null }]);
  });

  it('refuses a row of an entity-named record type that names no entity', async () => {
    for (const type of ['finance.period', 'finance.archive', 'kernel.mail_message']) {
      await expect(write(owner, type, orgId, null), type).rejects.toMatchObject({ code: '23514', message: expect.stringContaining('activity_entity_named') });
    }
    // A missing-invoice mail of the default entity is the owner's to read, not the branch member's.
    await asApp(
      owner,
      (c) =>
        c.query(
          `INSERT INTO crove_kernel.activity (org_id, record_type, record_id, kind, summary, actor_id, legal_entity_id)
           VALUES ($1, 'kernel.mail_message', $2, 'missing_invoices.requested', 'Gửi email', $3, $4)`,
          [orgId, randomUUID(), owner, defaultEntity],
        ),
      true,
    );
    expect(await readAs(member, ['kernel.mail_message'])).toEqual([]);
    expect(await readAs(owner, ['kernel.mail_message'])).toHaveLength(1);
  });

  it('lets no writer name an entity outside its scope, or other than the record of a mapped type', async () => {
    // The branch member naming the default entity: le_scope's WITH CHECK.
    await expect(write(member, 'finance.period', orgId, defaultEntity)).rejects.toMatchObject({ code: '42501' });
    await expect(write(member, 'finance.period', orgId, branch)).resolves.toBeDefined();
    // A journal entry of the branch named as the default entity's: the trigger refuses it.
    const entry = await admin(
      async (a) => (await a.query<{ id: string }>(`SELECT id FROM crove_finance.journal_entry WHERE org_id = $1 AND legal_entity_id = $2 LIMIT 1`, [orgId, branch])).rows[0]?.id as string,
    );
    await expect(write(owner, 'finance.journal_entry', entry, defaultEntity)).rejects.toMatchObject({ code: '23514', message: 'LEGAL_ENTITY_MISMATCH' });
    // A bank import with no new line stored none: the entity the writer names is kept (#1728).
    const kept = await write(owner, 'finance.bank_account', randomUUID(), defaultEntity);
    expect(kept.rows).toEqual([{ legal_entity_id: defaultEntity }]);
  });
});
