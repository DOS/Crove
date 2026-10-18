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
    rt = new Runtime(db).register({ commands: [...kernelCommands, ...socialCommands], queries: [...kernelQueries({ inboundDomain: null }), ...socialQueries] });
  });

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('puts a video on a post, checks it per channel with its duration, and submits only where it fits', async () => {
    const o = await org();
    const clip = await video(o, 12_500);
    const sandbox = await connection(o, 'sandbox');
    // X takes video, and its Crove adapter does not post it yet.
    const x = await connection(o, 'x');
    const { postId } = await exec<{ postId: string }>(o, 'social.post.create', { body: 'Khai trương', media: [{ fileId: clip }], channels: [{ connectionId: sandbox }, { connectionId: x }] });
    const view = await get(o, postId);
    expect(view.media).toEqual([{ fileId: clip, altText: null, mime: 'video/mp4', sizeBytes: 20_000_000, durationMs: 12_500 }]);
    const issues = Object.fromEntries(view.variants.map((v) => [v.provider, v.issues.map((i) => i.code)]));
    expect(issues).toEqual({ sandbox: [], x: ['VIDEO_NOT_SUPPORTED_YET'] });
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
