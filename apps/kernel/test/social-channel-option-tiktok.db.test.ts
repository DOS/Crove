// A TikTok account's creator options for the composer on PostgreSQL 17 (#1497), through the channel option cache of
// #1120: asked for by a member, read by the worker from creator_info with the account's sealed token and recorded; a
// spam-risk answer is kept as the try-later note; the list is fresh for minutes, not a day; and asking counts against
// the org's budget. TikTok answers are recorded shapes from TikTok's Content Posting API reference; no live call. Set
// CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TikTokPublisher, TIKTOK_SCOPES, YOUTUBE_SCOPES, type Fetch, type Publisher } from '@crove/channel';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { CredentialVault, Runtime, parseVaultKey } from '@crove/kernel-runtime';
import { CHANNEL_OPTION_FRESH_MS, CHANNEL_OPTION_PER_MINUTE, runChannelOptionJob, socialCommands, socialQueries, type ChannelOptionList } from '@crove/mod-social';
import { tiktokCreatorOf } from '@crove/mod-social/contract';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

const APP = { clientKey: 'awtestclientkey01', clientSecret: 'test-tiktok-secret-not-real' };
const CREATOR_INFO = 'POST open.tiktokapis.com/v2/post/publish/creator_info/query/';
const ok = { code: 'ok', message: '', log_id: 'log-1' };

type Answer = { status?: number; body?: unknown };
// TikTok as recorded answers, by method, host and path; every call is kept with its authorization.
function platform(routes: Record<string, Answer[]>) {
  const calls: { route: string; authorization: string | null }[] = [];
  const fetchImpl: Fetch = async (input, init) => {
    const url = new URL(input);
    const route = `${init?.method ?? 'GET'} ${url.host}${url.pathname}`;
    calls.push({ route, authorization: new Headers(init?.headers).get('authorization') });
    const answer = routes[route]?.shift() ?? { status: 500, body: { error: { code: 'internal_error', message: `no answer for ${route}` } } };
    return new Response(JSON.stringify(answer.body ?? {}), { status: answer.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
  return { calls, fetchImpl };
}
const creator = (data: Record<string, unknown>): Answer => ({ body: { data, error: ok } });

suite('TikTok creator options as channel options on PostgreSQL (#1497)', () => {
  const dbName = `crove_test_social_option_tiktok_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  let worker: Runtime;
  const vault = new CredentialVault([parseVaultKey(randomBytes(32).toString('base64'))]);
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

  async function org() {
    const person = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@option-tiktok.test`, name: null });
    const owner = await person('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    const member = await person('member');
    await admin((c) => c.query('INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, $3)', [orgId, member, 'member']));
    return { orgId, owner, member };
  }
  type Org = Awaited<ReturnType<typeof org>>;

  // A channel connected by the org's owner, its secret sealed as the connect flow seals it.
  async function connect(o: Org, provider: string, externalAccountId: string, secret: Record<string, string>, scopes: string[]) {
    const sealed = vault.seal(JSON.stringify(secret), { orgId: o.orgId, provider, externalAccountId });
    const { connectionId } = await rt.execute<{ connectionId: string }>(
      'kernel.channel.connect',
      { provider, externalAccountId, displayName: `Tiệm bánh ${externalAccountId.slice(0, 8)}`, scopes, expiresAt: null, credential: { keyId: sealed.keyId, envelope: sealed.envelope.toString('base64') } },
      { actor: asUser(o.owner), orgId: o.orgId },
    );
    return connectionId;
  }
  async function tiktok(o: Org) {
    const openId = `-000${randomBytes(8).toString('hex')}`;
    const token = `act.${randomBytes(12).toString('hex')}`;
    const connectionId = await connect(o, 'tiktok', openId, { accessToken: token, refreshToken: `rft.${randomBytes(8).toString('hex')}` }, [...TIKTOK_SCOPES]);
    return { connectionId, token };
  }

  const request = (o: Org, connectionId: string) => rt.execute<ChannelOptionList>('social.channel_option.request', { connectionId }, { actor: asUser(o.member), orgId: o.orgId });
  const get = (o: Org, connectionId: string) => rt.query<ChannelOptionList | null>('social.channel_option.get', { connectionId }, { actor: asUser(o.member), orgId: o.orgId });
  const events = (o: Org) =>
    admin(async (c) => (await c.query<{ payload: { option_id: string; kind: string } }>("SELECT payload FROM crove_kernel.outbox_event WHERE org_id = $1 AND type = 'social.channel_option.requested' ORDER BY created_at, id", [o.orgId])).rows);
  const optionId = async (o: Org, connectionId: string) =>
    admin(async (c) => (await c.query<{ id: string }>('SELECT id FROM crove_social.channel_option WHERE org_id = $1 AND channel_connection_id = $2', [o.orgId, connectionId])).rows[0]?.id as string);
  const stored = (id: string) => admin(async (c) => (await c.query<{ kind: string; status: string; items: string; error: string | null }>('SELECT kind, status, items::text AS items, error FROM crove_social.channel_option WHERE id = $1', [id])).rows[0]);
  const job = (o: Org, id: string, publishers: Readonly<Record<string, Publisher>>) => runChannelOptionJob({ runtime: worker, broker: vault, publishers }, o.orgId, id);
  // The list's last answer, moved back in time as if it were read that long ago.
  const age = (id: string, ms: number) => admin((c) => c.query("UPDATE crove_social.channel_option SET fetched_at = fetched_at - ($2 || ' milliseconds')::interval, requested_at = requested_at - ($2 || ' milliseconds')::interval WHERE id = $1", [id, String(ms)]));

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
    const as = (user: string, password: string) => {
      const u = new URL(adminUrl);
      u.username = user;
      u.password = password;
      return u.toString();
    };
    pool = createPool({ connectionString: as('crove_app', 'test-app-pw'), max: 4 });
    workerPool = createPool({ connectionString: as('crove_worker', 'test-worker-pw'), max: 2 });
    db = createDb(pool);
    const registry = { commands: [...kernelCommands, ...socialCommands], queries: [...kernelQueries({ inboundDomain: null }), ...socialQueries] };
    rt = new Runtime(db).register(registry);
    worker = new Runtime(createDb(workerPool)).register(registry);
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    await workerPool?.end();
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it("reads the account's creator_info through the worker with the account's own token, and keeps no token", async () => {
    const o = await org();
    const t = await tiktok(o);
    expect(await request(o, t.connectionId)).toMatchObject({ connectionId: t.connectionId, kind: 'tiktok_creator', status: 'pending', options: [], error: null });
    const queued = await events(o);
    expect(queued.map((e) => e.payload.kind)).toEqual(['tiktok_creator']);
    const id = queued[0]?.payload.option_id as string;
    const api = platform({ [CREATOR_INFO]: [creator({ creator_nickname: 'Tiệm Bánh B', creator_username: 'tiembanhb', privacy_level_options: ['SELF_ONLY'], comment_disabled: false, duet_disabled: true, stitch_disabled: false, max_video_post_duration_sec: 600 })] });
    expect(await job(o, id, { tiktok: new TikTokPublisher(APP, api.fetchImpl) })).toBe('ready');
    expect(api.calls).toEqual([{ route: CREATOR_INFO, authorization: `Bearer ${t.token}` }]);
    const list = await get(o, t.connectionId);
    expect(list).toMatchObject({ kind: 'tiktok_creator', status: 'ready', error: null });
    // An account offering only "Only me" gives one privacy choice; duet is off; a 700 s video passes the 600 s limit.
    expect(tiktokCreatorOf(list?.options ?? [])).toEqual({ nickname: 'Tiệm Bánh B', privacyLevels: ['SELF_ONLY'], off: { comment: false, duet: true, stitch: false }, maxVideoSeconds: 600, cannotPost: null });
    const row = await stored(id);
    expect(row?.kind).toBe('tiktok_creator');
    expect(row?.items).not.toContain(t.token);
    expect(JSON.stringify(await events(o))).not.toContain(t.token);
  });

  it('keeps a spam-risk answer as the try-later note, and an expired token as a failed read that rests', async () => {
    const o = await org();
    const banned = await tiktok(o);
    const expired = await tiktok(o);
    await request(o, banned.connectionId);
    await request(o, expired.connectionId);
    const api = platform({
      [CREATOR_INFO]: [
        { body: { data: {}, error: { code: 'spam_risk_too_many_posts', message: 'The user has reached the daily post limit' } } },
        { status: 401, body: { error: { code: 'access_token_invalid', message: 'expired' } } },
      ],
    });
    const publishers = { tiktok: new TikTokPublisher(APP, api.fetchImpl) };
    expect(await job(o, await optionId(o, banned.connectionId), publishers)).toBe('ready');
    expect(await job(o, await optionId(o, expired.connectionId), publishers)).toBe('failed');
    expect(tiktokCreatorOf((await get(o, banned.connectionId))?.options ?? [])).toMatchObject({ privacyLevels: [], cannotPost: 'spam_risk_too_many_posts' });
    const failed = await get(o, expired.connectionId);
    expect(failed).toMatchObject({ status: 'failed', options: [], error: 'token_expired' });
    expect(failed?.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('is fresh for minutes, not a day: asked again after that, it is read again', async () => {
    expect(CHANNEL_OPTION_FRESH_MS.tiktok_creator).toBe(5 * 60_000);
    expect(CHANNEL_OPTION_FRESH_MS.youtube_playlist).toBe(24 * 60 * 60_000);
    const o = await org();
    const t = await tiktok(o);
    await request(o, t.connectionId);
    const id = await optionId(o, t.connectionId);
    const api = platform({ [CREATOR_INFO]: [creator({ privacy_level_options: ['PUBLIC_TO_EVERYONE', 'SELF_ONLY'] }), creator({ privacy_level_options: ['SELF_ONLY'] })] });
    const publishers = { tiktok: new TikTokPublisher(APP, api.fetchImpl) };
    expect(await job(o, id, publishers)).toBe('ready');
    // A minute later, the list is the answer: nothing is queued.
    await age(id, 60_000);
    expect(await request(o, t.connectionId)).toMatchObject({ status: 'ready' });
    expect(await events(o)).toHaveLength(1);
    // Past its freshness, asking again queues a new read; the last answer stays until the worker records the new one.
    await age(id, CHANNEL_OPTION_FRESH_MS.tiktok_creator);
    expect(await request(o, t.connectionId)).toMatchObject({ status: 'pending' });
    expect(await events(o)).toHaveLength(2);
    expect(await job(o, id, publishers)).toBe('ready');
    expect(tiktokCreatorOf((await get(o, t.connectionId))?.options ?? []).privacyLevels).toEqual(['SELF_ONLY']);
    // A YouTube list of the same age is still fresh.
    const channelId = `UC${randomBytes(16).toString('hex').slice(0, 22)}`;
    const youtube = await connect(o, 'youtube', channelId, { accessToken: `ya29.${randomBytes(12).toString('hex')}`, refreshToken: `1//${randomBytes(8).toString('hex')}` }, [...YOUTUBE_SCOPES]);
    await request(o, youtube);
    const yid = await optionId(o, youtube);
    await worker.execute('social.channel_option.record', { optionId: yid, result: { ok: true, options: [] } }, { actor: { type: 'system', component: 'option-tiktok-test' }, orgId: o.orgId });
    await age(yid, CHANNEL_OPTION_FRESH_MS.tiktok_creator + 60_000);
    expect(await request(o, youtube)).toMatchObject({ status: 'ready' });
  });

  it("counts against the org's budget of lists a minute", async () => {
    const o = await org();
    const channels = [];
    for (let i = 0; i <= CHANNEL_OPTION_PER_MINUTE; i++) channels.push(await tiktok(o));
    for (const c of channels.slice(0, CHANNEL_OPTION_PER_MINUTE)) expect(await request(o, c.connectionId)).toMatchObject({ kind: 'tiktok_creator', status: 'pending' });
    await expect(request(o, channels[CHANNEL_OPTION_PER_MINUTE]?.connectionId as string)).rejects.toMatchObject({ code: 'CHANNEL_OPTION_LIMIT' });
  });
});
