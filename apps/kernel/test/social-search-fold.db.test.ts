// Social search without Vietnamese marks (#1360) on PostgreSQL 17: "dien thoai" finds "Điện thoại" in a post's text and
// title, in a channel's own text and in media file names (NFD names from a Mac too); a search with marks still matches;
// a term with nothing left once folded matches as typed; a member limited to some channels (#1081) finds nothing on
// another channel, its own text or its own media; find and replace (#1144) stays exact; and a search over an org of
// 5,000 posts answers within 200 ms at p95. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
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
// The seeded org's size, from the issue's acceptance criterion.
const POSTS = 5_000;

suite('social search without marks on PostgreSQL (#1360)', () => {
  const dbName = `crove_test_social_search_fold_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  type Org = { orgId: string; owner: string; admin: string; member: string; a: string; b: string };

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  const person = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@search-fold.test`, name: null });

  async function connection(orgId: string, owner: string, name: string) {
    const id = randomUUID();
    await admin((c) =>
      c.query('INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, $3, $4, $5, $6)', [orgId, id, 'sandbox', `acct-${id.slice(0, 8)}`, name, owner]),
    );
    return id;
  }

  // An org with an owner, an admin and a member, and two channels A and B.
  async function org(): Promise<Org> {
    const owner = await person('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    const adminUser = await person('admin');
    const member = await person('member');
    await admin((c) => c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member')", [orgId, adminUser, member]));
    return { orgId, owner, admin: adminUser, member, a: await connection(orgId, owner, 'Kênh A'), b: await connection(orgId, owner, 'Kênh B') };
  }

  const exec = <O>(o: Org, user: string, name: string, input: unknown) => rt.execute<O>(name, input, { actor: asUser(user), orgId: o.orgId });
  const query = <O>(o: Org, user: string, name: string, input: unknown) => rt.query<O>(name, input, { actor: asUser(user), orgId: o.orgId });
  async function post(o: Org, connections: string[], body: string, title?: string) {
    const { postId } = await exec<{ postId: string }>(o, o.owner, 'social.post.create', { body, ...(title ? { title } : {}), channels: connections.map((connectionId) => ({ connectionId })) });
    return postId;
  }
  const found = async (o: Org, user: string, search: string) => (await query<PostView[]>(o, user, 'social.post.list', { search })).map((p) => p.id).sort();
  const variantOn = async (o: Org, postId: string, connectionId: string) => {
    const view = await query<PostView>(o, o.owner, 'social.post.get', { postId });
    const v = view.variants.find((x) => x.connectionId === connectionId);
    if (!v) throw new Error('no variant on that channel');
    return v;
  };

  // A stored social upload, as the upload route records it.
  async function file(o: Org, filename: string) {
    const id = randomUUID();
    const sha = createHash('sha256').update(id).digest('hex');
    await admin((c) =>
      c.query(
        `INSERT INTO crove_kernel.file (org_id, id, sha256, storage_key, generation, filename, content_type, size_bytes, source)
         VALUES ($1, $2, $3, $4, $5, $6, 'image/jpeg', 120000, 'social')`,
        [o.orgId, id, sha, `org/${o.orgId}/${sha}`, `content:${sha}`, filename],
      ),
    );
    return id;
  }
  const media = async (o: Org, user: string, input: Record<string, unknown>) => (await query<{ items: LibraryItem[] }>(o, user, 'social.media.list', input)).items.map((i) => i.filename).sort();

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

  it('finds posts by their text, title and a channel’s own text without marks, and with them', async () => {
    const o = await org();
    const phone = await post(o, [o.a], 'Điện thoại mới về, giảm 20% 🔥');
    const promo = await post(o, [o.a], 'Ưu đãi cuối tuần', 'Khuyến mãi tháng 11');
    const own = await post(o, [o.a, o.b], 'Phụ kiện');
    const other = await post(o, [o.a], 'Áo thun mùa hè');
    const vb = await variantOn(o, own, o.b);
    await exec(o, o.owner, 'social.variant.update', { variantId: vb.id, revision: vb.revision, body: 'Ốp lưng điện thoại chính hãng' });

    // Without marks, in any case.
    expect(await found(o, o.owner, 'dien thoai')).toEqual([phone, own].sort());
    expect(await found(o, o.owner, 'DIEN THOAI')).toEqual([phone, own].sort());
    expect(await found(o, o.owner, 'khuyen mai')).toEqual([promo]);
    expect(await found(o, o.owner, 'op lung')).toEqual([own]);
    // With marks, as before; punctuation between the words does not matter.
    expect(await found(o, o.owner, 'Điện thoại')).toEqual([phone, own].sort());
    expect(await found(o, o.owner, 'điện-thoại')).toEqual([phone, own].sort());
    expect(await found(o, o.owner, 'Áo thun')).toEqual([other]);
    expect(await found(o, o.owner, 'ao thun mua he')).toEqual([other]);
    // A term with nothing left once folded matches as typed, wildcards as themselves.
    expect(await found(o, o.owner, '🔥')).toEqual([phone]);
    expect(await found(o, o.owner, '%')).toEqual([phone]);
    expect(await found(o, o.owner, '_')).toEqual([]);
    expect(await found(o, o.owner, 'quan jean')).toEqual([]);

    // The stored folded copy follows an edit.
    const v = await variantOn(o, phone, o.a);
    await exec(o, o.owner, 'social.variant.update', { variantId: v.id, revision: v.revision, title: 'Sạc dự phòng' });
    expect(await found(o, o.owner, 'sac du phong')).toEqual([phone]);
  });

  it('keeps a member limited to some channels from another channel’s posts, own text and own media', async () => {
    const o = await org();
    await exec(o, o.admin, 'social.channel_access.set', { userId: o.member, channelConnectionIds: [o.a] });
    const onA = await post(o, [o.a], 'Điện thoại kênh A');
    const onB = await post(o, [o.b], 'Điện thoại kênh B');
    const both = await post(o, [o.a, o.b], 'Hai kênh');
    const vb = await variantOn(o, both, o.b);
    await exec(o, o.owner, 'social.variant.update', { variantId: vb.id, revision: vb.revision, body: 'Tai nghe riêng kênh B' });

    expect(await found(o, o.owner, 'dien thoai')).toEqual([onA, onB].sort());
    expect(await found(o, o.member, 'dien thoai')).toEqual([onA]);
    expect(await found(o, o.owner, 'tai nghe')).toEqual([both]);
    expect(await found(o, o.member, 'tai nghe')).toEqual([]);
    expect(await found(o, o.member, 'Tai nghe riêng')).toEqual([]);

    // Media: a file only channel B's own media lists stays out of the member's pickers, folded search or not.
    const mine = await file(o, 'dien-thoai-kenh-a.jpg');
    const theirs = await file(o, 'Điện thoại kênh B.jpg');
    const pa = await variantOn(o, onA, o.a);
    const pb = await variantOn(o, onB, o.b);
    const own = (id: string) => JSON.stringify([{ fileId: id, generation: null, altText: null, mime: 'image/jpeg', sizeBytes: 120000 }]);
    await admin(async (c) => {
      await c.query('UPDATE crove_social.post_variant SET media = $2::jsonb WHERE id = $1', [pa.id, own(mine)]);
      await c.query('UPDATE crove_social.post_variant SET media = $2::jsonb WHERE id = $1', [pb.id, own(theirs)]);
    });
    expect(await media(o, o.owner, { search: 'dien thoai', usable: true })).toEqual(['Điện thoại kênh B.jpg', 'dien-thoai-kenh-a.jpg'].sort());
    expect(await media(o, o.member, { search: 'dien thoai', usable: true })).toEqual(['dien-thoai-kenh-a.jpg']);
    expect(await media(o, o.member, { search: 'Điện thoại', usable: true })).toEqual(['dien-thoai-kenh-a.jpg']);
  });

  it('finds media file names without marks, with them, and from decomposed (NFD) names', async () => {
    const o = await org();
    await file(o, 'Điện-thoại_mới.jpg');
    await file(o, 'Điện thoại cũ.jpg'.normalize('NFD'));
    await file(o, 'khuyen-mai.jpg');
    expect(await media(o, o.owner, { search: 'dien thoai' })).toHaveLength(2);
    expect(await media(o, o.owner, { search: 'ĐIỆN THOẠI' })).toHaveLength(2);
    expect(await media(o, o.owner, { search: 'thoai moi' })).toEqual(['Điện-thoại_mới.jpg']);
    expect(await media(o, o.owner, { search: 'Khuyến mãi' })).toEqual(['khuyen-mai.jpg']);
    expect(await media(o, o.owner, { search: 'tivi' })).toEqual([]);
  });

  it('leaves find and replace exact: an unmarked word does not match a marked one', async () => {
    const o = await org();
    const id = await post(o, [o.a], 'Điện thoại giá tốt');
    const preview = (find: string) => query<{ posts: Array<{ postId: string; matches: unknown[] }> }>(o, o.owner, 'social.post.bulk_replace_preview', { postIds: [id], find, replace: 'x' });
    expect((await preview('dien thoai')).posts[0]?.matches).toEqual([]);
    expect((await preview('Điện thoại')).posts[0]?.matches).not.toEqual([]);
  });

  describe(`an org of ${POSTS} posts`, () => {
    let o: Org;
    let target = '';

    beforeAll(async () => {
      o = await org();
      target = await post(o, [o.a], 'Điện thoại gập Galaxy giảm sâu');
      await admin(async (c) => {
        await c.query('BEGIN');
        // Posts of a few hundred characters each, one channel each, half with a channel text of their own.
        await c.query(
          `WITH p AS (
             INSERT INTO crove_social.post (org_id, body, title, author_user_id)
             SELECT $1, 'Bài số ' || g || ': ' || repeat('Cửa hàng thời trang Hà Nội giới thiệu bộ sưu tập mới, ưu đãi cho khách quen. ', 4),
                    CASE WHEN g % 3 = 0 THEN 'Tiêu đề ' || g END, $2
             FROM generate_series(1, $4::int) g
             RETURNING id, body
           )
           INSERT INTO crove_social.post_variant (org_id, post_id, channel_connection_id, provider, body, content_hash)
           SELECT $1, p.id, $3, 'sandbox', CASE WHEN row_number() OVER () % 2 = 0 THEN 'Riêng kênh: ' || p.body END,
                  'sha256:' || encode(sha256(convert_to(p.id::text, 'UTF8')), 'hex')
           FROM p`,
          [o.orgId, o.owner, o.a, POSTS],
        );
        await c.query('COMMIT');
        await c.query('VACUUM ANALYZE crove_social.post, crove_social.post_variant');
      });
    }, 300_000);

    it('finds the one post and answers within 200 ms at p95', async () => {
      expect(await found(o, o.owner, 'dien thoai gap')).toEqual([target]);
      expect(await query<PostView[]>(o, o.owner, 'social.post.list', { search: 'thoi trang', limit: 50 })).toHaveLength(50);

      const queries = ['dien thoai gap', 'Điện thoại', 'thoi trang ha noi', 'khong co gi', 'tieu de 4999', 'rieng kenh', 'bo suu tap moi', 'giảm sâu'];
      for (const q of queries) await found(o, o.owner, q);
      const times: number[] = [];
      for (let round = 0; round < 4; round++) {
        for (const q of queries) {
          const start = performance.now();
          await found(o, o.owner, q);
          times.push(performance.now() - start);
        }
      }
      times.sort((a, b) => a - b);
      const p95 = times[Math.ceil(times.length * 0.95) - 1] ?? Infinity;
      expect(p95, `p95 ${p95.toFixed(1)} ms over ${times.length} searches`).toBeLessThan(200);
    }, 120_000);
  });
});
