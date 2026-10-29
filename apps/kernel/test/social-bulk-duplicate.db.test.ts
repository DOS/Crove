// Copies of many posts at once, moved by days or weeks, on PostgreSQL 17 (#1192): social.post.duplicate with a planned
// time, as the bulk bar sends it post by post. Ten posts of one week give ten drafts a week later with the same
// channels, settings, signature and labels; a member limited to some channels (#1081) copies those only; a source with
// no channel left for them is reported and not copied; a planned time in the past is refused; a copy is a draft that
// goes through review again and is never scheduled without an approval; and a copy whose text X would refuse as a
// repeat (#1156) is named. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { socialCommands, socialQueries, type DuplicateResult, type PostView } from '@crove/mod-social';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const DAY = 86_400_000;
const WEEK = 7 * DAY;

suite('social copies of many posts moved by days or weeks on PostgreSQL (#1192)', () => {
  const dbName = `crove_test_social_bulk_duplicate_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  type Org = { orgId: string; owner: string; member: string; a: string; b: string };

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  const person = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@bulk-duplicate.test`, name: null });
  async function connection(o: { orgId: string; owner: string }, provider = 'sandbox') {
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
  // An org with an owner and a member, and two channels A and B.
  async function org(): Promise<Org> {
    const owner = await person('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    const member = await person('member');
    await admin((c) => c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')", [orgId, member]));
    const base = { orgId, owner };
    return { ...base, member, a: await connection(base), b: await connection(base) };
  }

  const exec = <O>(o: Org, user: string, name: string, input: unknown) => rt.execute<O>(name, input, { actor: asUser(user), orgId: o.orgId });
  const get = (o: Org, postId: string, user = o.owner) => rt.query<PostView>('social.post.get', { postId }, { actor: asUser(user), orgId: o.orgId });
  const duplicate = (o: Org, user: string, postId: string, scheduledAt?: string | null) => exec<DuplicateResult>(o, user, 'social.post.duplicate', { postId, ...(scheduledAt === undefined ? {} : { scheduledAt }) });
  const copiesOf = (o: Org, postId: string) =>
    admin(async (c) => (await c.query<{ post_id: string }>("SELECT detail->>'post_id' AS post_id FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'social.post.duplicate' AND outcome = 'ok' AND detail->>'copy_of' = $2", [o.orgId, postId])).rows.map((r) => r.post_id));
  const postCount = (o: Org) => admin(async (c) => Number((await c.query<{ n: string }>('SELECT count(*) AS n FROM crove_social.post WHERE org_id = $1', [o.orgId])).rows[0]?.n));
  const approveAll = async (o: Org, postId: string) => {
    const view = await get(o, postId);
    await exec(o, o.owner, 'social.variant.decide', { postId, decision: 'approved', variants: view.variants.map((v) => ({ variantId: v.id, revision: v.revision, contentHash: v.contentHash })) });
  };

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

  it('moves ten posts of one week to ten drafts a week later, with the same channels, settings, signature and labels', async () => {
    const o = await org();
    await exec(o, o.owner, 'social.channel.set_signature', { connectionId: o.b, signature: 'Hotline 1900 0000' });
    const promo = await exec<{ labelId: string }>(o, o.owner, 'social.label.create', { name: 'Khuyến mãi tuần', color: 'green' });
    const menu = await exec<{ labelId: string }>(o, o.owner, 'social.label.create', { name: 'Thực đơn', color: 'blue' });
    // Week 1, from tomorrow at 09:00 in Ho Chi Minh City (02:00Z), one post a day and a second on three of the days.
    const start = Math.ceil(Date.now() / DAY) * DAY + DAY + 2 * 3_600_000;
    const times = [0, 1, 2, 3, 4, 5, 6, 0.5, 2.25, 4.75].map((d) => new Date(start + d * DAY).toISOString());
    const sources: string[] = [];
    for (const [i, at] of times.entries()) {
      const { postId } = await exec<{ postId: string }>(o, o.owner, 'social.post.create', {
        body: `Thực đơn ngày ${i + 1}`,
        timeZone: 'Asia/Ho_Chi_Minh',
        scheduledAt: at,
        channels: [{ connectionId: o.a }, { connectionId: o.b, body: `Riêng kênh B, ngày ${i + 1}`, settings: { firstComment: `Đặt bàn ngày ${i + 1}` } }],
      });
      await exec(o, o.owner, 'social.post.set_labels', { postId, labelIds: i % 2 === 0 ? [promo.labelId, menu.labelId] : [menu.labelId] });
      sources.push(postId);
    }
    // The channel's signature changes after the posts were written: the copies keep the one their sources have.
    await exec(o, o.owner, 'social.channel.set_signature', { connectionId: o.b, signature: 'Hotline mới 1800 0000' });

    for (const [i, postId] of sources.entries()) {
      const source = await get(o, postId);
      const at = new Date(Date.parse(times[i] as string) + WEEK).toISOString();
      const result = await duplicate(o, o.member, postId, at);
      expect(result.repeats).toEqual([]);
      const copy = await get(o, result.postId);
      expect([copy.status, copy.scheduledAt, copy.timeZone, copy.body, copy.repostOf]).toEqual(['draft', at, 'Asia/Ho_Chi_Minh', source.body, null]);
      expect(copy.labelIds.sort()).toEqual([...source.labelIds].sort());
      expect(copy.variants.map((v) => ({ connectionId: v.connectionId, status: v.status, own: v.overrides.body, settings: v.settings, body: v.effective.body }))).toEqual(
        source.variants.map((v) => ({ connectionId: v.connectionId, status: 'draft', own: v.overrides.body, settings: v.settings, body: v.effective.body })),
      );
      expect(copy.variants[1]?.settings).toMatchObject({ signature: 'Hotline 1900 0000', firstComment: `Đặt bàn ngày ${i + 1}` });
      expect(copy.variants[1]?.effective.body).toBe(`Riêng kênh B, ngày ${i + 1}\n\nHotline 1900 0000`);
      expect(copy.variants.every((v) => v.effectiveAt === at)).toBe(true);
      expect(await copiesOf(o, postId)).toEqual([result.postId]);
    }
    // Zero gives an undated draft.
    const undated = await duplicate(o, o.owner, sources[0] as string, null);
    expect((await get(o, undated.postId)).scheduledAt).toBeNull();
  });

  it("copies only the channels a limited member may use, and reports a source with none of theirs left", async () => {
    const o = await org();
    await exec(o, o.owner, 'social.channel_access.set', { userId: o.member, channelConnectionIds: [o.a] });
    const both = await exec<{ postId: string }>(o, o.owner, 'social.post.create', { body: 'Hai kênh', channels: [{ connectionId: o.a }, { connectionId: o.b }] });
    const mine = await get(o, (await duplicate(o, o.member, both.postId)).postId, o.member);
    expect(mine.variants.map((v) => v.connectionId)).toEqual([o.a]);
    expect((await get(o, mine.id)).variants.map((v) => v.connectionId)).toEqual([o.a]);
    // An owner's copy keeps both.
    const theirs = await get(o, (await duplicate(o, o.owner, both.postId)).postId);
    expect(theirs.variants.map((v) => v.connectionId)).toEqual([o.a, o.b]);

    // Channel A disconnected: B is still connected, but not the member's, so nothing is copied.
    const before = await postCount(o);
    await admin((c) => c.query("UPDATE crove_kernel.channel_connection SET status = 'revoked' WHERE id = $1", [o.a]));
    await expect(duplicate(o, o.member, both.postId, new Date(Date.now() + WEEK).toISOString())).rejects.toMatchObject({ code: 'NOTHING_TO_DUPLICATE', status: 409 });
    // A post on B alone is not theirs to copy at all.
    const onB = await exec<{ postId: string }>(o, o.owner, 'social.post.create', { body: 'Chỉ kênh B', channels: [{ connectionId: o.b }] });
    await expect(duplicate(o, o.member, onB.postId)).rejects.toMatchObject({ code: 'CHANNEL_NOT_ALLOWED', status: 403 });
    expect(await postCount(o)).toBe(before + 1);
    // Every channel gone for everyone.
    await admin((c) => c.query("UPDATE crove_kernel.channel_connection SET status = 'revoked' WHERE id = $1", [o.b]));
    await expect(duplicate(o, o.owner, onB.postId)).rejects.toMatchObject({ code: 'NOTHING_TO_DUPLICATE' });
    expect(await postCount(o)).toBe(before + 1);
  });

  it('refuses a planned time in the past, and makes nothing', async () => {
    const o = await org();
    const { postId } = await exec<{ postId: string }>(o, o.owner, 'social.post.create', { body: 'Bài cũ', channels: [{ connectionId: o.a }] });
    const before = await postCount(o);
    await expect(duplicate(o, o.member, postId, new Date(Date.now() - DAY).toISOString())).rejects.toMatchObject({ code: 'DUPLICATE_IN_PAST', status: 422 });
    expect(await postCount(o)).toBe(before);
    await expect(duplicate(o, o.member, postId, 'next week')).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('makes a draft that goes through review again, never scheduled without an approval', async () => {
    const o = await org();
    const { postId } = await exec<{ postId: string }>(o, o.owner, 'social.post.create', { body: 'Bài đã duyệt', channels: [{ connectionId: o.a }, { connectionId: o.b }] });
    await exec(o, o.owner, 'social.post.submit', { postId });
    await approveAll(o, postId);
    const at = new Date(Date.now() + 2 * DAY);
    await exec(o, o.owner, 'social.variant.schedule', { postId, at: at.toISOString() });
    expect((await get(o, postId)).variants.map((v) => v.status)).toEqual(['scheduled', 'scheduled']);

    const planned = new Date(at.getTime() + WEEK).toISOString();
    const copy = await get(o, (await duplicate(o, o.member, postId, planned)).postId);
    expect(copy.status).toBe('draft');
    expect(copy.variants.map((v) => [v.status, v.review.approvedBy, v.latestDecision, v.queueSlotAt])).toEqual([
      ['draft', [], null, null],
      ['draft', [], null, null],
    ]);
    // No channel has a time of its own: the planned time is the post's, for a person to schedule once approved.
    const own = await admin(async (c) => (await c.query<{ scheduled_at: Date | null }>('SELECT scheduled_at FROM crove_social.post_variant WHERE post_id = $1', [copy.id])).rows);
    expect(own.map((r) => r.scheduled_at)).toEqual([null, null]);
    await expect(exec(o, o.owner, 'social.variant.schedule', { postId: copy.id, at: planned })).rejects.toBeDefined();
    // Once sent to review and approved, it schedules as any post.
    await exec(o, o.member, 'social.post.submit', { postId: copy.id });
    expect((await get(o, copy.id)).variants.map((v) => v.status)).toEqual(['in_review', 'in_review']);
    await approveAll(o, copy.id);
    await exec(o, o.owner, 'social.variant.schedule', { postId: copy.id, at: planned });
    expect((await get(o, copy.id)).variants.map((v) => v.status)).toEqual(['scheduled', 'scheduled']);
  });

  it('names a copy on X whose text matches a post published there, and none elsewhere', async () => {
    const o = await org();
    const x = await connection(o, 'x');
    const { postId } = await exec<{ postId: string }>(o, o.owner, 'social.post.create', { body: 'Thực đơn thứ Hai', channels: [{ connectionId: x }, { connectionId: o.a }] });
    await admin((c) =>
      c.query(
        `UPDATE crove_social.post_variant v SET status = 'published', published_at = now() - interval '6 days', content_frozen = true, body = coalesce(v.body, p.body), external_post_id = 'x-' || v.id
           FROM crove_social.post p WHERE p.org_id = v.org_id AND p.id = v.post_id AND v.post_id = $1`,
        [postId],
      ),
    );
    const result = await duplicate(o, o.member, postId, new Date(Date.now() + DAY).toISOString());
    const copy = await get(o, result.postId);
    const onX = copy.variants.find((v) => v.connectionId === x);
    expect(result.repeats).toEqual([{ variantId: onX?.id, connectionId: x, provider: 'x', at: expect.any(String), status: 'published' }]);
    // The copy edited: no repeat left.
    const edited = await get(o, (await duplicate(o, o.member, postId)).postId);
    await exec(o, o.member, 'social.post.update', { postId: edited.id, revision: edited.revision, body: 'Thực đơn thứ Hai tuần này' });
    const again = await duplicate(o, o.member, edited.id);
    expect(again.repeats).toEqual([]);
  });
});
