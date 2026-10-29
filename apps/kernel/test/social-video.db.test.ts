// Video on Crove Social posts on PostgreSQL 17 (Social plan S9, issue #410): a post can carry a video uploaded for
// posts, its duration (read by the server at upload) feeds the channel checks, a channel whose Crove adapter cannot
// post video says so, and the library lists videos with their length.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { socialCommands, socialQueries, type LibraryItem, type PostView } from '@crove/mod-social';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('social video posts on PostgreSQL (S9)', () => {
  const dbName = `crove_test_social_video_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  type Org = { orgId: string; owner: string };

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  async function org(): Promise<Org> {
    const owner = await upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `owner-${randomUUID().slice(0, 8)}@video.test`, name: null });
    const { orgId } = await createOrg(rt, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    return { orgId, owner };
  }

  async function connection(o: Org, provider: string) {
    const id = randomUUID();
    await admin((c) =>
      c.query('INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, $3, $4, $5, $6)', [
        o.orgId,
        id,
        provider,
        `acct-${id.slice(0, 8)}`,
        'Kênh thử',
        o.owner,
      ]),
    );
    return id;
  }

  // A video as the upload route records it: source social, the type and duration it read.
  async function video(o: Org, durationMs: number) {
    const id = randomUUID();
    const sha = createHash('sha256').update(id).digest('hex');
    await admin((c) =>
      c.query(
        `INSERT INTO crove_kernel.file (org_id, id, sha256, storage_key, generation, filename, content_type, size_bytes, source, duration_ms)
         VALUES ($1, $2, $3, $4, $5, 'khai-truong.mp4', 'video/mp4', 20000000, 'social', $6)`,
        [o.orgId, id, sha, `org/${o.orgId}/${sha}`, `content:${sha}`, durationMs],
      ),
    );
    return id;
  }

  const exec = <O>(o: Org, name: string, input: unknown) => rt.execute<O>(name, input, { actor: asUser(o.owner), orgId: o.orgId });
  const get = (o: Org, postId: string) => rt.query<PostView>('social.post.get', { postId }, { actor: asUser(o.owner), orgId: o.orgId });

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
    rt = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands, ...socialCommands], queries: [...kernelQueries({ inboundDomain: null }), ...socialQueries] });
  });

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  // An image as the upload route records it with the size it read from the header (#636).
  async function image(o: Org, width: number | null, height: number | null) {
    const id = randomUUID();
    const sha = createHash('sha256').update(id).digest('hex');
    await admin((c) =>
      c.query(
        `INSERT INTO crove_kernel.file (org_id, id, sha256, storage_key, generation, filename, content_type, size_bytes, source, image_width, image_height)
         VALUES ($1, $2, $3, $4, $5, 'anh.jpg', 'image/jpeg', 200000, 'social', $6, $7)`,
        [o.orgId, id, sha, `org/${o.orgId}/${sha}`, `content:${sha}`, width, height],
      ),
    );
    return id;
  }

  it("checks an image's shape and width for Instagram and Threads, and swaps in a cropped one (#636)", async () => {
    const o = await org();
    const story = await image(o, 1080, 1920);
    const instagram = await connection(o, 'instagram');
    const threads = await connection(o, 'threads');
    const { postId } = await exec<{ postId: string }>(o, 'social.post.create', { body: 'Ảnh dọc', media: [{ fileId: story }], channels: [{ connectionId: instagram }, { connectionId: threads }] });
    const view = await get(o, postId);
    expect(view.media[0]).toMatchObject({ fileId: story, width: 1080, height: 1920 });
    const issues = () => get(o, postId).then((p) => Object.fromEntries(p.variants.map((v) => [v.provider, v.issues])));
    expect(await issues()).toEqual({ instagram: [{ code: 'IMAGE_RATIO_NOT_ALLOWED', field: 'media.0', limit: null, actual: 563 }], threads: [] });
    // The crop, uploaded as a new file of 4:5: nothing to fix.
    const cropped = await image(o, 1080, 1350);
    const fresh = await get(o, postId);
    await exec(o, 'social.post.update', { postId, revision: fresh.revision, media: [{ fileId: cropped }] });
    expect(await issues()).toEqual({ instagram: [], threads: [] });
    // An image whose size is unknown (uploaded before sizes were read) is not checked.
    const old = await image(o, null, null);
    const again = await get(o, postId);
    await exec(o, 'social.post.update', { postId, revision: again.revision, media: [{ fileId: old }] });
    expect(await issues()).toEqual({ instagram: [], threads: [] });
  });

  it('puts a video on a post, checks it per channel with its duration, and submits only where it fits', async () => {
    const o = await org();
    const clip = await video(o, 12_500);
    const sandbox = await connection(o, 'sandbox');
    // A Zalo OA video article needs a title and a cover image (#1429).
    const zalo = await connection(o, 'zalo_oa');
    const { postId } = await exec<{ postId: string }>(o, 'social.post.create', { body: 'Khai trương', media: [{ fileId: clip }], channels: [{ connectionId: sandbox }, { connectionId: zalo }] });
    const view = await get(o, postId);
    expect(view.media).toEqual([{ fileId: clip, altText: null, mime: 'video/mp4', sizeBytes: 20_000_000, durationMs: 12_500, width: null, height: null, filename: null }]);
    const issues = Object.fromEntries(view.variants.map((v) => [v.provider, v.issues.map((i) => i.code)]));
    expect(issues).toEqual({ sandbox: [], zalo_oa: ['TITLE_REQUIRED', 'COVER_REQUIRED'] });
    await expect(exec(o, 'social.post.submit', { postId })).rejects.toMatchObject({ code: 'VARIANT_INVALID' });
    await exec(o, 'social.post.submit', { postId, variantIds: [view.variants.find((v) => v.provider === 'sandbox')?.id] });
    expect((await get(o, postId)).variants.find((v) => v.provider === 'sandbox')?.status).toBe('in_review');
  });

  it('flags a video too long for the channel, from the duration read at upload', async () => {
    const o = await org();
    const long = await video(o, 601_000);
    const tiktok = await connection(o, 'tiktok');
    const { postId } = await exec<{ postId: string }>(o, 'social.post.create', { body: '', media: [{ fileId: long }], channels: [{ connectionId: tiktok }] });
    expect((await get(o, postId)).variants[0]?.issues.map((i) => i.code)).toEqual(['VIDEO_TOO_LONG', 'PRIVACY_REQUIRED']);
  });

  it('lists videos in the library with their duration', async () => {
    const o = await org();
    const clip = await video(o, 30_000);
    const page = await rt.query<{ items: LibraryItem[] }>('social.media.list', {}, { actor: asUser(o.owner), orgId: o.orgId });
    expect(page.items.map((i) => [i.fileId, i.mime, i.durationMs])).toEqual([[clip, 'video/mp4', 30_000]]);
  });
});
