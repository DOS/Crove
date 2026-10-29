// Delivery events from the mail provider, Email E2 (#539), on a real PostgreSQL 17: the signed webhook refused when
// forged, stale or malformed and then stored nowhere; a replayed event recorded once; the org found from the stored
// mail; a hard bounce suppressing all mail to the address and a complaint suppressing marketing; three soft bounces
// in 7 days pausing marketing for 30 days; and events written only in the system context. Set CROVE_TEST_ADMIN_URL to
// a superuser URL; each run creates and drops its own database.
import { createHmac, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { sql } from 'kysely';
import pg from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createMailMessage, createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { DomainError, Runtime, defineCommand, type BlobStore, type UserActor } from '@crove/kernel-runtime';
import { createResendProvider } from '@crove/mail';
import { createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { mailEventJob, processMailEvent, type MailEventJob, type MailEventRow } from '../src/mail-events.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const WEBHOOK_SECRET = `whsec_${Buffer.from('mail-events-test-signing-secret!').toString('base64')}`;
const DAY = 24 * 60 * 60 * 1000;

const suite = ADMIN ? describe : describe.skip;

// Test-only commands: one writes a mail row the way a sending command does, one tries to write an event in a member
// context.
const sendTest = defineCommand({
  sideEffect: 'none',
  name: 'kernel.mail_test.send',
  input: z.object({ to: z.string(), stream: z.enum(['system', 'transactional', 'marketing']) }),
  risk: 'R1',
  access: ['owner', 'admin', 'member', 'viewer'],
  handler: async (ctx, input) =>
    createMailMessage(ctx, { stream: input.stream, source: 'kernel.mail_test.send', templateKey: 'kernel.mail_test', to: input.to, status: 'sending' }),
});
const forgeEvent = defineCommand({
  sideEffect: 'none',
  name: 'kernel.mail_test.forge_event',
  input: z.object({ messageId: z.uuid() }),
  risk: 'R1',
  access: ['owner', 'admin', 'member', 'viewer'],
  handler: async (ctx, input) => {
    await sql`INSERT INTO crove_kernel.mail_event (org_id, message_id, provider, provider_event_id, kind, occurred_at)
      VALUES (${ctx.orgId}, ${input.messageId}, 'resend', ${`forged-${randomUUID()}`}, 'bounce_hard', now())`.execute(ctx.trx);
    return {};
  },
});

suite('mail delivery events (#539)', () => {
  const dbName = `crove_test_mail_events_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let db: Db;
  let workerDb: Db;
  let runtime: Runtime;
  let workerRuntime: Runtime;
  let app: ReturnType<typeof createHttpApp>;
  let orgId = '';
  let otherOrgId = '';
  let owner: UserActor;
  let other: UserActor;

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }
  const actor = (userId: string): UserActor => ({ type: 'user', userId, aal: 'aal1', sessionId: randomUUID(), mfaAt: null });
  const run = (name: string, input: unknown, who: UserActor, org = orgId) => runtime.execute<any>(name, input, { actor: who, orgId: org });
  const refusal = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (error) {
      return error instanceof DomainError ? error.code : String(error);
    }
    return 'resolved';
  };

  // A mail the org sent through Resend, which gave it this id.
  async function sentMail(to: string, providerMessageId = `em_${randomUUID()}`, who = owner, org = orgId) {
    const mail = await run('kernel.mail_test.send', { to, stream: 'transactional' }, who, org);
    await run('kernel.mail.record_direct', { messageId: mail.id, outcome: 'sent', provider: 'resend', providerMessageId }, who, org);
    return { id: String(mail.id), providerMessageId };
  }

  function signed(body: string, id = `msg_${randomUUID()}`, at = Date.now(), secret = WEBHOOK_SECRET) {
    const timestamp = String(Math.floor(at / 1000));
    const signature = createHmac('sha256', Buffer.from(secret.replace(/^whsec_/, ''), 'base64'))
      .update(`${id}.${timestamp}.${body}`)
      .digest('base64');
    return { 'svix-id': id, 'svix-timestamp': timestamp, 'svix-signature': `v1,${signature}`, 'content-type': 'application/json' };
  }
  const event = (type: string, emailId: string, data: Record<string, unknown> = {}) =>
    JSON.stringify({ type, created_at: new Date().toISOString(), data: { email_id: emailId, created_at: new Date().toISOString(), ...data } });
  async function post(body: string, headers: Record<string, string>, provider = 'resend') {
    const response = await app.request(`/webhooks/mail/${provider}`, { method: 'POST', headers, body });
    return { status: response.status, body: (await response.json().catch(() => null)) as Record<string, unknown> | null };
  }
  const pending = () => admin(async (c) => Number((await c.query<{ n: string }>('SELECT count(*) AS n FROM crove_kernel.mail_event_pending')).rows[0]?.n));
  // What the worker relay and job do: claim the pending events and record each in its mail's org.
  async function drain() {
    const rows = (await sql<MailEventRow>`SELECT * FROM crove_kernel.mail_event_claim(100)`.execute(workerDb)).rows;
    return Promise.all(rows.map((row) => processMailEvent({ runtime: workerRuntime, workerDb }, mailEventJob(row))));
  }
  const job = (providerMessageId: string, kind: MailEventJob['kind'], occurredAt = new Date()): MailEventJob => ({
    provider: 'resend',
    providerEventId: `msg_${randomUUID()}`,
    providerMessageId,
    kind,
    occurredAt: occurredAt.toISOString(),
    detail: {},
  });
  const mailRow = (id: string) =>
    admin(async (c) => (await c.query<{ status: string; provider: string | null }>('SELECT status, provider FROM crove_kernel.mail_message WHERE id = $1', [id])).rows[0]);
  const suppressions = (messageId: string) =>
    admin(
      async (c) =>
        (
          await c.query<{ scope: string; reason: string }>(
            'SELECT scope, reason FROM crove_kernel.mail_suppression WHERE source_message_id = $1 AND lifted_at IS NULL ORDER BY scope',
            [messageId],
          )
        ).rows,
    );

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
    const registry = { commands: [...kernelCommands, sendTest, forgeEvent], queries: kernelQueries({ inboundDomain: null }) };
    runtime = new Runtime(db, { manifests: TEST_MANIFESTS }).register(registry);
    workerRuntime = new Runtime(workerDb, { manifests: TEST_MANIFESTS }).register(registry);

    owner = actor(await upsertIdentity(db, { issuer: 'mail-events', subject: `owner-${randomUUID()}`, email: `owner-${dbName}@mail.test`, name: null }));
    other = actor(await upsertIdentity(db, { issuer: 'mail-events', subject: `other-${randomUUID()}`, email: `other-${dbName}@mail.test`, name: null }));
    orgId = (await createOrg(runtime, owner, 'Công ty Thư')).orgId;
    otherOrgId = (await createOrg(runtime, other, 'Công ty Khác')).orgId;

    const config = loadConfig({
      DATABASE_URL: login('crove_app', 'test-app-pw'),
      AUTH_JWT_SECRET: 'test-only-jwt-secret-for-mail-events-0123456789',
      AUTH_ISSUER: 'crove-auth',
      AUTH_SESSION_CHECK: 'off',
      MIGRATIONS_DIR: MIGRATIONS,
      WEB_DIST: '/nonexistent',
    });
    const mailer = createResendProvider({ apiKey: 're_test', from: 'noreply@mail.test', webhookSecret: WEBHOOK_SECRET, fetch: (() => Promise.reject(new Error('no network'))) as typeof fetch });
    app = createHttpApp({ config, runtime, store: {} as BlobStore, authenticate: createAuthenticator(config, db), pool, aiEnabled: false, mailer });
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

  it('refuses a forged, stale or malformed webhook and stores nothing', async () => {
    const mail = await sentMail('forged@mail.test');
    const body = event('email.bounced', mail.providerMessageId, { bounce: { type: 'Permanent' } });
    const otherSecret = `whsec_${Buffer.from('not-the-secret-not-the-secret-ab').toString('base64')}`;
    expect(await post(body, signed(body, undefined, Date.now(), otherSecret))).toEqual({ status: 401, body: { code: 'WEBHOOK_SIGNATURE' } });
    expect(await post(body, signed(body, undefined, Date.now() - 10 * 60_000))).toEqual({ status: 401, body: { code: 'WEBHOOK_SIGNATURE' } });
    expect(await post(body, { 'content-type': 'application/json' })).toEqual({ status: 401, body: { code: 'WEBHOOK_SIGNATURE' } });
    expect(await post('{"type":', signed('{"type":'))).toEqual({ status: 400, body: { code: 'WEBHOOK_MALFORMED' } });
    // Only the configured provider has a route.
    expect((await post(body, signed(body), 'postmark')).status).toBe(404);
    expect(await pending()).toBe(0);
    expect(await mailRow(mail.id)).toMatchObject({ status: 'sent' });
    expect(await suppressions(mail.id)).toEqual([]);
  });

  it('records a delivery once, however often the webhook is replayed', async () => {
    const mail = await sentMail('delivered@mail.test');
    const body = event('email.delivered', mail.providerMessageId);
    const headers = signed(body, 'msg_replayed');
    expect(await post(body, headers)).toEqual({ status: 202, body: { queued: 1 } });
    // Again before the worker ran: already pending.
    expect(await post(body, headers)).toEqual({ status: 202, body: { queued: 0 } });
    expect(await drain()).toEqual([{ recorded: true, status: 'delivered', suppressed: null }]);
    // Again after the worker ran: queued, and then changes nothing.
    expect(await post(body, headers)).toEqual({ status: 202, body: { queued: 1 } });
    expect(await drain()).toEqual([{ recorded: false, status: 'delivered', suppressed: null }]);
    const events = await admin(async (c) => (await c.query('SELECT org_id, kind, provider_event_id FROM crove_kernel.mail_event WHERE message_id = $1', [mail.id])).rows);
    expect(events).toEqual([{ org_id: orgId, kind: 'delivered', provider_event_id: 'msg_replayed' }]);
    // An event type Crove does not record is acknowledged and dropped.
    const opened = event('email.opened', mail.providerMessageId);
    expect(await post(opened, signed(opened))).toEqual({ status: 200, body: { queued: 0 } });
    expect(await pending()).toBe(0);
  });

  it('suppresses all mail after a hard bounce, and marketing after a complaint', async () => {
    const bounced = await sentMail('Bounced.User@Mail.Test');
    const bounce = event('email.bounced', bounced.providerMessageId, { bounce: { type: 'Permanent', subType: 'General' } });
    expect((await post(bounce, signed(bounce))).status).toBe(202);
    expect(await drain()).toEqual([{ recorded: true, status: 'bounced', suppressed: 'all' }]);
    expect(await suppressions(bounced.id)).toEqual([{ scope: 'all', reason: 'hard_bounce' }]);
    expect((await run('kernel.mail_test.send', { to: 'bounced.user@mail.test', stream: 'system' }, owner)).status).toBe('suppressed');
    // The other org's list is its own.
    expect((await run('kernel.mail_test.send', { to: 'bounced.user@mail.test', stream: 'system' }, other, otherOrgId)).status).toBe('sending');

    const complained = await sentMail('complained@mail.test');
    const complaint = event('email.complained', complained.providerMessageId);
    expect((await post(complaint, signed(complaint))).status).toBe(202);
    expect(await drain()).toEqual([{ recorded: true, status: 'complained', suppressed: 'marketing' }]);
    expect(await suppressions(complained.id)).toEqual([{ scope: 'marketing', reason: 'complaint' }]);
    expect((await run('kernel.mail_test.send', { to: 'complained@mail.test', stream: 'transactional' }, owner)).status).toBe('sending');
    expect((await run('kernel.mail_test.send', { to: 'complained@mail.test', stream: 'marketing' }, owner)).status).toBe('suppressed');
    // A bounce after the complaint is recorded; the status stays, and the hard bounce adds scope 'all'.
    expect(await processMailEvent({ runtime: workerRuntime, workerDb }, job(complained.providerMessageId, 'bounce_hard'))).toEqual({
      recorded: true,
      status: 'complained',
      suppressed: 'all',
    });
  });

  it('pauses marketing for 30 days after three soft bounces within 7 days', async () => {
    const now = Date.now();
    const bounceAt = async (to: string, ago: number) => {
      const mail = await sentMail(to);
      const result = await processMailEvent({ runtime: workerRuntime, workerDb }, job(mail.providerMessageId, 'bounce_soft', new Date(now - ago)));
      expect(result).toEqual({ recorded: true, status: 'sent', suppressed: null });
    };
    const status = async (to: string, stream: 'transactional' | 'marketing') => (await run('kernel.mail_test.send', { to, stream }, owner)).status;

    for (const ago of [3 * DAY, 2 * DAY, 1 * DAY]) await bounceAt('full@mail.test', ago);
    expect(await status('full@mail.test', 'marketing')).toBe('suppressed');
    expect(await status('full@mail.test', 'transactional')).toBe('sending');
    // Three, but not within 7 days.
    for (const ago of [20 * DAY, 10 * DAY, 1 * DAY]) await bounceAt('spread@mail.test', ago);
    expect(await status('spread@mail.test', 'marketing')).toBe('sending');
    // Three within 7 days, but the pause ended.
    for (const ago of [35 * DAY, 34 * DAY, 33 * DAY]) await bounceAt('recovered@mail.test', ago);
    expect(await status('recovered@mail.test', 'marketing')).toBe('sending');
    // Two are not enough.
    for (const ago of [2 * DAY, 1 * DAY]) await bounceAt('twice@mail.test', ago);
    expect(await status('twice@mail.test', 'marketing')).toBe('sending');
  });

  it('drops an event for a mail Crove does not know', async () => {
    expect(await processMailEvent({ runtime: workerRuntime, workerDb }, job('em_unknown', 'bounce_hard'))).toEqual({ dropped: 'UNKNOWN_MESSAGE' });
  });

  it('writes events only in the system context, and keeps a provider id to one mail', async () => {
    const mail = await sentMail('guarded@mail.test');
    // The command is the worker's; a member cannot run it, nor write an event through another command.
    const input = { messageId: mail.id, provider: 'resend', providerEventId: 'msg_member', kind: 'bounce_hard', occurredAt: new Date().toISOString(), detail: {} };
    expect(await refusal(run('kernel.mail.event.record', input, owner))).toBe('FORBIDDEN');
    expect(await refusal(run('kernel.mail_test.forge_event', { messageId: mail.id }, owner))).toBe('FORBIDDEN');
    expect(await suppressions(mail.id)).toEqual([]);

    // The provider and its id are written once.
    await expect(admin((c) => c.query(`UPDATE crove_kernel.mail_message SET provider_message_id = 'em_other' WHERE id = $1`, [mail.id]))).rejects.toThrow(
      /MAIL_MESSAGE_IMMUTABLE/,
    );
    await expect(admin((c) => c.query(`UPDATE crove_kernel.mail_message SET provider = 'smtp' WHERE id = $1`, [mail.id]))).rejects.toThrow(/MAIL_MESSAGE_IMMUTABLE/);
    // No other mail, in any org, may carry the same provider id.
    await expect(sentMail('copy@mail.test', mail.providerMessageId, other, otherOrgId)).rejects.toMatchObject({ code: 'CONFLICT' });
    // The API role cannot read or claim pending events, nor look a mail up by its provider id.
    await expect(sql`SELECT * FROM crove_kernel.mail_event_claim(1)`.execute(db)).rejects.toThrow(/permission denied/);
    await expect(sql`SELECT * FROM crove_kernel.mail_message_by_provider_id('resend', ${mail.providerMessageId})`.execute(db)).rejects.toThrow(/permission denied/);
    await expect(sql`SELECT * FROM crove_kernel.mail_event_pending`.execute(db)).rejects.toThrow(/permission denied/);
  });
});
