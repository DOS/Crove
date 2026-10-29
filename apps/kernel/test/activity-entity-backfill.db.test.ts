// The backfill of activity rows about one legal entity written before #1792 (#1805) on PostgreSQL 17. Rows written
// org-level before the commands named their entity take the one entity that the audit event of the command writing their
// kind recorded in the same transaction, else the one a missing-invoice mail's payload names, else the org's default
// entity; other org-level rows stay as they are.
// The constraint activity_entity_named is then validated, with the tax obligation and party link kinds, so an UPDATE of
// an old row passes. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
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
import { Runtime } from '@crove/kernel-runtime';
import { TEST_MANIFESTS } from './manifests.ts';
import { enterUser } from './context-token.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
// #1792's constraint: the rows below are written as the code wrote them before it.
const BEFORE_VERSION = '20261104130000';
const suite = ADMIN ? describe : describe.skip;

suite('activity entity backfill on PostgreSQL (#1805)', () => {
  const dbName = `crove_test_activity_backfill_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let before = '';
  let pool: pg.Pool;
  let orgId = '';
  let owner = '';
  let defaultEntity = '';
  let branch = '';
  let branch2 = '';
  // Limited to the branch by an external_accountant assignment.
  let member = '';
  // The default entity of another org.
  let foreignEntity = '';
  // Activity row ids by what they stand for.
  const rows: Record<string, string> = {};

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  // An org-level activity row at `at`, as the code wrote it before #1792, with the audit events of its transaction:
  // [command, detail].
  async function oldRow(name: string, recordType: string, recordId: string, kind: string, at: string, audited: Array<[string, Record<string, unknown>]> = []) {
    await admin(async (c) => {
      for (const [command, detail] of audited) {
        await c.query(
          `INSERT INTO crove_kernel.audit_event (org_id, occurred_at, actor_type, actor_id, command, command_id, outcome, input_sha256, detail)
           VALUES ($1, $2, 'user', $3, $4, gen_random_uuid(), 'ok', repeat('0', 64), $5::jsonb)`,
          [orgId, at, owner, command, JSON.stringify(detail)],
        );
      }
      const { rows: inserted } = await c.query<{ id: string }>(
        `INSERT INTO crove_kernel.activity (org_id, record_type, record_id, kind, summary, actor_id, occurred_at)
         VALUES ($1, $2, $3, $4, 'Dòng cũ', $5, $6) RETURNING id`,
        [orgId, recordType, recordId, kind, owner, at],
      );
      rows[name] = inserted[0]?.id as string;
    });
  }

  // A missing-invoice mail with the payload given; its id.
  const mail = (payload: Record<string, unknown>) =>
    admin(
      async (c) =>
        (
          await c.query<{ id: string }>(
            `INSERT INTO crove_kernel.mail_message (org_id, stream, source, template_key, to_hash, payload, message_id_header)
             VALUES ($1, 'transactional', 'finance.missing_invoices.request', 'finance.missing_invoices', repeat('a', 64), $2::jsonb, $3) RETURNING id`,
            [orgId, JSON.stringify(payload), `<${randomUUID()}@backfill.test>`],
          )
        ).rows[0]?.id as string,
    );

  const entityOf = async (name: string) =>
    (await admin((c) => c.query<{ e: string | null }>('SELECT legal_entity_id AS e FROM crove_kernel.activity WHERE org_id = $1 AND id = $2', [orgId, rows[name]]))).rows[0]?.e;

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    // The database as it was before #1792.
    before = mkdtempSync(join(tmpdir(), 'crove-activity-backfill-before-'));
    for (const name of readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql') && n.slice(0, 14) < BEFORE_VERSION)) {
      copyFileSync(join(MIGRATIONS, name), join(before, name));
    }
    await migrate({ adminUrl, dir: before });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    const app = new URL(adminUrl);
    app.username = 'crove_app';
    app.password = 'test-app-pw';
    appUrl = app.toString();
    pool = createPool({ connectionString: appUrl, max: 2 });
    const db = createDb(pool);
    // No context token key: the database starts at a version before enter_user_context (#1822).
    const rt = new Runtime(db, { manifests: TEST_MANIFESTS, contextTokenKey: null }).register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) });
    owner = await upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: 'owner@activity-backfill.test', name: null });
    ({ orgId } = await createOrg(rt, { type: 'user', userId: owner, aal: 'aal1' }, 'Hai pháp nhân cũ'));
    member = await upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: 'member@activity-backfill.test', name: null });
    const { orgId: otherOrg } = await createOrg(rt, { type: 'user', userId: owner, aal: 'aal1' }, 'Tổ chức khác');
    const defaultOf = async (c: pg.Client, org: string) =>
      (await c.query<{ id: string }>('SELECT id FROM crove_kernel.legal_entity WHERE org_id = $1 AND is_default', [org])).rows[0]?.id as string;
    await admin(async (c) => {
      defaultEntity = await defaultOf(c, orgId);
      foreignEntity = await defaultOf(c, otherOrg);
      const add = async (name: string) =>
        (await c.query<{ id: string }>(`INSERT INTO crove_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, $2, 'branch', $3) RETURNING id`, [orgId, name, owner]))
          .rows[0]?.id as string;
      branch = await add('Chi nhánh Huế');
      branch2 = await add('Chi nhánh Đà Nẵng');
      await c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')`, [orgId, member]);
      await c.query(`INSERT INTO crove_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by) VALUES ($1, $2, 'external_accountant', $3, $4)`, [
        orgId,
        member,
        branch,
        owner,
      ]);
    });

    await oldRow('lockAudited', 'finance.period', orgId, 'period.locked', '2026-10-01T01:00:00Z', [['finance.period.lock', { month: '2026-09', legalEntityId: branch }]]);
    await oldRow('lockUnaudited', 'finance.period', orgId, 'period.locked', '2026-10-01T02:00:00Z');
    // Two locks in one transaction naming two branches: no one entity, so the default, not either branch.
    await oldRow('lockAmbiguous', 'finance.period', orgId, 'period.locked', '2026-10-01T03:00:00Z', [
      ['finance.period.lock', { legalEntityId: branch }],
      ['finance.period.lock', { legalEntityId: branch2 }],
    ]);
    // Another command of the same transaction names an entity: it is not the lock's.
    await oldRow('lockBeside', 'finance.period', orgId, 'period.locked', '2026-10-01T03:30:00Z', [['kernel.party.link_entity', { legalEntityId: branch }]]);
    await oldRow('request', 'kernel.mail_message', await mail({ kind: 'request', legalEntityId: branch }), 'missing_invoices.requested', '2026-10-01T04:00:00Z');
    await oldRow('requestAudited', 'kernel.mail_message', await mail({ kind: 'request' }), 'missing_invoices.requested', '2026-10-01T05:00:00Z', [
      ['finance.missing_invoices.request', { period: '2026-09', legal_entity_id: branch }],
    ]);
    // A payload or an audit event naming another org's entity, or no uuid at all, counts for nothing (#1835).
    await oldRow('requestForeign', 'kernel.mail_message', await mail({ kind: 'request', legalEntityId: foreignEntity }), 'missing_invoices.requested', '2026-10-01T05:10:00Z');
    await oldRow('requestJunk', 'kernel.mail_message', await mail({ kind: 'request', legalEntityId: 'junk' }), 'missing_invoices.requested', '2026-10-01T05:20:00Z');
    await oldRow('lockForeign', 'finance.period', orgId, 'period.locked', '2026-10-01T05:30:00Z', [['finance.period.lock', { legalEntityId: foreignEntity }]]);
    await oldRow('reminder', 'kernel.mail_message', await mail({ kind: 'reminder' }), 'missing_invoices.reminded', '2026-10-01T06:00:00Z');
    await oldRow('archive', 'finance.archive', orgId, 'archive.requested', '2026-10-01T07:00:00Z', [['finance.archive.build', { year: 2025 }]]);
    await oldRow('taxMark', 'kernel.tenant', orgId, 'org.tax_obligation_done', '2026-10-01T08:00:00Z', [
      ['kernel.tax_obligation.done', { obligation: 'vat_return', period: '2026-09', legalEntityId: branch }],
    ]);
    await oldRow('partyLink', 'kernel.party', randomUUID(), 'party.entity_linked', '2026-10-01T09:00:00Z', [['kernel.party.link_entity', { legalEntityId: branch }]]);
    // A mark whose command recorded no entity, and a row of a kind that stays org-level whatever its audit names.
    await oldRow('taxUnmark', 'kernel.tenant', orgId, 'org.tax_obligation_undone', '2026-10-01T10:00:00Z');
    await oldRow('orgLevel', 'kernel.tenant', orgId, 'org.address_changed', '2026-10-01T11:00:00Z', [['kernel.org.set_address', { legalEntityId: branch }]]);

    await migrate({ adminUrl, dir: MIGRATIONS });
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

  it("gives each old row the entity its command recorded, else its mail's, else the org's default entity", async () => {
    expect(await entityOf('lockAudited')).toBe(branch);
    expect(await entityOf('request')).toBe(branch);
    expect(await entityOf('requestAudited')).toBe(branch);
    expect(await entityOf('taxMark')).toBe(branch);
    expect(await entityOf('partyLink')).toBe(branch);
    // Nothing recorded one entity: the default entity.
    for (const name of ['lockUnaudited', 'lockAmbiguous', 'lockBeside', 'requestForeign', 'requestJunk', 'lockForeign', 'reminder', 'archive', 'taxUnmark']) {
      expect(await entityOf(name), name).toBe(defaultEntity);
    }
    // Other org-level rows stay org-level.
    expect(await entityOf('orgLevel')).toBeNull();
  });

  it("shows a member limited to the branch the old rows backfilled to it and the org-level ones, and none of the default entity's (#1835)", async () => {
    // A connection of its own: the pool's were opened before the migration.
    const c = new pg.Client({ connectionString: appUrl });
    await c.connect();
    let seen: string[];
    try {
      await c.query('BEGIN');
      await enterUser(c, member, orgId);
      const ids = (await c.query<{ id: string }>('SELECT id FROM crove_kernel.activity WHERE id = ANY($1::uuid[])', [Object.values(rows)])).rows.map((r) => r.id);
      seen = Object.entries(rows)
        .filter(([, id]) => ids.includes(id))
        .map(([name]) => name)
        .sort();
    } finally {
      await c.query('ROLLBACK');
      await c.end();
    }
    expect(seen).toEqual(['lockAudited', 'orgLevel', 'partyLink', 'request', 'requestAudited', 'taxMark']);
  });

  it('validates the constraint, so an old row can be updated and a new one must name its entity', async () => {
    const validated = await admin(
      async (c) =>
        (await c.query<{ v: boolean }>(`SELECT convalidated AS v FROM pg_catalog.pg_constraint WHERE conrelid = 'crove_kernel.activity'::regclass AND conname = 'activity_entity_named'`))
          .rows[0]?.v,
    );
    expect(validated).toBe(true);
    await expect(admin((c) => c.query(`UPDATE crove_kernel.activity SET summary = 'Đã xóa' WHERE org_id = $1 AND id = $2`, [orgId, rows.taxMark]))).resolves.toBeDefined();
    await expect(
      admin((c) =>
        c.query(`INSERT INTO crove_kernel.activity (org_id, record_type, record_id, kind, summary, actor_id) VALUES ($1, 'kernel.party', $2, 'party.entity_unlinked', 'x', $3)`, [
          orgId,
          randomUUID(),
          owner,
        ]),
      ),
    ).rejects.toMatchObject({ code: '23514', message: expect.stringContaining('activity_entity_named') });
  });
});
