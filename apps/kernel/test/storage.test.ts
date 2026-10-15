// The blob store the API and the worker build from configuration (External-tenant gate T7). Every case runs on
// local disk, and on an S3-compatible server when CROVE_TEST_S3_URL is set
// (http://<access key>:<secret>@<host>:<port>/<bucket>, as for packages/kernel-runtime). A "restart" is a new
// store instance built from the same configuration, used by a new HTTP app or worker call.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CreateBucketCommand } from '@aws-sdk/client-s3';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ORG_HEADER } from '@crove/kernel-contract';
import { BlobNotFoundError, LocalDiskStore, S3BlobStore, createS3Client, inboundKey, sha256Hex, type BlobStore, type Runtime } from '@crove/kernel-runtime';
import type { AuthUser } from '../src/auth.ts';
import { loadConfig, type Config } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { processInboundEmail } from '../src/inbound.ts';
import { createBlobStore, describeStorage } from '../src/storage.ts';
import { inProcessExtract } from './extract-service.ts';

const FIXTURE = readFileSync(new URL('../../../packages/l10n-vn/test/fixtures/einvoice-basic.xml', import.meta.url));
const S3_URL = process.env.CROVE_TEST_S3_URL;
const BASE = { DATABASE_URL: 'postgres://localhost/x', AUTH_JWT_SECRET: 'x'.repeat(32), AUTH_ISSUER: 'crove-auth', WEB_DIST: '/nonexistent' };

describe('storage configuration', () => {
  it('defaults to local disk, so compose works unchanged', () => {
    const config = loadConfig(BASE);
    expect(config.STORAGE).toBe('local');
    expect(createBlobStore(config)).toBeInstanceOf(LocalDiskStore);
  });

  it('builds an S3 store from the S3 settings and never puts credentials in the log line', () => {
    const config = loadConfig({
      ...BASE,
      STORAGE: 's3',
      S3_ENDPOINT: 'https://acc0unt.r2.cloudflarestorage.com',
      S3_REGION: 'auto',
      S3_BUCKET: 'crove-files-prod',
      S3_ACCESS_KEY_ID: 'AKIAEXAMPLEKEY',
      S3_SECRET_ACCESS_KEY: 'example-secret-value',
      S3_FORCE_PATH_STYLE: 'true',
    });
    expect(createBlobStore(config)).toBeInstanceOf(S3BlobStore);
    const line = describeStorage(config);
    expect(line).toBe('s3 bucket crove-files-prod at acc0unt.r2.cloudflarestorage.com');
    expect(line).not.toMatch(/AKIA|secret/);
    expect(loadConfig({ ...BASE, STORAGE: 's3', S3_BUCKET: 'b-1' }).S3_REGION).toBe('us-east-1');
  });

  it('refuses incomplete or malformed S3 settings, naming the field and never its value', () => {
    expect(() => loadConfig({ ...BASE, STORAGE: 's3' })).toThrow(/S3_BUCKET/);
    expect(() => loadConfig({ ...BASE, STORAGE: 'gcs' })).toThrow(/STORAGE/);
    expect(() => loadConfig({ ...BASE, STORAGE: 's3', S3_BUCKET: 'Bad_Bucket!' })).toThrow(/S3_BUCKET/);
    expect(() => loadConfig({ ...BASE, STORAGE: 's3', S3_BUCKET: 'b-1', S3_ENDPOINT: 'ftp://minio:9000' })).toThrow(/S3_ENDPOINT/);
    expect(() => loadConfig({ ...BASE, STORAGE: 's3', S3_BUCKET: 'b-1', S3_FORCE_PATH_STYLE: 'yes' })).toThrow(/S3_FORCE_PATH_STYLE/);
    const halfCredentials = () => loadConfig({ ...BASE, STORAGE: 's3', S3_BUCKET: 'b-1', S3_SECRET_ACCESS_KEY: 'example-secret-value' });
    expect(halfCredentials).toThrow(/S3_ACCESS_KEY_ID/);
    expect(halfCredentials).not.toThrow(/example-secret-value/);
  });
});

type Backend = { name: string; env: () => Promise<Record<string, string>>; cleanup?: () => Promise<void> };

let localRoot = '';
const backends: Backend[] = [
  {
    name: 'local disk',
    env: async () => {
      localRoot = await mkdtemp(join(tmpdir(), 'crove-store-'));
      return { STORAGE: 'local', STORAGE_DIR: localRoot };
    },
    cleanup: () => rm(localRoot, { recursive: true, force: true }),
  },
];
if (S3_URL) {
  backends.push({
    name: 's3',
    env: async () => {
      const url = new URL(S3_URL);
      const env = {
        STORAGE: 's3',
        S3_ENDPOINT: url.origin,
        S3_BUCKET: url.pathname.replace(/^\//, '') || 'crove-test',
        S3_ACCESS_KEY_ID: decodeURIComponent(url.username),
        S3_SECRET_ACCESS_KEY: decodeURIComponent(url.password),
        S3_FORCE_PATH_STYLE: 'true',
      };
      const client = createS3Client({ bucket: env.S3_BUCKET, region: 'us-east-1', endpoint: env.S3_ENDPOINT, accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY, forcePathStyle: true });
      await client.send(new CreateBucketCommand({ Bucket: env.S3_BUCKET })).catch((error: { name?: string }) => {
        if (error.name !== 'BucketAlreadyOwnedByYou' && error.name !== 'BucketAlreadyExists') throw error;
      });
      return env;
    },
  });
}

describe.each(backends)('files survive a restart on $name, from the API and the worker', (backend) => {
  const INBOUND_SECRET = 'y'.repeat(32);
  const orgId = randomUUID();
  const token = randomUUID().replace(/-/g, '').slice(0, 24);
  const user: AuthUser = { userId: randomUUID(), email: 'owner@example.com', name: null, aal: 'aal1', sessionId: randomUUID(), mfaAt: null };
  let config: Config;

  // The rows the kernel would keep: file id -> what kernel.file.get returns.
  const files = new Map<string, { filename: string; content_type: string; storage_key: string }>();
  // Answers to Runtime.orgless, in order (the enqueue definer, then the org lookup by inbound token).
  const orgless: unknown[] = [];
  const runtime = {
    forUser: async () => [{ orgId, slug: 'acme', name: 'Acme', role: 'owner' }],
    orgless: async () => orgless.shift(),
    execute: async (command: string, input: Record<string, unknown>) => {
      const record = (f: { filename: string; contentType: string; storageKey: string }) => {
        const id = randomUUID();
        files.set(id, { filename: f.filename, content_type: f.contentType, storage_key: f.storageKey });
        return id;
      };
      if (command === 'kernel.file.ingest') return { fileId: record(input as never), duplicate: false };
      if (command === 'kernel.inbound.receive') return { duplicate: false, fileIds: (input.files as never[]).map(record) };
      throw new Error(`unexpected command ${command}`);
    },
    query: async (name: string, input: { id: string }) => {
      if (name !== 'kernel.file.get') throw new Error(`unexpected query ${name}`);
      const file = files.get(input.id);
      if (!file) throw new Error('no such file');
      return file;
    },
  } as unknown as Runtime;

  // A fresh process: a new store from the same configuration behind a new HTTP app.
  function apiProcess(store: BlobStore = createBlobStore(config)) {
    return createHttpApp({ config, runtime, store, authenticate: async () => user, pool: {} as pg.Pool, aiEnabled: false });
  }

  async function download(fileId: string): Promise<Uint8Array> {
    const response = await apiProcess().request(`/api/files/${fileId}`, { headers: { authorization: 'Bearer t', [ORG_HEADER]: 'acme' } });
    expect(response.status).toBe(200);
    return new Uint8Array(await response.arrayBuffer());
  }

  beforeAll(async () => {
    config = loadConfig({ ...BASE, ...(await backend.env()), INBOUND_DOMAIN: 'in.test', INBOUND_SECRET });
  });

  afterAll(async () => {
    await backend.cleanup?.();
  });

  it('API: an uploaded file downloads from a restarted API', async () => {
    const form = new FormData();
    form.append('file', new File([FIXTURE], 'hd-1234.xml', { type: 'application/xml' }));
    const upload = await apiProcess().request('/api/files', { method: 'POST', body: form, headers: { authorization: 'Bearer t', [ORG_HEADER]: 'acme' } });
    expect(upload.status).toBe(200);
    const { files: uploaded } = (await upload.json()) as { files: Array<{ fileId: string }> };
    const fileId = uploaded[0]?.fileId ?? '';
    expect(files.get(fileId)?.storage_key).toBe(`org/${orgId}/${sha256Hex(FIXTURE)}`);
    expect(await download(fileId)).toEqual(new Uint8Array(FIXTURE));
  });

  it('worker: a message the API stored is processed by a restarted worker, whose files a restarted API serves', async () => {
    const attachment = FIXTURE.toString('base64').replace(/.{76}/g, '$&\r\n');
    const mime = [
      `To: ${token}@in.test`,
      'Subject: Hoa don',
      `Message-ID: <${randomUUID()}@vendor.example>`,
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="b1"',
      '',
      '--b1',
      'Content-Type: application/xml; name="hd.xml"',
      'Content-Disposition: attachment; filename="hd.xml"',
      'Content-Transfer-Encoding: base64',
      '',
      attachment,
      '--b1--',
      '',
    ].join('\r\n');

    // The API process stores the raw message and enqueues it.
    const apiStore = createBlobStore(config);
    const stored: string[] = [];
    const recordingStore: BlobStore = {
      put: (key, bytes, type) => {
        stored.push(key);
        return apiStore.put(key, bytes, type);
      },
      get: (key) => apiStore.get(key),
      delete: (key) => apiStore.delete(key),
    };
    orgless.push(true);
    const accepted = await apiProcess(recordingStore).request('/api/inbound/email', {
      method: 'POST',
      headers: { authorization: `Bearer ${INBOUND_SECRET}`, 'x-crove-recipient': `${token}@in.test` },
      body: mime,
    });
    expect(accepted.status).toBe(202);
    const { sha256 } = (await accepted.json()) as { sha256: string };
    const key = stored[0] ?? '';
    expect(key).toMatch(/^inbound\/[0-9a-f]{64}$/);

    // A worker started later, with its own store, reads it, files the attachment and deletes the raw message.
    const workerStore = createBlobStore(config);
    orgless.push(orgId);
    const job = { blobId: key.slice('inbound/'.length), sha256, sizeBytes: new TextEncoder().encode(mime).byteLength, recipient: `${token}@in.test` };
    const result = await processInboundEmail({ runtime, store: workerStore, domain: 'in.test', extract: inProcessExtract() }, job);
    expect(result.fileIds).toHaveLength(1);
    await workerStore.delete(inboundKey(job.blobId));
    await expect(createBlobStore(config).get(key)).rejects.toBeInstanceOf(BlobNotFoundError);

    expect(await download(result.fileIds[0] ?? '')).toEqual(new Uint8Array(FIXTURE));
  });
});
