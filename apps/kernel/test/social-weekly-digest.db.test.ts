// The weekly email digest on PostgreSQL 17 (#1104): the worker's sweep sends exactly one digest per member per week,
// even when two sweeps run at once; nobody who turned it off or turned Social mail off, and no viewer, gets one; a
// member limited to some channels reads only those; the review part goes only to those who may approve; an org whose
// time zone PostgreSQL does not know falls back to Asia/Ho_Chi_Minh and stops no other org; nothing goes out before
// Monday 08:00 local; and only the worker login runs the scan. The sweep is run here by hand. Set CROVE_TEST_ADMIN_URL
// to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { socialCommands, socialQueries, sweepDigests } from '@crove/mod-social';
import { renderDigestMail } from '../src/digest-mail.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const HCM = 'Asia/Ho_Chi_Minh';
const suite = ADMIN ? describe : describe.skip;

// Whether the digest of a zone is due at an instant: past Monday 08:00 local. Also the minutes to the next change, so a
// test can stay clear of one.
function localOf(zone: string, at: number) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(at).map((p) => [p.type, p.value]),
  );
  const weekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(parts.weekday ?? '') + 1;
  return { weekday, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}
const dueIn = (zone: string, at = Date.now()) => {
  const l = localOf(zone, at);
  return !(l.weekday === 1 && l.minutes < 8 * 60);
};
// Clear of a change of week or of the 08:00 gate for the next half hour.
const steady = (zone: string) => {
  const l = localOf(zone, Date.now());
  const late = l.weekday === 7 && l.minutes >= 23 * 60 + 30;
  const monday = l.weekday === 1 && l.minutes >= 7 * 60 + 30 && l.minutes < 8 * 60 + 5;
  return !late && !monday && dueIn(zone);
};
// A zone whose digest is due now and stays so for the test.
const ZONE = [HCM, 'America/New_York', 'Pacific/Kiritimati', 'Europe/London'].find(steady) ?? HCM;

interface DigestPayload {
  org: string;
  week: string;
  last: { published: number; channels: { name: string; published: number; failed: number }[]; top: { text: string; channel: string; engagement: number; path: string }[]; failures: { total: number; items: { text: string }[] } };
  next: { days: { date: string; planned: number }[]; emptyQueueDays: { channel: string; dates: string[] }[] };
  review: { total: number; items: { text: string; path: string }[] } | null;
}

suite('social weekly digest on PostgreSQL (#1104)', () => {
  const dbName = `crove_test_social_digest_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  let workerPool: pg.Pool;
  // The worker's runtime (the crove_worker login): only it enters an org's system context.
  let worker: Runtime;
  let workerDb: Db;
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
  const one = async <T extends pg.QueryResultRow>(text: string, values: unknown[] = []) => (await admin((c) => c.query<T>(text, values))).rows;

  async function person(name: string) {
    return upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@digest.test`, name: null });
  }

  type Org = { orgId: string; owner: string; admin: string; member: string; viewer: string };
  // An org with an owner, an admin, a member and a viewer, its digest zone set on the org-wide goal (null: none).
  async function org(zone: string | null = ZONE): Promise<Org> {
    const owner = await person('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    const o = { orgId, owner, admin: await person('admin'), member: await person('member'), viewer: await person('viewer') };
    await addMember(o, o.admin, 'admin');
    await addMember(o, o.member, 'member');
    await addMember(o, o.viewer, 'viewer');
    if (zone !== null) {
      await admin((c) => c.query('INSERT INTO crove_social.goal (org_id, connection_id, time_zone, posts, created_by, updated_by) VALUES ($1, NULL, $2, 10, $3, $3)', [orgId, zone, owner]));
    }
    return o;
  }
  const addMember = (o: { orgId: string }, userId: string, role: string) => admin((c) => c.query('INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, $3)', [o.orgId, userId, role]));

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

  // A draft on one channel; returns the post and its variant.
  async function post(o: Org, connectionId: string, body: string, author = o.owner) {
    const { postId } = await exec<{ postId: string }>(o, author, 'social.post.create', { body, channels: [{ connectionId }] });
    const [v] = await one<{ id: string }>('SELECT id FROM crove_social.post_variant WHERE org_id = $1 AND post_id = $2', [o.orgId, postId]);
    return { postId, variantId: v?.id as string };
  }
  // The org's week as the database sees it now in a zone.
  async function weekIn(zone: string) {
    const [w] = await one<{ last_start: Date; this_start: Date; next_start: Date; iso_week: string }>(
      `SELECT timezone($1, date_trunc('week', timezone($1, now())) - interval '7 days') AS last_start,
              timezone($1, date_trunc('week', timezone($1, now()))) AS this_start,
              timezone($1, date_trunc('week', timezone($1, now())) + interval '7 days') AS next_start,
              to_char(timezone($1, now()), 'IYYY-"W"IW') AS iso_week`,
      [zone],
    );
    return w as { last_start: Date; this_start: Date; next_start: Date; iso_week: string };
  }
  const hours = (d: Date, h: number) => new Date(d.getTime() + h * 3_600_000);
  async function published(o: Org, connectionId: string, body: string, at: Date, engagement: number) {
    const p = await post(o, connectionId, body);
    await admin((c) => c.query("UPDATE crove_social.post_variant SET status = 'published', published_at = $3, external_post_id = $4 WHERE org_id = $1 AND id = $2", [o.orgId, p.variantId, at, `ext-${p.variantId.slice(0, 8)}`]));
    if (engagement > 0) {
      await admin((c) =>
        c.query('INSERT INTO crove_social.metric_snapshot (org_id, variant_id, capture_key, metrics) VALUES ($1, $2, $3, $4)', [o.orgId, p.variantId, `test-${p.variantId}`, JSON.stringify({ reactions: engagement, comments: 0 })]),
      );
    }
    return p;
  }
  async function failed(o: Org, connectionId: string, body: string, at: Date) {
    const p = await post(o, connectionId, body);
    await admin((c) => c.query("UPDATE crove_social.post_variant SET status = 'failed', updated_at = $3 WHERE org_id = $1 AND id = $2", [o.orgId, p.variantId, at]));
    return p;
  }
  async function planned(o: Org, connectionId: string, body: string, at: Date) {
    const p = await post(o, connectionId, body);
    await admin((c) => c.query("UPDATE crove_social.post_variant SET status = 'scheduled', scheduled_at = $3 WHERE org_id = $1 AND id = $2", [o.orgId, p.variantId, at]));
    return p;
  }
  // A post sent to review by its author.
  async function inReview(o: Org, connectionId: string, body: string, author: string) {
    const p = await post(o, connectionId, body, author);
    await exec(o, author, 'social.post.submit', { postId: p.postId });
    return p;
  }

  const emailOf = async (userId: string) => (await one<{ email: string }>('SELECT email FROM crove_kernel.user_account WHERE id = $1', [userId]))[0]?.email as string;
  const digests = (o: Org) =>
    one<{ to_address: string; status: string; subject: string; source_id: string; payload: DigestPayload }>(
      "SELECT to_address, status, subject, source_id::text, payload FROM crove_kernel.mail_message WHERE org_id = $1 AND source = 'social.digest.week' ORDER BY to_address",
      [o.orgId],
    );
  const digestOf = async (o: Org, userId: string) => {
    const email = await emailOf(userId);
    return (await digests(o)).filter((m) => m.to_address === email);
  };
  const markers = (o: Org) => one<{ id: string; iso_week: string }>('SELECT id::text, iso_week FROM crove_social.digest_week WHERE org_id = $1', [o.orgId]);
  const sweep = () => sweepDigests({ runtime: worker, workerDb });

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
    workerPool = createPool({ connectionString: asWorker.toString(), max: 4 });
    workerDb = createDb(workerPool);
    worker = new Runtime(workerDb).register(registry);
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

  it('sends exactly one digest per member per week, even with two sweeps at once, and none to the muted, mail off, suppressed or viewers', async () => {
    const o = await org();
    const muted = await person('muted');
    const mailOff = await person('mailoff');
    const suppressed = await person('suppressed');
    for (const u of [muted, mailOff, suppressed]) await addMember(o, u, 'member');
    await exec(o, muted, 'social.notification.mute', { kind: 'weekly_digest', muted: true });
    await exec(o, mailOff, 'social.notification.mail', { enabled: false });
    await admin(async (c) => c.query("INSERT INTO crove_kernel.mail_suppression (org_id, to_hash, scope, reason) SELECT $1, crove_kernel.mail_address_hash($2), 'all', 'manual'", [o.orgId, await emailOf(suppressed)]));
    const conn = await connection(o, 'Trang chính');
    const week = await weekIn(ZONE);
    await published(o, conn, 'Bài tuần trước', hours(week.last_start, 30), 12);
    await failed(o, conn, 'Bài lỗi tuần trước', hours(week.last_start, 50));
    await planned(o, conn, 'Bài tuần này', hours(week.this_start, 24 * 6 + 10));

    await Promise.all([sweep(), sweep()]);
    expect(await markers(o)).toEqual([{ id: expect.any(String), iso_week: week.iso_week }]);
    const mails = await digests(o);
    const expected = [o.owner, o.admin, o.member, suppressed];
    expect(mails.map((m) => m.to_address).sort()).toEqual((await Promise.all(expected.map(emailOf))).sort());
    // Suppressed addresses get a row, never a send.
    expect(mails.filter((m) => m.status === 'suppressed').map((m) => m.to_address)).toEqual([await emailOf(suppressed)]);
    expect(mails.filter((m) => m.status === 'queued')).toHaveLength(3);
    const [marker] = await markers(o);
    expect(mails.every((m) => m.source_id === marker?.id && m.subject.startsWith('Bản tin tuần '))).toBe(true);
    for (const u of [muted, mailOff, o.viewer]) expect(await digestOf(o, u)).toEqual([]);
    const [mine] = await digestOf(o, o.member);
    expect(mine?.payload).toMatchObject({
      week: week.iso_week,
      last: { published: 1, channels: [{ name: 'Trang chính', published: 1, failed: 1 }], top: [{ text: 'Bài tuần trước', channel: 'Trang chính', engagement: 12 }], failures: { total: 1, items: [{ text: 'Bài lỗi tuần trước' }] } },
      review: null,
    });
    expect(mine?.payload.next.days.reduce((n, d) => n + d.planned, 0)).toBe(1);
    // The template renders what the command wrote.
    const rendered = await renderDigestMail({ messageId: randomUUID(), subject: mine?.subject ?? null, payload: mine?.payload as unknown as Record<string, unknown>, publicUrl: 'https://crove.test', inboundAddress: null, brand: 'Crove', execute: async () => { throw new Error('unused'); } });
    expect(rendered?.text).toContain('Bài tuần trước');

    // Later sweeps and a direct command find the week claimed.
    await sweep();
    expect(await worker.execute('social.digest.send', {}, { actor: system, orgId: o.orgId })).toMatchObject({ state: 'claimed', week: week.iso_week });
    expect(await digests(o)).toHaveLength(4);
    expect(await markers(o)).toHaveLength(1);
  });

  it('mails no disabled account, and skips a recipient whose mail cannot be written instead of the whole digest (#1115)', async () => {
    const o = await org();
    const conn = await connection(o, 'Trang chính');
    const week = await weekIn(ZONE);
    await published(o, conn, 'Bài tuần trước', hours(week.last_start, 30), 5);
    await planned(o, conn, 'Bài tuần này', hours(week.this_start, 24 * 6 + 10));
    await admin((c) => c.query('UPDATE crove_kernel.user_account SET disabled_at = now() WHERE id = $1', [o.member]));
    // The admin's mail fails to be written every time, as a constraint or trigger would refuse it.
    const refused = await emailOf(o.admin);
    await admin(async (c) => {
      await c.query('CREATE SCHEMA IF NOT EXISTS test_1115');
      await c.query(
        `CREATE OR REPLACE FUNCTION test_1115.refuse() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$ BEGIN IF NEW.to_address = '${refused}' THEN RAISE EXCEPTION 'refused for the test'; END IF; RETURN NEW; END $$`,
      );
      await c.query('GRANT USAGE ON SCHEMA test_1115 TO PUBLIC');
      await c.query('CREATE TRIGGER test_1115_refuse BEFORE INSERT ON crove_kernel.mail_message FOR EACH ROW EXECUTE FUNCTION test_1115.refuse()');
    });
    try {
      await sweep();
    } finally {
      await admin((c) => c.query('DROP TRIGGER IF EXISTS test_1115_refuse ON crove_kernel.mail_message'));
    }
    expect(await markers(o)).toHaveLength(1);
    expect((await digests(o)).map((m) => m.to_address)).toEqual([await emailOf(o.owner)]);
    // The claim and the owner's mail committed; the admin's was skipped, and the disabled member got none.
    expect(await digestOf(o, o.admin)).toEqual([]);
    expect(await digestOf(o, o.member)).toEqual([]);
  });

  it('saves a goal zone as PostgreSQL spells it, so the digest finds it (#1115)', async () => {
    const o = await org(null);
    await exec(o, o.owner, 'social.goal.set', { connectionId: null, targets: { posts: 5 }, timeZone: 'asia/ho_chi_minh' });
    expect(await one<{ time_zone: string }>('SELECT time_zone FROM crove_social.goal WHERE org_id = $1', [o.orgId])).toEqual([{ time_zone: HCM }]);
    await exec(o, o.owner, 'social.goal.set', { connectionId: null, targets: { posts: 6 }, timeZone: 'EUROPE/LONDON' });
    expect(await one<{ time_zone: string }>('SELECT time_zone FROM crove_social.goal WHERE org_id = $1', [o.orgId])).toEqual([{ time_zone: 'Europe/London' }]);
    // An empty or unknown zone is refused, never saved to fall back later.
    await expect(exec(o, o.owner, 'social.goal.set', { connectionId: null, targets: { posts: 6 }, timeZone: '' })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(exec(o, o.owner, 'social.goal.set', { connectionId: null, targets: { posts: 6 }, timeZone: 'Mars/Olympus' })).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(await one<{ time_zone: string }>('SELECT time_zone FROM crove_social.goal WHERE org_id = $1', [o.orgId])).toEqual([{ time_zone: 'Europe/London' }]);
  });

  it('claims a week once when two commands run at the same time', async () => {
    const o = await org();
    const conn = await connection(o, 'Trang thử');
    await inReview(o, conn, 'Chờ duyệt', o.member);
    const both = await Promise.all([0, 1].map(() => worker.execute<{ state: string; mails: number }>('social.digest.send', {}, { actor: system, orgId: o.orgId })));
    expect(both.map((r) => r.state).sort()).toEqual(['claimed', 'sent']);
    expect(await markers(o)).toHaveLength(1);
    // Only the owner and the admin have something to read: the post waiting for their review.
    expect((await digests(o)).map((m) => m.to_address).sort()).toEqual((await Promise.all([o.owner, o.admin].map(emailOf))).sort());
  });

  it("leaves other channels out of a limited member's digest, and gives the reviews only to those who may approve", async () => {
    const o = await org();
    const limited = await person('limited');
    await addMember(o, limited, 'member');
    const a = await connection(o, 'Kênh A');
    const b = await connection(o, 'Kênh B');
    await exec(o, o.owner, 'social.channel_access.set', { userId: limited, channelConnectionIds: [a] });
    const week = await weekIn(ZONE);
    await published(o, a, 'Bài trên A', hours(week.last_start, 20), 5);
    await published(o, b, 'Bài trên B', hours(week.last_start, 22), 50);
    await failed(o, b, 'Lỗi trên B', hours(week.last_start, 40));
    await planned(o, b, 'Lịch trên B', hours(week.this_start, 24 * 5));
    const reviewA = await inReview(o, a, 'Duyệt trên A', o.member);
    const reviewB = await inReview(o, b, 'Duyệt trên B', o.member);
    // The admin already approved B's content in this round: it no longer waits for them.
    const [vb] = await one<{ id: string; revision: number; content_hash: string }>('SELECT id, revision, content_hash FROM crove_social.post_variant WHERE org_id = $1 AND id = $2', [o.orgId, reviewB.variantId]);
    await admin((c) =>
      c.query("INSERT INTO crove_social.post_approval (org_id, post_id, variant_id, decision, decided_by, revision, content_hash, snapshot) VALUES ($1, $2, $3, 'approved', $4, $5, $6, '{}'::jsonb)", [
        o.orgId,
        reviewB.postId,
        vb?.id,
        o.admin,
        vb?.revision,
        vb?.content_hash,
      ]),
    );

    await sweep();
    const [lim] = await digestOf(o, limited);
    expect(lim?.payload.last).toMatchObject({ published: 1, channels: [{ name: 'Kênh A', published: 1, failed: 0 }], top: [{ text: 'Bài trên A', channel: 'Kênh A' }], failures: { total: 0, items: [] } });
    expect(lim?.payload.next.days.every((d) => d.planned === 0)).toBe(true);
    expect(JSON.stringify(lim?.payload)).not.toMatch(/Kênh B|trên B/);
    expect(lim?.payload.review).toBeNull();

    const [member] = await digestOf(o, o.member);
    expect(member?.payload.last.top.map((t) => t.text)).toEqual(['Bài trên B', 'Bài trên A']);
    expect(member?.payload.last.failures.total).toBe(1);
    expect(member?.payload.next.days.reduce((n, d) => n + d.planned, 0)).toBe(1);
    expect(member?.payload.review).toBeNull();

    const [owner] = await digestOf(o, o.owner);
    expect(owner?.payload.review?.items.map((r) => r.text).sort()).toEqual(['Duyệt trên A', 'Duyệt trên B']);
    expect(owner?.payload.review?.items.every((r) => /^\/o\/[a-z0-9-]+\/social\/[0-9a-f-]{36}$/.test(r.path))).toBe(true);
    const [adm] = await digestOf(o, o.admin);
    expect(adm?.payload.review).toEqual({ total: 1, items: [{ text: 'Duyệt trên A', path: expect.stringContaining(reviewA.postId) }] });
    expect(await digestOf(o, o.viewer)).toEqual([]);
  });

  it("falls back to Asia/Ho_Chi_Minh for a zone PostgreSQL does not know, and one org's bad zone stops no other org", async () => {
    const before = dueIn(HCM);
    const bad = await org('Mars/Olympus');
    const badSchedule = await org(null);
    await admin((c) =>
      c.query(
        "INSERT INTO crove_social.report_schedule (org_id, name, cadence, weekday, time_zone, period, recipients, next_run_at, created_by) VALUES ($1, 'Báo cáo', 'weekly', 1, 'Nowhere/Land', 'previous_week', ARRAY['khach@digest.test'], now() + interval '1 day', $2)",
        [badSchedule.orgId, badSchedule.owner],
      ),
    );
    const good = [await org(), await org()];
    for (const o of [bad, badSchedule, ...good]) await inReview(o, await connection(o, 'Trang'), 'Chờ duyệt', o.member);
    // The scan itself answers, whatever the zones.
    const { rows } = await workerPool.query<{ org_id: string }>('SELECT org_id FROM crove_social.digest_due(NULL, 500)');
    const due = new Set(rows.map((r) => r.org_id));
    for (const o of good) expect(due.has(o.orgId)).toBe(true);
    await sweep();
    for (const o of good) expect(await markers(o)).toHaveLength(1);
    // The fallback zone decides for the others, when it did not change during the test.
    if (before === dueIn(HCM)) {
      for (const o of [bad, badSchedule]) {
        expect(due.has(o.orgId)).toBe(before);
        expect((await markers(o)).map((m) => m.iso_week)).toEqual(before ? [(await weekIn(HCM)).iso_week] : []);
      }
    }
  });

  it('sends nothing before Monday 08:00 local, and the scan follows each zone', async () => {
    const o = await org();
    await inReview(o, await connection(o, 'Trang'), 'Chờ duyệt', o.member);
    // This week's Monday (the database's week), a minute before and after 08:00 in the org's zone.
    const [at] = await one<{ before: Date; after: Date; iso_week: string }>(
      `SELECT timezone($1, m + interval '7 hours 59 minutes') AS before, timezone($1, m + interval '8 hours 1 minute') AS after, to_char(m, 'IYYY-"W"IW') AS iso_week
       FROM (SELECT date_trunc('week', timezone($1, now())) AS m) w`,
      [ZONE],
    );
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(at?.before as Date);
      expect(await worker.execute('social.digest.send', {}, { actor: system, orgId: o.orgId })).toMatchObject({ state: 'not_due', week: at?.iso_week, mails: 0 });
      expect(await markers(o)).toEqual([]);
      expect(await digests(o)).toEqual([]);
      vi.setSystemTime(at?.after as Date);
      expect(await worker.execute('social.digest.send', {}, { actor: system, orgId: o.orgId })).toMatchObject({ state: 'sent', week: at?.iso_week, mails: 2 });
    } finally {
      vi.useRealTimers();
    }
    expect((await markers(o)).map((m) => m.iso_week)).toEqual([at?.iso_week]);

    // One org per whole-hour zone, from UTC+14 to UTC-12: the scan names those past Monday 08:00 now. A zone whose gate
    // changed while the test ran is left out.
    const zones = Array.from({ length: 27 }, (_, i) => 14 - i).map((h) => (h === 0 ? 'Etc/GMT' : `Etc/GMT${h > 0 ? '-' : '+'}${Math.abs(h)}`));
    const orgs = new Map<string, string>();
    for (const zone of zones) {
      const z = await org(zone);
      await post(z, await connection(z, 'Trang'), 'Bản nháp');
      orgs.set(z.orgId, zone);
    }
    const expected = new Map(zones.map((zone) => [zone, dueIn(zone)]));
    const { rows } = await workerPool.query<{ org_id: string }>('SELECT org_id FROM crove_social.digest_due(NULL, 500)');
    const named = new Set(rows.map((r) => r.org_id));
    let checked = 0;
    for (const [orgId, zone] of orgs) {
      if (expected.get(zone) !== dueIn(zone)) continue;
      expect([zone, named.has(orgId)]).toEqual([zone, expected.get(zone)]);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(20);
  });

  it("claims no week while the command's clock and the database's are in different ISO weeks", async () => {
    const o = await org();
    await inReview(o, await connection(o, 'Trang'), 'Chờ duyệt', o.member);
    // Monday 10:00 local three weeks back and one week ahead: past 08:00 by the command's clock, but not the database's
    // week, so a skewed clock neither sends an old week nor claims the next one early.
    const [at] = await one<{ past: Date; ahead: Date; past_week: string; ahead_week: string }>(
      `SELECT timezone($1, m - interval '21 days' + interval '10 hours') AS past, timezone($1, m + interval '7 days' + interval '10 hours') AS ahead,
              to_char(m - interval '21 days', 'IYYY-"W"IW') AS past_week, to_char(m + interval '7 days', 'IYYY-"W"IW') AS ahead_week
       FROM (SELECT date_trunc('week', timezone($1, now())) AS m) w`,
      [ZONE],
    );
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(at?.past as Date);
      expect(await worker.execute('social.digest.send', {}, { actor: system, orgId: o.orgId })).toMatchObject({ state: 'not_due', week: at?.past_week, mails: 0 });
      vi.setSystemTime(at?.ahead as Date);
      expect(await worker.execute('social.digest.send', {}, { actor: system, orgId: o.orgId })).toMatchObject({ state: 'not_due', week: at?.ahead_week, mails: 0 });
    } finally {
      vi.useRealTimers();
    }
    expect(await markers(o)).toEqual([]);
    expect(await digests(o)).toEqual([]);
    // With both clocks in the same week, the week goes out once.
    expect(await worker.execute('social.digest.send', {}, { actor: system, orgId: o.orgId })).toMatchObject({ state: 'sent', week: (await weekIn(ZONE)).iso_week });
    expect(await markers(o)).toHaveLength(1);
  });

  it('keeps the scan for the worker login, the command for the system, and pages with a clamped limit', async () => {
    const { rows } = await admin((c) =>
      c.query<{ role: string; ok: boolean }>(
        "SELECT r AS role, has_function_privilege(r, 'crove_social.digest_due(uuid, int)', 'EXECUTE') AS ok FROM unnest(ARRAY['crove_worker', 'crove_app', 'crove_tenant', 'crove_definer_tenant']) r",
      ),
    );
    expect(Object.fromEntries(rows.map((r) => [r.role, r.ok]))).toEqual({ crove_worker: true, crove_app: false, crove_tenant: false, crove_definer_tenant: false });
    const [acl] = await one<{ acl: string }>("SELECT proacl::text AS acl FROM pg_proc WHERE oid = 'crove_social.digest_due(uuid, int)'::regprocedure");
    // No PUBLIC entry (an ACL item with an empty grantee).
    expect(acl?.acl).not.toMatch(/[{,]=/);
    await expect(pool.query('SELECT * FROM crove_social.digest_due(NULL, 10)')).rejects.toThrow(/permission denied/);
    const o = await org();
    await expect(exec(o, o.owner, 'social.digest.send', {})).rejects.toThrow();
    // The limit is clamped: zero or less still reads one, the order is by org.
    await inReview(o, await connection(o, 'Trang'), 'Chờ duyệt', o.member);
    const page = await workerPool.query<{ org_id: string }>('SELECT org_id FROM crove_social.digest_due(NULL, 0)');
    expect(page.rows).toHaveLength(1);
    const after = await workerPool.query<{ org_id: string }>('SELECT org_id FROM crove_social.digest_due($1, 500)', [page.rows[0]?.org_id]);
    expect(after.rows.every((r) => r.org_id > (page.rows[0]?.org_id ?? ''))).toBe(true);
  });
});
