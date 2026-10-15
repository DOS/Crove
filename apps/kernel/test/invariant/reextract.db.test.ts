// Invariant suite: re-extraction of a file (issue #40). Who may ask for it, that it never touches a decided
// proposal, that an approval of an earlier revision never carries over to the new one, that concurrent requests
// and races with the first extraction or an approval never produce two current versions, and that a finished
// extraction version is never overwritten. Self-contained like the rest of test/invariant/.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run creates and drops its own database.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { InvoiceExtractor } from '@crove/agent';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createExtractApp } from '@crove/extract';
import { createExtractClient } from '@crove/extract-contract';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime, fileKey, sha256Hex, type BlobStore } from '@crove/kernel-runtime';
import type { ParsedInvoice } from '@crove/l10n-vn';
import { extractAndPropose, financeCommands, financeQueries } from '@crove/mod-finance';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const FIXTURE = readFileSync(new URL('./fixtures/einvoice-basic.xml', import.meta.url));
const extractApp = createExtractApp({ concurrency: 2 });
const extract = createExtractClient({ url: 'http://crove-extract.test', fetch: async (input, init) => extractApp.fetch(new Request(input, init)) });

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
}

interface Detail {
  revision: number;
  status: string;
  payload: { lines: Array<{ lineNo: number; description: string; debitAccount: string }>; checks: Array<{ id: string }> } | null;
  canApprove: boolean;
  canEdit: boolean;
  canReject: boolean;
  canReextract: boolean;
  extraction: { version: number; status: string; inFlight: boolean; proposalVersion: number | null } | null;
}

const suite = ADMIN ? describe : describe.skip;

suite('re-extraction invariants on PostgreSQL (issue #40)', () => {
  const dbName = `crove_test_reex_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl: string;
  let pool: pg.Pool;
  let db: Db;
  let runtime: Runtime;
  let workerPool: pg.Pool;
  let workerRuntime: Runtime;
  const store = new MemoryStore();
  const users = { owner: '', admin: '', member: '', viewer: '', outsider: '' };
  let orgA = '';
  let orgB = '';
  let base: ParsedInvoice;
  let invoiceNo = 5000;
  // What the fake AI reads from the next image: an invoice, or null (not an invoice).
  const reads: Array<ParsedInvoice | null> = [];
  const ai = {
    fromText: async () => reads.shift() ?? null,
    fromImage: async () => reads.shift() ?? null,
  } as unknown as InvoiceExtractor;

  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const asMfa = (userId: string) => ({
    type: 'user' as const,
    userId,
    aal: 'aal2' as const,
    sessionId: '0f6c3a52-8d3b-4c1e-9a77-5b2f0e9d1c00',
    mfaAt: Math.floor(Date.now() / 1000),
  });
  const deps = () => ({ runtime: workerRuntime, store, extractor: ai, extract, today: () => '2026-10-13' });

  async function join(orgId: string, inviter: string, userId: string, email: string, role: 'admin' | 'member' | 'viewer') {
    const { acceptPath } = await runtime.execute<{ acceptPath: string }>('kernel.member.invite.create', { email, role }, { actor: asMfa(inviter), orgId });
    await runtime.executeOrgless('kernel.member.invite.accept', { token: acceptPath.split('#')[1] }, { actor: asUser(userId) });
  }

  // A fresh invoice (its own number, so no duplicate check fires across tests), with a line description to tell
  // readings apart.
  function invoice(number: string, description = 'Cước dịch vụ internet'): ParsedInvoice {
    return { ...base, number, lines: base.lines.map((l) => (l.lineNo === 1 ? { ...l, description } : l)) };
  }

  // An image the owner uploads (images are read by the AI only, so each read can differ).
  async function upload(): Promise<string> {
    const bytes = randomBytes(64);
    const sha256 = sha256Hex(bytes);
    const storageKey = fileKey(orgA, sha256);
    await store.put(storageKey, bytes);
    const { fileId } = await runtime.execute<{ fileId: string }>(
      'kernel.file.ingest',
      { filename: 'hd.png', contentType: 'image/png', sizeBytes: bytes.byteLength, sha256, storageKey, source: 'upload' },
      { actor: asUser(users.owner), orgId: orgA },
    );
    return fileId;
  }

  async function proposed(description = 'Cước dịch vụ internet') {
    const number = String(invoiceNo++);
    const fileId = await upload();
    reads.push(invoice(number, description));
    const { proposalId } = await extractAndPropose(deps(), orgA, fileId);
    if (!proposalId) throw new Error('no proposal');
    return { fileId, proposalId, number };
  }

  const reextract = (fileId: string, userId = users.owner, idempotencyKey?: string) =>
    runtime.execute<{ fileId: string; version: number }>('kernel.file.reextract', { fileId }, { actor: asUser(userId), orgId: orgA, ...(idempotencyKey ? { idempotencyKey } : {}) });
  const get = (id: string, userId = users.owner) => runtime.query<Detail>('kernel.inbox.get', { id }, { actor: asUser(userId), orgId: orgA });

  async function withAdmin<T>(fn: (admin: pg.Client) => Promise<T>): Promise<T> {
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      return await fn(admin);
    } finally {
      await admin.end();
    }
  }

  const versions = (fileId: string) =>
    withAdmin(async (admin) => {
      const { rows } = await admin.query<{ version: number; status: string; result: unknown; completed_at: Date | null }>(
        'SELECT version, status, result, completed_at FROM crove_kernel.extraction WHERE file_id = $1 ORDER BY version',
        [fileId],
      );
      return rows;
    });

  beforeAll(async () => {
    const url = new URL(ADMIN as string);
    const admin = new pg.Client({ connectionString: ADMIN });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();
    url.pathname = `/${dbName}`;
    adminUrl = url.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    const loginUrl = (username: string, password: string) => {
      const u = new URL(adminUrl);
      u.username = username;
      u.password = password;
      return u.toString();
    };
    const register = (target: Db) =>
      new Runtime(target).register({
        commands: [...kernelCommands, ...financeCommands],
        queries: [...kernelQueries({ inboundDomain: 'in.test' }), ...financeQueries],
      });
    pool = createPool({ connectionString: loginUrl('crove_app', 'test-app-pw'), max: 6 });
    db = createDb(pool);
    runtime = register(db);
    workerPool = createPool({ connectionString: loginUrl('crove_worker', 'test-worker-pw'), max: 6 });
    workerRuntime = register(createDb(workerPool));
    for (const name of Object.keys(users) as Array<keyof typeof users>) {
      users[name] = await upsertIdentity(db, { issuer: 'test', subject: `reex-${name}`, email: `reex-${name}@example.com`, name: null });
    }
    orgA = (await createOrg(runtime, asUser(users.owner), 'Org A')).orgId;
    orgB = (await createOrg(runtime, asUser(users.outsider), 'Org B')).orgId;
    await join(orgA, users.owner, users.admin, 'reex-admin@example.com', 'admin');
    await join(orgA, users.owner, users.member, 'reex-member@example.com', 'member');
    await join(orgA, users.owner, users.viewer, 'reex-viewer@example.com', 'viewer');
    const parsed = await extract.extract('einvoice_xml', FIXTURE);
    if (!parsed.ok) throw new Error('fixture did not parse');
    base = parsed.invoice;
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

  it('lets owners, admins and members ask for a re-read; refuses viewers, outsiders, other orgs and system actors', async () => {
    const { fileId } = await proposed();
    await expect(reextract(fileId, users.viewer)).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    await expect(reextract(fileId, users.outsider)).rejects.toMatchObject({ code: 'NOT_A_MEMBER', status: 403 });
    // The file id of org A, asked in org B's context, is not there.
    await expect(
      runtime.execute('kernel.file.reextract', { fileId }, { actor: asUser(users.outsider), orgId: orgB }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
    // The worker never starts a re-read on its own.
    await expect(
      workerRuntime.execute('kernel.file.reextract', { fileId }, { actor: { type: 'system', component: 'test' }, orgId: orgA }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    expect((await versions(fileId)).map((v) => v.status)).toEqual(['done']);

    await expect(reextract(fileId, users.member)).resolves.toEqual({ fileId, version: 2 });
    const audit = await withAdmin(async (admin) => {
      const { rows } = await admin.query<{ actor_id: string; outcome: string; target_id: string }>(
        `SELECT actor_id, outcome, target_id FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.file.reextract' ORDER BY occurred_at`,
        [orgA],
      );
      return rows;
    });
    expect(audit).toEqual([
      { actor_id: users.viewer, outcome: 'denied', target_id: fileId },
      // The system actor's refusal.
      { actor_id: null, outcome: 'denied', target_id: fileId },
      { actor_id: users.member, outcome: 'ok', target_id: fileId },
    ]);
    // Through the outbox, never parsed in the API.
    const events = await withAdmin(async (admin) => {
      const { rows } = await admin.query<{ payload: { fileId: string; version: number } }>(
        `SELECT payload FROM crove_kernel.outbox_event WHERE org_id = $1 AND type = 'kernel.file.reextract_requested'`,
        [orgA],
      );
      return rows.map((r) => r.payload);
    });
    expect(events).toContainEqual({ fileId, version: 2 });
    for (const role of ['admin', 'owner'] as const) {
      await withAdmin((admin) => admin.query(`UPDATE crove_kernel.extraction SET status = 'failed', completed_at = now() WHERE file_id = $1 AND status = 'pending'`, [fileId]));
      await expect(reextract(fileId, users[role])).resolves.toMatchObject({ fileId });
    }
  });

  it('never re-reads a booked invoice, and never changes a decided proposal', async () => {
    const { fileId, proposalId } = await proposed();
    const before = await get(proposalId);
    await runtime.execute('kernel.proposal.approve', { id: proposalId, revision: before.revision }, { actor: asMfa(users.admin), orgId: orgA });
    await expect(reextract(fileId)).rejects.toMatchObject({ code: 'PROPOSAL_DECIDED', status: 409 });
    expect(await versions(fileId)).toHaveLength(1);
    const after = await get(proposalId);
    expect(after).toMatchObject({ status: 'executed', revision: before.revision, canReextract: false });

    // A rejected proposal stays rejected: a re-read becomes a new proposal.
    const second = await proposed('Lần đọc đầu');
    await runtime.execute('kernel.proposal.reject', { id: second.proposalId }, { actor: asUser(users.owner), orgId: orgA });
    const { version } = await reextract(second.fileId);
    reads.push(invoice(second.number, 'Lần đọc thứ hai'));
    const { proposalId: replacement } = await extractAndPropose(deps(), orgA, second.fileId, version);
    expect(replacement).not.toBe(second.proposalId);
    expect(await get(second.proposalId)).toMatchObject({ status: 'rejected', revision: 1 });
    expect(await get(replacement as string)).toMatchObject({ status: 'pending', revision: 1 });
    expect((await get(second.proposalId)).payload?.lines[0]?.description).toBe('Lần đọc đầu');
  });

  it('turns a re-read into a new revision, so an approval of the earlier revision never carries over', async () => {
    const { fileId, proposalId, number } = await proposed('Bản đọc 1');
    const first = await get(proposalId);
    const line1 = first.payload?.lines[0];
    if (!line1) throw new Error('no line');
    // An edit (revision 2) picks another account; the re-read (revision 3) replaces the content again.
    const other = line1.debitAccount === '6422' ? '6421' : '6422';
    await runtime.execute('kernel.proposal.edit', { id: proposalId, revision: 1, lineAccounts: [{ lineNo: 1, debitAccount: other }] }, { actor: asUser(users.member), orgId: orgA });
    const { version } = await reextract(fileId, users.member);

    // While the re-read is in flight nobody decides on the proposal.
    for (const [name, input] of [
      ['kernel.proposal.approve', { id: proposalId, revision: 2 }],
      ['kernel.proposal.edit', { id: proposalId, revision: 2, lineAccounts: [{ lineNo: 1, debitAccount: line1.debitAccount }] }],
      ['kernel.proposal.reject', { id: proposalId }],
    ] as const) {
      await expect(runtime.execute(name, input, { actor: asMfa(users.admin), orgId: orgA })).rejects.toMatchObject({ code: 'EXTRACTION_PENDING', status: 409 });
    }
    expect(await get(proposalId, users.admin)).toMatchObject({ canApprove: false, canEdit: false, canReject: false, canReextract: false });

    reads.push(invoice(number, 'Bản đọc 2'));
    await extractAndPropose(deps(), orgA, fileId, version);
    const revised = await get(proposalId, users.admin);
    expect(revised).toMatchObject({ revision: 3, status: 'pending', extraction: { version: 2, status: 'done', proposalVersion: 2, inFlight: false } });
    expect(revised.payload?.lines[0]?.description).toBe('Bản đọc 2');
    // The re-read is its own reading: the line accounts are the module's defaults again, not the edit's.
    expect(revised.payload?.lines[0]?.debitAccount).toBe(line1.debitAccount);
    // Its own earlier revision is not a duplicate of it.
    expect(revised.payload?.checks.some((c) => c.id === 'duplicate')).toBe(false);

    const asAdmin = { actor: asMfa(users.admin), orgId: orgA };
    await expect(runtime.execute('kernel.proposal.approve', { id: proposalId, revision: 2 }, asAdmin)).rejects.toMatchObject({ code: 'STALE_REVISION' });
    // The accounts the approver saw on revision 2 are not what revision 3 says.
    await expect(
      runtime.execute('kernel.proposal.approve', { id: proposalId, revision: 3, lineAccounts: [{ lineNo: 1, debitAccount: other }] }, asAdmin),
    ).rejects.toMatchObject({ code: 'CONTENT_CHANGED' });

    // Authors accumulate: the uploader, the editor and the member who asked for the re-read. The admin is none of them.
    const authors = await withAdmin(async (admin) => {
      const { rows } = await admin.query<{ authors: Array<{ type: string; id?: string }> }>('SELECT authors FROM crove_kernel.proposal WHERE id = $1', [proposalId]);
      return rows[0]?.authors.filter((a) => a.type === 'user').map((a) => a.id);
    });
    expect(new Set(authors)).toEqual(new Set([users.owner, users.member]));
    await expect(runtime.execute('kernel.proposal.approve', { id: proposalId, revision: 3 }, asAdmin)).resolves.toMatchObject({ journalEntryId: expect.any(String) });
  });

  it('makes the user who asked for a re-read an author of the new revision (P10)', async () => {
    const { fileId, proposalId, number } = await proposed();
    const { version } = await reextract(fileId, users.admin);
    reads.push(invoice(number, 'Đọc lại bởi quản trị'));
    await extractAndPropose(deps(), orgA, fileId, version);
    expect(await get(proposalId, users.admin)).toMatchObject({ revision: 2, canApprove: false });
    await expect(runtime.execute('kernel.proposal.approve', { id: proposalId, revision: 2 }, { actor: asMfa(users.admin), orgId: orgA })).rejects.toMatchObject({
      code: 'FOUR_EYES_REQUIRED',
    });
  });

  it('keeps every version: a finished one is never overwritten, a failed re-read leaves the proposal as it was', async () => {
    const { fileId, proposalId } = await proposed('Giữ nguyên');
    const { version } = await reextract(fileId);
    reads.push(null);
    await extractAndPropose(deps(), orgA, fileId, version);
    const rows = await versions(fileId);
    expect(rows.map((r) => [r.version, r.status])).toEqual([
      [1, 'done'],
      [2, 'failed'],
    ]);
    expect(rows.every((r) => r.completed_at !== null)).toBe(true);
    const detail = await get(proposalId);
    expect(detail).toMatchObject({ revision: 1, extraction: { version: 2, status: 'failed', proposalVersion: 1 }, canReextract: true });
    expect(detail.payload?.lines[0]?.description).toBe('Giữ nguyên');

    // A late or repeated job for a finished version changes nothing.
    reads.push(invoice('9999', 'Muộn'));
    await expect(extractAndPropose(deps(), orgA, fileId, version)).resolves.toEqual({ proposalId: null });
    await expect(extractAndPropose(deps(), orgA, fileId)).resolves.toEqual({ proposalId: null });
    expect(await versions(fileId)).toEqual(rows);
    reads.length = 0;

    // Not even the runtime roles can rewrite a finished version or delete one.
    const asApp = (statement: string) =>
      db.transaction().execute(async (trx) => {
        await sql`SELECT crove_kernel.enter_context(${users.owner}::uuid, ${orgA}::uuid)`.execute(trx);
        await sql.raw(statement).execute(trx);
      });
    await expect(asApp(`UPDATE crove_kernel.extraction SET result = '{}'::jsonb WHERE file_id = '${fileId}' AND version = 1`)).rejects.toThrow(/EXTRACTION_IMMUTABLE/);
    await expect(asApp(`UPDATE crove_kernel.extraction SET status = 'pending', completed_at = NULL WHERE file_id = '${fileId}'`)).rejects.toThrow(/EXTRACTION_IMMUTABLE/);
    await expect(asApp(`UPDATE crove_kernel.extraction SET version = 7 WHERE file_id = '${fileId}'`)).rejects.toThrow(/permission denied/);
    await expect(asApp(`DELETE FROM crove_kernel.extraction WHERE file_id = '${fileId}'`)).rejects.toThrow(/permission denied/);
    await expect(
      asApp(`INSERT INTO crove_kernel.extraction (org_id, file_id, version, status, method) VALUES ('${orgA}', '${fileId}', 1, 'done', 'image_ai')`),
    ).rejects.toThrow(/extraction_version_uq/);
    expect(await versions(fileId)).toEqual(rows);
  });

  it('runs one re-read at a time: concurrent requests leave one pending version', async () => {
    const { fileId } = await proposed();
    const results = await Promise.allSettled([reextract(fileId), reextract(fileId, users.admin), reextract(fileId, users.member)]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    expect(ok).toHaveLength(1);
    for (const r of results) {
      if (r.status === 'rejected') expect(r.reason).toMatchObject({ code: 'EXTRACTION_PENDING', status: 409 });
    }
    expect((await versions(fileId)).map((v) => [v.version, v.status])).toEqual([
      [1, 'done'],
      [2, 'pending'],
    ]);
    // A repeated request is refused too, and a retry with the same idempotency key returns the first answer.
    await expect(reextract(fileId)).rejects.toMatchObject({ code: 'EXTRACTION_PENDING' });
    const second = await proposed();
    const key = '0192a7a0-0000-7000-8000-00000000c0de';
    const answer = await reextract(second.fileId, users.owner, key);
    await expect(reextract(second.fileId, users.owner, key)).resolves.toEqual(answer);
    expect(await versions(second.fileId)).toHaveLength(2);
  });

  it('never lets a re-read and an approval both win', async () => {
    for (let i = 0; i < 4; i++) {
      const { fileId, proposalId } = await proposed();
      const [approved, requested] = await Promise.allSettled([
        runtime.execute('kernel.proposal.approve', { id: proposalId, revision: 1 }, { actor: asMfa(users.admin), orgId: orgA }),
        reextract(fileId),
      ]);
      const rows = await versions(fileId);
      const detail = await get(proposalId);
      if (approved.status === 'fulfilled') {
        expect(requested).toMatchObject({ status: 'rejected', reason: { code: 'PROPOSAL_DECIDED' } });
        expect(rows.map((r) => r.status)).toEqual(['done']);
        expect(detail.status).toBe('executed');
      } else {
        expect(approved.reason).toMatchObject({ code: 'EXTRACTION_PENDING' });
        expect(requested.status).toBe('fulfilled');
        expect(rows.map((r) => r.status)).toEqual(['done', 'pending']);
        expect(detail.status).toBe('pending');
      }
    }
  });

  it('never creates a second version while the first extraction is running', async () => {
    for (let i = 0; i < 4; i++) {
      const fileId = await upload();
      reads.push(invoice(String(invoiceNo++)));
      const [first, requested] = await Promise.allSettled([extractAndPropose(deps(), orgA, fileId), reextract(fileId)]);
      expect(first.status).toBe('fulfilled');
      const rows = await versions(fileId);
      if (requested.status === 'rejected') {
        expect(requested.reason).toMatchObject({ code: 'EXTRACTION_PENDING' });
        expect(rows.map((r) => [r.version, r.status])).toEqual([[1, 'done']]);
      } else {
        expect(rows.map((r) => [r.version, r.status])).toEqual([
          [1, 'done'],
          [2, 'pending'],
        ]);
      }
    }
    reads.length = 0;
  });

  it('replaces a lost (stale) re-read, and the lost job then changes nothing', async () => {
    const { fileId, proposalId, number } = await proposed('Trước khi mất');
    const lost = await reextract(fileId);
    // Age the pending run past the stale window (as the superuser, with triggers off for this session only).
    await withAdmin(async (admin) => {
      await admin.query(`SET session_replication_role = replica`);
      await admin.query(`UPDATE crove_kernel.extraction SET created_at = now() - interval '1 hour' WHERE file_id = $1 AND status = 'pending'`, [fileId]);
    });
    // A stale run no longer blocks decisions, and a new request closes it and takes the next number.
    expect(await get(proposalId, users.admin)).toMatchObject({ canEdit: true, canReextract: true, extraction: { inFlight: false } });
    const next = await reextract(fileId);
    expect(next.version).toBe(lost.version + 1);
    expect((await versions(fileId)).map((v) => [v.version, v.status])).toEqual([
      [1, 'done'],
      [2, 'failed'],
      [3, 'pending'],
    ]);
    reads.push(invoice(number, 'Job bị mất'));
    await expect(extractAndPropose(deps(), orgA, fileId, lost.version)).resolves.toEqual({ proposalId: null });
    reads.length = 0;
    expect((await get(proposalId)).payload?.lines[0]?.description).toBe('Trước khi mất');
  });
});
