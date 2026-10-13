// Integration tests against a real PostgreSQL 17. Set CROVE_TEST_ADMIN_URL to a superuser URL
// (CI uses a service container); each run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { DomainError, Runtime, fileKey, sha256Hex, type BlobStore } from '@crove/kernel-runtime';
import { extractAndPropose, financeCommands, financeQueries, recordExtractionFailure } from '@crove/mod-finance';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const FIXTURE = readFileSync(new URL('../../../packages/l10n-vn/test/fixtures/einvoice-basic.xml', import.meta.url));

class MemoryStore implements BlobStore {
  private readonly blobs = new Map<string, Uint8Array>();
  async put(key: string, bytes: Uint8Array) {
    this.blobs.set(key, bytes);
  }
  async get(key: string) {
    const b = this.blobs.get(key);
    if (!b) throw new Error('missing blob');
    return b;
  }
}

const suite = ADMIN ? describe : describe.skip;

suite('kernel on PostgreSQL', () => {
  const dbName = `crove_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl: string;
  let appUrl: string;
  let pool: pg.Pool;
  let db: Db;
  let runtime: Runtime;
  const store = new MemoryStore();
  const users: Record<'owner' | 'outsider' | 'viewer', string> = { owner: '', outsider: '', viewer: '' };
  let orgA = '';
  let orgB = '';

  const asUser = (userId: string) => ({ type: 'user' as const, userId });

  async function ingest(orgId: string, userId: string, bytes: Uint8Array) {
    const sha256 = sha256Hex(bytes);
    const storageKey = fileKey(orgId, sha256);
    await store.put(storageKey, bytes);
    return runtime.execute<{ fileId: string; duplicate: boolean }>(
      'kernel.file.ingest',
      { filename: 'hd.xml', contentType: 'application/xml', sizeBytes: bytes.byteLength, sha256, storageKey, source: 'upload' },
      { actor: asUser(userId), orgId },
    );
  }

  beforeAll(async () => {
    const base = new URL(ADMIN as string);
    const admin = new pg.Client({ connectionString: ADMIN });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw' });
    const app = new URL(adminUrl);
    app.username = 'crove_app';
    app.password = 'test-app-pw';
    appUrl = app.toString();
    pool = createPool({ connectionString: appUrl, max: 4 });
    db = createDb(pool);
    runtime = new Runtime(db).register({
      commands: [...kernelCommands, ...financeCommands],
      queries: [...kernelQueries({ inboundDomain: 'in.test' }), ...financeQueries],
    });
    users.owner = await upsertIdentity(db, { issuer: 'test', subject: 'owner', email: 'owner@example.com', name: 'Owner' });
    users.outsider = await upsertIdentity(db, { issuer: 'test', subject: 'outsider', email: 'outsider@example.com', name: null });
    users.viewer = await upsertIdentity(db, { issuer: 'test', subject: 'viewer', email: 'viewer@example.com', name: null });
    orgA = (await createOrg(runtime, users.owner, 'Org A')).orgId;
    orgB = (await createOrg(runtime, users.outsider, 'Org B')).orgId;
    await runtime.execute('kernel.member.add', { email: 'viewer@example.com', role: 'viewer' }, { actor: asUser(users.owner), orgId: orgA });
  });

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const admin = new pg.Client({ connectionString: ADMIN });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  });

  it('rejects users who are not members of the org', async () => {
    await expect(runtime.query('kernel.inbox.list', {}, { actor: asUser(users.outsider), orgId: orgA })).rejects.toMatchObject({
      code: 'NOT_A_MEMBER',
      status: 403,
    });
  });

  it('isolates tenants with RLS, including when no context is set', async () => {
    await ingest(orgA, users.owner, new TextEncoder().encode('<a>org-a</a>'));
    const visible = await db.transaction().execute(async (trx) => {
      await sql`SELECT crove_kernel.enter_context(${users.outsider}::uuid, ${orgB}::uuid)`.execute(trx);
      return trx.selectFrom('crove_kernel.file').select('org_id').execute();
    });
    expect(visible.every((r) => r.org_id === orgB)).toBe(true);
    const noContext = await db.selectFrom('crove_kernel.file').select('id').execute();
    expect(noContext).toHaveLength(0);
    await expect(
      db.transaction().execute(async (trx) => {
        await sql`SELECT crove_kernel.enter_context(${users.outsider}::uuid, ${orgB}::uuid)`.execute(trx);
        await trx
          .insertInto('crove_kernel.party')
          .values({ org_id: orgA, name: 'smuggled' })
          .execute();
      }),
    ).rejects.toThrow(/row-level security/);
  });

  it('keeps audit and outbox append-only, even for the database owner', async () => {
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      await expect(admin.query('UPDATE crove_kernel.audit_event SET outcome = $1', ['denied'])).rejects.toThrow(/append-only/);
      await expect(admin.query('DELETE FROM crove_kernel.outbox_event')).rejects.toThrow(/append-only/);
      const { rows } = await admin.query<{ n: string }>('SELECT count(*) AS n FROM crove_kernel.audit_event');
      expect(Number(rows[0]?.n)).toBeGreaterThan(0);
    } finally {
      await admin.end();
    }
  });

  it('refuses unbalanced journal entries at commit', async () => {
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      await admin.query('BEGIN');
      const { rows } = await admin.query<{ id: string }>(
        `INSERT INTO crove_finance.journal_entry (org_id, entry_date, description, source_type, source_id)
         VALUES ($1, '2026-10-01', 'test', 'test', crove_kernel.uuid_v7()) RETURNING id`,
        [orgA],
      );
      await admin.query(
        `INSERT INTO crove_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit) VALUES
         ($1, $2, 1, '6422', 100, 0), ($1, $2, 2, '331', 0, 90)`,
        [orgA, rows[0]?.id],
      );
      await expect(admin.query('COMMIT')).rejects.toThrow(/does not balance/);
    } finally {
      await admin.query('ROLLBACK').catch(() => {});
      await admin.end();
    }
  });

  it('turns an e-invoice into a proposal, and records it once on approval', async () => {
    const { fileId, duplicate } = await ingest(orgA, users.owner, FIXTURE);
    expect(duplicate).toBe(false);
    const again = await ingest(orgA, users.owner, FIXTURE);
    expect(again).toEqual({ fileId, duplicate: true });

    const { proposalId } = await extractAndPropose({ runtime, store, extractor: null, today: () => '2026-10-13' }, orgA, fileId);
    expect(proposalId).toBeTruthy();
    const detail = await runtime.query<{ revision: number; payload: { invoice: { total: string } } }>(
      'kernel.inbox.get',
      { id: proposalId },
      { actor: asUser(users.owner), orgId: orgA },
    );
    expect(detail.payload.invoice.total).toBe('1980000');

    await expect(
      runtime.execute('kernel.proposal.approve', { id: proposalId, revision: detail.revision }, { actor: asUser(users.viewer), orgId: orgA }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      runtime.execute('finance.purchase.record', { payload: detail.payload, lineAccounts: [] }, { actor: asUser(users.owner), orgId: orgA }),
    ).rejects.toMatchObject({ status: 403 });

    const approvalRequest = randomUUID();
    const first = await runtime.execute<{ documentId: string; journalEntryId: string }>(
      'kernel.proposal.approve',
      { id: proposalId, revision: detail.revision, lineAccounts: [{ lineNo: 1, debitAccount: '6422' }] },
      { actor: asUser(users.owner), orgId: orgA, idempotencyKey: approvalRequest },
    );
    const replay = await runtime.execute(
      'kernel.proposal.approve',
      { id: proposalId, revision: detail.revision, lineAccounts: [{ lineNo: 1, debitAccount: '6422' }] },
      { actor: asUser(users.owner), orgId: orgA, idempotencyKey: approvalRequest },
    );
    expect(replay).toEqual(first);
    await expect(
      runtime.execute('kernel.proposal.approve', { id: proposalId, revision: detail.revision }, { actor: asUser(users.owner), orgId: orgA }),
    ).rejects.toMatchObject({ code: 'PROPOSAL_DECIDED' });

    const journal = await runtime.query<Array<{ lines: Array<{ accountCode: string; debit: string; credit: string }> }>>(
      'finance.journal.list',
      {},
      { actor: asUser(users.owner), orgId: orgA },
    );
    expect(journal).toHaveLength(1);
    const lines = journal[0]?.lines.map((l) => [l.accountCode, l.debit, l.credit]);
    expect(lines).toEqual([
      ['6421', '1000000.0000', '0.0000'],
      ['6422', '800000.0000', '0.0000'],
      ['1331', '180000.0000', '0.0000'],
      ['331', '0.0000', '1980000.0000'],
    ]);
    const outsiderView = await runtime
      .query('finance.journal.list', {}, { actor: asUser(users.outsider), orgId: orgA })
      .catch((e: DomainError) => e.code);
    expect(outsiderView).toBe('NOT_A_MEMBER');
  });

  it('keeps recorded documents and journal entries append-only', async () => {
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      await expect(admin.query('UPDATE crove_finance.journal_line SET debit = debit')).rejects.toThrow(/append-only/);
      await expect(admin.query('DELETE FROM crove_finance.purchase_document')).rejects.toThrow(/append-only/);
    } finally {
      await admin.end();
    }
  });

  it('only shows user accounts of the org in context', async () => {
    const ids = await db.transaction().execute(async (trx) => {
      await sql`SELECT crove_kernel.enter_context(${users.outsider}::uuid, ${orgB}::uuid)`.execute(trx);
      return (await trx.selectFrom('crove_kernel.user_account').select('id').execute()).map((r) => r.id);
    });
    expect(ids).toEqual([users.outsider]);
    expect(await db.selectFrom('crove_kernel.user_account').select('id').execute()).toHaveLength(0);
  });

  it('lets only owners grant admin, and never changes an owner', async () => {
    const admin = await upsertIdentity(db, { issuer: 'test', subject: 'admin', email: 'admin@example.com', name: null });
    await upsertIdentity(db, { issuer: 'test', subject: 'member', email: 'member@example.com', name: null });
    await runtime.execute('kernel.member.add', { email: 'admin@example.com', role: 'admin' }, { actor: asUser(users.owner), orgId: orgA });
    const asAdmin = { actor: asUser(admin), orgId: orgA };
    await expect(runtime.execute('kernel.member.add', { email: 'member@example.com', role: 'admin' }, asAdmin)).rejects.toMatchObject({
      status: 403,
    });
    await expect(runtime.execute('kernel.member.add', { email: 'owner@example.com', role: 'viewer' }, asAdmin)).rejects.toMatchObject({
      status: 403,
    });
    await expect(runtime.execute('kernel.member.add', { email: 'member@example.com', role: 'member' }, asAdmin)).resolves.toBeTruthy();
  });

  it('records an invoice with failed checks only after explicit confirmation, and never a foreign-currency one', async () => {
    const variant = (number: string, edit: (xml: string) => string) =>
      new TextEncoder().encode(edit(FIXTURE.toString('utf8').replace('<SHDon>1234</SHDon>', `<SHDon>${number}</SHDon>`)));
    const propose = async (bytes: Uint8Array) => {
      const { fileId } = await ingest(orgA, users.owner, bytes);
      const { proposalId } = await extractAndPropose({ runtime, store, extractor: null, today: () => '2026-10-13' }, orgA, fileId);
      const detail = await runtime.query<{ revision: number }>('kernel.inbox.get', { id: proposalId }, { actor: asUser(users.owner), orgId: orgA });
      return { id: proposalId, revision: detail.revision };
    };
    const asOwner = { actor: asUser(users.owner), orgId: orgA };

    const mismatch = await propose(variant('1235', (xml) => xml.replace('<TThue>180000</TThue>', '<TThue>170000</TThue>')));
    await expect(runtime.execute('kernel.proposal.approve', mismatch, asOwner)).rejects.toMatchObject({ code: 'CHECKS_FAILED' });
    await expect(runtime.execute('kernel.proposal.approve', { ...mismatch, acceptFailedChecks: true }, asOwner)).resolves.toMatchObject({
      journalEntryId: expect.any(String),
    });

    const totalOff = await propose(variant('1237', (xml) => xml.replace('<TgTTTBSo>1980000</TgTTTBSo>', '<TgTTTBSo>1979999</TgTTTBSo>')));
    const pending = await runtime.query<Array<{ id: string; failedChecks: number; total: string | null }>>(
      'kernel.inbox.list',
      { status: 'pending' },
      asOwner,
    );
    expect(pending.find((p) => p.id === totalOff.id)).toMatchObject({ failedChecks: 1, total: '1979999' });
    await expect(runtime.execute('kernel.proposal.approve', { ...totalOff, acceptFailedChecks: true }, asOwner)).rejects.toMatchObject({
      code: 'CHECKS_BLOCKING',
    });

    const usd = await propose(variant('1236', (xml) => xml.replace('<DVTTe>VND</DVTTe>', '<DVTTe>USD</DVTTe>')));
    await expect(runtime.execute('kernel.proposal.approve', { ...usd, acceptFailedChecks: true }, asOwner)).rejects.toMatchObject({
      code: 'UNSUPPORTED_CURRENCY',
    });
  });

  it('marks a file as failed when extraction keeps failing, so it never stays "processing"', async () => {
    const { fileId } = await ingest(orgA, users.owner, new TextEncoder().encode('<a>unreadable</a>'));
    await recordExtractionFailure(runtime, orgA, fileId, 'Không đọc được');
    await recordExtractionFailure(runtime, orgA, fileId, 'Không đọc được');
    const recent = await runtime.query<Array<{ id: string; status: string; error: string | null }>>(
      'kernel.files.recent',
      {},
      { actor: asUser(users.owner), orgId: orgA },
    );
    expect(recent.find((f) => f.id === fileId)).toMatchObject({ status: 'failed', error: 'Không đọc được' });
  });

  it("refuses a storage key that belongs to another org", async () => {
    const bytes = new TextEncoder().encode('<a>other org</a>');
    const sha256 = sha256Hex(bytes);
    await expect(
      runtime.execute(
        'kernel.file.ingest',
        { filename: 'x.xml', contentType: 'application/xml', sizeBytes: bytes.byteLength, sha256, storageKey: fileKey(orgB, sha256), source: 'upload' },
        { actor: asUser(users.owner), orgId: orgA },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_STORAGE_KEY' });
  });
});
