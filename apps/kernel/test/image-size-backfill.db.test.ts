// The backfill of Social image sizes (#668) on PostgreSQL 17: a pass reads the header of each Social image without a
// size and records it once, skips what it cannot read, and pauses between rounds. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own
// database.
import { randomUUID } from 'node:crypto';
import { fileKey, sha256Hex, type BlobStore } from '@crove/kernel-runtime';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { backfillImageSizes } from '../src/image-size-backfill.ts';
import { socialCommands, socialQueries } from '@crove/mod-social';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('image size backfill on PostgreSQL (#668)', () => {
  const dbName = `crove_test_image_sizes_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  let workerPool: pg.Pool;
  let workerRt: Runtime;
  let workerDb: Db;
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  const person = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@social.test`, name: null });

  async function org() {
    const owner = await person('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    const member = await person('member');
    const viewer = await person('viewer');
    await admin((c) => c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'viewer')", [orgId, member, viewer]));
    return { orgId, owner, member, viewer };
  }

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    const app = new URL(adminUrl);
    app.username = 'crove_app';
    app.password = 'test-app-pw';
    pool = createPool({ connectionString: app.toString(), max: 4 });
    db = createDb(pool);
    rt = new Runtime(db).register({ commands: [...kernelCommands, ...socialCommands], queries: [...kernelQueries({ inboundDomain: null }), ...socialQueries] });
    const worker = new URL(adminUrl);
    worker.username = 'crove_worker';
    worker.password = 'test-worker-pw';
    workerPool = createPool({ connectionString: worker.toString(), max: 2 });
    workerDb = createDb(workerPool);
    workerRt = new Runtime(workerDb).register({ commands: [...kernelCommands, ...socialCommands], queries: [...kernelQueries({ inboundDomain: null }), ...socialQueries] });
  });

  afterAll(async () => {
    await pool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  // A PNG header of the given size (enough for the probe), and a store that holds the bytes under their content key.
  const png = (width: number, height: number) => {
    const b = new Uint8Array(33);
    b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
    new DataView(b.buffer).setUint32(16, width);
    new DataView(b.buffer).setUint32(20, height);
    b[32] = Math.floor(Math.random() * 256);
    return b;
  };
  const blobs = new Map<string, Uint8Array>();
  const store = { get: async (key: string) => blobs.get(key) ?? new Uint8Array(0) } as unknown as BlobStore;

  async function image(orgId: string, owner: string, bytes: Uint8Array, type = 'image/png', source = 'social') {
    const id = randomUUID();
    const sha = sha256Hex(bytes);
    const key = fileKey(orgId, sha);
    blobs.set(key, bytes);
    await admin((c) =>
      c.query("INSERT INTO crove_kernel.file (org_id, id, sha256, storage_key, generation, filename, content_type, size_bytes, source, created_by) VALUES ($1, $2, $3, $4, $5, 'anh.png', $6, $7, $8, $9)", [orgId, id, sha, key, `content:${sha}`, type, bytes.byteLength, source, owner]),
    );
    return id;
  }
  const sizeOf = (id: string) => admin(async (c) => (await c.query<{ image_width: number | null; image_height: number | null }>('SELECT image_width, image_height FROM crove_kernel.file WHERE id = $1', [id])).rows[0]);

  it('records the size of Social images that have none, once, and leaves the rest', async () => {
    const o = await org();
    const old = await image(o.orgId, o.owner, png(1080, 1350));
    const broken = await image(o.orgId, o.owner, new Uint8Array([1, 2, 3, 4]));
    const notSocial = await image(o.orgId, o.owner, png(10, 10), 'image/png', 'upload');
    const state = { after: null as string | null, pausedUntil: 0 };
    const done = await backfillImageSizes({ runtime: workerRt, workerDb, store }, state);
    expect(done.recorded).toBeGreaterThanOrEqual(1);
    expect(done.unreadable).toBeGreaterThanOrEqual(1);
    expect(await sizeOf(old)).toEqual({ image_width: 1080, image_height: 1350 });
    expect(await sizeOf(broken)).toEqual({ image_width: null, image_height: null });
    expect(await sizeOf(notSocial)).toEqual({ image_width: null, image_height: null });
    // The round is over: the next pass waits a day instead of reading the unreadable file again.
    expect(state.after).toBeNull();
    expect(state.pausedUntil).toBeGreaterThan(Date.now());
    expect(await backfillImageSizes({ runtime: workerRt, workerDb, store }, state)).toEqual({ recorded: 0, unreadable: 0 });
  });

  it('is not open to the app role', async () => {
    const app = new URL(adminUrl);
    app.username = 'crove_app';
    app.password = 'test-app-pw';
    const c = new pg.Client({ connectionString: app.toString() });
    await c.connect();
    try {
      await expect(c.query('SELECT * FROM crove_kernel.image_size_due(NULL, 10)')).rejects.toMatchObject({ code: '42501' });
    } finally {
      await c.end();
    }
  });
});
