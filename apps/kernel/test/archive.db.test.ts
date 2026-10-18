// Bulk intake (issue #314) on PostgreSQL 17: a ZIP uploaded as one file is opened by the worker in the parsing sandbox
// (outbox -> pg-boss -> the extraction job -> crove-extract), each entry becomes a document of its own created by the
// uploader, and each document is read into a proposal by the ordinary extraction job. Set CROVE_TEST_ADMIN_URL to a
// superuser URL; the run creates and drops its own database.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import type { ExtractClient } from '@crove/extract-contract';
import { MAX_BATCH_ENTRIES, type BatchFile } from '@crove/kernel-contract';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { MAX_ARCHIVE_ENTRIES, createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime, fileKey, sha256Hex, type BlobStore } from '@crove/kernel-runtime';
import { financeCommands, financeQueries } from '@crove/mod-finance';
import { buildZip, type ZipEntrySpec } from '../../extract/test/zip-fixture.ts';
import { archiveSource, expandArchive } from '../src/archive.ts';
import { migrateJobs, startWorker } from '../src/worker.ts';
import { inProcessExtract } from './extract-service.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const FIXTURE = readFileSync(new URL('../../extract/test/fixtures/einvoice-basic.xml', import.meta.url), 'utf8');
// The acceptance case of #314: a month of 200 e-invoices in one ZIP.
const INVOICES = 200;

class MemoryStore implements BlobStore {
  readonly blobs = new Map<string, Uint8Array>();
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

const suite = ADMIN ? describe : describe.skip;

suite('bulk intake of a ZIP archive on PostgreSQL (issue #314)', () => {
  const dbName = `crove_test_archive_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
  let adminUser = '';
  let outsider = '';
  let orgA = '';
  let orgB = '';

  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const asMfa = (userId: string) => ({ ...asUser(userId), aal: 'aal2' as const, sessionId: '0f6c3a52-8d3b-4c1e-9a77-5b2f0e9d1c01', mfaAt: Math.floor(Date.now() / 1000) });
  const invoiceXml = (n: number) => FIXTURE.replace('<SHDon>1234</SHDon>', `<SHDon>${90000 + n}</SHDon>`);

  // The API's part: the archive is stored under the org's content address and recorded like any upload.
  async function uploadZip(entries: ZipEntrySpec[], filename = 'thang-10.zip', userId = owner, orgId = orgA): Promise<string> {
    const bytes = buildZip(entries);
    const sha256 = sha256Hex(bytes);
    const storageKey = fileKey(orgId, sha256);
    const generation = await store.put(storageKey, bytes);
    const { fileId } = await runtime.execute<{ fileId: string }>(
      'kernel.file.ingest',
      { filename, contentType: 'application/zip', sizeBytes: bytes.byteLength, sha256, storageKey, generation, source: 'upload' },
      { actor: asUser(userId), orgId },
    );
    return fileId;
  }

  const batch = (ids: string[], userId = owner, orgId = orgA) => runtime.query<BatchFile[]>('kernel.files.batch', { ids }, { actor: asUser(userId), orgId });

  async function until(check: () => Promise<boolean>, ms: number) {
    const deadline = Date.now() + ms;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error('timed out waiting for the worker');
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  beforeAll(async () => {
    extract = inProcessExtract();
    const url = new URL(ADMIN as string);
    const client = new pg.Client({ connectionString: ADMIN });
    await client.connect();
    await client.query(`CREATE DATABASE ${dbName}`);
    await client.end();
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
      new Runtime(target).register({
        commands: [...kernelCommands, ...financeCommands],
        queries: [...kernelQueries({ inboundDomain: 'in.test' }), ...financeQueries],
      });
    pool = createPool({ connectionString: loginUrl('crove_app', 'test-app-pw'), max: 4 });
    const db = createDb(pool);
    runtime = register(db);
    workerPool = createPool({ connectionString: workerUrl, max: 4 });
    workerDb = createDb(workerPool);
    workerRuntime = register(workerDb);
    owner = await upsertIdentity(db, { issuer: 'test', subject: 'zip-owner', email: 'zip-owner@example.com', name: null });
    viewer = await upsertIdentity(db, { issuer: 'test', subject: 'zip-viewer', email: 'zip-viewer@example.com', name: null });
    adminUser = await upsertIdentity(db, { issuer: 'test', subject: 'zip-admin', email: 'zip-admin@example.com', name: null });
    outsider = await upsertIdentity(db, { issuer: 'test', subject: 'zip-outsider', email: 'zip-outsider@example.com', name: null });
    orgA = (await createOrg(runtime, asUser(owner), 'Org A')).orgId;
    orgB = (await createOrg(runtime, asUser(outsider), 'Org B')).orgId;
    const { acceptPath } = await runtime.execute<{ acceptPath: string }>(
      'kernel.member.invite.create',
      { email: 'zip-viewer@example.com', role: 'viewer' },
      { actor: asMfa(owner), orgId: orgA },
    );
    await runtime.executeOrgless('kernel.member.invite.accept', { token: acceptPath.split('#')[1] }, { actor: asUser(viewer) });
    // A second approver, so four-eyes (P10) applies to the owner's uploads.
    const adminInvite = await runtime.execute<{ acceptPath: string }>(
      'kernel.member.invite.create',
      { email: 'zip-admin@example.com', role: 'admin' },
      { actor: asMfa(owner), orgId: orgA },
    );
    await runtime.executeOrgless('kernel.member.invite.accept', { token: adminInvite.acceptPath.split('#')[1] }, { actor: asUser(adminUser) });
  });

  afterAll(async () => {
    await pool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    const client = new pg.Client({ connectionString: ADMIN });
    await client.connect();
    await client.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await client.end();
  });

  it('refuses a hostile archive whole and records why, filing nothing', async () => {
    const fileId = await uploadZip([{ name: 'hd.xml', data: invoiceXml(-1) }, { name: '../../etc/hd.xml', data: invoiceXml(-2) }], 'hostile.zip');
    const source = await archiveSource(workerRuntime, orgA, fileId);
    expect(source).toMatchObject({ id: fileId, expanded: false });
    await expandArchive({ runtime: workerRuntime, store, extract }, orgA, source!);
    const [file] = await batch([fileId]);
    expect(file).toMatchObject({ status: 'failed', entries: null, canReextract: false });
    expect(file?.error).toMatch(/đường dẫn không an toàn/);
    const files = await admin((c) => c.query(`SELECT count(*)::int AS n FROM crove_kernel.file WHERE org_id = $1`, [orgA]));
    expect(files.rows[0]?.n).toBe(1);
  });

  it('opens an archive once, never reads it as a document, and shows it only to its org', async () => {
    const fileId = await uploadZip([{ name: 'chi-mot.xml', data: invoiceXml(-3) }], 'mot-tep.zip');
    const source = await archiveSource(workerRuntime, orgA, fileId);
    const first = await expandArchive({ runtime: workerRuntime, store, extract }, orgA, source!);
    expect(first.fileIds).toHaveLength(1);
    // A retried job finds the run and files nothing again.
    expect((await archiveSource(workerRuntime, orgA, fileId))?.expanded).toBe(true);
    const again = await workerRuntime.execute<{ duplicate: boolean }>(
      'kernel.file.archive.record',
      { fileId, status: 'done', error: null, entries: [] },
      { actor: { type: 'system', component: 'test' }, orgId: orgA },
    );
    expect(again.duplicate).toBe(true);
    await expect(runtime.execute('kernel.file.reextract', { fileId }, { actor: asUser(owner), orgId: orgA })).rejects.toMatchObject({ code: 'ARCHIVE_NOT_READ', status: 409 });
    // Only the worker records an opening.
    await expect(
      runtime.execute('kernel.file.archive.record', { fileId, status: 'done', error: null, entries: [] }, { actor: asUser(owner), orgId: orgA }),
    ).rejects.toMatchObject({ status: 403 });
    // A viewer sees the batch; another org's member does not see the file at all.
    expect((await batch([fileId], viewer))[0]).toMatchObject({ status: 'expanded' });
    expect(await batch([fileId], outsider, orgB)).toEqual([]);
    // The file that is not an archive has no archive source.
    expect(await archiveSource(workerRuntime, orgA, first.fileIds[0] as string)).toBeNull();
  });

  it('bounds a batch answer to MAX_BATCH_ENTRIES entries in all, and lists only counts in the recent files', async () => {
    const ids: string[] = [];
    for (let a = 0; a < 5; a++) {
      const bytes = new Uint8Array(Buffer.from(`PK\u0005\u0006 bounded batch ${a} ${Date.now()}`));
      const sha256 = sha256Hex(bytes);
      const storageKey = fileKey(orgA, sha256);
      const generation = await store.put(storageKey, bytes);
      const { fileId } = await runtime.execute<{ fileId: string }>(
        'kernel.file.ingest',
        { filename: `lon-${a}.zip`, contentType: 'application/zip', sizeBytes: bytes.byteLength, sha256, storageKey, generation, source: 'upload' },
        { actor: asUser(owner), orgId: orgA },
      );
      // The most an archive can hold: 500 entries with the longest names.
      const entries = Array.from({ length: MAX_ARCHIVE_ENTRIES }, (_, i) => ({ outcome: 'rejected' as const, name: `${String(i).padStart(4, '0')}${'x'.repeat(251)}`, reason: 'unsupported_type' as const }));
      await workerRuntime.execute('kernel.file.archive.record', { fileId, status: 'done', error: null, entries }, { actor: { type: 'system', component: 'test' }, orgId: orgA });
      ids.push(fileId);
    }
    const answer = await batch(ids);
    expect(answer.map((f) => f.entryCount)).toEqual([500, 500, 500, 500, 500]);
    expect(answer.reduce((sum, f) => sum + (f.entries?.length ?? 0), 0)).toBe(MAX_BATCH_ENTRIES);
    expect(answer.map((f) => [f.entries?.length, f.entriesTruncated])).toEqual([
      [500, false],
      [500, false],
      [500, false],
      [500, false],
      [0, true],
    ]);
    expect(JSON.stringify(answer).length).toBeLessThan(2_000_000);
    // Asked about alone, the last one comes whole.
    const [alone] = await batch([ids[4] as string]);
    expect(alone).toMatchObject({ entryCount: 500, entriesTruncated: false });
    expect(alone?.entries).toHaveLength(500);
    expect(alone?.entries?.[499]?.name.startsWith('0499')).toBe(true);
    // The recent files never carry entries.
    const recent = await runtime.query<Array<Record<string, unknown>>>('kernel.files.recent', {}, { actor: asUser(owner), orgId: orgA });
    expect(recent.find((f) => f.id === ids[0])).not.toHaveProperty('entries');
  });

  it(`opens a ZIP of ${INVOICES} e-invoices through the worker into ${INVOICES} proposals, each entry its own document`, { timeout: 400_000 }, async () => {
    await migrateJobs(adminUrl);
    const inner = buildZip([{ name: 'a.xml', data: invoiceXml(-4) }]);
    const entries: ZipEntrySpec[] = [
      { name: 'thang-10/', data: '', method: 'store' },
      ...Array.from({ length: INVOICES }, (_, i) => ({ name: `thang-10/hd-${String(i).padStart(3, '0')}.xml`, data: invoiceXml(i) })),
      // The same bytes twice in one archive: the second is the file the first one filed.
      { name: 'thang-10/ban-sao/hd-000.xml', data: invoiceXml(0) },
      { name: 'thang-10/kem-theo.zip', data: inner },
      { name: 'thang-10/ghi-chu.txt', data: 'Hoa don thang 10' },
      { name: 'thang-10/rong.xml', data: '', method: 'store' },
    ];
    const started = Date.now();
    const fileId = await uploadZip(entries);
    const stop = await startWorker({ connectionString: workerUrl, workerDb, runtime: workerRuntime, store, extractor: null, extract, inboundDomain: null });
    let view: BatchFile | undefined;
    try {
      await until(async () => {
        [view] = await batch([fileId]);
        return view?.status === 'expanded' && (view.entries ?? []).every((e) => e.outcome !== 'stored' || (e.file !== null && e.file.status !== 'processing'));
      }, 360_000);
    } finally {
      await stop();
    }
    const elapsed = Date.now() - started;
    console.log(`[archive.db.test] ${INVOICES} invoices opened and read in ${elapsed} ms`);

    const list = view?.entries ?? [];
    expect(list).toHaveLength(INVOICES + 4);
    const stored = list.filter((e) => e.outcome === 'stored');
    expect(stored).toHaveLength(INVOICES);
    expect(stored.every((e) => e.file?.status === 'proposed')).toBe(true);
    expect(list.find((e) => e.name === 'thang-10/ban-sao/hd-000.xml')).toMatchObject({ outcome: 'duplicate', file: { id: stored[0]?.file?.id } });
    expect(list.filter((e) => e.outcome === 'rejected').map((e) => [e.name, e.reason])).toEqual([
      ['thang-10/kem-theo.zip', 'nested_archive'],
      ['thang-10/ghi-chu.txt', 'unsupported_type'],
      ['thang-10/rong.xml', 'empty'],
    ]);
    expect(stored[1]?.file?.filename).toBe('hd-001.xml');

    // Every entry is a document of its own, uploaded (for approval) by the member who uploaded the archive.
    const children = stored.map((e) => e.file?.id as string);
    const rows = await admin((c) =>
      c.query<{ created_by: string; source: string; proposals: number }>(
        `SELECT f.created_by, f.source, (SELECT count(*)::int FROM crove_kernel.proposal p WHERE p.org_id = f.org_id AND p.source_file_id = f.id) AS proposals
         FROM crove_kernel.file f WHERE f.org_id = $1 AND f.id = ANY($2::uuid[])`,
        [orgA, children],
      ),
    );
    expect(rows.rows).toHaveLength(INVOICES);
    expect(rows.rows.every((r) => r.created_by === owner && r.source === 'upload' && r.proposals === 1)).toBe(true);
    // So the uploader is an author of every proposal read from the archive and cannot approve it alone (P10).
    const proposalId = stored[0]?.file?.proposalId as string;
    const detail = await runtime.query<{ canApprove: boolean; approveReason: string }>('kernel.inbox.get', { id: proposalId }, { actor: asMfa(owner), orgId: orgA });
    expect(detail).toMatchObject({ canApprove: false, approveReason: 'four_eyes' });
    const second = await runtime.query<{ canApprove: boolean }>('kernel.inbox.get', { id: proposalId }, { actor: asMfa(adminUser), orgId: orgA });
    expect(second.canApprove).toBe(true);
    // The archive itself has no proposal and cannot be read again.
    expect(view).toMatchObject({ status: 'expanded', proposalId: null, canReextract: false });
  });
});
