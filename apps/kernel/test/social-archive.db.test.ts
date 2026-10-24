// Archived Social posts on PostgreSQL 17 (#1299): archive and restore by the author, an owner or an admin, never a
// viewer or another member; a member limited to some channels only on a post wholly on theirs; refused while a channel
// is scheduled, paused, going out, waiting for a person or being taken down; out of every list, calendar, inbox, export
// and figure, and listed on their own with archived; evergreen and the repeat turned off and the post's review links
// revoked; the commands that would move the post on refused; the bulk commands with an outcome per post; a restore that
// gives the post back unchanged; and published archived posts still in the metrics. Set CROVE_TEST_ADMIN_URL to a
// superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { socialCommands, socialQueries, type ActivityItem, type ArchiveResult, type BulkArchiveResult, type PostView } from '@crove/mod-social';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const DAY = 86_400_000;

suite('social archived posts on PostgreSQL (#1299)', () => {
  const dbName = `crove_test_social_archive_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  let workerPool: pg.Pool;
  let worker: Runtime;
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const system = { type: 'system' as const, component: 'test' };

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }
  const person = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@social.test`, name: null });

  type Org = { orgId: string; owner: string; admin: string; member: string; other: string; viewer: string; conn: string };
  async function channel(orgId: string, owner: string, name: string) {
    const id = randomUUID();
    await admin((c) =>
      c.query('INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, $3, $4, $5, $6)', [orgId, id, 'sandbox', `acct-${id.slice(0, 8)}`, name, owner]),
    );
    return id;
  }
  async function org(): Promise<Org> {
    const owner = await person('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    const people = { admin: await person('admin'), member: await person('member'), other: await person('other'), viewer: await person('viewer') };
    const roles = { admin: 'admin', member: 'member', other: 'member', viewer: 'viewer' } as const;
    for (const [key, id] of Object.entries(people)) {
      await admin((c) => c.query('INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, $3)', [orgId, id, roles[key as keyof typeof roles]]));
    }
    return { orgId, owner, ...people, conn: await channel(orgId, owner, 'Kênh thử') };
  }

  const exec = <O>(o: Org, user: string, name: string, input: unknown) => rt.execute<O>(name, input, { actor: asUser(user), orgId: o.orgId });
  const query = <O>(o: Org, user: string, name: string, input: unknown) => rt.query<O>(name, input, { actor: asUser(user), orgId: o.orgId });
  const get = (o: Org, user: string, postId: string) => query<PostView>(o, user, 'social.post.get', { postId });
  const list = async (o: Org, user: string, input: Record<string, unknown> = {}) => (await query<PostView[]>(o, user, 'social.post.list', { limit: 200, ...input })).map((p) => p.id);
  const post = async (o: Org, user: string, body: string, connections: string[] = [o.conn]) =>
    (await exec<{ postId: string }>(o, user, 'social.post.create', { body, channels: connections.map((connectionId) => ({ connectionId })) })).postId;
  const archive = (o: Org, user: string, postId: string) => exec<ArchiveResult>(o, user, 'social.post.archive', { postId });
  const restore = (o: Org, user: string, postId: string) => exec<ArchiveResult>(o, user, 'social.post.restore', { postId });
  // A channel moved by hand, as the publisher or the queue leaves it.
  const setStatus = (o: Org, postId: string, status: string, extra = '') =>
    admin((c) => c.query(`UPDATE crove_social.post_variant SET status = $3${extra} WHERE org_id = $1 AND post_id = $2`, [o.orgId, postId, status]));
  const publish = async (o: Org, postId: string, publishedAt = new Date()) => {
    await admin(async (c) => {
      await c.query("UPDATE crove_social.post_variant SET status = 'published', published_at = $3, external_post_id = 'ext-' || id::text WHERE org_id = $1 AND post_id = $2", [o.orgId, postId, publishedAt]);
      await c.query("UPDATE crove_social.post SET status = 'published' WHERE org_id = $1 AND id = $2", [o.orgId, postId]);
    });
  };
  const row = (o: Org, postId: string) =>
    admin(async (c) => (await c.query<{ archived_at: Date | null; archived_by: string | null; evergreen_days: number | null; recurrence: unknown }>('SELECT archived_at, archived_by, evergreen_days, recurrence FROM crove_social.post WHERE org_id = $1 AND id = $2', [o.orgId, postId])).rows[0]);
  const audits = (o: Org, command: string) =>
    admin(async (c) => (await c.query<{ target_id: string | null; detail: Record<string, unknown> | null }>("SELECT target_id, detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = $2 AND outcome = 'ok' ORDER BY occurred_at, id", [o.orgId, command])).rows);
  const sorted = (ids: readonly string[]) => [...ids].sort();
  // The post as the screens show it, without what archiving itself sets.
  const shown = (p: PostView) => {
    const { archivedAt: _at, archivedBy: _by, ...rest } = p;
    return rest;
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
    const registry = { commands: [...kernelCommands, ...socialCommands], queries: [...kernelQueries({ inboundDomain: null }), ...socialQueries] };
    rt = new Runtime(db).register(registry);
    const asWorker = new URL(adminUrl);
    asWorker.username = 'crove_worker';
    asWorker.password = 'test-worker-pw';
    workerPool = createPool({ connectionString: asWorker.toString(), max: 2 });
    worker = new Runtime(createDb(workerPool)).register(registry);
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

  it('takes a post out of every list and gives it back unchanged, with both steps on its timeline', async () => {
    const o = await org();
    const draft = await post(o, o.member, 'Bản nháp từ nguồn tin');
    const label = (await exec<{ labelId: string }>(o, o.member, 'social.label.create', { name: 'Tin' })).labelId;
    await exec(o, o.member, 'social.post.set_labels', { postId: draft, labelIds: [label] });
    await exec(o, o.owner, 'social.post.update', { postId: draft, revision: 1, scheduledAt: new Date(Date.now() + 3 * DAY).toISOString() });
    const kept = await post(o, o.member, 'Bài khác vẫn ở lại');
    const before = await get(o, o.owner, draft);
    expect(before.archivedAt).toBeNull();
    const range = { from: new Date(Date.now() - DAY).toISOString(), to: new Date(Date.now() + 10 * DAY).toISOString() };
    expect(await list(o, o.owner, range)).toContain(draft);

    expect(await archive(o, o.member, draft)).toEqual({ postId: draft, archived: true, changed: true });
    const stored = await row(o, draft);
    expect(stored?.archived_by).toBe(o.member);
    expect(stored?.archived_at).toBeInstanceOf(Date);
    // Out of the lists, the board, the calendar, the label filter and the search, for every role.
    for (const user of [o.owner, o.member, o.viewer]) {
      expect(await list(o, user)).toEqual([kept]);
      expect(await list(o, user, { stage: 'drafts' })).toEqual([kept]);
      expect(await list(o, user, range)).toEqual([]);
      expect(await list(o, user, { labelId: label })).toEqual([]);
      expect(await list(o, user, { search: 'nguồn tin' })).toEqual([]);
      expect(await list(o, user, { archived: true })).toEqual([draft]);
    }
    expect(await list(o, o.owner, { archived: true, search: 'nguồn tin' })).toEqual([draft]);
    // Still readable on its own, with who archived it and when.
    const archived = await get(o, o.viewer, draft);
    expect(archived.archivedBy).toBe(o.member);
    expect(archived.archivedAt).toBe(stored?.archived_at?.toISOString());
    // Archiving again changes nothing.
    expect(await archive(o, o.owner, draft)).toEqual({ postId: draft, archived: true, changed: false });

    expect(await restore(o, o.member, draft)).toEqual({ postId: draft, archived: false, changed: true });
    const after = await get(o, o.owner, draft);
    // Exactly as it was: status, channels and their states, labels, planned time, revision, last change.
    expect(shown(after)).toEqual(shown(before));
    expect(after.archivedAt).toBeNull();
    expect(after.archivedBy).toBeNull();
    expect(sorted(await list(o, o.owner))).toEqual(sorted([draft, kept]));
    expect(await list(o, o.owner, range)).toContain(draft);
    expect(await list(o, o.owner, { archived: true })).toEqual([]);
    expect(await restore(o, o.member, draft)).toEqual({ postId: draft, archived: false, changed: false });

    const timeline = (await query<{ items: ActivityItem[] }>(o, o.viewer, 'social.post.activity', { postId: draft })).items.filter((i) => i.kind === 'archived' || i.kind === 'unarchived');
    expect(timeline.map((i) => [i.kind, i.userId])).toEqual([
      ['unarchived', o.member],
      ['archived', o.member],
    ]);
    // The calls that changed nothing are audited too, but left off the timeline.
    expect((await audits(o, 'social.post.archive')).filter((a) => a.detail?.post_id !== undefined).map((a) => a.target_id)).toEqual([draft]);
    expect((await audits(o, 'social.post.restore')).filter((a) => a.detail?.post_id !== undefined).map((a) => a.target_id)).toEqual([draft]);
  });

  it('lets members archive their own posts only, owners and admins any, and never viewers', async () => {
    const o = await org();
    const mine = await post(o, o.member, 'Bài của thành viên');
    const theirs = await post(o, o.other, 'Bài của người khác');
    await expect(archive(o, o.member, theirs)).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    await expect(archive(o, o.viewer, mine)).rejects.toMatchObject({ status: 403 });
    await expect(archive(o, o.member, randomUUID())).rejects.toMatchObject({ code: 'POST_NOT_FOUND' });
    expect((await row(o, theirs))?.archived_at).toBeNull();
    expect((await archive(o, o.admin, theirs)).changed).toBe(true);
    // The author may not bring back what is theirs only when they wrote it.
    await expect(restore(o, o.member, theirs)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(restore(o, o.viewer, theirs)).rejects.toMatchObject({ status: 403 });
    expect((await restore(o, o.other, theirs)).changed).toBe(true);
    expect((await archive(o, o.member, mine)).changed).toBe(true);
    expect((await restore(o, o.owner, mine)).changed).toBe(true);
    // A post of another org is not there.
    const foreign = await org();
    const far = await post(foreign, foreign.member, 'Bài của tổ chức khác');
    await expect(archive(o, o.owner, far)).rejects.toMatchObject({ code: 'POST_NOT_FOUND' });
  });

  it('keeps a member limited to some channels to posts wholly on theirs', async () => {
    const o = await org();
    const second = await channel(o.orgId, o.owner, 'Kênh thứ hai');
    const both = await post(o, o.member, 'Trên hai kênh', [o.conn, second]);
    const own = await post(o, o.member, 'Chỉ kênh của mình');
    const elsewhere = await post(o, o.member, 'Chỉ kênh kia', [second]);
    await exec(o, o.owner, 'social.channel_access.set', { userId: o.member, channelConnectionIds: [o.conn] });
    await expect(archive(o, o.member, both)).rejects.toMatchObject({ code: 'CHANNEL_NOT_ALLOWED' });
    await expect(archive(o, o.member, elsewhere)).rejects.toMatchObject({ code: 'CHANNEL_NOT_ALLOWED' });
    const bulk = await exec<BulkArchiveResult>(o, o.member, 'social.post.bulk_archive', { postIds: [both, own, elsewhere] });
    expect(bulk.done).toEqual([own]);
    expect(bulk.skipped).toEqual(
      sorted([both, elsewhere]).map((postId) => ({ postId, reason: 'not_allowed' })),
    );
    // The archived list shows a limited member their channels' posts only, as every list does.
    await archive(o, o.owner, elsewhere);
    expect(await list(o, o.member, { archived: true })).toEqual([own]);
    expect(sorted(await list(o, o.owner, { archived: true }))).toEqual(sorted([own, elsewhere]));
  });

  it('refuses a post with a channel scheduled, paused, going out, waiting for a person or being taken down', async () => {
    const o = await org();
    const at = `, scheduled_at = now() + interval '2 days'`;
    const cases: Array<[string, string, string]> = [
      ['scheduled', at, 'POST_ARCHIVE_SCHEDULED'],
      ['paused', at, 'POST_ARCHIVE_SCHEDULED'],
      ['publishing', '', 'POST_ARCHIVE_IN_FLIGHT'],
      ['processing', '', 'POST_ARCHIVE_IN_FLIGHT'],
      ['ambiguous', '', 'POST_ARCHIVE_IN_FLIGHT'],
      ['needs_attention', '', 'POST_ARCHIVE_IN_FLIGHT'],
    ];
    for (const [status, extra, code] of cases) {
      const postId = await post(o, o.member, `Bài ${status}`);
      await setStatus(o, postId, status, extra);
      await expect(archive(o, o.owner, postId), status).rejects.toMatchObject({ code, status: 409 });
      const bulk = await exec<BulkArchiveResult>(o, o.owner, 'social.post.bulk_archive', { postIds: [postId] });
      expect(bulk, status).toEqual({ done: [], skipped: [{ postId, reason: code === 'POST_ARCHIVE_SCHEDULED' ? 'scheduled' : 'in_flight' }] });
      expect((await row(o, postId))?.archived_at, status).toBeNull();
    }
    // A takedown asked for and not answered yet (#860).
    const asked = await post(o, o.member, 'Đang chờ gỡ');
    await publish(o, asked);
    await admin((c) => c.query('UPDATE crove_social.post_variant SET remove_requested_at = now(), removed_by = $2 WHERE org_id = $1 AND post_id = $3', [o.orgId, o.owner, asked]));
    await expect(archive(o, o.owner, asked)).rejects.toMatchObject({ code: 'POST_ARCHIVE_REMOVING' });
    expect((await exec<BulkArchiveResult>(o, o.owner, 'social.post.bulk_archive', { postIds: [asked] })).skipped).toEqual([{ postId: asked, reason: 'removing' }]);
    // A planned takedown (#861) the worker will still ask for.
    const planned = await post(o, o.member, 'Sẽ tự gỡ');
    await publish(o, planned, new Date(Date.now() - 3_600_000));
    await admin((c) =>
      c.query("UPDATE crove_social.post_variant SET settings = settings || jsonb_build_object('removeAt', $3::text) WHERE org_id = $1 AND post_id = $2", [o.orgId, planned, new Date(Date.now() + DAY).toISOString()]),
    );
    await expect(archive(o, o.owner, planned)).rejects.toMatchObject({ code: 'POST_ARCHIVE_REMOVING' });
    // Published, failed, cancelled and in review are fine.
    const out = await post(o, o.member, 'Đã đăng');
    await publish(o, out);
    const failed = await post(o, o.member, 'Đăng lỗi');
    await setStatus(o, failed, 'failed');
    const cancelled = await post(o, o.member, 'Đã hủy');
    await exec(o, o.owner, 'social.variant.cancel', { variantIds: (await get(o, o.owner, cancelled)).variants.map((v) => v.id) });
    const reviewing = await post(o, o.member, 'Đang chờ duyệt');
    await exec(o, o.member, 'social.post.submit', { postId: reviewing });
    for (const postId of [out, failed, cancelled, reviewing]) expect((await archive(o, o.member, postId)).changed).toBe(true);
  });

  it('archives and restores many posts at once, each left out with its reason, in id order', async () => {
    const o = await org();
    const a = await post(o, o.member, 'A');
    const b = await post(o, o.member, 'B');
    const already = await post(o, o.member, 'Đã lưu trữ');
    await archive(o, o.member, already);
    const scheduled = await post(o, o.member, 'Đã lên lịch');
    await setStatus(o, scheduled, 'scheduled', `, scheduled_at = now() + interval '1 day'`);
    const others = await post(o, o.other, 'Của người khác');
    const missing = randomUUID();
    const seen = (await audits(o, 'social.post.archive')).length;

    const result = await exec<BulkArchiveResult>(o, o.member, 'social.post.bulk_archive', { postIds: [b, a, already, scheduled, others, missing] });
    expect(result.done).toEqual(sorted([a, b]));
    const order = sorted([already, scheduled, others, missing]);
    const reasons: Record<string, string> = { [already]: 'unchanged', [scheduled]: 'scheduled', [others]: 'not_allowed', [missing]: 'not_found' };
    expect(result.skipped).toEqual(order.map((postId) => ({ postId, reason: reasons[postId] })));
    // One audit row per post archived (each post's timeline shows it), and one for the whole.
    // A post already archived is audited as a call that changed nothing (no post_id in its facts).
    expect(
      (await audits(o, 'social.post.archive'))
        .slice(seen)
        .filter((x) => x.detail?.post_id !== undefined)
        .map((x) => x.target_id),
    ).toEqual(sorted([a, b]));
    const whole = (await audits(o, 'social.post.bulk_archive')).at(-1)?.detail;
    expect(whole).toMatchObject({ done: 2, post_ids: sorted([a, b]) });
    expect(sorted(await list(o, o.owner, { archived: true }))).toEqual(sorted([a, b, already]));

    const back = await exec<BulkArchiveResult>(o, o.member, 'social.post.bulk_restore', { postIds: [a, b, already, scheduled, missing] });
    expect(back.done).toEqual(sorted([a, already, b]));
    expect(back.skipped).toEqual(sorted([scheduled, missing]).map((postId) => ({ postId, reason: postId === missing ? 'not_found' : 'unchanged' })));
    expect(await list(o, o.owner, { archived: true })).toEqual([]);
    await expect(exec(o, o.viewer, 'social.post.bulk_archive', { postIds: [a] })).rejects.toMatchObject({ status: 403 });
    await expect(exec(o, o.member, 'social.post.bulk_archive', { postIds: Array.from({ length: 101 }, () => randomUUID()) })).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('turns off evergreen reposts and the repeat, so the sweeps never find an archived post', async () => {
    const o = await org();
    const evergreen = await post(o, o.member, 'Bài đăng lại mãi');
    await publish(o, evergreen, new Date(Date.now() - 40 * DAY));
    await exec(o, o.member, 'social.post.set_evergreen', { postId: evergreen, days: 30 });
    const series = await post(o, o.member, 'Bài lặp hằng tuần');
    await publish(o, series, new Date(Date.now() - DAY));
    await exec(o, o.member, 'social.post.recurrence_set', { postId: series, recurrence: { everyWeeks: 1, weekdays: [1, 3], time: '09:00', until: null, times: null } });
    const due = (fn: string) => admin(async (c) => (await c.query<{ post_id: string }>(`SELECT post_id FROM crove_social.${fn}(500, ARRAY[]::uuid[])`)).rows.map((r) => r.post_id));
    expect(await due('evergreen_due')).toContain(evergreen);
    expect(await due('recurring_due')).toContain(series);

    await archive(o, o.member, evergreen);
    await archive(o, o.member, series);
    expect(await row(o, evergreen)).toMatchObject({ evergreen_days: null });
    expect(await row(o, series)).toMatchObject({ recurrence: null });
    expect(await due('evergreen_due')).not.toContain(evergreen);
    expect(await due('recurring_due')).not.toContain(series);
    expect((await audits(o, 'social.post.archive')).map((a) => a.detail)).toEqual([expect.objectContaining({ evergreen_days: 30, recurrence_stopped: false }), expect.objectContaining({ evergreen_days: null, recurrence_stopped: true })]);
    // The worker's own commands find nothing to do, and nobody turns them back on while it is archived.
    await expect(worker.execute('social.post.repost_evergreen', { postId: evergreen }, { actor: system, orgId: o.orgId })).resolves.toEqual({ postId: null });
    await expect(worker.execute('social.recurring.next', { postId: series }, { actor: system, orgId: o.orgId })).resolves.toEqual({ postId: null, reason: 'not_series' });
    await expect(exec(o, o.member, 'social.post.set_evergreen', { postId: evergreen, days: 30 })).rejects.toMatchObject({ code: 'POST_ARCHIVED' });
    await expect(exec(o, o.member, 'social.post.recurrence_set', { postId: series, recurrence: { everyWeeks: 1, weekdays: [1], time: '09:00', until: null, times: null } })).rejects.toMatchObject({ code: 'POST_ARCHIVED' });
    // Turning evergreen off is still allowed, and a restore leaves both off.
    await exec(o, o.member, 'social.post.set_evergreen', { postId: evergreen, days: null });
    await restore(o, o.member, evergreen);
    await restore(o, o.member, series);
    expect((await get(o, o.owner, evergreen)).evergreenDays).toBeNull();
    expect((await get(o, o.owner, series)).recurrence).toBeNull();
  });

  it("revokes the post's open review links and the plan links that include it, and makes no new ones", async () => {
    const o = await org();
    const target = await post(o, o.member, 'Bài gửi khách');
    const other = await post(o, o.member, 'Bài khác của kế hoạch');
    const single = (await exec<{ linkId: string }>(o, o.owner, 'social.review_link.create', { postId: target })).linkId;
    const otherLink = (await exec<{ linkId: string }>(o, o.owner, 'social.review_link.create', { postId: other })).linkId;
    const plan = (await exec<{ linkId: string }>(o, o.owner, 'social.review_link.create_plan', { postIds: [target, other] })).linkId;
    const otherPlan = (await exec<{ linkId: string }>(o, o.owner, 'social.review_link.create_plan', { postIds: [other] })).linkId;
    // An expired or revoked link stays as it was.
    const expired = (await exec<{ linkId: string }>(o, o.owner, 'social.review_link.create', { postId: target })).linkId;
    await admin((c) => c.query("UPDATE crove_social.review_link SET expires_at = now() - interval '1 minute', created_at = now() - interval '2 days' WHERE id = $1", [expired]));

    await archive(o, o.member, target);
    const links = await admin(async (c) => (await c.query<{ id: string; revoked_by: string | null }>('SELECT id, revoked_by FROM crove_social.review_link WHERE org_id = $1', [o.orgId])).rows);
    const revoked = new Map(links.map((l) => [l.id, l.revoked_by]));
    expect(revoked.get(single)).toBe(o.member);
    expect(revoked.get(plan)).toBe(o.member);
    expect(revoked.get(otherLink)).toBeNull();
    expect(revoked.get(otherPlan)).toBeNull();
    expect(revoked.get(expired)).toBeNull();
    expect((await audits(o, 'social.post.archive'))[0]?.detail).toMatchObject({ review_links: sorted([single, plan]) });

    await expect(exec(o, o.owner, 'social.review_link.create', { postId: target })).rejects.toMatchObject({ code: 'POST_ARCHIVED' });
    await expect(exec(o, o.owner, 'social.review_link.create_plan', { postIds: [target, other] })).rejects.toMatchObject({ code: 'POST_ARCHIVED' });
    // A plan from a date range leaves archived posts out.
    const when = new Date(Date.now() + 2 * DAY).toISOString();
    await admin((c) => c.query('UPDATE crove_social.post SET scheduled_at = $2 WHERE org_id = $1 AND id = ANY($3::uuid[])', [o.orgId, when, [target, other]]));
    const ranged = await exec<{ linkId: string; posts: number }>(o, o.owner, 'social.review_link.create_plan', { range: { from: new Date().toISOString(), to: new Date(Date.now() + 5 * DAY).toISOString() } });
    expect(ranged.posts).toBe(1);
    const inPlan = await admin(async (c) => (await c.query<{ post_id: string }>('SELECT post_id FROM crove_social.review_link_post WHERE link_id = $1', [ranged.linkId])).rows.map((r) => r.post_id));
    expect(inPlan).toEqual([other]);
  });

  it('refuses the commands that would move an archived post on', async () => {
    const o = await org();
    const second = await channel(o.orgId, o.owner, 'Kênh thứ hai');
    const postId = await post(o, o.member, 'Bài đã lưu trữ');
    await exec(o, o.member, 'social.post.submit', { postId });
    const view = await get(o, o.owner, postId);
    const variant = view.variants[0] as PostView['variants'][number];
    await archive(o, o.owner, postId);
    const refused = { code: 'POST_ARCHIVED', status: 409 };
    await expect(exec(o, o.member, 'social.post.update', { postId, revision: view.revision, body: 'Sửa lại' })).rejects.toMatchObject(refused);
    await expect(exec(o, o.member, 'social.variant.update', { variantId: variant.id, revision: variant.revision, body: 'Sửa riêng' })).rejects.toMatchObject(refused);
    await expect(exec(o, o.member, 'social.post.add_channels', { postId, channels: [{ connectionId: second }] })).rejects.toMatchObject(refused);
    await expect(exec(o, o.owner, 'social.variant.decide', { postId, decision: 'approved', variants: [{ variantId: variant.id, revision: variant.revision, contentHash: variant.contentHash }] })).rejects.toMatchObject(refused);
    await expect(exec(o, o.owner, 'social.variant.schedule', { postId, at: new Date(Date.now() + DAY).toISOString() })).rejects.toMatchObject(refused);
    await expect(exec(o, o.member, 'social.post.set_text_variations', { postId, variations: [{ text: 'Một cách viết khác', ai: false }] })).rejects.toMatchObject(refused);
    await setStatus(o, postId, 'changes_requested');
    await expect(exec(o, o.member, 'social.post.submit', { postId })).rejects.toMatchObject(refused);
    await setStatus(o, postId, 'failed');
    await expect(exec(o, o.owner, 'social.variant.retry', { variantIds: [variant.id] })).rejects.toMatchObject(refused);
    // Labels, comments and copies still work, and the copy is not archived.
    const copy = (await exec<{ postId: string }>(o, o.member, 'social.post.duplicate', { postId })).postId;
    expect((await get(o, o.owner, copy)).archivedAt).toBeNull();
    await exec(o, o.member, 'social.post_comment.add', { postId, body: 'Ghi chú nội bộ' });
  });

  it('leaves archived posts out of the inboxes, the plan export, the reminders and the multi-client figures, and keeps published ones in the metrics', async () => {
    const o = await org();
    const reviewing = await post(o, o.member, 'Chờ duyệt rồi lưu trữ');
    await exec(o, o.member, 'social.post.submit', { postId: reviewing });
    const failed = await post(o, o.member, 'Lỗi rồi lưu trữ');
    await setStatus(o, failed, 'failed');
    const published = await post(o, o.member, 'Đã đăng rồi lưu trữ');
    await publish(o, published, new Date(Date.now() - 3_600_000));
    const inbox = async () => (await query<{ items: { postId: string }[] }>(o, o.owner, 'social.review.inbox', {})).items.map((i) => i.postId);
    const attention = async () => (await query<{ posts: { postId: string }[] }>(o, o.owner, 'social.attention.inbox', {})).posts.map((p) => p.postId);
    const exported = async () =>
      (
        await exec<{ rows: { postId: string }[] }>(o, o.owner, 'social.plan.export', { from: new Date(Date.now() - DAY).toISOString(), to: new Date(Date.now() + DAY).toISOString(), timeZone: 'Asia/Ho_Chi_Minh', format: 'print' })
      ).rows.map((r) => r.postId);
    const figures = () => query<{ review: number; attention: number }>(o, o.owner, 'social.overview.figures', {});
    const metrics = async () => (await query<{ postId: string }[]>(o, o.owner, 'social.metrics.summary', { days: 30 })).map((r) => r.postId);
    expect(await inbox()).toEqual([reviewing]);
    expect(await attention()).toEqual([failed]);
    expect(await exported()).toEqual([published]);
    expect(await figures()).toMatchObject({ review: 1, attention: 1 });
    expect(await metrics()).toEqual([published]);

    for (const postId of [reviewing, failed, published]) await archive(o, o.member, postId);
    expect(await inbox()).toEqual([]);
    expect(await attention()).toEqual([]);
    expect(await exported()).toEqual([]);
    expect(await figures()).toMatchObject({ review: 0, attention: 0 });
    expect(await list(o, o.owner, { stage: 'done' })).toEqual([]);
    // What went out still counts.
    expect(await metrics()).toEqual([published]);

    // The reminder sweep: nobody is told, and the post no longer comes back in its scan.
    // Its review clock moved back as if it went into review days ago (the trigger is skipped for this).
    await admin(async (c) => {
      await c.query("SET session_replication_role = 'replica'");
      await c.query("UPDATE crove_social.post_variant SET review_since = now() - interval '3 days' WHERE org_id = $1 AND post_id = $2", [o.orgId, reviewing]);
    });
    const remindersDue = () => admin(async (c) => (await c.query<{ post_id: string }>('SELECT post_id FROM crove_social.review_reminders_due(1000)')).rows.map((r) => r.post_id));
    expect(await remindersDue()).toContain(reviewing);
    await expect(worker.execute('social.review.remind', { postId: reviewing }, { actor: system, orgId: o.orgId })).resolves.toEqual({ stage: null });
    expect(await remindersDue()).not.toContain(reviewing);
    const told = await admin(async (c) => (await c.query<{ n: string }>("SELECT count(*) AS n FROM crove_kernel.outbox_event WHERE org_id = $1 AND type LIKE 'social.review.remind%'", [o.orgId])).rows[0]?.n);
    expect(Number(told)).toBe(0);
  });
});
