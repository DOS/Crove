// Integration tests against a real PostgreSQL 17. Set CROVE_TEST_ADMIN_URL to a superuser URL
// (CI uses a service container); each run creates and drops its own database.
// Security, tenancy, authorization and ledger invariants live in test/invariant/ (the invariant suite,
// which CI runs from the base branch on protected-path PRs). This file keeps the product flows.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { DomainError, Runtime, fileKey, inboundKey, newInboundBlobId, sha256Hex, type BlobStore } from '@crove/kernel-runtime';
import { extractAndPropose, financeCommands, financeQueries, recordExtractionFailure } from '@crove/mod-finance';
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
    await createOrg(runtime, asUser(users.outsider), 'Org B');
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

  it('records an invoice with failed checks only after explicit confirmation, and never a foreign-currency one', async () => {
    // The owner uploads these and org A gets an admin, so four-eyes (P10) makes the admin approve.
    const admin = await upsertIdentity(db, { issuer: 'test', subject: 'admin', email: 'admin@example.com', name: null });
    await runtime.execute('kernel.member.add', { email: 'admin@example.com', role: 'admin' }, { actor: asMfa(users.owner), orgId: orgA });
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
});
