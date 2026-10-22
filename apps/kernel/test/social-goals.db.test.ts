// Monthly goals and the agency note of client reports (#1056) on PostgreSQL 17: owners and admins set and remove the
// org's goals and its channels', members and viewers only read them; a month's progress counts the posts, reach,
// impressions, engagement and followers of the month in the goals' zone; another org sees and changes nothing of them;
// a report link shows the goals only when its period is exactly one month, only its own org's and only for the
// channels it covers; its note comes back as the plain text it was; the report mail of a month carries them.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { monthBounds, socialCommands, socialQueries, type GoalsProgressView, type ReportLinkView } from '@crove/mod-social';
import { reportView } from '../src/report-link.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const HCM = 'Asia/Ho_Chi_Minh';

type Org = { orgId: string; owner: string; admin: string; member: string; viewer: string };
interface Page {
  note: string | null;
  goals: { month: string; timeZone: string; groups: { channel: string | null; provider: string | null; items: { metric: string; target: number; actual: number | null }[] }[] } | null;
}

suite('social monthly goals on PostgreSQL (#1056)', () => {
  const dbName = `crove_test_social_goals_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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

  const person = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@goals.test`, name: null });

  async function org(): Promise<Org> {
    const owner = await person('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Agency ${randomUUID().slice(0, 6)}`);
    const adminUser = await person('admin');
    const member = await person('member');
    const viewer = await person('viewer');
    await admin((c) =>
      c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'viewer')", [orgId, adminUser, member, viewer]),
    );
    return { orgId, owner, admin: adminUser, member, viewer };
  }

  async function connection(o: Org, name: string) {
    const id = randomUUID();
    await admin((c) =>
      c.query('INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, $3, $4, $5, $6)', [
        o.orgId,
        id,
        'sandbox',
        `acct-${id.slice(0, 8)}`,
        name,
        o.owner,
      ]),
    );
    return id;
  }

  const exec = <O>(o: Org, user: string, name: string, input: unknown) => rt.execute<O>(name, input, { actor: asUser(user), orgId: o.orgId });
  const progress = (o: Org, user: string, month?: string) => rt.query<GoalsProgressView>('social.goal.progress', month ? { month } : {}, { actor: asUser(user), orgId: o.orgId });
  const setGoal = (o: Org, connectionId: string | null, targets: Record<string, number | null>, user = o.admin, timeZone = HCM) =>
    exec<{ goalId: string | null }>(o, user, 'social.goal.set', { connectionId, targets, timeZone });

  async function published(o: Org, conn: string, at: string, metrics: Record<string, number>) {
    const { postId } = await exec<{ postId: string }>(o, o.owner, 'social.post.create', { body: 'Bài', channels: [{ connectionId: conn }] });
    await admin(async (c) => {
      const { rows } = await c.query<{ id: string }>("UPDATE crove_social.post_variant SET status = 'published', published_at = $2 WHERE post_id = $1 RETURNING id", [postId, at]);
      await c.query("INSERT INTO crove_social.metric_snapshot (org_id, variant_id, capture_key, metrics) VALUES ($1, $2, 'k', $3)", [o.orgId, rows[0]?.id, JSON.stringify(metrics)]);
    });
  }
  const followers = (o: Org, conn: string, day: string, n: number) =>
    admin((c) => c.query('INSERT INTO crove_social.account_snapshot (org_id, channel_connection_id, captured_on, followers) VALUES ($1, $2, $3, $4)', [o.orgId, conn, day, n]));

  const view = async (token: string) => (await reportView(rt, { token })) as unknown as Page | null;
  const link = (o: Org, period: { start: number; end: number }, extra: Record<string, unknown> = {}) =>
    exec<{ token: string; linkId: string }>(o, o.owner, 'social.report_link.create', { periodStart: new Date(period.start).toISOString(), periodEnd: new Date(period.end).toISOString(), ...extra });

  // September 2026 in Ho Chi Minh City: from 31 August 17:00 UTC to 30 September 17:00 UTC.
  const SEP = monthBounds('2026-09', HCM) as { start: number; end: number };

  // An org with goals and a September of posts and follower counts on two channels.
  async function agency() {
    const o = await org();
    const fb = await connection(o, 'Trang Facebook');
    const zalo = await connection(o, 'Zalo OA');
    // 1 September 01:00 in Vietnam, still 31 August in UTC: in the month.
    await published(o, fb, '2026-08-31T18:00:00Z', { reach: 30_000, impressions: 40_000, reactions: 300, comments: 50, clicks: 20 });
    await published(o, fb, '2026-09-20T03:00:00Z', { reach: 15_000, reactions: 100, saves: 30 });
    await published(o, zalo, '2026-09-10T03:00:00Z', { views: 900, reactions: 40 });
    // 1 October 01:00 in Vietnam: the next month.
    await published(o, fb, '2026-09-30T18:00:00Z', { reach: 99_999 });
    // Followers of the page: 100 the day before the month, 160 on its last day; Zalo reports none.
    await followers(o, fb, '2026-08-31', 100);
    await followers(o, fb, '2026-09-15', 130);
    await followers(o, fb, '2026-09-30', 160);
    await followers(o, fb, '2026-10-01', 999);
    await setGoal(o, null, { posts: 3, reach: 50_000, engagement: 500 });
    await setGoal(o, fb, { posts: 3, followersGained: 50, impressions: 40_000 });
    await setGoal(o, zalo, { posts: 1, reach: 1000, followersGained: 10 });
    return { o, fb, zalo };
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

  it('lets owners and admins set and remove goals, and every member read them', async () => {
    const o = await org();
    const fb = await connection(o, 'Trang');
    expect((await progress(o, o.viewer)).goals).toEqual([]);
    for (const user of [o.member, o.viewer]) {
      await expect(setGoal(o, null, { posts: 12 }, user)).rejects.toMatchObject({ status: 403 });
      await expect(exec(o, user, 'social.goal.remove', { connectionId: null })).rejects.toMatchObject({ status: 403 });
    }
    await expect(setGoal(o, null, { posts: 0 })).rejects.toMatchObject({ status: 422 });
    await expect(setGoal(o, null, { posts: 1.5 })).rejects.toMatchObject({ status: 422 });
    await expect(setGoal(o, null, { posts: 12 }, o.admin, 'Mars/Base')).rejects.toMatchObject({ status: 422 });
    await expect(setGoal(o, randomUUID(), { posts: 12 })).rejects.toMatchObject({ code: 'CHANNEL_NOT_FOUND' });
    const { goalId } = await setGoal(o, null, { posts: 12, reach: 50_000 }, o.owner);
    expect(goalId).toBeTruthy();
    await setGoal(o, fb, { followersGained: 100 });
    // Setting the org's goals again changes the row, and the zone goes on every goal of the org.
    expect((await setGoal(o, null, { posts: 10 }, o.admin, 'America/New_York')).goalId).toBe(goalId);
    for (const user of [o.owner, o.admin, o.member, o.viewer]) {
      const p = await progress(o, user);
      expect(p.timeZone).toBe('America/New_York');
      expect(p.goals.map((g) => [g.connectionId, g.timeZone, g.targets])).toEqual([
        [null, 'America/New_York', { posts: 10, reach: null, impressions: null, engagement: null, followersGained: null }],
        [fb, 'America/New_York', { posts: null, reach: null, impressions: null, engagement: null, followersGained: 100 }],
      ]);
    }
    // No target left removes the scope's goals; removing what is not there says so.
    expect(await setGoal(o, fb, {})).toEqual({ goalId: expect.any(String) });
    await expect(exec(o, o.admin, 'social.goal.remove', { connectionId: fb })).rejects.toMatchObject({ code: 'GOAL_NOT_FOUND' });
    await exec(o, o.owner, 'social.goal.remove', { connectionId: null });
    expect((await progress(o, o.member)).goals).toEqual([]);
    const audit = await admin(async (c) => (await c.query<{ command: string }>("SELECT command FROM crove_kernel.audit_event WHERE org_id = $1 AND command LIKE 'social.goal.%' AND outcome = 'ok' ORDER BY occurred_at", [o.orgId])).rows);
    expect(audit.map((a) => a.command)).toEqual(['social.goal.set', 'social.goal.set', 'social.goal.set', 'social.goal.set', 'social.goal.remove']);
  });

  it('keeps one row per scope and refuses a channel of another org', async () => {
    const a = await org();
    const b = await org();
    const theirs = await connection(b, 'Kênh của B');
    await expect(setGoal(a, theirs, { posts: 1 })).rejects.toMatchObject({ code: 'CHANNEL_NOT_FOUND' });
    await setGoal(a, null, { posts: 1 });
    await setGoal(a, null, { posts: 2 });
    const rows = await admin(async (c) => (await c.query<{ n: string }>('SELECT count(*) AS n FROM crove_social.goal WHERE org_id = $1', [a.orgId])).rows);
    expect(Number(rows[0]?.n)).toBe(1);
    // The table refuses a second org row and a goal with no target.
    await expect(admin((c) => c.query("INSERT INTO crove_social.goal (org_id, posts, created_by, updated_by) VALUES ($1, 5, $2, $2)", [a.orgId, a.owner]))).rejects.toThrow(/goal_scope_uq/);
    await expect(admin((c) => c.query('INSERT INTO crove_social.goal (org_id, connection_id, created_by, updated_by) VALUES ($1, $2, $3, $3)', [b.orgId, theirs, b.owner]))).rejects.toThrow(/goal_some_target/);
  });

  it('counts the month in the goals zone against each target', async () => {
    const { o, fb, zalo } = await agency();
    const p = await progress(o, o.viewer, '2026-09');
    expect(p).toMatchObject({ timeZone: HCM, month: '2026-09', periodStart: '2026-08-31T17:00:00.000Z', periodEnd: '2026-09-30T17:00:00.000Z' });
    const of = (conn: string | null) => p.goals.find((g) => g.connectionId === conn)?.progress.map((x) => [x.metric, x.actual, x.target, x.status]);
    // The org: 3 posts; reach 45,000 of 50,000; engagement 300 + 50 + 20 + 100 + 30 + 40 = 540.
    expect(of(null)).toEqual([
      ['posts', 3, 3, 'met'],
      ['reach', 45_000, 50_000, 'missed'],
      ['engagement', 540, 500, 'met'],
    ]);
    // The page: 2 posts, 40,000 impressions, 60 followers gained (160 at the end against 100 the day before).
    expect(of(fb)).toEqual([
      ['posts', 2, 3, 'missed'],
      ['impressions', 40_000, 40_000, 'met'],
      ['followersGained', 60, 50, 'met'],
    ]);
    // Zalo reports neither reach nor followers.
    expect(of(zalo)).toEqual([
      ['posts', 1, 1, 'met'],
      ['reach', null, 1000, 'no_data'],
      ['followersGained', null, 10, 'no_data'],
    ]);
    // October has only the post of 1 October (Vietnam) on the page, and its followers after the 30 September count.
    const oct = await progress(o, o.member, '2026-10');
    expect(oct.goals.find((g) => g.connectionId === fb)?.progress.map((x) => [x.metric, x.actual])).toEqual([
      ['posts', 1],
      ['impressions', null],
      ['followersGained', 839],
    ]);
    await expect(progress(o, o.member, '2026-13')).rejects.toMatchObject({ status: 422 });
  });

  it('shows another org nothing of the goals', async () => {
    const { o } = await agency();
    const other = await org();
    expect((await progress(other, other.owner, '2026-09')).goals).toEqual([]);
    // As the tenant role in the other org's context, the table has no rows of the first.
    const seen = await rt.query<{ n: number }>('social.goal.progress', { month: '2026-09' }, { actor: asUser(other.owner), orgId: other.orgId });
    expect(seen).toMatchObject({ goals: [] });
    await expect(exec(other, other.owner, 'social.goal.remove', { connectionId: null })).rejects.toMatchObject({ code: 'GOAL_NOT_FOUND' });
    expect((await progress(o, o.owner, '2026-09')).goals).toHaveLength(3);
  });

  it('puts the goals in a client report of exactly one month, for the channels it covers', async () => {
    const { o, fb, zalo } = await agency();
    // Another org with goals of its own: none of them in this org's report.
    const other = await org();
    await setGoal(other, null, { posts: 777 });

    const page = await view((await link(o, SEP)).token);
    expect(page?.goals).toEqual({
      month: '2026-09',
      timeZone: HCM,
      groups: [
        {
          channel: null,
          provider: null,
          items: [
            { metric: 'posts', target: 3, actual: 3 },
            { metric: 'reach', target: 50_000, actual: 45_000 },
            { metric: 'engagement', target: 500, actual: 540 },
          ],
        },
        {
          channel: 'Trang Facebook',
          provider: 'sandbox',
          items: [
            { metric: 'posts', target: 3, actual: 2 },
            { metric: 'impressions', target: 40_000, actual: 40_000 },
            { metric: 'followersGained', target: 50, actual: 60 },
          ],
        },
        {
          channel: 'Zalo OA',
          provider: 'sandbox',
          items: [
            { metric: 'posts', target: 1, actual: 1 },
            { metric: 'reach', target: 1000, actual: null },
            { metric: 'followersGained', target: 10, actual: null },
          ],
        },
      ],
    });
    expect(JSON.stringify(page)).not.toContain('777');

    // A report of one channel: that channel's goals only, never the org's.
    const zaloOnly = await view((await link(o, SEP, { connectionIds: [zalo] })).token);
    expect(zaloOnly?.goals?.groups.map((g) => g.channel)).toEqual(['Zalo OA']);
    const fbOnly = await view((await link(o, SEP, { connectionIds: [fb] })).token);
    expect(fbOnly?.goals?.groups.map((g) => g.channel)).toEqual(['Trang Facebook']);

    // Not one month: 30 days, a day short, two months, the month in UTC.
    for (const period of [
      { start: SEP.start, end: SEP.start + 30 * 86_400_000 + 3_600_000 },
      { start: SEP.start, end: SEP.end - 86_400_000 },
      { start: SEP.start, end: (monthBounds('2026-10', HCM) as { end: number }).end },
      { start: Date.parse('2026-09-01T00:00:00Z'), end: Date.parse('2026-10-01T00:00:00Z') },
    ]) {
      const p = await view((await link(o, period)).token);
      expect(p).not.toBeNull();
      expect(p?.goals).toBeNull();
    }

    // Goals counted in another zone: the Vietnamese month is not one there.
    await setGoal(o, null, { posts: 3 }, o.owner, 'America/New_York');
    expect((await view((await link(o, SEP)).token))?.goals).toBeNull();
    const nySep = monthBounds('2026-09', 'America/New_York') as { start: number; end: number };
    expect((await view((await link(o, nySep)).token))?.goals?.month).toBe('2026-09');

    // An org without goals: the report as before.
    const plain = await org();
    const plainPage = await view((await link(plain, SEP)).token);
    expect(plainPage).toMatchObject({ note: null, goals: null });
  });

  it('keeps the agency note as plain text', async () => {
    const o = await org();
    const note = 'Tháng này tăng 20%.\r\n<script>alert(1)</script> & <b>đậm</b>' + String.fromCodePoint(0x202e, 0x200b, 0x07);
    const { token, linkId } = await link(o, SEP, { note });
    const page = await view(token);
    // Line breaks as LF, hidden and control characters gone, markup kept as the text it is.
    expect(page?.note).toBe('Tháng này tăng 20%.\n<script>alert(1)</script> & <b>đậm</b>');
    const listed = await rt.query<ReportLinkView[]>('social.report_link.list', {}, { actor: asUser(o.owner), orgId: o.orgId });
    expect(listed.find((l) => l.id === linkId)?.note).toBe(page?.note);
    // Empty is no note; too long is refused.
    expect((await view((await link(o, SEP, { note: '  \n ' })).token))?.note).toBeNull();
    await expect(link(o, SEP, { note: 'a'.repeat(2001) })).rejects.toMatchObject({ status: 422 });
    expect((await view((await link(o, SEP, { note: 'ữ'.repeat(2000) })).token))?.note).toHaveLength(2000);
    // The table holds no more either.
    await expect(admin((c) => c.query('UPDATE crove_social.report_link SET note = $2 WHERE id = $1', [linkId, 'a'.repeat(2001)]))).rejects.toThrow(/report_link_note_length/);
  });

  it('carries the goals in the report mail of a month, not of a week', async () => {
    const { o } = await agency();
    const save = (period: string, cadence: 'weekly' | 'monthly') =>
      exec<{ scheduleId: string }>(o, o.owner, 'social.report_schedule.save', {
        name: 'Báo cáo',
        cadence,
        ...(cadence === 'weekly' ? { weekday: 1 } : { monthDay: 1 }),
        sendHour: 8,
        timeZone: HCM,
        period,
        connectionIds: [],
        recipients: ['khach@example.vn'],
      });
    const monthly = await save('previous_month', 'monthly');
    await exec(o, o.owner, 'social.report_schedule.test', { scheduleId: monthly.scheduleId });
    const weekly = await save('previous_week', 'weekly');
    await exec(o, o.owner, 'social.report_schedule.test', { scheduleId: weekly.scheduleId });
    const mails = await admin(
      async (c) =>
        (
          await c.query<{ payload: { periodStart: string; goals?: { month: string; items: { channel: string | null; metric: string; target: number; status: string }[] } } }>(
            "SELECT payload FROM crove_kernel.mail_message WHERE org_id = $1 AND source = 'social.report_schedule.run' ORDER BY created_at",
            [o.orgId],
          )
        ).rows,
    );
    expect(mails).toHaveLength(2);
    const [month, week] = mails.map((m) => m.payload);
    // The latest month, whatever today is: the goals of the org and of both channels, judged as over.
    expect(month?.goals?.month).toMatch(/^\d{4}-\d{2}$/);
    expect(month?.goals?.items.map((i) => [i.channel, i.metric, i.target])).toEqual([
      [null, 'posts', 3],
      [null, 'reach', 50_000],
      [null, 'engagement', 500],
      ['Trang Facebook', 'posts', 3],
      ['Trang Facebook', 'impressions', 40_000],
      ['Trang Facebook', 'followersGained', 50],
      ['Zalo OA', 'posts', 1],
      ['Zalo OA', 'reach', 1000],
      ['Zalo OA', 'followersGained', 10],
    ]);
    expect(month?.goals?.items.every((i) => ['met', 'missed', 'no_data'].includes(i.status))).toBe(true);
    expect(week).not.toHaveProperty('goals');
  });
});
