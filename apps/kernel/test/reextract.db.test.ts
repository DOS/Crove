// Product flow of re-extraction (issue #40): a file read again through the worker (outbox -> pg-boss -> the
// extraction job) becomes a new extraction version and a new revision of its proposal; the Inbox file list follows
// the newest run. Security invariants of the same feature live in test/invariant/reextract.db.test.ts.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { InvoiceExtractor } from '@crove/agent';
import { createDb, createPool, type Db } from '@crove/db';
import type { ExtractClient } from '@crove/extract-contract';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { MAX_EXTRACTION_VERSIONS, createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime, fileKey, sha256Hex, type BlobStore } from '@crove/kernel-runtime';
import type { ParsedInvoice } from '@crove/l10n-vn';
import { extractAndPropose, financeCommands, financeQueries } from '@crove/mod-finance';
import { startWorker } from '../src/worker.ts';
import { inProcessExtract } from './extract-service.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const FIXTURE = readFileSync(new URL('../../extract/test/fixtures/einvoice-basic.xml', import.meta.url));

class MemoryStore implements BlobStore {
  private readonly blobs = new Map<string, Uint8Array>();
  // Memory has no object versions: the generation is the content address (ADR-0013).
  async put(key: string, bytes: Uint8Array) {
    this.blobs.set(key, bytes);
    return `content:${sha256Hex(bytes)}`;
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

interface FileStatus {
  id: string;
  status: string;
  error: string | null;
  proposalId: string | null;
  version: number | null;
  canReextract: boolean;
}

const suite = ADMIN ? describe : describe.skip;

suite('re-extraction on PostgreSQL (issue #40)', () => {
  const dbName = `crove_test_reexf_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl: string;
  let workerUrl: string;
  let pool: pg.Pool;
  let runtime: Runtime;
  let workerPool: pg.Pool;
  let workerDb: Db;
  let workerRuntime: Runtime;
  const store = new MemoryStore();
  let extract: ExtractClient;
  let owner = '';
  let viewer = '';
  let orgA = '';
  let base: ParsedInvoice;
  const reads: Array<ParsedInvoice | null> = [];
  const ai = {
    fromText: async () => reads.shift() ?? null,
    fromImage: async () => reads.shift() ?? null,
  } as unknown as InvoiceExtractor;

  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const asMfa = (userId: string) => ({ ...asUser(userId), aal: 'aal2' as const, sessionId: '0f6c3a52-8d3b-4c1e-9a77-5b2f0e9d1c00', mfaAt: Math.floor(Date.now() / 1000) });
  const invoice = (number: string, description: string): ParsedInvoice => ({
    ...base,
    number,
    lines: base.lines.map((l) => (l.lineNo === 1 ? { ...l, description } : l)),
  });

  async function upload(): Promise<string> {
    const bytes = randomBytes(64);
    const sha256 = sha256Hex(bytes);
    const storageKey = fileKey(orgA, sha256);
    const generation = await store.put(storageKey, bytes);
    const { fileId } = await runtime.execute<{ fileId: string }>(
      'kernel.file.ingest',
      { filename: 'hd.png', contentType: 'image/png', sizeBytes: bytes.byteLength, sha256, storageKey, generation, source: 'upload' },
      { actor: asUser(owner), orgId: orgA },
    );
    return fileId;
  }

  const recent = async (fileId: string, userId = owner) =>
    (await runtime.query<FileStatus[]>('kernel.files.recent', {}, { actor: asUser(userId), orgId: orgA })).find((f) => f.id === fileId);

  async function until(check: () => Promise<boolean>) {
    const deadline = Date.now() + 60_000;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error('timed out waiting for the worker');
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  beforeAll(async () => {
    extract = inProcessExtract();
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
    workerUrl = loginUrl('crove_worker', 'test-worker-pw');
    const register = (target: Db) =>
      new Runtime(target, { manifests: TEST_MANIFESTS }).register({
        commands: [...kernelCommands, ...financeCommands],
        queries: [...kernelQueries({ inboundDomain: 'in.test' }), ...financeQueries],
      });
    pool = createPool({ connectionString: loginUrl('crove_app', 'test-app-pw'), max: 4 });
    const db = createDb(pool);
    runtime = register(db);
    workerPool = createPool({ connectionString: workerUrl, max: 4 });
    workerDb = createDb(workerPool);
    workerRuntime = register(workerDb);
    owner = await upsertIdentity(db, { issuer: 'test', subject: 'reexf-owner', email: 'reexf-owner@example.com', name: null });
    viewer = await upsertIdentity(db, { issuer: 'test', subject: 'reexf-viewer', email: 'reexf-viewer@example.com', name: null });
    orgA = (await createOrg(runtime, asUser(owner), 'Org A')).orgId;
    const { acceptPath } = await runtime.execute<{ acceptPath: string }>(
      'kernel.member.invite.create',
      { email: 'reexf-viewer@example.com', role: 'viewer' },
      { actor: asMfa(owner), orgId: orgA },
    );
    await runtime.executeOrgless('kernel.member.invite.accept', { token: acceptPath.split('#')[1] }, { actor: asUser(viewer) });
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

  it('reads a file that failed again once it can be read, and the file list follows the newest run', async () => {
    const fileId = await upload();
    reads.push(null);
    await extractAndPropose({ runtime: workerRuntime, store, extractor: ai, extract }, orgA, fileId);
    expect(await recent(fileId)).toMatchObject({ status: 'failed', version: 1, proposalId: null, canReextract: true });
    expect(await recent(fileId, viewer)).toMatchObject({ canReextract: false });

    const { version } = await runtime.execute<{ version: number }>('kernel.file.reextract', { fileId }, { actor: asUser(owner), orgId: orgA });
    expect(version).toBe(2);
    expect(await recent(fileId)).toMatchObject({ status: 'processing', version: 2, error: null, canReextract: false });

    reads.push(invoice('7001', 'Đọc được ở lần hai'));
    const { proposalId } = await extractAndPropose({ runtime: workerRuntime, store, extractor: ai, extract }, orgA, fileId, version);
    expect(proposalId).toBeTruthy();
    expect(await recent(fileId)).toMatchObject({ status: 'proposed', version: 2, proposalId, proposalStatus: 'pending', canReextract: true });
  });

  it('shows a re-read that failed after a rejection as failed, with its re-read, not as the old rejection (#2032)', async () => {
    const fileId = await upload();
    reads.push(invoice('7004', 'Bản đọc bị từ chối'));
    const { proposalId } = await extractAndPropose({ runtime: workerRuntime, store, extractor: ai, extract }, orgA, fileId);
    await runtime.execute('kernel.proposal.reject', { id: proposalId }, { actor: asUser(owner), orgId: orgA });
    expect(await recent(fileId)).toMatchObject({ status: 'proposed', version: 1, proposalId, proposalStatus: 'rejected', voided: false });

    const { version } = await runtime.execute<{ version: number }>('kernel.file.reextract', { fileId }, { actor: asUser(owner), orgId: orgA });
    reads.push(null);
    await extractAndPropose({ runtime: workerRuntime, store, extractor: ai, extract }, orgA, fileId, version);
    expect(await recent(fileId)).toMatchObject({ status: 'failed', version: 2, proposalId, proposalStatus: 'rejected', canReextract: true });
    // Drop the re-read's queued event, so the worker test below does not read it from the shared fake AI.
    const closer = new pg.Client({ connectionString: adminUrl });
    await closer.connect();
    try {
      await closer.query(`DELETE FROM crove_kernel.outbox_pending WHERE org_id = $1`, [orgA]);
    } finally {
      await closer.end();
    }
  });

  it('keeps the rejection when the failed re-read came before it (#2032)', async () => {
    const fileId = await upload();
    reads.push(invoice('7005', 'Bản đọc đầu'));
    const { proposalId } = await extractAndPropose({ runtime: workerRuntime, store, extractor: ai, extract }, orgA, fileId);
    const { version } = await runtime.execute<{ version: number }>('kernel.file.reextract', { fileId }, { actor: asUser(owner), orgId: orgA });
    reads.push(null);
    await extractAndPropose({ runtime: workerRuntime, store, extractor: ai, extract }, orgA, fileId, version);
    // The proposal still stands while it waits: the failed re-read does not hide it.
    expect(await recent(fileId)).toMatchObject({ status: 'proposed', version: 2, proposalId, proposalStatus: 'pending' });
    await runtime.execute('kernel.proposal.reject', { id: proposalId }, { actor: asUser(owner), orgId: orgA });
    expect(await recent(fileId)).toMatchObject({ status: 'proposed', version: 2, proposalId, proposalStatus: 'rejected' });
    const closer = new pg.Client({ connectionString: adminUrl });
    await closer.connect();
    try {
      await closer.query(`DELETE FROM crove_kernel.outbox_pending WHERE org_id = $1`, [orgA]);
    } finally {
      await closer.end();
    }
  });

  it('shows a lost re-read of a file without a proposal as failed, with a message', async () => {
    const fileId = await upload();
    reads.push(null);
    await extractAndPropose({ runtime: workerRuntime, store, extractor: ai, extract }, orgA, fileId);
    await runtime.execute('kernel.file.reextract', { fileId }, { actor: asUser(owner), orgId: orgA });
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      await admin.query(`SET session_replication_role = replica`);
      await admin.query(`UPDATE crove_kernel.extraction SET created_at = now() - interval '1 hour' WHERE file_id = $1 AND status = 'pending'`, [fileId]);
    } finally {
      await admin.end();
    }
    expect(await recent(fileId)).toMatchObject({ status: 'failed', version: 2, error: expect.stringMatching(/quá lâu/), canReextract: true });
    // Close the run and drop its queued event, so the worker test below does not read from the shared fake AI.
    const closer = new pg.Client({ connectionString: adminUrl });
    await closer.connect();
    try {
      await closer.query(`UPDATE crove_kernel.extraction SET status = 'failed', completed_at = now() WHERE file_id = $1 AND status = 'pending'`, [fileId]);
      await closer.query(`DELETE FROM crove_kernel.outbox_pending WHERE org_id = $1`, [orgA]);
    } finally {
      await closer.end();
    }
  });

  it('caps the number of runs per file', async () => {
    const fileId = await upload();
    reads.push(invoice('7002', 'Giới hạn'));
    await extractAndPropose({ runtime: workerRuntime, store, extractor: ai, extract }, orgA, fileId);
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      await admin.query(
        `INSERT INTO crove_kernel.extraction (org_id, file_id, status, method)
         SELECT $1, $2, 'failed', 'image_ai' FROM generate_series(2, $3::int)`,
        [orgA, fileId, MAX_EXTRACTION_VERSIONS],
      );
    } finally {
      await admin.end();
    }
    expect(await recent(fileId)).toMatchObject({ version: MAX_EXTRACTION_VERSIONS, canReextract: false });
    await expect(runtime.execute('kernel.file.reextract', { fileId }, { actor: asUser(owner), orgId: orgA })).rejects.toMatchObject({
      code: 'REEXTRACT_LIMIT',
      status: 409,
    });
  });

  it('runs a requested re-read through the outbox and the worker into a new revision', { timeout: 90_000 }, async () => {
    const fileId = await upload();
    reads.push(invoice('7003', 'Bản đọc đầu'));
    const stop = await startWorker({ connectionString: workerUrl, workerDb, runtime: workerRuntime, store, extractor: ai, extract, inboundDomain: null });
    try {
      // The upload's own event runs the first extraction.
      await until(async () => (await recent(fileId))?.status === 'proposed');
      const proposalId = (await recent(fileId))?.proposalId as string;
      reads.push(invoice('7003', 'Bản đọc lại'));
      await runtime.execute('kernel.file.reextract', { fileId }, { actor: asUser(owner), orgId: orgA });
      await until(async () => {
        const detail = await runtime.query<{ revision: number }>('kernel.inbox.get', { id: proposalId }, { actor: asUser(owner), orgId: orgA });
        return detail.revision === 2;
      });
      const detail = await runtime.query<{
        revision: number;
        payload: { lines: Array<{ description: string }> };
        extraction: { version: number; status: string; proposalVersion: number };
      }>('kernel.inbox.get', { id: proposalId }, { actor: asUser(owner), orgId: orgA });
      expect(detail.payload.lines[0]?.description).toBe('Bản đọc lại');
      expect(detail.extraction).toMatchObject({ version: 2, status: 'done', proposalVersion: 2 });
      expect(await recent(fileId)).toMatchObject({ status: 'proposed', version: 2, proposalId });
    } finally {
      await stop();
    }
  });
});
