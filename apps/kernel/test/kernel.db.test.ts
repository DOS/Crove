// Integration tests against a real PostgreSQL 17. Set CROVE_TEST_ADMIN_URL to a superuser URL
// (CI uses a service container); each run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import { sql, type Transaction } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertSystemContextAccess, createDb, createPool, type Database, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { DomainError, Runtime, fileKey, inboundKey, newInboundBlobId, sha256Hex, type BlobStore } from '@crove/kernel-runtime';
import { extractAndPropose, financeCommands, financeQueries, recordExtractionFailure } from '@crove/mod-finance';
import { actorOf, createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { processInboundEmail } from '../src/inbound.ts';
import { migrateJobs, startWorker } from '../src/worker.ts';

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
  async delete(key: string) {
    this.blobs.delete(key);
  }
  keys(prefix: string) {
    return [...this.blobs.keys()].filter((k) => k.startsWith(prefix));
  }
}

const suite = ADMIN ? describe : describe.skip;

suite('kernel on PostgreSQL', () => {
  const dbName = `crove_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl: string;
  let appUrl: string;
  let workerUrl: string;
  let pool: pg.Pool;
  let db: Db;
  // The API login role (crove_app): user actors only.
  let runtime: Runtime;
  let workerPool: pg.Pool;
  let workerDb: Db;
  // The worker login role (crove_worker): the only one that may run system actors.
  let workerRuntime: Runtime;
  const store = new MemoryStore();
  const users: Record<'owner' | 'outsider' | 'viewer', string> = { owner: '', outsider: '', viewer: '' };
  let orgA = '';
  let orgB = '';

  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  // R3 (approve, membership changes) needs aal2 with a second factor in the last 5 minutes (policy P11).
  const asMfa = (userId: string, mfaAgeS = 0) => ({
    type: 'user' as const,
    userId,
    aal: 'aal2' as const,
    sessionId: '0f6c3a52-8d3b-4c1e-9a77-5b2f0e9d1c00',
    mfaAt: Math.floor(Date.now() / 1000) - mfaAgeS,
  });

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

  // The fixture invoice under another invoice number, so each variant is a new document.
  const variant = (number: string, edit: (xml: string) => string = (xml) => xml) =>
    new TextEncoder().encode(edit(FIXTURE.toString('utf8').replace('<SHDon>1234</SHDon>', `<SHDon>${number}</SHDon>`)));

  async function propose(bytes: Uint8Array) {
    const { fileId } = await ingest(orgA, users.owner, bytes);
    const { proposalId } = await extractAndPropose({ runtime: workerRuntime, store, extractor: null, today: () => '2026-10-13' }, orgA, fileId);
    const detail = await runtime.query<{ revision: number }>('kernel.inbox.get', { id: proposalId }, { actor: asUser(users.owner), orgId: orgA });
    return { id: proposalId, revision: detail.revision };
  }

  async function withAdmin<T>(fn: (admin: pg.Client) => Promise<T>): Promise<T> {
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      return await fn(admin);
    } finally {
      await admin.end();
    }
  }

  // The API login role in its owner's context in org B; org A keeps only the entries approvals post.
  function inOrgB<T>(fn: (trx: Transaction<Database>) => Promise<T>): Promise<T> {
    return db.transaction().execute(async (trx) => {
      await sql`SELECT crove_kernel.enter_context(${users.outsider}::uuid, ${orgB}::uuid)`.execute(trx);
      return fn(trx);
    });
  }

  type PostingLine = { line_no: number; account_code: string; debit: string; credit: string };
  const BALANCED: PostingLine[] = [
    { line_no: 1, account_code: '6422', debit: '100', credit: '0' },
    { line_no: 2, account_code: '331', debit: '0', credit: '100' },
  ];

  async function post(lines: PostingLine[]): Promise<string> {
    return inOrgB(async (trx) => {
      const { rows } = await sql<{ id: string }>`
        SELECT crove_finance.post_journal_entry('2026-10-01', 'test', 'test', ${randomUUID()}::uuid, ${JSON.stringify(lines)}::jsonb) AS id`.execute(trx);
      return rows[0]?.id ?? '';
    });
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
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    const loginUrl = (username: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = username;
      url.password = password;
      return url.toString();
    };
    appUrl = loginUrl('crove_app', 'test-app-pw');
    workerUrl = loginUrl('crove_worker', 'test-worker-pw');
    const register = (target: Db) =>
      new Runtime(target).register({
        commands: [...kernelCommands, ...financeCommands],
        queries: [...kernelQueries({ inboundDomain: 'in.test' }), ...financeQueries],
      });
    pool = createPool({ connectionString: appUrl, max: 4 });
    db = createDb(pool);
    runtime = register(db);
    workerPool = createPool({ connectionString: workerUrl, max: 4 });
    workerDb = createDb(workerPool);
    workerRuntime = register(workerDb);
    users.owner = await upsertIdentity(db, { issuer: 'test', subject: 'owner', email: 'owner@example.com', name: 'Owner' });
    users.outsider = await upsertIdentity(db, { issuer: 'test', subject: 'outsider', email: 'outsider@example.com', name: null });
    users.viewer = await upsertIdentity(db, { issuer: 'test', subject: 'viewer', email: 'viewer@example.com', name: null });
    orgA = (await createOrg(runtime, asUser(users.owner), 'Org A')).orgId;
    orgB = (await createOrg(runtime, asUser(users.outsider), 'Org B')).orgId;
    await runtime.execute('kernel.member.add', { email: 'viewer@example.com', role: 'viewer' }, { actor: asMfa(users.owner), orgId: orgA });
  });

  afterAll(async () => {
    await pool?.end();
    await workerPool?.end();
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
    await expect(post([BALANCED[0] as PostingLine, { line_no: 2, account_code: '331', debit: '0', credit: '90' }])).rejects.toThrow(
      /does not balance/,
    );
  });

  it('refuses an entry with no lines at commit, checked from the entry side', async () => {
    await withAdmin(async (admin) => {
      await admin.query('BEGIN');
      try {
        await admin.query(
          `INSERT INTO crove_finance.journal_entry (org_id, entry_date, description, source_type, source_id)
           VALUES ($1, '2026-10-01', 'no lines', 'test', crove_kernel.uuid_v7())`,
          [orgA],
        );
        await expect(admin.query('COMMIT')).rejects.toThrow(/needs at least 2 lines \(has 0\)/);
      } finally {
        await admin.query('ROLLBACK').catch(() => {});
      }
    });
    await expect(post([])).rejects.toThrow(/at least 2 lines/);
  });

  it('writes the ledger only through the posting function, which stamps org and author from the context', async () => {
    await expect(
      inOrgB((trx) =>
        trx
          .insertInto('crove_finance.journal_entry')
          .values({ org_id: orgB, entry_date: '2026-10-01', description: 'direct', source_type: 'test', source_id: randomUUID() })
          .execute(),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      inOrgB((trx) =>
        trx
          .insertInto('crove_finance.journal_line')
          .values({ org_id: orgB, entry_id: randomUUID(), line_no: 1, account_code: '6422', debit: '100' })
          .execute(),
      ),
    ).rejects.toThrow(/permission denied/);

    const entryId = await post(BALANCED);
    await withAdmin(async (admin) => {
      const { rows } = await admin.query('SELECT org_id, created_by FROM crove_finance.journal_entry WHERE id = $1', [entryId]);
      expect(rows).toEqual([{ org_id: orgB, created_by: users.outsider }]);
    });
  });

  it('refuses lines added to an entry posted in an earlier transaction, even for the database owner', async () => {
    const entryId = await post(BALANCED);
    await withAdmin(async (admin) => {
      // A balanced pair keeps the entry balanced, so only the posted-entry rule can stop it.
      await expect(
        admin.query(
          `INSERT INTO crove_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit) VALUES
           ($1, $2, 3, '6422', 50, 0), ($1, $2, 4, '331', 0, 50)`,
          [orgB, entryId],
        ),
      ).rejects.toThrow(/already posted/);
      const { rows } = await admin.query<{ n: number }>('SELECT count(*)::int AS n FROM crove_finance.journal_line WHERE entry_id = $1', [entryId]);
      expect(rows[0]?.n).toBe(2);
    });
  });

  it('gives the login roles no temporary schema to plant objects in', async () => {
    for (const url of [appUrl, workerUrl]) {
      const login = new pg.Client({ connectionString: url });
      await login.connect();
      try {
        await expect(login.query('CREATE TEMP TABLE text (v pg_catalog.text)')).rejects.toThrow(/permission denied to create temporary tables/);
        await expect(login.query('CREATE FUNCTION pg_temp.f() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$')).rejects.toThrow(/permission denied/);
      } finally {
        await login.end();
      }
    }
  });

  it("never resolves types or casts from the caller's temporary schema inside definer functions", async () => {
    // Login roles have no TEMPORARY (previous test). Grant it back for this session so the pinned
    // search_path is tested on its own, as the layer that still holds if TEMP is ever granted.
    await withAdmin((admin) => admin.query(`GRANT TEMPORARY ON DATABASE ${dbName} TO crove_app`));
    const app = new pg.Client({ connectionString: appUrl });
    await app.connect();
    try {
      // A temp table named "text" is also a type; casts on it run whatever the caller wrote.
      await app.query('CREATE TEMP TABLE text (v pg_catalog.text)');
      for (const [name, from, to, kind] of [
        ['hijack_uuid', 'pg_catalog.uuid', 'pg_temp.text', ''],
        ['hijack_text', 'pg_temp.text', 'pg_catalog.text', 'AS IMPLICIT'],
      ] as const) {
        await app.query(
          `CREATE FUNCTION pg_temp.${name}(${from}) RETURNS ${to} LANGUAGE plpgsql
           AS $$ BEGIN RAISE EXCEPTION 'hijacked as %', current_user; END $$`,
        );
        await app.query(`CREATE CAST (${from} AS ${to}) WITH FUNCTION pg_temp.${name}(${from}) ${kind}`);
      }
      await app.query('BEGIN');
      await app.query('SELECT crove_kernel.enter_context($1::uuid, $2::uuid)', [users.outsider, orgB]);
      // Objects reach a text column only through the planted cast; without it they are not account codes.
      const lines = [
        { line_no: 1, account_code: { v: '6422' }, debit: '100', credit: '0' },
        { line_no: 2, account_code: { v: '331' }, debit: '0', credit: '100' },
      ];
      await expect(
        app.query(`SELECT crove_finance.post_journal_entry('2026-10-01', 'x', 'test', $1::uuid, $2::jsonb)`, [randomUUID(), JSON.stringify(lines)]),
      ).rejects.toThrow(/foreign key/);
    } finally {
      await app.query('ROLLBACK').catch(() => {});
      await app.end();
      await withAdmin((admin) => admin.query(`REVOKE TEMPORARY ON DATABASE ${dbName} FROM crove_app`));
    }
  });

  it('turns an e-invoice into a proposal, and records it once on approval', async () => {
    const { fileId, duplicate } = await ingest(orgA, users.owner, FIXTURE);
    expect(duplicate).toBe(false);
    const again = await ingest(orgA, users.owner, FIXTURE);
    expect(again).toEqual({ fileId, duplicate: true });

    const { proposalId } = await extractAndPropose({ runtime: workerRuntime, store, extractor: null, today: () => '2026-10-13' }, orgA, fileId);
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
      { actor: asMfa(users.owner), orgId: orgA, idempotencyKey: approvalRequest },
    );
    const replay = await runtime.execute(
      'kernel.proposal.approve',
      { id: proposalId, revision: detail.revision, lineAccounts: [{ lineNo: 1, debitAccount: '6422' }] },
      { actor: asMfa(users.owner), orgId: orgA, idempotencyKey: approvalRequest },
    );
    expect(replay).toEqual(first);
    await withAdmin(async (admin) => {
      const { rows } = await admin.query(
        'SELECT created_by, created_xact_id IS NOT NULL AS stamped FROM crove_finance.journal_entry WHERE id = $1',
        [first.journalEntryId],
      );
      expect(rows).toEqual([{ created_by: users.owner, stamped: true }]);
    });
    await expect(
      runtime.execute('kernel.proposal.approve', { id: proposalId, revision: detail.revision }, { actor: asMfa(users.owner), orgId: orgA }),
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
    await runtime.execute('kernel.member.add', { email: 'admin@example.com', role: 'admin' }, { actor: asMfa(users.owner), orgId: orgA });
    const asAdmin = { actor: asMfa(admin), orgId: orgA };
    await expect(runtime.execute('kernel.member.add', { email: 'member@example.com', role: 'admin' }, asAdmin)).rejects.toMatchObject({
      status: 403,
    });
    await expect(runtime.execute('kernel.member.add', { email: 'owner@example.com', role: 'viewer' }, asAdmin)).rejects.toMatchObject({
      status: 403,
    });
    await expect(runtime.execute('kernel.member.add', { email: 'member@example.com', role: 'member' }, asAdmin)).resolves.toBeTruthy();
  });

  it('records an invoice with failed checks only after explicit confirmation, and never a foreign-currency one', async () => {
    // The owner uploads these and org A has an admin by now, so four-eyes (P10) makes the admin approve.
    const admin = await upsertIdentity(db, { issuer: 'test', subject: 'admin', email: 'admin@example.com', name: null });
    const asAdmin = { actor: asMfa(admin), orgId: orgA };

    const mismatch = await propose(variant('1235', (xml) => xml.replace('<TThue>180000</TThue>', '<TThue>170000</TThue>')));
    await expect(runtime.execute('kernel.proposal.approve', mismatch, asAdmin)).rejects.toMatchObject({ code: 'CHECKS_FAILED' });
    await expect(runtime.execute('kernel.proposal.approve', { ...mismatch, acceptFailedChecks: true }, asAdmin)).resolves.toMatchObject({
      journalEntryId: expect.any(String),
    });

    const totalOff = await propose(variant('1237', (xml) => xml.replace('<TgTTTBSo>1980000</TgTTTBSo>', '<TgTTTBSo>1979999</TgTTTBSo>')));
    const pending = await runtime.query<Array<{ id: string; failedChecks: number; total: string | null }>>(
      'kernel.inbox.list',
      { status: 'pending' },
      asAdmin,
    );
    expect(pending.find((p) => p.id === totalOff.id)).toMatchObject({ failedChecks: 1, total: '1979999' });
    await expect(runtime.execute('kernel.proposal.approve', { ...totalOff, acceptFailedChecks: true }, asAdmin)).rejects.toMatchObject({
      code: 'CHECKS_BLOCKING',
    });

    const usd = await propose(variant('1236', (xml) => xml.replace('<DVTTe>VND</DVTTe>', '<DVTTe>USD</DVTTe>')));
    await expect(runtime.execute('kernel.proposal.approve', { ...usd, acceptFailedChecks: true }, asAdmin)).rejects.toMatchObject({
      code: 'UNSUPPORTED_CURRENCY',
    });
  });

  it('marks a file as failed when extraction keeps failing, so it never stays "processing"', async () => {
    const { fileId } = await ingest(orgA, users.owner, new TextEncoder().encode('<a>unreadable</a>'));
    await recordExtractionFailure(workerRuntime, orgA, fileId, 'Không đọc được');
    await recordExtractionFailure(workerRuntime, orgA, fileId, 'Không đọc được');
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

  it('lets only roles that may post approve an R3 proposal, and records the approver', async () => {
    const member = await upsertIdentity(db, { issuer: 'test', subject: 'plain-member', email: 'plain-member@example.com', name: null });
    const approver = await upsertIdentity(db, { issuer: 'test', subject: 'approver', email: 'approver@example.com', name: null });
    const asOwner = { actor: asMfa(users.owner), orgId: orgA };
    await runtime.execute('kernel.member.add', { email: 'plain-member@example.com', role: 'member' }, asOwner);
    await runtime.execute('kernel.member.add', { email: 'approver@example.com', role: 'admin' }, asOwner);
    const proposal = await propose(variant('1238'));

    await expect(runtime.execute('kernel.proposal.approve', proposal, { actor: asUser(member), orgId: orgA })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      status: 403,
    });
    await expect(runtime.execute('kernel.proposal.approve', proposal, { actor: asMfa(approver), orgId: orgA })).resolves.toMatchObject({
      journalEntryId: expect.any(String),
    });

    await withAdmin(async (admin) => {
      const decided = await admin.query('SELECT status, decided_by FROM crove_kernel.proposal WHERE id = $1', [proposal.id]);
      expect(decided.rows).toEqual([{ status: 'executed', decided_by: approver }]);
      const audit = await admin.query(
        `SELECT actor_id, outcome FROM crove_kernel.audit_event
         WHERE command = 'kernel.proposal.approve' AND target_id = $1 ORDER BY occurred_at`,
        [proposal.id],
      );
      expect(audit.rows).toEqual([
        { actor_id: member, outcome: 'denied' },
        { actor_id: approver, outcome: 'ok' },
      ]);
    });
  });

  it('reads the assurance level, session and MFA time from every token, not from the identity cache', async () => {
    const secret = 'test-only-jwt-secret-for-aal-0123456789';
    const authenticate = createAuthenticator(
      loadConfig({ DATABASE_URL: appUrl, AUTH_JWT_SECRET: secret, AUTH_ISSUER: 'test-auth', AUTH_SESSION_CHECK: 'off' }),
      db,
    );
    const session = '6b1f2a9e-3c4d-4e5f-8a9b-0c1d2e3f4a5b';
    const bearer = async (claims: Record<string, unknown>) =>
      `Bearer ${await new SignJWT({ email: 'mfa@example.com', role: 'authenticated', session_id: session, ...claims })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject('mfa-user')
        .setIssuer('test-auth')
        .setAudience('authenticated')
        .setExpirationTime('5m')
        .sign(new TextEncoder().encode(secret))}`;

    const mfaAt = Math.floor(Date.now() / 1000) - 10;
    const stepUp = await authenticate(await bearer({ aal: 'aal2', amr: [{ method: 'totp', timestamp: mfaAt }, { method: 'password', timestamp: mfaAt - 60 }] }));
    expect(stepUp).toMatchObject({ aal: 'aal2', sessionId: session, mfaAt });
    await expect(authenticate(await bearer({ aal: 'aal1' }))).resolves.toEqual({ ...stepUp, aal: 'aal1', mfaAt: null });
    await expect(authenticate(await bearer({}))).resolves.toEqual({ ...stepUp, aal: 'aal1', mfaAt: null });
    expect(actorOf(stepUp)).toEqual({ type: 'user', userId: stepUp.userId, aal: 'aal2', sessionId: session, mfaAt });
  });

  // Policy P11 (ADR-0028 section 5): R3 needs aal2 and a second factor in the last 5 minutes.
  it('refuses R3 without fresh MFA, and records the assurance used on the audit row', async () => {
    const proposal = await propose(variant('1239'));
    // The owner uploaded it and org A has other admins by now, so an admin approves (four-eyes, P10).
    const admin = await upsertIdentity(db, { issuer: 'test', subject: 'admin', email: 'admin@example.com', name: null });
    const approve = (actor: ReturnType<typeof asMfa> | ReturnType<typeof asUser>) =>
      runtime.execute('kernel.proposal.approve', proposal, { actor, orgId: orgA });
    await expect(approve(asUser(admin))).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED', status: 403 });
    await expect(approve(asMfa(admin, 6 * 60))).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED', status: 403 });
    await expect(approve({ ...asMfa(admin), aal: 'aal1' as const })).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' });
    await expect(
      runtime.execute('kernel.member.add', { email: 'viewer@example.com', role: 'viewer' }, { actor: asUser(users.owner), orgId: orgA }),
    ).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' });
    const fresh = asMfa(admin, 60);
    await expect(approve(fresh)).resolves.toMatchObject({ journalEntryId: expect.any(String) });
    // A deployment that turned P11 off (local only) approves without MFA.
    const relaxed = new Runtime(db, { stepUp: 'off' }).register({
      commands: [...kernelCommands, ...financeCommands],
      queries: [...kernelQueries({ inboundDomain: 'in.test' }), ...financeQueries],
    });
    const other = await propose(variant('1241'));
    await expect(relaxed.execute('kernel.proposal.approve', other, { actor: asUser(admin), orgId: orgA })).resolves.toMatchObject({
      journalEntryId: expect.any(String),
    });

    await withAdmin(async (admin) => {
      const { rows } = await admin.query(
        `SELECT outcome, detail FROM crove_kernel.audit_event
         WHERE command = 'kernel.proposal.approve' AND target_id = $1 ORDER BY occurred_at`,
        [proposal.id],
      );
      expect(rows.map((r) => [r.outcome, r.detail.code ?? null])).toEqual([
        ['denied', 'STEP_UP_REQUIRED'],
        ['denied', 'STEP_UP_REQUIRED'],
        ['denied', 'STEP_UP_REQUIRED'],
        ['ok', null],
      ]);
      expect(rows[3]?.detail).toMatchObject({ aal: 'aal2', sessionId: fresh.sessionId, mfaAt: fresh.mfaAt });
    });
  });

  // External-tenant gate T5: system context is the worker's alone.
  it('lets only the worker login role enter system context (EXECUTE matrix)', async () => {
    const functions = [
      'crove_kernel.enter_system_context(uuid)',
      'crove_kernel.enter_context(uuid,uuid)',
      'crove_kernel.org_by_inbound_token(text)',
      'crove_kernel.inbound_enqueue(text,text,bigint,text)',
      'crove_kernel.inbound_claim(integer)',
      'crove_kernel.outbox_claim(integer)',
    ];
    const roles = ['crove_app', 'crove_worker', 'crove_tenant', 'crove_definer_tenant'];
    const matrix = await withAdmin(async (admin) => {
      const { rows } = await admin.query<{ fn: string; role: string; can: boolean }>(
        `SELECT f AS fn, r AS role, has_function_privilege(r, f, 'EXECUTE') AS can
         FROM unnest($1::text[]) f CROSS JOIN unnest($2::text[]) r`,
        [functions, roles],
      );
      return Object.fromEntries(functions.map((f) => [f, roles.filter((r) => rows.some((row) => row.fn === f && row.role === r && row.can))]));
    });
    expect(matrix).toEqual({
      'crove_kernel.enter_system_context(uuid)': ['crove_worker'],
      'crove_kernel.enter_context(uuid,uuid)': ['crove_app'],
      'crove_kernel.org_by_inbound_token(text)': ['crove_worker'],
      'crove_kernel.inbound_enqueue(text,text,bigint,text)': ['crove_app'],
      'crove_kernel.inbound_claim(integer)': ['crove_worker'],
      'crove_kernel.outbox_claim(integer)': ['crove_worker'],
    });

    // The API login role is refused by the database itself, and so is a system command run through it.
    await expect(db.transaction().execute((trx) => sql`SELECT crove_kernel.enter_system_context(${orgA}::uuid)`.execute(trx))).rejects.toThrow(
      /permission denied for function enter_system_context/,
    );
    await expect(
      runtime.execute(
        'kernel.inbound.receive',
        { messageId: 'smuggled', from: null, subject: null, files: [] },
        { actor: { type: 'system', component: 'inbound.email' }, orgId: orgA },
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });

    // The worker login role enters an org without a user.
    const entered = await workerDb.transaction().execute(async (trx) => {
      await sql`SELECT crove_kernel.enter_system_context(${orgA}::uuid)`.execute(trx);
      const { rows } = await sql<{ org: string; user: string | null }>`SELECT crove_kernel.ctx_org_id() AS org, crove_kernel.ctx_user_id() AS user`.execute(trx);
      return rows[0];
    });
    expect(entered).toEqual({ org: orgA, user: null });

    // No crove_kernel function is executable by PUBLIC.
    await withAdmin(async (admin) => {
      const { rows } = await admin.query(
        `SELECT p.proname FROM pg_proc p, aclexplode(p.proacl) a WHERE a.grantee = 0 AND p.pronamespace = 'crove_kernel'::regnamespace`,
      );
      expect(rows).toEqual([]);
    });

    // The session_user check holds on its own: even with EXECUTE granted to crove_app (rolled back), it refuses.
    await withAdmin(async (admin) => {
      await admin.query('BEGIN');
      try {
        await admin.query('GRANT EXECUTE ON FUNCTION crove_kernel.enter_system_context(uuid) TO crove_app');
        await admin.query('SET SESSION AUTHORIZATION crove_app');
        await expect(admin.query('SELECT crove_kernel.enter_system_context($1::uuid)', [orgA])).rejects.toMatchObject({
          code: '42501',
          message: 'SYSTEM_CONTEXT_WORKER_ONLY',
        });
      } finally {
        await admin.query('ROLLBACK');
      }
      const { rows } = await admin.query<{ can: boolean; who: string }>(
        `SELECT has_function_privilege('crove_app', 'crove_kernel.enter_system_context(uuid)', 'EXECUTE') AS can, session_user AS who`,
      );
      expect(rows[0]).toMatchObject({ can: false });
      expect(rows[0]?.who).not.toBe('crove_app');
    });

    // A more privileged definer granted to the API cannot reach it either: the check is on session_user.
    await withAdmin(async (admin) => {
      await admin.query(`CREATE FUNCTION public.t5_probe(p uuid) RETURNS void LANGUAGE sql SECURITY DEFINER
        SET search_path = pg_catalog, pg_temp AS $$ SELECT crove_kernel.enter_system_context(p) $$`);
      await admin.query('GRANT EXECUTE ON FUNCTION public.t5_probe(uuid) TO crove_app');
    });
    try {
      await expect(db.transaction().execute((trx) => sql`SELECT public.t5_probe(${orgA}::uuid)`.execute(trx))).rejects.toThrow(
        /SYSTEM_CONTEXT_WORKER_ONLY/,
      );
    } finally {
      await withAdmin((admin) => admin.query('DROP FUNCTION public.t5_probe(uuid)'));
    }

    // The startup guards agree with the grants.
    await expect(assertSystemContextAccess(pool, 'denied')).resolves.toBeUndefined();
    await expect(assertSystemContextAccess(workerPool, 'granted')).resolves.toBeUndefined();
    await expect(assertSystemContextAccess(pool, 'granted')).rejects.toThrow(
      /cannot enter system context \(crove_kernel.enter_system_context\(uuid\), crove_kernel.org_by_inbound_token\(text\), crove_kernel.inbound_claim\(integer\)\)/,
    );
    await expect(assertSystemContextAccess(workerPool, 'denied')).rejects.toThrow(/can enter system context \(crove_kernel.enter_system_context/);
  });

  // ---------------------------------------------------------------------------------------------------------
  // External-tenant gate T4: org creation is the org-less command kernel.org.create, run by execute().
  // ---------------------------------------------------------------------------------------------------------
  async function orgCreationRows(userId: string) {
    return withAdmin(async (admin) => {
      const tenants = await admin.query<{ org_id: string; slug: string; xid: string }>(
        'SELECT org_id, slug, xmin::text AS xid FROM crove_kernel.tenant WHERE created_by = $1 ORDER BY created_at, org_id',
        [userId],
      );
      const ids = tenants.rows.map((t) => t.org_id);
      const members = await admin.query<{ org_id: string; user_id: string; role: string; xid: string }>(
        'SELECT org_id, user_id, role, xmin::text AS xid FROM crove_kernel.tenant_member WHERE org_id = ANY($1::uuid[]) ORDER BY org_id, user_id',
        [ids],
      );
      const audits = await admin.query<{ org_id: string; actor_id: string; outcome: string; detail: Record<string, unknown>; xid: string }>(
        `SELECT org_id, actor_id, outcome, detail, xmin::text AS xid FROM crove_kernel.audit_event
         WHERE command = 'kernel.org.create' AND org_id = ANY($1::uuid[]) ORDER BY occurred_at, id`,
        [ids],
      );
      const keys = await admin.query<{ org_id: string; key: string; response: unknown; xid: string }>(
        `SELECT org_id, key, response, xmin::text AS xid FROM crove_kernel.idempotency_key
         WHERE command = 'kernel.org.create' AND org_id = ANY($1::uuid[]) ORDER BY created_at, key`,
        [ids],
      );
      return { tenants: tenants.rows, members: members.rows, audits: audits.rows, keys: keys.rows };
    });
  }

  it('creates an org through execute() with tenant, owner, audit row and idempotency key in one transaction', async () => {
    const tag = randomUUID().slice(0, 8);
    const founder = await upsertIdentity(db, { issuer: 'test', subject: `founder-${tag}`, email: `founder-${tag}@example.com`, name: null });
    const key = randomUUID();
    const created = await createOrg(runtime, asUser(founder), `  Công ty TNHH Bốn ${tag}  `, key);
    expect(created).toEqual({ orgId: expect.any(String), slug: `cong-ty-tnhh-bon-${tag}`, name: `Công ty TNHH Bốn ${tag}`, role: 'owner' });

    const first = await orgCreationRows(founder);
    expect(first.tenants).toEqual([{ org_id: created.orgId, slug: created.slug, xid: expect.any(String) }]);
    const xid = first.tenants[0]?.xid;
    expect(first.members).toEqual([{ org_id: created.orgId, user_id: founder, role: 'owner', xid }]);
    expect(first.audits).toEqual([{ org_id: created.orgId, actor_id: founder, outcome: 'ok', detail: { slug: created.slug }, xid }]);
    expect(first.keys).toEqual([{ org_id: created.orgId, key, response: { value: created }, xid }]);

    // A replayed request with the same key returns the same org and writes nothing.
    await expect(createOrg(runtime, asUser(founder), `Công ty TNHH Bốn ${tag}`, key)).resolves.toEqual(created);
    expect(await orgCreationRows(founder)).toEqual(first);

    // The same key with another name is refused, and the refusal is audited in the org the key belongs to.
    await expect(createOrg(runtime, asUser(founder), 'Another name', key)).rejects.toMatchObject({ code: 'IDEMPOTENCY_MISMATCH', status: 422 });
    const refused = await orgCreationRows(founder);
    expect(refused.tenants).toEqual(first.tenants);
    expect(refused.audits.map((a) => [a.org_id, a.outcome, a.detail])).toEqual([
      [created.orgId, 'ok', { slug: created.slug }],
      [created.orgId, 'failed', { code: 'IDEMPOTENCY_MISMATCH', aal: 'aal1', sessionId: null, mfaAt: null }],
    ]);

    // Two concurrent requests with one key create one org.
    const concurrentKey = randomUUID();
    const [a, b] = await Promise.all([
      createOrg(runtime, asUser(founder), `Song song ${tag}`, concurrentKey),
      createOrg(runtime, asUser(founder), `Song song ${tag}`, concurrentKey),
    ]);
    expect(a).toEqual(b);
    // Without a key every request is a new org; a taken slug gets a random suffix.
    const again = await createOrg(runtime, asUser(founder), `Song song ${tag}`);
    expect(again.orgId).not.toBe(a.orgId);
    expect(again.slug).toMatch(new RegExp(`^song-song-${tag}-[0-9a-f]{4}$`));
    const final = await orgCreationRows(founder);
    expect(final.tenants.map((t) => t.org_id)).toEqual([created.orgId, a.orgId, again.orgId]);
    expect(final.members.filter((m) => m.role === 'owner')).toHaveLength(3);
    expect(final.audits.filter((x) => x.outcome === 'ok').map((x) => x.org_id)).toEqual([created.orgId, a.orgId, again.orgId]);

    // The new owner works in the org like any member.
    await expect(runtime.query('kernel.org.get', {}, { actor: asUser(founder), orgId: created.orgId })).resolves.toMatchObject({
      slug: created.slug,
    });
  });

  it('lets no login role create an org outside execute() (EXECUTE matrix, audit at commit)', async () => {
    const functions = ['crove_kernel.create_or_replay_org(uuid,text,text,text)', 'crove_kernel.tenant_requires_audit()'];
    const roles = ['crove_app', 'crove_worker', 'crove_tenant', 'crove_definer_tenant'];
    const matrix = await withAdmin(async (admin) => {
      const { rows } = await admin.query<{ fn: string; role: string; can: boolean }>(
        `SELECT f AS fn, r AS role, has_function_privilege(r, f, 'EXECUTE') AS can
         FROM unnest($1::text[]) f CROSS JOIN unnest($2::text[]) r`,
        [functions, roles],
      );
      const raw = await admin.query<{ fn: string | null }>(`SELECT to_regprocedure('crove_kernel.create_org(uuid,text,text)')::text AS fn`);
      return {
        ...Object.fromEntries(functions.map((f) => [f, roles.filter((r) => rows.some((row) => row.fn === f && row.role === r && row.can))])),
        raw: raw.rows[0]?.fn,
      };
    });
    expect(matrix).toEqual({
      'crove_kernel.create_or_replay_org(uuid,text,text,text)': ['crove_app'],
      'crove_kernel.tenant_requires_audit()': [],
      raw: null,
    });

    // The API role calling the definer directly gets no tenant: it cannot commit without its audit row.
    await expect(
      db.transaction().execute((trx) => sql`SELECT crove_kernel.create_or_replay_org(${users.owner}::uuid, 'raw-org', 'Raw', NULL)`.execute(trx)),
    ).rejects.toThrow(/ORG_CREATE_UNAUDITED/);
    await expect(
      workerDb.transaction().execute((trx) => sql`SELECT crove_kernel.create_or_replay_org(${users.owner}::uuid, 'raw-org', 'Raw', NULL)`.execute(trx)),
    ).rejects.toThrow(/permission denied for function create_or_replay_org/);
    // Neither can the database owner insert a tenant on its own.
    await withAdmin(async (admin) => {
      await expect(
        admin.query(`INSERT INTO crove_kernel.tenant (slug, name, created_by) VALUES ('raw-org', 'Raw', $1)`, [users.owner]),
      ).rejects.toThrow(/ORG_CREATE_UNAUDITED/);
      const { rows } = await admin.query(`SELECT 1 FROM crove_kernel.tenant WHERE slug = 'raw-org'`);
      expect(rows).toEqual([]);
    });

    // Org-less commands only run through executeOrgless(), and org commands only through execute().
    await expect(runtime.execute('kernel.org.create', { name: 'x' }, { actor: asUser(users.owner), orgId: orgA })).rejects.toMatchObject({
      code: 'COMMAND_NOT_FOUND',
    });
    await expect(runtime.executeOrgless('kernel.member.add', {}, { actor: asUser(users.owner) })).rejects.toMatchObject({
      code: 'COMMAND_NOT_FOUND',
    });
  });

  it('files a forwarded e-invoice through the worker: the API only stores and enqueues it', { timeout: 90_000 }, async () => {
    const inboundSecret = 'test-only-inbound-secret-0123456789abcdef';
    const config = loadConfig({
      DATABASE_URL: appUrl,
      AUTH_JWT_SECRET: 'test-only-jwt-secret-for-inbound-0123456789',
      AUTH_ISSUER: 'test-auth',
      INBOUND_DOMAIN: 'in.test',
      INBOUND_SECRET: inboundSecret,
      WEB_DIST: '/nonexistent',
    });
    const app = createHttpApp({
      config,
      runtime,
      store,
      authenticate: async () => {
        throw new Error('not used');
      },
      pool,
      aiEnabled: false,
    });
    const token = await withAdmin(async (admin) => {
      const { rows } = await admin.query<{ inbound_token: string }>('SELECT inbound_token FROM crove_kernel.tenant WHERE org_id = $1', [orgA]);
      return rows[0]?.inbound_token ?? '';
    });
    const attachment = Buffer.from(variant('1240')).toString('base64').replace(/.{76}/g, '$&\r\n');
    const mime = [
      'From: Nha cung cap <ketoan@vendor.example>',
      `To: ${token}@in.test`,
      'Subject: Hoa don 1240',
      'Message-ID: <hd-1240@vendor.example>',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="b1"',
      '',
      '--b1',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Hoa don dinh kem',
      '--b1',
      'Content-Type: application/xml; name="hd-1240.xml"',
      'Content-Disposition: attachment; filename="hd-1240.xml"',
      'Content-Transfer-Encoding: base64',
      '',
      attachment,
      '--b1--',
      '',
    ].join('\r\n');
    const deliver = (secret: string, body = mime) =>
      app.request('/api/inbound/email', {
        method: 'POST',
        headers: { authorization: `Bearer ${secret}`, 'content-type': 'message/rfc822', 'x-crove-recipient': `${token}@in.test` },
        body,
      });
    const count = (query: string, params: unknown[]) =>
      withAdmin(async (admin) => Number((await admin.query<{ n: string }>(query, params)).rows[0]?.n ?? 0));
    const emailProposals = () =>
      count(
        `SELECT count(*) AS n FROM crove_kernel.proposal p
         JOIN crove_kernel.file f ON f.org_id = p.org_id AND f.id = p.source_file_id
         WHERE p.org_id = $1 AND f.source = 'email'`,
        [orgA],
      );
    const receiveAudits = () =>
      count(`SELECT count(*) AS n FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.inbound.receive' AND actor_type = 'system'`, [orgA]);
    const pending = () => count('SELECT count(*) AS n FROM crove_kernel.inbound_pending', []);
    const until = async (check: () => Promise<boolean>) => {
      const deadline = Date.now() + 60_000;
      while (!(await check())) {
        if (Date.now() > deadline) throw new Error('timed out waiting for the worker');
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    };

    expect((await deliver('wrong-secret')).status).toBe(401);
    const first = await deliver(inboundSecret);
    expect(first.status).toBe(202);
    expect(await first.json()).toMatchObject({ accepted: true, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    // A retried delivery while the message is still pending is absorbed.
    expect((await deliver(inboundSecret)).status).toBe(202);
    // Nothing reached the tenant yet: the API stored the raw message and queued it, and did not parse it.
    // The duplicate delivery's blob was deleted again, so one blob backs the one pending row.
    expect(await pending()).toBe(1);
    expect(store.keys('inbound/')).toHaveLength(1);
    expect(await count('SELECT count(*) AS n FROM crove_kernel.inbound_message WHERE org_id = $1', [orgA])).toBe(0);

    // Backpressure: past 10000 pending messages the API answers 503 and keeps nothing.
    await withAdmin((admin) =>
      admin.query(`INSERT INTO crove_kernel.inbound_pending (blob_id, raw_sha256, size_bytes)
        SELECT encode(sha256(('filler-' || i)::bytea), 'hex'), encode(sha256(('filler-' || i)::bytea), 'hex'), 1
        FROM generate_series(1, 10000) i`),
    );
    const overloaded = await deliver(inboundSecret, mime.replace('hd-1240@', 'hd-1240-again@'));
    expect(overloaded.status).toBe(503);
    expect(await overloaded.json()).toMatchObject({ code: 'OVERLOADED' });
    expect(store.keys('inbound/')).toHaveLength(1);
    await withAdmin((admin) => admin.query(`DELETE FROM crove_kernel.inbound_pending WHERE size_bytes = 1`));
    expect(await pending()).toBe(1);

    await migrateJobs(adminUrl);
    // pg-boss functions are SECURITY INVOKER, which is why the hardening guard skips them; a rerun of the
    // runner (and its guard) passes with the job schema installed.
    await withAdmin(async (admin) => {
      const { rows } = await admin.query<{ total: number; definers: number }>(
        `SELECT count(*)::int AS total, count(*) FILTER (WHERE prosecdef)::int AS definers FROM pg_proc WHERE pronamespace = 'crove_jobs'::regnamespace`,
      );
      expect(rows[0]?.total).toBeGreaterThan(0);
      expect(rows[0]?.definers).toBe(0);
    });
    expect(await migrate({ adminUrl, dir: MIGRATIONS })).toEqual([]);
    const stop = await startWorker({ connectionString: workerUrl, workerDb, runtime: workerRuntime, store, extractor: null, inboundDomain: 'in.test' });
    try {
      await until(async () => (await emailProposals()) === 1);
      expect(await pending()).toBe(0);
      expect(await receiveAudits()).toBe(1);
      // Filed, so the raw message is deleted.
      await until(async () => store.keys('inbound/').length === 0);
      const inbox = await runtime.query<Array<{ title: string; total: string | null }>>('kernel.inbox.list', {}, { actor: asUser(users.owner), orgId: orgA });
      expect(inbox.some((p) => p.total === '1980000')).toBe(true);

      // The same message delivered again later is recorded once (idempotent on Message-ID).
      expect((await deliver(inboundSecret)).status).toBe(202);
      await until(async () => (await receiveAudits()) === 2);
      expect(await count(`SELECT count(*) AS n FROM crove_kernel.inbound_message WHERE org_id = $1 AND message_id LIKE '%hd-1240@vendor.example%'`, [orgA])).toBe(1);
      expect(await emailProposals()).toBe(1);
      await until(async () => store.keys('inbound/').length === 0);
    } finally {
      await stop();
    }

    // The worker refuses a blob that does not match the size or hash the API enqueued.
    const blobId = newInboundBlobId();
    const raw = new TextEncoder().encode(mime);
    await store.put(inboundKey(blobId), raw);
    const job = { blobId, sha256: sha256Hex(raw), sizeBytes: raw.byteLength, recipient: `${token}@in.test` };
    for (const tampered of [{ ...job, sizeBytes: raw.byteLength + 1 }, { ...job, sha256: sha256Hex('other') }]) {
      await expect(processInboundEmail({ runtime: workerRuntime, store, domain: 'in.test' }, tampered)).rejects.toMatchObject({
        code: 'INBOUND_BLOB_MISMATCH',
      });
    }
  });

  // ---------------------------------------------------------------------------------------------------------
  // Approval policy (plan §4.7 P10 and P12, §8.3; External-tenant gate T2). Each case runs in its own org.
  // ---------------------------------------------------------------------------------------------------------
  type Role = 'admin' | 'member' | 'viewer';
  type Decision = { canApprove: boolean; approveReason: string; canEdit: boolean; revision: number };

  async function policyOrg(name: string, roles: Role[]) {
    const tag = randomUUID().slice(0, 8);
    const owner = await upsertIdentity(db, { issuer: 'test', subject: `owner-${tag}`, email: `owner-${tag}@example.com`, name: null });
    const orgId = (await createOrg(runtime, asUser(owner), `${name} ${tag}`)).orgId;
    const people: string[] = [];
    for (const [i, role] of roles.entries()) {
      const email = `${role}${i}-${tag}@example.com`;
      people.push(await upsertIdentity(db, { issuer: 'test', subject: `${role}${i}-${tag}`, email, name: null }));
      await runtime.execute('kernel.member.add', { email, role }, { actor: asMfa(owner), orgId });
    }
    const setRole = (userId: string, role: Role) => {
      const index = people.indexOf(userId);
      return runtime.execute('kernel.member.add', { email: `${roles[index]}${index}-${tag}@example.com`, role }, { actor: asMfa(owner), orgId });
    };
    return { orgId, owner, people, setRole };
  }

  async function proposeIn(orgId: string, uploader: string, number: string) {
    const bytes = variant(number);
    const sha256 = sha256Hex(bytes);
    const storageKey = fileKey(orgId, sha256);
    await store.put(storageKey, bytes);
    const { fileId } = await runtime.execute<{ fileId: string }>(
      'kernel.file.ingest',
      { filename: 'hd.xml', contentType: 'application/xml', sizeBytes: bytes.byteLength, sha256, storageKey, source: 'upload' },
      { actor: asUser(uploader), orgId },
    );
    const { proposalId } = await extractAndPropose({ runtime: workerRuntime, store, extractor: null, today: () => '2026-10-13' }, orgId, fileId);
    if (!proposalId) throw new Error('no proposal');
    return proposalId;
  }

  const view = (orgId: string, userId: string, id: string) =>
    runtime.query<Decision & { payload: { lines: Array<{ lineNo: number; debitAccount: string }> } }>('kernel.inbox.get', { id }, { actor: asUser(userId), orgId });
  const approveAs = (orgId: string, userId: string, id: string, revision: number) =>
    runtime.execute<{ journalEntryId: string }>('kernel.proposal.approve', { id, revision }, { actor: asMfa(userId), orgId });

  async function approvalAudit(proposalId: string) {
    return withAdmin(async (admin) => {
      const { rows } = await admin.query<{ actor_id: string; outcome: string; detail: Record<string, unknown> }>(
        `SELECT actor_id, outcome, detail FROM crove_kernel.audit_event
         WHERE command = 'kernel.proposal.approve' AND target_id = $1 ORDER BY occurred_at, id`,
        [proposalId],
      );
      return rows;
    });
  }

  it('four-eyes (P10): with two eligible approvers the uploader cannot approve, the other approver can', async () => {
    const { orgId, owner, people } = await policyOrg('Four eyes', ['admin']);
    const admin = people[0] as string;
    const id = await proposeIn(orgId, owner, '2001');

    const asOwner = await view(orgId, owner, id);
    expect(asOwner).toMatchObject({ canApprove: false, approveReason: 'four_eyes', canEdit: true });
    expect(await view(orgId, admin, id)).toMatchObject({ canApprove: true, approveReason: 'ok' });
    await expect(approveAs(orgId, owner, id, asOwner.revision)).rejects.toMatchObject({ code: 'FOUR_EYES_REQUIRED', status: 403 });
    await expect(approveAs(orgId, admin, id, asOwner.revision)).resolves.toMatchObject({ journalEntryId: expect.any(String) });

    expect(await approvalAudit(id)).toEqual([
      {
        actor_id: owner,
        outcome: 'denied',
        detail: { code: 'FOUR_EYES_REQUIRED', rule: 'P10', aal: 'aal2', sessionId: asMfa(owner).sessionId, mfaAt: expect.any(Number) },
      },
      {
        actor_id: admin,
        outcome: 'ok',
        detail: {
          revision: 1,
          aal: 'aal2',
          sessionId: asMfa(admin).sessionId,
          mfaAt: expect.any(Number),
          policy: { P12: 'pass', P10: 'pass' },
          eligible_approvers: 2,
          self_approved: false,
          accept_failed_checks: false,
        },
      },
    ]);
    expect(await view(orgId, admin, id)).toMatchObject({ canApprove: false, approveReason: 'not_pending', canEdit: false });
  });

  it('lets the only eligible approver (the owner alone) self-approve, flagged in the audit row', async () => {
    const { orgId, owner, people } = await policyOrg('Solo', ['member']);
    const id = await proposeIn(orgId, owner, '2002');
    const detail = await view(orgId, owner, id);
    expect(detail).toMatchObject({ canApprove: true, approveReason: 'ok' });
    await expect(approveAs(orgId, owner, id, detail.revision)).resolves.toMatchObject({ journalEntryId: expect.any(String) });
    const [row] = await approvalAudit(id);
    expect(row).toMatchObject({ actor_id: owner, outcome: 'ok', detail: { self_approved: true, eligible_approvers: 1, policy: { P10: 'self_approved' } } });

    // A proposal uploaded by someone else is not a self-approval.
    const other = await proposeIn(orgId, people[0] as string, '2003');
    await approveAs(orgId, owner, other, 1);
    expect((await approvalAudit(other))[0]).toMatchObject({ outcome: 'ok', detail: { self_approved: false, policy: { P10: 'pass' } } });
  });

  it('never lets members or viewers approve (P12), and hides Approve from them', async () => {
    const { orgId, owner, people } = await policyOrg('Roles', ['member', 'viewer']);
    const [member, viewer] = people as [string, string];
    const id = await proposeIn(orgId, member, '2004');
    expect(await view(orgId, member, id)).toMatchObject({ canApprove: false, approveReason: 'not_eligible', canEdit: true });
    expect(await view(orgId, viewer, id)).toMatchObject({ canApprove: false, approveReason: 'not_eligible', canEdit: false });
    await expect(approveAs(orgId, member, id, 1)).rejects.toMatchObject({ status: 403 });
    await expect(approveAs(orgId, viewer, id, 1)).rejects.toMatchObject({ status: 403 });
    await expect(
      runtime.execute('kernel.proposal.edit', { id, revision: 1, lineAccounts: [{ lineNo: 1, debitAccount: '6421' }] }, { actor: asUser(viewer), orgId }),
    ).rejects.toMatchObject({ status: 403 });
    // The owner did not upload it, so they approve without self-approval.
    expect(await view(orgId, owner, id)).toMatchObject({ canApprove: true, approveReason: 'ok' });
  });

  it('re-checks roles live: a demoted admin cannot approve, and an admin promoted later is not in the snapshot', async () => {
    const { orgId, owner, people, setRole } = await policyOrg('Role changes', ['admin', 'member']);
    const [adminA, laterAdmin] = people as [string, string];
    const id = await proposeIn(orgId, owner, '2005');
    expect(await view(orgId, adminA, id)).toMatchObject({ canApprove: true });

    await setRole(adminA, 'member');
    await setRole(laterAdmin, 'admin');
    expect(await view(orgId, adminA, id)).toMatchObject({ canApprove: false, approveReason: 'not_eligible' });
    await expect(approveAs(orgId, adminA, id, 1)).rejects.toMatchObject({ status: 403 });
    expect(await view(orgId, laterAdmin, id)).toMatchObject({ canApprove: false, approveReason: 'not_eligible' });
    await expect(approveAs(orgId, laterAdmin, id, 1)).rejects.toMatchObject({ code: 'NOT_ELIGIBLE', status: 403 });
    expect((await approvalAudit(id)).at(-1)).toMatchObject({ actor_id: laterAdmin, outcome: 'denied', detail: { code: 'NOT_ELIGIBLE', rule: 'P12' } });

    // Only the owner is still eligible from the snapshot, so the owner (the uploader) may self-approve.
    expect(await view(orgId, owner, id)).toMatchObject({ canApprove: true, approveReason: 'ok' });
    await approveAs(orgId, owner, id, 1);
    expect((await approvalAudit(id)).at(-1)).toMatchObject({ actor_id: owner, outcome: 'ok', detail: { self_approved: true, eligible_approvers: 1 } });
  });

  it('turns an edit into a new revision authored by the editor; the old revision and unsaved changes cannot be approved', async () => {
    const { orgId, owner, people } = await policyOrg('Edits', ['admin', 'member']);
    const [admin, member] = people as [string, string];
    const id = await proposeIn(orgId, member, '2006');
    const before = await view(orgId, owner, id);
    expect(before).toMatchObject({ revision: 1, canApprove: true });
    const line = before.payload.lines[0] as { lineNo: number; debitAccount: string };
    const account = line.debitAccount === '6421' ? '6422' : '6421';
    const changed = [{ lineNo: line.lineNo, debitAccount: account }];

    // Approve never carries an edit.
    await expect(
      runtime.execute('kernel.proposal.approve', { id, revision: 1, lineAccounts: changed }, { actor: asMfa(owner), orgId }),
    ).rejects.toMatchObject({ code: 'CONTENT_CHANGED' });
    // An edit that changes nothing creates no revision.
    await expect(
      runtime.execute('kernel.proposal.edit', { id, revision: 1, lineAccounts: [line] }, { actor: asUser(owner), orgId }),
    ).resolves.toEqual({ revision: 1, changed: false });
    await expect(
      runtime.execute('kernel.proposal.edit', { id, revision: 1, lineAccounts: [{ lineNo: line.lineNo, debitAccount: '99999' }] }, { actor: asUser(owner), orgId }),
    ).rejects.toMatchObject({ code: 'UNKNOWN_ACCOUNT' });

    await expect(
      runtime.execute('kernel.proposal.edit', { id, revision: 1, lineAccounts: changed }, { actor: asUser(owner), orgId }),
    ).resolves.toEqual({ revision: 2, changed: true });
    await withAdmin(async (adminClient) => {
      const { rows } = await adminClient.query('SELECT revision, authors FROM crove_kernel.proposal WHERE id = $1', [id]);
      expect(rows[0]).toEqual({
        revision: 2,
        authors: [
          { type: 'system', component: 'finance.extract' },
          { type: 'user', id: member },
          { type: 'user', id: owner },
        ],
      });
    });

    await expect(approveAs(orgId, admin, id, 1)).rejects.toMatchObject({ code: 'STALE_REVISION' });
    const after = await view(orgId, owner, id);
    expect(after).toMatchObject({ revision: 2, canApprove: false, approveReason: 'four_eyes', canEdit: true });
    expect(after.payload.lines[0]).toMatchObject({ debitAccount: account, reason: 'Người dùng chọn' });
    await expect(approveAs(orgId, owner, id, 2)).rejects.toMatchObject({ code: 'FOUR_EYES_REQUIRED' });
    expect(await view(orgId, admin, id)).toMatchObject({ canApprove: true, approveReason: 'ok' });
    const { journalEntryId } = await approveAs(orgId, admin, id, 2);

    const journal = await runtime.query<Array<{ id: string; lines: Array<{ accountCode: string }> }>>('finance.journal.list', {}, { actor: asUser(admin), orgId });
    expect(journal.find((j) => j.id === journalEntryId)?.lines.map((l) => l.accountCode)).toContain(account);
    expect((await approvalAudit(id)).at(-1)).toMatchObject({ actor_id: admin, outcome: 'ok', detail: { revision: 2, self_approved: false } });
  });
});
