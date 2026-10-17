// Staged presigned uploads and generation-pinned downloads (plan §7.6, ADR-0013, issue #109) through the HTTP API,
// against a real PostgreSQL 17. Every case runs on an in-memory versioned store with presigned transfers, and on an
// S3-compatible server when CROVE_TEST_S3_URL is set (http://<access key>:<secret>@<host>:<port>/<bucket>; CI:
// MinIO), where the browser's POST and GET go to the server itself. Set CROVE_TEST_ADMIN_URL to a superuser URL.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BucketVersioningStatus, CreateBucketCommand, PutBucketVersioningCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { SignJWT } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { buildKernelCommands, kernelCommands, kernelQueries } from '@crove/kernel';
import {
  BlobConflictError,
  BlobNotFoundError,
  BlobTooLargeError,
  Runtime,
  S3BlobStore,
  createS3Client,
  readVerified,
  sha256Hex,
  versionOf,
  type BlobRef,
  type BlobStore,
  type DirectTransfers,
  type PresignedUpload,
} from '@crove/kernel-runtime';
import { financeCommands, financeQueries } from '@crove/mod-finance';
import { createAuthenticator } from '../src/auth.ts';
import { ConcurrencyLimiter } from '../src/concurrency.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp, type HttpDeps } from '../src/http.ts';
import { createSessionStatusSource } from '../src/sessions.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const S3_URL = process.env.CROVE_TEST_S3_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const FIXTURE = new Uint8Array(readFileSync(new URL('../../extract/test/fixtures/einvoice-basic.xml', import.meta.url)));
const SECRET = 'test-only-jwt-secret-for-uploads-0123456789';
const ISSUER = 'crove-auth';

// A versioned bucket in memory: every write is a new version, create-only through put like S3BlobStore, and a
// staged upload is whatever the test "browser" last posted to the staging key.
class MemoryBucket implements BlobStore {
  private readonly versions = new Map<string, Array<{ id: string; bytes: Uint8Array } | null>>();
  private next = 1;
  readonly reads: string[] = [];

  private current(key: string) {
    return this.versions.get(key)?.at(-1) ?? null;
  }

  // Any write, as someone with bucket access would make it (no precondition).
  write(key: string, bytes: Uint8Array): string {
    const id = `v${this.next++}`;
    this.versions.set(key, [...(this.versions.get(key) ?? []), { id, bytes }]);
    return id;
  }

  async put(key: string, bytes: Uint8Array): Promise<string> {
    const current = this.current(key);
    if (current) {
      if (sha256Hex(current.bytes) !== sha256Hex(bytes)) throw new BlobConflictError(key);
      return `s3:${current.id}`;
    }
    return `s3:${this.write(key, bytes)}`;
  }

  async get(key: string, generation?: string | null): Promise<Uint8Array> {
    this.reads.push(key);
    const version = versionOf(generation);
    const found = version ? this.versions.get(key)?.find((v) => v?.id === version) : this.current(key);
    if (!found) throw new BlobNotFoundError(key);
    return found.bytes;
  }

  async delete(key: string): Promise<void> {
    if (this.current(key)) this.versions.set(key, [...(this.versions.get(key) ?? []), null]);
  }

  readonly direct: DirectTransfers = {
    presignUpload: async (key, maxBytes) => ({ url: 'memory://bucket', fields: { key }, expiresAt: new Date(Date.now() + 300_000), maxBytes }),
    presignDownload: async (ref: BlobRef) => {
      const version = versionOf(ref.generation);
      return version ? `https://bucket.test/${ref.key}?versionId=${version}` : null;
    },
    readStaged: async (key, maxBytes) => {
      const bytes = await this.get(key);
      if (bytes.byteLength > maxBytes) throw new BlobTooLargeError(key, maxBytes);
      return { bytes, sha256: sha256Hex(bytes) };
    },
  };
}

interface Backend {
  name: string;
  store: () => Promise<BlobStore>;
  // What the browser does with the presigned form; returns the HTTP status (204 on success).
  post: (form: PresignedUpload, bytes: Uint8Array) => Promise<number>;
  // A write to a key outside Crove, by someone with bucket access; returns the version id.
  overwrite: (key: string, bytes: Uint8Array) => Promise<string | undefined>;
  // Reads what a presigned download URL serves.
  follow: ((url: string) => Promise<Uint8Array>) | null;
}

const memory = new MemoryBucket();
const backends: Backend[] = [
  {
    name: 'an in-memory versioned store',
    store: async () => memory,
    post: async (form, bytes) => {
      memory.write(String(form.fields.key), bytes);
      return 204;
    },
    overwrite: async (key, bytes) => memory.write(key, bytes),
    follow: null,
  },
];
if (S3_URL) {
  const url = new URL(S3_URL);
  const options = {
    bucket: url.pathname.replace(/^\//, '') || 'crove-test',
    region: 'us-east-1',
    endpoint: url.origin,
    accessKeyId: decodeURIComponent(url.username),
    secretAccessKey: decodeURIComponent(url.password),
    forcePathStyle: true,
  };
  const client = createS3Client(options);
  backends.push({
    name: 'an S3-compatible server',
    store: async () => {
      await client.send(new CreateBucketCommand({ Bucket: options.bucket })).catch((error: { name?: string }) => {
        if (error.name !== 'BucketAlreadyOwnedByYou' && error.name !== 'BucketAlreadyExists') throw error;
      });
      await client.send(new PutBucketVersioningCommand({ Bucket: options.bucket, VersioningConfiguration: { Status: BucketVersioningStatus.Enabled } }));
      return S3BlobStore.connect(options);
    },
    post: async (form, bytes) => {
      const body = new FormData();
      for (const [name, value] of Object.entries(form.fields)) body.append(name, value);
      body.append('file', new Blob([Buffer.from(bytes)]), 'upload.bin');
      return (await fetch(form.url, { method: 'POST', body })).status;
    },
    overwrite: async (key, bytes) => (await client.send(new PutObjectCommand({ Bucket: options.bucket, Key: key, Body: bytes }))).VersionId,
    follow: async (location) => {
      const response = await fetch(location);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-disposition')).toMatch(/^attachment; filename\*=UTF-8''/);
      return new Uint8Array(await response.arrayBuffer());
    },
  });
}

const suite = ADMIN ? describe : describe.skip;

suite.each(backends)('staged uploads on PostgreSQL and $name (issue #109)', (backend) => {
  const dbName = `crove_test_upload_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let store: BlobStore;
  let app: ReturnType<typeof createHttpApp>;
  let deps: HttpDeps;
  const accounts = new Map<string, { subject: string; email: string; session: string }>();
  let slug = '';
  let orgId = '';

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  async function token(name: string, mfa = false) {
    let who = accounts.get(name);
    if (!who) {
      who = { subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@upload.test`, session: randomUUID() };
      accounts.set(name, who);
    }
    const now = Math.floor(Date.now() / 1000);
    const extra = mfa ? { aal: 'aal2', amr: [{ method: 'totp', timestamp: now }] } : { aal: 'aal1' };
    return new SignJWT({ role: 'authenticated', email: who.email, session_id: who.session, is_anonymous: false, ...extra })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(who.subject)
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(new TextEncoder().encode(SECRET));
  }

  async function call(path: string, name: string, init: { method?: string; json?: unknown; org?: string | null } = {}) {
    const response = await app.request(path, {
      method: init.method ?? 'POST',
      headers: {
        authorization: `Bearer ${await token(name)}`,
        'content-type': 'application/json',
        ...(init.org === null ? {} : { 'x-crove-org': init.org ?? slug }),
      },
      ...(init.method === 'GET' ? {} : { body: JSON.stringify(init.json ?? {}) }),
    });
    return response;
  }

  async function rpc(path: string, name: string, input: unknown, org: string | null, mfa = false) {
    const response = await app.request(`/api/rpc/${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await token(name, mfa)}`, 'content-type': 'application/json', ...(org ? { 'x-crove-org': org } : {}) },
      body: JSON.stringify(input === undefined ? {} : { json: input }),
    });
    const body = (await response.json()) as { json?: Record<string, unknown> };
    return { status: response.status, body: (body.json ?? body) as Record<string, unknown> };
  }

  async function join(name: string, role: 'member' | 'viewer') {
    await token(name);
    const invited = await rpc('org/invite', 'owner', { email: accounts.get(name)?.email, role }, slug, true);
    expect(invited.status).toBe(200);
    const accepted = await rpc('invites/accept', name, { token: String(invited.body.acceptPath).split('#')[1] }, null);
    expect(accepted.status).toBe(200);
  }

  async function begin(name = 'owner', purpose?: string) {
    const response = await call('/api/files/uploads', name, purpose ? { json: { purpose } } : {});
    expect(response.status).toBe(200);
    return (await response.json()) as PresignedUpload & { uploadId: string; expiresAt: string };
  }

  const complete = (uploadId: string, name = 'owner', filename = 'hd-1234.xml') =>
    call(`/api/files/uploads/${uploadId}/complete`, name, { json: { filename } });

  const grant = (uploadId: string) =>
    admin(async (c) => (await c.query<{ staging_key: string; used_at: Date | null }>('SELECT staging_key, used_at FROM crove_kernel.file_upload WHERE id = $1', [uploadId])).rows[0]);

  const files = () =>
    admin(async (c) =>
      (await c.query<{ id: string; sha256: string; storage_key: string; generation: string | null }>(
        'SELECT id, sha256, storage_key, generation FROM crove_kernel.file WHERE org_id = $1 ORDER BY created_at',
        [orgId],
      )).rows,
    );

  // A variant of the fixture invoice, so each case uploads new bytes.
  const invoice = (n: string) => new TextEncoder().encode(new TextDecoder().decode(FIXTURE).replace('<SHDon>1234</SHDon>', `<SHDon>${n}</SHDon>`));

  beforeAll(async () => {
    store = await backend.store();
    const base = new URL(ADMIN as string);
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    const appUrl = new URL(adminUrl);
    appUrl.username = 'crove_app';
    appUrl.password = 'test-app-pw';
    pool = createPool({ connectionString: appUrl.toString(), max: 6 });
    const db = createDb(pool);
    const config = loadConfig({
      DATABASE_URL: appUrl.toString(),
      AUTH_JWT_SECRET: SECRET,
      AUTH_ISSUER: ISSUER,
      AUTH_SESSION_CHECK: 'off',
      MIGRATIONS_DIR: MIGRATIONS,
      WEB_DIST: '/nonexistent',
    });
    const runtime = new Runtime(db, { sessions: createSessionStatusSource('off'), stepUp: 'required' }).register({
      commands: [...kernelCommands, ...financeCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries],
    });
    deps = { config, runtime, store, authenticate: createAuthenticator(config, db), pool, aiEnabled: false };
    app = createHttpApp(deps);
    const created = await rpc('org/create', 'owner', { name: `Uploads ${randomUUID().slice(0, 6)}`, idempotencyKey: randomUUID() }, null);
    expect(created.status).toBe(200);
    slug = String(created.body.slug);
    orgId = String(created.body.orgId);
    await join('member', 'member');
    await join('viewer', 'viewer');
  });

  afterAll(async () => {
    await pool?.end();
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('tells the app to upload through presigned forms', async () => {
    const response = await app.request('/api/config');
    expect(await response.json()).toMatchObject({ uploads: 'presigned' });
  });

  it('turns a staged upload into a file only through the server-side hash, and deletes the staging object', async () => {
    const before = await files();
    const form = await begin();
    expect(form.fields.key).toMatch(/^staging\/[0-9a-f]{64}$/);
    expect(Date.parse(form.expiresAt) - Date.now()).toBeLessThanOrEqual(300_000);
    const bytes = invoice('5001');
    expect(await backend.post(form, bytes)).toBe(204);
    // Staged bytes are not a file.
    expect(await files()).toEqual(before);

    const response = await complete(form.uploadId);
    expect(response.status).toBe(200);
    const { fileId, duplicate } = (await response.json()) as { fileId: string; duplicate: boolean };
    expect(duplicate).toBe(false);
    const row = (await files()).find((f) => f.id === fileId);
    const sha256 = sha256Hex(bytes);
    expect(row).toMatchObject({ sha256, storage_key: `org/${orgId}/${sha256}`, generation: expect.stringMatching(/^s3:.+/) });
    // The triple reads the bytes back.
    expect(await readVerified(store, { key: row?.storage_key ?? '', generation: row?.generation ?? null, sha256 })).toEqual(bytes);
    expect((await grant(form.uploadId))?.used_at).not.toBeNull();
    await expect(store.get(String(form.fields.key))).rejects.toBeInstanceOf(BlobNotFoundError);
  });

  it('uses a grant once: a second completion, even after new bytes reach the staging key, is refused and reads nothing', async () => {
    const form = await begin();
    expect(await backend.post(form, invoice('5002'))).toBe(204);
    expect((await complete(form.uploadId)).status).toBe(200);
    const after = await files();
    // The form is still within its 5 minutes, so the store accepts another POST to the same key.
    expect(await backend.post(form, invoice('5003'))).toBe(204);
    const again = await complete(form.uploadId);
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ code: 'UPLOAD_USED' });
    expect(await files()).toEqual(after);
  });

  it('refuses a grant after it expired (database clock)', async () => {
    const form = await begin();
    expect(await backend.post(form, invoice('5004'))).toBe(204);
    await admin(async (c) => {
      await c.query('BEGIN');
      // Past the guard trigger, as only a superuser can: the grant was issued 10 minutes ago.
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query("UPDATE crove_kernel.file_upload SET created_at = now() - interval '10 minutes', expires_at = now() - interval '5 minutes' WHERE id = $1", [form.uploadId]);
      await c.query('COMMIT');
    });
    const before = await files();
    const response = await complete(form.uploadId);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'UPLOAD_EXPIRED' });
    expect(await files()).toEqual(before);
  });

  it("refuses viewers, other users' grants and unknown grants", async () => {
    expect((await call('/api/files/uploads', 'viewer')).status).toBe(403);
    const form = await begin('owner');
    expect(await backend.post(form, invoice('5005'))).toBe(204);
    const stolen = await complete(form.uploadId, 'member');
    expect(stolen.status).toBe(404);
    expect((await grant(form.uploadId))?.used_at).toBeNull();
    expect((await complete(randomUUID())).status).toBe(404);
    // The owner can still use it.
    expect((await complete(form.uploadId)).status).toBe(200);
  });

  it('refuses a completion before the bytes arrived, and the grant is spent', async () => {
    const form = await begin();
    const response = await complete(form.uploadId);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'UPLOAD_MISSING' });
    expect((await grant(form.uploadId))?.used_at).not.toBeNull();
  });

  // Images for Social posts (#372): stored like every file, recorded as source 'social', never sent to extraction.
  it('records an image uploaded for a Social post as source social, and takes only images for it', async () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Buffer.from(randomUUID())]);
    const form = await begin();
    expect(await backend.post(form, png)).toBe(204);
    const done = await call(`/api/files/uploads/${form.uploadId}/complete`, 'owner', { json: { filename: 'anh.png', purpose: 'social' } });
    expect(done.status).toBe(200);
    const { fileId } = (await done.json()) as { fileId: string };
    const row = await admin(async (c) => (await c.query<{ source: string; content_type: string }>('SELECT source, content_type FROM crove_kernel.file WHERE id = $1', [fileId])).rows[0]);
    expect(row).toEqual({ source: 'social', content_type: 'image/png' });
    // No extraction is queued for it.
    const events = await admin(async (c) => (await c.query("SELECT 1 FROM crove_kernel.outbox_event WHERE type = 'kernel.file.ingested' AND payload->>'fileId' = $1", [fileId])).rowCount);
    expect(events).toBe(0);

    const xml = await begin();
    expect(await backend.post(xml, invoice('5099'))).toBe(204);
    expect((await call(`/api/files/uploads/${xml.uploadId}/complete`, 'owner', { json: { filename: 'hd.xml', purpose: 'social' } })).status).toBe(415);
    const odd = await begin();
    expect(await backend.post(odd, png)).toBe(204);
    expect((await call(`/api/files/uploads/${odd.uploadId}/complete`, 'owner', { json: { filename: 'anh.png', purpose: 'payroll' } })).status).toBe(400);
  });

  // Videos for Social posts (#409): a social grant allows 100 MB, the type and duration come from the file itself.
  it('records a video for a Social post with the duration read from it, and refuses one it cannot read', async () => {
    const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
    const box = (type: string, body: number[]) => [...u32(8 + body.length), ...Buffer.from(type), ...body];
    const ftyp = box('ftyp', [...Buffer.from('isom'), ...u32(0), ...Buffer.from('isomavc1')]);
    const mvhd = box('mvhd', [0, 0, 0, 0, ...u32(0), ...u32(0), ...u32(1000), ...u32(12_500), ...Array.from({ length: 80 }, () => 0)]);
    const mp4 = Uint8Array.from([...ftyp, ...box('free', [...Buffer.from(randomUUID())]), ...box('moov', mvhd)]);

    const document = await begin();
    expect(document.maxBytes).toBe(25 * 1024 * 1024);
    const form = await begin('owner', 'social');
    expect(form.maxBytes).toBe(100 * 1024 * 1024);
    expect(await backend.post(form, mp4)).toBe(204);
    const done = await call(`/api/files/uploads/${form.uploadId}/complete`, 'owner', { json: { filename: 'khai-truong.mp4', purpose: 'social' } });
    expect(done.status).toBe(200);
    const { fileId } = (await done.json()) as { fileId: string };
    const row = await admin(async (c) => (await c.query('SELECT source, content_type, duration_ms, filename FROM crove_kernel.file WHERE id = $1', [fileId])).rows[0]);
    expect(row).toEqual({ source: 'social', content_type: 'video/mp4', duration_ms: '12500', filename: 'khai-truong.mp4' });

    // A video is never taken as a document, and one without a movie header is refused.
    const asDocument = await begin();
    expect(await backend.post(asDocument, mp4)).toBe(204);
    expect((await call(`/api/files/uploads/${asDocument.uploadId}/complete`, 'owner', { json: { filename: 'a.mp4' } })).status).toBe(415);
    const broken = await begin('owner', 'social');
    expect(await backend.post(broken, Uint8Array.from([...ftyp, ...box('mdat', [...Buffer.from(randomUUID())])]))).toBe(204);
    const refused = await call(`/api/files/uploads/${broken.uploadId}/complete`, 'owner', { json: { filename: 'hong.mp4', purpose: 'social' } });
    expect(refused.status).toBe(415);
  });

  it('keeps documents and post images apart when the same bytes arrive as both', async () => {
    const upload = async (bytes: Uint8Array, filename: string, purpose: 'document' | 'social') => {
      const form = await begin();
      expect(await backend.post(form, bytes)).toBe(204);
      return call(`/api/files/uploads/${form.uploadId}/complete`, 'owner', { json: { filename, purpose } });
    };
    const ingested = (fileId: string) =>
      admin(async (c) => (await c.query("SELECT 1 FROM crove_kernel.outbox_event WHERE type = 'kernel.file.ingested' AND payload->>'fileId' = $1", [fileId])).rowCount);
    // A document first: its bytes cannot become a post image.
    const doc = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, ...Buffer.from(randomUUID())]);
    expect((await upload(doc, 'hoa-don.jpg', 'document')).status).toBe(200);
    const refused = await upload(doc, 'hoa-don.jpg', 'social');
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: 'FILE_IS_DOCUMENT' });
    // A post image first: the same bytes uploaded later as a document are still read as one, once.
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Buffer.from(randomUUID())]);
    const image = (await (await upload(png, 'anh.png', 'social')).json()) as { fileId: string };
    expect(await ingested(image.fileId)).toBe(0);
    const asDocument = (await (await upload(png, 'anh.png', 'document')).json()) as { fileId: string; duplicate: boolean };
    expect(asDocument).toEqual({ fileId: image.fileId, duplicate: false });
    expect(await ingested(image.fileId)).toBe(1);
  });

  it('refuses content that is not an accepted type, without recording a file', async () => {
    const form = await begin();
    expect(await backend.post(form, new TextEncoder().encode('#!/bin/sh\necho no'))).toBe(204);
    const before = await files();
    expect((await complete(form.uploadId)).status).toBe(415);
    expect(await files()).toEqual(before);
    await expect(store.get(String(form.fields.key))).rejects.toBeInstanceOf(BlobNotFoundError);
  });

  // Red-team S25: the object under a recorded key is replaced after approval by someone with bucket access.
  it('downloads the recorded version through a presigned GET after the key is overwritten', async () => {
    const form = await begin();
    const bytes = invoice('5006');
    expect(await backend.post(form, bytes)).toBe(204);
    const { fileId } = (await (await complete(form.uploadId)).json()) as { fileId: string };
    const row = (await files()).find((f) => f.id === fileId);
    const swappedVersion = await backend.overwrite(row?.storage_key ?? '', new TextEncoder().encode('<HDon>swapped</HDon>'));

    const response = await call(`/api/files/${fileId}`, 'viewer', { method: 'GET' });
    expect(response.status).toBe(302);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const location = new URL(response.headers.get('location') ?? '');
    expect(location.searchParams.get('versionId')).toBe(versionOf(row?.generation));
    expect(location.searchParams.get('versionId')).not.toBe(swappedVersion);
    if (backend.follow) expect(await backend.follow(location.toString())).toEqual(bytes);
    // The app asks for the link instead of following a redirect with its headers.
    const link = await call(`/api/files/${fileId}?link=1`, 'viewer', { method: 'GET' });
    expect(link.status).toBe(200);
    const { url } = (await link.json()) as { url: string };
    expect(new URL(url).searchParams.get('versionId')).toBe(versionOf(row?.generation));
    // The worker's read of the same triple gets the original too.
    expect(await readVerified(store, { key: row?.storage_key ?? '', generation: row?.generation ?? null, sha256: sha256Hex(bytes) })).toEqual(bytes);
  });

  it('fails closed for a row without a version whose object was swapped: nothing is served', async () => {
    const form = await begin();
    const bytes = invoice('5007');
    expect(await backend.post(form, bytes)).toBe(204);
    const { fileId } = (await (await complete(form.uploadId)).json()) as { fileId: string };
    const row = (await files()).find((f) => f.id === fileId);
    await admin(async (c) => {
      await c.query('BEGIN');
      // A row from before ADR-0013 (no generation), past the guard trigger as only a superuser can.
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query('UPDATE crove_kernel.file SET generation = NULL WHERE id = $1', [fileId]);
      await c.query('COMMIT');
    });
    await backend.overwrite(row?.storage_key ?? '', new TextEncoder().encode('<HDon>swapped</HDon>'));
    const response = await call(`/api/files/${fileId}`, 'owner', { method: 'GET' });
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ code: 'BLOB_INTEGRITY' });
  });

  it('caps open grants per user', async () => {
    const open = await admin(async (c) =>
      Number((await c.query<{ n: string }>(
        "SELECT count(*) AS n FROM crove_kernel.file_upload f JOIN crove_kernel.user_account u ON u.id = f.created_by WHERE f.org_id = $1 AND u.email LIKE 'member-%' AND used_at IS NULL AND expires_at > now()",
        [orgId],
      )).rows[0]?.n),
    );
    for (let i = open; i < 20; i++) expect((await call('/api/files/uploads', 'member')).status).toBe(200);
    const refused = await call('/api/files/uploads', 'member');
    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({ code: 'RATE_LIMITED' });
  });

  // Runs the body against another app built from the same dependencies, then puts the suite's app back.
  async function withApp<T>(other: ReturnType<typeof createHttpApp>, body: () => Promise<T>): Promise<T> {
    const saved = app;
    app = other;
    try {
      return await body();
    } finally {
      app = saved;
    }
  }

  // Issue #223: each completion buffers up to 25 MB, so a process runs a few at once and refuses the rest at once.
  it('refuses a completion with 503 and Retry-After while every slot is busy, and leaves its grant unused', async () => {
    const direct = store.direct as DirectTransfers;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => (entered = resolve));
    // The same store, with the staged read held until the test lets it go.
    const gated: BlobStore = {
      put: (key, bytes, contentType) => store.put(key, bytes, contentType),
      get: (key, generation) => store.get(key, generation),
      delete: (key) => store.delete(key),
      direct: {
        ...direct,
        readStaged: async (key, maxBytes) => {
          entered();
          await gate;
          return direct.readStaged(key, maxBytes);
        },
      },
    };
    await withApp(createHttpApp({ ...deps, store: gated, uploadCompletes: new ConcurrencyLimiter({ total: 1 }) }), async () => {
      const first = await begin();
      const second = await begin();
      expect(await backend.post(first, invoice('5101'))).toBe(204);
      expect(await backend.post(second, invoice('5102'))).toBe(204);
      const running = complete(first.uploadId);
      await inside;
      const busy = await complete(second.uploadId);
      expect(busy.status).toBe(503);
      expect(busy.headers.get('retry-after')).toBe('3');
      expect(await busy.json()).toMatchObject({ code: 'UPLOAD_BUSY' });
      // Refused before the claim: the grant can still be completed.
      expect((await grant(second.uploadId))?.used_at).toBeNull();
      release();
      expect((await running).status).toBe(200);
      expect((await complete(second.uploadId)).status).toBe(200);
      expect((await grant(second.uploadId))?.used_at).not.toBeNull();
    });
  });

  // Issue #223: a claimed grant is no longer open, so the open cap alone does not bound begin, claim, late POST loops.
  it('limits the grants one user opens per rolling minute, in the database', async () => {
    await join('burst', 'member');
    await join('steady', 'member');
    const runtime = new Runtime(createDb(pool), { sessions: createSessionStatusSource('off'), stepUp: 'required' }).register({
      commands: [...buildKernelCommands({ uploadBeginLimits: { perMinute: 3 } }), ...financeCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries],
    });
    await withApp(createHttpApp({ ...deps, runtime }), async () => {
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        const form = await begin('burst');
        ids.push(form.uploadId);
        // Claimed at once: none of them stays open, so only the rate refuses the next one.
        expect((await complete(form.uploadId, 'burst')).status).toBe(409);
      }
      const refused = await call('/api/files/uploads', 'burst');
      expect(refused.status).toBe(429);
      expect(await refused.json()).toMatchObject({ code: 'RATE_LIMITED', message: expect.stringMatching(/một phút/) });
      // Per user: another member is not affected.
      expect((await call('/api/files/uploads', 'steady')).status).toBe(200);
      // The window rolls with the database clock: grants issued two minutes ago no longer count.
      await admin(async (c) => {
        await c.query('BEGIN');
        await c.query('SET LOCAL session_replication_role = replica');
        await c.query(
          "UPDATE crove_kernel.file_upload SET created_at = created_at - interval '2 minutes', expires_at = expires_at - interval '2 minutes', used_at = used_at - interval '2 minutes' WHERE id = ANY($1::uuid[])",
          [ids],
        );
        await c.query('COMMIT');
      });
      expect((await call('/api/files/uploads', 'burst')).status).toBe(200);
    });
  });
});
