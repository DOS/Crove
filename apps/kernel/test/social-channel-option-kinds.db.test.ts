// A YouTube channel's playlists and a WordPress site's categories and tags for the composer on PostgreSQL 17 (#1131,
// #1030), through the channel option cache of #1120: asked for by a member, read by the worker with the channel's
// sealed credential and recorded; each WordPress term keeps its taxonomy; the scope and connection checks hold; and the
// database lets a member only ask again. YouTube and WordPress answers are recorded shapes from the YouTube Data API v3
// and the WordPress REST API handbook; no live call. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its
// own database.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WordPressPublisher, YOUTUBE_SCOPES, YouTubePublisher, type Fetch, type Publisher } from '@crove/channel';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { CredentialVault, Runtime, parseVaultKey } from '@crove/kernel-runtime';
import { runChannelOptionJob, socialCommands, socialQueries, type ChannelOptionList } from '@crove/mod-social';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

const GOOGLE = { clientId: '123456789012-abcdefgh12345678.apps.googleusercontent.com', clientSecret: 'test-google-secret-not-real' };
const SALE = 'PLabcdefghijklmnopqrstuvwxyz012345';
const MENU = 'PL0123456789abcdef';
const PASSWORD_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

type Answer = { status?: number; body?: unknown };
// A platform as recorded answers, by method, host and path; every call is kept with its authorization.
function platform(routes: Record<string, Answer[]>) {
  const calls: { route: string; url: string; authorization: string | null }[] = [];
  const fetchImpl: Fetch = async (input, init) => {
    const url = new URL(input);
    const route = `${init?.method ?? 'GET'} ${url.host}${url.pathname}`;
    calls.push({ route, url: input, authorization: new Headers(init?.headers).get('authorization') });
    const answer = routes[route]?.shift() ?? { status: 500, body: { message: `no answer for ${route}` } };
    return new Response(JSON.stringify(answer.body ?? {}), { status: answer.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
  return { calls, fetchImpl };
}
const PLAYLISTS = 'GET www.googleapis.com/youtube/v3/playlists';

suite('YouTube playlists and WordPress terms as channel options on PostgreSQL (#1131)', () => {
  const dbName = `crove_test_social_option_kinds_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
    const person = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@option-kinds.test`, name: null });
    const owner = await person('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    const member = await person('member');
    const viewer = await person('viewer');
    await admin(async (c) => {
      await c.query('INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, $3)', [orgId, member, 'member']);
      await c.query('INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, $3)', [orgId, viewer, 'viewer']);
    });
    return { orgId, owner, member, viewer };
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
  async function youtube(o: Org) {
    const channelId = `UC${randomBytes(16).toString('hex').slice(0, 22)}`;
    const token = `ya29.${randomBytes(12).toString('hex')}`;
    const connectionId = await connect(o, 'youtube', channelId, { accessToken: token, refreshToken: `1//${randomBytes(8).toString('hex')}` }, [...YOUTUBE_SCOPES]);
    return { connectionId, channelId, token };
  }
  async function wordpress(o: Org) {
    const host = `tiem-${randomBytes(4).toString('hex')}.vn`;
    const password = Array.from(randomBytes(24), (b) => PASSWORD_CHARS[b % PASSWORD_CHARS.length]).join('');
    const connectionId = await connect(o, 'wordpress', host, { site: `https://${host}`, username: 'chutiem', appPassword: password }, ['application_password']);
    return { connectionId, host, password, basic: `Basic ${Buffer.from(`chutiem:${password}`).toString('base64')}` };
  }

  const request = (o: Org, user: string, connectionId: string) => rt.execute<ChannelOptionList>('social.channel_option.request', { connectionId }, { actor: asUser(user), orgId: o.orgId });
  const get = (o: Org, user: string, connectionId: string) => rt.query<ChannelOptionList | null>('social.channel_option.get', { connectionId }, { actor: asUser(user), orgId: o.orgId });
  const events = (o: Org) =>
    admin(async (c) => (await c.query<{ payload: { option_id: string; kind: string } }>("SELECT payload FROM crove_kernel.outbox_event WHERE org_id = $1 AND type = 'social.channel_option.requested' ORDER BY created_at", [o.orgId])).rows);
  const optionId = async (o: Org, connectionId: string) =>
    admin(async (c) => (await c.query<{ id: string }>('SELECT id FROM crove_social.channel_option WHERE org_id = $1 AND channel_connection_id = $2', [o.orgId, connectionId])).rows[0]?.id as string);
  const stored = (id: string) => admin(async (c) => (await c.query<{ kind: string; status: string; items: string; error: string | null }>('SELECT kind, status, items::text AS items, error FROM crove_social.channel_option WHERE id = $1', [id])).rows[0]);
  const job = (o: Org, id: string, publishers: Readonly<Record<string, Publisher>>, deadlineMs?: number) =>
    runChannelOptionJob({ runtime: worker, broker: vault, publishers, ...(deadlineMs === undefined ? {} : { deadlineMs }) }, o.orgId, id);
  const system = (o: Org) => ({ actor: { type: 'system' as const, component: 'channel-option-kinds-test' }, orgId: o.orgId });

  // SQL in the context of a member of the org, as the API's login role runs it; rolled back.
  async function asMember(o: Org, user: string, text: string, params: unknown[]) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT crove_kernel.enter_context($1::uuid, $2::uuid)', [user, o.orgId]);
      return await c.query(text, params);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
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
    rt = new Runtime(db, { manifests: TEST_MANIFESTS }).register(registry);
    worker = new Runtime(createDb(workerPool), { manifests: TEST_MANIFESTS }).register(registry);
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    await workerPool?.end();
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it("lists a YouTube channel's playlists through the worker with the channel's own token, page by page", async () => {
    const o = await org();
    const y = await youtube(o);
    expect(await request(o, o.member, y.connectionId)).toMatchObject({ connectionId: y.connectionId, kind: 'youtube_playlist', status: 'pending', options: [], error: null });
    const queued = await events(o);
    expect(queued.map((e) => e.payload.kind)).toEqual(['youtube_playlist']);
    const google = platform({
      [PLAYLISTS]: [
        { body: { kind: 'youtube#playlistListResponse', items: [{ id: SALE, snippet: { title: 'Khuyến mãi tháng 10' } }], nextPageToken: 'CAEQAA' } },
        { body: { kind: 'youtube#playlistListResponse', items: [{ id: MENU, snippet: { title: 'Thực đơn <mới>' } }] } },
      ],
    });
    expect(await job(o, queued[0]?.payload.option_id as string, { youtube: new YouTubePublisher(GOOGLE, google.fetchImpl) })).toBe('ready');
    expect(google.calls.map((c) => [c.route, c.authorization])).toEqual([
      [PLAYLISTS, `Bearer ${y.token}`],
      [PLAYLISTS, `Bearer ${y.token}`],
    ]);
    expect(new URL(google.calls[1]?.url as string).searchParams.get('pageToken')).toBe('CAEQAA');
    expect(await get(o, o.member, y.connectionId)).toMatchObject({
      status: 'ready',
      options: [
        { id: SALE, name: 'Khuyến mãi tháng 10' },
        // YouTube's text, kept as text; the composer shows it as text.
        { id: MENU, name: 'Thực đơn <mới>' },
      ],
    });
    const row = await stored(queued[0]?.payload.option_id as string);
    expect(row?.items).not.toContain(y.token);
    expect(JSON.stringify(await events(o))).not.toContain(y.token);
    expect(JSON.parse(row?.items ?? '[]').some((i: Record<string, unknown>) => 'taxonomy' in i)).toBe(false);
  });

  it("lists a WordPress site's categories and tags with their taxonomy, read with the site's own login", async () => {
    const o = await org();
    const w = await wordpress(o);
    expect(await request(o, o.member, w.connectionId)).toMatchObject({ kind: 'wordpress_term', status: 'pending' });
    const id = await optionId(o, w.connectionId);
    const site = platform({
      [`GET ${w.host}/wp-json/wp/v2/categories`]: [{ body: [{ id: 1, name: 'Chưa phân loại' }, { id: 7, name: 'Tin tức &amp; Sự kiện' }] }],
      [`GET ${w.host}/wp-json/wp/v2/tags`]: [{ body: [{ id: 7, name: 'bánh mì' }] }],
    });
    expect(await job(o, id, { wordpress: new WordPressPublisher(site.fetchImpl) })).toBe('ready');
    expect(site.calls.map((c) => [c.route, c.authorization])).toEqual([
      [`GET ${w.host}/wp-json/wp/v2/categories`, w.basic],
      [`GET ${w.host}/wp-json/wp/v2/tags`, w.basic],
    ]);
    expect((await get(o, o.owner, w.connectionId))?.options).toEqual([
      { id: '1', name: 'Chưa phân loại', taxonomy: 'category' },
      { id: '7', name: 'Tin tức & Sự kiện', taxonomy: 'category' },
      // The same id in the other taxonomy is another term.
      { id: '7', name: 'bánh mì', taxonomy: 'tag' },
    ]);
    const row = await stored(id);
    expect(row?.items).not.toContain(w.password);
    expect(JSON.stringify(await events(o))).not.toContain(w.password);
  });

  it('records why a list could not be read, as for Pinterest', async () => {
    const o = await org();
    const rest = (connectionId: string) => admin((c) => c.query("UPDATE crove_social.channel_option SET fetched_at = fetched_at - interval '6 minutes' WHERE channel_connection_id = $1", [connectionId]));
    const y = await youtube(o);
    const yt = (answer: Answer) => ({ youtube: new YouTubePublisher(GOOGLE, platform({ [PLAYLISTS]: [answer] }).fetchImpl) });
    const google = (status: number, reason: string) => ({ status, body: { error: { code: status, message: reason, errors: [{ reason }] } } });
    for (const [answer, error] of [
      [google(401, 'authError'), 'token_expired'],
      [google(403, 'insufficientPermissions'), 'permission'],
      [google(404, 'channelNotFound'), 'not_found'],
      [google(403, 'quotaExceeded'), 'no_answer'],
    ] as const) {
      await request(o, o.member, y.connectionId);
      expect(await job(o, await optionId(o, y.connectionId), yt(answer))).toBe('failed');
      expect(await get(o, o.member, y.connectionId)).toMatchObject({ status: 'failed', error, options: [] });
      await rest(y.connectionId);
    }
    const w = await wordpress(o);
    const wp = (answer: Answer) => ({ wordpress: new WordPressPublisher(platform({ [`GET ${w.host}/wp-json/wp/v2/categories`]: [answer] }).fetchImpl) });
    for (const [answer, error] of [
      [{ status: 401, body: { code: 'incorrect_password', message: 'Invalid application password.' } }, 'token_expired'],
      [{ status: 404, body: { code: 'rest_no_route', message: 'No route was found.' } }, 'not_found'],
      [{ status: 500, body: { code: 'internal_server_error', message: 'Critical error.' } }, 'no_answer'],
    ] as const) {
      await request(o, o.member, w.connectionId);
      expect(await job(o, await optionId(o, w.connectionId), wp(answer))).toBe('failed');
      expect(await get(o, o.member, w.connectionId)).toMatchObject({ status: 'failed', error, options: [] });
      expect((await stored(await optionId(o, w.connectionId)))?.items).toBe('[]');
      await rest(w.connectionId);
    }
  });

  it('refuses a viewer, a channel outside the member’s scope, another org and a channel that is not active', async () => {
    const o = await org();
    const y = await youtube(o);
    const w = await wordpress(o);
    for (const connectionId of [y.connectionId, w.connectionId]) {
      await expect(request(o, o.viewer, connectionId)).rejects.toMatchObject({ status: 403 });
      await expect(get(o, o.viewer, connectionId)).rejects.toMatchObject({ status: 403 });
    }
    // The member is limited to the site (#1081).
    await admin((c) => c.query('INSERT INTO crove_social.channel_access (org_id, user_id, channel_connection_id, created_by) VALUES ($1, $2, $3, $4)', [o.orgId, o.member, w.connectionId, o.owner]));
    await expect(request(o, o.member, y.connectionId)).rejects.toMatchObject({ code: 'CHANNEL_NOT_ALLOWED' });
    await expect(get(o, o.member, y.connectionId)).rejects.toMatchObject({ code: 'CHANNEL_NOT_ALLOWED' });
    expect((await request(o, o.member, w.connectionId)).status).toBe('pending');
    const stranger = await org();
    await expect(request(stranger, stranger.owner, y.connectionId)).rejects.toMatchObject({ code: 'CHANNEL_NOT_FOUND' });
    await expect(request(stranger, stranger.owner, w.connectionId)).rejects.toMatchObject({ code: 'CHANNEL_NOT_FOUND' });
    // A site that needs reconnecting: refused to members, and the request already queued is dropped by the worker.
    await admin((c) => c.query("UPDATE crove_kernel.channel_connection SET status = 'expired' WHERE id = $1", [w.connectionId]));
    await expect(request(o, o.owner, w.connectionId)).rejects.toMatchObject({ code: 'CHANNEL_NOT_ACTIVE' });
    const untouched = platform({});
    expect(await job(o, await optionId(o, w.connectionId), { wordpress: new WordPressPublisher(untouched.fetchImpl) })).toBe('none');
    expect(untouched.calls).toEqual([]);
    expect(await events(stranger)).toEqual([]);
  });

  it('lets a member only ask again, keeps a taxonomy on every WordPress term and on no playlist, and knows no other kind', async () => {
    const o = await org();
    const y = await youtube(o);
    const w = await wordpress(o);
    await request(o, o.member, y.connectionId);
    await request(o, o.member, w.connectionId);
    const yId = await optionId(o, y.connectionId);
    const wId = await optionId(o, w.connectionId);
    const answerOnly = /only the worker records an answer; a member may only ask again/;
    const forged = JSON.stringify([{ id: '7', name: 'Giả mạo', taxonomy: 'category' }]);
    await expect(asMember(o, o.owner, "UPDATE crove_social.channel_option SET status = 'ready', items = $2::jsonb, fetched_at = now() WHERE id = $1", [wId, forged])).rejects.toThrow(answerOnly);
    await expect(asMember(o, o.owner, 'UPDATE crove_social.channel_option SET items = $2::jsonb WHERE id = $1', [yId, JSON.stringify([{ id: SALE, name: 'x' }])])).rejects.toThrow(answerOnly);
    await expect(asMember(o, o.owner, "UPDATE crove_social.channel_option SET kind = 'wordpress_term' WHERE id = $1", [yId])).rejects.toThrow(/permission denied/);
    // A new list starts pending with no answer, and its kind is one of the three.
    const other = await youtube(o);
    await expect(
      asMember(o, o.owner, "INSERT INTO crove_social.channel_option (org_id, channel_connection_id, kind, status, items, requested_at, fetched_at) VALUES ($1, $2, 'youtube_playlist', 'ready', $3::jsonb, now(), now())", [o.orgId, other.connectionId, forged]),
    ).rejects.toThrow(/a channel option list starts pending, with no answer/);
    await expect(
      asMember(o, o.owner, "INSERT INTO crove_social.channel_option (org_id, channel_connection_id, kind, status, requested_at) VALUES ($1, $2, 'youtube_video', 'pending', now())", [o.orgId, other.connectionId]),
    ).rejects.toThrow(/channel_option_kind_check/);
    const site = await wordpress(o);
    expect(
      (await asMember(o, o.owner, "INSERT INTO crove_social.channel_option (org_id, channel_connection_id, kind, status, requested_at) VALUES ($1, $2, 'wordpress_term', 'pending', now())", [o.orgId, site.connectionId])).rowCount,
    ).toBe(1);

    // The record command checks each item's taxonomy against the list's kind.
    const record = (id: string, options: unknown[]) => worker.execute('social.channel_option.record', { optionId: id, result: { ok: true, options } }, system(o));
    for (const options of [
      [{ id: '7', name: 'Tin tức' }],
      [{ id: '7', name: 'Tin tức', taxonomy: 'category' }, { id: '8', name: 'bánh mì' }],
      [{ id: '7', name: 'Tin tức', taxonomy: 'topic' }],
      [{ id: '7', name: 'Tin tức', taxonomy: 'category' }, { id: '7', name: 'Tin tức 2', taxonomy: 'category' }],
    ]) {
      await expect(record(wId, options)).rejects.toMatchObject({ status: 422 });
    }
    await expect(record(yId, [{ id: SALE, name: 'Khuyến mãi', taxonomy: 'tag' }])).rejects.toMatchObject({ status: 422 });
    expect((await stored(wId))?.status).toBe('pending');
    expect((await stored(yId))?.status).toBe('pending');
    expect(await record(wId, [{ id: '7', name: 'Tin tức', taxonomy: 'category' }, { id: '7', name: 'bánh mì', taxonomy: 'tag' }])).toEqual({ recorded: true });
    expect(await record(yId, [{ id: SALE, name: 'Khuyến mãi' }])).toEqual({ recorded: true });
    expect((await get(o, o.member, w.connectionId))?.options).toEqual([
      { id: '7', name: 'Tin tức', taxonomy: 'category' },
      { id: '7', name: 'bánh mì', taxonomy: 'tag' },
    ]);
    expect((await get(o, o.member, y.connectionId))?.options).toEqual([{ id: SALE, name: 'Khuyến mãi' }]);
    // A site answer whose items do not fit its kind is recorded as no answer, keeping none.
    const third = await wordpress(o);
    await request(o, o.member, third.connectionId);
    const odd = { options: async () => ({ options: [{ id: '1', name: 'Không có loại' }] }) } as unknown as Publisher;
    expect(await job(o, await optionId(o, third.connectionId), { wordpress: odd })).toBe('failed');
    expect(await get(o, o.member, third.connectionId)).toMatchObject({ status: 'failed', error: 'no_answer', options: [] });
  });

  it('answers no list when a site is too slow, without holding the worker, and asks it nothing more', async () => {
    const o = await org();
    const w = await wordpress(o);
    await request(o, o.member, w.connectionId);
    // A site that answers after ten seconds, whatever the signal says, as a request through the egress guard does.
    const urls: string[] = [];
    const slow: Fetch = async (input) => {
      urls.push(input);
      await new Promise((resolve) => setTimeout(resolve, 10_000));
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const started = Date.now();
    expect(await job(o, await optionId(o, w.connectionId), { wordpress: new WordPressPublisher(slow) }, 300)).toBe('failed');
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(await get(o, o.member, w.connectionId)).toMatchObject({ status: 'failed', error: 'no_answer', options: [] });
    expect(urls).toHaveLength(1);
    // A platform whose request honours the deadline is aborted at it.
    const y = await youtube(o);
    await request(o, o.member, y.connectionId);
    const hanging: Fetch = (_input, init) => new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true }));
    expect(await job(o, await optionId(o, y.connectionId), { youtube: new YouTubePublisher(GOOGLE, hanging) }, 300)).toBe('failed');
    expect(await get(o, o.member, y.connectionId)).toMatchObject({ status: 'failed', error: 'no_answer' });
  });

  it('stores a list of long names cut at the byte cap, and refuses to record one past it', async () => {
    const o = await org();
    const w = await wordpress(o);
    await request(o, o.member, w.connectionId);
    const id = await optionId(o, w.connectionId);
    // Five pages of categories with 200-letter Vietnamese names: 500 of them would pass the CHECK on items.
    const page = (n: number) => Array.from({ length: 100 }, (_, i) => ({ id: n * 100 + i + 1, name: `${'ệ'.repeat(195)} ${n * 100 + i}` }));
    const site = platform({ [`GET ${w.host}/wp-json/wp/v2/categories`]: [0, 1, 2, 3, 4].map((n) => ({ body: page(n) })) });
    expect(await job(o, id, { wordpress: new WordPressPublisher(site.fetchImpl) })).toBe('ready');
    const listed = (await get(o, o.member, w.connectionId))?.options ?? [];
    expect(listed.length).toBeGreaterThan(100);
    expect(listed.length).toBeLessThan(500);
    const bytes = await admin(async (c) => (await c.query<{ n: number }>('SELECT octet_length(items::text) AS n FROM crove_social.channel_option WHERE id = $1', [id])).rows[0]?.n ?? 0);
    expect(bytes).toBeLessThanOrEqual(131_072);
    // The record command refuses a list past the cap with a 422, rather than leaving it to the database.
    await admin((c) => c.query("UPDATE crove_social.channel_option SET status = 'pending', error = NULL, fetched_at = NULL WHERE id = $1", [id]));
    const options = [0, 1, 2, 3, 4].flatMap(page).map((t) => ({ id: String(t.id), name: t.name, taxonomy: 'category' }));
    await expect(worker.execute('social.channel_option.record', { optionId: id, result: { ok: true, options } }, system(o))).rejects.toMatchObject({ status: 422 });
    // The worker cuts what an adapter hands it to the cap before recording.
    const loose = { options: async () => ({ options }) } as unknown as Publisher;
    expect(await job(o, id, { wordpress: loose })).toBe('ready');
    expect((await get(o, o.member, w.connectionId))?.options.length).toBe(listed.length);
  });
});