// Queued mail, Email E1b (#548), on a real PostgreSQL 17: the worker's sweep finds what is due and puts it on the right
// queue; one send per attempt through external_call; the suppression list read again before a send; an unknown outcome
// left ambiguous, sent again only by a mailer that dedupes and never for marketing; a send lost with its worker
// recorded as ambiguous; mail off, a missing template and a refused recipient recorded as failures; the retention
// purge of addresses, subjects and merge data; and the commands and definers kept to the worker. Set
// CROVE_TEST_ADMIN_URL to a superuser URL; each run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createMailMessage, createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { DomainError, Runtime, defineCommand, type UserActor } from '@crove/kernel-runtime';
import { createLogProvider, type MailProvider, type OutboundMail, type SendResult } from '@crove/mail';
import { MAIL_BULK_QUEUE, MAIL_SEND_QUEUE, purgeMail, runMailJob, sweepMail, type MailJob, type MailTemplates } from '../src/mail-queue.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

// A command that queues a mail the way a module does: the row 'queued', with its merge data.
const queueTest = defineCommand({
  name: 'kernel.mail_test.queue',
  input: z.object({ to: z.string(), stream: z.enum(['system', 'transactional', 'marketing']), template: z.string().optional() }),
  risk: 'R1',
  access: ['owner', 'admin', 'member', 'viewer'],
  handler: async (ctx, input) =>
    createMailMessage(ctx, {
      stream: input.stream,
      source: 'kernel.mail_test.queue',
      templateKey: input.template ?? 'kernel.mail_test',
      to: input.to,
      subject: 'Báo cáo tuần',
      payload: { reach: 1200 },
      status: 'queued',
    }),
});

const TEMPLATES: MailTemplates = {
  'kernel.mail_test': {
    render: ({ subject, payload, publicUrl }) =>
      typeof payload.reach === 'number' ? { subject: subject ?? 'Báo cáo', text: `Tiếp cận ${payload.reach}\n${publicUrl}`, html: `<p>Tiếp cận ${payload.reach}</p>` } : null,
  },
};

// A mailer that answers from a script and keeps what it was given.
function scripted(answers: SendResult[], safety: MailProvider['sendRetrySafety'] = 'never') {
  const sent: OutboundMail[] = [];
  const mailer: MailProvider = {
    name: 'resend',
    enabled: true,
    sendRetrySafety: safety,
    send: async (mail) => {
      sent.push(mail);
      return answers.shift() ?? { status: 'accepted', providerMessageId: `em_${randomUUID()}` };
    },
  };
  return { mailer, sent };
}

suite('queued mail (#548)', () => {
  const dbName = `crove_test_mail_queue_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let db: Db;
  let workerDb: Db;
  let runtime: Runtime;
  let workerRuntime: Runtime;
  let orgId = '';
  let otherOrgId = '';
  let owner: UserActor;

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }
  // Moves a row's clock back past the guards (they keep created_at and started_at fixed).
  const backdate = (statement: string, params: unknown[]) =>
    admin(async (c) => {
      await c.query('SET session_replication_role = replica');
      await c.query(statement, params);
    });
  const actor = (userId: string): UserActor => ({ type: 'user', userId, aal: 'aal1', sessionId: randomUUID(), mfaAt: null });
  const queue = async (to: string, stream: 'system' | 'transactional' | 'marketing' = 'transactional', template?: string, org = orgId) =>
    String((await runtime.execute<{ id: string }>('kernel.mail_test.queue', { to, stream, ...(template ? { template } : {}) }, { actor: owner, orgId: org })).id);
  const deps = (mailer: MailProvider) => ({ runtime: workerRuntime, mailer, templates: TEMPLATES, publicUrl: 'https://crove.example', bounceDomain: 'in.crove.example', sleep: async () => {} });
  const row = (id: string) =>
    admin(
      async (c) =>
        (
          await c.query<{ status: string; attempts: number; provider_message_id: string | null; error_code: string | null; to_address: string | null; subject: string | null; payload: unknown; to_hash: string }>(
            'SELECT status, attempts, provider_message_id, error_code, to_address, subject, payload, to_hash FROM crove_kernel.mail_message WHERE id = $1',
            [id],
          )
        ).rows[0],
    );
  const calls = (id: string) =>
    admin(async (c) => (await c.query<{ key: string; state: string; error_kind: string | null }>('SELECT key, state, error_kind FROM crove_kernel.external_call WHERE key LIKE $1 ORDER BY key', [`mail:${id}:%`])).rows);
  // The sweep with a stand-in for pg-boss.
  async function sweep(mailer: MailProvider) {
    const jobs: { queue: string; data: MailJob }[] = [];
    await sweepMail({ send: async (q, data) => jobs.push({ queue: q, data }) }, workerDb, workerRuntime, mailer);
    return jobs;
  }

  beforeAll(async () => {
    const base = new URL(ADMIN as string);
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
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
    const registry = { commands: [...kernelCommands, queueTest], queries: kernelQueries({ inboundDomain: null }) };
    runtime = new Runtime(db).register(registry);
    workerRuntime = new Runtime(workerDb).register(registry);
    owner = actor(await upsertIdentity(db, { issuer: 'mail-queue', subject: `owner-${randomUUID()}`, email: `owner-${dbName}@mail.test`, name: null }));
    orgId = (await createOrg(runtime, owner, 'Công ty Hàng đợi')).orgId;
    otherOrgId = (await createOrg(runtime, owner, 'Công ty Khác')).orgId;
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

  it('queues due mail by stream and sends each once, rendered, through one external call', async () => {
    const invoice = await queue('Khach@Example.vn ', 'transactional');
    const campaign = await queue('ban@example.vn', 'marketing');
    const { mailer, sent } = scripted([{ status: 'accepted', providerMessageId: 'em_1' }]);
    const jobs = await sweep(mailer);
    expect(jobs.filter((j) => [invoice, campaign].includes(j.data.messageId))).toEqual([
      { queue: MAIL_SEND_QUEUE, data: { orgId, messageId: invoice } },
      { queue: MAIL_BULK_QUEUE, data: { orgId, messageId: campaign } },
    ]);

    expect(await runMailJob(deps(mailer), { orgId, messageId: invoice })).toEqual({ action: 'recorded', outcome: 'sent', code: null });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: 'khach@example.vn', subject: 'Báo cáo tuần', text: 'Tiếp cận 1200\nhttps://crove.example' });
    expect(sent[0]?.messageId).toMatch(/^<[0-9a-f-]{36}@crove\.invalid>$/);
    expect(sent[0]?.returnPath).toMatch(/^bounce\+[^@]+@in\.crove\.example$/);
    expect(await row(invoice)).toMatchObject({ status: 'sent', attempts: 1, provider_message_id: 'em_1', error_code: null });
    expect(await calls(invoice)).toEqual([{ key: `mail:${invoice}:1`, state: 'succeeded', error_kind: null }]);
    // A second job for the same mail (a retried job, a duplicate) sends nothing, and the sweep no longer finds it.
    expect(await runMailJob(deps(mailer), { orgId, messageId: invoice })).toEqual({ action: 'none', reason: 'SENT' });
    expect(sent).toHaveLength(1);
    expect((await sweep(mailer)).map((j) => j.data.messageId)).not.toContain(invoice);
    // A job naming another org finds nothing there.
    expect(await runMailJob(deps(mailer), { orgId: otherOrgId, messageId: campaign })).toEqual({ action: 'none', reason: 'NOT_FOUND' });
  });

  it('puts a campaign behind every other mail in a pass, and takes an unsendable mail out of the queue', async () => {
    const campaign = [await queue('a@example.vn', 'marketing'), await queue('b@example.vn', 'marketing'), await queue('c@example.vn', 'marketing')];
    const invoice = await queue('hoa-don@example.vn', 'transactional');
    const { rows } = await workerPool.query<{ message_id: string }>('SELECT message_id FROM crove_kernel.mail_queued_due(2, 600, false)');
    const due = rows.map((r) => r.message_id);
    expect(due).toContain(invoice);
    expect(due.filter((id) => campaign.includes(id)).length).toBeLessThan(2);

    // A queued mail that lost its address (an erasure) fails once instead of coming back every pass.
    await backdate('UPDATE crove_kernel.mail_message SET to_address = NULL WHERE id = $1', [invoice]);
    const { mailer, sent } = scripted([]);
    expect(await runMailJob(deps(mailer), { orgId, messageId: invoice })).toEqual({ action: 'none', reason: 'NO_ADDRESS' });
    expect(sent).toHaveLength(0);
    expect(await row(invoice)).toMatchObject({ status: 'failed', error_code: 'NO_ADDRESS' });
    for (const id of campaign) await runMailJob(deps(mailer), { orgId, messageId: id });
  });

  it('reads the suppression list again before a send', async () => {
    const id = await queue('da-chan@example.vn');
    await runtime.execute('kernel.mail.suppression.add', { email: 'da-chan@example.vn', scope: 'all' }, { actor: owner, orgId });
    const { mailer, sent } = scripted([]);
    expect(await runMailJob(deps(mailer), { orgId, messageId: id })).toEqual({ action: 'suppressed' });
    expect(sent).toHaveLength(0);
    expect(await row(id)).toMatchObject({ status: 'suppressed', attempts: 0 });
    expect(await calls(id)).toEqual([]);
  });

  it('leaves an unknown outcome ambiguous, sends it again only through a mailer that dedupes, and never for marketing', async () => {
    const id = await queue('mo-ho@example.vn');
    const news = await queue('tin@example.vn', 'marketing');
    const unknown = scripted([{ status: 'unknown', code: 'http_502' }, { status: 'unknown', code: 'http_502' }]);
    expect(await runMailJob(deps(unknown.mailer), { orgId, messageId: id })).toEqual({ action: 'recorded', outcome: 'ambiguous', code: 'HTTP_502' });
    expect(await runMailJob(deps(unknown.mailer), { orgId, messageId: news })).toMatchObject({ outcome: 'ambiguous' });
    expect(await calls(id)).toEqual([{ key: `mail:${id}:1`, state: 'ambiguous', error_kind: 'unknown' }]);
    await backdate("UPDATE crove_kernel.mail_message SET updated_at = now() - interval '10 minutes' WHERE id = ANY ($1)", [[id, news]]);

    // SMTP cannot dedupe: nothing is sent again, and a job that runs anyway is refused.
    const smtp = scripted([], 'never');
    expect((await sweep(smtp.mailer)).map((j) => j.data.messageId)).not.toContain(id);
    expect(await runMailJob(deps(smtp.mailer), { orgId, messageId: id })).toEqual({ action: 'none', reason: 'NOT_REPEATABLE' });

    // A mailer that dedupes on the Message-ID sends the transactional mail again, as attempt 2; marketing stays.
    const resend = scripted([{ status: 'accepted', providerMessageId: 'em_2' }], 'idempotent');
    const again = (await sweep(resend.mailer)).map((j) => j.data.messageId);
    expect(again).toContain(id);
    expect(again).not.toContain(news);
    expect(await runMailJob(deps(resend.mailer), { orgId, messageId: id })).toMatchObject({ outcome: 'sent' });
    expect(resend.sent[0]?.messageId).toBe(unknown.sent[0]?.messageId);
    expect(await row(id)).toMatchObject({ status: 'sent', attempts: 2, provider_message_id: 'em_2' });
    expect(await runMailJob(deps(resend.mailer), { orgId, messageId: news })).toEqual({ action: 'none', reason: 'MARKETING_NOT_REPEATED' });
  });

  it('records a send lost with its worker as ambiguous', async () => {
    const id = await queue('mat@example.vn');
    const begun = await workerRuntime.execute<{ action: string; attempt: number }>('kernel.mail.queue.begin', { messageId: id, provider: 'resend', safety: 'never' }, { actor: { type: 'system', component: 'kernel.mail' }, orgId });
    expect(begun).toMatchObject({ action: 'send', attempt: 1 });
    const { mailer } = scripted([]);
    // Not stale yet: left alone.
    await sweep(mailer);
    expect(await row(id)).toMatchObject({ status: 'sending' });
    await backdate("UPDATE crove_kernel.external_call SET started_at = now() - interval '20 minutes' WHERE key = $1", [`mail:${id}:1`]);
    await sweep(mailer);
    expect(await row(id)).toMatchObject({ status: 'ambiguous', error_code: 'WORKER_LOST' });
    expect(await calls(id)).toEqual([{ key: `mail:${id}:1`, state: 'ambiguous', error_kind: 'unknown' }]);
  });

  it('records mail off, a missing template, bad merge data and a refused recipient as failures', async () => {
    const off = await queue('tat@example.vn');
    expect(await runMailJob(deps(createLogProvider(() => {})), { orgId, messageId: off })).toEqual({ action: 'recorded', outcome: 'failed', code: 'MAIL_OFF' });
    const unknownTemplate = await queue('mau@example.vn', 'transactional', 'kernel.mail_missing');
    const { mailer } = scripted([
      { status: 'rejected', error: 'transient', code: 'smtp_421' },
      { status: 'rejected', error: 'invalid_recipient', code: 'smtp_550' },
    ]);
    expect(await runMailJob(deps(mailer), { orgId, messageId: unknownTemplate })).toMatchObject({ outcome: 'failed', code: 'TEMPLATE_UNKNOWN' });
    // A busy server is asked again; a recipient it refuses stops the org's mail to the address.
    const refused = await queue('khong-co@example.vn');
    expect(await runMailJob(deps(mailer), { orgId, messageId: refused })).toEqual({ action: 'recorded', outcome: 'failed', code: 'SMTP_550' });
    expect(await calls(refused)).toEqual([{ key: `mail:${refused}:1`, state: 'failed', error_kind: 'bad_request' }]);
    const stop = await admin(async (c) => (await c.query<{ scope: string; reason: string }>('SELECT scope, reason FROM crove_kernel.mail_suppression WHERE source_message_id = $1', [refused])).rows);
    expect(stop).toEqual([{ scope: 'all', reason: 'hard_bounce' }]);
    expect(await row(off)).toMatchObject({ status: 'failed', error_code: 'MAIL_OFF' });
  });

  it('drops addresses and subjects after 13 months and merge data 30 days after a final status, keeping the hash', async () => {
    const old = await queue('cu@example.vn');
    const recent = await queue('moi@example.vn');
    const { mailer } = scripted([]);
    await runMailJob(deps(mailer), { orgId, messageId: old });
    await runMailJob(deps(mailer), { orgId, messageId: recent });
    await backdate("UPDATE crove_kernel.mail_message SET created_at = now() - interval '14 months', updated_at = now() - interval '31 days' WHERE id = $1", [old]);
    const before = await row(old);
    const cleared = await purgeMail(workerDb);
    expect(cleared['kernel.mail_message.address']).toBeGreaterThanOrEqual(1);
    expect(cleared['kernel.mail_message.payload']).toBeGreaterThanOrEqual(1);
    expect(await row(old)).toMatchObject({ to_address: null, subject: null, payload: null, to_hash: before?.to_hash, status: 'sent' });
    expect(await row(recent)).toMatchObject({ to_address: 'moi@example.vn', subject: 'Báo cáo tuần', payload: { reach: 1200 } });
  });

  it('keeps the queue commands to the worker and the definers to its role', async () => {
    const id = await queue('rieng@example.vn');
    for (const name of ['kernel.mail.queue.begin', 'kernel.mail.queue.record']) {
      const input = name.endsWith('begin') ? { messageId: id, provider: 'resend', safety: 'never' } : { messageId: id, attempt: 1, outcome: 'sent' };
      const refused = await runtime.execute(name, input, { actor: owner, orgId }).then(
        () => 'resolved',
        (error: unknown) => (error instanceof DomainError ? error.status : String(error)),
      );
      expect(refused).toBe(403);
    }
    const grants = await admin(
      async (c) =>
        (
          await c.query<{ routine_name: string; grantee: string }>(
            "SELECT routine_name, grantee FROM information_schema.role_routine_grants WHERE routine_schema = 'crove_kernel' AND routine_name IN ('mail_queued_due', 'mail_retention_purge') AND grantee <> 'postgres' ORDER BY 1, 2",
          )
        ).rows,
    );
    expect(grants).toEqual([
      { routine_name: 'mail_queued_due', grantee: 'crove_worker' },
      { routine_name: 'mail_retention_purge', grantee: 'crove_worker' },
    ]);
    const app = new pg.Client({ connectionString: pool.options.connectionString });
    await app.connect();
    try {
      await expect(app.query('SELECT * FROM crove_kernel.mail_queued_due(10, 600, true)')).rejects.toMatchObject({ code: '42501' });
    } finally {
      await app.end();
    }
    expect(await row(id)).toMatchObject({ status: 'queued' });
  });
});
