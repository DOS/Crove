// The review checklist (#1105) on PostgreSQL 17: owners and admins keep up to 10 items in all, org-wide or per channel;
// an approval needs every item of the channel's list ticked and keeps the items as the database holds them; a request
// for changes or a rejection needs none; an org without a list approves as before. Set CROVE_TEST_ADMIN_URL to a
// superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { socialCommands, socialQueries, type ActivityItem, type PostView, type ReviewCheck, type VersionView } from '@crove/mod-social';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('social review checklist on PostgreSQL (#1105)', () => {
  const dbName = `crove_test_social_checklist_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let rt: Runtime;
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

  async function person(name: string) {
    return upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@social.test`, name: null });
  }

  type Org = { orgId: string; owner: string; admin: string; member: string; viewer: string };
  async function org(): Promise<Org> {
    const owner = await person('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    const roles = { admin: await person('admin'), member: await person('member'), viewer: await person('viewer') };
    for (const [role, id] of Object.entries(roles)) {
      await admin((c) => c.query('INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, $3)', [orgId, id, role]));
    }
    return { orgId, owner, ...roles };
  }

  async function connection(orgId: string, owner: string) {
    const id = randomUUID();
    await admin((c) =>
      c.query('INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, $3, $4, $5, $6)', [
        orgId,
        id,
        'sandbox',
        `acct-${id.slice(0, 8)}`,
        'Kênh thử',
        owner,
      ]),
    );
    return id;
  }

  const exec = <O>(o: Org, user: string, name: string, input: unknown) => rt.execute<O>(name, input, { actor: asUser(user), orgId: o.orgId });
  const get = (o: Org, postId: string, user = o.owner) => rt.query<PostView>('social.post.get', { postId }, { actor: asUser(user), orgId: o.orgId });
  const list = (o: Org, user: string) => rt.query<{ items: ReviewCheck[] }>('social.review_check.list', {}, { actor: asUser(user), orgId: o.orgId });
  const setList = (o: Org, user: string, items: Array<{ connectionId: string | null; label: string }>) => exec<{ items: ReviewCheck[] }>(o, user, 'social.review_check.set', { items });
  const refusal = (p: Promise<unknown>) => p.then(() => 'resolved', (e: unknown) => (e as { code?: string }).code ?? String(e));
  // What the reviewer saw, with the ticks given per variant (by variant id).
  const seen = (p: PostView, checks: (v: PostView['variants'][number]) => string[] | undefined = () => undefined) =>
    p.variants.map((v) => {
      const c = checks(v);
      return { variantId: v.id, revision: v.revision, contentHash: v.contentHash, ...(c === undefined ? {} : { checks: c }) };
    });
  const all = (v: PostView['variants'][number]) => v.checklist.map((c) => c.id);
  const stored = (postId: string) =>
    admin(async (c) => (await c.query<{ variant_id: string; decision: string; checklist: unknown }>('SELECT variant_id, decision, checklist FROM crove_social.post_approval WHERE post_id = $1 ORDER BY id', [postId])).rows);
  async function inReview(o: Org, channels: string[], body = 'Khai trương cửa hàng') {
    const { postId } = await exec<{ postId: string }>(o, o.member, 'social.post.create', { body, channels: channels.map((connectionId) => ({ connectionId })) });
    await exec(o, o.member, 'social.post.submit', { postId });
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

  it('refuses an approval without every item ticked, and keeps the items from the database with one that has them', async () => {
    const o = await org();
    const conn = await connection(o.orgId, o.owner);
    const saved = await setList(o, o.admin, [
      { connectionId: null, label: '  Đã soát   chính tả ' },
      { connectionId: null, label: 'Đúng tên thương hiệu' },
      { connectionId: conn, label: 'Liên kết mở được' },
    ]);
    // Labels as the command keeps them, in the list's order.
    expect(saved.items.map((c) => c.label)).toEqual(['Đã soát chính tả', 'Đúng tên thương hiệu', 'Liên kết mở được']);
    const postId = await inReview(o, [conn]);
    const post = await get(o, postId);
    expect(post.variants[0]?.checklist.map((c) => c.label)).toEqual(['Đã soát chính tả', 'Đúng tên thương hiệu', 'Liên kết mở được']);

    // No ticks, then all but one.
    expect(await refusal(exec(o, o.owner, 'social.variant.decide', { postId, decision: 'approved', variants: seen(post) }))).toBe('CHECKLIST_INCOMPLETE');
    expect(await refusal(exec(o, o.owner, 'social.variant.decide', { postId, decision: 'approved', variants: seen(post, (v) => all(v).slice(1)) }))).toBe('CHECKLIST_INCOMPLETE');
    expect(await stored(postId)).toEqual([]);
    expect((await get(o, postId)).variants[0]?.status).toBe('in_review');

    // Every item, given in another order and in upper case: stored in the list's order with the database's labels.
    await exec(o, o.owner, 'social.variant.decide', { postId, decision: 'approved', variants: seen(post, (v) => all(v).reverse().map((id) => id.toUpperCase())) });
    const rows = await stored(postId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.checklist).toEqual(saved.items.map((c) => ({ id: c.id, label: c.label })));
    expect((await get(o, postId)).variants[0]?.status).toBe('approved');

    // The activity and the versions show the ticked items.
    const activity = (await rt.query<{ items: ActivityItem[] }>('social.post.activity', { postId }, { actor: asUser(o.member), orgId: o.orgId })).items;
    expect(activity.find((i) => i.kind === 'decision')?.checklist).toEqual(saved.items.map((c) => ({ id: c.id, label: c.label })));
    await exec(o, o.member, 'social.post.update', { postId, revision: (await get(o, postId)).revision, body: 'Khai trương cửa hàng, giảm 20%' });
    const versions = (await rt.query<{ versions: VersionView[] }>('social.post.versions', { postId }, { actor: asUser(o.member), orgId: o.orgId })).versions;
    // The newest is the edit, which nobody approved; the one before holds the approved content.
    expect(versions[0]?.variants[0]?.approvals).toEqual([]);
    expect(versions[1]?.variants[0]?.approvals).toMatchObject([{ decidedBy: o.owner, checklist: saved.items.map((c) => ({ id: c.id, label: c.label })) }]);
  });

  it('takes ids only: a label or any other field from the client is refused, and the stored labels are the list', async () => {
    const o = await org();
    const conn = await connection(o.orgId, o.owner);
    await setList(o, o.owner, [{ connectionId: null, label: 'Đã soát chính tả' }]);
    const postId = await inReview(o, [conn]);
    const post = await get(o, postId);
    const v = post.variants[0] as PostView['variants'][number];
    const base = { variantId: v.id, revision: v.revision, contentHash: v.contentHash };
    const id = v.checklist[0]?.id as string;
    expect(await refusal(exec(o, o.owner, 'social.variant.decide', { postId, decision: 'approved', variants: [{ ...base, checks: [{ id, label: 'Tôi tự viết' }] }] }))).toBe('VALIDATION');
    expect(await refusal(exec(o, o.owner, 'social.variant.decide', { postId, decision: 'approved', variants: [{ ...base, checks: [id], checklist: [{ id, label: 'Tôi tự viết' }] }] }))).toBe('VALIDATION');
    expect(await refusal(exec(o, o.owner, 'social.variant.decide', { postId, decision: 'approved', checklist: [{ id, label: 'Tôi tự viết' }], variants: [{ ...base, checks: [id] }] }))).toBe('VALIDATION');
    await exec(o, o.owner, 'social.variant.decide', { postId, decision: 'approved', variants: [{ ...base, checks: [id] }] });
    expect((await stored(postId))[0]?.checklist).toEqual([{ id, label: 'Đã soát chính tả' }]);
  });

  it('refuses ticks of a list that changed between loading the post and deciding', async () => {
    const o = await org();
    const conn = await connection(o.orgId, o.owner);
    await setList(o, o.owner, [{ connectionId: null, label: 'Đã soát chính tả' }]);
    const postId = await inReview(o, [conn]);
    const loaded = await get(o, postId);
    // Saved again, the same label: a new item, so the old tick is not on the list.
    await setList(o, o.admin, [{ connectionId: null, label: 'Đã soát chính tả' }]);
    expect(await refusal(exec(o, o.owner, 'social.variant.decide', { postId, decision: 'approved', variants: seen(loaded, all) }))).toBe('CHECKLIST_CHANGED');
    // The list emptied since: a tick of a removed item is refused too.
    const reloaded = await get(o, postId);
    await setList(o, o.admin, []);
    expect(await refusal(exec(o, o.owner, 'social.variant.decide', { postId, decision: 'approved', variants: seen(reloaded, all) }))).toBe('CHECKLIST_CHANGED');
    // With no list left, the approval goes as before.
    await exec(o, o.owner, 'social.variant.decide', { postId, decision: 'approved', variants: seen(await get(o, postId)) });
    expect((await stored(postId))[0]?.checklist).toBeNull();
  });

  it('asks nothing of a request for changes or a rejection, and stores no ticks with them', async () => {
    const o = await org();
    const conn = await connection(o.orgId, o.owner);
    await setList(o, o.owner, [{ connectionId: null, label: 'Đã soát chính tả' }]);
    const first = await inReview(o, [conn]);
    await exec(o, o.owner, 'social.variant.decide', { postId: first, decision: 'changes_requested', comment: 'Sửa giá', variants: seen(await get(o, first)) });
    const second = await inReview(o, [conn], 'Bài thứ hai');
    // Ticks given with a rejection are not kept.
    await exec(o, o.owner, 'social.variant.decide', { postId: second, decision: 'rejected', variants: seen(await get(o, second), all) });
    expect((await stored(first)).map((r) => [r.decision, r.checklist])).toEqual([['changes_requested', null]]);
    expect((await stored(second)).map((r) => [r.decision, r.checklist])).toEqual([['rejected', null]]);
  });

  it('approves exactly as before in an org without a checklist', async () => {
    const o = await org();
    const conn = await connection(o.orgId, o.owner);
    expect((await list(o, o.member)).items).toEqual([]);
    const postId = await inReview(o, [conn]);
    const post = await get(o, postId);
    expect(post.variants[0]?.checklist).toEqual([]);
    await exec(o, o.owner, 'social.variant.decide', { postId, decision: 'approved', variants: seen(post) });
    expect(await stored(postId)).toMatchObject([{ decision: 'approved', checklist: null }]);
    expect((await get(o, postId)).variants[0]?.status).toBe('approved');
    const activity = (await rt.query<{ items: ActivityItem[] }>('social.post.activity', { postId }, { actor: asUser(o.owner), orgId: o.orgId })).items;
    expect(activity.find((i) => i.kind === 'decision')?.checklist).toBeNull();
  });

  it('caps the list at 10 items across org-wide and channel items', async () => {
    const o = await org();
    const a = await connection(o.orgId, o.owner);
    const b = await connection(o.orgId, o.owner);
    const items = (n: number, connectionId: string | null, tag: string) => Array.from({ length: n }, (_, i) => ({ connectionId, label: `${tag} ${i + 1}` }));
    expect(await refusal(setList(o, o.owner, [...items(6, null, 'Chung'), ...items(3, a, 'Kênh A'), ...items(2, b, 'Kênh B')]))).toBe('VALIDATION');
    const ten = await setList(o, o.owner, [...items(5, null, 'Chung'), ...items(3, a, 'Kênh A'), ...items(2, b, 'Kênh B')]);
    expect(ten.items).toHaveLength(10);
    expect(ten.items.map((c) => c.position)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    // Labels over 120 characters, empty ones and the same item twice on one channel are refused.
    expect(await refusal(setList(o, o.owner, [{ connectionId: null, label: 'x'.repeat(121) }]))).toBe('VALIDATION');
    expect(await refusal(setList(o, o.owner, [{ connectionId: null, label: '   ' }]))).toBe('VALIDATION');
    expect(await refusal(setList(o, o.owner, [{ connectionId: a, label: 'Liên kết' }, { connectionId: a, label: 'Liên  kết' }]))).toBe('VALIDATION');
    expect((await list(o, o.owner)).items).toHaveLength(10);
    // A whole approval of a channel: at most the 10 items, as the column's check allows.
    const postId = await inReview(o, [a]);
    const post = await get(o, postId);
    expect(post.variants[0]?.checklist).toHaveLength(8);
    await exec(o, o.owner, 'social.variant.decide', { postId, decision: 'approved', variants: seen(post, all) });
    expect((await stored(postId))[0]?.checklist).toHaveLength(8);
    const audit = await admin(async (c) => (await c.query<{ detail: { items: unknown[]; removed: number } }>("SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'social.review_check.set' AND outcome = 'ok' ORDER BY id", [o.orgId])).rows);
    expect(audit.map((r) => [r.detail.items.length, r.detail.removed])).toEqual([[10, 0]]);
  });

  it('lets only owners and admins change the list; members and viewers read it', async () => {
    const o = await org();
    expect(await refusal(setList(o, o.member, [{ connectionId: null, label: 'Đã soát chính tả' }]))).toBe('FORBIDDEN');
    expect(await refusal(setList(o, o.viewer, [{ connectionId: null, label: 'Đã soát chính tả' }]))).toBe('FORBIDDEN');
    await setList(o, o.admin, [{ connectionId: null, label: 'Đã soát chính tả' }]);
    expect((await list(o, o.viewer)).items.map((c) => c.label)).toEqual(['Đã soát chính tả']);
    expect(await refusal(setList(o, o.member, []))).toBe('FORBIDDEN');
    expect((await list(o, o.member)).items).toHaveLength(1);
  });

  it("refuses another org's channel, and keeps each org's list to itself", async () => {
    const o = await org();
    const other = await org();
    const theirs = await connection(other.orgId, other.owner);
    expect(await refusal(setList(o, o.owner, [{ connectionId: theirs, label: 'Liên kết mở được' }]))).toBe('CHANNEL_NOT_FOUND');
    expect(await refusal(setList(o, o.owner, [{ connectionId: randomUUID(), label: 'Liên kết mở được' }]))).toBe('CHANNEL_NOT_FOUND');
    await setList(other, other.owner, [{ connectionId: theirs, label: 'Của tổ chức khác' }]);
    expect((await list(o, o.owner)).items).toEqual([]);
    // A tick of another org's item is not on this org's list.
    const mine = await connection(o.orgId, o.owner);
    const postId = await inReview(o, [mine]);
    const foreign = (await list(other, other.owner)).items[0]?.id as string;
    expect(await refusal(exec(o, o.owner, 'social.variant.decide', { postId, decision: 'approved', variants: seen(await get(o, postId), () => [foreign]) }))).toBe('CHECKLIST_CHANGED');
  });

  it("applies a channel's items to that channel only, and shows a limited member only theirs", async () => {
    const o = await org();
    const a = await connection(o.orgId, o.owner);
    const b = await connection(o.orgId, o.owner);
    await setList(o, o.owner, [
      { connectionId: a, label: 'Gắn thẻ đúng trang' },
      { connectionId: null, label: 'Đã soát chính tả' },
    ]);
    const postId = await inReview(o, [a, b]);
    const post = await get(o, postId);
    const va = post.variants.find((v) => v.connectionId === a) as PostView['variants'][number];
    const vb = post.variants.find((v) => v.connectionId === b) as PostView['variants'][number];
    expect(va.checklist.map((c) => c.label)).toEqual(['Gắn thẻ đúng trang', 'Đã soát chính tả']);
    expect(vb.checklist.map((c) => c.label)).toEqual(['Đã soát chính tả']);
    // Channel A's item is not on channel B's list.
    expect(await refusal(exec(o, o.owner, 'social.variant.decide', { postId, decision: 'approved', variants: seen(post, () => all(va)) }))).toBe('CHECKLIST_CHANGED');
    await exec(o, o.owner, 'social.variant.decide', { postId, decision: 'approved', variants: seen(post, all) });
    const rows = await stored(postId);
    expect(rows.find((r) => r.variant_id === va.id)?.checklist).toEqual(va.checklist.map((c) => ({ id: c.id, label: c.label })));
    expect(rows.find((r) => r.variant_id === vb.id)?.checklist).toEqual(vb.checklist.map((c) => ({ id: c.id, label: c.label })));
    // A member limited to channel B (#1081) sees the org-wide item only.
    await exec(o, o.owner, 'social.channel_access.set', { userId: o.member, channelConnectionIds: [b] });
    expect((await list(o, o.member)).items.map((c) => c.label)).toEqual(['Đã soát chính tả']);
    expect((await list(o, o.owner)).items).toHaveLength(2);
    // A removed channel takes its items with it.
    await admin((c) => c.query('DELETE FROM crove_social.review_check WHERE org_id = $1 AND channel_connection_id IS NOT NULL', [o.orgId]));
    expect((await list(o, o.owner)).items.map((c) => c.label)).toEqual(['Đã soát chính tả']);
  });

  it('asks every approver of a channel that needs two approvals', async () => {
    const o = await org();
    const conn = await connection(o.orgId, o.owner);
    await exec(o, o.owner, 'social.channel.set_policy', { connectionId: conn, approvalsRequired: 2 });
    await setList(o, o.owner, [{ connectionId: null, label: 'Đã soát chính tả' }]);
    const postId = await inReview(o, [conn]);
    await exec(o, o.admin, 'social.variant.decide', { postId, decision: 'approved', variants: seen(await get(o, postId), all) });
    expect((await get(o, postId)).variants[0]?.status).toBe('in_review');
    expect(await refusal(exec(o, o.owner, 'social.variant.decide', { postId, decision: 'approved', variants: seen(await get(o, postId)) }))).toBe('CHECKLIST_INCOMPLETE');
    await exec(o, o.owner, 'social.variant.decide', { postId, decision: 'approved', variants: seen(await get(o, postId), all) });
    expect((await get(o, postId)).variants[0]?.status).toBe('approved');
    expect((await stored(postId)).map((r) => (r.checklist as unknown[]).length)).toEqual([1, 1]);
  });

  it('completes an approval on its own only with approvals that ticked the list as it is now (#1113)', async () => {
    const o = await org();
    const conn = await connection(o.orgId, o.owner);
    await exec(o, o.owner, 'social.channel.set_policy', { connectionId: conn, approvalsRequired: 2 });
    // One approval each, given before the checklist existed.
    const early = await inReview(o, [conn], 'Bài duyệt trước danh sách');
    await exec(o, o.admin, 'social.variant.decide', { postId: early, decision: 'approved', variants: seen(await get(o, early)) });
    await setList(o, o.owner, [{ connectionId: null, label: 'Đã soát chính tả' }]);
    // And one approval with the list ticked.
    const ticked = await inReview(o, [conn], 'Bài duyệt có đánh dấu');
    await exec(o, o.admin, 'social.variant.decide', { postId: ticked, decision: 'approved', variants: seen(await get(o, ticked), all) });

    // A lowered approval count approves the post whose approval ticked the list, and leaves the other in review.
    const lowered = await exec<{ approved: string[] }>(o, o.owner, 'social.channel.set_policy', { connectionId: conn, approvalsRequired: 1 });
    expect((await get(o, ticked)).variants[0]?.status).toBe('approved');
    expect((await get(o, early)).variants[0]?.status).toBe('in_review');
    expect(lowered.approved).toEqual([(await get(o, ticked)).variants[0]?.id]);
    // A reviewer who ticks the list approves it as always.
    await exec(o, o.owner, 'social.variant.decide', { postId: early, decision: 'approved', variants: seen(await get(o, early), all) });
    expect((await get(o, early)).variants[0]?.status).toBe('approved');
  });

  it('keeps a post in review when client approval is turned off and its approval came before the list (#1113)', async () => {
    const o = await org();
    const conn = await connection(o.orgId, o.owner);
    await exec(o, o.owner, 'social.channel.set_client_approval', { connectionId: conn, clientApproval: true });
    const postId = await inReview(o, [conn]);
    await exec(o, o.admin, 'social.variant.decide', { postId, decision: 'approved', variants: seen(await get(o, postId)) });
    // Waiting for the client only.
    expect((await get(o, postId)).variants[0]?.status).toBe('in_review');
    await setList(o, o.owner, [{ connectionId: conn, label: 'Liên kết mở được' }]);
    const off = await exec<{ approved: string[] }>(o, o.owner, 'social.channel.set_client_approval', { connectionId: conn, clientApproval: false });
    expect(off.approved).toEqual([]);
    expect((await get(o, postId)).variants[0]?.status).toBe('in_review');
  });

  it('refuses to read a list longer than the cap rather than reading it shorter (#1113)', async () => {
    const o = await org();
    const conn = await connection(o.orgId, o.owner);
    await setList(o, o.owner, Array.from({ length: 10 }, (_, i) => ({ connectionId: null, label: `Mục ${i + 1}` })));
    // An 11th item written outside the command.
    await admin((c) => c.query("INSERT INTO crove_social.review_check (org_id, channel_connection_id, position, label, created_by) VALUES ($1, NULL, 9, 'Mục lạ', $2)", [o.orgId, o.owner]));
    expect(await refusal(list(o, o.owner))).toBe('CHECKLIST_INVALID');
    const postId = await inReview(o, [conn]);
    expect(await refusal(get(o, postId))).toBe('CHECKLIST_INVALID');
  });

  it('keeps the column to approvals and to its shape', async () => {
    const o = await org();
    const conn = await connection(o.orgId, o.owner);
    const postId = await inReview(o, [conn]);
    const v = (await get(o, postId)).variants[0] as PostView['variants'][number];
    const insert = (decision: string, checklist: unknown) =>
      admin((c) =>
        c
          .query(
            `INSERT INTO crove_social.post_approval (org_id, post_id, variant_id, revision, content_hash, decision, decided_by, snapshot, checklist)
             VALUES ($1, $2, $3, $4, $5, $6, $7, '{}'::jsonb, $8::jsonb)`,
            [o.orgId, postId, v.id, v.revision, v.contentHash, decision, o.owner, checklist === null ? null : JSON.stringify(checklist)],
          )
          .then(
            () => 'ok',
            (e: { code?: string; constraint?: string }) => e.constraint ?? e.code ?? 'error',
          ),
      );
    const id = randomUUID();
    expect(await insert('changes_requested', [{ id, label: 'x' }])).toBe('post_approval_checklist_approved');
    for (const bad of [[], {}, [1], [[{ id, label: 'x' }]], [{ id }], [{ id, label: '' }], [{ id, label: 'x'.repeat(121) }], [{ id: id.toUpperCase(), label: 'x' }], [{ id, label: 'x', extra: 1 }], [{ id, label: ['x'] }], Array.from({ length: 11 }, () => ({ id, label: 'x' }))]) {
      expect(await insert('approved', bad), JSON.stringify(bad).slice(0, 80)).toBe('post_approval_checklist_shape');
    }
    expect(await insert('approved', [{ id, label: 'ă'.repeat(120) }])).toBe('ok');
    expect(await insert('approved', null)).toBe('ok');
  });
});
