// AI alt text suggestions through the API (#817, #1121): a recorded model answer fills the suggestion from the stored
// image, within the chosen channels' strictest limit; a viewer, a server without AI or without a vision model, a file
// that is not the org's own Social image, a channel of another org and a spent budget are refused before the model is
// asked; and the route writes nothing. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
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
import { socialCommands, socialQueries } from '@crove/mod-social';
import { CredentialVault, LocalDiskStore, Runtime, fileKey, parseVaultKey, putFile } from '@crove/kernel-runtime';
import { SocialWriter, type DescribeGenerator } from '@crove/agent';
import { createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { socialDrafter } from '../src/kernel.ts';
import { createSessionStatusSource } from '../src/sessions.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const SECRET = 'test-only-jwt-secret-for-alt-text-0123456789';
const ISSUER = 'crove-auth';
const suite = ADMIN ? describe : describe.skip;

interface Account {
  subject: string;
  email: string;
  session: string;
  userId: string;
}

suite('AI alt text suggestions through the API (#1121)', () => {
  const dbName = `crove_test_social_alt_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let dir = '';
  let apps: Record<'on' | 'noVision' | 'noAi' | 'failing', ReturnType<typeof createHttpApp>>;
  // The model's answer, recorded: what it was sent, and the description it gave.
  const asked: { system: string; prompt: string; image: Uint8Array; mime: string }[] = [];
  const RECORDED = { altText: 'Ổ bánh mì thịt nướng giòn trên khay gỗ, bên cạnh ly cà phê sữa đá. Dòng chữ "Khai trương" ở góc trên.' };
  const generate: DescribeGenerator = async (args) => {
    asked.push(args);
    return RECORDED;
  };
  const owner: Account = { subject: randomUUID(), email: 'owner@alt-text.test', session: randomUUID(), userId: '' };
  const viewer: Account = { subject: randomUUID(), email: 'viewer@alt-text.test', session: randomUUID(), userId: '' };
  const other: Account = { subject: randomUUID(), email: 'other@alt-text.test', session: randomUUID(), userId: '' };
  let org = { slug: '', orgId: '' };
  let otherOrg = { slug: '', orgId: '' };
  const photo = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new TextEncoder().encode('a test jpeg of a bánh mì')]);
  let files: { photo: string; video: string; document: string; large: string; foreign: string };
  let channels: { pinterest: string; foreign: string };

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

  async function connection(orgId: string, provider: string, by: string) {
    const id = randomUUID();
    await admin((c) =>
      c.query('INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, $3, $4, $5, $6)', [
        orgId,
        id,
        provider,
        `acct-${id.slice(0, 8)}`,
        'Kênh thử',
        by,
      ]),
    );
    return id;
  }

  // Every row of every Crove table, hashed by table: the route must leave all of them as they were.
  async function snapshot(): Promise<Record<string, string>> {
    return admin(async (c) => {
      const { rows: tables } = await c.query<{ name: string }>(
        `SELECT format('%I.%I', schemaname, tablename) AS name FROM pg_catalog.pg_tables WHERE schemaname LIKE 'crove\\_%' ORDER BY 1`,
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
    dir = await mkdtemp(join(tmpdir(), 'crove-alt-text-'));
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
    // image is read from the store; without one (AI_VISION off) the writer has no way to describe images.
    const writer = new SocialWriter({ baseURL: 'http://localhost:1/v1', apiKey: null, model: 'test' }, undefined, undefined, undefined, generate);
    const vault = new CredentialVault([parseVaultKey(randomBytes(32).toString('base64'))]);
    const make = (socialWriter?: ReturnType<typeof socialDrafter>) =>
      createHttpApp({ config, runtime, store, authenticate: createAuthenticator(config, db), pool, aiEnabled: true, channels: { broker: vault, sandbox: true }, ...(socialWriter ? { socialWriter } : {}) });
    // failing: a model that does not answer, on an app of its own so it spends none of the budget the last test counts.
    const failing = {
      ...socialDrafter(writer, store),
      describeStored: async () => {
        throw new Error('the model did not answer');
      },
    };
    apps = { on: make(socialDrafter(writer, store)), noVision: make(socialDrafter(writer, null)), noAi: make(), failing: make(failing) };

    for (const who of [owner, viewer, other]) {
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
    await admin((c) => c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'viewer')", [org.orgId, viewer.userId]));
    files = {
      photo: await file(org.orgId, { bytes: photo }),
      video: await file(org.orgId, { contentType: 'video/mp4' }),
      // An accounting document photo of the org: an image, but never a Social upload.
      document: await file(org.orgId, { source: 'upload' }),
      large: await file(org.orgId, { sizeBytes: 11 * 1024 * 1024 }),
      foreign: await file(otherOrg.orgId, { bytes: photo }),
    };
    channels = { pinterest: await connection(org.orgId, 'pinterest', owner.userId), foreign: await connection(otherOrg.orgId, 'x', other.userId) };
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

  it('fills the suggestion with the recorded answer from the stored image, in the language asked, and writes nothing', async () => {
    const before = await snapshot();
    // The snapshot sees the tables a suggestion could touch.
    expect(Object.keys(before)).toEqual(expect.arrayContaining(['crove_kernel.file', 'crove_kernel.audit_event', 'crove_social.post', 'crove_social.post_media']));
    const answer = await rpc('social/posts/describeImage', await tokenFor(owner), { fileId: files.photo, language: 'vi', connectionIds: [channels.pinterest] });
    expect(answer).toMatchObject({ status: 200, body: { altText: RECORDED.altText } });
    expect(asked).toHaveLength(1);
    // The exact stored bytes went to the model, as an image, with the ask in Vietnamese and within the limit.
    expect(Buffer.from(asked[0]?.image ?? []).equals(Buffer.from(photo))).toBe(true);
    expect(asked[0]?.mime).toBe('image/jpeg');
    expect(asked[0]?.system).toContain('Describe in Vietnamese');
    expect(asked[0]?.system).toContain('At most 250 characters');
    const english = await rpc('social/posts/describeImage', await tokenFor(owner), { fileId: files.photo, language: 'en' });
    expect(english.status).toBe(200);
    expect(asked[1]?.system).toContain('Describe in English');
    expect(await snapshot()).toEqual(before);
  });

  it('refuses a viewer, a server without AI or without a vision model, before asking the model', async () => {
    const count = asked.length;
    expect(await rpc('social/posts/describeImage', await tokenFor(viewer), { fileId: files.photo, language: 'vi' })).toMatchObject({ status: 403, body: { code: 'FORBIDDEN' } });
    expect(await rpc('social/posts/describeImage', await tokenFor(owner), { fileId: files.photo, language: 'vi' }, { app: 'noAi' })).toMatchObject({ status: 503, body: { code: 'AI_NOT_CONFIGURED' } });
    expect(await rpc('social/posts/describeImage', await tokenFor(owner), { fileId: files.photo, language: 'vi' }, { app: 'noVision' })).toMatchObject({ status: 422, body: { code: 'AI_VISION_OFF' } });
    expect(asked).toHaveLength(count);
  });

  it('words a failed model call as an alt text failure, not a draft failure (#1126)', async () => {
    expect(await rpc('social/posts/describeImage', await tokenFor(owner), { fileId: files.photo, language: 'vi' }, { app: 'failing' })).toMatchObject({ status: 503, body: { code: 'AI_ALT_TEXT_FAILED' } });
  });

  it("refuses a video, an image too large, an accounting document, another org's file and another org's channel", async () => {
    const count = asked.length;
    const before = await snapshot();
    const token = await tokenFor(owner);
    expect(await rpc('social/posts/describeImage', token, { fileId: files.video, language: 'vi' })).toMatchObject({ status: 422, body: { code: 'ALT_TEXT_IMAGE_ONLY' } });
    expect(await rpc('social/posts/describeImage', token, { fileId: files.large, language: 'vi' })).toMatchObject({ status: 413, body: { code: 'ALT_TEXT_IMAGE_TOO_LARGE' } });
    expect(await rpc('social/posts/describeImage', token, { fileId: files.document, language: 'vi' })).toMatchObject({ status: 404, body: { code: 'MEDIA_NOT_FOUND' } });
    expect(await rpc('social/posts/describeImage', token, { fileId: files.foreign, language: 'vi' })).toMatchObject({ status: 404, body: { code: 'MEDIA_NOT_FOUND' } });
    expect(await rpc('social/posts/describeImage', token, { fileId: files.photo, language: 'vi', connectionIds: [channels.foreign] })).toMatchObject({ status: 404, body: { code: 'CHANNEL_NOT_FOUND' } });
    // The other org's owner, in their own org, cannot reach this org's image either.
    expect(await rpc('social/posts/describeImage', await tokenFor(other), { fileId: files.photo, language: 'vi' }, { slug: otherOrg.slug })).toMatchObject({ status: 404, body: { code: 'MEDIA_NOT_FOUND' } });
    expect(asked).toHaveLength(count);
    expect(await snapshot()).toEqual(before);
  });

  it('counts against the AI drafting budget and refuses once it is spent, without asking the model', async () => {
    const token = await tokenFor(owner);
    let refused: Awaited<ReturnType<typeof rpc>> | null = null;
    let allowed = 0;
    for (let i = 0; i < 10 && !refused; i++) {
      const before = asked.length;
      const r = await rpc('social/posts/describeImage', token, { fileId: files.photo, language: 'vi' });
      if (r.status === 200) {
        allowed++;
        expect(asked.length).toBe(before + 1);
      } else {
        refused = r;
        expect(asked.length).toBe(before);
      }
    }
    // Two asks of the first test and these: six a minute per member (#386).
    expect(allowed).toBe(4);
    expect(refused).toMatchObject({ status: 429, body: { code: 'RATE_LIMITED' } });
  });
});
