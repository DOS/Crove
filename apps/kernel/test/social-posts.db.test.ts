// Crove Social posts on PostgreSQL 17 (Social plan S3, issue #233): compose for several channels, inherit and override
// content, review per variant on the exact revision seen, schedule at a time or in a queue, cancel, and the rules that
// keep history and in-flight variants safe. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { socialCommands, socialQueries, type PostView } from '@crove/mod-social';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const HOUR = 3_600_000;

suite('social posts on PostgreSQL (S3)', () => {
  const dbName = `crove_test_social_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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

  async function org() {
    const owner = await person('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    const roles: Record<'member' | 'viewer', string> = { member: await person('member'), viewer: await person('viewer') };
    for (const [role, id] of Object.entries(roles)) {
      await admin((c) => c.query('INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, $3)', [orgId, id, role]));
    }
    return { orgId, owner, ...roles };
  }

  async function connection(orgId: string, owner: string, provider = 'sandbox') {
    const id = randomUUID();
    await admin((c) =>
      c.query(
        'INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, $3, $4, $5, $6)',
        [orgId, id, provider, `acct-${id.slice(0, 8)}`, 'Kênh thử', owner],
      ),
    );
    return id;
  }

  const exec = <O>(o: { orgId: string }, user: string, name: string, input: unknown) => rt.execute<O>(name, input, { actor: asUser(user), orgId: o.orgId });
  const get = (o: { orgId: string }, user: string, postId: string) => rt.query<PostView>('social.post.get', { postId }, { actor: asUser(user), orgId: o.orgId });
  const seen = (p: PostView) => p.variants.map((v) => ({ variantId: v.id, revision: v.revision, contentHash: v.contentHash }));

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
    rt = new Runtime(db).register({
      commands: [...kernelCommands, ...socialCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...socialQueries],
    });
  });

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('composes one variant per channel that inherits the base until it overrides it', async () => {
    const o = await org();
    const [a, b] = [await connection(o.orgId, o.owner), await connection(o.orgId, o.owner)];
    const created = await exec<{ postId: string; revision: number }>(o, o.member, 'social.post.create', {
      body: 'Ra mắt sản phẩm mới',
      channels: [{ connectionId: a }, { connectionId: b, body: 'Bản riêng cho kênh B' }],
    });
    let post = await get(o, o.viewer, created.postId);
    expect(post.status).toBe('draft');
    expect(post.variants.map((v) => [v.effective.body, v.status, v.revision])).toEqual([
      ['Ra mắt sản phẩm mới', 'draft', 1],
      ['Bản riêng cho kênh B', 'draft', 1],
    ]);
    const [va, vb] = post.variants as [PostView['variants'][number], PostView['variants'][number]];

    // A base edit reaches only the variant that inherits it.
    const updated = await exec<{ changedVariants: string[] }>(o, o.member, 'social.post.update', { postId: post.id, revision: 1, body: 'Ra mắt sản phẩm mới, giảm 20%' });
    expect(updated.changedVariants).toEqual([va.id]);
    post = await get(o, o.owner, post.id);
    expect(post.variants.find((v) => v.id === va.id)).toMatchObject({ revision: 2, effective: { body: 'Ra mắt sản phẩm mới, giảm 20%' } });
    expect(post.variants.find((v) => v.id === vb.id)).toMatchObject({ revision: 1, contentHash: vb.contentHash });
    await expect(exec(o, o.member, 'social.post.update', { postId: post.id, revision: 1, body: 'cũ' })).rejects.toMatchObject({ code: 'STALE_REVISION' });

    // Clearing an override inherits the base again.
    await exec(o, o.member, 'social.variant.update', { variantId: vb.id, revision: 1, body: null });
    post = await get(o, o.owner, post.id);
    expect(post.variants.find((v) => v.id === vb.id)?.effective.body).toBe('Ra mắt sản phẩm mới, giảm 20%');
    // One variant per connection, and only live connections of the org.
    await expect(exec(o, o.member, 'social.post.add_channels', { postId: post.id, channels: [{ connectionId: a }] })).rejects.toMatchObject({ code: 'CHANNEL_ALREADY_IN_POST' });
    const other = await org();
    const foreign = await connection(other.orgId, other.owner);
    await expect(exec(o, o.member, 'social.post.add_channels', { postId: post.id, channels: [{ connectionId: foreign }] })).rejects.toMatchObject({ code: 'CHANNEL_NOT_FOUND' });
    await expect(get(other, other.owner, post.id)).rejects.toMatchObject({ code: 'POST_NOT_FOUND' });
  });

  it('reviews each variant on the exact revision the reviewer saw, and keeps what they saw', async () => {
    const o = await org();
    const conn = await connection(o.orgId, o.owner);
    const { postId } = await exec<{ postId: string }>(o, o.member, 'social.post.create', { body: 'Bài cần duyệt', channels: [{ connectionId: conn }] });
    await expect(exec(o, o.viewer, 'social.post.submit', { postId })).rejects.toMatchObject({ status: 403 });
    await exec(o, o.member, 'social.post.submit', { postId });
    let post = await get(o, o.owner, postId);
    expect(post.variants[0]?.status).toBe('in_review');
    // Members do not decide; a decision on a hash the variant no longer has is refused.
    await expect(exec(o, o.member, 'social.variant.decide', { postId, decision: 'approved', variants: seen(post) })).rejects.toMatchObject({ status: 403 });
    const stale = seen(post).map((s) => ({ ...s, contentHash: `sha256:${'1'.repeat(64)}` }));
    await expect(exec(o, o.owner, 'social.variant.decide', { postId, decision: 'approved', variants: stale })).rejects.toMatchObject({ code: 'STALE_REVISION' });
    await exec(o, o.owner, 'social.variant.decide', { postId, decision: 'changes_requested', comment: 'Thêm giá', variants: seen(post) });
    post = await get(o, o.owner, postId);
    expect(post.variants[0]).toMatchObject({ status: 'changes_requested', latestDecision: { decision: 'changes_requested', comment: 'Thêm giá', current: true } });
    await exec(o, o.member, 'social.post.update', { postId, revision: post.revision, body: 'Bài cần duyệt, giá 99k' });
    await exec(o, o.member, 'social.post.submit', { postId });
    post = await get(o, o.owner, postId);
    await exec(o, o.owner, 'social.variant.decide', { postId, decision: 'approved', variants: seen(post) });
    const { rows } = await admin((c) => c.query<{ decision: string; snapshot: { body: string } }>('SELECT decision, snapshot FROM crove_social.post_approval WHERE post_id = $1 ORDER BY created_at', [postId]));
    expect(rows.map((r) => [r.decision, r.snapshot.body])).toEqual([
      ['changes_requested', 'Bài cần duyệt'],
      ['approved', 'Bài cần duyệt, giá 99k'],
    ]);
    // Decisions are history: no role updates or deletes them.
    await expect(admin((c) => c.query("UPDATE crove_social.post_approval SET decision = 'rejected' WHERE post_id = $1", [postId]))).rejects.toThrow(/append-only/);
  });

  it('refuses a variant that does not fit its channel at submit', async () => {
    const o = await org();
    const conn = await connection(o.orgId, o.owner);
    const { postId } = await exec<{ postId: string }>(o, o.member, 'social.post.create', { body: '   ', channels: [{ connectionId: conn }] });
    await expect(exec(o, o.member, 'social.post.submit', { postId })).rejects.toMatchObject({
      code: 'VARIANT_INVALID',
      details: { variants: [{ issues: [expect.objectContaining({ code: 'CONTENT_REQUIRED' })] }] },
    });
  });

  async function approved(o: Awaited<ReturnType<typeof org>>, connections: string[], body = 'Bài đã duyệt') {
    const { postId } = await exec<{ postId: string }>(o, o.member, 'social.post.create', { body, channels: connections.map((connectionId) => ({ connectionId })) });
    await exec(o, o.member, 'social.post.submit', { postId });
    const post = await get(o, o.owner, postId);
    await exec(o, o.owner, 'social.variant.decide', { postId, decision: 'approved', variants: seen(post) });
    return get(o, o.owner, postId);
  }

  it('schedules only an approval of the current content, in the future', async () => {
    const o = await org();
    const conn = await connection(o.orgId, o.owner);
    const post = await approved(o, [conn]);
    await expect(exec(o, o.owner, 'social.variant.schedule', { postId: post.id, at: new Date(Date.now() - HOUR).toISOString() })).rejects.toMatchObject({ code: 'SCHEDULE_IN_PAST' });
    await expect(exec(o, o.member, 'social.variant.schedule', { postId: post.id, at: new Date(Date.now() + HOUR).toISOString() })).rejects.toMatchObject({ status: 403 });
    const at = new Date(Date.now() + 2 * HOUR).toISOString();
    await exec(o, o.owner, 'social.variant.schedule', { postId: post.id, at });
    let view = await get(o, o.owner, post.id);
    expect(view).toMatchObject({ status: 'scheduled', variants: [{ status: 'scheduled', effectiveAt: at }] });
    // Editing a scheduled variant sends it back to draft; it must be approved again before it can go out.
    await exec(o, o.member, 'social.post.update', { postId: post.id, revision: view.revision, body: 'Đổi sau khi duyệt' });
    view = await get(o, o.owner, post.id);
    expect(view).toMatchObject({ status: 'draft', variants: [{ status: 'draft', latestDecision: { decision: 'approved', current: false } }] });
    await expect(exec(o, o.owner, 'social.variant.schedule', { postId: post.id, variantIds: [view.variants[0]?.id], at })).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
  });

  it('places queued variants in free slots and keeps them in place when the queue changes', async () => {
    const o = await org();
    const conn = await connection(o.orgId, o.owner);
    // Every day at 09:00 and 20:00, Ho Chi Minh City time.
    const daily = (minute: number) => [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, minute }));
    await expect(exec(o, o.member, 'social.queue.set', { connectionId: conn, timeZone: 'Asia/Ho_Chi_Minh', slots: daily(540) })).rejects.toMatchObject({ status: 403 });
    await exec(o, o.owner, 'social.queue.set', { connectionId: conn, timeZone: 'Asia/Ho_Chi_Minh', slots: [...daily(540), ...daily(1200)] });
    const first = await approved(o, [conn], 'Bài 1');
    const second = await approved(o, [conn], 'Bài 2');
    const r1 = await exec<{ scheduled: Array<{ at: string }> }>(o, o.owner, 'social.variant.schedule', { postId: first.id, queue: true });
    const r2 = await exec<{ scheduled: Array<{ at: string }> }>(o, o.owner, 'social.variant.schedule', { postId: second.id, queue: true });
    const [s1, s2] = [r1.scheduled[0]?.at as string, r2.scheduled[0]?.at as string];
    expect(Date.parse(s2)).toBeGreaterThan(Date.parse(s1));
    const local = (iso: string) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
    expect(['09:00', '20:00']).toContain(local(s1));
    expect(['09:00', '20:00']).toContain(local(s2));

    // Dropping the 20:00 slots moves only the posts that sat in them; nothing is repacked.
    const queue = await rt.query<{ nextFree: string[] }>('social.queue.get', { connectionId: conn }, { actor: asUser(o.viewer), orgId: o.orgId });
    expect(queue.nextFree.length).toBeGreaterThan(0);
    const moved = await exec<{ moved: Array<{ variantId: string; at: string | null }> }>(o, o.owner, 'social.queue.set', { connectionId: conn, timeZone: 'Asia/Ho_Chi_Minh', slots: daily(540) });
    const after = await Promise.all([get(o, o.owner, first.id), get(o, o.owner, second.id)]);
    for (const p of after) expect(local(p.variants[0]?.queueSlotAt as string)).toBe('09:00');
    const stayed = [s1, s2].filter((s) => local(s) === '09:00');
    for (const s of stayed) expect(after.map((p) => p.variants[0]?.queueSlotAt)).toContain(s);
    expect(moved.moved.length).toBe(2 - stayed.length);

    // A time-zone change keeps the local clock time: 09:00 in Ho Chi Minh City becomes 09:00 in Bangkok (same offset)
    // and 09:00 in Tokyo (two hours earlier in UTC).
    await exec(o, o.owner, 'social.queue.set', { connectionId: conn, timeZone: 'Asia/Tokyo', slots: daily(540) });
    const tokyo = await get(o, o.owner, first.id);
    expect(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(tokyo.variants[0]?.queueSlotAt as string))).toBe('09:00');
  });

  it('never edits or cancels a variant in flight, and keeps what a published variant said', async () => {
    const o = await org();
    const [a, b] = [await connection(o.orgId, o.owner), await connection(o.orgId, o.owner)];
    const post = await approved(o, [a, b], 'Nội dung gốc');
    const [va, vb] = post.variants as [PostView['variants'][number], PostView['variants'][number]];
    // The publish job's work, done by hand: one variant published, the other in flight.
    await admin((c) => c.query("UPDATE crove_social.post_variant SET status = 'published' WHERE id = $1", [va.id]));
    await admin((c) => c.query("UPDATE crove_social.post_variant SET status = 'publishing' WHERE id = $1", [vb.id]));
    await expect(exec(o, o.member, 'social.post.update', { postId: post.id, revision: post.revision, body: 'Đổi' })).rejects.toMatchObject({ code: 'VARIANT_IN_FLIGHT' });
    await expect(exec(o, o.member, 'social.variant.cancel', { variantIds: [vb.id] })).rejects.toMatchObject({ code: 'VARIANT_STATE' });
    // Once the in-flight one is done, a base edit leaves the published variant's text as it went out.
    await admin((c) => c.query("UPDATE crove_social.post_variant SET status = 'failed' WHERE id = $1", [vb.id]));
    await exec(o, o.member, 'social.post.update', { postId: post.id, revision: post.revision, body: 'Đổi' });
    const view = await get(o, o.owner, post.id);
    expect(view.variants.find((v) => v.id === va.id)).toMatchObject({ status: 'published', effective: { body: 'Nội dung gốc' }, overrides: { body: 'Nội dung gốc' } });
    expect(view.variants.find((v) => v.id === vb.id)).toMatchObject({ status: 'draft', effective: { body: 'Đổi' } });
    // A tenant role cannot delete a post or a variant: work is cancelled, history stays.
    await expect(
      admin(async (c) => {
        const u = new URL(adminUrl);
        u.username = 'crove_app';
        u.password = 'test-app-pw';
        const app = new pg.Client({ connectionString: u.toString() });
        await app.connect();
        try {
          await app.query('BEGIN');
          await app.query('SELECT crove_kernel.enter_context($1::uuid, $2::uuid)', [o.owner, o.orgId]);
          return await app.query('DELETE FROM crove_social.post_variant WHERE id = $1', [va.id]);
        } finally {
          await app.query('ROLLBACK').catch(() => undefined);
          await app.end();
          void c;
        }
      }),
    ).rejects.toThrow(/permission denied/);
  });

  it('lists the calendar by when variants go out', async () => {
    const o = await org();
    const conn = await connection(o.orgId, o.owner);
    const soon = await approved(o, [conn], 'Sớm');
    const later = await approved(o, [conn], 'Muộn');
    const t1 = new Date(Date.now() + 2 * HOUR);
    const t2 = new Date(Date.now() + 50 * HOUR);
    await exec(o, o.owner, 'social.variant.schedule', { postId: soon.id, at: t1.toISOString() });
    await exec(o, o.owner, 'social.variant.schedule', { postId: later.id, at: t2.toISOString() });
    const list = (from: Date, to: Date) =>
      rt.query<PostView[]>('social.post.list', { from: from.toISOString(), to: to.toISOString() }, { actor: asUser(o.viewer), orgId: o.orgId }).then((ps) => ps.map((p) => p.id));
    expect(await list(new Date(), new Date(Date.now() + 24 * HOUR))).toEqual([soon.id]);
    expect((await list(new Date(), new Date(Date.now() + 72 * HOUR))).sort()).toEqual([soon.id, later.id].sort());
  });
  it('schedules each channel at its own time, and shows a post waiting in a paused queue (#576)', async () => {
    const o = await org();
    const [a, b] = [await connection(o.orgId, o.owner), await connection(o.orgId, o.owner)];
    const post = await approved(o, [a, b], 'Giờ riêng');
    const [va, vb] = post.variants as [PostView['variants'][number], PostView['variants'][number]];
    const t1 = new Date(Date.now() + 2 * HOUR).toISOString();
    const t2 = new Date(Date.now() + 5 * HOUR).toISOString();
    await expect(exec(o, o.owner, 'social.variant.schedule', { postId: post.id, times: [{ variantId: va.id, at: t1 }], at: t2 })).rejects.toBeDefined();
    await expect(exec(o, o.owner, 'social.variant.schedule', { postId: post.id, times: [{ variantId: va.id, at: new Date(Date.now() - HOUR).toISOString() }] })).rejects.toMatchObject({ code: 'SCHEDULE_IN_PAST' });
    await exec(o, o.owner, 'social.variant.schedule', { postId: post.id, times: [{ variantId: va.id, at: t1 }, { variantId: vb.id, at: t2 }] });
    const after = await get(o, o.owner, post.id);
    expect(after.variants.map((v) => [v.status, v.effectiveAt])).toEqual([
      ['scheduled', t1],
      ['scheduled', t2],
    ]);

    // A queued post on a queue paused by a person says so; resumed, it does not.
    const queued = await approved(o, [a], 'Hàng đợi');
    await exec(o, o.owner, 'social.queue.set', { connectionId: a, timeZone: 'Asia/Ho_Chi_Minh', slots: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, minute: 9 * 60 })) });
    await exec(o, o.owner, 'social.variant.schedule', { postId: queued.id, queue: true });
    expect((await get(o, o.owner, queued.id)).variants[0]?.queuePaused).toBe(false);
    const slots = [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, minute: 9 * 60 }));
    await exec(o, o.owner, 'social.queue.set', { connectionId: a, timeZone: 'Asia/Ho_Chi_Minh', slots, paused: true });
    expect((await get(o, o.owner, queued.id)).variants[0]).toMatchObject({ status: 'scheduled', queuePaused: true });
    await exec(o, o.owner, 'social.queue.set', { connectionId: a, timeZone: 'Asia/Ho_Chi_Minh', slots, paused: false });
    expect((await get(o, o.owner, queued.id)).variants[0]?.queuePaused).toBe(false);
  });

  it('stores an override equal to the base, and inheriting again, though the effective content does not change', async () => {
    const o = await org();
    const conn = await connection(o.orgId, o.owner);
    const { postId } = await exec<{ postId: string }>(o, o.member, 'social.post.create', { body: 'A', channels: [{ connectionId: conn }] });
    let post = await get(o, o.owner, postId);
    const v = post.variants[0] as PostView['variants'][number];
    // Pin the same text: no new revision, but a later base edit no longer reaches it.
    expect(await exec(o, o.member, 'social.variant.update', { variantId: v.id, revision: 1, body: 'A' })).toMatchObject({ changed: false, revision: 1 });
    await exec(o, o.member, 'social.post.update', { postId, revision: post.revision, body: 'B' });
    post = await get(o, o.owner, postId);
    expect(post.variants[0]).toMatchObject({ effective: { body: 'A' }, overrides: { body: 'A' }, revision: 1 });
    // Inherit again: the text changes to the base, as asked.
    await exec(o, o.member, 'social.variant.update', { variantId: v.id, revision: 1, body: null });
    post = await get(o, o.owner, postId);
    expect(post.variants[0]).toMatchObject({ effective: { body: 'B' }, overrides: { body: null }, revision: 2 });
  });

  it('freezes history, also its empty title and link, when the base changes', async () => {
    const o = await org();
    const [a, b] = [await connection(o.orgId, o.owner), await connection(o.orgId, o.owner)];
    const post = await approved(o, [a, b], 'Gốc');
    const [va, vb] = post.variants as [PostView['variants'][number], PostView['variants'][number]];
    // One cancelled through the command, one published by the publisher (not frozen yet).
    await exec(o, o.owner, 'social.variant.cancel', { variantIds: [va.id] });
    await admin((c) => c.query("UPDATE crove_social.post_variant SET status = 'published', published_at = now() WHERE id = $1", [vb.id]));
    await exec(o, o.member, 'social.post.update', { postId: post.id, revision: post.revision, body: 'Mới', title: 'Tiêu đề mới', linkUrl: 'https://crove.example/moi' });
    const view = await get(o, o.owner, post.id);
    for (const v of view.variants) expect(v.effective).toEqual({ body: 'Gốc', title: null, linkUrl: null });
  });

  it('serializes scheduling into a queue with a queue edit, without a deadlock', async () => {
    const o = await org();
    const conn = await connection(o.orgId, o.owner);
    const slots = [1, 2, 3, 4, 5, 6, 7].flatMap((weekday) => [540, 1200].map((minute) => ({ weekday, minute })));
    await exec(o, o.owner, 'social.queue.set', { connectionId: conn, timeZone: 'Asia/Ho_Chi_Minh', slots });
    const posts = await Promise.all([1, 2, 3].map((i) => approved(o, [conn], `Bài ${i}`)));
    const results = await Promise.allSettled([
      ...posts.map((p) => exec(o, o.owner, 'social.variant.schedule', { postId: p.id, queue: true })),
      exec(o, o.owner, 'social.queue.set', { connectionId: conn, timeZone: 'Asia/Ho_Chi_Minh', slots: slots.filter((s) => s.minute === 540) }),
      exec(o, o.owner, 'social.queue.set', { connectionId: conn, timeZone: 'Asia/Ho_Chi_Minh', slots }),
    ]);
    expect(results.filter((r) => r.status === 'rejected').map((r) => (r as PromiseRejectedResult).reason)).toEqual([]);
    const at = (await Promise.all(posts.map((p) => get(o, o.owner, p.id)))).map((p) => p.variants[0]?.queueSlotAt);
    expect(new Set(at).size).toBe(3);
  });

  it('serializes a queue edit with edits of the posts it moves, without a deadlock', async () => {
    const o = await org();
    const conn = await connection(o.orgId, o.owner);
    const daily = (minute: number) => [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, minute }));
    await exec(o, o.owner, 'social.queue.set', { connectionId: conn, timeZone: 'Asia/Ho_Chi_Minh', slots: [...daily(540), ...daily(1200)] });
    const posts = await Promise.all([1, 2, 3, 4].map((i) => approved(o, [conn], `Bài ${i}`)));
    for (const p of posts) await exec(o, o.owner, 'social.variant.schedule', { postId: p.id, queue: true });
    const views = await Promise.all(posts.map((p) => get(o, o.owner, p.id)));
    for (let round = 0; round < 3; round++) {
      const results = await Promise.allSettled([
        exec(o, o.owner, 'social.queue.set', { connectionId: conn, timeZone: 'Asia/Ho_Chi_Minh', slots: round % 2 === 0 ? daily(600) : [...daily(540), ...daily(1200)] }),
        ...views.map((v, i) => exec(o, o.member, 'social.post.update', { postId: v.id, revision: v.revision + round, body: `Bài ${i} vòng ${round}` })),
      ]);
      expect(results.filter((r) => r.status === 'rejected').map((r) => (r as PromiseRejectedResult).reason)).toEqual([]);
    }
  });

  it('updates the post status when a queue edit takes its variant out, and handles two first sets at once', async () => {
    const o = await org();
    const conn = await connection(o.orgId, o.owner);
    const fresh = await connection(o.orgId, o.owner);
    const both = await Promise.allSettled([
      exec(o, o.owner, 'social.queue.set', { connectionId: fresh, timeZone: 'Asia/Ho_Chi_Minh', slots: [{ weekday: 1, minute: 540 }] }),
      exec(o, o.owner, 'social.queue.set', { connectionId: fresh, timeZone: 'Asia/Ho_Chi_Minh', slots: [{ weekday: 2, minute: 540 }] }),
    ]);
    expect(both.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    await expect(exec(o, o.owner, 'social.variant.schedule', { postId: (await approved(o, [conn])).id, queue: true })).rejects.toMatchObject({ code: 'QUEUE_EMPTY' });
    await exec(o, o.owner, 'social.queue.set', { connectionId: conn, timeZone: 'Asia/Ho_Chi_Minh', slots: [{ weekday: 3, minute: 600 }] });
    const post = await approved(o, [conn]);
    await exec(o, o.owner, 'social.variant.schedule', { postId: post.id, queue: true });
    expect((await get(o, o.owner, post.id)).status).toBe('scheduled');
    await exec(o, o.owner, 'social.queue.set', { connectionId: conn, timeZone: 'Asia/Ho_Chi_Minh', slots: [] });
    expect(await get(o, o.owner, post.id)).toMatchObject({ status: 'draft', variants: [{ status: 'approved', queueSlotAt: null }] });
  });

  it('lets a failed variant be edited after another post took its slot', async () => {
    const o = await org();
    const conn = await connection(o.orgId, o.owner);
    await exec(o, o.owner, 'social.queue.set', { connectionId: conn, timeZone: 'Asia/Ho_Chi_Minh', slots: [{ weekday: 1, minute: 540 }] });
    const x = await approved(o, [conn], 'X');
    await exec(o, o.owner, 'social.variant.schedule', { postId: x.id, queue: true });
    const xv = (await get(o, o.owner, x.id)).variants[0] as PostView['variants'][number];
    await admin((c) => c.query("UPDATE crove_social.post_variant SET status = 'failed' WHERE id = $1", [xv.id]));
    const y = await approved(o, [conn], 'Y');
    await exec(o, o.owner, 'social.variant.schedule', { postId: y.id, queue: true });
    expect((await get(o, o.owner, y.id)).variants[0]?.queueSlotAt).toBe(xv.queueSlotAt);
    const xp = await get(o, o.owner, x.id);
    await exec(o, o.member, 'social.post.update', { postId: x.id, revision: xp.revision, body: 'X sửa' });
    expect((await get(o, o.owner, x.id)).variants[0]).toMatchObject({ status: 'draft', queueSlotAt: null });
  });

  it('keeps signed-off work for owners and admins, and lets a cancelled channel be added again', async () => {
    const o = await org();
    const [a, b] = [await connection(o.orgId, o.owner), await connection(o.orgId, o.owner)];
    const post = await approved(o, [a, b]);
    const [va, vb] = post.variants as [PostView['variants'][number], PostView['variants'][number]];
    await expect(exec(o, o.member, 'social.variant.cancel', { variantIds: [va.id] })).rejects.toMatchObject({ status: 403 });
    await exec(o, o.owner, 'social.variant.schedule', { postId: post.id, variantIds: [vb.id], at: new Date(Date.now() + HOUR).toISOString() });
    await expect(exec(o, o.member, 'social.variant.unschedule', { variantIds: [vb.id] })).rejects.toMatchObject({ status: 403 });
    await exec(o, o.owner, 'social.variant.unschedule', { variantIds: [vb.id] });
    await exec(o, o.owner, 'social.variant.cancel', { variantIds: [va.id] });
    // A draft is the member's to cancel.
    const draft = await exec<{ postId: string; variants: Array<{ variantId: string }> }>(o, o.member, 'social.post.create', { body: 'Nháp', channels: [{ connectionId: a }] });
    await exec(o, o.member, 'social.variant.cancel', { variantIds: [draft.variants[0]?.variantId] });
    // The cancelled channel can be added to its post again.
    const added = await exec<{ variants: Array<{ variantId: string }> }>(o, o.member, 'social.post.add_channels', { postId: post.id, channels: [{ connectionId: a }] });
    expect(added.variants).toHaveLength(1);
  });

  it('refuses variant ids of another org or of several posts', async () => {
    const o = await org();
    const other = await org();
    const mine = await approved(o, [await connection(o.orgId, o.owner)]);
    const theirs = await approved(other, [await connection(other.orgId, other.owner)]);
    const theirVariant = theirs.variants[0]?.id as string;
    await expect(exec(o, o.owner, 'social.variant.cancel', { variantIds: [theirVariant] })).rejects.toMatchObject({ code: 'VARIANT_NOT_FOUND' });
    await expect(exec(o, o.owner, 'social.variant.unschedule', { variantIds: [theirVariant] })).rejects.toMatchObject({ code: 'VARIANT_NOT_FOUND' });
    await expect(exec(o, o.owner, 'social.variant.decide', { postId: mine.id, decision: 'approved', variants: seen(theirs) })).rejects.toMatchObject({ code: 'VARIANT_NOT_FOUND' });
    const second = await approved(o, [await connection(o.orgId, o.owner)]);
    await expect(exec(o, o.owner, 'social.variant.cancel', { variantIds: [mine.variants[0]?.id, second.variants[0]?.id] })).rejects.toMatchObject({
      code: 'VARIANTS_OF_SEVERAL_POSTS',
    });
  });

  it('caps settings at 16 KiB of UTF-8, below what the column allows', async () => {
    const o = await org();
    const conn = await connection(o.orgId, o.owner);
    const big = { note: 'ệ'.repeat(6000) };
    await expect(exec(o, o.member, 'social.post.create', { body: 'x', channels: [{ connectionId: conn, settings: big }] })).rejects.toMatchObject({ status: 422 });
    const fits = { note: 'ệ'.repeat(5000) };
    await expect(exec(o, o.member, 'social.post.create', { body: 'x', channels: [{ connectionId: conn, settings: fits }] })).resolves.toBeDefined();
  });

  // Images on posts (#372): the post's media is part of every inheriting variant's content, hash and channel checks.
  describe('images', () => {
    async function image(orgId: string, contentType = 'image/jpeg', sizeBytes = 120_000, source = 'social') {
      const id = randomUUID();
      const sha = createHash('sha256').update(id).digest('hex');
      await admin((c) =>
        c.query(
          `INSERT INTO crove_kernel.file (org_id, id, sha256, storage_key, generation, filename, content_type, size_bytes, source)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [orgId, id, sha, `org/${orgId}/${sha}`, `content:${sha}`, 'anh.jpg', contentType, sizeBytes, source],
        ),
      );
      return id;
    }

    it('keeps the images in order, binds them into the hash and checks them per channel', async () => {
      const o = await org();
      const [fb, ig] = [await connection(o.orgId, o.owner, 'facebook_page'), await connection(o.orgId, o.owner, 'instagram')];
      const [a, b] = [await image(o.orgId), await image(o.orgId, 'image/png')];
      const { postId } = await exec<{ postId: string }>(o, o.member, 'social.post.create', {
        body: 'Khai trương',
        media: [{ fileId: a, altText: 'Mặt tiền' }, { fileId: b }],
        channels: [{ connectionId: fb }, { connectionId: ig }],
      });
      let post = await get(o, o.viewer, postId);
      expect(post.media.map((m) => [m.fileId, m.altText, m.mime])).toEqual([
        [a, 'Mặt tiền', 'image/jpeg'],
        [b, null, 'image/png'],
      ]);
      expect(post.variants.map((v) => v.media.length)).toEqual([2, 2]);
      // Instagram takes JPEG only; Facebook takes both.
      const igVariant = post.variants.find((v) => v.provider === 'instagram');
      expect(igVariant?.issues.map((i) => i.code)).toEqual(['IMAGE_TYPE_NOT_ALLOWED']);
      expect(post.variants.find((v) => v.provider === 'facebook_page')?.issues).toEqual([]);

      // Changing the images is an edit: every inheriting variant gets a new hash and revision.
      const before = post.variants.map((v) => v.contentHash);
      const updated = await exec<{ changedVariants: string[]; revision: number }>(o, o.member, 'social.post.update', { postId, revision: post.revision, media: [{ fileId: a, altText: 'Mặt tiền' }] });
      expect(updated.changedVariants).toHaveLength(2);
      post = await get(o, o.viewer, postId);
      expect(post.media.map((m) => m.fileId)).toEqual([a]);
      expect(post.variants.map((v) => v.contentHash)).not.toEqual(before);
      expect(post.variants.map((v) => v.revision)).toEqual([2, 2]);
      expect(igVariant && post.variants.find((v) => v.id === igVariant.id)?.issues).toEqual([]);
      // The same list again changes nothing.
      expect((await exec<{ changedVariants: string[] }>(o, o.member, 'social.post.update', { postId, revision: post.revision, media: [{ fileId: a, altText: 'Mặt tiền' }] })).changedVariants).toEqual([]);
    });

    it('takes only images uploaded for posts, never a document of the org, and keeps them out of the Inbox', async () => {
      const o = await org();
      const conn = await connection(o.orgId, o.owner, 'facebook_page');
      const pdf = await image(o.orgId, 'application/pdf', 1000, 'social');
      await expect(exec(o, o.member, 'social.post.create', { body: 'x', media: [{ fileId: pdf }], channels: [{ connectionId: conn }] })).rejects.toMatchObject({ code: 'MEDIA_TYPE_UNSUPPORTED' });
      // An invoice photo is an image too, but it is an accounting document: it cannot be attached.
      const scan = await image(o.orgId, 'image/jpeg', 1000, 'upload');
      await expect(exec(o, o.member, 'social.post.create', { body: 'x', media: [{ fileId: scan }], channels: [{ connectionId: conn }] })).rejects.toMatchObject({ code: 'MEDIA_NOT_FOUND' });
      const other = await org();
      const foreign = await image(other.orgId);
      await expect(exec(o, o.member, 'social.post.create', { body: 'x', media: [{ fileId: foreign }], channels: [{ connectionId: conn }] })).rejects.toMatchObject({ code: 'MEDIA_NOT_FOUND' });
      const mine = await image(o.orgId);
      await expect(exec(o, o.member, 'social.post.create', { body: 'x', media: [{ fileId: mine }, { fileId: mine }], channels: [{ connectionId: conn }] })).rejects.toMatchObject({ status: 422 });
      const recent = await rt.query<{ id: string }[]>('kernel.files.recent', {}, { actor: asUser(o.owner), orgId: o.orgId });
      expect(recent.map((f) => f.id)).toEqual([scan]);
      // A file a post shows cannot be deleted from under it.
      const { postId } = await exec<{ postId: string }>(o, o.member, 'social.post.create', { body: 'x', media: [{ fileId: mine }], channels: [{ connectionId: conn }] });
      expect(postId).toBeTruthy();
      await expect(admin((c) => c.query('DELETE FROM crove_kernel.file WHERE id = $1', [mine]))).rejects.toThrow(/post_media_file_fk/);
    });

    it('freezes the images a published or cancelled variant had', async () => {
      const o = await org();
      const conn = await connection(o.orgId, o.owner, 'facebook_page');
      const [a, b] = [await image(o.orgId), await image(o.orgId)];
      const { postId, variants } = await exec<{ postId: string; variants: { variantId: string }[] }>(o, o.member, 'social.post.create', { body: 'Bài', media: [{ fileId: a }], channels: [{ connectionId: conn }] });
      await exec(o, o.member, 'social.variant.cancel', { variantIds: variants.map((v) => v.variantId) });
      let post = await get(o, o.owner, postId);
      expect(post.variants[0]?.status).toBe('cancelled');
      await exec(o, o.member, 'social.post.update', { postId, revision: post.revision, media: [{ fileId: b }] });
      post = await get(o, o.owner, postId);
      expect(post.media.map((m) => m.fileId)).toEqual([b]);
      expect(post.variants[0]?.media.map((m) => m.fileId)).toEqual([a]);
    });
  });
});