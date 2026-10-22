// The version history of a post (issue #1021) on PostgreSQL 17: each save that changes a post's content appends a
// version in the save's transaction (the first one also keeps the content before it), at most 50 per post;
// social.post.restore_version saves one again as a new edit, so an approved channel needs approval again, a published
// channel keeps what went out and a post with nothing left to edit is refused; viewers may read but not restore, and
// another org sees nothing.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { MAX_VERSIONS_PER_POST, socialCommands, socialQueries, type ActivityItem, type PostView, type VersionView } from '@crove/mod-social';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const HOUR = 3_600_000;

suite('social post versions on PostgreSQL (#1021)', () => {
  const dbName = `crove_test_social_post_versions_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  type Org = { orgId: string; owner: string; member: string; viewer: string };

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  const person = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@post-versions.test`, name: null });

  async function org(): Promise<Org> {
    const owner = await person('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    const member = await person('member');
    const viewer = await person('viewer');
    await admin((c) => c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'viewer')", [orgId, member, viewer]));
    return { orgId, owner, member, viewer };
  }

  async function connection(o: Org) {
    const id = randomUUID();
    await admin((c) =>
      c.query('INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, $3, $4, $5, $6)', [
        o.orgId,
        id,
        'sandbox',
        `acct-${id.slice(0, 8)}`,
        'Kênh thử',
        o.owner,
      ]),
    );
    return id;
  }

  // An image uploaded for Social, as the upload route records it.
  async function image(orgId: string) {
    const id = randomUUID();
    const sha = createHash('sha256').update(id).digest('hex');
    await admin((c) =>
      c.query(
        `INSERT INTO crove_kernel.file (org_id, id, sha256, storage_key, generation, filename, content_type, size_bytes, source)
         VALUES ($1, $2, $3, $4, $5, 'anh.jpg', 'image/jpeg', 120000, 'social')`,
        [orgId, id, sha, `org/${orgId}/${sha}`, `content:${sha}`],
      ),
    );
    return id;
  }

  const exec = <O>(o: Org, user: string, name: string, input: unknown) => rt.execute<O>(name, input, { actor: asUser(user), orgId: o.orgId });
  const get = (o: Org, postId: string) => rt.query<PostView>('social.post.get', { postId }, { actor: asUser(o.owner), orgId: o.orgId });
  const versions = async (o: Org, user: string, postId: string) => (await rt.query<{ versions: VersionView[] }>('social.post.versions', { postId }, { actor: asUser(user), orgId: o.orgId })).versions;
  const edit = async (o: Org, postId: string, body: string) => exec(o, o.member, 'social.post.update', { postId, revision: (await get(o, postId)).revision, body });
  const restore = async (o: Org, user: string, postId: string, versionId: string, variantRevisions?: Record<string, number>) =>
    exec<{ revision: number; changedVariants: string[]; kept: string[] }>(o, user, 'social.post.restore_version', {
      postId,
      versionId,
      revision: (await get(o, postId)).revision,
      ...(variantRevisions ? { variantRevisions } : {}),
    });
  const countVersions = async (o: Org, postId: string) =>
    Number((await admin((c) => c.query<{ n: string }>('SELECT count(*) AS n FROM crove_social.post_version WHERE org_id = $1 AND post_id = $2', [o.orgId, postId]))).rows[0]?.n);
  const decide = async (o: Org, postId: string, decision: string) =>
    exec(o, o.owner, 'social.variant.decide', { postId, decision, variants: (await get(o, postId)).variants.filter((v) => v.status === 'in_review').map((v) => ({ variantId: v.id, revision: v.revision, contentHash: v.contentHash })) });
  async function post(o: Org, body: string, connections: string[]) {
    const { postId } = await exec<{ postId: string }>(o, o.member, 'social.post.create', { body, channels: connections.map((connectionId) => ({ connectionId })) });
    return postId;
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
  });

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('keeps the content before the first edit and each save that changes it, newest first', async () => {
    const o = await org();
    const conn = await connection(o);
    const [first, second] = [await image(o.orgId), await image(o.orgId)];
    const { postId } = await exec<{ postId: string }>(o, o.member, 'social.post.create', { body: 'Bản đầu', media: [{ fileId: first, altText: 'Áo đỏ' }], channels: [{ connectionId: conn }] });
    expect(await versions(o, o.viewer, postId)).toEqual([]);

    await exec(o, o.member, 'social.post.update', { postId, revision: 1, body: 'Bản hai', media: [{ fileId: second, altText: null }] });
    let list = await versions(o, o.viewer, postId);
    expect(list.map((v) => [v.number, v.createdBy])).toEqual([
      [2, o.member],
      [1, null],
    ]);
    expect(list[0]?.createdByName).toEqual(expect.stringContaining('member-'));
    const variantId = (await get(o, postId)).variants[0]?.id as string;
    expect(list[1]?.variants).toEqual([{ variantId, content: { body: 'Bản đầu', title: null, linkUrl: null, media: [{ fileId: first, altText: 'Áo đỏ', mime: 'image/jpeg' }], settings: {} } }]);
    expect(list[0]?.variants[0]?.content).toMatchObject({ body: 'Bản hai', media: [{ fileId: second, altText: null, mime: 'image/jpeg' }] });

    // A save that changes no content (the time zone) keeps no version; a channel's own text does.
    await exec(o, o.member, 'social.post.update', { postId, revision: 2, timeZone: 'Asia/Bangkok' });
    expect(await versions(o, o.viewer, postId)).toHaveLength(2);
    const v = (await get(o, postId)).variants[0] as PostView['variants'][number];
    await exec(o, o.member, 'social.variant.update', { variantId: v.id, revision: v.revision, body: 'Riêng cho kênh', settings: { firstComment: 'Xem thêm' } });
    list = await versions(o, o.viewer, postId);
    expect(list.map((x) => x.number)).toEqual([3, 2, 1]);
    expect(list[0]?.variants[0]?.content).toMatchObject({ body: 'Riêng cho kênh', settings: { firstComment: 'Xem thêm' } });
  });

  it(`keeps the newest ${MAX_VERSIONS_PER_POST} versions of a post and deletes older ones in the same save`, async () => {
    const o = await org();
    const conn = await connection(o);
    const postId = await post(o, 'Lần 0', [conn]);
    const other = await post(o, 'Bài khác', [conn]);
    await edit(o, other, 'Bài khác, đã sửa');
    for (let i = 1; i <= 60; i++) await edit(o, postId, `Lần ${i}`);
    const list = await versions(o, o.member, postId);
    // 61 versions were written (the content before the first edit, then 60 edits); the oldest 11 are gone.
    expect(list).toHaveLength(MAX_VERSIONS_PER_POST);
    expect(list[0]).toMatchObject({ number: 61, variants: [{ content: { body: 'Lần 60' } }] });
    expect(list.at(-1)).toMatchObject({ number: 12, variants: [{ content: { body: 'Lần 11' } }] });
    const { rows } = await admin((c) => c.query<{ n: string }>('SELECT count(*) AS n FROM crove_social.post_version WHERE org_id = $1 AND post_id = $2', [o.orgId, postId]));
    expect(Number(rows[0]?.n)).toBe(MAX_VERSIONS_PER_POST);
    // Another post's history is its own.
    expect((await versions(o, o.member, other)).map((v) => v.number)).toEqual([2, 1]);
  });

  it('restores a version as a new edit: an approved channel goes back to draft and needs approval again', async () => {
    const o = await org();
    const conn = await connection(o);
    const postId = await post(o, 'Nội dung gốc', [conn]);
    await edit(o, postId, 'Nội dung sai');
    await exec(o, o.member, 'social.post.submit', { postId });
    await decide(o, postId, 'approved');
    const approved = (await get(o, postId)).variants[0] as PostView['variants'][number];
    expect(approved.status).toBe('approved');

    const original = (await versions(o, o.member, postId)).find((v) => v.number === 1) as VersionView;
    const result = await restore(o, o.member, postId, original.id);
    expect(result.changedVariants).toEqual([approved.id]);
    expect(result.kept).toEqual([]);
    const view = await get(o, postId);
    expect(view.body).toBe('Nội dung gốc');
    const v = view.variants[0] as PostView['variants'][number];
    expect(v).toMatchObject({ status: 'draft', revision: approved.revision + 1, effective: { body: 'Nội dung gốc' } });
    // The approval was of the other content: scheduling waits for a new one.
    await expect(exec(o, o.owner, 'social.variant.schedule', { postId, variantIds: [v.id], at: new Date(Date.now() + HOUR).toISOString() })).rejects.toMatchObject({ status: 409 });
    // The restore is a version of its own, and the timeline says so.
    expect((await versions(o, o.member, postId)).map((x) => [x.number, x.createdBy, x.variants[0]?.content.body])).toEqual([
      [3, o.member, 'Nội dung gốc'],
      [2, o.member, 'Nội dung sai'],
      [1, null, 'Nội dung gốc'],
    ]);
    const { items } = await rt.query<{ items: ActivityItem[] }>('social.post.activity', { postId }, { actor: asUser(o.viewer), orgId: o.orgId });
    expect(items.filter((i) => i.kind === 'restored')).toMatchObject([{ userId: o.member }]);
    // Reviewed again, it schedules.
    await exec(o, o.member, 'social.post.submit', { postId });
    await decide(o, postId, 'approved');
    await exec(o, o.owner, 'social.variant.schedule', { postId, variantIds: [v.id], at: new Date(Date.now() + HOUR).toISOString() });
    expect((await get(o, postId)).variants[0]?.status).toBe('scheduled');
  });

  it("restores a channel's own text, settings and images, and leaves a channel added later as it is", async () => {
    const o = await org();
    const [a, b] = [await connection(o), await connection(o)];
    const pic = await image(o.orgId);
    const postId = await post(o, 'Chung', [a]);
    const va = (await get(o, postId)).variants[0] as PostView['variants'][number];
    await exec(o, o.member, 'social.variant.update', { variantId: va.id, revision: va.revision, body: 'Riêng kênh A', settings: { firstComment: 'Bình luận đầu' }, media: [{ fileId: pic, altText: 'Ảnh riêng' }] });
    const saved = (await versions(o, o.member, postId))[0] as VersionView;
    const now = (await get(o, postId)).variants[0] as PostView['variants'][number];
    await exec(o, o.member, 'social.variant.update', { variantId: now.id, revision: now.revision, body: null, settings: {}, media: null });
    await exec(o, o.member, 'social.post.add_channels', { postId, channels: [{ connectionId: b, body: 'Riêng kênh B' }] });

    const result = await restore(o, o.member, postId, saved.id);
    expect(result.changedVariants).toEqual([va.id]);
    const view = await get(o, postId);
    expect(view.variants.find((v) => v.id === va.id)).toMatchObject({ effective: { body: 'Riêng kênh A' }, settings: { firstComment: 'Bình luận đầu' }, media: [{ fileId: pic, altText: 'Ảnh riêng' }] });
    expect(view.variants.find((v) => v.id !== va.id)).toMatchObject({ effective: { body: 'Riêng kênh B' } });
    // Restoring the content the post has again changes nothing and keeps no version.
    const count = (await versions(o, o.member, postId)).length;
    const again = await restore(o, o.member, postId, saved.id);
    expect(again.changedVariants).toEqual([]);
    expect(await versions(o, o.member, postId)).toHaveLength(count);
  });

  it('never restores into a published channel post', async () => {
    const o = await org();
    const [a, b] = [await connection(o), await connection(o)];
    // One channel, published: nothing to restore into.
    const solo = await post(o, 'Bản một', [a]);
    await edit(o, solo, 'Bản đã đăng');
    const soloVariant = (await get(o, solo)).variants[0]?.id as string;
    await admin((c) => c.query("UPDATE crove_social.post_variant SET status = 'published', published_at = now() WHERE id = $1", [soloVariant]));
    const first = (await versions(o, o.member, solo)).find((v) => v.number === 1) as VersionView;
    await expect(restore(o, o.member, solo, first.id)).rejects.toMatchObject({ code: 'POST_PUBLISHED', status: 409 });
    expect((await get(o, solo)).variants[0]).toMatchObject({ status: 'published', effective: { body: 'Bản đã đăng' } });
    expect(await versions(o, o.member, solo)).toHaveLength(2);

    // Two channels, one published: the other is restored, the published one keeps what went out.
    const pair = await post(o, 'Bản một', [a, b]);
    await edit(o, pair, 'Bản hai');
    const [pa, pb] = (await get(o, pair)).variants as [PostView['variants'][number], PostView['variants'][number]];
    await admin((c) => c.query("UPDATE crove_social.post_variant SET status = 'published', published_at = now() WHERE id = $1", [pa.id]));
    const one = (await versions(o, o.member, pair)).find((v) => v.number === 1) as VersionView;
    const result = await restore(o, o.member, pair, one.id);
    expect(result).toMatchObject({ changedVariants: [pb.id], kept: [pa.id] });
    const view = await get(o, pair);
    expect(view.variants.find((v) => v.id === pa.id)).toMatchObject({ status: 'published', effective: { body: 'Bản hai' } });
    expect(view.variants.find((v) => v.id === pb.id)).toMatchObject({ status: 'draft', effective: { body: 'Bản một' } });
  });

  it('lets members restore and viewers only read, refuses a stale revision and an unknown version', async () => {
    const o = await org();
    const conn = await connection(o);
    const postId = await post(o, 'Một', [conn]);
    await edit(o, postId, 'Hai');
    const [, oldest] = (await versions(o, o.viewer, postId)) as [VersionView, VersionView];
    await expect(restore(o, o.viewer, postId, oldest.id)).rejects.toMatchObject({ status: 403 });
    await expect(exec(o, o.member, 'social.post.restore_version', { postId, versionId: oldest.id, revision: 1 })).rejects.toMatchObject({ code: 'STALE_REVISION' });
    await expect(restore(o, o.member, postId, randomUUID())).rejects.toMatchObject({ code: 'VERSION_NOT_FOUND', status: 404 });
    await restore(o, o.owner, postId, oldest.id);
    expect((await get(o, postId)).body).toBe('Một');
  });

  it('keeps each org to its own versions', async () => {
    const a = await org();
    const b = await org();
    const postA = await post(a, 'Của A', [await connection(a)]);
    await edit(a, postA, 'Của A, đã sửa');
    const postB = await post(b, 'Của B', [await connection(b)]);
    await edit(b, postB, 'Của B, đã sửa');
    const [, versionA] = (await versions(a, a.member, postA)) as [VersionView, VersionView];

    // B reads nothing of A's post, and cannot restore A's version into its own post or into A's.
    await expect(versions(b, b.owner, postA)).rejects.toMatchObject({ code: 'POST_NOT_FOUND' });
    await expect(restore(b, b.owner, postB, versionA.id)).rejects.toMatchObject({ code: 'VERSION_NOT_FOUND' });
    await expect(exec(b, b.owner, 'social.post.restore_version', { postId: postA, versionId: versionA.id, revision: 2 })).rejects.toMatchObject({ code: 'POST_NOT_FOUND' });
    expect((await get(b, postB)).body).toBe('Của B, đã sửa');
    expect((await versions(b, b.owner, postB)).map((v) => v.id)).not.toContain(versionA.id);
    const { rows } = await admin((c) => c.query<{ n: string }>('SELECT count(*) AS n FROM crove_social.post_version WHERE org_id = $1', [a.orgId]));
    expect(Number(rows[0]?.n)).toBe(2);
  });

  it("refuses another post's version, a channel in flight and a channel edited since it was shown", async () => {
    const o = await org();
    const conn = await connection(o);
    const one = await post(o, 'Bài một', [conn]);
    await edit(o, one, 'Bài một, đã sửa');
    const two = await post(o, 'Bài hai', [conn]);
    await edit(o, two, 'Bài hai, đã sửa');
    const [, ofOne] = (await versions(o, o.member, one)) as [VersionView, VersionView];
    await expect(restore(o, o.member, two, ofOne.id)).rejects.toMatchObject({ code: 'VERSION_NOT_FOUND', status: 404 });
    expect((await get(o, two)).body).toBe('Bài hai, đã sửa');

    // A channel publishing now: the restore would change its content, so it is refused and nothing is written.
    const flying = (await get(o, one)).variants[0]?.id as string;
    await admin((c) => c.query("UPDATE crove_social.post_variant SET status = 'publishing' WHERE id = $1", [flying]));
    await expect(restore(o, o.member, one, ofOne.id)).rejects.toMatchObject({ code: 'VARIANT_IN_FLIGHT', status: 409 });
    expect((await get(o, one)).body).toBe('Bài một, đã sửa');
    expect(await countVersions(o, one)).toBe(2);

    // The page showed a channel revision that another tab has moved on from.
    const [, ofTwo] = (await versions(o, o.member, two)) as [VersionView, VersionView];
    const shown = (await get(o, two)).variants[0] as PostView['variants'][number];
    await exec(o, o.owner, 'social.variant.update', { variantId: shown.id, revision: shown.revision, body: 'Sửa ở tab khác' });
    await expect(restore(o, o.member, two, ofTwo.id, { [shown.id]: shown.revision })).rejects.toMatchObject({ code: 'STALE_REVISION', status: 409 });
    await expect(restore(o, o.member, two, ofTwo.id, { [randomUUID()]: 1 })).rejects.toMatchObject({ code: 'STALE_REVISION' });
    const fresh = (await get(o, two)).variants[0] as PostView['variants'][number];
    await restore(o, o.member, two, ofTwo.id, { [fresh.id]: fresh.revision });
    expect((await get(o, two)).variants[0]?.effective.body).toBe('Bài hai');
  });

  it('resolves the files of a version again and refuses a version that does not pass the edit schemas', async () => {
    const o = await org();
    const conn = await connection(o);
    const pic = await image(o.orgId);
    const { postId } = await exec<{ postId: string }>(o, o.member, 'social.post.create', { body: 'Có ảnh', media: [{ fileId: pic, altText: null }], channels: [{ connectionId: conn }] });
    await exec(o, o.member, 'social.post.update', { postId, revision: 1, body: 'Không ảnh', media: [] });
    const [, withImage] = (await versions(o, o.member, postId)) as [VersionView, VersionView];
    await admin((c) => c.query('DELETE FROM crove_kernel.file WHERE org_id = $1 AND id = $2', [o.orgId, pic]));
    await expect(restore(o, o.member, postId, withImage.id)).rejects.toMatchObject({ code: 'MEDIA_NOT_FOUND', status: 404 });

    // Rows written past the commands: a link an edit refuses, a channel setting that is not an object.
    const tampered = async (number: number, columns: { link_url?: string; variants?: string }) => {
      const { rows } = await admin((c) =>
        c.query<{ id: string }>(
          `INSERT INTO crove_social.post_version (org_id, post_id, number, revision, body, link_url, variants, created_by)
           VALUES ($1, $2, $3, 1, 'Sửa tay', $4, $5::jsonb, $6) RETURNING id`,
          [o.orgId, postId, number, columns.link_url ?? null, columns.variants ?? '[]', o.member],
        ),
      );
      return rows[0]?.id as string;
    };
    const badLink = await tampered(90, { link_url: 'javascript:alert(1)' });
    const variantId = (await get(o, postId)).variants[0]?.id as string;
    const badSettings = await tampered(91, { variants: JSON.stringify([{ variantId, body: null, title: null, linkUrl: null, settings: 'x', media: null }]) });
    for (const id of [badLink, badSettings]) await expect(restore(o, o.member, postId, id)).rejects.toMatchObject({ code: 'VERSION_INVALID', status: 422 });
    expect((await get(o, postId)).body).toBe('Không ảnh');
  });

  it('restores the base content of a post without channels', async () => {
    const o = await org();
    const postId = randomUUID();
    await admin(async (c) => {
      await c.query("INSERT INTO crove_social.post (org_id, id, body, author_user_id) VALUES ($1, $2, 'Bây giờ', $3)", [o.orgId, postId, o.member]);
      await c.query("INSERT INTO crove_social.post_version (org_id, post_id, number, revision, body, created_by) VALUES ($1, $2, 1, 1, 'Ngày trước', $3)", [o.orgId, postId, o.member]);
    });
    const [saved] = (await versions(o, o.member, postId)) as [VersionView];
    const result = await restore(o, o.member, postId, saved.id);
    expect(result).toMatchObject({ changedVariants: [], kept: [] });
    expect((await get(o, postId)).body).toBe('Ngày trước');
    expect((await versions(o, o.member, postId)).map((v) => v.number)).toEqual([2, 1]);
  });
});
