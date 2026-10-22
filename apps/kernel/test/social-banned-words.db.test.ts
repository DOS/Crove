// Banned and sensitive words (issue #1055) on PostgreSQL 17: owners and admins keep the org's list, members and viewers
// only read it; a 'block' word refuses submit, approval and scheduling with 422 BANNED_WORDS, also written without
// diacritics; a 'warn' word goes through and shows on the post view for review; a word limited to some channels holds
// only there; evergreen and recurring copies with a blocked word stay drafts; another org sees nothing of the list.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { socialCommands, socialQueries, type BannedWordView, type PostView } from '@crove/mod-social';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const HOUR = 3_600_000;

suite('social banned words on PostgreSQL (#1055)', () => {
  const dbName = `crove_test_social_banned_words_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appPool: pg.Pool;
  let workerPool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  let worker: Runtime;
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  type Org = { orgId: string; owner: string; admin: string; member: string; viewer: string };

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  const person = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@banned-words.test`, name: null });

  async function org(): Promise<Org> {
    const owner = await person('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    const adminUser = await person('admin');
    const member = await person('member');
    const viewer = await person('viewer');
    await admin((c) =>
      c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'viewer')", [orgId, adminUser, member, viewer]),
    );
    return { orgId, owner, admin: adminUser, member, viewer };
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

  const exec = <O>(o: Org, user: string, name: string, input: unknown) => rt.execute<O>(name, input, { actor: asUser(user), orgId: o.orgId });
  const get = (o: Org, postId: string) => rt.query<PostView>('social.post.get', { postId }, { actor: asUser(o.owner), orgId: o.orgId });
  const list = (o: Org, user: string) => rt.query<BannedWordView[]>('social.banned_word.list', {}, { actor: asUser(user), orgId: o.orgId });
  const add = (o: Org, phrase: string, level: 'warn' | 'block', extra: { reason?: string; connectionIds?: string[] } = {}, user = o.admin) =>
    exec<{ wordId: string }>(o, user, 'social.banned_word.add', { phrase, level, ...extra });
  async function post(o: Org, body: string, connections: string[]) {
    const { postId } = await exec<{ postId: string }>(o, o.member, 'social.post.create', { body, channels: connections.map((connectionId) => ({ connectionId })) });
    return postId;
  }
  const submit = (o: Org, postId: string) => exec(o, o.member, 'social.post.submit', { postId });
  const approve = async (o: Org, postId: string) =>
    exec<{ variants: string[]; waiting: string[] }>(o, o.owner, 'social.variant.decide', {
      postId,
      decision: 'approved',
      variants: (await get(o, postId)).variants.filter((v) => v.status === 'in_review').map((v) => ({ variantId: v.id, revision: v.revision, contentHash: v.contentHash })),
    });
  const schedule = (o: Org, postId: string) => exec(o, o.owner, 'social.variant.schedule', { postId, at: new Date(Date.now() + 2 * HOUR).toISOString() });
  const statuses = async (o: Org, postId: string) => (await get(o, postId)).variants.map((v) => v.status);

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
    const as = (user: string, password: string) => {
      const u = new URL(adminUrl);
      u.username = user;
      u.password = password;
      return u.toString();
    };
    appPool = createPool({ connectionString: as('crove_app', 'test-app-pw'), max: 4 });
    workerPool = createPool({ connectionString: as('crove_worker', 'test-worker-pw'), max: 4 });
    db = createDb(appPool);
    const registry = { commands: [...kernelCommands, ...socialCommands], queries: [...kernelQueries({ inboundDomain: null }), ...socialQueries] };
    rt = new Runtime(db).register(registry);
    worker = new Runtime(createDb(workerPool)).register(registry);
  });

  afterAll(async () => {
    await appPool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('starts empty; owners and admins add and remove words, members and viewers only read them', async () => {
    const o = await org();
    expect(await list(o, o.viewer)).toEqual([]);
    const { wordId } = await add(o, '  Tốt   NHẤT ', 'block', { reason: 'Luật Quảng cáo' });
    await add(o, 'số 1', 'warn', {}, o.owner);
    const words = await list(o, o.member);
    expect(words.map((w) => [w.phrase, w.level, w.reason, w.connectionIds])).toEqual([
      ['số 1', 'warn', null, []],
      ['Tốt NHẤT', 'block', 'Luật Quảng cáo', []],
    ]);
    expect(await list(o, o.viewer)).toHaveLength(2);
    for (const user of [o.member, o.viewer]) {
      await expect(add(o, 'cam kết', 'block', {}, user)).rejects.toMatchObject({ status: 403 });
      await expect(exec(o, user, 'social.banned_word.remove', { wordId })).rejects.toMatchObject({ status: 403 });
    }
    // The same phrase as the matcher compares it, whatever its case or spacing, once per org.
    await expect(add(o, 'tốt nhất', 'warn')).rejects.toMatchObject({ code: 'BANNED_WORD_EXISTS', status: 409 });
    await expect(add(o, '​', 'warn')).rejects.toBeDefined();
    const audited = await admin((c) => c.query<{ command: string }>("SELECT command FROM crove_kernel.audit_event WHERE org_id = $1 AND command LIKE 'social.banned_word.%' AND outcome = 'ok' ORDER BY id", [o.orgId]));
    expect(audited.rows.map((r) => r.command)).toEqual(['social.banned_word.add', 'social.banned_word.add']);
    expect(await exec(o, o.admin, 'social.banned_word.remove', { wordId })).toEqual({ wordId });
    await expect(exec(o, o.admin, 'social.banned_word.remove', { wordId })).rejects.toMatchObject({ code: 'BANNED_WORD_NOT_FOUND' });
    expect((await list(o, o.owner)).map((w) => w.phrase)).toEqual(['số 1']);
  });

  it('a blocked word refuses submit, also written without diacritics; fixed, the post goes to review', async () => {
    const o = await org();
    const conn = await connection(o);
    await add(o, 'chữa khỏi', 'block', { reason: 'Không hứa chữa bệnh' });
    const postId = await post(o, 'Trà thảo mộc CHUA KHOI mất ngủ 🌿', [conn]);
    expect((await get(o, postId)).variants[0]?.bannedWords).toMatchObject([{ phrase: 'chữa khỏi', level: 'block', field: 'body', reason: 'Không hứa chữa bệnh', start: 13, end: 22 }]);
    const refused = await submit(o, postId).catch((e: unknown) => e);
    expect(refused).toMatchObject({ code: 'BANNED_WORDS', status: 422 });
    expect((refused as { details?: { variants: Array<{ words: Array<{ phrase: string; field: string }> }> } }).details?.variants[0]?.words).toEqual([
      expect.objectContaining({ phrase: 'chữa khỏi', field: 'body' }),
    ]);
    expect(await statuses(o, postId)).toEqual(['draft']);
    // "chưa khỏi" (not yet cured) is another word.
    await exec(o, o.member, 'social.post.update', { postId, revision: (await get(o, postId)).revision, body: 'Trà thảo mộc giúp ngủ ngon, bệnh chưa khỏi thì hỏi bác sĩ' });
    await submit(o, postId);
    expect(await statuses(o, postId)).toEqual(['in_review']);
  });

  it('a blocked word in the first comment or a channel override counts too', async () => {
    const o = await org();
    const conn = await connection(o);
    await add(o, 'mua ngay', 'block');
    const { postId } = await exec<{ postId: string }>(o, o.member, 'social.post.create', { body: 'Bộ sưu tập mới', channels: [{ connectionId: conn, settings: { firstComment: 'Mua ngay!' } }] });
    await expect(submit(o, postId)).rejects.toMatchObject({ code: 'BANNED_WORDS' });
    expect((await get(o, postId)).variants[0]?.bannedWords.map((m) => m.field)).toEqual(['settings.firstComment']);
  });

  it('a warned word goes through submit, approval and scheduling, and shows for review', async () => {
    const o = await org();
    const conn = await connection(o);
    await add(o, 'tốt nhất', 'warn', { reason: 'Cần bằng chứng' });
    const postId = await post(o, 'Dịch vụ tốt nhất quận 1', [conn]);
    await submit(o, postId);
    const inReview = await get(o, postId);
    expect(inReview.variants[0]?.status).toBe('in_review');
    expect(inReview.variants[0]?.bannedWords).toMatchObject([{ phrase: 'tốt nhất', level: 'warn', reason: 'Cần bằng chứng' }]);
    await approve(o, postId);
    await schedule(o, postId);
    expect(await statuses(o, postId)).toEqual(['scheduled']);
  });

  it('a word blocked after submit refuses the approval but not a request for changes; after approval it refuses scheduling', async () => {
    const o = await org();
    const conn = await connection(o);
    const first = await post(o, 'Cam kết hoàn tiền 100%', [conn]);
    const second = await post(o, 'Cam kết hoàn tiền trong 7 ngày', [conn]);
    await submit(o, first);
    await submit(o, second);
    await approve(o, second);
    await add(o, 'cam kết', 'block');
    await expect(approve(o, first)).rejects.toMatchObject({ code: 'BANNED_WORDS', status: 422 });
    expect(await statuses(o, first)).toEqual(['in_review']);
    const v = (await get(o, first)).variants[0];
    await exec(o, o.owner, 'social.variant.decide', { postId: first, decision: 'changes_requested', comment: 'Bỏ chữ cam kết', variants: [{ variantId: v?.id, revision: v?.revision, contentHash: v?.contentHash }] });
    expect(await statuses(o, first)).toEqual(['changes_requested']);
    await expect(schedule(o, second)).rejects.toMatchObject({ code: 'BANNED_WORDS', status: 422 });
    expect(await statuses(o, second)).toEqual(['approved']);
    // Back to a warning: the schedule goes.
    const [word] = await list(o, o.owner);
    await exec(o, o.owner, 'social.banned_word.remove', { wordId: word?.id });
    await add(o, 'cam kết', 'warn');
    await schedule(o, second);
    expect(await statuses(o, second)).toEqual(['scheduled']);
  });

  it('a word limited to a channel holds only there', async () => {
    const o = await org();
    const zalo = await connection(o);
    const web = await connection(o);
    await add(o, 'giảm giá sốc', 'block', { connectionIds: [zalo] });
    await expect(add(o, 'x', 'block', { connectionIds: [randomUUID()] })).rejects.toMatchObject({ code: 'CHANNEL_NOT_FOUND' });
    const postId = await post(o, 'Giảm giá sốc cuối tuần', [zalo, web]);
    const view = await get(o, postId);
    expect(view.variants.map((v) => [v.connectionId, v.bannedWords.length])).toEqual([
      [zalo, 1],
      [web, 0],
    ]);
    const zaloVariant = view.variants.find((v) => v.connectionId === zalo);
    const webVariant = view.variants.find((v) => v.connectionId === web);
    await expect(submit(o, postId)).rejects.toMatchObject({ code: 'BANNED_WORDS' });
    await exec(o, o.member, 'social.post.submit', { postId, variantIds: [webVariant?.id] });
    await expect(exec(o, o.member, 'social.post.submit', { postId, variantIds: [zaloVariant?.id] })).rejects.toMatchObject({ code: 'BANNED_WORDS' });
    expect((await get(o, postId)).variants.map((v) => [v.connectionId, v.status])).toEqual([
      [zalo, 'draft'],
      [web, 'in_review'],
    ]);
  });

  it('an import with submit leaves a channel with a blocked word as a draft', async () => {
    const o = await org();
    const conn = await connection(o);
    await add(o, 'số 1', 'block');
    const { posts } = await exec<{ posts: Array<{ postId: string; submitted: number }> }>(o, o.member, 'social.post.import', {
      submit: true,
      posts: [
        { body: 'Thương hiệu số 1 Việt Nam', connectionIds: [conn] },
        { body: 'Gọi số 10 để đặt bàn', connectionIds: [conn] },
      ],
    });
    expect(posts.map((p) => p.submitted)).toEqual([0, 1]);
  });

  it('an evergreen copy with a blocked word stays a draft on that channel', async () => {
    const o = await org();
    const a = await connection(o);
    const b = await connection(o);
    const source = await post(o, 'Liệu trình chữa khỏi mụn', [a, b]);
    // Published long ago and evergreen, as the publisher and the evergreen setting leave it.
    await admin((c) => c.query("UPDATE crove_social.post_variant SET status = 'published', published_at = now() - interval '40 days', external_post_id = id::text WHERE post_id = $1", [source]));
    await admin((c) => c.query("UPDATE crove_social.post SET status = 'published', evergreen_days = 30 WHERE id = $1", [source]));
    await add(o, 'chua khoi', 'block', { connectionIds: [a] });
    const copy = await worker.execute<{ postId: string | null }>('social.post.repost_evergreen', { postId: source }, { actor: { type: 'system', component: 'social-banned-words-test' }, orgId: o.orgId });
    expect(copy.postId).not.toBeNull();
    expect((await get(o, copy.postId as string)).variants.map((v) => [v.connectionId, v.status])).toEqual([
      [a, 'draft'],
      [b, 'in_review'],
    ]);
  });

  it('another org sees and changes nothing of the list, and its posts are not checked against it', async () => {
    const o = await org();
    const other = await org();
    const { wordId } = await add(o, 'độc quyền', 'block');
    expect(await list(other, other.owner)).toEqual([]);
    await expect(exec(other, other.owner, 'social.banned_word.remove', { wordId })).rejects.toMatchObject({ code: 'BANNED_WORD_NOT_FOUND' });
    expect((await list(o, o.owner)).map((w) => w.id)).toEqual([wordId]);
    const conn = await connection(other);
    const postId = await post(other, 'Sản phẩm độc quyền', [conn]);
    await submit(other, postId);
    expect(await statuses(other, postId)).toEqual(['in_review']);
    // The same phrase is free in the other org (the unique index is per org); row-level isolation itself is the RLS
    // matrix invariant's.
    await add(other, 'độc quyền', 'warn');
    expect((await list(other, other.owner)).map((w) => w.level)).toEqual(['warn']);
    expect((await list(o, o.owner)).map((w) => w.level)).toEqual(['block']);
  });
});
