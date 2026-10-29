// An org's link-in-bio page on PostgreSQL 17 (#707): owners and admins save one page; the public definers show a
// published page of an active org and nothing else (no button link, no file key), follow its buttons and posts while
// counting people only, and hand out only the files the page shows. Set CROVE_TEST_ADMIN_URL to a superuser URL; each
// run makes its own database.
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { socialCommands, socialQueries, type BioPage } from '@crove/mod-social';
import { bioGo, bioView, renderBioPage } from '../src/bio-page.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('social link-in-bio page on PostgreSQL (#707)', () => {
  const dbName = `crove_test_social_bio_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let rt: Runtime;
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

  async function person(name: string) {
    return upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@social.test`, name: null });
  }

  type Org = { orgId: string; owner: string; admin: string; member: string; other: string; viewer: string; };
  async function org(): Promise<Org> {
    const owner = await person('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    const roles = { admin: await person('admin'), member: await person('member'), other: await person('other'), viewer: await person('viewer') };
    const role = { admin: 'admin', member: 'member', other: 'member', viewer: 'viewer' } as const;
    for (const [key, id] of Object.entries(roles)) {
      await admin((c) => c.query('INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, $3)', [orgId, id, role[key as keyof typeof role]]));
    }
    return { orgId, owner, ...roles };
  }

  async function connection(orgId: string, owner: string) {
    const id = randomUUID();
    await admin((c) =>
      c.query(
        'INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, $3, $4, $5, $6)',
        [orgId, id, 'sandbox', `acct-${id.slice(0, 8)}`, 'Kênh thử', owner],
      ),
    );
    return id;
  }

  const exec = <O>(o: Org, user: string, name: string, input: unknown) => rt.execute<O>(name, input, { actor: asUser(user), orgId: o.orgId });

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
    pool = createPool({ connectionString: app.toString(), max: 4 });
    db = createDb(pool);
    const registry = { commands: [...kernelCommands, ...socialCommands], queries: [...kernelQueries({ inboundDomain: null }), ...socialQueries] };
    rt = new Runtime(db, { manifests: TEST_MANIFESTS }).register(registry);
  });

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  async function socialFile(orgId: string, owner: string, type = 'image/jpeg') {
    const id = randomUUID();
    const sha = createHash('sha256').update(id).digest('hex');
    await admin((c) =>
      c.query("INSERT INTO crove_kernel.file (org_id, id, sha256, storage_key, generation, filename, content_type, size_bytes, source, created_by) VALUES ($1, $2, $3, $4, $5, 'anh.jpg', $6, 1000, 'social', $7)", [orgId, id, sha, `org/${orgId}/${sha}`, `content:${sha}`, type, owner]),
    );
    return id;
  }
  const save = (o: Org, user: string, input: Record<string, unknown>) => exec<{ pageId: string; slug: string }>(o, user, 'social.bio.save', input);
  const page = (o: Org, user: string) => rt.query<BioPage | null>('social.bio.get', {}, { actor: asUser(user), orgId: o.orgId });
  // As the API login role, the one the public routes use.
  const fileOf = async (slug: string, fileId: string) => (await pool.query<{ storage_key: string }>('SELECT storage_key FROM crove_social.bio_page_file($1, $2::uuid)', [slug, fileId])).rows;

  it('saves one page per org, shows it only when published, and nothing of it but what it shows', async () => {
    const o = await org();
    const avatar = await socialFile(o.orgId, o.owner);
    const input = { slug: 'tiem-banh', title: 'Tiệm Bánh <B>', about: 'Bánh mỗi ngày', avatarFileId: avatar, buttons: [{ label: 'Đặt bánh', url: 'https://tiembanh.example/dat' }, { label: 'Zalo', url: 'https://zalo.me/0900000000' }], showPosts: true, published: false };
    await expect(save(o, o.member, input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await save(o, o.admin, input);
    expect(await bioView(rt, 'tiem-banh')).toBeNull();
    await save(o, o.owner, { ...input, published: true });
    const view = await bioView(rt, 'tiem-banh');
    expect(view).toEqual({ title: 'Tiệm Bánh <B>', about: 'Bánh mỗi ngày', avatar: true, avatarId: avatar, buttons: [{ label: 'Đặt bánh' }, { label: 'Zalo' }], posts: [] });
    expect(JSON.stringify(view)).not.toContain('tiembanh.example');
    const html = renderBioPage('tiem-banh', view as NonNullable<typeof view>);
    expect(html).toContain('Tiệm Bánh &lt;B&gt;');
    expect(html).toContain('href="/b/tiem-banh/go/button:0"');
    expect(html).not.toContain('<script');

    // Another org cannot take the slug; a reserved word is refused.
    const b = await org();
    await expect(save(b, b.owner, { ...input, avatarFileId: null })).rejects.toMatchObject({ code: 'BIO_SLUG_TAKEN' });
    await expect(save(b, b.owner, { ...input, avatarFileId: null, slug: 'api' })).rejects.toThrow();
    // Another org's file is not an avatar.
    await expect(save(b, b.owner, { ...input, slug: 'cua-hang-b', avatarFileId: avatar })).rejects.toMatchObject({ code: 'MEDIA_NOT_FOUND' });
  });

  it('follows buttons and shown posts, counting people only, and hands out only the files it shows', async () => {
    const o = await org();
    const conn = await connection(o.orgId, o.owner);
    const avatar = await socialFile(o.orgId, o.owner);
    const other = await socialFile(o.orgId, o.owner);
    const image = await socialFile(o.orgId, o.owner);
    const { postId } = await exec<{ postId: string }>(o, o.owner, 'social.post.create', { body: 'Bánh mới', linkUrl: 'https://tiembanh.example/moi', media: [{ fileId: image }], channels: [{ connectionId: conn }] });
    await admin((c) => c.query("UPDATE crove_social.post_variant SET status = 'published', published_at = now(), external_url = 'https://social.example/p/1' WHERE post_id = $1", [postId]));
    await save(o, o.owner, { slug: 'bio-tiem', title: 'Tiệm', avatarFileId: avatar, buttons: [{ label: 'Website', url: 'https://tiembanh.example/' }], showPosts: true, published: true });
    const view = await bioView(rt, 'bio-tiem');
    expect(view?.posts).toEqual([{ postId, fileId: image, excerpt: 'Bánh mới', linked: true }]);

    expect(await bioGo(rt, 'bio-tiem', 'button:0', 'Mozilla/5.0')).toBe('https://tiembanh.example/');
    expect(await bioGo(rt, 'bio-tiem', 'button:0', 'facebookexternalhit/1.1')).toBe('https://tiembanh.example/');
    // Zalo's in-app browser is a person; WhatsApp's link preview fetcher is not.
    expect(await bioGo(rt, 'bio-tiem', 'button:0', 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36 Zalo android/12345 ZaloTheme/light')).toBe('https://tiembanh.example/');
    expect(await bioGo(rt, 'bio-tiem', 'button:0', 'WhatsApp/2.23.20.0 A')).toBe('https://tiembanh.example/');
    expect(await bioGo(rt, 'bio-tiem', `post:${postId}`, 'Mozilla/5.0')).toBe('https://tiembanh.example/moi');
    expect(await bioGo(rt, 'bio-tiem', 'button:5', 'Mozilla/5.0')).toBeNull();
    expect(await bioGo(rt, 'bio-tiem', `post:${randomUUID()}`, 'Mozilla/5.0')).toBeNull();
    expect(await bioGo(rt, 'khong-co', 'button:0', 'Mozilla/5.0')).toBeNull();
    expect((await page(o, o.viewer))?.clicks).toEqual({ 'button:0': 2, [`post:${postId}`]: 1 });

    // Files: the avatar and the shown post's image, nothing else of the org; none once the page is hidden.
    expect((await fileOf('bio-tiem', avatar)).length).toBe(1);
    expect((await fileOf('bio-tiem', image)).length).toBe(1);
    expect(await fileOf('bio-tiem', other)).toEqual([]);
    await save(o, o.owner, { slug: 'bio-tiem', title: 'Tiệm', avatarFileId: avatar, buttons: [], showPosts: false, published: true });
    expect(await fileOf('bio-tiem', image)).toEqual([]);
    expect(await bioGo(rt, 'bio-tiem', `post:${postId}`, 'Mozilla/5.0')).toBeNull();
    await save(o, o.owner, { slug: 'bio-tiem', title: 'Tiệm', avatarFileId: avatar, buttons: [], showPosts: false, published: false });
    expect(await fileOf('bio-tiem', avatar)).toEqual([]);
    // The API role cannot write clicks; only the definer does.
    await expect(pool.query("INSERT INTO crove_social.bio_click (org_id, page_id, target, day) SELECT org_id, id, 'button:0', current_date FROM crove_social.bio_page")).rejects.toMatchObject({ code: '42501' });
  });
});
