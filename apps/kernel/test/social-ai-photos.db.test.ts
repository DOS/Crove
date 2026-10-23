// AI drafts written from the post's photos through the API (#1191): two library photos and no brief give a tainted
// draft that carries both photos, one variant per chosen channel, with the exact stored bytes sent to a recorded model;
// a viewer, a server without AI or without a vision model, a channel outside a limited member's, another org's file,
// an accounting document, a video, an image too large, a hidden channel's own media and an object larger than its file
// row records are refused before the model is asked, in that order; and the call counts once against the drafts
// budget whatever the number of photos. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { kernelCommands, kernelQueries } from '@crove/kernel';
import { AI_DRAFT_IMAGES_MAX, AI_IMAGE_MAX_BYTES } from '@crove/kernel-contract';
import { socialCommands, socialQueries } from '@crove/mod-social';
import { CredentialVault, LocalDiskStore, Runtime, fileKey, parseVaultKey, putFile } from '@crove/kernel-runtime';
import { ALT_TEXT_IMAGE_MAX_BYTES, DRAFT_IMAGES_MAX, SocialWriter, type DraftGenerator } from '@crove/agent';
import { createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { socialDrafter } from '../src/kernel.ts';
import { createSessionStatusSource } from '../src/sessions.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const SECRET = 'test-only-jwt-secret-for-ai-photos-0123456789';
const ISSUER = 'crove-auth';
const suite = ADMIN ? describe : describe.skip;

interface Account {
  subject: string;
  email: string;
  session: string;
  userId: string;
}

suite('AI drafts from the post photos through the API (#1191)', () => {
  const dbName = `crove_test_social_ai_photos_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let dir = '';
  let apps: Record<'on' | 'noVision' | 'noAi' | 'failing' | 'budget', ReturnType<typeof createHttpApp>>;
  // The model's answers, recorded: what it was sent, and the draft it gave.
  const asked: Parameters<DraftGenerator>[0][] = [];
  let answer: Awaited<ReturnType<DraftGenerator>> = { body: 'Bánh mì nóng giòn vừa ra lò, ghé tiệm sáng nay nhé!', title: null, variants: [] };
  const generate: DraftGenerator = async (args) => {
    asked.push(args);
    return answer;
  };
  const owner: Account = { subject: randomUUID(), email: 'owner@ai-photos.test', session: randomUUID(), userId: '' };
  const viewer: Account = { subject: randomUUID(), email: 'viewer@ai-photos.test', session: randomUUID(), userId: '' };
  const member: Account = { subject: randomUUID(), email: 'member@ai-photos.test', session: randomUUID(), userId: '' };
  const other: Account = { subject: randomUUID(), email: 'other@ai-photos.test', session: randomUUID(), userId: '' };
  let org = { slug: '', orgId: '' };
  let otherOrg = { slug: '', orgId: '' };
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new TextEncoder().encode('a test jpeg of a bánh mì')]);
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, ...new TextEncoder().encode('a test png of the shop front')]);
  let files: { jpeg: string; png: string; video: string; document: string; large: string; foreign: string; hiddenOwn: string; hiddenShared: string; mineOwn: string };
  // mine: the channel the limited member may use; hidden: one they may not.
  let channels: { mine: string; hidden: string };

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  async function tokenFor(who: Account) {
    return new SignJWT({ role: 'authenticated', email: who.email, session_id: who.session, aal: 'aal1', is_anonymous: false })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(who.subject)
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(new TextEncoder().encode(SECRET));
  }

  async function rpc(path: string, token: string, input: unknown, options: { slug?: string | null; app?: keyof typeof apps } = {}) {
    const slug = options.slug === undefined ? org.slug : options.slug;
    const response = await apps[options.app ?? 'on'].request(`/api/rpc/${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(slug ? { 'x-crove-org': slug } : {}) },
      body: JSON.stringify(input === undefined ? {} : { json: input }),
    });
    const body = (await response.json().catch(() => null)) as ({ json?: unknown } & Record<string, unknown>) | null;
    return { status: response.status, body: (body && 'json' in body ? body.json : body) as any };
  }

  // A file row as the upload route records it; with bytes, they are stored under its key as uploads store them.
  async function file(orgId: string, options: { source?: string; contentType?: string; bytes?: Uint8Array; sizeBytes?: number } = {}) {
    const id = randomUUID();
    const bytes = options.bytes ?? new TextEncoder().encode(id);
    const sha = createHash('sha256').update(bytes).digest('hex');
    const key = fileKey(orgId, sha);
    const generation = options.bytes ? await putFile(new LocalDiskStore(dir), key, bytes, options.contentType ?? 'image/jpeg', sha) : `content:${sha}`;
    await admin((c) =>
      c.query(
        `INSERT INTO crove_kernel.file (org_id, id, sha256, storage_key, generation, filename, content_type, size_bytes, source)
         VALUES ($1, $2, $3, $4, $5, 'banh-mi.jpg', $6, $7, $8)`,
        [orgId, id, sha, key, generation, options.contentType ?? 'image/jpeg', options.sizeBytes ?? bytes.byteLength, options.source ?? 'social'],
      ),
    );
    return id;
  }

  async function joinAs(who: Account, role: 'member' | 'viewer') {
    await admin((c) => c.query('INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, $3)', [org.orgId, who.userId, role]));
  }

  async function newAccount(name: string): Promise<Account> {
    const who: Account = { subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@ai-photos.test`, session: randomUUID(), userId: '' };
    who.userId = String((await rpc('me/get', await tokenFor(who), undefined, { slug: null })).body?.userId);
    return who;
  }

  // Every row of every Crove table, hashed by table: a refused call must leave all of them as they were. The callers'
  // own account rows are left out: signing in keeps them up to date, whatever the route does.
  async function snapshot(): Promise<Record<string, string>> {
    return admin(async (c) => {
      const { rows: tables } = await c.query<{ name: string }>(
        `SELECT format('%I.%I', schemaname, tablename) AS name FROM pg_catalog.pg_tables WHERE schemaname LIKE 'crove\\_%' AND tablename <> 'user_account' ORDER BY 1`,
      );
      const hashes: Record<string, string> = {};
      for (const t of tables) {
        const { rows } = await c.query<{ h: string | null; n: string }>(`SELECT md5(string_agg(r::text, ',' ORDER BY r::text)) AS h, count(*) AS n FROM ${t.name} r`);
        hashes[t.name] = `${rows[0]?.n ?? 0}:${rows[0]?.h ?? ''}`;
      }
      return hashes;
    });
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
    const appUrl = new URL(adminUrl);
    appUrl.username = 'crove_app';
    appUrl.password = 'test-app-pw';
    pool = createPool({ connectionString: appUrl.toString(), max: 4 });
    db = createDb(pool);
    dir = await mkdtemp(join(tmpdir(), 'crove-ai-photos-'));
    const store = new LocalDiskStore(dir);
    const kernel = { commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) };
    const runtime = new Runtime(db, { sessions: createSessionStatusSource('off'), stepUp: 'required' }).register({
      commands: [...kernel.commands, ...socialCommands],
      queries: [...kernel.queries, ...socialQueries],
    });
    const config = loadConfig({
      DATABASE_URL: appUrl.toString(),
      AUTH_JWT_SECRET: SECRET,
      AUTH_ISSUER: ISSUER,
      AUTH_SESSION_CHECK: 'off',
      MIGRATIONS_DIR: MIGRATIONS,
      WEB_DIST: '/nonexistent',
    });
    // The writer as the kernel wires it, with the recorded model in place of the endpoint: with a vision model the
    // photos are read from the store; without one (AI_VISION off) there is no way to draft from them.
    const writer = new SocialWriter({ baseURL: 'http://localhost:1/v1', apiKey: null, model: 'test' }, generate);
    const vault = new CredentialVault([parseVaultKey(randomBytes(32).toString('base64'))]);
    // Each app has its own drafts budget, so the budget test counts only its own calls.
    const make = (socialWriter?: ReturnType<typeof socialDrafter>) =>
      createHttpApp({ config, runtime, store, authenticate: createAuthenticator(config, db), pool, aiEnabled: true, channels: { broker: vault, sandbox: true }, ...(socialWriter ? { socialWriter } : {}) });
    const failing = {
      ...socialDrafter(writer, store),
      draftStored: async () => {
        throw new Error('the model did not answer');
      },
    };
    apps = { on: make(socialDrafter(writer, store)), noVision: make(socialDrafter(writer, null)), noAi: make(), failing: make(failing), budget: make(socialDrafter(writer, store)) };

    for (const who of [owner, viewer, member, other]) {
      const me = await rpc('me/get', await tokenFor(who), undefined, { slug: null });
      expect(me.status).toBe(200);
      who.userId = String(me.body?.userId);
    }
    const created = await rpc('org/create', await tokenFor(owner), { name: 'Tiệm bánh mì', idempotencyKey: randomUUID() }, { slug: null });
    expect(created.status).toBe(200);
    org = { slug: String(created.body?.slug), orgId: String(created.body?.orgId) };
    const second = await rpc('org/create', await tokenFor(other), { name: 'Tiệm khác', idempotencyKey: randomUUID() }, { slug: null });
    expect(second.status).toBe(200);
    otherOrg = { slug: String(second.body?.slug), orgId: String(second.body?.orgId) };
    await joinAs(viewer, 'viewer');
    await joinAs(member, 'member');
    const ownerToken = await tokenFor(owner);
    const connect = async (displayName: string) => String((await rpc('channels/connectSandbox', ownerToken, { displayName, key: randomUUID() })).body?.connectionId);
    channels = { mine: await connect('Trang của bạn'), hidden: await connect('Trang khác') };
    await admin((c) =>
      c.query('INSERT INTO crove_social.channel_access (org_id, user_id, channel_connection_id, created_by) VALUES ($1, $2, $3, $4)', [org.orgId, member.userId, channels.mine, owner.userId]),
    );
    files = {
      jpeg: await file(org.orgId, { bytes: jpeg }),
      png: await file(org.orgId, { bytes: png, contentType: 'image/png' }),
      video: await file(org.orgId, { contentType: 'video/mp4' }),
      // An accounting document photo of the org: an image, but never a Social upload.
      document: await file(org.orgId, { source: 'upload' }),
      large: await file(org.orgId, { sizeBytes: 11 * 1024 * 1024 }),
      foreign: await file(otherOrg.orgId, { bytes: jpeg }),
      hiddenOwn: await file(org.orgId, { bytes: new Uint8Array([...jpeg, 1]) }),
      hiddenShared: await file(org.orgId, { bytes: new Uint8Array([...jpeg, 2]) }),
      mineOwn: await file(org.orgId, { bytes: new Uint8Array([...jpeg, 3]) }),
    };
    // A post on the hidden channel with its own media, one with shared media, and the member's channel's own media.
    const post = async (input: Record<string, unknown>) => expect((await rpc('social/posts/create', ownerToken, { body: 'Bài cũ', idempotencyKey: randomUUID(), ...input })).status).toBe(200);
    await post({ channels: [{ connectionId: channels.hidden, media: [{ fileId: files.hiddenOwn }] }] });
    await post({ media: [{ fileId: files.hiddenShared }], channels: [{ connectionId: channels.hidden }] });
    await post({ channels: [{ connectionId: channels.mine, media: [{ fileId: files.mineOwn }] }, { connectionId: channels.hidden, media: [{ fileId: files.mineOwn }] }] });
  });

  afterAll(async () => {
    await pool?.end();
    if (dir) await rm(dir, { recursive: true, force: true });
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('agrees with the writer on how many photos and how large', () => {
    expect(AI_DRAFT_IMAGES_MAX).toBe(DRAFT_IMAGES_MAX);
    expect(AI_IMAGE_MAX_BYTES).toBe(ALT_TEXT_IMAGE_MAX_BYTES);
  });

  it('drafts from two photos and no brief: a tainted post that carries both, one variant per chosen channel', async () => {
    const token = await tokenFor(owner);
    answer = { body: 'Bánh mì nóng giòn vừa ra lò, ghé tiệm sáng nay nhé!', title: null, variants: [{ key: channels.hidden, body: 'Bánh mì vừa ra lò!', title: null }] };
    const count = asked.length;
    const drafted = await rpc('social/posts/draftWithAi', token, { brief: '', connectionIds: [channels.mine, channels.hidden], fileIds: [files.png, files.jpeg] });
    expect(drafted.status).toBe(200);
    expect(asked).toHaveLength(count + 1);
    const ask = asked.at(-1) as Parameters<DraftGenerator>[0];
    // The exact stored bytes, in the order picked, with their types.
    expect(ask.images?.map((i) => i.mime)).toEqual(['image/png', 'image/jpeg']);
    expect(Buffer.from(ask.images?.[0]?.image ?? []).equals(Buffer.from(png))).toBe(true);
    expect(Buffer.from(ask.images?.[1]?.image ?? []).equals(Buffer.from(jpeg))).toBe(true);
    expect(ask.system).toContain('Write only about what is clearly visible in them and what the brief says.');
    expect(ask.prompt).toContain('Brief: none; write a post about what the photos show.');
    expect(ask.prompt).toContain('text at most 1000 characters');
    const post = await rpc('social/posts/get', token, { postId: drafted.body?.postId });
    expect(post.body).toMatchObject({ origin: 'ai', tainted: true, body: answer.body });
    expect(post.body.media.map((m: { fileId: string }) => m.fileId)).toEqual([files.png, files.jpeg]);
    expect(post.body.variants.map((v: { connectionId: string }) => v.connectionId).sort()).toEqual([channels.mine, channels.hidden].sort());
    const hidden = post.body.variants.find((v: { connectionId: string }) => v.connectionId === channels.hidden);
    expect(hidden).toMatchObject({ status: 'draft', effective: { body: 'Bánh mì vừa ra lò!' } });
  });

  it('refuses a viewer, a server without AI or without a vision model, before reading or asking anything', async () => {
    const count = asked.length;
    const before = await snapshot();
    const input = { brief: '', connectionIds: [channels.mine], fileIds: [files.jpeg] };
    expect(await rpc('social/posts/draftWithAi', await tokenFor(viewer), input)).toMatchObject({ status: 403, body: { code: 'FORBIDDEN' } });
    expect(await rpc('social/posts/draftWithAi', await tokenFor(owner), input, { app: 'noAi' })).toMatchObject({ status: 503, body: { code: 'AI_NOT_CONFIGURED' } });
    // Vision before the channels: a limited member asking for another channel without a vision model hears of the model.
    expect(await rpc('social/posts/draftWithAi', await tokenFor(member), { ...input, connectionIds: [channels.hidden] }, { app: 'noVision' })).toMatchObject({
      status: 422,
      body: { code: 'AI_VISION_OFF' },
    });
    // A draft from text alone still works without a vision model.
    expect(asked).toHaveLength(count);
    expect(await snapshot()).toEqual(before);
    expect((await rpc('social/posts/draftWithAi', await tokenFor(owner), { brief: 'Khai trương', connectionIds: [channels.mine] }, { app: 'noVision' })).status).toBe(200);
    expect(asked).toHaveLength(count + 1);
    expect(asked.at(-1)?.images).toBeUndefined();
  });

  it("refuses a limited member's other channel before the files, and the files before the model", async () => {
    const count = asked.length;
    const before = await snapshot();
    const owner_ = await tokenFor(owner);
    const member_ = await tokenFor(member);
    // Channel access (#1081) comes before the files: another org's file with a hidden channel is a channel refusal.
    expect(await rpc('social/posts/draftWithAi', member_, { brief: '', connectionIds: [channels.hidden], fileIds: [files.foreign] })).toMatchObject({
      status: 403,
      body: { code: 'CHANNEL_NOT_ALLOWED', data: { connectionIds: [channels.hidden] } },
    });
    const draft = (fileIds: string[], token = owner_) => rpc('social/posts/draftWithAi', token, { brief: '', connectionIds: [channels.mine], fileIds });
    expect(await draft([files.jpeg, files.foreign])).toMatchObject({ status: 404, body: { code: 'MEDIA_NOT_FOUND', data: { fileId: files.foreign } } });
    expect(await draft([files.document])).toMatchObject({ status: 404, body: { code: 'MEDIA_NOT_FOUND' } });
    expect(await draft([randomUUID()])).toMatchObject({ status: 404, body: { code: 'MEDIA_NOT_FOUND' } });
    expect(await draft([files.jpeg, files.video])).toMatchObject({ status: 422, body: { code: 'AI_DRAFT_IMAGE_ONLY', data: { fileId: files.video } } });
    expect(await draft([files.large])).toMatchObject({ status: 413, body: { code: 'AI_DRAFT_IMAGE_TOO_LARGE' } });
    // At most four photos, each once.
    expect((await draft([files.jpeg, files.png, files.hiddenShared, files.mineOwn, files.hiddenOwn])).status).toBe(400);
    expect((await draft([files.jpeg, files.jpeg])).status).toBe(400);
    // The other org's owner, in their own org with their own channel, cannot reach this org's photo either.
    const other_ = await tokenFor(other);
    const theirs = String((await rpc('channels/connectSandbox', other_, { displayName: 'Trang của họ', key: randomUUID() }, { slug: otherOrg.slug })).body?.connectionId);
    const afterConnect = await snapshot();
    expect(await rpc('social/posts/draftWithAi', other_, { brief: '', connectionIds: [theirs], fileIds: [files.jpeg] }, { slug: otherOrg.slug })).toMatchObject({
      status: 404,
      body: { code: 'MEDIA_NOT_FOUND' },
    });
    expect(await snapshot()).toEqual(afterConnect);
    // A limited member may not use a hidden channel's own media.
    expect(await draft([files.jpeg, files.hiddenOwn], member_)).toMatchObject({ status: 403, body: { code: 'MEDIA_NOT_ALLOWED', data: { fileId: files.hiddenOwn } } });
    expect(asked).toHaveLength(count);
    // Nothing changed but the other org's new channel.
    const now = await snapshot();
    expect(Object.keys(now).filter((t) => now[t] !== before[t])).toEqual(Object.keys(afterConnect).filter((t) => afterConnect[t] !== before[t]));
  });

  it("lets a limited member use a photo of a post's shared media or of their channel's own, and the owner any", async () => {
    const count = asked.length;
    answer = { body: 'Ảnh đẹp', title: null, variants: [] };
    expect((await rpc('social/posts/draftWithAi', await tokenFor(member), { brief: 'Mở bán', connectionIds: [channels.mine], fileIds: [files.hiddenShared, files.mineOwn] })).status).toBe(200);
    expect((await rpc('social/posts/draftWithAi', await tokenFor(owner), { brief: '', connectionIds: [channels.mine], fileIds: [files.hiddenOwn] })).status).toBe(200);
    expect(asked).toHaveLength(count + 2);
  });

  it('words a failed vision call as one, and gives the empty answer its own words', async () => {
    const token = await tokenFor(owner);
    const input = { brief: '', connectionIds: [channels.mine], fileIds: [files.jpeg] };
    expect(await rpc('social/posts/draftWithAi', token, input, { app: 'failing' })).toMatchObject({ status: 503, body: { code: 'AI_DRAFT_VISION_FAILED' } });
    answer = { body: '  ', title: null, variants: [] };
    expect(await rpc('social/posts/draftWithAi', token, input)).toMatchObject({ status: 422, body: { code: 'AI_DRAFT_PHOTOS_EMPTY' } });
    answer = { body: 'Bánh mì', title: null, variants: [] };
  });

  it('reads no more of a stored photo than its file row records (#1126)', async () => {
    // The row says one byte less than the object holds, as if the object had been swapped for a larger one.
    const short = await file(org.orgId, { bytes: new Uint8Array([...jpeg, 0x42]), sizeBytes: jpeg.byteLength });
    const count = asked.length;
    const before = await snapshot();
    expect(await rpc('social/posts/draftWithAi', await tokenFor(owner), { brief: '', connectionIds: [channels.mine], fileIds: [files.jpeg, short] })).toMatchObject({
      status: 503,
      body: { code: 'AI_DRAFT_VISION_FAILED' },
    });
    expect(asked).toHaveLength(count);
    expect(await snapshot()).toEqual(before);
  });

  it('counts one call of four photos once against the drafts budget, and refuses once it is spent without asking the model', async () => {
    const who = await newAccount('budget');
    await admin((c) => c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')", [org.orgId, who.userId]));
    const token = await tokenFor(who);
    const input = { brief: '', connectionIds: [channels.mine], fileIds: [files.jpeg, files.png, files.hiddenShared, files.hiddenOwn] };
    let refused: Awaited<ReturnType<typeof rpc>> | null = null;
    let allowed = 0;
    for (let i = 0; i < 10 && !refused; i++) {
      const before = asked.length;
      const r = await rpc('social/posts/draftWithAi', token, input, { app: 'budget' });
      if (r.status === 200) {
        allowed++;
        expect(asked.length).toBe(before + 1);
        expect(asked.at(-1)?.images).toHaveLength(4);
      } else {
        refused = r;
        expect(asked.length).toBe(before);
      }
    }
    // Six a minute per member (#386), one per call.
    expect(allowed).toBe(6);
    expect(refused).toMatchObject({ status: 429, body: { code: 'RATE_LIMITED' } });
  });
});
