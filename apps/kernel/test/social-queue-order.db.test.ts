// Reordering a channel's queue on PostgreSQL 17 (issue #1020): a shuffle and a move to the front only trade the slot
// times queued posts hold, so the set of times stays the same; a slot kept for a label goes only to posts with it;
// posts in review, held by the publishing hold, set for a time of their own or waiting out a rate limit stay put. Owners
// and admins only; each move is written while the post still holds the time read (#956), and two reorders at once
// leave a consistent queue. The post's timeline shows each move.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { CredentialVault, Runtime, parseVaultKey } from '@crove/kernel-runtime';
import { socialCommands, socialQueries, type ActivityItem, type PostView } from '@crove/mod-social';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const HCM = 'Asia/Ho_Chi_Minh';
const DAYS = [1, 2, 3, 4, 5, 6, 7];

type Reorder = { queueId: string; moved: { variantId: string; postId: string; from: string; at: string }[] };
type Row = { id: string; post_id: string; status: string; queue_slot_at: Date | null; scheduled_at: Date | null; error_retry_at: Date | null };

suite('social queue reordering on PostgreSQL (#1020)', () => {
  const dbName = `crove_test_social_queue_order_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appPool: pg.Pool;
  let appDb: Db;
  let api: Runtime;
  const vault = new CredentialVault([parseVaultKey(randomBytes(32).toString('base64'))]);
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

  const person = (name: string) => upsertIdentity(appDb, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@queue-order.test`, name: null });

  type Org = { orgId: string; owner: string; admin: string; member: string; viewer: string };
  async function org(): Promise<Org> {
    const owner = await person('owner');
    const { orgId } = await createOrg(api, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    const people = { admin: await person('admin'), member: await person('member'), viewer: await person('viewer') };
    for (const [role, id] of Object.entries(people)) {
      await admin((c) => c.query('INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, $3)', [orgId, id, role]));
    }
    return { orgId, owner, ...people };
  }

  const exec = <O>(o: Org, name: string, input: unknown, user = o.owner) => api.execute<O>(name, input, { actor: asUser(user), orgId: o.orgId });
  const get = (o: Org, postId: string) => api.query<PostView>('social.post.get', { postId }, { actor: asUser(o.owner), orgId: o.orgId });
  const activity = async (o: Org, postId: string) => (await api.query<{ items: ActivityItem[] }>('social.post.activity', { postId }, { actor: asUser(o.viewer), orgId: o.orgId })).items.filter((i) => i.kind === 'queue_moved');

  async function connect(o: Org) {
    const account = `acct-${randomUUID().slice(0, 8)}`;
    const sealed = vault.seal(JSON.stringify({ accessToken: 'sbx_test' }), { orgId: o.orgId, provider: 'sandbox', externalAccountId: account });
    const { connectionId } = await exec<{ connectionId: string }>(o, 'kernel.channel.connect', {
      provider: 'sandbox',
      externalAccountId: account,
      displayName: 'Trang thử',
      scopes: ['publish'],
      expiresAt: null,
      credential: { keyId: sealed.keyId, envelope: sealed.envelope.toString('base64') },
    });
    return connectionId;
  }

  // An approved post, its labels set first, put in the channel's queue.
  async function queued(o: Org, connectionId: string, body: string, labelIds: string[] = []) {
    const { postId } = await exec<{ postId: string }>(o, 'social.post.create', { body, channels: [{ connectionId }] }, o.member);
    if (labelIds.length > 0) await exec(o, 'social.post.set_labels', { postId, labelIds }, o.member);
    await exec(o, 'social.post.submit', { postId }, o.member);
    const post = await get(o, postId);
    await exec(o, 'social.variant.decide', { postId, decision: 'approved', variants: post.variants.map((v) => ({ variantId: v.id, revision: v.revision, contentHash: v.contentHash })) });
    const r = await exec<{ scheduled: { variantId: string; at: string }[] }>(o, 'social.variant.schedule', { postId, queue: true });
    return { postId, variantId: r.scheduled[0]?.variantId as string, at: r.scheduled[0]?.at as string };
  }

  const rows = (connectionId: string) =>
    admin(async (c) => (await c.query<Row>('SELECT id, post_id, status, queue_slot_at, scheduled_at, error_retry_at FROM crove_social.post_variant WHERE channel_connection_id = $1 ORDER BY id', [connectionId])).rows);
  const slots = (list: readonly Row[], ids?: ReadonlySet<string>) =>
    list
      .filter((r) => r.queue_slot_at !== null && (!ids || ids.has(r.id)))
      .map((r) => (r.queue_slot_at as Date).getTime())
      .sort((a, b) => a - b);
  const local = (at: Date | string) => new Intl.DateTimeFormat('en-GB', { timeZone: HCM, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(at));

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
    appPool = createPool({ connectionString: u.toString(), max: 6 });
    appDb = createDb(appPool);
    api = new Runtime(appDb).register({ commands: [...kernelCommands, ...socialCommands], queries: [...kernelQueries({ inboundDomain: null }), ...socialQueries] });
  });

  afterAll(async () => {
    await appPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('shuffles only the posts that may move, keeps the set of times and the slots kept for a label', async () => {
    const o = await org();
    const conn = await connect(o);
    const { labelId } = await exec<{ labelId: string }>(o, 'social.label.create', { name: 'Khuyến mãi' }, o.member);
    // 09:00 is open to every post; 20:00 is kept for promotions.
    await exec(o, 'social.queue.set', { connectionId: conn, timeZone: HCM, slots: [...DAYS.map((weekday) => ({ weekday, minute: 540 })), ...DAYS.map((weekday) => ({ weekday, minute: 1200, labelId }))] });
    const plain = [];
    for (let i = 0; i < 6; i++) plain.push(await queued(o, conn, `Mẹo ${i}`));
    const promo = [];
    for (let i = 0; i < 3; i++) promo.push(await queued(o, conn, `Giảm giá ${i}`, [labelId]));
    expect(promo.every((p) => local(p.at) === '20:00')).toBe(true);

    // Posts that must not move: one sent back to review (it keeps its slot), one waiting out a rate limit, one set for a
    // time of its own, and one already due while the org's publishing is held.
    const review = await queued(o, conn, 'Đang duyệt lại');
    const reviewPost = await get(o, review.postId);
    await exec(o, 'social.post.update', { postId: review.postId, revision: reviewPost.revision, body: 'Đang duyệt lại, đã sửa' }, o.member);
    await exec(o, 'social.post.submit', { postId: review.postId }, o.member);
    const limited = await queued(o, conn, 'Chờ hết giới hạn');
    await admin((c) => c.query("UPDATE crove_social.post_variant SET error_retry_at = now() + interval '30 days', error_kind = 'rate_limited' WHERE id = $1", [limited.variantId]));
    const fixed = await exec<{ postId: string }>(o, 'social.post.create', { body: 'Giờ cố định', channels: [{ connectionId: conn }] }, o.member);
    await exec(o, 'social.post.submit', { postId: fixed.postId }, o.member);
    const fixedView = await get(o, fixed.postId);
    await exec(o, 'social.variant.decide', { postId: fixed.postId, decision: 'approved', variants: fixedView.variants.map((v) => ({ variantId: v.id, revision: v.revision, contentHash: v.contentHash })) });
    await exec(o, 'social.variant.schedule', { postId: fixed.postId, at: new Date(Date.now() + 3 * 86_400_000).toISOString() });
    const held = await queued(o, conn, 'Bị giữ lại');
    await admin((c) => c.query("UPDATE crove_social.post_variant SET queue_slot_at = date_trunc('minute', now()) - interval '10 minutes' WHERE id = $1", [held.variantId]));
    await exec(o, 'social.publishing.hold', { reason: 'Ngày quốc tang' });

    const before = await rows(conn);
    const may = new Set([...plain, ...promo].map((p) => p.variantId));
    const stay = before.filter((r) => !may.has(r.id));

    for (const user of [o.member, o.viewer]) await expect(exec(o, 'social.queue.shuffle', { connectionId: conn }, user)).rejects.toMatchObject({ status: 403 });
    const result = await exec<Reorder>(o, 'social.queue.shuffle', { connectionId: conn }, o.admin);
    expect(result.moved.length).toBeGreaterThan(0);
    expect(result.moved.every((m) => may.has(m.variantId))).toBe(true);

    const after = await rows(conn);
    // The same times, each held once; nothing else changed.
    expect(slots(after, may)).toEqual(slots(before, may));
    expect(new Set(slots(after)).size).toBe(slots(after).length);
    expect(after.filter((r) => !may.has(r.id))).toEqual(stay);
    // A promotion slot went only to a promotion.
    const promoIds = new Set(promo.map((p) => p.variantId));
    for (const r of after.filter((x) => may.has(x.id))) {
      if (local(r.queue_slot_at as Date) === '20:00') expect(promoIds.has(r.id)).toBe(true);
    }
    expect(after.filter((r) => may.has(r.id)).every((r) => r.status === 'scheduled')).toBe(true);

    // Each moved post's timeline says it was shuffled, by whom and on which channel.
    const first = result.moved[0] as Reorder['moved'][number];
    expect(await activity(o, first.postId)).toMatchObject([{ kind: 'queue_moved', code: 'shuffle', userId: o.admin, variantId: first.variantId }]);
    const untouched = [review, limited, held].map((p) => p.postId);
    for (const postId of untouched) expect(await activity(o, postId)).toEqual([]);
  });

  it('shuffles only the posts within a date range', async () => {
    const o = await org();
    const conn = await connect(o);
    await exec(o, 'social.queue.set', { connectionId: conn, timeZone: HCM, slots: DAYS.map((weekday) => ({ weekday, minute: 540 })) });
    const posts = [];
    for (let i = 0; i < 8; i++) posts.push(await queued(o, conn, `Bài ${i}`));
    const times = posts.map((p) => p.at).sort();
    const [from, to] = [times[2] as string, times[5] as string];
    await expect(exec(o, 'social.queue.shuffle', { connectionId: conn, from: to, to: from })).rejects.toBeDefined();
    const before = await rows(conn);
    const result = await exec<Reorder>(o, 'social.queue.shuffle', { connectionId: conn, from, to });
    expect(result.moved.length).toBeGreaterThan(0);
    for (const m of result.moved) {
      expect(Date.parse(m.from)).toBeGreaterThanOrEqual(Date.parse(from));
      expect(Date.parse(m.at)).toBeLessThanOrEqual(Date.parse(to));
    }
    const after = await rows(conn);
    const inRange = (r: Row) => (r.queue_slot_at as Date).getTime() >= Date.parse(from) && (r.queue_slot_at as Date).getTime() <= Date.parse(to);
    expect(after.filter((r) => !inRange(r))).toEqual(before.filter((r) => !inRange(r)));
    expect(slots(after)).toEqual(slots(before));
  });

  it('moves a post to the front, the posts it passes one place later, with the expected-time guard', async () => {
    const o = await org();
    const conn = await connect(o);
    await exec(o, 'social.queue.set', { connectionId: conn, timeZone: HCM, slots: DAYS.map((weekday) => ({ weekday, minute: 540 })) });
    const posts = [];
    for (let i = 0; i < 4; i++) posts.push(await queued(o, conn, `Bài ${i}`));
    const [a, b, c, d] = posts as [(typeof posts)[number], (typeof posts)[number], (typeof posts)[number], (typeof posts)[number]];

    for (const user of [o.member, o.viewer]) await expect(exec(o, 'social.queue.move_to_front', { variantId: d.variantId, expectedAt: d.at }, user)).rejects.toMatchObject({ status: 403 });
    // The time the person saw is not the post's any more: refused, nothing moves.
    await expect(exec(o, 'social.queue.move_to_front', { variantId: d.variantId, expectedAt: c.at })).rejects.toMatchObject({ code: 'STALE_REVISION' });
    expect((await rows(conn)).map((r) => r.queue_slot_at?.toISOString()).sort()).toEqual(posts.map((p) => p.at).sort());

    const result = await exec<Reorder>(o, 'social.queue.move_to_front', { variantId: d.variantId, expectedAt: d.at }, o.admin);
    expect(result.moved).toHaveLength(4);
    const at = new Map((await rows(conn)).map((r) => [r.id, r.queue_slot_at?.toISOString()]));
    expect([at.get(d.variantId), at.get(a.variantId), at.get(b.variantId), at.get(c.variantId)]).toEqual([a.at, b.at, c.at, d.at]);
    expect(await activity(o, d.postId)).toMatchObject([{ code: 'front', userId: o.admin }]);
    expect(await activity(o, a.postId)).toMatchObject([{ code: 'shifted' }]);

    // Already first: nothing moves.
    expect((await exec<Reorder>(o, 'social.queue.move_to_front', { variantId: d.variantId, expectedAt: a.at })).moved).toEqual([]);

    // A post sent back to review keeps its slot and is not moved to the front; neither is one set for its own time.
    const post = await get(o, b.postId);
    await exec(o, 'social.post.update', { postId: b.postId, revision: post.revision, body: 'Sửa lại' }, o.member);
    await exec(o, 'social.post.submit', { postId: b.postId }, o.member);
    await expect(exec(o, 'social.queue.move_to_front', { variantId: b.variantId })).rejects.toMatchObject({ code: 'VARIANT_STATE' });
    const beforeFront = await rows(conn);
    await exec(o, 'social.queue.move_to_front', { variantId: c.variantId });
    const afterFront = await rows(conn);
    // b (in review) stays in its slot and the others pass it by: c first, then d and a one place later each.
    expect(afterFront.find((r) => r.id === b.variantId)).toEqual(beforeFront.find((r) => r.id === b.variantId));
    expect(slots(afterFront)).toEqual(slots(beforeFront));
    const now = new Map(afterFront.map((r) => [r.id, r.queue_slot_at?.toISOString()]));
    expect([now.get(c.variantId), now.get(d.variantId), now.get(a.variantId)]).toEqual([a.at, b.at, d.at]);
  });

  it('leaves a consistent queue when reorders run at once', async () => {
    const o = await org();
    const conn = await connect(o);
    await exec(o, 'social.queue.set', { connectionId: conn, timeZone: HCM, slots: [...DAYS.map((weekday) => ({ weekday, minute: 540 })), ...DAYS.map((weekday) => ({ weekday, minute: 1200 }))] });
    const posts = [];
    for (let i = 0; i < 10; i++) posts.push(await queued(o, conn, `Bài ${i}`));
    const before = slots(await rows(conn));
    for (let round = 0; round < 3; round++) {
      const last = posts[(round * 3) % posts.length] as (typeof posts)[number];
      const results = await Promise.allSettled([
        exec<Reorder>(o, 'social.queue.shuffle', { connectionId: conn }),
        exec<Reorder>(o, 'social.queue.shuffle', { connectionId: conn }, o.admin),
        exec<Reorder>(o, 'social.queue.move_to_front', { variantId: last.variantId }),
      ]);
      // Each one waits for the queue's lock and runs on what the one before it wrote.
      expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled']);
      const after = await rows(conn);
      expect(slots(after)).toEqual(before);
      expect(after.every((r) => r.status === 'scheduled')).toBe(true);
    }
  });
});
