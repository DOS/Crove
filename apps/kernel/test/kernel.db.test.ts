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
import { DomainError, Runtime, fileKey, sha256Hex, type BlobStore } from '@crove/kernel-runtime';
import { extractAndPropose, financeCommands, financeQueries, recordExtractionFailure } from '@crove/mod-finance';
import { actorOf, createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
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
    orgA = (await createOrg(runtime, users.owner, 'Org A')).orgId;
    orgB = (await createOrg(runtime, users.outsider, 'Org B')).orgId;
    await runtime.execute('kernel.member.add', { email: 'viewer@example.com', role: 'viewer' }, { actor: asUser(users.owner), orgId: orgA });
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

  it("never resolves types or casts from the caller's temporary schema inside definer functions", async () => {
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
      { actor: asUser(users.owner), orgId: orgA, idempotencyKey: approvalRequest },
    );
    const replay = await runtime.execute(
      'kernel.proposal.approve',
      { id: proposalId, revision: detail.revision, lineAccounts: [{ lineNo: 1, debitAccount: '6422' }] },
      { actor: asUser(users.owner), orgId: orgA, idempotencyKey: approvalRequest },
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
    const asOwner = { actor: asUser(users.owner), orgId: orgA };
    await runtime.execute('kernel.member.add', { email: 'plain-member@example.com', role: 'member' }, asOwner);
    await runtime.execute('kernel.member.add', { email: 'approver@example.com', role: 'admin' }, asOwner);
    const proposal = await propose(variant('1238'));

    await expect(runtime.execute('kernel.proposal.approve', proposal, { actor: asUser(member), orgId: orgA })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      status: 403,
    });
    await expect(runtime.execute('kernel.proposal.approve', proposal, { actor: asUser(approver), orgId: orgA })).resolves.toMatchObject({
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

  it('reads the assurance level from every token, not from the identity cache', async () => {
    const secret = 'test-only-jwt-secret-for-aal-0123456789';
    const authenticate = createAuthenticator(loadConfig({ DATABASE_URL: appUrl, AUTH_JWT_SECRET: secret }), db);
    const bearer = async (claims: Record<string, unknown>) =>
      `Bearer ${await new SignJWT({ email: 'mfa@example.com', role: 'authenticated', ...claims })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject('mfa-user')
        .setAudience('authenticated')
        .setExpirationTime('5m')
        .sign(new TextEncoder().encode(secret))}`;

    const stepUp = await authenticate(await bearer({ aal: 'aal2' }));
    expect(stepUp.aal).toBe('aal2');
    await expect(authenticate(await bearer({ aal: 'aal1' }))).resolves.toEqual({ ...stepUp, aal: 'aal1' });
    await expect(authenticate(await bearer({}))).resolves.toEqual({ ...stepUp, aal: 'aal1' });
    expect(actorOf(stepUp)).toEqual({ type: 'user', userId: stepUp.userId, aal: 'aal2' });
  });

  // External-tenant gate T5: system context is the worker's alone.
  it('lets only the worker login role enter system context (EXECUTE matrix)', async () => {
    const functions = [
      'crove_kernel.enter_system_context(uuid)',
      'crove_kernel.enter_context(uuid,uuid)',
      'crove_kernel.org_by_inbound_token(text)',
      'crove_kernel.inbound_enqueue(text,bigint,text)',
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
      'crove_kernel.inbound_enqueue(text,bigint,text)': ['crove_app'],
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
    await expect(assertSystemContextAccess(pool, 'granted')).rejects.toThrow(/cannot enter system context/);
    await expect(assertSystemContextAccess(workerPool, 'denied')).rejects.toThrow(/can enter system context/);
  });

  it('files a forwarded e-invoice through the worker: the API only stores and enqueues it', { timeout: 90_000 }, async () => {
    const inboundSecret = 'test-only-inbound-secret-0123456789abcdef';
    const config = loadConfig({
      DATABASE_URL: appUrl,
      AUTH_JWT_SECRET: 'test-only-jwt-secret-for-inbound-0123456789',
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
    const deliver = (secret: string) =>
      app.request('/api/inbound/email', {
        method: 'POST',
        headers: { authorization: `Bearer ${secret}`, 'content-type': 'message/rfc822', 'x-crove-recipient': `${token}@in.test` },
        body: mime,
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
    expect(await pending()).toBe(1);
    expect(await count('SELECT count(*) AS n FROM crove_kernel.inbound_message WHERE org_id = $1', [orgA])).toBe(0);

    await migrateJobs(adminUrl);
    const stop = await startWorker({ connectionString: workerUrl, workerDb, runtime: workerRuntime, store, extractor: null, inboundDomain: 'in.test' });
    try {
      await until(async () => (await emailProposals()) === 1);
      expect(await pending()).toBe(0);
      expect(await receiveAudits()).toBe(1);
      const inbox = await runtime.query<Array<{ title: string; total: string | null }>>('kernel.inbox.list', {}, { actor: asUser(users.owner), orgId: orgA });
      expect(inbox.some((p) => p.total === '1980000')).toBe(true);

      // The same message delivered again later is recorded once (idempotent on Message-ID).
      expect((await deliver(inboundSecret)).status).toBe(202);
      await until(async () => (await receiveAudits()) === 2);
      expect(await count(`SELECT count(*) AS n FROM crove_kernel.inbound_message WHERE org_id = $1 AND message_id LIKE '%hd-1240@vendor.example%'`, [orgA])).toBe(1);
      expect(await emailProposals()).toBe(1);
    } finally {
      await stop();
    }
  });
});
