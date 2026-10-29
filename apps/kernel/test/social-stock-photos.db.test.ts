// Stock photos from Pexels through the API on PostgreSQL 17 (#1106), with recorded Pexels answers and no real call:
// a member searches and saves a photo, which lands in the library as a Social file with its credit and alt text (the
// saver from the sealed context, the first credit kept when the same bytes come again); a src on another host is
// refused with nothing written; a viewer, a non-member and a server without the key are refused before any call to
// Pexels; and the command refuses a credit that links outside Pexels, and a viewer. Set CROVE_TEST_ADMIN_URL to a
// superuser URL; each run makes its own database.
import { randomBytes, randomUUID } from 'node:crypto';
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
import { CredentialVault, LocalDiskStore, Runtime, fileKey, parseVaultKey, putFile, sha256Hex, type EgressOptions, type EgressResponse, type GuardedRequest } from '@crove/kernel-runtime';
import { createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { createPexels } from '../src/stock-photos.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const SECRET = 'test-only-jwt-secret-for-stock-photos-0123456789';
const ISSUER = 'crove-auth';
// A low-entropy fake key: never a real one.
const KEY = 'pexelstestkeyaaaaaaaaaaaaaaaaaaaa';
const suite = ADMIN ? describe : describe.skip;

interface Account {
  subject: string;
  email: string;
  session: string;
  userId: string;
}

const photo = (id: number, overrides: Record<string, unknown> = {}) => ({
  id,
  width: 6000,
  height: 4000,
  url: `https://www.pexels.com/photo/banh-mi-${id}/`,
  photographer: 'Trần Thị B',
  photographer_url: 'https://www.pexels.com/@tran-thi-b',
  avg_color: '#A0522D',
  src: {
    original: `https://images.pexels.com/photos/${id}/pexels-photo-${id}.jpeg`,
    large2x: `https://images.pexels.com/photos/${id}/pexels-photo-${id}.jpeg?auto=compress&cs=tinysrgb&dpr=2&h=650&w=940`,
    large: `https://images.pexels.com/photos/${id}/pexels-photo-${id}.jpeg?auto=compress&cs=tinysrgb&h=650&w=940`,
    tiny: `https://images.pexels.com/photos/${id}/pexels-photo-${id}.jpeg?auto=compress&cs=tinysrgb&dpr=1&fit=crop&h=200&w=280`,
  },
  alt: 'Ổ bánh mì nóng giòn trên khay gỗ',
  ...overrides,
});

suite('stock photos from Pexels through the API (#1106)', () => {
  const dbName = `crove_test_social_stock_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let dir = '';
  let apps: Record<'on' | 'off', ReturnType<typeof createHttpApp>>;
  // Every request that would have gone to Pexels, and the recorded photos it answers with, by id.
  const calls: string[] = [];
  const photos = new Map<number, ReturnType<typeof photo>>();
  const bytesOf = (url: string) => Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Buffer.from(`jpeg of ${new URL(url).pathname}`)]);
  const json = (body: unknown, status = 200): EgressResponse => ({ url: 'https://api.pexels.com/', status, contentType: 'application/json', body: Buffer.from(JSON.stringify(body)), truncated: false });
  const request = async (raw: string, _request: GuardedRequest, _options: EgressOptions): Promise<EgressResponse> => {
    calls.push(raw);
    const url = new URL(raw);
    if (url.pathname === '/v1/search') return json({ total_results: 2, page: 1, per_page: 24, photos: [photo(11), photo(12)] });
    const id = Number(url.pathname.split('/').at(-1));
    const found = photos.get(id);
    return found ? json(found) : json({ error: 'Not found' }, 404);
  };
  const fetch = async (raw: string, _options: EgressOptions): Promise<EgressResponse> => {
    calls.push(raw);
    return { url: raw, status: 200, contentType: 'image/jpeg', body: bytesOf(raw), truncated: false };
  };
  const owner: Account = { subject: randomUUID(), email: 'owner@stock.test', session: randomUUID(), userId: '' };
  const member: Account = { subject: randomUUID(), email: 'member@stock.test', session: randomUUID(), userId: '' };
  const viewer: Account = { subject: randomUUID(), email: 'viewer@stock.test', session: randomUUID(), userId: '' };
  const outsider: Account = { subject: randomUUID(), email: 'outsider@stock.test', session: randomUUID(), userId: '' };
  let org = { slug: '', orgId: '' };

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

  const counts = () =>
    admin(async (c) => {
      const files = await c.query<{ n: string }>('SELECT count(*) AS n FROM crove_kernel.file WHERE org_id = $1', [org.orgId]);
      const credits = await c.query<{ n: string }>('SELECT count(*) AS n FROM crove_social.media_attribution WHERE org_id = $1', [org.orgId]);
      return { files: Number(files.rows[0]?.n), credits: Number(credits.rows[0]?.n) };
    });

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
    dir = await mkdtemp(join(tmpdir(), 'crove-stock-'));
    const store = new LocalDiskStore(dir);
    const runtime = new Runtime(db, { manifests: TEST_MANIFESTS, sessions: createSessionStatusSource('off'), stepUp: 'required' }).register({
      commands: [...kernelCommands, ...socialCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...socialQueries],
    });
    const config = loadConfig({ DATABASE_URL: appUrl.toString(), AUTH_JWT_SECRET: SECRET, AUTH_ISSUER: ISSUER, AUTH_SESSION_CHECK: 'off', MIGRATIONS_DIR: MIGRATIONS, WEB_DIST: '/nonexistent' });
    const vault = new CredentialVault([parseVaultKey(randomBytes(32).toString('base64'))]);
    const make = (on: boolean) =>
      createHttpApp({
        config,
        runtime,
        store,
        authenticate: createAuthenticator(config, db),
        pool,
        aiEnabled: false,
        channels: { broker: vault, sandbox: false, ...(on ? { stockPhotos: createPexels({ apiKey: KEY, store, request, fetch }) } : {}) },
      });
    apps = { on: make(true), off: make(false) };
    for (const who of [owner, member, viewer, outsider]) {
      const me = await rpc('me/get', who, undefined, { slug: null });
      expect(me.status).toBe(200);
      who.userId = String(me.body?.userId);
    }
    const created = await rpc('org/create', owner, { name: 'Tiệm bánh mì', idempotencyKey: randomUUID() }, { slug: null });
    expect(created.status).toBe(200);
    org = { slug: String(created.body?.slug), orgId: String(created.body?.orgId) };
    await admin((c) => c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'viewer')", [org.orgId, member.userId, viewer.userId]));
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

  it('says whether the server offers Pexels photos', async () => {
    expect((await rpc('social/stockPhotos/status', viewer, {})).body).toEqual({ enabled: true, provider: 'pexels' });
    expect((await rpc('social/stockPhotos/status', viewer, {}, { app: 'off' })).body).toEqual({ enabled: false, provider: 'pexels' });
  });

  it('searches Pexels for a member and maps the recorded answer', async () => {
    calls.length = 0;
    const found = await rpc('social/stockPhotos/search', member, { query: 'bánh mì', locale: 'vi-VN' });
    expect(found.status).toBe(200);
    expect(found.body.total).toBe(2);
    expect(found.body.more).toBe(false);
    expect(found.body.photos.map((p: { id: number; photographer: string; pageUrl: string }) => [p.id, p.photographer, p.pageUrl])).toEqual([
      [11, 'Trần Thị B', 'https://www.pexels.com/photo/banh-mi-11/'],
      [12, 'Trần Thị B', 'https://www.pexels.com/photo/banh-mi-12/'],
    ]);
    expect(found.body.photos[0].thumb).toMatch(/^data:image\/jpeg;base64,/);
    expect(calls.map((c) => new URL(c).hostname)).toEqual(['api.pexels.com', 'images.pexels.com', 'images.pexels.com']);
    expect(JSON.stringify(found.body)).not.toContain(KEY);
  });

  it('saves a photo into the library with its credit and alt text, the saver from the session, the first credit kept', async () => {
    photos.set(11, photo(11));
    const saved = await rpc('social/stockPhotos/save', member, { photoId: 11 });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ duplicate: false, credited: true, filename: 'pexels-11.jpg', mime: 'image/jpeg', altText: 'Ổ bánh mì nóng giòn trên khay gỗ' });
    const fileId = String(saved.body.fileId);
    const rows = await admin((c) =>
      c.query(
        `SELECT f.source, f.content_type, f.filename, f.created_by AS file_by, a.provider, a.external_id, a.photographer, a.photographer_url, a.source_url, a.alt_text, a.created_by
           FROM crove_kernel.file f JOIN crove_social.media_attribution a ON a.org_id = f.org_id AND a.file_id = f.id WHERE f.org_id = $1 AND f.id = $2`,
        [org.orgId, fileId],
      ),
    );
    expect(rows.rows).toEqual([
      {
        source: 'social',
        content_type: 'image/jpeg',
        filename: 'pexels-11.jpg',
        file_by: member.userId,
        provider: 'pexels',
        external_id: '11',
        photographer: 'Trần Thị B',
        photographer_url: 'https://www.pexels.com/@tran-thi-b',
        source_url: 'https://www.pexels.com/photo/banh-mi-11/',
        alt_text: 'Ổ bánh mì nóng giòn trên khay gỗ',
        created_by: member.userId,
      },
    ]);
    // The library shows it with its credit, to everyone in the org.
    const list = await rpc('social/media/list', viewer, {});
    const item = list.body.items.find((i: { fileId: string }) => i.fileId === fileId);
    expect(item?.credit).toEqual({ provider: 'pexels', photographer: 'Trần Thị B', photographerUrl: 'https://www.pexels.com/@tran-thi-b', sourceUrl: 'https://www.pexels.com/photo/banh-mi-11/', altText: 'Ổ bánh mì nóng giòn trên khay gỗ' });
    // Another photo with the same bytes (Pexels' copy of it): the same file, and the first credit stays.
    photos.set(13, photo(13, { photographer: 'Người khác', src: { large2x: photo(11).src.large2x } }));
    const again = await rpc('social/stockPhotos/save', owner, { photoId: 13 });
    expect(again.body).toMatchObject({ fileId, duplicate: true, credited: false });
    const credit = await admin((c) => c.query('SELECT photographer, external_id FROM crove_social.media_attribution WHERE org_id = $1 AND file_id = $2', [org.orgId, fileId]));
    expect(credit.rows).toEqual([{ photographer: 'Trần Thị B', external_id: '11' }]);
    const audit = await admin((c) => c.query("SELECT actor_id, detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'social.media.save_stock' ORDER BY occurred_at, id", [org.orgId]));
    expect(audit.rows.map((r) => [r.actor_id, r.detail.external_id, r.detail.credited])).toEqual([
      [member.userId, '11', true],
      [owner.userId, '13', false],
    ]);
  });

  it('refuses a src on another host, an answer of another photo and an unknown photo, writing nothing', async () => {
    const before = await counts();
    photos.set(21, photo(21, { src: { large2x: 'https://evil.example/pexels-photo-21.jpeg' } }));
    photos.set(22, photo(22, { photographer_url: 'https://evil.example/@b' }));
    calls.length = 0;
    expect(await rpc('social/stockPhotos/save', member, { photoId: 21 })).toMatchObject({ status: 422, body: { code: 'STOCK_PHOTO_REFUSED' } });
    expect(await rpc('social/stockPhotos/save', member, { photoId: 22 })).toMatchObject({ status: 422, body: { code: 'STOCK_PHOTO_REFUSED' } });
    expect(await rpc('social/stockPhotos/save', member, { photoId: 404404 })).toMatchObject({ status: 404, body: { code: 'STOCK_PHOTO_NOT_FOUND' } });
    // Only the API was asked; no image was fetched.
    expect(calls.every((c) => new URL(c).hostname === 'api.pexels.com')).toBe(true);
    expect(await counts()).toEqual(before);
  });

  it('refuses a viewer, a non-member and a server without the key before any call to Pexels', async () => {
    photos.set(31, photo(31));
    calls.length = 0;
    const before = await counts();
    expect(await rpc('social/stockPhotos/save', viewer, { photoId: 31 })).toMatchObject({ status: 403, body: { code: 'FORBIDDEN' } });
    expect(await rpc('social/stockPhotos/search', viewer, { query: 'bánh mì' })).toMatchObject({ status: 403, body: { code: 'FORBIDDEN' } });
    expect(await rpc('social/stockPhotos/save', outsider, { photoId: 31 })).toMatchObject({ status: 403, body: { code: 'NOT_A_MEMBER' } });
    expect(await rpc('social/stockPhotos/search', member, { query: 'bánh mì' }, { app: 'off' })).toMatchObject({ status: 404, body: { code: 'STOCK_PHOTOS_DISABLED' } });
    expect(await rpc('social/stockPhotos/save', member, { photoId: 31 }, { app: 'off' })).toMatchObject({ status: 404, body: { code: 'STOCK_PHOTOS_DISABLED' } });
    expect(calls).toEqual([]);
    expect(await counts()).toEqual(before);
  });

  it('records a credit only through the command, and only with links on pexels.com', async () => {
    const actor = { type: 'user' as const, userId: member.userId, aal: 'aal1' as const };
    const store = new LocalDiskStore(dir);
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Buffer.from('a direct command call')]);
    const sha = sha256Hex(bytes);
    const key = fileKey(org.orgId, sha);
    const generation = await putFile(store, key, bytes, 'image/jpeg', sha);
    const runtime = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands, ...socialCommands], queries: [...kernelQueries({ inboundDomain: null }), ...socialQueries] });
    const file = { filename: 'pexels-41.jpg', contentType: 'image/jpeg', sizeBytes: bytes.byteLength, sha256: sha, storageKey: key, generation };
    const credit = { provider: 'pexels', externalId: '41', photographer: 'A', photographerUrl: 'https://www.pexels.com/@a', sourceUrl: 'https://www.pexels.com/photo/41/', altText: null };
    const before = await counts();
    for (const bad of [{ ...credit, photographerUrl: 'https://evil.example/@a' }, { ...credit, sourceUrl: 'javascript:alert(1)' }, { ...credit, provider: 'unsplash' }]) {
      await expect(runtime.execute('social.media.save_stock', { file, credit: bad }, { actor, orgId: org.orgId })).rejects.toMatchObject({ status: 422 });
    }
    // A viewer may not save, whatever the route.
    await expect(runtime.execute('social.media.save_stock', { file, credit }, { actor: { ...actor, userId: viewer.userId }, orgId: org.orgId })).rejects.toMatchObject({ status: 403 });
    expect(await counts()).toEqual(before);
    // The login role may not change a credit once written.
    const client = await pool.connect();
    try {
      await expect(client.query("UPDATE crove_social.media_attribution SET photographer = 'X'")).rejects.toThrow(/permission denied/);
    } finally {
      client.release();
    }
  });
});
