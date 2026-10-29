// LinkedIn and Bluesky link cards (#1498) on PostgreSQL 17: the card is part of the variant, its image is an image of
// the org uploaded for Social, of a type and size the channel takes, attached like the post's media, and the publish
// job may read it.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { socialCommands, socialQueries, type PostView } from '@crove/mod-social';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const LINK = 'https://tiem.example/khai-truong';

suite('social link cards on PostgreSQL (#1498)', () => {
  const dbName = `crove_test_social_link_card_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  // The publish job's runtime, as the worker login.
  let worker: Runtime;
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
    const owner = await upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `owner-${randomUUID().slice(0, 8)}@card.test`, name: null });
    const { orgId } = await createOrg(rt, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    return { orgId, owner };
  }

  async function connection(o: Org, provider: string) {
    const id = randomUUID();
    await admin((c) =>
      c.query('INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, $3, $4, $5, $6)', [o.orgId, id, provider, `acct-${id.slice(0, 8)}`, 'Kênh thử', o.owner]),
    );
    return id;
  }

  // An image as the upload route records it.
  async function image(o: Org, options: { sizeBytes?: number; contentType?: string; source?: string } = {}) {
    const id = randomUUID();
    const sha = createHash('sha256').update(id).digest('hex');
    await admin((c) =>
      c.query(
        `INSERT INTO crove_kernel.file (org_id, id, sha256, storage_key, generation, filename, content_type, size_bytes, source)
         VALUES ($1, $2, $3, $4, $5, 'the.png', $6, $7, $8)`,
        [o.orgId, id, sha, `org/${o.orgId}/${sha}`, `content:${sha}`, options.contentType ?? 'image/png', options.sizeBytes ?? 300_000, options.source ?? 'social'],
      ),
    );
    return id;
  }

  const exec = <O>(o: Org, name: string, input: unknown) => rt.execute<O>(name, input, { actor: asUser(o.owner), orgId: o.orgId });
  const get = (o: Org, postId: string) => rt.query<PostView>('social.post.get', { postId }, { actor: asUser(o.owner), orgId: o.orgId });
  const card = (thumbFileId?: string) => ({ title: 'Khai trương chi nhánh mới', description: 'Giảm 20% tuần đầu', ...(thumbFileId ? { thumbFileId } : {}) });

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
    const registry = { commands: [...kernelCommands, ...socialCommands], queries: [...kernelQueries({ inboundDomain: null }), ...socialQueries] };
    rt = new Runtime(db, { manifests: TEST_MANIFESTS }).register(registry);
    const workerUrl = new URL(adminUrl);
    workerUrl.username = 'crove_worker';
    workerUrl.password = 'test-worker-pw';
    workerPool = createPool({ connectionString: workerUrl.toString(), max: 2 });
    worker = new Runtime(createDb(workerPool), { manifests: TEST_MANIFESTS }).register(registry);
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

  it('keeps a card with its image on LinkedIn and Bluesky link posts, its file id in lower case, and the publish job may read the image', async () => {
    const o = await org();
    const thumb = await image(o);
    const linkedin = await connection(o, 'linkedin');
    const bluesky = await connection(o, 'bluesky');
    const settings = { linkCard: card(thumb.toUpperCase()) };
    const { postId } = await exec<{ postId: string }>(o, 'social.post.create', { body: 'Mời bạn ghé', linkUrl: LINK, channels: [{ connectionId: linkedin, settings }, { connectionId: bluesky, settings }] });
    const view = await get(o, postId);
    for (const v of view.variants) {
      expect(v.issues).toEqual([]);
      expect(v.settings.linkCard).toEqual(card(thumb));
    }
    const file = await worker.query<{ contentType: string }>('social.media.file', { fileId: thumb }, { actor: { type: 'system', component: 'social.publisher' }, orgId: o.orgId });
    expect(file.contentType).toBe('image/png');
    // Any other image of the org is not readable through it.
    const other = await image(o);
    await expect(worker.query('social.media.file', { fileId: other }, { actor: { type: 'system', component: 'social.publisher' }, orgId: o.orgId })).rejects.toMatchObject({ code: 'MEDIA_NOT_FOUND' });
  });

  it("refuses an image over Bluesky's 1,000,000 bytes, of another type or not uploaded for Social, and a card of another shape", async () => {
    const o = await org();
    const linkedin = await connection(o, 'linkedin');
    const bluesky = await connection(o, 'bluesky');
    const big = await image(o, { sizeBytes: 1_500_000 });
    const create = (connectionId: string, linkCard: unknown) => exec<{ postId: string }>(o, 'social.post.create', { body: 'Mời bạn ghé', linkUrl: LINK, channels: [{ connectionId, settings: { linkCard } }] });
    await expect(create(bluesky, card(big))).rejects.toMatchObject({ code: 'LINK_CARD_THUMB_TOO_LARGE', status: 422, details: { limit: 1_000_000, actual: 1_500_000 } });
    // LinkedIn takes it.
    await create(linkedin, card(big));
    await expect(create(linkedin, card(await image(o, { contentType: 'image/webp' })))).rejects.toMatchObject({ code: 'LINK_CARD_THUMB_TYPE' });
    await expect(create(linkedin, card(await image(o, { source: 'upload' })))).rejects.toMatchObject({ code: 'MEDIA_NOT_FOUND' });
    await expect(create(linkedin, card(randomUUID()))).rejects.toMatchObject({ code: 'MEDIA_NOT_FOUND' });
    await expect(create(linkedin, { title: '' })).rejects.toMatchObject({ code: 'LINK_CARD_INVALID' });
  });

  it('refuses an archived image on a new card, and keeps one the card already shows', async () => {
    const o = await org();
    const linkedin = await connection(o, 'linkedin');
    const kept = await image(o);
    const gone = await image(o);
    const { postId } = await exec<{ postId: string }>(o, 'social.post.create', { body: 'Mời bạn ghé', linkUrl: LINK, channels: [{ connectionId: linkedin, settings: { linkCard: card(kept) } }] });
    await exec(o, 'social.media.archive', { fileIds: [kept, gone] });
    const variant = (await get(o, postId)).variants[0] as PostView['variants'][number];
    await expect(exec(o, 'social.variant.update', { variantId: variant.id, revision: variant.revision, settings: { linkCard: card(gone) } })).rejects.toMatchObject({ code: 'MEDIA_NOT_ALLOWED', details: { fileId: gone, reason: 'archived' } });
    await exec(o, 'social.variant.update', { variantId: variant.id, revision: variant.revision, settings: { linkCard: { ...card(kept), title: 'Tiêu đề mới' } } });
    expect((await get(o, postId)).variants[0]?.settings.linkCard).toMatchObject({ title: 'Tiêu đề mới', thumbFileId: kept });
  });

  it('flags a card on a post with images, without a link, or on a channel that builds its own card', async () => {
    const o = await org();
    const linkedin = await connection(o, 'linkedin');
    const threads = await connection(o, 'threads');
    const photo = await image(o, { contentType: 'image/jpeg' });
    const { postId } = await exec<{ postId: string }>(o, 'social.post.create', { body: 'Mời bạn ghé', media: [{ fileId: photo }], linkUrl: LINK, channels: [{ connectionId: linkedin, settings: { linkCard: card() } }, { connectionId: threads, settings: { linkCard: card() } }] });
    const issues = Object.fromEntries((await get(o, postId)).variants.map((v) => [v.provider, v.issues.map((i) => i.code)]));
    expect(issues).toEqual({ linkedin: ['LINK_CARD_WITH_MEDIA'], threads: ['LINK_CARD_NOT_SUPPORTED'] });
    const plain = await exec<{ postId: string }>(o, 'social.post.create', { body: 'Mời bạn ghé', channels: [{ connectionId: linkedin, settings: { linkCard: card() } }] });
    expect((await get(o, plain.postId)).variants[0]?.issues.map((i) => i.code)).toEqual(['LINK_CARD_NEEDS_LINK']);
  });
});
