// The same text going out again on a channel (#1156) on PostgreSQL 17: social.post.get names, on each open channel, the
// newest other post on the same channel connection with the same text, published in the last 30 days or scheduled or
// queued there; social.post.pre_review adds a finding. A post published longer ago, another channel, or one word
// changed name nothing, and a member limited to some channels (#1081) learns nothing of the others.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { socialCommands, socialQueries, type PostView, type PreReview } from '@crove/mod-social';
import { styleSelection, styleText } from '@crove/mod-social/contract';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const DAY = 86_400_000;

suite('social duplicate text on PostgreSQL (#1156)', () => {
  const dbName = `crove_test_social_duplicate_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appPool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  // x: an X channel; other: a second channel of the org.
  type Org = { orgId: string; owner: string; member: string; x: string; other: string };

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  const person = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@duplicate.test`, name: null });

  async function connection(orgId: string, owner: string, provider: string, name: string) {
    const id = randomUUID();
    await admin((c) =>
      c.query('INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, $3, $4, $5, $6)', [orgId, id, provider, `acct-${id.slice(0, 8)}`, name, owner]),
    );
    return id;
  }

  async function org(): Promise<Org> {
    const owner = await person('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    const member = await person('member');
    await admin((c) => c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')", [orgId, member]));
    return { orgId, owner, member, x: await connection(orgId, owner, 'x', 'Kênh X'), other: await connection(orgId, owner, 'sandbox', 'Kênh khác') };
  }

  const exec = <O>(o: Org, user: string, name: string, input: unknown) => rt.execute<O>(name, input, { actor: asUser(user), orgId: o.orgId });
  const query = <O>(o: Org, user: string, name: string, input: unknown) => rt.query<O>(name, input, { actor: asUser(user), orgId: o.orgId });
  async function post(o: Org, connections: string[], body: string, user = o.owner) {
    const { postId } = await exec<{ postId: string }>(o, user, 'social.post.create', { body, channels: connections.map((connectionId) => ({ connectionId })) });
    return postId;
  }
  const get = (o: Org, postId: string, user = o.owner) => query<PostView>(o, user, 'social.post.get', { postId });
  const on = (view: PostView, connectionId: string) => view.variants.find((v) => v.connectionId === connectionId);

  // Moves a post's channel as the publisher or the scheduler would leave it: published some days ago with the text
  // frozen on the channel, scheduled at a time, or queued in a slot.
  async function published(o: Org, postId: string, connectionId: string, daysAgo: number) {
    await admin((c) =>
      c.query(
        `UPDATE crove_social.post_variant v SET status = 'published', published_at = now() - make_interval(days => $4), content_frozen = true, body = coalesce(v.body, p.body), external_post_id = 'x-' || v.id
           FROM crove_social.post p WHERE p.org_id = v.org_id AND p.id = v.post_id AND v.org_id = $1 AND v.post_id = $2 AND v.channel_connection_id = $3`,
        [o.orgId, postId, connectionId, daysAgo],
      ),
    );
  }
  async function scheduled(o: Org, postId: string, connectionId: string, at: Date, queued = false) {
    await admin((c) =>
      c.query(
        `UPDATE crove_social.post_variant SET status = 'scheduled', ${queued ? 'queue_slot_at' : 'scheduled_at'} = $4 WHERE org_id = $1 AND post_id = $2 AND channel_connection_id = $3`,
        [o.orgId, postId, connectionId, at],
      ),
    );
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
    const u = new URL(adminUrl);
    u.username = 'crove_app';
    u.password = 'test-app-pw';
    appPool = createPool({ connectionString: u.toString(), max: 4 });
    db = createDb(appPool);
    rt = new Runtime(db).register({ commands: [...kernelCommands, ...socialCommands], queries: [...kernelQueries({ inboundDomain: null }), ...socialQueries] });
  });

  afterAll(async () => {
    await appPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it("warns in review when a copy on X has last week's text, and one word changed clears it", async () => {
    const o = await org();
    const text = 'Ưu đãi cuối tuần: giảm 20% mọi món';
    const last = await post(o, [o.x], `${text} https://crove.vn/uu-dai`);
    await published(o, last, o.x, 7);
    const copy = await post(o, [o.x, o.other], `${text}\n\nhttps://crove.vn/uu-dai-tuan-nay`);
    await exec(o, o.owner, 'social.post.submit', { postId: copy });
    const view = await get(o, copy);
    const x = on(view, o.x);
    expect(x?.status).toBe('in_review');
    expect(x?.duplicateOf?.status).toBe('published');
    expect(Math.abs(Date.parse(x?.duplicateOf?.at as string) - (Date.now() - 7 * DAY))).toBeLessThan(60_000);
    // The other channel never carried that text.
    expect(on(view, o.other)?.duplicateOf).toBeNull();
    // The post that went out is not open, so it is not checked against the copy.
    expect(on(await get(o, last), o.x)?.duplicateOf).toBeNull();
    // The list does not check.
    const listed = await query<PostView[]>(o, o.owner, 'social.post.list', {});
    expect(listed.find((p) => p.id === copy)?.variants.every((v) => v.duplicateOf === null)).toBe(true);
    const review = await query<PreReview>(o, o.owner, 'social.post.pre_review', { postId: copy });
    expect(review.findings.filter((f) => f.startsWith('Kênh X: nội dung trùng'))).toHaveLength(1);
    expect(review.findings.some((f) => f.includes('X sẽ từ chối'))).toBe(true);
    expect(review.findings.some((f) => f.startsWith('Kênh khác: nội dung trùng'))).toBe(false);

    // One word changed: no longer the same text.
    await exec(o, o.owner, 'social.post.update', { postId: copy, revision: view.revision, body: `Ưu đãi cuối tháng: giảm 20% mọi món` });
    const changed = await get(o, copy);
    expect(changed.variants.map((v) => v.duplicateOf)).toEqual([null, null]);
    expect((await query<PreReview>(o, o.owner, 'social.post.pre_review', { postId: copy })).findings.some((f) => f.includes('trùng'))).toBe(false);
  });

  it('catches last week\'s text sent again in bold (#1179), on X', async () => {
    const o = await org();
    const text = 'Ưu đãi cuối tuần: giảm 20% mọi món #uudai';
    const last = await post(o, [o.x], text);
    await published(o, last, o.x, 7);
    // The composer's bold over the whole text keeps the hashtag; the words are the same.
    const bold = styleSelection(text, 0, text.length, 'bold').text;
    expect(bold).not.toBe(text);
    const copy = await post(o, [o.x], bold);
    expect(on(await get(o, copy), o.x)?.duplicateOf?.status).toBe('published');
    // The other way round: a post that went out in italic, and the same words in plain text.
    const italic = await post(o, [o.x], styleText('Mua 1 tặng 1 hôm nay', 'italic'));
    await published(o, italic, o.x, 3);
    const plain = await post(o, [o.x], 'Mua 1 tặng 1 hôm nay');
    expect(on(await get(o, plain), o.x)?.duplicateOf?.status).toBe('published');
  });

  it('counts posts published in the last 30 days, scheduled or queued, the newest first; not older ones', async () => {
    const o = await org();
    const text = 'Tuần lễ cà phê &amp; bánh ngọt';
    const old = await post(o, [o.x], 'Tuần lễ cà phê & bánh ngọt');
    await published(o, old, o.x, 40);
    const draft = await post(o, [o.x], text);
    expect(on(await get(o, draft), o.x)?.duplicateOf).toBeNull();

    const soon = new Date(Date.now() + 2 * DAY);
    const planned = await post(o, [o.x], 'Tuần lễ cà phê & bánh   ngọt');
    await scheduled(o, planned, o.x, soon);
    expect(on(await get(o, draft), o.x)?.duplicateOf).toEqual({ at: soon.toISOString(), status: 'scheduled' });

    const later = new Date(Date.now() + 5 * DAY);
    const slotted = await post(o, [o.x], 'Tuần lễ cà phê & bánh ngọt');
    await scheduled(o, slotted, o.x, later, true);
    expect(on(await get(o, draft), o.x)?.duplicateOf).toEqual({ at: later.toISOString(), status: 'queued' });
    // A scheduled channel is checked too: it can still be unscheduled and changed.
    expect(on(await get(o, planned), o.x)?.duplicateOf).toEqual({ at: later.toISOString(), status: 'queued' });

    // The same text on another channel names nothing on this one.
    const elsewhere = await post(o, [o.other], 'Một bài khác hẳn');
    const twin = await post(o, [o.other], 'Một bài khác hẳn');
    await published(o, twin, o.other, 1);
    expect(on(await get(o, elsewhere), o.other)?.duplicateOf?.status).toBe('published');
    expect(on(await get(o, draft), o.x)?.duplicateOf?.status).toBe('queued');
    const onX = await post(o, [o.x], 'Một bài khác hẳn');
    expect(on(await get(o, onX), o.x)?.duplicateOf).toBeNull();
  });

  it('tells a member limited to some channels only of the channels they use (#1081)', async () => {
    const o = await org();
    const text = 'Khai trương chi nhánh mới';
    const both = await post(o, [o.x, o.other], text);
    const before = await post(o, [o.x], text);
    await published(o, before, o.x, 3);
    await exec(o, o.owner, 'social.post.submit', { postId: both });
    expect(on(await get(o, both), o.x)?.duplicateOf?.status).toBe('published');
    expect((await query<PreReview>(o, o.owner, 'social.post.pre_review', { postId: both })).findings.some((f) => f.startsWith('Kênh X: nội dung trùng'))).toBe(true);

    await exec(o, o.owner, 'social.channel_access.set', { userId: o.member, channelConnectionIds: [o.other] });
    const seen = await get(o, both, o.member);
    expect(seen.variants.map((v) => v.connectionId)).toEqual([o.other]);
    expect(seen.variants[0]?.duplicateOf).toBeNull();
    const review = await query<PreReview>(o, o.member, 'social.post.pre_review', { postId: both });
    expect(review.waiting).toBe(1);
    expect(review.findings.some((f) => f.includes('trùng'))).toBe(false);

    // On a channel they use, they see a match there, from a post they may read.
    const mine = await post(o, [o.other], text, o.member);
    const twin = await post(o, [o.other], text);
    await published(o, twin, o.other, 2);
    expect(on(await get(o, mine, o.member), o.other)?.duplicateOf?.status).toBe('published');
  });
});
