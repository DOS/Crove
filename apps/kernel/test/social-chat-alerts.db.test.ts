// Team alerts in a Telegram or Discord chat (#863) on PostgreSQL 17: who saves, tests and removes the org's chat; that
// the sealed target sits only in the definer-only chat_alert_target, which the API's role can neither read nor read out;
// that no answer, audit row or log carries it; and the worker path: one line per alerting event to a fake Telegram or
// Discord (recorded answers), nothing for a kind not ticked, the per-org limit, the test line and its recorded
// outcome, a saver who lost the admin role, and a failed send that leaves the notification mail alone. Set
// CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Fetch } from '@crove/channel';
import { createDb, createPool, type Db, type MemberRole } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { CredentialVault, generateVaultKey, parseVaultKey, Runtime } from '@crove/kernel-runtime';
import { socialCommands, socialQueries, type ChatAlertView, type PostView } from '@crove/mod-social';
import { ChatAlertTestBudget, requestChatAlertTest, saveChatAlert, type ChatAlertSaveInput } from '../src/chat-alert-save.ts';
import { CHAT_ALERT_TEST_TEXT, ChatAlertSender } from '../src/chat-alerts.ts';
import { TEST_MANIFESTS } from './manifests.ts';
import { contextToken } from './context-token.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

const BOT_TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw1';
const CHAT_ID = '-4012345678';
const HOOK = '1234567890123456789';
const HOOK_TOKEN = `tok_${'A1b2C3d4'.repeat(8)}`;
const PUBLIC_URL = 'https://crove.example';

type Answer = { status?: number; body: unknown };
type Call = { host: string; path: string; json: Record<string, unknown> | null };

// A fake Telegram Bot API and Discord webhook with recorded answers: a method's queue first, then its default.
function platforms(queued: Record<string, Answer[]> = {}) {
  const calls: Call[] = [];
  const defaults: Record<string, Answer> = {
    getMe: { body: { ok: true, result: { id: 987654321, is_bot: true, username: 'shop_bot' } } },
    getChat: { body: { ok: true, result: { id: Number(CHAT_ID), type: 'group', title: 'Nhóm bán hàng' } } },
    getChatMember: { body: { ok: true, result: { status: 'member' } } },
    sendMessage: { body: { ok: true, result: { message_id: 1 } } },
    'discord.GET': { body: { type: 1, id: HOOK, name: 'Thông báo Crove', channel_id: '876543210987654321', guild_id: '987654321098765432' } },
    'discord.POST': { body: { id: '1111111111111111111' } },
  };
  const fetchImpl: Fetch = async (input, init) => {
    const url = new URL(input);
    const json = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    calls.push({ host: url.hostname, path: url.pathname, json });
    const method = url.hostname === 'api.telegram.org' ? (url.pathname.split('/')[2] as string) : `discord.${init?.method ?? 'GET'}`;
    const answer = queued[method]?.shift() ?? defaults[method] ?? { status: 500, body: { ok: false } };
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
  const sent = () => calls.filter((c) => c.path.endsWith('/sendMessage') || (c.host === 'discord.com' && c.json !== null));
  return { calls, sent, fetchImpl };
}

suite('social team chat alerts on PostgreSQL (#863)', () => {
  const dbName = `crove_test_social_chat_alerts_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  let appUrl = '';
  // The worker's runtime (the crove_worker login): only it enters an org's system context.
  let worker: Runtime;
  const broker = new CredentialVault([parseVaultKey(generateVaultKey())]);
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

  type Org = { orgId: string; slug: string; owner: string; admin: string; member: string; viewer: string; seen: Set<string> };
  async function org(): Promise<Org> {
    const owner = await person('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    const people = { admin: await person('admin'), member: await person('member'), viewer: await person('viewer') };
    for (const [role, id] of Object.entries(people)) await admin((c) => c.query('INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, $3)', [orgId, id, role]));
    const slug = await admin(async (c) => (await c.query<{ slug: string }>('SELECT slug FROM crove_kernel.tenant WHERE org_id = $1', [orgId])).rows[0]?.slug as string);
    return { orgId, slug, owner, ...people, seen: new Set() };
  }
  const roleOf = (o: Org, user: string): MemberRole => (user === o.owner ? 'owner' : user === o.admin ? 'admin' : user === o.member ? 'member' : 'viewer');
  const scope = (o: Org, user: string) => ({ orgId: o.orgId, actor: asUser(user), role: roleOf(o, user) });
  const telegramInput = (events: ChatAlertSaveInput['events'] = ['needs_approval', 'failed', 'published', 'client_answered']): ChatAlertSaveInput => ({ kind: 'telegram', botToken: BOT_TOKEN, chatId: CHAT_ID, events });
  const save = (o: Org, user: string, input: ChatAlertSaveInput, fetchImpl: Fetch) => saveChatAlert({ runtime: rt, broker, fetch: fetchImpl }, scope(o, user), input);
  const get = (o: Org, user: string) => rt.query<ChatAlertView | null>('social.chat_alert.get', {}, { actor: asUser(user), orgId: o.orgId });

  async function connection(orgId: string, owner: string, name = 'Facebook Quán Phở') {
    const id = randomUUID();
    await admin((c) =>
      c.query('INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, $3, $4, $5, $6)', [orgId, id, 'sandbox', `acct-${id.slice(0, 8)}`, name, owner]),
    );
    return id;
  }
  const exec = <O>(o: Org, user: string, name: string, input: unknown) => rt.execute<O>(name, input, { actor: asUser(user), orgId: o.orgId });
  const post = (o: Org, user: string, postId: string) => rt.query<PostView>('social.post.get', { postId }, { actor: asUser(user), orgId: o.orgId });
  // An event the worker would get from the publish job or a review link, written as the system writes it.
  const event = (o: Org, type: string, payload: Record<string, unknown>) =>
    admin(async (c) => (await c.query<{ id: string }>("INSERT INTO crove_kernel.outbox_event (org_id, type, payload, actor_type) VALUES ($1, $2, $3, 'system') RETURNING id", [o.orgId, type, payload])).rows[0]?.id as string);
  // What the worker does for each new outbox event of the org: the chat alert job.
  async function alert(o: Org, sender: ChatAlertSender): Promise<string[]> {
    const events = await admin(async (c) => (await c.query<{ id: string }>('SELECT id FROM crove_kernel.outbox_event WHERE org_id = $1 ORDER BY created_at, id', [o.orgId])).rows);
    const outcomes: string[] = [];
    for (const e of events) {
      if (o.seen.has(e.id)) continue;
      o.seen.add(e.id);
      const outcome = await sender.handle(o.orgId, e.id);
      if (outcome !== 'none') outcomes.push(outcome);
    }
    return outcomes;
  }
  const sender = (fetchImpl: Fetch, perMinute?: number) => new ChatAlertSender({ runtime: worker, broker, publicUrl: PUBLIC_URL, fetch: fetchImpl, ...(perMinute ? { perMinute } : {}) });
  async function submitted(o: Org, body = 'Khai trương chi nhánh mới') {
    const conn = await connection(o.orgId, o.owner);
    const { postId } = await exec<{ postId: string }>(o, o.member, 'social.post.create', { body, channels: [{ connectionId: conn }] });
    await exec(o, o.member, 'social.post.submit', { postId });
    const variantId = (await post(o, o.owner, postId)).variants[0]?.id as string;
    return { postId, variantId };
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
    appUrl = app.toString();
    pool = createPool({ connectionString: appUrl, max: 4 });
    db = createDb(pool);
    const registry = { commands: [...kernelCommands, ...socialCommands], queries: [...kernelQueries({ inboundDomain: null }), ...socialQueries] };
    rt = new Runtime(db, { manifests: TEST_MANIFESTS }).register(registry);
    const asWorker = new URL(adminUrl);
    asWorker.username = 'crove_worker';
    asWorker.password = 'test-worker-pw';
    workerPool = createPool({ connectionString: asWorker.toString(), max: 2 });
    worker = new Runtime(createDb(workerPool), { manifests: TEST_MANIFESTS }).register(registry);
  });

  afterEach(() => {
    vi.restoreAllMocks();
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

  it('lets owners and admins save a chat the platform checked; every member sees it is on, never its target', async () => {
    const o = await org();
    const api = platforms();
    expect(await save(o, o.admin, telegramInput(['published', 'needs_approval']), api.fetchImpl)).toEqual({ saved: true });
    expect(api.calls.map((c) => c.path.split('/')[2])).toEqual(['getMe', 'getChat', 'getChatMember']);
    for (const user of [o.owner, o.admin, o.member, o.viewer]) {
      const view = await get(o, user);
      expect(view).toEqual({ kind: 'telegram', events: ['needs_approval', 'published'], label: 'Nhóm bán hàng', updatedAt: expect.any(String), lastTestAt: null, lastTestCode: null });
      expect(JSON.stringify(view)).not.toContain(BOT_TOKEN.split(':')[1]);
    }
    // The target is in the definer-only table, as ciphertext; the audit row holds only the kind and the kinds.
    const rows = await admin(async (c) => (await c.query<{ envelope: Buffer; key_id: string }>('SELECT envelope, key_id FROM crove_social.chat_alert_target WHERE org_id = $1', [o.orgId])).rows);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.envelope.includes(Buffer.from(BOT_TOKEN.split(':')[1] as string))).toBe(false);
    expect(rows[0]?.envelope.includes(Buffer.from(CHAT_ID))).toBe(false);
    expect(rows[0]?.key_id).toBe(broker.keyId);
    const audit = await admin(async (c) => (await c.query<{ detail: unknown }>("SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command LIKE 'social.chat_alert.%'", [o.orgId])).rows);
    expect(audit.map((a) => a.detail)).toEqual([expect.objectContaining({ kind: 'telegram', events: ['needs_approval', 'published'] })]);
    expect(JSON.stringify(audit)).not.toContain(BOT_TOKEN.split(':')[1]);

    // A member or a viewer cannot save, and the platform is not called for them.
    for (const user of [o.member, o.viewer]) {
      const refused = platforms();
      await expect(save(o, user, telegramInput(), refused.fetchImpl)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(refused.calls).toEqual([]);
      await expect(exec(o, user, 'social.chat_alert.remove', {})).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(exec(o, user, 'social.chat_alert.test', {})).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    // Nor can they write a target of their own making through the command.
    await expect(exec(o, o.member, 'social.chat_alert.save', { id: randomUUID(), kind: 'discord', keyId: 'k', envelope: 'AA==', label: 'x', events: ['failed'] })).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // Saving again replaces the org's chat; the platform's refusal saves nothing.
    expect(await save(o, o.owner, { kind: 'discord', webhookUrl: `https://discord.com/api/webhooks/${HOOK}/${HOOK_TOKEN}`, events: ['failed'] }, api.fetchImpl)).toEqual({ saved: true });
    expect(await get(o, o.viewer)).toMatchObject({ kind: 'discord', events: ['failed'], label: 'Thông báo Crove' });
    const refused = platforms({ getChat: [{ status: 400, body: { ok: false, error_code: 400, description: 'Bad Request: chat not found' } }] });
    await expect(save(o, o.owner, telegramInput(), refused.fetchImpl)).rejects.toMatchObject({ code: 'TELEGRAM_CHAT_NOT_FOUND' });
    await expect(save(o, o.owner, { kind: 'telegram', botToken: 'nope', chatId: CHAT_ID, events: ['failed'] }, refused.fetchImpl)).rejects.toMatchObject({ code: 'TELEGRAM_TOKEN_INVALID' });
    expect(await get(o, o.viewer)).toMatchObject({ kind: 'discord' });
    expect(await admin(async (c) => (await c.query('SELECT 1 FROM crove_social.chat_alert WHERE org_id = $1', [o.orgId])).rowCount)).toBe(1);
    expect(await admin(async (c) => (await c.query('SELECT 1 FROM crove_social.chat_alert_target WHERE org_id = $1', [o.orgId])).rowCount)).toBe(1);

    // Another org sees none of it.
    const other = await org();
    expect(await get(other, other.owner)).toBeNull();

    expect(await exec(o, o.admin, 'social.chat_alert.remove', {})).toEqual({ removed: true });
    expect(await get(o, o.owner)).toBeNull();
    expect(await admin(async (c) => (await c.query('SELECT 1 FROM crove_social.chat_alert_target WHERE org_id = $1', [o.orgId])).rowCount)).toBe(0);
    expect(await exec(o, o.admin, 'social.chat_alert.remove', {})).toEqual({ removed: false });
  });

  it('keeps the sealed target from the API: no column of chat_alert, no read and no read-out for crove_app', async () => {
    const columns = await admin(
      async (c) => (await c.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_schema = 'crove_social' AND table_name = 'chat_alert' ORDER BY ordinal_position")).rows,
    );
    expect(columns.map((r) => r.column_name)).not.toContain('envelope');
    expect(columns.map((r) => r.column_name)).not.toContain('key_id');
    const grants = await admin(
      async (c) =>
        (
          await c.query<{ role: string; select: boolean; get: boolean; put: boolean }>(
            `SELECT r AS role, has_table_privilege(r, 'crove_social.chat_alert_target', 'SELECT') AS select,
                    has_function_privilege(r, 'crove_social.chat_alert_target_get(uuid)', 'EXECUTE') AS get,
                    has_function_privilege(r, 'crove_social.chat_alert_target_put(uuid, text, bytea)', 'EXECUTE') AS put
               FROM unnest(ARRAY['crove_app', 'crove_tenant', 'crove_worker']) r ORDER BY r`,
          )
        ).rows,
    );
    expect(grants).toEqual([
      { role: 'crove_app', select: false, get: false, put: true },
      { role: 'crove_tenant', select: false, get: false, put: false },
      { role: 'crove_worker', select: false, get: true, put: true },
    ]);
    // As the API's own login, in an owner's context of an org with a saved chat.
    const o = await org();
    await save(o, o.owner, telegramInput(), platforms().fetchImpl);
    const alertId = await admin(async (c) => (await c.query<{ id: string }>('SELECT id FROM crove_social.chat_alert WHERE org_id = $1', [o.orgId])).rows[0]?.id as string);
    const api = new pg.Client({ connectionString: appUrl });
    await api.connect();
    try {
      const attempt = async (statement: string, params: unknown[] = []) => {
        await api.query('BEGIN');
        try {
          await api.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [o.orgId, contextToken(o.owner, o.orgId)]);
          await api.query(statement, params);
        } finally {
          await api.query('ROLLBACK');
        }
      };
      await expect(attempt('SELECT * FROM crove_social.chat_alert_target')).rejects.toThrow(/permission denied/);
      await expect(attempt('SELECT * FROM crove_social.chat_alert_target_get($1::uuid)', [alertId])).rejects.toThrow(/permission denied/);
    } finally {
      await api.end();
    }
    // The worker reads it out only in the org's system context.
    await expect(rt.query('social.chat_alert.target', {}, { actor: asUser(o.owner), orgId: o.orgId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await worker.query('social.chat_alert.target', {}, { actor: system, orgId: o.orgId })).toMatchObject({ id: alertId, kind: 'telegram', keyId: broker.keyId });
  });

  it('asks the worker for a test line, which sends it and records how it went', async () => {
    const o = await org();
    const api = platforms();
    const budget = new ChatAlertTestBudget();
    const request = (user: string) => requestChatAlertTest(rt, budget, scope(o, user));
    const testEvents = async () => (await admin(async (c) => (await c.query<{ id: string }>("SELECT id FROM crove_kernel.outbox_event WHERE org_id = $1 AND type = 'social.chat_alert.test_requested' ORDER BY created_at, id", [o.orgId])).rows)).map((r) => r.id);
    const lastEvent = async () => (await testEvents()).at(-1) as string;
    await expect(request(o.owner)).rejects.toMatchObject({ code: 'CHAT_ALERT_NOT_SET' });
    await save(o, o.owner, telegramInput(), api.fetchImpl);
    await expect(request(o.member)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await get(o, o.viewer)).toMatchObject({ lastTestAt: null, lastTestCode: null });

    // Asked for: nothing is sent by the API, an event waits for the worker.
    expect(await request(o.admin)).toEqual({ queued: true });
    expect(api.sent()).toEqual([]);
    const worker1 = sender(api.fetchImpl);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await worker1.test(o.orgId, await lastEvent())).toBe('sent');
    expect(api.sent().map((c) => c.json)).toEqual([{ chat_id: CHAT_ID, text: CHAT_ALERT_TEST_TEXT, link_preview_options: { is_disabled: true } }]);
    const sent = await get(o, o.viewer);
    expect(sent).toMatchObject({ lastTestAt: expect.any(String), lastTestCode: null });
    // The same job again sends nothing.
    expect(await worker1.test(o.orgId, await lastEvent())).toBe('duplicate');

    // A recorded refusal: the bot was removed from the group.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const kicked = platforms({ sendMessage: [{ status: 403, body: { ok: false, error_code: 403, description: `Forbidden: bot ${BOT_TOKEN} was kicked from the group chat` } }] });
    await request(o.owner);
    expect(await sender(kicked.fetchImpl).test(o.orgId, await lastEvent())).toBe('failed');
    expect(await get(o, o.viewer)).toMatchObject({ lastTestCode: 'CHAT_ALERT_REFUSED' });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(BOT_TOKEN.split(':')[1]);
    const silent = platforms({ sendMessage: [{ status: 502, body: null }] });
    await request(o.owner);
    expect(await sender(silent.fetchImpl).test(o.orgId, await lastEvent())).toBe('failed');
    expect(await get(o, o.viewer)).toMatchObject({ lastTestCode: 'CHAT_ALERT_UNREACHABLE' });
    // The requests are audited with the kind only; the outcomes with their code.
    const audit = await admin(async (c) => (await c.query<{ command: string; detail: unknown }>("SELECT command, detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command IN ('social.chat_alert.test', 'social.chat_alert.tested') AND outcome = 'ok' ORDER BY occurred_at", [o.orgId])).rows);
    expect(audit.filter((a) => a.command === 'social.chat_alert.test').every((a) => (a.detail as { kind?: string }).kind === 'telegram')).toBe(true);
    expect(audit.filter((a) => a.command === 'social.chat_alert.tested').map((a) => (a.detail as { code?: string | null }).code)).toEqual([null, 'CHAT_ALERT_REFUSED', 'CHAT_ALERT_UNREACHABLE']);
    // Five a minute per org, the refused one before the chat was saved included.
    await request(o.owner);
    await expect(request(o.owner)).rejects.toMatchObject({ code: 'CHAT_ALERT_TEST_LIMIT' });
    // Only the worker records an outcome.
    await expect(exec(o, o.owner, 'social.chat_alert.tested', { code: null })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('stops opening the target once the member who saved it is no longer an owner or admin', async () => {
    const o = await org();
    const api = platforms();
    await save(o, o.admin, telegramInput(['published']), api.fetchImpl);
    const { postId, variantId } = await submitted(o);
    await admin((c) => c.query("UPDATE crove_kernel.tenant_member SET role = 'member' WHERE org_id = $1 AND user_id = $2", [o.orgId, o.admin]));
    await expect(worker.query('social.chat_alert.target', {}, { actor: system, orgId: o.orgId })).rejects.toMatchObject({ code: 'CHAT_ALERT_OWNER_LEFT' });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await event(o, 'social.variant.published', { post_id: postId, variant_id: variantId });
    expect(await alert(o, sender(api.fetchImpl))).toEqual(['failed']);
    expect(api.sent()).toEqual([]);
    expect(error.mock.calls.flat().join(' ')).toContain('CHAT_ALERT_OWNER_LEFT');
    // A test line records why it did not go out; the alert stays as it was saved, for an owner to save again.
    await requestChatAlertTest(rt, new ChatAlertTestBudget(), scope(o, o.owner));
    const testEvent = await admin(async (c) => (await c.query<{ id: string }>("SELECT id FROM crove_kernel.outbox_event WHERE org_id = $1 AND type = 'social.chat_alert.test_requested'", [o.orgId])).rows[0]?.id as string);
    expect(await sender(api.fetchImpl).test(o.orgId, testEvent)).toBe('failed');
    expect(await get(o, o.owner)).toMatchObject({ kind: 'telegram', lastTestCode: 'CHAT_ALERT_OWNER_LEFT' });
    // A disabled owner who saved it counts as gone too.
    await save(o, o.owner, telegramInput(['published']), api.fetchImpl);
    expect(await worker.query('social.chat_alert.target', {}, { actor: system, orgId: o.orgId })).toMatchObject({ kind: 'telegram' });
    await admin((c) => c.query('UPDATE crove_kernel.user_account SET disabled_at = now() WHERE id = $1', [o.owner]));
    await expect(worker.query('social.chat_alert.target', {}, { actor: system, orgId: o.orgId })).rejects.toMatchObject({ code: 'CHAT_ALERT_OWNER_LEFT' });
  });

  it('posts one line per event to the chat, for the kinds ticked only, with the link to the post', async () => {
    const o = await org();
    const api = platforms();
    await save(o, o.owner, telegramInput(['needs_approval', 'published']), api.fetchImpl);
    const worker1 = sender(api.fetchImpl);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { postId, variantId } = await submitted(o);
    expect(await alert(o, worker1)).toEqual(['sent']);
    const link = `${PUBLIC_URL}/o/${o.slug}/social/${postId}`;
    expect(api.sent().map((c) => c.json)).toEqual([{ chat_id: CHAT_ID, text: `Bài «Khai trương chi nhánh mới» trên Facebook Quán Phở đang chờ duyệt: ${link}`, link_preview_options: { is_disabled: true } }]);
    // The same event again (a second job for it) sends nothing.
    const submittedEvent = await admin(async (c) => (await c.query<{ id: string }>("SELECT id FROM crove_kernel.outbox_event WHERE org_id = $1 AND type = 'social.post.submitted'", [o.orgId])).rows[0]?.id as string);
    expect(await worker1.handle(o.orgId, submittedEvent)).toBe('duplicate');
    expect(api.sent()).toHaveLength(1);
    // A failed channel is not ticked: nothing goes out. A published one is.
    await event(o, 'social.variant.failed', { post_id: postId, variant_id: variantId });
    await event(o, 'social.variant.published', { post_id: postId, variant_id: variantId });
    expect(await alert(o, worker1)).toEqual(['sent']);
    expect(api.sent().map((c) => c.json?.text)).toEqual([expect.stringContaining('đang chờ duyệt'), `Bài «Khai trương chi nhánh mới» đã đăng lên Facebook Quán Phở: ${link}`]);
    // No log line carries the token, the chat or the post's text.
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).not.toContain(BOT_TOKEN.split(':')[1]);
    expect(logged).not.toContain(CHAT_ID);
    expect(logged).not.toContain('Khai trương');

    // A client's answer on a review link goes to a Discord chat that ticked it, escaped for Discord; a plain comment does not.
    const d = await org();
    const dApi = platforms();
    await save(d, d.owner, { kind: 'discord', webhookUrl: `https://discord.com/api/webhooks/${HOOK}/${HOOK_TOKEN}`, events: ['client_answered'] }, dApi.fetchImpl);
    const answered = await submitted(d, '**Giảm giá** cuối tuần');
    const feedback = async (verdict: string, name: string) => {
      const id = randomUUID();
      const link = randomUUID();
      await admin(async (c) => {
        await c.query("INSERT INTO crove_social.review_link (org_id, id, post_id, token_sha256, content_key, created_by, expires_at) VALUES ($1, $2, $3, $4, 'k', $5, now() + interval '1 day')", [d.orgId, link, answered.postId, randomUUID().replaceAll('-', '').padEnd(64, '0'), d.owner]);
        await c.query('INSERT INTO crove_social.review_feedback (org_id, id, link_id, post_id, reviewer_name, verdict, body) VALUES ($1, $2, $3, $4, $5, $6, $7)', [d.orgId, id, link, answered.postId, name, verdict, verdict === 'comment' ? 'Đẹp' : null]);
      });
      return event(d, 'social.review.answered', { post_id: answered.postId, feedback_id: id });
    };
    await feedback('comment', 'Chị Lan');
    await feedback('changes_requested', 'Chị Lan');
    // The post waiting for review is not ticked in this chat.
    expect(await alert(d, sender(dApi.fetchImpl))).toEqual(['sent']);
    expect(dApi.sent().map((c) => c.json)).toEqual([
      { content: `Khách hàng Chị Lan yêu cầu sửa bài «\\*\\*Giảm giá\\*\\* cuối tuần»: ${PUBLIC_URL}/o/${d.slug}/social/${answered.postId}`, allowed_mentions: { parse: [] }, flags: 4 },
    ]);
  });

  it('drops what is over the per-org limit, and a target sealed for another org does not open', async () => {
    const o = await org();
    const api = platforms();
    await save(o, o.owner, telegramInput(['published']), api.fetchImpl);
    const { postId, variantId } = await submitted(o);
    for (let i = 0; i < 3; i += 1) await event(o, 'social.variant.published', { post_id: postId, variant_id: variantId });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await alert(o, sender(api.fetchImpl, 2))).toEqual(['sent', 'sent', 'rate_limited']);
    expect(api.sent()).toHaveLength(2);
    expect(warn.mock.calls.flat().join(' ')).toContain('more than 2 alerts a minute');

    // The envelope is bound to its org and alert: copied into another org's target, it does not open, and nothing is sent.
    const b = await org();
    await save(b, b.owner, telegramInput(['published']), api.fetchImpl);
    const other = await submitted(b);
    await admin((c) =>
      c.query('UPDATE crove_social.chat_alert_target t SET envelope = a.envelope, key_id = a.key_id FROM crove_social.chat_alert_target a WHERE t.org_id = $2 AND a.org_id = $1', [o.orgId, b.orgId]),
    );
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await event(b, 'social.variant.published', { post_id: other.postId, variant_id: other.variantId });
    expect(await alert(b, sender(api.fetchImpl))).toEqual(['failed']);
    expect(api.sent()).toHaveLength(2);
    expect(error.mock.calls.flat().join(' ')).toContain('does not open');
  });

  it('logs a failed send without the target, and the notification mail still goes out', async () => {
    const o = await org();
    await save(o, o.owner, telegramInput(['needs_approval']), platforms().fetchImpl);
    const down = platforms({ sendMessage: [{ status: 403, body: { ok: false, error_code: 403, description: `Forbidden: bot ${BOT_TOKEN} was kicked` } }] });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await submitted(o);
    expect(await alert(o, sender(down.fetchImpl))).toEqual(['failed']);
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain('Telegram answered 403');
    expect(logged).not.toContain(BOT_TOKEN.split(':')[1]);
    // The notices and their mail run apart from the chat alert, on the same event.
    let mailed = 0;
    for (const eventId of o.seen) mailed += (await worker.execute<{ mailed: number }>('social.notification.dispatch', { eventId }, { actor: system, orgId: o.orgId })).mailed;
    expect(mailed).toBe(2);
    expect(await admin(async (c) => (await c.query("SELECT 1 FROM crove_kernel.mail_message WHERE org_id = $1 AND source = 'social.notification.dispatch' AND status = 'queued'", [o.orgId])).rowCount)).toBe(2);
  });
});
