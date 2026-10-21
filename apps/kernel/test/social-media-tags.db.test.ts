// Tags on the Social media library on PostgreSQL 17 (issue #904): members tag library files and take tags off, each
// tag once per file whatever its case and at most 20 per file; the library filters by one tag together with the name
// search and the cursor; the org's tags are listed with counts; another org sees and tags nothing; tags go with their
// file. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { MAX_TAGS_PER_FILE, socialCommands, socialQueries, type LibraryItem, type MediaTagCount } from '@crove/mod-social';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('social media library tags on PostgreSQL (#904)', () => {
  const dbName = `crove_test_social_media_tags_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  type Org = { orgId: string; owner: string; member: string; viewer: string };
  type Tagged = { fileId: string; tags: string[] };

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  const person = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@tags.test`, name: null });

  async function org(): Promise<Org> {
    const owner = await person('owner');
    const member = await person('member');
    const viewer = await person('viewer');
    const { orgId } = await createOrg(rt, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    await admin((c) => c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'viewer')", [orgId, member, viewer]));
    return { orgId, owner, member, viewer };
  }

  // A stored file as the upload route records it, created at a given time.
  async function file(o: Org, filename: string, options: { source?: string; at?: string } = {}) {
    const id = randomUUID();
    const sha = createHash('sha256').update(id).digest('hex');
    await admin((c) =>
      c.query(
        `INSERT INTO crove_kernel.file (org_id, id, sha256, storage_key, generation, filename, content_type, size_bytes, source, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'image/jpeg', 120000, $7, coalesce($8::timestamptz, now()))`,
        [o.orgId, id, sha, `org/${o.orgId}/${sha}`, `content:${sha}`, filename, options.source ?? 'social', options.at ?? null],
      ),
    );
    return id;
  }

  const tag = (o: Org, fileId: string, tags: string[], who = o.member) => rt.execute<Tagged>('social.media.tag', { fileId, tags }, { actor: asUser(who), orgId: o.orgId });
  const untag = (o: Org, fileId: string, tags: string[], who = o.member) => rt.execute<Tagged>('social.media.untag', { fileId, tags }, { actor: asUser(who), orgId: o.orgId });
  const list = (o: Org, input: Record<string, unknown> = {}) => rt.query<{ items: LibraryItem[]; more: boolean }>('social.media.list', input, { actor: asUser(o.viewer), orgId: o.orgId });
  const tags = (o: Org) => rt.query<MediaTagCount[]>('social.media.tags', {}, { actor: asUser(o.viewer), orgId: o.orgId });

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
    rt = new Runtime(db).register({ commands: [...kernelCommands, ...socialCommands], queries: [...kernelQueries({ inboundDomain: null }), ...socialQueries] });
  });

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('tags a file with normalized tags, each once whatever its case, and takes tags off', async () => {
    const o = await org();
    const f = await file(o, 'ao-dai.jpg');
    expect(await tag(o, f, ['  Áo   dài ', 'Tết', 'tết', 'Khách A'])).toEqual({ fileId: f, tags: ['Áo dài', 'Khách A', 'Tết'] });
    // A tag the file has in another case is left as it is.
    expect((await tag(o, f, ['TẾT', 'Mùa hè'], o.owner)).tags).toEqual(['Áo dài', 'Khách A', 'Mùa hè', 'Tết']);
    expect((await list(o)).items.map((i) => i.tags)).toEqual([['Áo dài', 'Khách A', 'Mùa hè', 'Tết']]);

    expect((await untag(o, f, ['tết', 'không có'])).tags).toEqual(['Áo dài', 'Khách A', 'Mùa hè']);
    const audit = await admin((c) => c.query("SELECT command, target_type, detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command LIKE 'social.media.%' ORDER BY occurred_at, id", [o.orgId]));
    expect(audit.rows.map((r) => [r.command, r.target_type, r.detail.file_id, r.detail.added ?? r.detail.removed])).toEqual([
      ['social.media.tag', 'kernel.file', f, 3],
      ['social.media.tag', 'kernel.file', f, 1],
      ['social.media.untag', 'kernel.file', f, 1],
    ]);
  });

  it('refuses viewers, empty or long tags, and a file outside the library', async () => {
    const o = await org();
    const f = await file(o, 'a.jpg');
    await expect(tag(o, f, ['Tết'], o.viewer)).rejects.toMatchObject({ status: 403 });
    await expect(untag(o, f, ['Tết'], o.viewer)).rejects.toMatchObject({ status: 403 });
    await expect(tag(o, f, ['   '])).rejects.toMatchObject({ status: 422 });
    await expect(tag(o, f, ['x'.repeat(41)])).rejects.toMatchObject({ status: 422 });
    await expect(tag(o, f, [])).rejects.toMatchObject({ status: 422 });
    // An accounting document is not a library item.
    const invoice = await file(o, 'hoa-don.jpg', { source: 'upload' });
    await expect(tag(o, invoice, ['Tết'])).rejects.toMatchObject({ status: 404, code: 'MEDIA_NOT_FOUND' });
    await expect(tag(o, randomUUID(), ['Tết'])).rejects.toMatchObject({ status: 404, code: 'MEDIA_NOT_FOUND' });
  });

  it(`caps a file at ${MAX_TAGS_PER_FILE} tags`, async () => {
    const o = await org();
    const f = await file(o, 'nhieu-the.jpg');
    const many = Array.from({ length: MAX_TAGS_PER_FILE }, (_, i) => `the-${String(i).padStart(2, '0')}`);
    expect((await tag(o, f, many)).tags).toHaveLength(MAX_TAGS_PER_FILE);
    await expect(tag(o, f, ['mot-the-nua'])).rejects.toMatchObject({ status: 409, code: 'MEDIA_TAG_LIMIT' });
    // A tag the file already has adds nothing, so it passes at the cap.
    expect((await tag(o, f, ['THE-00'])).tags).toHaveLength(MAX_TAGS_PER_FILE);
    await untag(o, f, ['the-00']);
    expect((await tag(o, f, ['mot-the-nua'])).tags).toHaveLength(MAX_TAGS_PER_FILE);
    const rows = await admin((c) => c.query('SELECT count(*)::int AS n FROM crove_social.media_tag WHERE org_id = $1 AND file_id = $2', [o.orgId, f]));
    expect(rows.rows[0].n).toBe(MAX_TAGS_PER_FILE);
  });

  it('filters by one tag whatever its case, together with the name search and the cursor', async () => {
    const o = await org();
    const files: string[] = [];
    for (let i = 0; i < 5; i++) files.push(await file(o, `tet-${i}.jpg`, { at: `2026-10-0${i + 1}T08:00:00Z` }));
    const other = await file(o, 'he-1.jpg', { at: '2026-10-08T08:00:00Z' });
    const plain = await file(o, 'tet-khong-the.jpg', { at: '2026-10-09T08:00:00Z' });
    for (const f of files) await tag(o, f, ['Tết 2027']);
    await tag(o, other, ['Mùa hè']);
    await tag(o, files[2] as string, ['Khách A']);

    expect((await list(o, { tag: 'tết  2027 ' })).items.map((i) => i.filename)).toEqual(['tet-4.jpg', 'tet-3.jpg', 'tet-2.jpg', 'tet-1.jpg', 'tet-0.jpg']);
    expect((await list(o, { tag: 'khách a' })).items.map((i) => [i.filename, i.tags])).toEqual([['tet-2.jpg', ['Khách A', 'Tết 2027']]]);
    expect((await list(o, { tag: 'TẾT 2027', search: 'TET-3' })).items.map((i) => i.filename)).toEqual(['tet-3.jpg']);
    // The name alone still finds the untagged file; with the tag it does not.
    expect((await list(o, { search: 'khong-the' })).items.map((i) => i.fileId)).toEqual([plain]);
    expect((await list(o, { search: 'khong-the', tag: 'Tết 2027' })).items).toEqual([]);
    expect((await list(o, { tag: 'không có' })).items).toEqual([]);

    const first = await list(o, { tag: 'Tết 2027', limit: 3 });
    expect([first.items.map((i) => i.filename), first.more]).toEqual([['tet-4.jpg', 'tet-3.jpg', 'tet-2.jpg'], true]);
    const last = first.items.at(-1) as LibraryItem;
    const next = await list(o, { tag: 'Tết 2027', limit: 3, before: { createdAt: last.createdAt, fileId: last.fileId } });
    expect([next.items.map((i) => i.filename), next.more]).toEqual([['tet-1.jpg', 'tet-0.jpg'], false]);
  });

  it('lists the org tags with how many files carry each, most used first, spellings in another case as one', async () => {
    const o = await org();
    const a = await file(o, 'a.jpg');
    const b = await file(o, 'b.jpg');
    const c = await file(o, 'c.jpg');
    await tag(o, a, ['Tết', 'Áo dài']);
    await tag(o, b, ['TẾT', 'Khách A']);
    await tag(o, c, ['tết', 'Áo dài']);
    const counted = await tags(o);
    expect(counted.map((x) => [x.tag.toLowerCase(), x.files])).toEqual([
      ['tết', 3],
      ['áo dài', 2],
      ['khách a', 1],
    ]);
    expect(await tags(await org())).toEqual([]);
  });

  it('lets another org neither see nor tag the files and tags', async () => {
    const a = await org();
    const b = await org();
    const theirs = await file(b, 'cua-b.jpg');
    await tag(b, theirs, ['Bí mật']);
    await expect(tag(a, theirs, ['Của A'])).rejects.toMatchObject({ status: 404, code: 'MEDIA_NOT_FOUND' });
    await expect(untag(a, theirs, ['Bí mật'])).rejects.toMatchObject({ status: 404, code: 'MEDIA_NOT_FOUND' });
    expect(await tags(a)).toEqual([]);
    expect((await list(a, { tag: 'Bí mật' })).items).toEqual([]);
    expect((await list(b, { tag: 'bí mật' })).items.map((i) => [i.fileId, i.tags])).toEqual([[theirs, ['Bí mật']]]);
  });

  it('removes the tags with their file', async () => {
    const o = await org();
    const gone = await file(o, 'xoa.jpg');
    const kept = await file(o, 'giu.jpg');
    await tag(o, gone, ['Tết', 'Khách A']);
    await tag(o, kept, ['Tết']);
    await admin((c) => c.query('DELETE FROM crove_kernel.file WHERE org_id = $1 AND id = $2', [o.orgId, gone]));
    const rows = await admin((c) => c.query('SELECT file_id, tag FROM crove_social.media_tag WHERE org_id = $1 ORDER BY tag', [o.orgId]));
    expect(rows.rows).toEqual([{ file_id: kept, tag: 'Tết' }]);
    expect((await tags(o)).map((x) => [x.tag, x.files])).toEqual([['Tết', 1]]);
  });
});
