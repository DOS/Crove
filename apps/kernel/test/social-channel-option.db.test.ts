// A channel's options for the composer on PostgreSQL 17 (#1120): a Pinterest board's sections, asked for by a member,
// read by the worker with the board's sealed token and recorded; only a new request is a member's to write; the
// answer is the worker's; an org's requests are capped per minute; a member limited to some channels asks only for
// those; and publishing lists the board's sections again before it pins. Pinterest answers are recorded shapes from
// the API v5 docs; no live call. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PINTEREST_SCOPES, PinterestPublisher, type Fetch, type Publisher } from '@crove/channel';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { CredentialVault, Runtime, parseVaultKey, type BlobStore } from '@crove/kernel-runtime';
import { CHANNEL_OPTION_PER_MINUTE, runChannelOptionJob, runPublishJob, socialCommands, socialQueries, type ChannelOptionList, type PostView } from '@crove/mod-social';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

const APP = { appId: '1500001', appSecret: 'test-pinterest-secret-not-real' };
const SALE = '5027630990032166911';
const MENU = '5027630990032166912';

type Answer = { status?: number; body?: unknown };
// Pinterest as recorded answers, by method and path; every call is kept.
function pinterest(routes: Record<string, Answer[]>) {
  const calls: { route: string; authorization: string | null; body: unknown }[] = [];
  const fetchImpl: Fetch = async (input, init) => {
    const url = new URL(input);
    const route = `${init?.method ?? 'GET'} ${url.pathname}`;
    const raw = init?.body;
    calls.push({ route, authorization: new Headers(init?.headers).get('authorization'), body: typeof raw === 'string' ? JSON.parse(raw) : null });
    const answer = routes[route]?.shift() ?? { status: 500, body: { code: 1, message: `no answer for ${route}` } };
    return new Response(JSON.stringify(answer.body ?? {}), { status: answer.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
  return { calls, publisher: new PinterestPublisher(APP, fetchImpl) };
}

suite('channel options on PostgreSQL (#1120)', () => {
  const dbName = `crove_test_social_option_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
    const person = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@option.test`, name: null });
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

  // A Pinterest board connected by the org's owner, its token sealed as the OAuth callback seals it.
  async function board(o: Org, provider: 'pinterest' | 'sandbox' = 'pinterest') {
    const boardId = String(549_755_000_000 + Math.floor(Math.random() * 1e6));
    const token = `pina_${randomBytes(12).toString('hex')}`;
    const secret = provider === 'pinterest' ? { accessToken: token, refreshToken: `pinr_${randomBytes(8).toString('hex')}` } : { accessToken: `sbx_${token}` };
    const sealed = vault.seal(JSON.stringify(secret), { orgId: o.orgId, provider, externalAccountId: boardId });
    const { connectionId } = await rt.execute<{ connectionId: string }>(
      'kernel.channel.connect',
      { provider, externalAccountId: boardId, displayName: `Tiệm bánh / ${boardId}`, scopes: provider === 'pinterest' ? [...PINTEREST_SCOPES] : ['publish'], expiresAt: null, credential: { keyId: sealed.keyId, envelope: sealed.envelope.toString('base64') } },
      { actor: asUser(o.owner), orgId: o.orgId },
    );
    return { connectionId, boardId, token };
  }

  const request = (o: Org, user: string, connectionId: string) => rt.execute<ChannelOptionList>('social.channel_option.request', { connectionId }, { actor: asUser(user), orgId: o.orgId });
  const get = (o: Org, user: string, connectionId: string) => rt.query<ChannelOptionList | null>('social.channel_option.get', { connectionId }, { actor: asUser(user), orgId: o.orgId });
  const requests = (o: Org) =>
    admin(async (c) => (await c.query<{ payload: { option_id: string } }>("SELECT payload FROM crove_kernel.outbox_event WHERE org_id = $1 AND type = 'social.channel_option.requested' ORDER BY created_at", [o.orgId])).rows);
  const optionId = async (o: Org, connectionId: string) =>
    admin(async (c) => (await c.query<{ id: string }>('SELECT id FROM crove_social.channel_option WHERE org_id = $1 AND channel_connection_id = $2', [o.orgId, connectionId])).rows[0]?.id as string);
  const job = (o: Org, id: string, publisher: Publisher) => runChannelOptionJob({ runtime: worker, broker: vault, publishers: { pinterest: publisher } }, o.orgId, id);
  const sections = (boardId: string, answers: Answer[]) => pinterest({ [`GET /v5/boards/${boardId}/sections`]: answers });

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

  it("lists a board's sections through the worker with the board's own token, and shows them once read", async () => {
    const o = await org();
    const b = await board(o);
    const first = await request(o, o.member, b.connectionId);
    expect(first).toMatchObject({ connectionId: b.connectionId, kind: 'pinterest_section', status: 'pending', options: [], error: null, fetchedAt: null });
    // Asked again while the worker is on it: the same request, queued once.
    expect((await request(o, o.owner, b.connectionId)).status).toBe('pending');
    const queued = await requests(o);
    expect(queued).toHaveLength(1);
    const id = queued[0]?.payload.option_id as string;
    expect(JSON.stringify(queued)).not.toContain(b.token);
    expect(await get(o, o.member, b.connectionId)).toMatchObject({ status: 'pending', options: [] });

    const platform = sections(b.boardId, [{ body: { items: [{ id: MENU, name: 'Thực đơn' }, { id: SALE, name: 'Khuyến mãi <b>tháng 10</b>' }], bookmark: null } }]);
    expect(await job(o, id, platform.publisher)).toBe('ready');
    expect(platform.calls).toEqual([{ route: `GET /v5/boards/${b.boardId}/sections`, authorization: `Bearer ${b.token}`, body: null }]);
    const ready = await get(o, o.member, b.connectionId);
    expect(ready).toMatchObject({
      status: 'ready',
      error: null,
      options: [
        { id: MENU, name: 'Thực đơn' },
        // Pinterest's text, kept as text; the composer shows it as text.
        { id: SALE, name: 'Khuyến mãi <b>tháng 10</b>' },
      ],
    });
    expect(ready?.fetchedAt).not.toBeNull();
    // A fresh answer is returned as it is: nothing queued again, and the job has nothing left to do.
    expect((await request(o, o.member, b.connectionId)).status).toBe('ready');
    expect(await requests(o)).toHaveLength(1);
    expect(await job(o, id, platform.publisher)).toBe('none');
    const stored = await admin(async (c) => (await c.query('SELECT items::text AS items, error FROM crove_social.channel_option WHERE id = $1', [id])).rows[0]);
    expect(stored.items).not.toContain(b.token);
  });

  it('records why a list could not be read, keeps no options with a failure, and lets a member ask again', async () => {
    const o = await org();
    const b = await board(o);
    const cases: [Answer, string][] = [
      [{ status: 401, body: { code: 2, message: 'Authentication failed.' } }, 'token_expired'],
      [{ status: 403, body: { code: 3, message: 'Not permitted.' } }, 'permission'],
      [{ status: 404, body: { code: 40, message: 'Board not found.' } }, 'not_found'],
      [{ status: 503, body: { code: 1, message: 'Service unavailable' } }, 'no_answer'],
    ];
    for (const [answer, error] of cases) {
      expect((await request(o, o.member, b.connectionId)).status).toBe('pending');
      expect(await job(o, await optionId(o, b.connectionId), sections(b.boardId, [answer]).publisher)).toBe('failed');
      expect(await get(o, o.member, b.connectionId)).toMatchObject({ status: 'failed', error, options: [] });
    }
    expect(await requests(o)).toHaveLength(cases.length);
    // A list read once, then failed: the failure keeps none of the old options.
    await request(o, o.member, b.connectionId);
    await job(o, await optionId(o, b.connectionId), sections(b.boardId, [{ body: { items: [{ id: SALE, name: 'Khuyến mãi' }] } }]).publisher);
    await admin((c) => c.query("UPDATE crove_social.channel_option SET fetched_at = now() - interval '25 hours' WHERE channel_connection_id = $1", [b.connectionId]));
    await request(o, o.member, b.connectionId);
    await job(o, await optionId(o, b.connectionId), sections(b.boardId, [{ status: 500, body: {} }]).publisher);
    const failed = await admin(async (c) => (await c.query('SELECT status, items::text AS items FROM crove_social.channel_option WHERE channel_connection_id = $1', [b.connectionId])).rows[0]);
    expect(failed).toEqual({ status: 'failed', items: '[]' });
    // A credential that no longer opens (dropped since): recorded as refused, nothing asked of Pinterest.
    await request(o, o.member, b.connectionId);
    await admin((c) => c.query('DELETE FROM crove_kernel.credential WHERE connection_id = $1', [b.connectionId]));
    const none = sections(b.boardId, []);
    expect(await job(o, await optionId(o, b.connectionId), none.publisher)).toBe('failed');
    expect(none.calls).toEqual([]);
    expect(await get(o, o.member, b.connectionId)).toMatchObject({ status: 'failed', error: 'permission' });
  });

  it('refuses a viewer, a channel outside the member’s scope, a channel that is not active and one that lists nothing', async () => {
    const o = await org();
    const b = await board(o);
    const other = await board(o);
    await expect(request(o, o.viewer, b.connectionId)).rejects.toMatchObject({ status: 403 });
    await expect(get(o, o.viewer, b.connectionId)).rejects.toMatchObject({ status: 403 });
    // The member is limited to the other board (#1081).
    await admin((c) => c.query('INSERT INTO crove_social.channel_access (org_id, user_id, channel_connection_id, created_by) VALUES ($1, $2, $3, $4)', [o.orgId, o.member, other.connectionId, o.owner]));
    await expect(request(o, o.member, b.connectionId)).rejects.toMatchObject({ code: 'CHANNEL_NOT_ALLOWED' });
    await expect(get(o, o.member, b.connectionId)).rejects.toMatchObject({ code: 'CHANNEL_NOT_ALLOWED' });
    expect((await request(o, o.member, other.connectionId)).status).toBe('pending');
    // Another org's connection is not found.
    const stranger = await org();
    await expect(request(stranger, stranger.owner, b.connectionId)).rejects.toMatchObject({ code: 'CHANNEL_NOT_FOUND' });
    // A connection that needs reconnecting: refused to members, and a request already queued is dropped by the worker.
    await admin((c) => c.query("UPDATE crove_kernel.channel_connection SET status = 'expired' WHERE id = $1", [other.connectionId]));
    await expect(request(o, o.owner, other.connectionId)).rejects.toMatchObject({ code: 'CHANNEL_NOT_ACTIVE' });
    await expect(get(o, o.owner, other.connectionId)).rejects.toMatchObject({ code: 'CHANNEL_NOT_ACTIVE' });
    const untouched = sections(other.boardId, []);
    expect(await job(o, await optionId(o, other.connectionId), untouched.publisher)).toBe('none');
    expect(untouched.calls).toEqual([]);
    const sandbox = await board(o, 'sandbox');
    await expect(request(o, o.owner, sandbox.connectionId)).rejects.toMatchObject({ code: 'CHANNEL_OPTIONS_NOT_OFFERED' });
    expect(await requests(stranger)).toEqual([]);
  });

  it("caps an org's requests a minute, and leaves other orgs alone", async () => {
    const o = await org();
    const boards = [];
    for (let i = 0; i <= CHANNEL_OPTION_PER_MINUTE; i += 1) boards.push(await board(o));
    for (const b of boards.slice(0, CHANNEL_OPTION_PER_MINUTE)) expect((await request(o, o.member, b.connectionId)).status).toBe('pending');
    await expect(request(o, o.member, (boards.at(-1) as { connectionId: string }).connectionId)).rejects.toMatchObject({ code: 'CHANNEL_OPTION_LIMIT', status: 429 });
    const other = await org();
    expect((await request(other, other.member, (await board(other)).connectionId)).status).toBe('pending');
    // A minute later, the budget is back.
    await admin((c) => c.query("UPDATE crove_social.channel_option SET requested_at = requested_at - interval '2 minutes' WHERE org_id = $1", [o.orgId]));
    expect((await request(o, o.member, (boards.at(-1) as { connectionId: string }).connectionId)).status).toBe('pending');
  });

  it('lets a member only ask again: the answer, the options and the list itself are the worker’s', async () => {
    const o = await org();
    const b = await board(o);
    await request(o, o.member, b.connectionId);
    const id = await optionId(o, b.connectionId);
    const forged = JSON.stringify([{ id: SALE, name: 'Giả mạo' }]);
    const answerOnly = /only the worker records an answer; a member may only ask again/;
    await expect(asMember(o, o.owner, "UPDATE crove_social.channel_option SET status = 'ready', items = $2::jsonb, fetched_at = now() WHERE id = $1", [id, forged])).rejects.toThrow(answerOnly);
    await expect(asMember(o, o.owner, 'UPDATE crove_social.channel_option SET items = $2::jsonb WHERE id = $1', [id, forged])).rejects.toThrow(answerOnly);
    await expect(asMember(o, o.owner, "UPDATE crove_social.channel_option SET status = 'failed', error = 'no_answer', fetched_at = now() WHERE id = $1", [id])).rejects.toThrow(answerOnly);
    await expect(asMember(o, o.owner, "UPDATE crove_social.channel_option SET requested_at = requested_at - interval '1 minute' WHERE id = $1", [id])).rejects.toThrow(answerOnly);
    // Asking again, and an update that changes nothing, pass.
    expect((await asMember(o, o.owner, "UPDATE crove_social.channel_option SET status = 'pending', error = NULL, requested_at = requested_at + interval '1 second' WHERE id = $1", [id])).rowCount).toBe(1);
    expect((await asMember(o, o.owner, 'UPDATE crove_social.channel_option SET status = status WHERE id = $1', [id])).rowCount).toBe(1);
    // The list's org, connection and kind are not a member's to change, and nobody deletes a list.
    await expect(asMember(o, o.owner, 'UPDATE crove_social.channel_option SET channel_connection_id = channel_connection_id WHERE id = $1', [id])).rejects.toThrow(/permission denied/);
    await expect(asMember(o, o.owner, 'DELETE FROM crove_social.channel_option WHERE id = $1', [id])).rejects.toThrow(/permission denied/);
    // A new list starts pending with no answer; another org's row is refused by row-level security.
    const other = await board(o);
    await expect(
      asMember(o, o.owner, "INSERT INTO crove_social.channel_option (org_id, channel_connection_id, kind, status, items, requested_at, fetched_at) VALUES ($1, $2, 'pinterest_section', 'ready', $3::jsonb, now(), now())", [o.orgId, other.connectionId, forged]),
    ).rejects.toThrow(/a channel option list starts pending, with no answer/);
    const stranger = await org();
    await expect(
      asMember(o, o.owner, "INSERT INTO crove_social.channel_option (org_id, channel_connection_id, kind, status, requested_at) VALUES ($1, $2, 'pinterest_section', 'pending', now())", [stranger.orgId, other.connectionId]),
    ).rejects.toThrow(/row-level security/);
    // Even outside any context, a failed answer keeps no options.
    await expect(admin((c) => c.query("UPDATE crove_social.channel_option SET status = 'failed', error = 'no_answer', fetched_at = now(), items = $2::jsonb WHERE id = $1", [id, forged]))).rejects.toThrow(/a failed answer keeps no options/);

    // The record command is the worker's alone, records only a list still pending, and checks what it keeps.
    const result = { ok: true, options: [{ id: SALE, name: 'Khuyến mãi' }] };
    await expect(rt.execute('social.channel_option.record', { optionId: id, result }, { actor: asUser(o.owner), orgId: o.orgId })).rejects.toMatchObject({ status: 403 });
    const system = { actor: { type: 'system' as const, component: 'channel-option-test' }, orgId: o.orgId };
    for (const options of [
      [{ id: SALE, name: 'a' }, { id: SALE, name: 'b' }],
      [{ id: SALE, name: 'Khuyến​ mãi' }],
      [{ id: SALE, name: ' padded ' }],
      [{ id: 'bad id', name: 'x' }],
      Array.from({ length: 501 }, (_, i) => ({ id: String(i + 1), name: `S${i}` })),
    ]) {
      await expect(worker.execute('social.channel_option.record', { optionId: id, result: { ok: true, options } }, system)).rejects.toMatchObject({ status: 422 });
    }
    expect(await worker.execute('social.channel_option.record', { optionId: id, result }, system)).toEqual({ recorded: true });
    expect(await worker.execute('social.channel_option.record', { optionId: id, result: { ok: false, error: 'no_answer' } }, system)).toEqual({ recorded: false });
    expect(await get(o, o.member, b.connectionId)).toMatchObject({ status: 'ready', options: [{ id: SALE, name: 'Khuyến mãi' }] });
  });

  describe('publishing into a section (#1120)', () => {
    // Each pin's own image bytes, by storage key.
    const blobs = new Map<string, Uint8Array>();
    const store = { get: async (key: string) => blobs.get(key) } as unknown as BlobStore;

    // A pin with one image into this section, approved and due on a fresh board.
    async function duePin(o: Org, settings: Record<string, unknown>) {
      const b = await board(o);
      const fileId = randomUUID();
      const bytes = new Uint8Array(Buffer.from(`fake-jpeg-${fileId}`));
      const sha = createHash('sha256').update(bytes).digest('hex');
      blobs.set(`org/${o.orgId}/${sha}`, bytes);
      await admin((c) =>
        c.query(
          `INSERT INTO crove_kernel.file (org_id, id, sha256, storage_key, generation, filename, content_type, size_bytes, source)
           VALUES ($1, $2, $3, $4, $5, 'banh.jpg', 'image/jpeg', $6, 'social')`,
          [o.orgId, fileId, sha, `org/${o.orgId}/${sha}`, `content:${sha}`, bytes.byteLength],
        ),
      );
      const exec = <T>(name: string, input: unknown) => rt.execute<T>(name, input, { actor: asUser(o.owner), orgId: o.orgId });
      const { postId } = await exec<{ postId: string }>('social.post.create', { body: 'Bánh mì mới ra lò', title: 'Thực đơn', media: [{ fileId }], channels: [{ connectionId: b.connectionId, settings }] });
      await exec('social.post.submit', { postId });
      const post = await rt.query<PostView>('social.post.get', { postId }, { actor: asUser(o.owner), orgId: o.orgId });
      await exec('social.variant.decide', { postId, decision: 'approved', variants: post.variants.map((v) => ({ variantId: v.id, revision: v.revision, contentHash: v.contentHash })) });
      await exec('social.variant.schedule', { postId, at: new Date(Date.now() + 3_600_000).toISOString() });
      await admin((c) => c.query("UPDATE crove_social.post_variant SET scheduled_at = now() - interval '1 second' WHERE post_id = $1", [postId]));
      return { ...b, postId, variantId: post.variants[0]?.id as string };
    }
    const publish = (o: Org, variantId: string, publisher: Publisher) => runPublishJob({ runtime: worker, broker: vault, publishers: { pinterest: publisher }, store, callTimeoutMs: 2_000 }, o.orgId, variantId, 'pinterest');
    const variantOf = async (o: Org, postId: string) => (await rt.query<PostView>('social.post.get', { postId }, { actor: asUser(o.owner), orgId: o.orgId })).variants[0];

    it('lists the board sections again and pins into the chosen one', async () => {
      const o = await org();
      const p = await duePin(o, { pinterest: { sectionId: SALE } });
      const platform = pinterest({
        [`GET /v5/boards/${p.boardId}/sections`]: [{ body: { items: [{ id: MENU, name: 'Thực đơn' }, { id: SALE, name: 'Khuyến mãi' }], bookmark: null } }],
        'POST /v5/pins': [{ status: 201, body: { id: '813744226420795884' } }],
      });
      expect(await publish(o, p.variantId, platform.publisher)).toEqual({ action: 'call', status: 'published' });
      expect(platform.calls.map((c) => c.route)).toEqual([`GET /v5/boards/${p.boardId}/sections`, 'POST /v5/pins']);
      expect(platform.calls[1]?.body).toMatchObject({ board_id: p.boardId, board_section_id: SALE });
    });

    it('pins nothing into a section the board no longer has, and tries again later when the list does not come', async () => {
      const o = await org();
      const gone = await duePin(o, { pinterest: { sectionId: SALE } });
      const without = pinterest({ [`GET /v5/boards/${gone.boardId}/sections`]: [{ body: { items: [{ id: MENU, name: 'Thực đơn' }], bookmark: null } }] });
      expect(await publish(o, gone.variantId, without.publisher)).toEqual({ action: 'call', status: 'failed' });
      expect(without.calls.map((c) => c.route)).toEqual([`GET /v5/boards/${gone.boardId}/sections`]);
      expect((await variantOf(o, gone.postId))?.error).toMatchObject({ kind: 'bad_request', code: 'PINTEREST_SECTION_NOT_FOUND' });

      const later = await duePin(o, { pinterest: { sectionId: SALE } });
      const down = pinterest({ [`GET /v5/boards/${later.boardId}/sections`]: [{ status: 503, body: { code: 1, message: 'down' } }] });
      const outcome = await publish(o, later.variantId, down.publisher);
      expect(down.calls.some((c) => c.route === 'POST /v5/pins')).toBe(false);
      const v = await variantOf(o, later.postId);
      expect(outcome.status).not.toBe('published');
      expect(v?.status).not.toBe('failed');
      expect(v?.error).toMatchObject({ kind: 'transient', code: 'PINTEREST_SECTIONS_UNREADABLE' });
    });

    it('sends a pin without a section exactly as before', async () => {
      const o = await org();
      const p = await duePin(o, {});
      const platform = pinterest({ 'POST /v5/pins': [{ status: 201, body: { id: '813744226420795885' } }] });
      expect(await publish(o, p.variantId, platform.publisher)).toEqual({ action: 'call', status: 'published' });
      expect(platform.calls.map((c) => c.route)).toEqual(['POST /v5/pins']);
      expect(Object.keys(platform.calls[0]?.body as object)).not.toContain('board_section_id');
    });
  });
});
