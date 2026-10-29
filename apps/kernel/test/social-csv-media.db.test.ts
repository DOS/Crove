// Images, labels and a first comment in the Social CSV import, through the API on PostgreSQL 17 (#1258), with recorded
// image answers and no real network call: a member's image URLs are fetched into the library as Social files (one file
// for the same bytes); an http URL, a loopback or private address (refused by the real egress guard before any
// connection, with a recorded resolver), a page that is not an image, an image over the upload limit, a host that does
// not answer, a redirect that ends on http and an accounting document's bytes are refused on their own, with nothing
// written; a viewer is refused, and the budget says busy. File names are found whatever the case and form, several
// files of one name are ambiguous, and a member limited to some channels (#1081) neither finds another channel's own
// media nor attaches it (MEDIA_NOT_ALLOWED), and the photo picker's list leaves it out (#1196). A 30-row import makes
// 30 drafts with their media, alt texts, labels (one created) and first comment, and the plan export writes those
// columns back. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
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
import { PLAN_CSV_COLUMNS, socialCommands, socialQueries } from '@crove/mod-social';
import { CredentialVault, EgressError, LocalDiskStore, Runtime, fileKey, guardedFetch, parseVaultKey, putFile, type EgressOptions, type EgressResponse } from '@crove/kernel-runtime';
import { createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { MediaUrlBudget, createMediaUrls } from '../src/media-urls.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const SECRET = 'test-only-jwt-secret-for-csv-media-0123456789';
const ISSUER = 'crove-auth';
const suite = ADMIN ? describe : describe.skip;

interface Account {
  subject: string;
  email: string;
  session: string;
  userId: string;
}

suite('images, labels and a first comment in the CSV import (#1258)', () => {
  const dbName = `crove_test_social_csv_media_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let dir = '';
  let apps: Record<'on' | 'tight', ReturnType<typeof createHttpApp>>;
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Buffer.from('a test jpeg of a bánh mì')]);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Buffer.from('a test png of the shop')]);
  const documentBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Buffer.from('a photo of a VAT invoice')]);
  // The recorded answers of the image hosts of the test, by URL; every other address goes through the real guard.
  const answers = new Map<string, EgressResponse | EgressError>();
  const fetched: string[] = [];
  const answer = (url: string, body: Buffer, contentType: string | null = 'image/jpeg', status = 200, finalUrl = url) => answers.set(url, { url: finalUrl, status, contentType, body, truncated: false });
  const fetch = async (raw: string, options: EgressOptions): Promise<EgressResponse> => {
    const found = answers.get(raw);
    if (found) {
      fetched.push(raw);
      if (found instanceof Error) throw found;
      return found;
    }
    // The guard itself, with a resolver that puts every name inside the network: it refuses before connecting.
    return guardedFetch(raw, { ...options, resolve: async (host) => [{ address: host === 'intranet.example' ? '10.0.0.7' : '169.254.169.254', family: 4 }] });
  };
  const owner: Account = { subject: randomUUID(), email: 'owner@csv-media.test', session: randomUUID(), userId: '' };
  const member: Account = { subject: randomUUID(), email: 'member@csv-media.test', session: randomUUID(), userId: '' };
  const limited: Account = { subject: randomUUID(), email: 'limited@csv-media.test', session: randomUUID(), userId: '' };
  const viewer: Account = { subject: randomUUID(), email: 'viewer@csv-media.test', session: randomUUID(), userId: '' };
  let org = { slug: '', orgId: '' };
  let channels: { mine: string; hidden: string };
  let files: { menu: string; menuNfd: string; twinA: string; twinB: string; hiddenOwn: string; mineOwn: string };

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

  async function rpc(path: string, who: Account, input: unknown, options: { slug?: string | null; app?: keyof typeof apps } = {}) {
    const slug = options.slug === undefined ? org.slug : options.slug;
    const response = await apps[options.app ?? 'on'].request(`/api/rpc/${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await tokenFor(who)}`, 'content-type': 'application/json', ...(slug ? { 'x-crove-org': slug } : {}) },
      body: JSON.stringify(input === undefined ? {} : { json: input }),
    });
    const body = (await response.json().catch(() => null)) as ({ json?: unknown } & Record<string, unknown>) | null;
    return { status: response.status, body: (body && 'json' in body ? body.json : body) as any };
  }

  // A file row as the upload route records it, its bytes stored under its key.
  async function file(filename: string, options: { source?: string; bytes?: Buffer; contentType?: string } = {}) {
    const id = randomUUID();
    const bytes = options.bytes ?? Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Buffer.from(id)]);
    const sha = createHash('sha256').update(bytes).digest('hex');
    const key = fileKey(org.orgId, sha);
    const generation = await putFile(new LocalDiskStore(dir), key, bytes, options.contentType ?? 'image/jpeg', sha);
    await admin((c) =>
      c.query(
        `INSERT INTO crove_kernel.file (org_id, id, sha256, storage_key, generation, filename, content_type, size_bytes, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [org.orgId, id, sha, key, generation, filename, options.contentType ?? 'image/jpeg', bytes.byteLength, options.source ?? 'social'],
      ),
    );
    return id;
  }

  const count = (table: string) => admin(async (c) => Number((await c.query<{ n: string }>(`SELECT count(*) AS n FROM ${table} WHERE org_id = $1`, [org.orgId])).rows[0]?.n));

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
    dir = await mkdtemp(join(tmpdir(), 'crove-csv-media-'));
    const store = new LocalDiskStore(dir);
    const runtime = new Runtime(db, { manifests: TEST_MANIFESTS, sessions: createSessionStatusSource('off'), stepUp: 'required' }).register({
      commands: [...kernelCommands, ...socialCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...socialQueries],
    });
    const config = loadConfig({ DATABASE_URL: appUrl.toString(), AUTH_JWT_SECRET: SECRET, AUTH_ISSUER: ISSUER, AUTH_SESSION_CHECK: 'off', MIGRATIONS_DIR: MIGRATIONS, WEB_DIST: '/nonexistent' });
    const vault = new CredentialVault([parseVaultKey(randomBytes(32).toString('base64'))]);
    const make = (budget?: MediaUrlBudget) =>
      createHttpApp({
        config,
        runtime,
        store,
        authenticate: createAuthenticator(config, db),
        pool,
        aiEnabled: false,
        channels: { broker: vault, sandbox: true, mediaUrls: createMediaUrls({ store, fetch, ...(budget ? { budget } : {}) }) },
      });
    apps = { on: make(), tight: make(new MediaUrlBudget({ perUserPerMinute: 2 })) };
    for (const who of [owner, member, limited, viewer]) {
      const me = await rpc('me/get', who, undefined, { slug: null });
      expect(me.status).toBe(200);
      who.userId = String(me.body?.userId);
    }
    const created = await rpc('org/create', owner, { name: 'Tiệm bánh mì', idempotencyKey: randomUUID() }, { slug: null });
    expect(created.status).toBe(200);
    org = { slug: String(created.body?.slug), orgId: String(created.body?.orgId) };
    await admin((c) =>
      c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member'), ($1, $4, 'viewer')", [org.orgId, member.userId, limited.userId, viewer.userId]),
    );
    const connect = async (displayName: string) => String((await rpc('channels/connectSandbox', owner, { displayName, key: randomUUID() })).body?.connectionId);
    channels = { mine: await connect('Trang của bạn'), hidden: await connect('Trang khác') };
    await admin((c) => c.query('INSERT INTO crove_social.channel_access (org_id, user_id, channel_connection_id, created_by) VALUES ($1, $2, $3, $4)', [org.orgId, limited.userId, channels.mine, owner.userId]));
    files = {
      menu: await file('Thực đơn.jpg'),
      // The same name as a Mac saves it (decomposed), on another file: two files of one name.
      menuNfd: await file('Quầy Thực đơn.jpg'.normalize('NFD')),
      twinA: await file('bia.jpg'),
      twinB: await file('BIA.jpg'),
      hiddenOwn: await file('rieng.jpg'),
      mineOwn: await file('cua-toi.jpg'),
    };
    const post = async (input: Record<string, unknown>) => expect((await rpc('social/posts/create', owner, { body: 'Bài cũ', idempotencyKey: randomUUID(), ...input })).status).toBe(200);
    // A post on the hidden channel with its own media, and the limited member's channel's own media.
    await post({ channels: [{ connectionId: channels.hidden, media: [{ fileId: files.hiddenOwn }] }] });
    await post({ channels: [{ connectionId: channels.mine, media: [{ fileId: files.mineOwn }] }] });
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

  it('fetches image URLs into the library as Social files, once for the same bytes', async () => {
    answer('https://cdn.test/anh/b%C3%A1nh-m%C3%AC.jpeg?w=940', jpeg);
    // A host that says octet-stream: the bytes decide.
    answer('https://cdn.test/cua-tiem', png, 'application/octet-stream');
    answer('https://mirror.test/copy.jpg', jpeg);
    const done = await rpc('social/media/fetchUrls', member, { urls: ['https://cdn.test/anh/b%C3%A1nh-m%C3%AC.jpeg?w=940', 'https://cdn.test/cua-tiem', 'https://mirror.test/copy.jpg'] });
    expect(done.status).toBe(200);
    const [first, second, copy] = done.body.results;
    expect(first).toMatchObject({ url: 'https://cdn.test/anh/b%C3%A1nh-m%C3%AC.jpeg?w=940', problem: null, file: { filename: 'bánh-mì.jpg', mime: 'image/jpeg', sizeBytes: jpeg.byteLength } });
    expect(second).toMatchObject({ problem: null, file: { filename: 'cua-tiem.png', mime: 'image/png' } });
    // The same bytes from another address: the same file.
    expect(copy.file.fileId).toBe(first.file.fileId);
    const rows = await admin((c) => c.query('SELECT source, content_type, created_by FROM crove_kernel.file WHERE org_id = $1 AND id = ANY($2::uuid[]) ORDER BY content_type', [org.orgId, [first.file.fileId, second.file.fileId]]));
    expect(rows.rows).toEqual([
      { source: 'social', content_type: 'image/jpeg', created_by: member.userId },
      { source: 'social', content_type: 'image/png', created_by: member.userId },
    ]);
  });

  it('refuses each bad URL on its own, fetching nothing it should not and writing nothing', async () => {
    await file('hoa-don.jpg', { source: 'upload', bytes: documentBytes });
    answer('https://cdn.test/trang.html', Buffer.from('<!doctype html><title>not an image</title>'), 'text/html');
    answers.set('https://cdn.test/lon.jpg', new EgressError('too_large', 'the response is too large'));
    answers.set('https://cdn.test/cham.jpg', new EgressError('timeout', 'took too long'));
    answer('https://cdn.test/mat.jpg', Buffer.from('Not Found'), 'text/plain', 404);
    answer('https://cdn.test/sang-http.jpg', jpeg, 'image/jpeg', 200, 'http://cdn.test/sang-http.jpg');
    answer('https://cdn.test/hoa-don.jpg', documentBytes);
    const before = { files: await count('crove_kernel.file'), fetched: fetched.length };
    const urls = [
      'http://cdn.test/a.jpg',
      'https://127.0.0.1/a.jpg',
      'https://intranet.example/a.jpg',
      'https://[::1]/a.jpg',
      'https://user:pw@cdn.test/a.jpg',
      'https://cdn.test/trang.html',
      'https://cdn.test/lon.jpg',
      'https://cdn.test/cham.jpg',
      'https://cdn.test/mat.jpg',
      'https://cdn.test/sang-http.jpg',
    ];
    const done = await rpc('social/media/fetchUrls', member, { urls });
    expect(done.status).toBe(200);
    expect(done.body.results.map((r: { problem: string; file: unknown }) => [r.problem, r.file])).toEqual([
      ['MEDIA_URL_INVALID', null],
      ['MEDIA_URL_BLOCKED', null],
      ['MEDIA_URL_BLOCKED', null],
      ['MEDIA_URL_BLOCKED', null],
      ['MEDIA_URL_INVALID', null],
      ['MEDIA_URL_NOT_IMAGE', null],
      ['MEDIA_URL_TOO_LARGE', null],
      ['MEDIA_URL_UNREACHABLE', null],
      ['MEDIA_URL_UNREACHABLE', null],
      ['MEDIA_URL_INVALID', null],
    ]);
    // Only the recorded hosts were asked; the http URL, the credentials and the private addresses never left.
    expect(fetched.slice(before.fetched).sort()).toEqual(['https://cdn.test/cham.jpg', 'https://cdn.test/lon.jpg', 'https://cdn.test/mat.jpg', 'https://cdn.test/sang-http.jpg', 'https://cdn.test/trang.html']);
    const document = await rpc('social/media/fetchUrls', member, { urls: ['https://cdn.test/hoa-don.jpg'] });
    expect(document.body.results).toEqual([{ url: 'https://cdn.test/hoa-don.jpg', file: null, problem: 'MEDIA_URL_DOCUMENT' }]);
    expect(await count('crove_kernel.file')).toBe(before.files);
    expect(await admin(async (c) => (await c.query("SELECT count(*) AS n FROM crove_kernel.file WHERE org_id = $1 AND source = 'social' AND filename = 'hoa-don.jpg'", [org.orgId])).rows[0]?.n)).toBe('0');
  });

  it('refuses a viewer and more than ten URLs, and says busy past the budget', async () => {
    expect(await rpc('social/media/fetchUrls', viewer, { urls: ['https://cdn.test/cua-tiem'] })).toMatchObject({ status: 403, body: { code: 'FORBIDDEN' } });
    expect((await rpc('social/media/fetchUrls', member, { urls: Array.from({ length: 11 }, (_, i) => `https://cdn.test/${i}.jpg`) })).status).toBe(400);
    const done = await rpc('social/media/fetchUrls', member, { urls: ['https://cdn.test/cua-tiem', 'https://mirror.test/copy.jpg', 'https://cdn.test/anh/b%C3%A1nh-m%C3%AC.jpeg?w=940'] }, { app: 'tight' });
    expect(done.body.results.map((r: { problem: string | null }) => r.problem)).toEqual([null, null, 'MEDIA_URL_BUSY']);
    expect(done.body.results[2].retryAfterSeconds).toBeGreaterThan(0);
  });

  it('finds library files by name whatever the case and form, or by id; says unknown, ambiguous and not allowed', async () => {
    const asked = ['thực đơn.JPG', 'Quầy Thực đơn.jpg'.normalize('NFC'), 'bia.jpg', 'khong-co.jpg', 'rieng.jpg', files.hiddenOwn.toUpperCase(), 'cua-toi.jpg'];
    const forOwner = await rpc('social/media/resolve', owner, { refs: asked });
    expect(forOwner.status).toBe(200);
    expect(forOwner.body.map((r: { file: { fileId: string } | null; problem: string | null }) => r.file?.fileId ?? r.problem)).toEqual([files.menu, files.menuNfd, 'AMBIGUOUS_FILE', 'UNKNOWN_FILE', files.hiddenOwn, files.hiddenOwn, files.mineOwn]);
    // The limited member: another channel's own media is not theirs to use, by name or by id.
    const forLimited = await rpc('social/media/resolve', limited, { refs: asked });
    expect(forLimited.body.map((r: { file: { fileId: string } | null; problem: string | null }) => r.file?.fileId ?? r.problem)).toEqual([files.menu, files.menuNfd, 'AMBIGUOUS_FILE', 'UNKNOWN_FILE', 'FILE_NOT_ALLOWED', 'FILE_NOT_ALLOWED', files.mineOwn]);
    expect((await rpc('social/media/resolve', viewer, { refs: ['bia.jpg'] })).status).toBe(403);
  });

  it("leaves another channel's own media out of the photo picker's list for a limited member (#1196)", async () => {
    const ids = async (who: Account, usable: boolean) => ((await rpc('social/media/list', who, { limit: 100, ...(usable ? { usable } : {}) })).body.items as { fileId: string }[]).map((i) => i.fileId);
    expect(await ids(limited, false)).toContain(files.hiddenOwn);
    expect(await ids(limited, true)).not.toContain(files.hiddenOwn);
    expect(await ids(limited, true)).toContain(files.mineOwn);
    expect(await ids(owner, true)).toContain(files.hiddenOwn);
  });

  it("refuses a limited member's import that attaches another channel's file, writing nothing", async () => {
    const posts = await count('crove_social.post');
    const refused = await rpc('social/posts/import', limited, { idempotencyKey: randomUUID(), posts: [{ body: 'Bài có ảnh', connectionIds: [channels.mine], media: [{ fileId: files.mineOwn }, { fileId: files.hiddenOwn }] }] });
    expect(refused).toMatchObject({ status: 403, body: { code: 'MEDIA_NOT_ALLOWED', data: { fileId: files.hiddenOwn } } });
    expect(await count('crove_social.post')).toBe(posts);
    const allowed = await rpc('social/posts/import', limited, { idempotencyKey: randomUUID(), posts: [{ body: 'Bài có ảnh', connectionIds: [channels.mine], media: [{ fileId: files.mineOwn }, { fileId: files.menu }] }] });
    expect(allowed.status).toBe(200);
  });

  it('makes 30 drafts from 30 rows with their media, alt texts, labels and first comment, creating the missing label', async () => {
    expect((await rpc('social/labels/create', owner, { name: 'Khai trương' })).status).toBe(200);
    const labelsBefore = await count('crove_social.label');
    const rows = Array.from({ length: 30 }, (_, i) => ({
      body: `Bài số ${i + 1}`,
      connectionIds: [channels.mine],
      media: i % 2 === 0 ? [{ fileId: files.menu, altText: `Thực đơn tuần ${i + 1}` }, { fileId: files.mineOwn }] : [{ fileId: files.menuNfd }],
      labels: i % 3 === 0 ? ['khai TRƯƠNG', 'Tháng 11'] : ['Tháng 11'],
      ...(i === 0 ? { firstComment: 'Xem thực đơn đầy đủ ở trang của quán' } : {}),
    }));
    const done = await rpc('social/posts/import', member, { idempotencyKey: randomUUID(), posts: rows });
    expect(done.status).toBe(200);
    const postIds: string[] = done.body.posts.map((p: { postId: string }) => p.postId);
    expect(postIds).toHaveLength(30);
    const media = await admin((c) =>
      c.query<{ post_id: string; file_id: string; position: number; alt_text: string | null }>('SELECT post_id, file_id, position, alt_text FROM crove_social.post_media WHERE org_id = $1 AND post_id = ANY($2::uuid[]) ORDER BY position', [org.orgId, postIds]),
    );
    expect(media.rows.filter((m) => m.post_id === postIds[0])).toEqual([
      { post_id: postIds[0], file_id: files.menu, position: 1, alt_text: 'Thực đơn tuần 1' },
      { post_id: postIds[0], file_id: files.mineOwn, position: 2, alt_text: null },
    ]);
    expect(media.rows.filter((m) => m.post_id === postIds[1]).map((m) => m.file_id)).toEqual([files.menuNfd]);
    expect(new Set(media.rows.map((m) => m.post_id)).size).toBe(30);
    const labels = await admin((c) =>
      c.query<{ name: string; n: string; created_by: string }>(
        'SELECT l.name, count(pl.post_id) AS n, l.created_by FROM crove_social.label l JOIN crove_social.post_label pl ON pl.org_id = l.org_id AND pl.label_id = l.id WHERE l.org_id = $1 AND pl.post_id = ANY($2::uuid[]) GROUP BY l.name, l.created_by ORDER BY l.name',
        [org.orgId, postIds],
      ),
    );
    expect(labels.rows).toEqual([
      { name: 'Khai trương', n: '10', created_by: owner.userId },
      { name: 'Tháng 11', n: '30', created_by: member.userId },
    ]);
    expect(await count('crove_social.label')).toBe(labelsBefore + 1);
    const variants = await admin((c) => c.query<{ post_id: string; status: string; settings: Record<string, unknown> }>('SELECT post_id, status, settings FROM crove_social.post_variant WHERE org_id = $1 AND post_id = ANY($2::uuid[])', [org.orgId, postIds]));
    expect(variants.rows.every((v) => v.status === 'draft')).toBe(true);
    expect(variants.rows.find((v) => v.post_id === postIds[0])?.settings.firstComment).toBe('Xem thực đơn đầy đủ ở trang của quán');
    expect(variants.rows.filter((v) => 'firstComment' in v.settings)).toHaveLength(1);
    const audit = await admin((c) => c.query("SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'social.post.import' ORDER BY occurred_at DESC LIMIT 1", [org.orgId]));
    expect(audit.rows[0]?.detail).toMatchObject({ posts: 30, media: 45, labels_created: 1 });
  });

  it('refuses labels that repeat in a row (the command) and more than ten media (the contract)', async () => {
    expect((await rpc('social/posts/import', member, { idempotencyKey: randomUUID(), posts: [{ body: 'x', connectionIds: [channels.mine], labels: ['Tết', 'tết'] }] })).status).toBe(422);
    const eleven = Array.from({ length: 11 }, () => ({ fileId: randomUUID() }));
    expect((await rpc('social/posts/import', member, { idempotencyKey: randomUUID(), posts: [{ body: 'x', connectionIds: [channels.mine], media: eleven }] })).status).toBe(400);
  });

  it('exports the media, alt texts, first comment and labels in the import columns, an ambiguous name as its id', async () => {
    const at = new Date(Date.now() + 3 * 86_400_000);
    at.setUTCHours(2, 0, 0, 0);
    const made = await rpc('social/posts/import', owner, {
      idempotencyKey: randomUUID(),
      posts: [{ body: 'Bài xuất', scheduledAt: at.toISOString(), connectionIds: [channels.mine], media: [{ fileId: files.menu, altText: 'Thực đơn' }, { fileId: files.twinA }], labels: ['Xuất'], firstComment: 'Bình luận đầu' }],
    });
    expect(made.status).toBe(200);
    const from = new Date(at.getTime() - 86_400_000).toISOString();
    const to = new Date(at.getTime() + 86_400_000).toISOString();
    const exported = await rpc('social/plan/export', owner, { from, to, timeZone: 'UTC', labelIds: [String((await rpc('social/labels/list', owner, {})).body.find((l: { name: string }) => l.name === 'Xuất').id)] });
    expect(exported.status).toBe(200);
    const lines: string[] = exported.body.csv.slice(1).split('\r\n');
    expect(lines[0]).toBe(PLAN_CSV_COLUMNS.join(','));
    expect(lines.slice(1).join('\r\n')).toContain(`Bài xuất,,,Trang của bạn,${at.toISOString().slice(0, 10)} 02:00,"Thực đơn.jpg\n${files.twinA}",Thực đơn,Bình luận đầu,Xuất,draft,,${made.body.posts[0].postId}`);
  });
});
