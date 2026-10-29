// TikTok posts that get their public id later, on PostgreSQL 17 (#1475), against recorded TikTok answers: a public post
// known by its publish_id gets its numeric id and address on a later sweep and the metrics sweep then reads its counts;
// an inbox draft the creator posts becomes a post and loses its SENT_TO_APP note; a SELF_ONLY post is never asked about;
// the asking stops after 7 days; a refused token marks the connection expired; the scan is the worker's alone and lists
// nothing of an inactive org or channel. Only status reads go out: no publish and no new call on the ledger. Set
// CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { CredentialVault, Runtime, parseVaultKey } from '@crove/kernel-runtime';
import { TikTokPublisher, type Fetch } from '@crove/channel';
import { publishCallKey, socialCommands, socialQueries, sweepLateIds, sweepMetrics } from '@crove/mod-social';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const APP = { clientKey: 'awtestclientkey01', clientSecret: 'test-tiktok-secret-not-real', videoList: true };
const STATUS = 'POST open.tiktokapis.com/v2/post/publish/status/fetch/';
const QUERY = 'POST open.tiktokapis.com/v2/video/query/';
const ok = { code: 'ok', message: '', log_id: 'log-1' };

// TikTok answering from recorded answers per route, keeping every call it was asked.
type Answer = { status?: number; body?: unknown; raw?: string };
function tiktok() {
  const routes: Record<string, Answer[]> = {};
  const calls: { route: string; body: unknown }[] = [];
  const fetchImpl: Fetch = async (input, init) => {
    const url = new URL(input);
    const route = `${init?.method ?? 'GET'} ${url.host}${url.pathname}`;
    calls.push({ route, body: typeof init?.body === 'string' ? JSON.parse(init.body) : null });
    const answer = routes[route]?.shift() ?? { status: 500, body: { error: { code: 'internal_error', message: `no answer for ${route}` } } };
    return new Response(answer.raw ?? JSON.stringify(answer.body ?? {}), { status: answer.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
  const answer = (route: string, ...answers: Answer[]) => (routes[route] = [...(routes[route] ?? []), ...answers]);
  return { calls, answer, publisher: new TikTokPublisher(APP, fetchImpl) };
}
const complete = (id: string): Answer => ({ raw: `{"data":{"status":"PUBLISH_COMPLETE","publicaly_available_post_id":[${id}]},"error":{"code":"ok"}}` });
const status = (s: string): Answer => ({ body: { data: { status: s }, error: ok } });

type Org = { orgId: string; owner: string };
interface Row {
  status: string;
  external_post_id: string | null;
  external_url: string | null;
  error_code: string | null;
  next_check_at: Date | null;
}

suite('TikTok late post ids (#1475)', () => {
  const dbName = `crove_test_social_late_ids_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appPool: pg.Pool;
  let workerPool: pg.Pool;
  let appDb: Db;
  let workerDb: Db;
  let api: Runtime;
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

  async function org(): Promise<Org> {
    const owner = await upsertIdentity(appDb, { issuer: 'test', subject: randomUUID(), email: `owner-${randomUUID().slice(0, 8)}@late-ids.test`, name: null });
    const { orgId } = await createOrg(api, asUser(owner), `Tiệm ${randomUUID().slice(0, 6)}`);
    return { orgId, owner };
  }

  async function connect(o: Org, scopes = ['user.info.basic', 'video.publish', 'video.list']) {
    const account = `open-${randomUUID().slice(0, 8)}`;
    const sealed = vault.seal(JSON.stringify({ accessToken: 'act.late-ids', refreshToken: 'rft.late-ids' }), { orgId: o.orgId, provider: 'tiktok', externalAccountId: account });
    const { connectionId } = await api.execute<{ connectionId: string }>(
      'kernel.channel.connect',
      { provider: 'tiktok', externalAccountId: account, displayName: 'Tiệm Bánh B', scopes, expiresAt: null, credential: { keyId: sealed.keyId, envelope: sealed.envelope.toString('base64') } },
      { actor: asUser(o.owner), orgId: o.orgId },
    );
    return connectionId;
  }

  // A TikTok post Crove published some hours ago: known by its publish_id (a direct post whose id has not come), or a
  // draft in the creator's inbox (no post id, the SENT_TO_APP note, the publish_id on its publish call).
  async function published(o: Org, conn: string, kind: { inbox: true } | { privacy: string }, hoursAgo = 2) {
    const publishId = `v_pub_file~v2-1.${randomUUID().slice(0, 8)}`;
    const { postId } = await api.execute<{ postId: string }>('social.post.create', { body: 'Khai trương #banh', channels: [{ connectionId: conn }] }, { actor: asUser(o.owner), orgId: o.orgId });
    const inbox = 'inbox' in kind;
    const settings = inbox ? { tiktokMode: 'inbox' } : { privacyLevel: kind.privacy };
    const v = await admin(async (c) => {
      const { rows } = await c.query<{ id: string; revision: number; attempt: number }>(
        `UPDATE crove_social.post_variant SET status = 'published', settings = $2, published_at = now() - make_interval(secs => $3), external_post_id = $4, error_code = $5
         WHERE post_id = $1 RETURNING id, revision, attempt`,
        [postId, JSON.stringify(settings), hoursAgo * 3600, inbox ? null : publishId, inbox ? 'SENT_TO_APP' : null],
      );
      const row = rows[0] as { id: string; revision: number; attempt: number };
      const key = publishCallKey(row.id, row.revision, row.attempt, 'publish');
      await c.query("INSERT INTO crove_kernel.external_call (org_id, key, module, target, step, retry_safety) VALUES ($1, $2, 'social', 'tiktok', 'publish', 'never')", [o.orgId, key]);
      await c.query("UPDATE crove_kernel.external_call SET state = 'succeeded', external_ref = $3, finished_at = now() WHERE org_id = $1 AND key = $2", [o.orgId, key, publishId]);
      return row;
    });
    return { postId, id: v.id, publishId };
  }

  const row = (id: string) =>
    admin(async (c) => (await c.query<Row>('SELECT status, external_post_id, external_url, error_code, next_check_at FROM crove_social.post_variant WHERE id = $1', [id])).rows[0] as Row);
  const due = async (o: Org) => (await workerPool.query<{ variant_id: string }>('SELECT variant_id FROM crove_social.late_id_due(500) WHERE org_id = $1', [o.orgId])).rows.map((r) => r.variant_id);
  const checkNow = (id: string) => admin((c) => c.query("UPDATE crove_social.post_variant SET next_check_at = now() - interval '1 second' WHERE id = $1", [id]));
  const ledger = (o: Org) => admin(async (c) => Number((await c.query<{ n: string }>('SELECT count(*) AS n FROM crove_kernel.external_call WHERE org_id = $1', [o.orgId])).rows[0]?.n));
  const sweep = (t: ReturnType<typeof tiktok>) => sweepLateIds({ runtime: worker, broker: vault, workerDb, publishers: { tiktok: t.publisher } });
  const timeline = (o: Org, postId: string) => api.query<{ items: Array<{ kind: string; code: string | null; url: string | null }> }>('social.post.activity', { postId }, { actor: asUser(o.owner), orgId: o.orgId });

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
    appPool = createPool({ connectionString: as('crove_app', 'test-app-pw'), max: 4 });
    workerPool = createPool({ connectionString: as('crove_worker', 'test-worker-pw'), max: 4 });
    appDb = createDb(appPool);
    workerDb = createDb(workerPool);
    const registry = { commands: [...kernelCommands, ...socialCommands], queries: [...kernelQueries({ inboundDomain: null }), ...socialQueries] };
    api = new Runtime(appDb, { manifests: TEST_MANIFESTS }).register(registry);
    worker = new Runtime(workerDb, { manifests: TEST_MANIFESTS }).register(registry);
  });

  afterAll(async () => {
    await appPool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('gives a public post its numeric id and address on a later sweep, and the metrics sweep then reads its counts', async () => {
    const o = await org();
    const conn = await connect(o);
    const { id, postId, publishId } = await published(o, conn, { privacy: 'PUBLIC_TO_EVERYONE' });
    const calls = await ledger(o);
    expect(await due(o)).toEqual([id]);

    // Still in moderation: asked again in an hour, on its first day.
    const t = tiktok();
    t.answer(STATUS, status('PUBLISH_COMPLETE'));
    await sweep(t);
    const waiting = await row(id);
    expect([waiting.external_post_id, waiting.error_code]).toEqual([publishId, null]);
    const inAnHour = (waiting.next_check_at?.getTime() ?? 0) - Date.now();
    expect(inAnHour).toBeGreaterThan(55 * 60_000);
    expect(inAnHour).toBeLessThanOrEqual(3_600_000);
    expect(await due(o)).toEqual([]);

    // Moderation passed: the id as TikTok wrote it, and the address video/query gives.
    await checkNow(id);
    t.answer(STATUS, complete('7300000000000000001'));
    t.answer(QUERY, { body: { data: { videos: [{ id: '7300000000000000001', share_url: 'https://www.tiktok.com/@tiembanhb/video/7300000000000000001' }] }, error: ok } });
    expect(await sweep(t)).toMatchObject({ checked: 1, settled: 1 });
    expect(await row(id)).toMatchObject({ status: 'published', external_post_id: '7300000000000000001', external_url: 'https://www.tiktok.com/@tiembanhb/video/7300000000000000001', error_code: null, next_check_at: null });
    expect(t.calls.map((c) => c.route)).toEqual([STATUS, STATUS, QUERY]);
    expect(t.calls[1]?.body).toEqual({ publish_id: publishId });
    expect(await due(o)).toEqual([]);
    // Only reads went out: no new call on the ledger.
    expect(await ledger(o)).toBe(calls);
    const events = await admin(async (c) => (await c.query<{ type: string }>("SELECT type FROM crove_kernel.outbox_event WHERE org_id = $1 AND type LIKE 'social.variant.%late%'", [o.orgId])).rows);
    expect(events.map((e) => e.type)).toEqual(['social.variant.published_late']);
    expect((await timeline(o, postId)).items.find((i) => i.kind === 'published')).toMatchObject({ code: null, url: 'https://www.tiktok.com/@tiembanhb/video/7300000000000000001' });

    // The metrics sweep now reads its counts by that id.
    t.answer(QUERY, { body: { data: { videos: [{ id: '7300000000000000001', view_count: 1200, like_count: 80, comment_count: 6, share_count: 3 }] }, error: ok } });
    await sweepMetrics({ runtime: worker, broker: vault, workerDb, publishers: { tiktok: t.publisher } });
    expect(t.calls.at(-1)).toMatchObject({ route: QUERY, body: { filters: { video_ids: ['7300000000000000001'] } } });
    const snapshot = await admin(async (c) => (await c.query<{ metrics: Record<string, number> }>('SELECT metrics FROM crove_social.metric_snapshot WHERE variant_id = $1', [id])).rows);
    expect(snapshot.map((s) => s.metrics)).toEqual([{ views: 1200, reactions: 80, comments: 6, shares: 3 }]);
  });

  it('makes an inbox draft the creator posts a post with its id, without its SENT_TO_APP note', async () => {
    const o = await org();
    const conn = await connect(o, ['user.info.basic', 'video.publish', 'video.upload']);
    const { id, postId, publishId } = await published(o, conn, { inbox: true });
    expect(await due(o)).toEqual([id]);
    const t = tiktok();
    // Still in the inbox: it keeps its note.
    t.answer(STATUS, status('SEND_TO_USER_INBOX'));
    await sweep(t);
    expect(await row(id)).toMatchObject({ external_post_id: null, error_code: 'SENT_TO_APP' });
    expect(t.calls[0]?.body).toEqual({ publish_id: publishId });

    // Posted in TikTok, its id still in moderation: the note goes, and it is known by its publish_id meanwhile.
    await checkNow(id);
    t.answer(STATUS, status('PUBLISH_COMPLETE'));
    await sweep(t);
    expect(await row(id)).toMatchObject({ external_post_id: publishId, external_url: null, error_code: null });
    expect((await timeline(o, postId)).items.find((i) => i.kind === 'published')).toMatchObject({ code: 'POSTED_IN_APP' });

    // Then the id, the first of the posts the creator made from the draft; no address without video.list.
    await checkNow(id);
    t.answer(STATUS, complete('7300000000000000002, 7300000000000000003'));
    await sweep(t);
    expect(await row(id)).toMatchObject({ status: 'published', external_post_id: '7300000000000000002', external_url: null, error_code: null, next_check_at: null });
    expect(t.calls.map((c) => c.route)).toEqual([STATUS, STATUS, STATUS]);
    expect(await due(o)).toEqual([]);
  });

  it('never asks about a private or friends-only post', async () => {
    const o = await org();
    const conn = await connect(o);
    await published(o, conn, { privacy: 'SELF_ONLY' });
    await published(o, conn, { privacy: 'FOLLOWER_OF_CREATOR' });
    expect(await due(o)).toEqual([]);
    const t = tiktok();
    await sweep(t);
    expect(t.calls).toEqual([]);
  });

  it('stops asking after 7 days: a public post says TikTok gave no id, a draft never posted keeps its note', async () => {
    const o = await org();
    const conn = await connect(o, ['user.info.basic', 'video.publish', 'video.upload']);
    const pub = await published(o, conn, { privacy: 'PUBLIC_TO_EVERYONE' }, 7 * 24 + 1);
    const draft = await published(o, conn, { inbox: true }, 7 * 24 + 1);
    const old = await published(o, conn, { privacy: 'PUBLIC_TO_EVERYONE' }, 9 * 24);
    expect((await due(o)).sort()).toEqual([pub.id, draft.id].sort());
    const t = tiktok();
    await sweep(t);
    // Nothing asked of TikTok past the 7 days.
    expect(t.calls).toEqual([]);
    expect(await row(pub.id)).toMatchObject({ external_post_id: pub.publishId, error_code: 'TIKTOK_NO_POST_ID', next_check_at: null });
    expect(await row(draft.id)).toMatchObject({ external_post_id: null, error_code: 'SENT_TO_APP' });
    expect(await row(old.id)).toMatchObject({ error_code: null, next_check_at: null });
    expect(await due(o)).toEqual([]);
    expect((await timeline(o, pub.postId)).items.find((i) => i.kind === 'published')).toMatchObject({ code: 'TIKTOK_NO_POST_ID', url: null });
  });

  it('stops on FAILED: the public post gets its note, the draft keeps its own', async () => {
    const o = await org();
    const conn = await connect(o, ['user.info.basic', 'video.publish', 'video.upload']);
    const pub = await published(o, conn, { privacy: 'PUBLIC_TO_EVERYONE' });
    const t = tiktok();
    t.answer(STATUS, { body: { data: { status: 'FAILED', fail_reason: 'publish_cancelled' }, error: ok } });
    await sweep(t);
    expect(await row(pub.id)).toMatchObject({ error_code: 'TIKTOK_NO_POST_ID', next_check_at: null });
    const draft = await published(o, conn, { inbox: true });
    t.answer(STATUS, { status: 400, body: { error: { code: 'invalid_publish_id', message: 'The publish_id does not exist.' } } });
    await sweep(t);
    const kept = await row(draft.id);
    expect(kept.error_code).toBe('SENT_TO_APP');
    expect(kept.next_check_at?.getTime()).toBeGreaterThan(Date.now() + 8 * 86_400_000);
    expect(await due(o)).toEqual([]);
  });

  it('marks the connection expired when TikTok refuses its token, and asks again later', async () => {
    const o = await org();
    const conn = await connect(o);
    const { id } = await published(o, conn, { privacy: 'PUBLIC_TO_EVERYONE' });
    const t = tiktok();
    t.answer(STATUS, { status: 401, body: { error: { code: 'access_token_invalid', message: 'The access token is invalid.' } } });
    expect(await sweep(t)).toMatchObject({ expired: 1 });
    const connection = await admin(async (c) => (await c.query<{ status: string }>('SELECT status FROM crove_kernel.channel_connection WHERE id = $1', [conn])).rows[0]);
    expect(connection?.status).toBe('expired');
    const kept = await row(id);
    expect([kept.error_code, kept.next_check_at === null]).toEqual([null, false]);
    // An expired channel is not asked about until it is reconnected.
    await checkNow(id);
    expect(await due(o)).toEqual([]);
  });

  it('keeps the scan to the worker, and lists nothing of an inactive org or channel', async () => {
    await expect(appPool.query('SELECT * FROM crove_social.late_id_due(10)')).rejects.toMatchObject({ code: '42501' });
    await expect(
      admin(async (c) => {
        await c.query('BEGIN');
        try {
          await c.query('SET LOCAL ROLE crove_tenant');
          return await c.query('SELECT * FROM crove_social.late_id_due(10)');
        } finally {
          await c.query('ROLLBACK');
        }
      }),
    ).rejects.toMatchObject({ code: '42501' });

    const closing = await org();
    const a = await published(closing, await connect(closing), { privacy: 'PUBLIC_TO_EVERYONE' });
    expect(await due(closing)).toEqual([a.id]);
    await admin((c) => c.query("UPDATE crove_kernel.tenant SET status = 'closed' WHERE org_id = $1", [closing.orgId]));
    expect(await due(closing)).toEqual([]);

    const o = await org();
    const conn = await connect(o);
    const b = await published(o, conn, { privacy: 'PUBLIC_TO_EVERYONE' });
    expect(await due(o)).toEqual([b.id]);
    await admin((c) => c.query("UPDATE crove_kernel.channel_connection SET status = 'revoked' WHERE id = $1", [conn]));
    expect(await due(o)).toEqual([]);
  });
});
