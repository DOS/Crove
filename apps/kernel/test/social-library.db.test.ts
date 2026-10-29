// The Social media library on PostgreSQL 17 (Social plan S9, issue #395): the org's post images only, newest first and
// paged, searchable by name with wildcards taken literally, each with the posts that show it, and nothing of another
// org. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { socialCommands, socialQueries, type LibraryItem, type LibraryUse } from '@crove/mod-social';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('social media library on PostgreSQL (S9)', () => {
  const dbName = `crove_test_social_library_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  type Org = { orgId: string; owner: string; viewer: string };

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  const person = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@library.test`, name: null });

  async function org(): Promise<Org> {
    const owner = await person('owner');
    const viewer = await person('viewer');
    const { orgId } = await createOrg(rt, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    await admin((c) => c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'viewer')", [orgId, viewer]));
    return { orgId, owner, viewer };
  }

  async function connection(o: Org) {
    const id = randomUUID();
    await admin((c) =>
      c.query('INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, $3, $4, $5, $6)', [
        o.orgId,
        id,
        'sandbox',
        `acct-${id.slice(0, 8)}`,
        'Kênh thử',
        o.owner,
      ]),
    );
    return id;
  }

  // A stored file as the upload route records it, created at a given time.
  async function file(o: Org, filename: string, options: { source?: string; contentType?: string; at?: string } = {}) {
    const id = randomUUID();
    const sha = createHash('sha256').update(id).digest('hex');
    await admin((c) =>
      c.query(
        `INSERT INTO crove_kernel.file (org_id, id, sha256, storage_key, generation, filename, content_type, size_bytes, source, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 120000, $8, coalesce($9::timestamptz, now()))`,
        [o.orgId, id, sha, `org/${o.orgId}/${sha}`, `content:${sha}`, filename, options.contentType ?? 'image/jpeg', options.source ?? 'social', options.at ?? null],
      ),
    );
    return id;
  }

  const list = (o: Org, input: Record<string, unknown> = {}) => rt.query<{ items: LibraryItem[]; more: boolean }>('social.media.list', input, { actor: asUser(o.viewer), orgId: o.orgId });
  const usage = (o: Org, fileId: string) => rt.query<LibraryUse[]>('social.media.usage', { fileId }, { actor: asUser(o.viewer), orgId: o.orgId });

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
    rt = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands, ...socialCommands], queries: [...kernelQueries({ inboundDomain: null }), ...socialQueries] });
  });

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('lists the post images of the org newest first, with how many posts show each', async () => {
    const o = await org();
    const old = await file(o, 'mat-tien.jpg', { at: '2026-10-01T08:00:00Z' });
    const fresh = await file(o, 'khuyen-mai.png', { contentType: 'image/png', at: '2026-10-10T08:00:00Z' });
    // An accounting document and another kind of file are not post images.
    await file(o, 'hoa-don.jpg', { source: 'upload' });
    await file(o, 'ghi-chu.xml', { contentType: 'application/xml' });
    const conn = await connection(o);
    await rt.execute('social.post.create', { body: 'Khai trương', media: [{ fileId: old }], channels: [{ connectionId: conn }] }, { actor: asUser(o.owner), orgId: o.orgId });
    const { postId: second } = await rt.execute<{ postId: string }>('social.post.create', { body: 'Tuần lễ vàng', media: [{ fileId: old }, { fileId: fresh }], channels: [{ connectionId: await connection(o) }] }, { actor: asUser(o.owner), orgId: o.orgId });

    const page = await list(o);
    expect(page.more).toBe(false);
    expect(page.items.map((i) => [i.filename, i.mime, i.usedIn])).toEqual([
      ['khuyen-mai.png', 'image/png', 1],
      ['mat-tien.jpg', 'image/jpeg', 2],
    ]);
    expect((await usage(o, fresh)).map((u) => [u.postId, u.excerpt])).toEqual([[second, 'Tuần lễ vàng']]);
    expect(await usage(o, old)).toHaveLength(2);
  });

  it('counts an image a channel went out with, though the post no longer has it', async () => {
    const o = await org();
    const kept = await file(o, 'cu.jpg');
    const conn = await connection(o);
    const { postId } = await rt.execute<{ postId: string }>('social.post.create', { body: 'Bài', channels: [{ connectionId: conn }] }, { actor: asUser(o.owner), orgId: o.orgId });
    await admin((c) =>
      c.query('UPDATE crove_social.post_variant SET media = $2::jsonb WHERE post_id = $1', [postId, JSON.stringify([{ fileId: kept, generation: null, altText: null, mime: 'image/jpeg', sizeBytes: 120000 }])]),
    );
    expect((await list(o)).items.map((i) => i.usedIn)).toEqual([1]);
    expect((await usage(o, kept)).map((u) => u.postId)).toEqual([postId]);
  });

  it('searches by name with wildcards taken literally, and pages with a cursor', async () => {
    const o = await org();
    for (let i = 0; i < 5; i++) await file(o, `anh-${i}.jpg`, { at: `2026-10-0${i + 1}T08:00:00Z` });
    await file(o, '100%_giam.jpg', { at: '2026-10-09T08:00:00Z' });
    expect((await list(o, { search: 'ANH-3' })).items.map((i) => i.filename)).toEqual(['anh-3.jpg']);
    expect((await list(o, { search: '%' })).items.map((i) => i.filename)).toEqual(['100%_giam.jpg']);
    expect((await list(o, { search: '_' })).items.map((i) => i.filename)).toEqual(['100%_giam.jpg']);

    const first = await list(o, { limit: 4 });
    expect([first.items.length, first.more]).toEqual([4, true]);
    const last = first.items.at(-1) as LibraryItem;
    const next = await list(o, { limit: 4, before: { createdAt: last.createdAt, fileId: last.fileId } });
    expect([next.items.map((i) => i.filename), next.more]).toEqual([['anh-1.jpg', 'anh-0.jpg'], false]);
  });

  it('lists a PDF for a LinkedIn document with the images, but never an accounting one (#1119)', async () => {
    const o = await org();
    await file(o, 'anh.jpg', { at: '2026-10-01T08:00:00Z' });
    await file(o, 'bao-gia-q4.pdf', { contentType: 'application/pdf', at: '2026-10-02T08:00:00Z' });
    await file(o, 'hoa-don.pdf', { contentType: 'application/pdf', source: 'upload', at: '2026-10-03T08:00:00Z' });
    expect((await list(o)).items.map((i) => [i.filename, i.mime])).toEqual([
      ['bao-gia-q4.pdf', 'application/pdf'],
      ['anh.jpg', 'image/jpeg'],
    ]);
  });

  it('shows nothing of another org', async () => {
    const a = await org();
    const b = await org();
    const theirs = await file(b, 'cua-b.jpg');
    await file(a, 'cua-a.jpg');
    expect((await list(a)).items.map((i) => i.filename)).toEqual(['cua-a.jpg']);
    expect(await usage(a, theirs)).toEqual([]);
  });
});
