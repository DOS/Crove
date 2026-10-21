// What changed since the last review (issue #944) on PostgreSQL 17: social.post.review_diff returns, per variant, the
// content its last decision was made on (the snapshot social.variant.decide keeps) next to its content now, so the
// review panel can show the edit; a first review has no decision, and another org reads nothing of the post.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { socialCommands, socialQueries, type PostView, type ReviewDiffVariant } from '@crove/mod-social';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('social review diff on PostgreSQL (#944)', () => {
  const dbName = `crove_test_social_review_diff_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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

  const person = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@review-diff.test`, name: null });

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
  const diff = (o: Org, user: string, postId: string) => rt.query<{ postId: string; variants: ReviewDiffVariant[] }>('social.post.review_diff', { postId }, { actor: asUser(user), orgId: o.orgId });
  const decide = async (o: Org, postId: string, decision: string, comment?: string) =>
    exec(o, o.owner, 'social.variant.decide', { postId, decision, variants: (await get(o, postId)).variants.map((v) => ({ variantId: v.id, revision: v.revision, contentHash: v.contentHash })), ...(comment ? { comment } : {}) });

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

  it('has no decision on a first review, then shows the content decided on next to the edit', async () => {
    const o = await org();
    const conn = await connection(o);
    const [first, second] = [await image(o.orgId), await image(o.orgId)];
    const { postId } = await exec<{ postId: string }>(o, o.member, 'social.post.create', {
      body: 'Khuyến mãi cuối tuần',
      media: [{ fileId: first, altText: 'Áo đỏ' }],
      channels: [{ connectionId: conn, settings: { firstComment: 'Xem thêm ở trang' } }],
    });
    await exec(o, o.member, 'social.post.submit', { postId });

    // A first review: nothing decided yet, so nothing to compare.
    let [row] = (await diff(o, o.owner, postId)).variants;
    expect(row?.lastDecision).toBeNull();
    expect(row?.current).toEqual({ body: 'Khuyến mãi cuối tuần', title: null, linkUrl: null, media: [{ fileId: first, altText: 'Áo đỏ', mime: 'image/jpeg' }], settings: { firstComment: 'Xem thêm ở trang' } });

    await decide(o, postId, 'changes_requested', 'Thêm chữ "lớn" và đổi ảnh');
    // Decided on the content as it is: unchanged.
    [row] = (await diff(o, o.member, postId)).variants;
    expect(row?.lastDecision).toMatchObject({ decision: 'changes_requested', decidedBy: o.owner, changed: false });
    expect(row?.lastDecision?.decidedByName).toEqual(expect.stringContaining('owner-'));
    expect(row?.lastDecision?.content).toEqual(row?.current);

    // The author edits the text, swaps the image and changes a setting.
    const post = await get(o, postId);
    await exec(o, o.member, 'social.post.update', { postId, revision: post.revision, body: 'Khuyến mãi lớn cuối tuần', media: [{ fileId: second, altText: null }] });
    const v = (await get(o, postId)).variants[0] as PostView['variants'][number];
    await exec(o, o.member, 'social.variant.update', { variantId: v.id, revision: v.revision, settings: { firstComment: 'Đặt hàng ở trang' } });
    await exec(o, o.member, 'social.post.submit', { postId });

    // A viewer may read it too, like the post.
    [row] = (await diff(o, o.viewer, postId)).variants;
    expect(row?.lastDecision).toMatchObject({
      decision: 'changes_requested',
      changed: true,
      content: { body: 'Khuyến mãi cuối tuần', title: null, linkUrl: null, media: [{ fileId: first, altText: 'Áo đỏ', mime: 'image/jpeg' }], settings: { firstComment: 'Xem thêm ở trang' } },
    });
    expect(row?.current).toEqual({ body: 'Khuyến mãi lớn cuối tuần', title: null, linkUrl: null, media: [{ fileId: second, altText: null, mime: 'image/jpeg' }], settings: { firstComment: 'Đặt hàng ở trang' } });

    // An approval of the edit is the newest decision, on the content as it is now.
    await decide(o, postId, 'approved');
    [row] = (await diff(o, o.owner, postId)).variants;
    expect(row?.lastDecision).toMatchObject({ decision: 'approved', changed: false, content: { body: 'Khuyến mãi lớn cuối tuần' } });
  });

  it('reads nothing of another org', async () => {
    const o = await org();
    const conn = await connection(o);
    const { postId } = await exec<{ postId: string }>(o, o.member, 'social.post.create', { body: 'Bài riêng', channels: [{ connectionId: conn }] });
    await exec(o, o.member, 'social.post.submit', { postId });
    await decide(o, postId, 'rejected');

    const other = await org();
    await expect(diff(other, other.owner, postId)).rejects.toMatchObject({ code: 'POST_NOT_FOUND' });
    // A member of the org who is not in the other one cannot read it there either.
    await expect(diff(other, o.owner, postId)).rejects.toBeDefined();
  });
});
