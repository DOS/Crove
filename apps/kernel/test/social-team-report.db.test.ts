// The team report (#1058) on PostgreSQL 17: per member, over a fixed September, the posts created, sent to review,
// approved and published (as author), assigned with a due date and overdue; per reviewer the decisions with the exact
// median time from submission to decision; for client review links the exact median time to the first answer. A
// member who left shows as left without a name, viewers and members are refused, another org's work never counts.
// The commands run as they would; the test then moves their times into September as the database owner, with
// triggers off, since append-only rows keep the time they were written. Set CROVE_TEST_ADMIN_URL to a superuser URL;
// each run makes its own database.
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { socialCommands, socialQueries, type PostView, type TeamMemberRow, type TeamReport } from '@crove/mod-social';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const HOUR = 3600;

// September 2026 in UTC, the period every assertion is about.
const FROM = '2026-09-01T00:00:00.000Z';
const TO = '2026-10-01T00:00:00.000Z';
const at = (day: string, time: string) => `2026-${day}T${time}:00.000Z`;

suite('social team report on PostgreSQL (#1058)', () => {
  const dbName = `crove_test_social_team_report_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
  // As the database owner with triggers off: append-only rows and the variant state machine let the test set times.
  const owner = (text: string, values: unknown[]) =>
    admin(async (c) => {
      await c.query("SET session_replication_role = 'replica'");
      await c.query(text, values);
    });

  const person = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@team-report.test`, name: null });

  type Org = { orgId: string; owner: string; reviewer: string; second: string; writer: string; leaver: string; viewer: string };
  async function org(): Promise<Org> {
    const ownerId = await person('owner');
    const { orgId } = await createOrg(rt, asUser(ownerId), `Org ${randomUUID().slice(0, 6)}`);
    const roles = { reviewer: ['admin', await person('reviewer')], second: ['admin', await person('second')], writer: ['member', await person('writer')], leaver: ['member', await person('leaver')], viewer: ['viewer', await person('viewer')] } as const;
    for (const [role, id] of Object.values(roles)) {
      await admin((c) => c.query('INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, $3)', [orgId, id, role]));
    }
    return { orgId, owner: ownerId, reviewer: roles.reviewer[1], second: roles.second[1], writer: roles.writer[1], leaver: roles.leaver[1], viewer: roles.viewer[1] };
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
  const seen = (p: PostView) => p.variants.filter((v) => v.status === 'in_review').map((v) => ({ variantId: v.id, revision: v.revision, contentHash: v.contentHash }));
  const report = (o: Org, user: string, range: { from: string; to: string } = { from: FROM, to: TO }) => rt.query<TeamReport>('social.team.report', range, { actor: asUser(user), orgId: o.orgId });
  const refusal = (p: Promise<unknown>) => p.then(() => 'resolved', (e: unknown) => (e as { code?: string; status?: number }).code ?? String((e as { status?: number }).status ?? e));

  // A post by `author` made at `created`, on the channels given.
  async function post(o: Org, author: string, created: string, channels: string[]): Promise<string> {
    const { postId } = await exec<{ postId: string }>(o, author, 'social.post.create', { body: `Bài ${randomUUID().slice(0, 6)}`, channels: channels.map((connectionId) => ({ connectionId })) });
    await owner('UPDATE crove_social.post SET created_at = $3 WHERE org_id = $1 AND id = $2', [o.orgId, postId, created]);
    return postId;
  }
  // Sent to review by `user` at `when` (the newest submit of the post is the one just made).
  async function submit(o: Org, user: string, postId: string, when: string) {
    await exec(o, user, 'social.post.submit', { postId });
    await owner(
      `UPDATE crove_kernel.audit_event SET occurred_at = $3 WHERE org_id = $1 AND id = (
         SELECT id FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'social.post.submit' AND target_id = $2 ORDER BY occurred_at DESC LIMIT 1)`,
      [o.orgId, postId, when],
    );
  }
  // A review decision by `user` at `when`, on every channel in review (one row per channel, one decision).
  async function decide(o: Org, user: string, postId: string, decision: 'approved' | 'changes_requested', when: string) {
    await exec(o, user, 'social.variant.decide', { postId, decision, variants: seen(await get(o, postId)) });
    await owner(
      `UPDATE crove_social.post_approval SET created_at = $3 WHERE org_id = $1 AND post_id = $2
         AND created_at = (SELECT max(created_at) FROM crove_social.post_approval WHERE org_id = $1 AND post_id = $2)`,
      [o.orgId, postId, when],
    );
  }
  const publish = (o: Org, postId: string, when: string) =>
    owner("UPDATE crove_social.post_variant SET status = 'published', published_at = $3 WHERE org_id = $1 AND post_id = $2", [o.orgId, postId, when]);
  const assign = (o: Org, postId: string, assignee: string, due: string) => exec(o, o.owner, 'social.post.assign', { postId, assigneeUserId: assignee, dueAt: due });

  // A client review link made at `created` for one post (or a plan of several), and a client's answer on it.
  async function link(o: Org, created: string, posts: string[], plan = false): Promise<string> {
    const id = randomUUID();
    const expires = new Date(Date.parse(created) + 30 * 86_400_000).toISOString();
    const token = createHash('sha256').update(id).digest('hex');
    await admin(async (c) => {
      await c.query('INSERT INTO crove_social.review_link (org_id, id, post_id, token_sha256, created_by, created_at, expires_at, kind) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', [
        o.orgId,
        id,
        plan ? null : posts[0],
        token,
        o.owner,
        created,
        expires,
        plan ? 'plan' : 'post',
      ]);
      if (plan) {
        for (const [position, postId] of posts.entries()) {
          await c.query('INSERT INTO crove_social.review_link_post (org_id, link_id, post_id, position) VALUES ($1, $2, $3, $4)', [o.orgId, id, postId, position]);
        }
      }
    });
    return id;
  }
  const answer = (o: Org, linkId: string, postId: string, verdict: 'approved' | 'changes_requested' | 'comment', when: string) =>
    admin((c) =>
      c.query('INSERT INTO crove_social.review_feedback (org_id, link_id, post_id, reviewer_name, verdict, body, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)', [
        o.orgId,
        linkId,
        postId,
        'Chị Hoa',
        verdict,
        verdict === 'comment' ? 'Đẹp lắm' : null,
        when,
      ]),
    );

  let a: Org;
  let other: Org;
  let rows: Map<string, TeamMemberRow>;
  let full: TeamReport;

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const url = new URL(ADMIN as string);
    url.pathname = `/${dbName}`;
    adminUrl = url.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    const app = new URL(adminUrl);
    app.username = 'crove_app';
    app.password = 'test-app-pw';
    pool = createPool({ connectionString: app.toString(), max: 4 });
    db = createDb(pool);
    rt = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands, ...socialCommands], queries: [...kernelQueries({ inboundDomain: null }), ...socialQueries] });

    a = await org();
    other = await org();
    const one = await connection(a);
    const two = await connection(a);

    // The writer's post on two channels: sent at 12:00, approved by the reviewer two hours later in one decision on
    // both channels, published the next day; a client answered its link after a comment, a day after it was made.
    const p1 = await post(a, a.writer, at('09-02', '10:00'), [one, two]);
    await submit(a, a.writer, p1, at('09-02', '12:00'));
    await decide(a, a.reviewer, p1, 'approved', at('09-02', '14:00'));
    await publish(a, p1, at('09-03', '08:00'));
    const l1 = await link(a, at('09-02', '15:00'), [p1]);
    await answer(a, l1, p1, 'comment', at('09-02', '16:00'));
    await answer(a, l1, p1, 'approved', at('09-03', '15:00'));
    await answer(a, l1, p1, 'changes_requested', at('09-04', '09:00'));

    // Sent twice: changes asked four hours after the first submission, approved an hour after the second.
    const p2 = await post(a, a.writer, at('09-05', '07:00'), [one]);
    await submit(a, a.writer, p2, at('09-05', '08:00'));
    await decide(a, a.reviewer, p2, 'changes_requested', at('09-05', '12:00'));
    await submit(a, a.writer, p2, at('09-06', '08:00'));
    await decide(a, a.reviewer, p2, 'approved', at('09-06', '09:00'));

    // The member who leaves: their post approved six hours after submission by the second admin.
    const p3 = await post(a, a.leaver, at('09-09', '20:00'), [one]);
    await submit(a, a.leaver, p3, at('09-10', '00:00'));
    await decide(a, a.second, p3, 'approved', at('09-10', '06:00'));

    // An import sent to review as it was made has no submit of its own: its creation stands for it (12 hours).
    const imported = await exec<{ posts: { postId: string }[] }>(a, a.owner, 'social.post.import', { posts: [{ body: 'Bài nhập từ bảng tính', connectionIds: [one] }], submit: true });
    const p7 = imported.posts[0]?.postId as string;
    await owner('UPDATE crove_social.post SET created_at = $3 WHERE org_id = $1 AND id = $2', [a.orgId, p7, at('09-12', '00:00')]);
    await decide(a, a.reviewer, p7, 'approved', at('09-12', '12:00'));

    // Approved three hours after submission, published the day before its due date; assigned to the leaver.
    const p5 = await post(a, a.writer, at('09-19', '23:00'), [one]);
    await submit(a, a.writer, p5, at('09-20', '00:00'));
    await decide(a, a.second, p5, 'approved', at('09-20', '03:00'));
    await assign(a, p5, a.leaver, at('09-25', '00:00'));
    await publish(a, p5, at('09-24', '08:00'));
    // A plan link of two posts: the client asked for changes on one after two hours, approved the other after six.
    const plan = await link(a, at('09-20', '04:00'), [p2, p5], true);
    await answer(a, plan, p2, 'changes_requested', at('09-20', '06:00'));
    await answer(a, plan, p5, 'approved', at('09-20', '10:00'));

    // Made in August, due in September and never published: overdue. A cancelled one due then counts for nobody.
    const p4 = await post(a, a.writer, at('08-20', '09:00'), [one]);
    await assign(a, p4, a.writer, at('09-15', '00:00'));
    const p8 = await post(a, a.writer, at('08-21', '09:00'), [one]);
    await assign(a, p8, a.writer, at('09-16', '00:00'));
    await exec(a, a.writer, 'social.variant.cancel', { variantIds: (await get(a, p8)).variants.map((v) => v.id) });

    // October is outside the period: a post, its submission, its decision and the client's answer.
    const p6 = await post(a, a.writer, at('10-05', '08:00'), [one]);
    await submit(a, a.writer, p6, at('10-05', '09:00'));
    await decide(a, a.reviewer, p6, 'approved', at('10-05', '10:00'));
    const l6 = await link(a, at('10-05', '11:00'), [p6]);
    await answer(a, l6, p6, 'approved', at('10-05', '12:00'));

    // Another org's work in the same hours.
    const theirs = await connection(other);
    const q1 = await post(other, other.writer, at('09-02', '10:00'), [theirs]);
    await submit(other, other.writer, q1, at('09-02', '11:00'));
    await decide(other, other.reviewer, q1, 'approved', at('09-02', '11:30'));
    const lq = await link(other, at('09-02', '12:00'), [q1]);
    await answer(other, lq, q1, 'approved', at('09-02', '12:30'));

    // The leaver leaves after all of it.
    await admin((c) => c.query('DELETE FROM crove_kernel.tenant_member WHERE org_id = $1 AND user_id = $2', [a.orgId, a.leaver]));

    full = await report(a, a.owner);
    rows = new Map(full.members.map((m) => [m.userId, m]));
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('counts what each writer did in the period, as author, submitter and assignee', () => {
    expect(rows.get(a.writer)).toMatchObject({ left: false, created: 3, submitted: 3, approved: 3, published: 2, assigned: 1, overdue: 1, decisions: 0, decisionSeconds: null });
    expect(rows.get(a.owner)).toMatchObject({ left: false, created: 1, submitted: 0, approved: 1, published: 0, assigned: 0, overdue: 0, decisions: 0 });
    expect(rows.get(a.writer)?.name).toMatch(/^writer-.*@team-report\.test$/);
  });

  it('gives each reviewer their decisions, one per post and verdict, and the exact median wait from submission', () => {
    // 2 h, 4 h, 1 h and the import's 12 h: the mean of 2 h and 4 h.
    expect(rows.get(a.reviewer)).toMatchObject({ decisions: 4, decisionSeconds: 3 * HOUR, created: 0 });
    // 6 h and 3 h.
    expect(rows.get(a.second)).toMatchObject({ decisions: 2, decisionSeconds: 4.5 * HOUR });
  });

  it('shows a member who left as left, without a name, with what they did, after the members', () => {
    expect(rows.get(a.leaver)).toEqual({ userId: a.leaver, name: null, left: true, created: 1, submitted: 1, approved: 1, published: 0, assigned: 1, overdue: 0, decisions: 0, decisionSeconds: null });
    expect(full.members.at(-1)?.userId).toBe(a.leaver);
    expect(full.members.filter((m) => m.left)).toHaveLength(1);
  });

  it("gives the client links' first answers in the period and the exact median time to them", () => {
    // 24 h (after a comment, which is no answer), 2 h and 6 h on the plan link; the second answer and October's are out.
    expect(full.client).toEqual({ answers: 3, approved: 2, changesRequested: 1, medianSeconds: 6 * HOUR });
  });

  it('lists the members without anything in the period, but no viewer, and nobody of another org', () => {
    expect([...rows.keys()].sort()).toEqual([a.owner, a.reviewer, a.second, a.writer, a.leaver].sort());
    for (const id of [other.owner, other.reviewer, other.writer, a.viewer]) expect(rows.has(id)).toBe(false);
    expect(full).toMatchObject({ from: FROM, to: TO });
  });

  it('answers admins as it answers owners, and the other org only with its own work', async () => {
    expect(await report(a, a.reviewer)).toEqual(full);
    const theirs = await report(other, other.owner);
    expect(theirs.members.find((m) => m.userId === other.reviewer)).toMatchObject({ decisions: 1, decisionSeconds: 1800 });
    expect(theirs.members.find((m) => m.userId === other.writer)).toMatchObject({ created: 1, submitted: 1, approved: 1 });
    expect(theirs.client).toEqual({ answers: 1, approved: 1, changesRequested: 0, medianSeconds: 1800 });
  });

  // #1064: the scans stay flat as history grows. Submissions are read back TEAM_REPORT_LOOKBACK_DAYS (90) before the
  // period only, and clients' answers only on links that could take one in it (a link lives at most 31 days).
  it('reads submissions 90 days back at most and answers only on links that could take one in the period (#1064)', async () => {
    const c = await org();
    const one = await connection(c);
    // Submitted in May, decided in September: older than the lookback, so its creation in April stands for it.
    const old = await post(c, c.writer, at('04-01', '00:00'), [one]);
    await submit(c, c.writer, old, at('05-01', '00:00'));
    await decide(c, c.reviewer, old, 'approved', at('09-02', '00:00'));
    // Submitted on 20 August, inside the lookback: its own submission counts, 12 days and 12 hours.
    const recent = await post(c, c.writer, at('07-01', '00:00'), [one]);
    await submit(c, c.writer, recent, at('08-20', '00:00'));
    await decide(c, c.second, recent, 'approved', at('09-01', '12:00'));
    // A link made long before the period, with an answer written into it (no live link could take one), is not read;
    // a link whose first answer came before the period has none in it.
    const stale = await link(c, at('07-01', '00:00'), [recent]);
    await answer(c, stale, recent, 'approved', at('09-02', '00:00'));
    const early = await link(c, at('08-15', '00:00'), [old]);
    await answer(c, early, old, 'changes_requested', at('08-20', '00:00'));
    await answer(c, early, old, 'approved', at('09-03', '00:00'));
    const r = await report(c, c.owner);
    expect(r.members.find((m) => m.userId === c.reviewer)).toMatchObject({ decisions: 1, decisionSeconds: (Date.parse(at('09-02', '00:00')) - Date.parse(at('04-01', '00:00'))) / 1000 });
    expect(r.members.find((m) => m.userId === c.second)).toMatchObject({ decisions: 1, decisionSeconds: 12 * 24 * HOUR + 12 * HOUR });
    expect(r.client).toEqual({ answers: 0, approved: 0, changesRequested: 0, medianSeconds: null });
  });

  it('refuses members and viewers', async () => {
    expect(await refusal(report(a, a.writer))).toBe('FORBIDDEN');
    expect(await refusal(report(a, a.viewer))).toBe('FORBIDDEN');
  });

  it('takes a period of at most 366 days that ends after it starts', async () => {
    expect(await refusal(report(a, a.owner, { from: TO, to: FROM }))).toBe('TEAM_RANGE_INVALID');
    expect(await refusal(report(a, a.owner, { from: FROM, to: FROM }))).toBe('TEAM_RANGE_INVALID');
    expect(await refusal(report(a, a.owner, { from: '2025-09-01T00:00:00.000Z', to: '2026-09-03T00:00:00.000Z' }))).toBe('TEAM_RANGE_INVALID');
    const year = await report(a, a.owner, { from: '2025-10-01T00:00:00.000Z', to: TO });
    // August's two posts count too; the cancelled one is still never assigned work.
    expect(year.members.find((m) => m.userId === a.writer)).toMatchObject({ created: 5, assigned: 1, overdue: 1 });
  });
});
