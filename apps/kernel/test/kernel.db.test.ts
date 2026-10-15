// Integration tests against a real PostgreSQL 17. Set CROVE_TEST_ADMIN_URL to a superuser URL
// (CI uses a service container); each run creates and drops its own database.
// Security, tenancy, authorization and ledger invariants live in test/invariant/ (the invariant suite,
// which CI runs from the base branch on protected-path PRs). This file keeps the product flows.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sql, type Transaction } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, createPool, type Database, type Db } from '@crove/db';
import type { ExtractClient } from '@crove/extract-contract';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, createOrgCommand, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { DomainError, Runtime, fileKey, type CommandDef, inboundKey, newInboundBlobId, sha256Hex, type BlobStore } from '@crove/kernel-runtime';
import { extractAndPropose, financeCommands, financeQueries, recordExtractionFailure } from '@crove/mod-finance';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { processInboundEmail } from '../src/inbound.ts';
import { migrateJobs, startWorker } from '../src/worker.ts';
import { startExtractService } from './extract-service.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const FIXTURE = readFileSync(new URL('../../extract/test/fixtures/einvoice-basic.xml', import.meta.url));

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
  // The real crove-extract service on a random port: worker code parses through HTTP and the sandbox.
  let extract: ExtractClient;
  let stopExtract: (() => Promise<void>) | undefined;
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

  // Members join by accepting an invite (issue #35): the inviter invites the email, the user signed in with it accepts.
  async function join(orgId: string, inviter: string, userId: string, email: string, role: 'admin' | 'member' | 'viewer') {
    const { acceptPath } = await runtime.execute<{ acceptPath: string }>('kernel.member.invite.create', { email, role }, { actor: asMfa(inviter), orgId });
    await runtime.executeOrgless('kernel.member.invite.accept', { token: acceptPath.split('#')[1] }, { actor: asUser(userId) });
  }

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
    const { proposalId } = await extractAndPropose({ runtime: workerRuntime, store, extractor: null, extract, today: () => '2026-10-13' }, orgA, fileId);
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
    ({ client: extract, stop: stopExtract } = await startExtractService());
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
    await join(orgA, users.owner, users.viewer, 'viewer@example.com', 'viewer');
  });

  afterAll(async () => {
    await stopExtract?.();
    await pool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    const admin = new pg.Client({ connectionString: ADMIN });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  });

  // A runtime whose first transaction (the command) is untouched and whose later ones (the refusal audit) first
  // run `before` inside the transaction. Counts the transactions.
  function refusalAuditHook(before: (trx: Transaction<Database>) => Promise<void>, extra: CommandDef<any, any>[] = []) {
    const seen = { transactions: 0 };
    const hooked = new Proxy(db, {
      get(target, prop) {
        if (prop !== 'transaction') return Reflect.get(target, prop, target);
        return () => {
          const builder = target.transaction();
          seen.transactions += 1;
          if (seen.transactions === 1) return builder;
          return {
            execute: <T,>(fn: (trx: Transaction<Database>) => Promise<T>) =>
              builder.execute(async (trx) => {
                await before(trx);
                return fn(trx);
              }),
          };
        };
      },
    }) as Db;
    const hookedRuntime = new Runtime(hooked).register({
      commands: [...kernelCommands, ...extra],
      queries: kernelQueries({ inboundDomain: 'in.test' }),
    });
    return { runtime: hookedRuntime, seen };
  }

  const auditRows = (orgId: string, command: string, outcome: string) =>
    withAdmin(async (admin) => {
      const { rows } = await admin.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM crove_kernel.audit_event WHERE org_id = $1 AND command = $2 AND outcome = $3`,
        [orgId, command, outcome],
      );
      return rows[0]?.n;
    });

  async function captureErrors<T>(fn: (logged: ReturnType<typeof vi.spyOn>) => Promise<T>): Promise<T> {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      return await fn(logged);
    } finally {
      logged.mockRestore();
    }
  }

  it('logs a refusal whose audit row cannot be written and still returns the refusal (#102)', async () => {
    const tag = randomUUID().slice(0, 8);
    const founder = await upsertIdentity(db, { issuer: 'test', subject: `audit-loss-${tag}`, email: `audit-loss-${tag}@example.com`, name: null });
    const key = randomUUID();
    const created = await createOrg(runtime, asUser(founder), `Mất audit ${tag}`, key);
    // The refusal audit runs read-only, so its INSERT fails in the database (SQLSTATE 25006).
    const broken = refusalAuditHook(async (trx) => {
      await sql`SET TRANSACTION READ ONLY`.execute(trx);
    });

    await captureErrors(async (logged) => {
      // A refused replay into the existing org: the caller still gets the original 422, not a 500.
      await expect(createOrg(broken.runtime, asUser(founder), `Tên khác ${tag}`, key)).rejects.toMatchObject({
        code: 'IDEMPOTENCY_MISMATCH',
        status: 422,
      });
      expect(broken.seen.transactions).toBe(2);
      expect(await auditRows(created.orgId, 'kernel.org.create', 'failed')).toBe(0);
      // The lost row is logged with ids and codes only, after the refusal count (#162) that failed the same way.
      expect(logged).toHaveBeenCalledTimes(2);
      expect(logged).toHaveBeenNthCalledWith(1, '[execute kernel.org.create] REFUSAL_TALLY_FAILED', {
        orgId: created.orgId,
        actorType: 'user',
        actorId: founder,
        refusal: 'IDEMPOTENCY_MISMATCH',
        sqlState: '25006',
      });
      expect(logged).toHaveBeenCalledWith('[execute kernel.org.create] AUDIT_WRITE_FAILED', {
        orgId: created.orgId,
        commandId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        actorType: 'user',
        actorId: founder,
        outcome: 'failed',
        refusal: 'IDEMPOTENCY_MISMATCH',
        error: 'INTERNAL',
        sqlState: '25006',
      });
      expect(JSON.stringify(logged.mock.calls)).not.toContain(`Tên khác ${tag}`);

      // With a working database the same refusal is audited and nothing is logged.
      logged.mockClear();
      await expect(createOrg(runtime, asUser(founder), `Tên khác ${tag}`, key)).rejects.toMatchObject({ code: 'IDEMPOTENCY_MISMATCH' });
      expect(await auditRows(created.orgId, 'kernel.org.create', 'failed')).toBe(1);
      expect(logged).not.toHaveBeenCalled();
    });
  });

  it('logs the lost refusal audit of an actor removed from the org before it is written (#102)', async () => {
    const tag = randomUUID().slice(0, 8);
    const owner = await upsertIdentity(db, { issuer: 'test', subject: `rm-owner-${tag}`, email: `rm-owner-${tag}@example.com`, name: null });
    const member = await upsertIdentity(db, { issuer: 'test', subject: `rm-member-${tag}`, email: `rm-member-${tag}@example.com`, name: null });
    const { orgId } = await createOrg(runtime, asUser(owner), `Xóa thành viên ${tag}`);
    await join(orgId, owner, member, `rm-member-${tag}@example.com`, 'member');
    // The member is removed (committed) after the refused command rolled back and before its audit is written.
    const removed = refusalAuditHook(async () => {
      await withAdmin((admin) => admin.query('DELETE FROM crove_kernel.tenant_member WHERE org_id = $1 AND user_id = $2', [orgId, member]));
    });

    await captureErrors(async (logged) => {
      await expect(
        removed.runtime.execute('kernel.member.invite.create', { email: `x-${tag}@example.com`, role: 'member' }, { actor: asMfa(member), orgId }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
      expect(removed.seen.transactions).toBe(2);
      expect(await auditRows(orgId, 'kernel.member.invite.create', 'denied')).toBe(0);
      expect(logged).toHaveBeenCalledTimes(1);
      expect(logged).toHaveBeenCalledWith('[execute kernel.member.invite.create] AUDIT_WRITE_FAILED', {
        orgId,
        commandId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        actorType: 'user',
        actorId: member,
        outcome: 'denied',
        refusal: 'FORBIDDEN',
        error: 'NOT_A_MEMBER',
        sqlState: '42501',
      });
    });
  });

  it('writes no refusal audit and logs nothing when a new org rolls back with its failed command (#102)', async () => {
    const tag = randomUUID().slice(0, 8);
    const founder = await upsertIdentity(db, { issuer: 'test', subject: `rollback-${tag}`, email: `rollback-${tag}@example.com`, name: null });
    // kernel.org.create's definer and checks, with a handler that refuses after the org exists in the transaction.
    const failing: CommandDef<any, any> = {
      ...createOrgCommand,
      name: 'test.org.create_then_fail',
      handler: async () => {
        throw new DomainError('INVALID', 422, 'refused after creation');
      },
    };
    const hooked = refusalAuditHook(async () => {}, [failing]);

    await captureErrors(async (logged) => {
      await expect(
        hooked.runtime.executeOrgless('test.org.create_then_fail', { name: `Hoàn tác ${tag}` }, { actor: asUser(founder) }),
      ).rejects.toMatchObject({ code: 'INVALID', status: 422 });
      // No refusal-audit transaction was opened: the org rolled back, there is nothing to audit in.
      expect(hooked.seen.transactions).toBe(1);
      expect(logged).not.toHaveBeenCalled();
    });
    const left = await withAdmin(async (admin) => (await admin.query('SELECT 1 FROM crove_kernel.tenant WHERE created_by = $1', [founder])).rows.length);
    expect(left).toBe(0);
  });

  // A session-level lock on the re-entry guard's key (T10) left on a pooled connection, by a caller bug or an attack,
  // makes every enter_context on that backend raise CONTEXT_REENTRY. The pool recovers either way (#117), and the
  // runtime logs the request that hit it on its own alert line (#105).
  it('alerts on CONTEXT_REENTRY and recovers a pooled connection left holding the context lock (#105)', async () => {
    const leak = async (target: pg.Pool) => {
      const c = await target.connect();
      const { rows } = await c.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      await c.query('SELECT pg_advisory_lock(1129467734, pg_backend_pid())');
      c.release();
      return rows[0]?.pid;
    };
    const backendOf = async (target: pg.Pool) => (await target.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
    const getOrg = (r: Runtime) => r.query<{ orgId: string }>('kernel.org.get', {}, { actor: asUser(users.owner), orgId: orgA });

    for (const resetOnRelease of [true, false]) {
      const single = createPool({ connectionString: appUrl, max: 1, resetOnRelease });
      const r = new Runtime(createDb(single)).register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: 'in.test' }) });
      try {
        await captureErrors(async (logged) => {
          const backend = await leak(single);
          if (resetOnRelease) {
            // The reset on release dropped the lock: the same backend serves the next request, nothing to alert on.
            await expect(getOrg(r)).resolves.toMatchObject({ orgId: orgA });
            expect(await backendOf(single)).toBe(backend);
            expect(logged).not.toHaveBeenCalled();
            return;
          }
          // Without the reset the next request on that backend fails closed, as a 500 that names nothing.
          await expect(getOrg(r)).rejects.toMatchObject({ code: 'INTERNAL', status: 500 });
          // The connection is released (and closed) before the runtime sees the error, so the db line comes first.
          expect(logged.mock.calls).toEqual([
            ['[db] closing a pooled connection after CONTEXT_REENTRY'],
            ['[alert] CONTEXT_REENTRY', { where: 'query kernel.org.get', orgId: orgA, actorType: 'user', actorId: users.owner }],
          ]);
          // The tainted connection was closed, so the next request gets a new backend and succeeds.
          await expect(getOrg(r)).resolves.toMatchObject({ orgId: orgA });
          expect(await backendOf(single)).not.toBe(backend);
          expect(logged).toHaveBeenCalledTimes(2);
        });
      } finally {
        await single.end();
      }
    }
  });

  it('turns an e-invoice into a proposal, and records it once on approval', async () => {
    const { fileId, duplicate } = await ingest(orgA, users.owner, FIXTURE);
    expect(duplicate).toBe(false);
    const again = await ingest(orgA, users.owner, FIXTURE);
    expect(again).toEqual({ fileId, duplicate: true });

    const { proposalId } = await extractAndPropose({ runtime: workerRuntime, store, extractor: null, extract, today: () => '2026-10-13' }, orgA, fileId);
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
    await join(orgA, users.owner, admin, 'admin@example.com', 'admin');
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
    const stop = await startWorker({ connectionString: workerUrl, workerDb, runtime: workerRuntime, store, extractor: null, extract, inboundDomain: 'in.test' });
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
      await expect(processInboundEmail({ runtime: workerRuntime, store, domain: 'in.test', extract }, tampered)).rejects.toMatchObject({
        code: 'INBOUND_BLOB_MISMATCH',
      });
    }
  });
});
