// The activity timeline per legal entity (#1716) on PostgreSQL 17: an activity row about a record of one legal entity
// (a voucher, a journal entry, a purchase document ...) takes that record's entity, the rows written before the
// migration included, and a member limited to another entity reads none of them, in the proposal timeline or in the
// database, while the org-level rows (the proposal's own, a party's, the org's settings) stay visible to every member.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import type { JournalVoucherRequest, Timeline } from '@crove/kernel-contract';
import { Runtime } from '@crove/kernel-runtime';
import { financeCommands, financeQueries } from '@crove/mod-finance';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const THIS_VERSION = '20261103120000';
const suite = ADMIN ? describe : describe.skip;

suite('activity per legal entity on PostgreSQL (#1716)', () => {
  const dbName = `crove_test_activity_le_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let before = '';
  let pool: pg.Pool;
  let rt: Runtime;
  let owner = '';
  let member = '';
  // Members limited by their external_accountant assignment to the default entity (A) and to the branch (B).
  let accountantA = '';
  let accountantB = '';
  let orgId = '';
  let defaultEntity = '';
  let branch = '';
  // A journal voucher of the branch approved before the migration, and one approved after it.
  let legacy = { proposalId: '', voucherId: '', journalEntryId: '' };
  let fresh = { proposalId: '', voucherId: '', journalEntryId: '' };
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

  // Runs statements as crove_app in the user's sealed context, in one transaction, committed unless it fails.
  async function asMember<T>(userId: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: appUrl });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT crove_kernel.enter_context($1::uuid, $2::uuid)', [userId, orgId]);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      await client.end();
    }
  }

  function connect() {
    pool = createPool({ connectionString: appUrl, max: 4 });
    rt = new Runtime(createDb(pool)).register({
      commands: [...kernelCommands, ...financeCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries],
    });
  }

  const voucher = (description: string, legalEntityId: string): JournalVoucherRequest => ({
    date: '2026-10-05',
    description,
    lines: [
      { account: '6422', debit: '450000', credit: '0' },
      { account: '3388', debit: '0', credit: '450000' },
    ],
    legalEntityId,
  });

  // The member asks, the owner approves (four-eyes, fresh MFA).
  async function record(input: JournalVoucherRequest) {
    const { proposalId } = await rt.execute<{ proposalId: string }>(
      'kernel.proposal.request',
      { command: 'finance.journal_voucher.record', input },
      { actor: asUser(member), orgId, idempotencyKey: randomUUID() },
    );
    const detail = await rt.query<{ revision: number }>('kernel.inbox.get', { id: proposalId }, { actor: asUser(owner), orgId });
    const done = await rt.execute<{ journalEntryId: string; voucherId: string }>(
      'kernel.proposal.approve',
      { id: proposalId, revision: detail.revision },
      { actor: asMfa(owner), orgId },
    );
    return { proposalId, voucherId: done.voucherId, journalEntryId: done.journalEntryId };
  }

  const timeline = (userId: string, proposalId: string) => rt.query<Timeline>('kernel.proposal.timeline', { id: proposalId }, { actor: asUser(userId), orgId });
  const entityOf = async (recordType: string, recordId: string) =>
    (
      await admin((c) =>
        c.query<{ e: string | null }>('SELECT legal_entity_id AS e FROM crove_kernel.activity WHERE org_id = $1 AND record_type = $2 AND record_id = $3', [
          orgId,
          recordType,
          recordId,
        ]),
      )
    ).rows.map((r) => r.e);

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    // The database as it was before this migration.
    before = mkdtempSync(join(tmpdir(), 'crove-activity-le-before-'));
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

    const db = createDb(pool);
    const person = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}@activity-le.test`, name: null });
    owner = await person('owner');
    member = await person('member');
    accountantA = await person('accountant-a');
    accountantB = await person('accountant-b');
    const second = await person('admin');
    ({ orgId } = await createOrg(rt, asUser(owner), 'Hai pháp nhân'));
    await admin(async (c) => {
      defaultEntity = (await c.query<{ id: string }>('SELECT id FROM crove_kernel.legal_entity WHERE org_id = $1 AND is_default', [orgId])).rows[0]?.id as string;
      branch = (
        await c.query<{ id: string }>(`INSERT INTO crove_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhánh', 'branch', $2) RETURNING id`, [orgId, owner])
      ).rows[0]?.id as string;
      // A second approver, so the owner may approve what the member asked for (P10, four-eyes).
      for (const [user, role] of [
        [member, 'member'],
        [second, 'admin'],
        [accountantA, 'member'],
        [accountantB, 'member'],
      ] as const) {
        await c.query('INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, $3)', [orgId, user, role]);
      }
      for (const [user, entity] of [
        [accountantA, defaultEntity],
        [accountantB, branch],
      ] as const) {
        await c.query(`INSERT INTO crove_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by) VALUES ($1, $2, 'external_accountant', $3, $4)`, [
          orgId,
          user,
          entity,
          owner,
        ]);
      }
    });
    // Written before the migration: its activity rows have no entity yet.
    legacy = await record(voucher('Trích trước tiền điện chi nhánh tháng 9', branch));

    await migrate({ adminUrl, dir: MIGRATIONS });
    // Connections opened before the migration may hold plans of the table as it was.
    await pool.end();
    connect();
    fresh = await record(voucher('Trích trước tiền điện chi nhánh tháng 10', branch));
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

  it("gives the rows of an entity's records that entity, the rows written before the migration included, and leaves the others org-level", async () => {
    expect(await entityOf('finance.journal_voucher', legacy.voucherId)).toEqual([branch]);
    expect(await entityOf('finance.journal_voucher', fresh.voucherId)).toEqual([branch]);
    // A proposal's rows stay org-level until proposals are scoped (#1538).
    for (const p of [legacy, fresh]) {
      const rows = await entityOf('kernel.proposal', p.proposalId);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((e) => e === null)).toBe(true);
    }
  });

  it("keeps entity B's activity out of the proposal timeline of a member limited to entity A, and shows it to B's", async () => {
    // A later command on the branch's journal entry leaves its row there, as a reversal does (reversal.ts); the
    // timeline follows the entry the approval posted.
    await asMember(owner, (c) =>
      c.query(`INSERT INTO crove_kernel.activity (org_id, record_type, record_id, kind, summary, actor_id) VALUES ($1, 'finance.journal_entry', $2, 'journal_entry.reversed', $3, $4)`, [
        orgId,
        fresh.journalEntryId,
        'Đảo bút toán: Trích trước tiền điện chi nhánh tháng 10 (450.000 đ)',
        owner,
      ]),
    );
    expect(await entityOf('finance.journal_entry', fresh.journalEntryId)).toEqual([branch]);

    const kinds = async (userId: string) => (await timeline(userId, fresh.proposalId)).items.map((i) => i.kind);
    expect(await kinds(owner)).toContain('journal_entry.reversed');
    expect(await kinds(accountantB)).toContain('journal_entry.reversed');
    const seenByA = await timeline(accountantA, fresh.proposalId);
    expect(seenByA.items.map((i) => i.kind)).not.toContain('journal_entry.reversed');
    expect(seenByA.items.filter((i) => i.recordType.startsWith('finance.'))).toEqual([]);
    // The proposal's own rows are org-level, so A still sees what happened to the proposal.
    expect(seenByA.items.map((i) => i.kind)).toEqual(expect.arrayContaining(['proposal.created', 'proposal.approved']));
  });

  it('keeps a member limited to entity A out of every row of entity B in the database, and shows it the org-level rows', async () => {
    const counts = (userId: string) =>
      asMember(userId, async (c) => {
        const { rows } = await c.query<{ b: number; a: number; org: number }>(
          `SELECT count(*) FILTER (WHERE legal_entity_id = $1)::int AS b,
                  count(*) FILTER (WHERE legal_entity_id = $2)::int AS a,
                  count(*) FILTER (WHERE legal_entity_id IS NULL)::int AS org
           FROM crove_kernel.activity`,
          [branch, defaultEntity],
        );
        return rows[0];
      });
    const all = (
      await admin((c) =>
        c.query<{ b: number; org: number }>(
          `SELECT count(*) FILTER (WHERE legal_entity_id = $2)::int AS b, count(*) FILTER (WHERE legal_entity_id IS NULL)::int AS org
           FROM crove_kernel.activity WHERE org_id = $1`,
          [orgId, branch],
        ),
      )
    ).rows[0];
    expect(all?.b).toBeGreaterThan(0);
    expect(all?.org).toBeGreaterThan(0);
    expect(await counts(accountantA)).toEqual({ b: 0, a: 0, org: all?.org });
    expect(await counts(accountantB)).toEqual({ b: all?.b, a: 0, org: all?.org });
    expect(await counts(owner)).toEqual({ b: all?.b, a: 0, org: all?.org });
    // The org overview's last activity time reads the same rows: the newest row is the branch's reversal.
    const last = async (userId: string) =>
      (await rt.query<{ lastActivityAt: string | null }>('kernel.org.overview', {}, { actor: asUser(userId), orgId })).lastActivityAt;
    const newest = (
      await admin((c) =>
        c.query<{ at: Date; e: string | null }>('SELECT occurred_at AS at, legal_entity_id AS e FROM crove_kernel.activity WHERE org_id = $1 ORDER BY occurred_at DESC, id DESC LIMIT 1', [orgId]),
      )
    ).rows[0];
    if (!newest) throw new Error('no activity row');
    expect(newest.e).toBe(branch);
    expect(await last(owner)).toBe(newest.at.toISOString());
    const seenByA = await last(accountantA);
    expect(seenByA).not.toBeNull();
    expect(new Date(seenByA as string).getTime()).toBeLessThan(newest.at.getTime());
  });

  it('scopes the row of an entity added or renamed to that entity', async () => {
    const added = await rt.execute<{ id: string }>(
      'kernel.legal_entity.create',
      { name: 'Chi nhánh Huế', kind: 'branch', taxCode: null, parentId: null },
      { actor: asUser(owner), orgId },
    );
    expect(await entityOf('kernel.legal_entity', added.id)).toEqual([added.id]);
    const sees = (userId: string) =>
      asMember(userId, async (c) => (await c.query('SELECT 1 FROM crove_kernel.activity WHERE record_type = $1 AND record_id = $2', ['kernel.legal_entity', added.id])).rowCount);
    expect(await sees(owner)).toBe(1);
    expect(await sees(accountantA)).toBe(0);
    expect(await sees(accountantB)).toBe(0);
  });

  it("refuses a row naming another entity than its record's or one outside the writer's scope, and scopes a row about a record the writer cannot read to its own entity", async () => {
    const insert = (userId: string, recordType: string, recordId: string, entity: string | null) =>
      asMember(userId, async (c) =>
        (
          await c.query<{ e: string | null }>(
            `INSERT INTO crove_kernel.activity (org_id, record_type, record_id, kind, summary, legal_entity_id)
             VALUES ($1, $2, $3, 'test.activity', 'x', $4) RETURNING legal_entity_id AS e`,
            [orgId, recordType, recordId, entity],
          )
        ).rows[0]?.e,
      );
    // The record is the branch's: naming the default entity is refused, even by a writer that sees every entity.
    await expect(insert(owner, 'finance.journal_voucher', fresh.voucherId, defaultEntity)).rejects.toMatchObject({ code: '23514', message: 'LEGAL_ENTITY_MISMATCH' });
    // An entity outside the writer's scope is refused by le_scope.
    await expect(insert(accountantA, 'kernel.party', randomUUID(), branch)).rejects.toMatchObject({ code: '42501' });
    // A writer limited to one entity that cannot read the record gets its own entity, not an org-level row.
    expect(await insert(accountantA, 'finance.journal_voucher', fresh.voucherId, null)).toBe(defaultEntity);
    // A writer with every entity in scope and a record that does not exist: org-level.
    expect(await insert(owner, 'finance.journal_voucher', randomUUID(), null)).toBeNull();
    // A record type that no entity owns stays org-level, for every writer.
    expect(await insert(accountantB, 'kernel.party', randomUUID(), null)).toBeNull();
  });
});
