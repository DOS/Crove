// Scheduled client report mail (#704) on PostgreSQL 17: owners and admins set schedules within the limits; the
// worker runs the due ones, queues one mail per recipient with the period's numbers and moves the next send on; the
// mail goes out through the queue with a report link minted for that recipient (its token only in the mail), which
// opens the report of the period; a test goes to the person who asks; mail off is recorded; other orgs and members see
// nothing; a schedule's note, label and sections reach its mail and each mail's link (#1259). Set CROVE_TEST_ADMIN_URL
// to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { DomainError, Runtime } from '@crove/kernel-runtime';
import { createLogProvider, type MailProvider, type OutboundMail } from '@crove/mail';
import { socialCommands, socialQueries, sweepReportSchedules, type ReportLinkView, type ReportScheduleView } from '@crove/mod-social';
import { MAIL_TEMPLATES } from '../src/mail-templates.ts';
import { runMailJob, sweepMail, type MailJob } from '../src/mail-queue.ts';
import { reportView, type ReportPage } from '../src/report-link.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

function capturing(): { mailer: MailProvider; sent: OutboundMail[] } {
  const sent: OutboundMail[] = [];
  return { sent, mailer: { name: 'resend', enabled: true, sendRetrySafety: 'idempotent', send: async (mail) => (sent.push(mail), { status: 'accepted', providerMessageId: `em_${randomUUID()}` }) } };
}

suite('scheduled client report mail on PostgreSQL (#704)', () => {
  const dbName = `crove_test_report_schedule_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let db: Db;
  let workerDb: Db;
  let rt: Runtime;
  let worker: Runtime;
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  async function org() {
    const person = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@schedule.test`, name: null });
    const owner = await person('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Agency ${randomUUID().slice(0, 6)}`);
    const member = await person('member');
    await admin((c) => c.query('INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, $3)', [orgId, member, 'member']));
    return { orgId, owner, member };
  }
  const exec = <O>(o: { orgId: string }, user: string, name: string, input: unknown) => rt.execute<O>(name, input, { actor: asUser(user), orgId: o.orgId });
  const list = (o: { orgId: string; owner: string }) => rt.query<ReportScheduleView[]>('social.report_schedule.list', {}, { actor: asUser(o.owner), orgId: o.orgId });

  async function connection(orgId: string, owner: string) {
    const id = randomUUID();
    await admin((c) => c.query('INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, $3, $4, $5, $6)', [orgId, id, 'sandbox', `acct-${id.slice(0, 8)}`, 'Trang', owner]));
    return id;
  }
  async function published(o: { orgId: string; owner: string }, conn: string, at: string, metrics: Record<string, number>) {
    const { postId } = await exec<{ postId: string }>(o, o.owner, 'social.post.create', { body: 'Bài', channels: [{ connectionId: conn }] });
    await admin(async (c) => {
      const { rows } = await c.query<{ id: string }>("UPDATE crove_social.post_variant SET status = 'published', published_at = $2 WHERE post_id = $1 RETURNING id", [postId, at]);
      await c.query("INSERT INTO crove_social.metric_snapshot (org_id, variant_id, capture_key, metrics) VALUES ($1, $2, 'k', $3)", [o.orgId, rows[0]?.id, JSON.stringify(metrics)]);
    });
    return postId;
  }
  const weekly = { name: 'Báo cáo tuần', cadence: 'weekly', weekday: 1, sendHour: 8, timeZone: 'Asia/Ho_Chi_Minh', period: 'previous_week', connectionIds: [] as string[] };
  // What the worker does: the queue's sweep and each job, with the deployment's templates.
  async function deliver(mailer: MailProvider) {
    const jobs: MailJob[] = [];
    await sweepMail({ send: async (_q, data) => jobs.push(data) }, workerDb, worker, mailer);
    for (const job of jobs) await runMailJob({ runtime: worker, mailer, templates: MAIL_TEMPLATES, publicUrl: 'https://crove.example', bounceDomain: null }, job);
    return jobs.length;
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
    const login = (user: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = user;
      url.password = password;
      return url.toString();
    };
    pool = createPool({ connectionString: login('crove_app', 'test-app-pw'), max: 4 });
    workerPool = createPool({ connectionString: login('crove_worker', 'test-worker-pw'), max: 2 });
    db = createDb(pool);
    workerDb = createDb(workerPool);
    const registry = { commands: [...kernelCommands, ...socialCommands], queries: [...kernelQueries({ inboundDomain: null }), ...socialQueries] };
    rt = new Runtime(db).register(registry);
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

  it('lets owners and admins set schedules within the limits, and nobody else see them', async () => {
    const o = await org();
    const other = await org();
    const recipients = ['khach@example.vn'];
    await expect(exec(o, o.member, 'social.report_schedule.save', { ...weekly, recipients })).rejects.toMatchObject({ status: 403 });
    await expect(exec(o, o.owner, 'social.report_schedule.save', { ...weekly, weekday: null, recipients })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(exec(o, o.owner, 'social.report_schedule.save', { ...weekly, timeZone: 'Mars/Base', recipients })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(exec(o, o.owner, 'social.report_schedule.save', { ...weekly, recipients: Array.from({ length: 11 }, (_, i) => `k${i}@example.vn`) })).rejects.toMatchObject({ status: 422 });
    const theirs = await connection(other.orgId, other.owner);
    await expect(exec(o, o.owner, 'social.report_schedule.save', { ...weekly, connectionIds: [theirs], recipients })).rejects.toMatchObject({ code: 'CHANNEL_NOT_FOUND' });
    for (let i = 0; i < 5; i++) await exec(o, o.owner, 'social.report_schedule.save', { ...weekly, name: `Lịch ${i}`, recipients: ['Khach@Example.vn', 'khach@example.vn'] });
    await expect(exec(o, o.owner, 'social.report_schedule.save', { ...weekly, recipients })).rejects.toMatchObject({ code: 'REPORT_SCHEDULE_LIMIT' });
    const mine = await list(o);
    expect(mine).toHaveLength(5);
    expect(mine[0]).toMatchObject({ recipients: ['khach@example.vn'], paused: false, runs: [] });
    // Next Monday 08:00 in Vietnam.
    expect(new Date(mine[0]?.nextRunAt as string).getUTCHours()).toBe(1);
    await expect(rt.query('social.report_schedule.list', {}, { actor: asUser(o.member), orgId: o.orgId })).rejects.toMatchObject({ status: 403 });
    expect(await list(other)).toEqual([]);
    await expect(exec(other, other.owner, 'social.report_schedule.remove', { scheduleId: mine[0]?.id })).rejects.toMatchObject({ code: 'REPORT_SCHEDULE_NOT_FOUND' });
    // The worker-only commands refuse people.
    for (const name of ['social.report_schedule.run', 'social.report_schedule.mint_link']) {
      const input = name.endsWith('run') ? { scheduleId: mine[0]?.id } : { messageId: randomUUID() };
      const refused = await exec(o, o.owner, name, input).then(
        () => 'resolved',
        (e: unknown) => (e instanceof DomainError ? e.status : String(e)),
      );
      expect(refused).toBe(403);
    }
  });

  it('moves a schedule whose run fails down the due scan, so it never starves the others (#736)', async () => {
    const o = await org();
    const { scheduleId } = await exec<{ scheduleId: string }>(o, o.owner, 'social.report_schedule.save', { ...weekly, recipients: ['a@example.vn'] });
    await admin((c) => c.query("UPDATE crove_social.report_schedule SET next_run_at = now() - interval '1 hour' WHERE id = $1", [scheduleId]));
    const due = () => admin(async (c) => (await c.query<{ schedule_id: string }>('SELECT schedule_id FROM crove_social.report_schedules_due(1000)')).rows.map((r) => r.schedule_id));
    expect(await due()).toContain(scheduleId);
    // Every run of this schedule fails; the sweep records nothing and defers it.
    const failing = {
      execute: (name: string, input: unknown, options: Parameters<typeof worker.execute>[2]) => (name === 'social.report_schedule.run' ? Promise.reject(new Error('boom')) : worker.execute(name, input, options)),
    } as unknown as typeof worker;
    expect(await sweepReportSchedules({ runtime: failing, workerDb })).toBe(0);
    expect(await due()).not.toContain(scheduleId);
    const next = await admin(async (c) => (await c.query<{ at: Date }>('SELECT next_run_at AS at FROM crove_social.report_schedule WHERE id = $1', [scheduleId])).rows[0]?.at);
    expect((next?.getTime() ?? 0) - Date.now()).toBeGreaterThan(25 * 60_000);
    // A schedule not due is left alone.
    expect(await worker.execute('social.report_schedule.defer', { scheduleId }, { actor: { type: 'system', component: 'test' }, orgId: o.orgId })).toEqual({ deferred: false });
  });

  it('caps scheduled report mail to one inbox across orgs, and names the sending org (#735)', async () => {
    const o = await org();
    const other = await org();
    // Five report mails to the same Gmail inbox from another org in the last day (dots and a +tag fold together).
    for (let i = 0; i < 5; i++) {
      await admin((c) =>
        c.query(
          `INSERT INTO crove_kernel.mail_message (org_id, stream, source, template_key, to_address, to_hash, message_id_header, status)
           VALUES ($1, 'transactional', 'social.report_schedule.run', 'social.report', $2, $3, $4, 'queued')`,
          [other.orgId, i % 2 ? 're.port_user+bao.cao@gmail.com' : 'report_user@gmail.com', 'a'.repeat(63) + String(i), `<cap-${i}-${randomUUID()}@test>`],
        ),
      );
    }
    const { scheduleId } = await exec<{ scheduleId: string }>(o, o.owner, 'social.report_schedule.save', { ...weekly, recipients: ['re.port_user@gmail.com', 'cap-other@example.vn'] });
    await admin((c) => c.query("UPDATE crove_social.report_schedule SET next_run_at = now() - interval '1 hour' WHERE id = $1", [scheduleId]));
    expect(await sweepReportSchedules({ runtime: worker, workerDb })).toBe(1);
    const mails = await admin(async (c) => (await c.query<{ to_address: string; status: string; error_code: string | null; payload: { orgName?: string } }>("SELECT to_address, status, error_code, payload FROM crove_kernel.mail_message WHERE org_id = $1 AND source = 'social.report_schedule.run' ORDER BY to_address", [o.orgId])).rows);
    expect(mails.map((m) => [m.to_address, m.status, m.error_code])).toEqual([
      ['cap-other@example.vn', 'queued', null],
      ['re.port_user@gmail.com', 'suppressed', 'recipient_daily_cap'],
    ]);
    expect(mails[0]?.payload.orgName).toBeTruthy();

    // The boundary: four report mails in the last day (plus a suppressed one and one older than a day) leave room for a fifth.
    const third = await org();
    const send = (address: string, status: string, age: string) =>
      admin((c) =>
        c.query(
          `INSERT INTO crove_kernel.mail_message (org_id, stream, source, template_key, to_address, to_hash, message_id_header, status, created_at)
           VALUES ($1, 'transactional', 'social.report_schedule.run', 'social.report', $2, $3, $4, $5, now() - $6::interval)`,
          [other.orgId, address, 'b'.repeat(63) + String(Math.floor(Math.random() * 10)), `<edge-${randomUUID()}@test>`, status, age],
        ),
      );
    for (let i = 0; i < 4; i++) await send('edge@example.vn', 'queued', '1 hour');
    await send('edge@example.vn', 'suppressed', '1 hour');
    await send('edge@example.vn', 'queued', '25 hours');
    const edge = await exec<{ scheduleId: string }>(third, third.owner, 'social.report_schedule.save', { ...weekly, recipients: ['edge@example.vn'] });
    await admin((c) => c.query("UPDATE crove_social.report_schedule SET next_run_at = now() - interval '1 hour' WHERE id = $1", [edge.scheduleId]));
    expect(await sweepReportSchedules({ runtime: worker, workerDb })).toBe(1);
    const fifth = await admin(async (c) => (await c.query<{ status: string }>("SELECT status FROM crove_kernel.mail_message WHERE org_id = $1 AND source = 'social.report_schedule.run'", [third.orgId])).rows);
    expect(fifth.map((m) => m.status)).toEqual(['queued']);
    // Only the worker's system context may ask the gate.
    const app = new URL(adminUrl);
    app.username = 'crove_app';
    app.password = 'test-app-pw';
    const c = new pg.Client({ connectionString: app.toString() });
    await c.connect();
    try {
      await expect(c.query("SELECT crove_social.report_mail_recipient_gate('x@example.vn', 5)")).rejects.toMatchObject({ code: '42501' });
    } finally {
      await c.end();
    }
  });

  it('runs a due schedule: one mail per recipient with the numbers and a link of its own to the report of the period', async () => {
    const o = await org();
    const conn = await connection(o.orgId, o.owner);
    // In the week before Monday 2026-10-19 (Vietnam), and one after it.
    await published(o, conn, '2026-10-13T03:00:00Z', { reach: 1200, impressions: 3000, reactions: 40, comments: 5 });
    await published(o, conn, '2026-10-19T03:00:00Z', { reach: 999 });
    await exec(o, o.owner, 'kernel.mail.suppression.add', { email: 'chan@example.vn', scope: 'all' });
    const { scheduleId } = await exec<{ scheduleId: string }>(o, o.owner, 'social.report_schedule.save', { ...weekly, recipients: ['a@example.vn', 'b@example.vn', 'chan@example.vn'] });
    // Not due yet: nothing runs.
    expect(await sweepReportSchedules({ runtime: worker, workerDb })).toBe(0);
    await admin((c) => c.query("UPDATE crove_social.report_schedule SET next_run_at = '2026-10-19T01:00:00Z' WHERE id = $1", [scheduleId]));
    expect(await sweepReportSchedules({ runtime: worker, workerDb })).toBe(1);
    // Run once: a second pass finds it not due.
    expect(await sweepReportSchedules({ runtime: worker, workerDb })).toBe(0);
    const [s] = await list(o);
    expect(new Date(s?.nextRunAt as string).getTime()).toBeGreaterThan(Date.now());
    expect(s?.runs).toHaveLength(1);
    expect(s?.runs[0]).toMatchObject({ kind: 'scheduled', periodStart: '2026-10-11T17:00:00.000Z', periodEnd: '2026-10-18T17:00:00.000Z' });
    expect(s?.runs[0]?.mails.map((m) => [m.to, m.status])).toEqual([
      ['a@example.vn', 'queued'],
      ['b@example.vn', 'queued'],
      ['chan@example.vn', 'suppressed'],
    ]);

    const { mailer, sent } = capturing();
    expect(await deliver(mailer)).toBeGreaterThanOrEqual(2);
    const ours = sent.filter((m) => m.to === 'a@example.vn' || m.to === 'b@example.vn');
    expect(ours).toHaveLength(2);
    const mail = ours[0] as OutboundMail;
    expect(mail.subject).toBe('Báo cáo mạng xã hội: Báo cáo tuần');
    expect(mail.text).toContain('Kỳ báo cáo: 12/10/2026 - 18/10/2026');
    expect(mail.text).toContain('Bài đã đăng: 1');
    expect(mail.text).toContain('Lượt tiếp cận: 1.200');
    expect(mail.text).toContain('Lượt tương tác: 45');
    // The sending org is named (#735).
    expect(mail.text).toMatch(/Thư này được .+ gửi tự động qua Ludy/);
    // Each recipient's own link opens the report of the period.
    const tokens = ours.map((m) => /\/-\/report#([A-Za-z0-9_-]{43})/.exec(m.text)?.[1]);
    expect(new Set(tokens).size).toBe(2);
    const page = (await reportView(rt, { token: tokens[0] })) as ReportPage;
    expect(page).toMatchObject({ title: 'Báo cáo tuần', posts: 1, totals: { reach: 1200 } });
    // The token is in the mail only: nowhere in the queue's rows.
    const stored = await admin(async (c) => (await c.query<{ row: string }>("SELECT row_to_json(m)::text AS row FROM crove_kernel.mail_message m WHERE source = 'social.report_schedule.run'")).rows.map((r) => r.row).join(' '));
    expect(stored).not.toContain(tokens[0]);
    // The links a schedule makes are not the org's manual links.
    const linkOf = (token: string | undefined) => admin(async (c) => (await c.query<{ revoked_at: Date | null }>('SELECT revoked_at FROM crove_social.report_link WHERE token_sha256 = encode(sha256(convert_to($1, \'UTF8\')), \'hex\')', [token])).rows[0]);
    expect(await linkOf(tokens[0])).toMatchObject({ revoked_at: null });
    expect(await rt.query<ReportLinkView[]>('social.report_link.list', {}, { actor: asUser(o.owner), orgId: o.orgId })).toEqual([]);
    const after = await list(o);
    expect(after[0]?.runs[0]?.mails.map((m) => m.status)).toEqual(['sent', 'sent', 'suppressed']);
    // A paused schedule does not run.
    await exec(o, o.owner, 'social.report_schedule.save', { ...weekly, scheduleId, recipients: ['a@example.vn'], paused: true });
    await admin((c) => c.query("UPDATE crove_social.report_schedule SET next_run_at = now() - interval '1 hour' WHERE id = $1", [scheduleId]));
    expect(await sweepReportSchedules({ runtime: worker, workerDb })).toBe(0);
    // Removing the schedule revokes the links it mailed: the report no longer opens.
    await exec(o, o.owner, 'social.report_schedule.remove', { scheduleId });
    expect(await linkOf(tokens[0])).toMatchObject({ revoked_at: expect.any(Date) });
    expect(await reportView(rt, { token: tokens[0] })).toBeNull();
  });

  // #1259: a schedule has a link's options; its mail and each mail's link follow them.
  it("runs a campaign schedule: only the label's posts, the note, the chosen sections in the mail and on its link (#1259)", async () => {
    const o = await org();
    const stranger = await org();
    const conn = await connection(o.orgId, o.owner);
    const sale = (await exec<{ labelId: string }>(o, o.owner, 'social.label.create', { name: 'Khuyến mãi' })).labelId;
    const tagged = await published(o, conn, '2026-10-13T03:00:00Z', { reach: 1200, reactions: 40, replies: 4 });
    await published(o, conn, '2026-10-14T03:00:00Z', { reach: 7777, reactions: 900 });
    await exec(o, o.owner, 'social.post.set_labels', { postId: tagged, labelIds: [sale] });
    const theirs = (await exec<{ labelId: string }>(stranger, stranger.owner, 'social.label.create', { name: 'Của họ' })).labelId;
    const recipients = ['camp@example.vn'];
    await expect(exec(o, o.owner, 'social.report_schedule.save', { ...weekly, recipients, labelId: theirs })).rejects.toMatchObject({ code: 'LABEL_NOT_FOUND' });
    await expect(exec(o, o.owner, 'social.report_schedule.save', { ...weekly, recipients, sections: ['top'], includeAudience: true })).rejects.toMatchObject({ code: 'VALIDATION' });
    const { scheduleId } = await exec<{ scheduleId: string }>(o, o.owner, 'social.report_schedule.save', {
      ...weekly,
      recipients,
      note: 'Chào anh chị <b>',
      labelId: sale,
      sections: ['note', 'top', 'channels'],
      topCount: 3,
    });
    expect((await list(o))[0]).toMatchObject({ note: 'Chào anh chị <b>', labelId: sale, includeAudience: false, sections: ['note', 'top', 'channels'], topCount: 3 });
    // Pausing through a save without the options keeps them.
    await exec(o, o.owner, 'social.report_schedule.save', { ...weekly, scheduleId, recipients, paused: true });
    expect((await list(o))[0]).toMatchObject({ paused: true, note: 'Chào anh chị <b>', labelId: sale, sections: ['note', 'top', 'channels'], topCount: 3 });
    await exec(o, o.owner, 'social.report_schedule.save', { ...weekly, scheduleId, recipients, paused: false });
    await admin((c) => c.query("UPDATE crove_social.report_schedule SET next_run_at = '2026-10-19T01:00:00Z' WHERE id = $1", [scheduleId]));
    expect(await sweepReportSchedules({ runtime: worker, workerDb })).toBe(1);
    // The mail's data: the label's post alone, no totals (not chosen), the note; no goals under a label.
    const payload = await admin(async (c) => (await c.query<{ payload: Record<string, unknown> }>("SELECT payload FROM crove_kernel.mail_message WHERE org_id = $1 AND source = 'social.report_schedule.run'", [o.orgId])).rows[0]?.payload);
    expect(payload).toMatchObject({ posts: 1, note: 'Chào anh chị <b>' });
    for (const key of ['reach', 'impressions', 'engagement', 'goals']) expect(payload).not.toHaveProperty(key);

    const { mailer, sent } = capturing();
    await deliver(mailer);
    const mail = sent.find((m) => m.to === 'camp@example.vn') as OutboundMail;
    expect(mail.text).toContain('Bài đã đăng: 1');
    expect(mail.text).not.toContain('Lượt tiếp cận');
    expect(mail.text).toContain('Chào anh chị <b>');
    expect(mail.html).toContain('Chào anh chị &lt;b&gt;');
    // Its link reports on the label's posts only, with the schedule's sections.
    const token = /\/-\/report#([A-Za-z0-9_-]{43})/.exec(mail.text)?.[1];
    const page = (await reportView(rt, { token })) as unknown as Record<string, unknown> & { top: unknown[]; channels: { totals: Record<string, number> }[] };
    expect(page).toMatchObject({ posts: 1, note: 'Chào anh chị <b>', sections: ['note', 'top', 'channels'], totals: null, audience: null, previous: null, goals: null });
    expect(page.top).toHaveLength(1);
    expect(page.channels[0]?.totals).toEqual({ reach: 1200, reactions: 40 });
    expect(JSON.stringify(page)).not.toContain('7777');
    // Deleting the label deletes the schedule (and its links with the label), never widening it to every post.
    await exec(o, o.owner, 'social.label.delete', { labelId: sale });
    expect(await list(o)).toEqual([]);
    expect(await reportView(rt, { token })).toBeNull();
  });

  it('keeps a schedule to the allowed sections and best posts, and lets the tenant role write its new columns (#1259)', async () => {
    const o = await org();
    const recipients = ['k@example.vn'];
    for (const bad of [{ sections: [] }, { sections: ['note', 'note'] }, { sections: ['comparison'] }, { topCount: 21 }, { note: 'x'.repeat(2001) }]) {
      await expect(exec(o, o.owner, 'social.report_schedule.save', { ...weekly, recipients, ...bad })).rejects.toMatchObject({ status: 422 });
    }
    const { scheduleId } = await exec<{ scheduleId: string }>(o, o.owner, 'social.report_schedule.save', { ...weekly, recipients });
    // A schedule without the options is as before: every section, every post, the audience.
    expect((await list(o))[0]).toMatchObject({ note: null, labelId: null, includeAudience: true, sections: null, topCount: null });
    const update = (set: string, value: unknown) => admin((c) => c.query(`UPDATE crove_social.report_schedule SET ${set} = $2 WHERE id = $1`, [scheduleId, value]));
    for (const [set, value] of [
      ['sections', ['top', 'top']],
      ['sections', ['secret']],
      ['sections', []],
      ['top_count', 2],
      ['note', ''],
    ] as const) {
      await expect(update(set, value)).rejects.toMatchObject({ code: '23514' });
    }
    // Another org's label: the composite FK refuses it.
    const other = await org();
    const theirs = (await exec<{ labelId: string }>(other, other.owner, 'social.label.create', { name: 'Của họ' })).labelId;
    await expect(update('label_id', theirs)).rejects.toMatchObject({ code: '23503' });
    const privileges = await admin(async (c) =>
      (
        await c.query<{ col: string; ok: boolean }>(
          `SELECT col, pg_catalog.has_column_privilege('crove_tenant', 'crove_social.report_schedule', col, 'UPDATE') AND pg_catalog.has_column_privilege('crove_tenant', 'crove_social.report_schedule', col, 'INSERT') AS ok
             FROM unnest(ARRAY['sections', 'top_count', 'note', 'label_id', 'include_audience']) col ORDER BY 1`,
        )
      ).rows,
    );
    expect(privileges.every((p) => p.ok)).toBe(true);
  });

  it('sends a test to the person who asks, records mail off, and limits tests', async () => {
    const o = await org();
    const { scheduleId } = await exec<{ scheduleId: string }>(o, o.owner, 'social.report_schedule.save', { ...weekly, cadence: 'monthly', weekday: null, monthDay: 1, period: 'previous_month', recipients: ['khach@example.vn'] });
    const test = await exec<{ runId: string; mails: number }>(o, o.owner, 'social.report_schedule.test', { scheduleId });
    expect(test.mails).toBe(1);
    const [s] = await list(o);
    expect(s?.runs[0]).toMatchObject({ kind: 'test' });
    expect(s?.runs[0]?.mails[0]?.to).toMatch(/^owner-.*@schedule\.test$/);
    // With mail off (the log provider) the mail is recorded as not sent.
    await deliver(createLogProvider(() => {}));
    expect((await list(o))[0]?.runs[0]?.mails[0]).toMatchObject({ status: 'failed', errorCode: 'MAIL_OFF' });
    for (let i = 0; i < 4; i++) await exec(o, o.owner, 'social.report_schedule.test', { scheduleId });
    await expect(exec(o, o.owner, 'social.report_schedule.test', { scheduleId })).rejects.toMatchObject({ code: 'REPORT_TEST_LIMIT' });
    await exec(o, o.owner, 'social.report_schedule.remove', { scheduleId });
    expect(await list(o)).toEqual([]);
  });

  it('keeps the due scan to the worker', async () => {
    const grants = await admin(
      async (c) =>
        (await c.query<{ grantee: string }>("SELECT grantee FROM information_schema.role_routine_grants WHERE routine_schema = 'crove_social' AND routine_name = 'report_schedules_due' AND grantee <> 'postgres' ORDER BY 1")).rows.map(
          (r) => r.grantee,
        ),
    );
    expect(grants).toEqual(['crove_worker']);
  });
});
