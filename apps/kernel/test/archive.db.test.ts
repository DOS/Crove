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
import { MAX_BATCH_ENTRIES, MAX_EMAIL_ARCHIVE_DOCUMENTS, MAX_EMAIL_ARCHIVES, type BatchFile } from '@crove/kernel-contract';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { MAX_ARCHIVE_ENTRIES, createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime, contentGeneration, fileKey, inboundKey, newInboundBlobId, sha256Hex, type BlobStore } from '@crove/kernel-runtime';
import { financeCommands, financeQueries } from '@crove/mod-finance';
import { buildZip, type ZipEntrySpec } from '../../extract/test/zip-fixture.ts';
import { archiveSource, expandArchive } from '../src/archive.ts';
import { processInboundEmail } from '../src/inbound.ts';
import { recordLastAttemptFailure, startWorker } from '../src/worker.ts';
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

  it('records a failed opening on the last attempt even when the archive lookup failed (#432)', async () => {
    // The worker's runtime, but the lookup of the archive behind a job fails, as while the database is unreachable.
    const lookupFails = new Proxy(workerRuntime, {
      get(target, property, receiver) {
        if (property === 'query') {
          return (name: string, ...rest: unknown[]) =>
            name === 'kernel.file.archive.source' ? Promise.reject(new Error('connection refused')) : Reflect.apply(target.query, target, [name, ...rest]);
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(receiver) : value;
      },
    }) as Runtime;
    const zip = await uploadZip([{ name: 'hd.xml', data: invoiceXml(-50) }], 'that-bai.zip');
    await recordLastAttemptFailure(lookupFails, orgA, zip, undefined, undefined);
    const [archive] = await batch([zip]);
    expect(archive).toMatchObject({ status: 'failed', error: 'Không mở được tệp ZIP sau nhiều lần thử; hãy tải lại tệp', entries: null });
    // A document whose lookup failed is recorded as a failed read, as before.
    const bytes = new TextEncoder().encode(invoiceXml(-51));
    const sha256 = sha256Hex(bytes);
    const storageKey = fileKey(orgA, sha256);
    const generation = await store.put(storageKey, bytes);
    const { fileId: document } = await runtime.execute<{ fileId: string }>(
      'kernel.file.ingest',
      { filename: 'hd.xml', contentType: 'application/xml', sizeBytes: bytes.byteLength, sha256, storageKey, generation, source: 'upload' },
      { actor: asUser(owner), orgId: orgA },
    );
    await recordLastAttemptFailure(lookupFails, orgA, document, undefined, undefined);
    expect((await batch([document]))[0]).toMatchObject({ status: 'failed' });
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

  it('keeps the entry count in a column the database sets from the result, and backfills older archives (#432)', async () => {
    const ingestArchive = async (label: string) => {
      const bytes = new Uint8Array(Buffer.from(`PK\u0005\u0006 entry count ${label} ${Date.now()}`));
      const sha256 = sha256Hex(bytes);
      const storageKey = fileKey(orgA, sha256);
      const generation = await store.put(storageKey, bytes);
      const { fileId } = await runtime.execute<{ fileId: string }>(
        'kernel.file.ingest',
        { filename: `dem-${label}.zip`, contentType: 'application/zip', sizeBytes: bytes.byteLength, sha256, storageKey, generation, source: 'upload' },
        { actor: asUser(owner), orgId: orgA },
      );
      return fileId;
    };
    const countOf = (fileId: string) =>
      admin(async (c) => (await c.query<{ n: number | null }>('SELECT entry_count AS n FROM crove_kernel.extraction WHERE file_id = $1', [fileId])).rows[0]?.n);
    const entries = (n: number) => Array.from({ length: n }, (_, i) => ({ outcome: 'rejected' as const, name: `muc-${i}.txt`, reason: 'unsupported_type' as const }));
    const system = { actor: { type: 'system' as const, component: 'test' }, orgId: orgA };

    // Recorded by the worker: the count is the length of the stored list, and files.batch reads it from the column.
    const opened = await ingestArchive('opened');
    await workerRuntime.execute('kernel.file.archive.record', { fileId: opened, status: 'done', error: null, entries: entries(3) }, system);
    expect(await countOf(opened)).toBe(3);
    expect((await batch([opened]))[0]).toMatchObject({ status: 'expanded', entryCount: 3 });
    // A failed opening lists no entry; a run of any other method has no count.
    const failed = await ingestArchive('failed');
    await workerRuntime.execute('kernel.file.archive.record', { fileId: failed, status: 'failed', error: 'hỏng', entries: [] }, system);
    expect(await countOf(failed)).toBe(0);
    expect((await batch([failed]))[0]).toMatchObject({ status: 'failed', entryCount: null });

    // Nobody writes it: an insert that names another count gets the real one, and the API role may not update it.
    const forged = await ingestArchive('forged');
    await admin((c) =>
      c.query(
        `INSERT INTO crove_kernel.extraction (org_id, file_id, method, status, result, checks, completed_at, entry_count)
         VALUES ($1, $2, 'archive', 'done', $3::jsonb, '[]', now(), 99)`,
        [orgA, forged, JSON.stringify({ entries: [{ name: 'a.txt', outcome: 'rejected', reason: 'unsupported_type', fileId: null }] })],
      ),
    );
    expect(await countOf(forged)).toBe(1);
    await expect(pool.query('UPDATE crove_kernel.extraction SET entry_count = 7 WHERE false')).rejects.toThrow(/permission denied/);

    // An archive opened before the column existed (the trigger off, as before the migration) is counted when the
    // migration runs, and running the migration again changes nothing.
    const older = await ingestArchive('older');
    await admin(async (c) => {
      await c.query('ALTER TABLE crove_kernel.extraction DISABLE TRIGGER extraction_entry_count');
      try {
        await c.query(
          `INSERT INTO crove_kernel.extraction (org_id, file_id, method, status, result, checks, completed_at)
           VALUES ($1, $2, 'archive', 'done', $3::jsonb, '[]', now())`,
          [orgA, older, JSON.stringify({ entries: entries(4).map((e) => ({ ...e, fileId: null })) })],
        );
      } finally {
        await c.query('ALTER TABLE crove_kernel.extraction ENABLE TRIGGER extraction_entry_count');
      }
    });
    expect(await countOf(older)).toBeNull();
    const migration = readFileSync(new URL('../../../supabase/migrations/20261020235000_crove_kernel_extraction_entry_count.sql', import.meta.url), 'utf8');
    for (let run = 0; run < 2; run++) await admin((c) => c.query(`BEGIN;\n${migration}\nCOMMIT;`));
    expect(await countOf(older)).toBe(4);
    expect(await countOf(opened)).toBe(3);
    expect((await batch([older]))[0]).toMatchObject({ status: 'expanded', entryCount: 4 });
  });

  it('opens ZIPs attached to an email as email documents, bounded per message and per ZIP (#432)', async () => {
    // Org B, so the counts of org A's other cases stay as they are.
    const token = await admin(async (c) => (await c.query<{ t: string }>('SELECT inbound_token AS t FROM crove_kernel.tenant WHERE org_id = $1', [orgB])).rows[0]?.t);
    const extra = 5;
    const big = Array.from({ length: MAX_EMAIL_ARCHIVE_DOCUMENTS + extra }, (_, i) => ({ name: `thang-10/hd-${String(i + 1).padStart(2, '0')}.xml`, data: invoiceXml(1000 + i) }));
    const zips = [buildZip(big), buildZip([{ name: 'hd.xml', data: invoiceXml(2000) }]), buildZip([{ name: 'hd.xml', data: invoiceXml(2001) }])];
    expect(zips.length).toBeGreaterThan(MAX_EMAIL_ARCHIVES);
    const part = (filename: string, contentType: string, bytes: Uint8Array) => [
      '--b1',
      `Content-Type: ${contentType}; name="${filename}"`,
      `Content-Disposition: attachment; filename="${filename}"`,
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(bytes).toString('base64').replace(/.{76}/g, '$&\r\n'),
    ];
    const mime = [
      'From: Nha cung cap <hoadon@vendor.example>',
      `To: ${token}@in.test`,
      'Subject: Hoa don thang 10',
      'Message-ID: <zip-432@vendor.example>',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="b1"',
      '',
      ...zips.flatMap((bytes, i) => part(`hoa-don-${i + 1}.zip`, 'application/zip', bytes)),
      ...part('hd-3000.xml', 'application/xml', new TextEncoder().encode(invoiceXml(3000))),
      '--b1--',
      '',
    ].join('\r\n');
    const raw = new TextEncoder().encode(mime);
    const blobId = newInboundBlobId();
    await store.put(inboundKey(blobId), raw);
    const received = await processInboundEmail(
      { runtime: workerRuntime, store, domain: 'in.test', extract },
      { blobId, sha256: sha256Hex(raw), sizeBytes: raw.byteLength, recipient: `${token}@in.test` },
    );
    if (!('fileIds' in received)) throw new Error('the message was not filed');
    // The first MAX_EMAIL_ARCHIVES ZIPs and the XML are filed; the third ZIP is skipped.
    expect(received.fileIds).toHaveLength(MAX_EMAIL_ARCHIVES + 1);
    const filed = await admin(async (c) =>
      (await c.query<{ id: string; filename: string; content_type: string; source: string; created_by: string | null }>(
        'SELECT id, filename, content_type, source, created_by FROM crove_kernel.file WHERE org_id = $1 AND id = ANY($2::uuid[]) ORDER BY filename',
        [orgB, received.fileIds],
      )).rows,
    );
    expect(filed.map((f) => [f.filename, f.content_type, f.source, f.created_by])).toEqual([
      ['hd-3000.xml', 'application/xml', 'email', null],
      ['hoa-don-1.zip', 'application/zip', 'email', null],
      ['hoa-don-2.zip', 'application/zip', 'email', null],
    ]);

    // The big ZIP files its first MAX_EMAIL_ARCHIVE_DOCUMENTS documents, as email documents with no creator; the rest
    // are listed with the reason and never stored.
    const bigId = filed.find((f) => f.filename === 'hoa-don-1.zip')?.id as string;
    const source = await archiveSource(workerRuntime, orgB, bigId);
    expect(source).toMatchObject({ source: 'email', expanded: false });
    const opened = await expandArchive({ runtime: workerRuntime, store, extract }, orgB, source!);
    expect(opened.fileIds).toHaveLength(MAX_EMAIL_ARCHIVE_DOCUMENTS);
    const [listing] = await batch([bigId], outsider, orgB);
    expect(listing?.entries?.map((e) => [e.name, e.outcome, e.reason])).toEqual(
      big.map((entry, i) => [entry.name, i < MAX_EMAIL_ARCHIVE_DOCUMENTS ? 'stored' : 'rejected', i < MAX_EMAIL_ARCHIVE_DOCUMENTS ? null : 'email_limit']),
    );
    const documents = await admin(async (c) =>
      (await c.query<{ source: string; created_by: string | null }>('SELECT source, created_by FROM crove_kernel.file WHERE org_id = $1 AND id = ANY($2::uuid[])', [orgB, opened.fileIds])).rows,
    );
    expect(documents).toEqual(opened.fileIds.map(() => ({ source: 'email', created_by: null })));
    for (const entry of big.slice(MAX_EMAIL_ARCHIVE_DOCUMENTS)) {
      expect(store.blobs.has(fileKey(orgB, sha256Hex(new TextEncoder().encode(entry.data))))).toBe(false);
    }

    // The kernel holds the limit whatever the worker sends: a recording of the second ZIP with more stored entries
    // than the limit files only the first MAX_EMAIL_ARCHIVE_DOCUMENTS.
    const smallId = filed.find((f) => f.filename === 'hoa-don-2.zip')?.id as string;
    const crafted = Array.from({ length: MAX_EMAIL_ARCHIVE_DOCUMENTS + 2 }, (_, i) => {
      const sha256 = sha256Hex(`crafted-${i}`);
      return {
        outcome: 'stored' as const,
        name: `crafted-${i}.xml`,
        file: { filename: `crafted-${i}.xml`, contentType: 'application/xml', sizeBytes: 10, sha256, storageKey: fileKey(orgB, sha256), generation: contentGeneration(sha256) },
      };
    });
    const recorded = await workerRuntime.execute<{ fileIds: string[] }>(
      'kernel.file.archive.record',
      { fileId: smallId, status: 'done', error: null, entries: crafted },
      { actor: { type: 'system', component: 'test' }, orgId: orgB },
    );
    expect(recorded.fileIds).toHaveLength(MAX_EMAIL_ARCHIVE_DOCUMENTS);
    const [small] = await batch([smallId], outsider, orgB);
    expect(small?.entries?.filter((e) => e.reason === 'email_limit').map((e) => e.name)).toEqual([`crafted-${MAX_EMAIL_ARCHIVE_DOCUMENTS}.xml`, `crafted-${MAX_EMAIL_ARCHIVE_DOCUMENTS + 1}.xml`]);
  });

  it(`opens a ZIP of ${INVOICES} e-invoices through the worker into ${INVOICES} proposals, each entry its own document`, { timeout: 400_000 }, async () => {
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
