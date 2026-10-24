// Archived media library files on PostgreSQL 17 (#1302), and the channel limits on every command that attaches files
// (#1273). Members archive and restore up to 100 files at once; an archived file leaves the library's list and its
// pickers (usable), is listed alone when asked for, and comes back on restore. Every attach path refuses an archived
// file, and another channel's own media for a member limited to some channels (#1081), with 403 MEDIA_NOT_ALLOWED: the
// post create and update, the variant update (its media and its cover), add channels, duplicate, drafts from media, the
// CSV import, the AI draft's photos and the CSV import's file names. A post that already uses an archived file keeps
// it: edits that keep it, a bulk add channel and a submit still work. Set CROVE_TEST_ADMIN_URL to a superuser URL; each
// run makes its own database.
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { socialCommands, socialQueries, type LibraryItem } from '@crove/mod-social';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('archived media library files and the attach checks (#1302, #1273)', () => {
  const dbName = `crove_test_social_media_archive_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  // A member limited to the channel mine (#1081); other is a channel they may not use.
  type Org = { orgId: string; owner: string; member: string; limited: string; viewer: string; mine: string; other: string };
  const NOT_ALLOWED = { code: 'MEDIA_NOT_ALLOWED', status: 403 };
  const archivedRefusal = (fileId: string) => ({ ...NOT_ALLOWED, details: { fileId, reason: 'archived' } });
  const hiddenRefusal = (fileId: string) => ({ ...NOT_ALLOWED, details: { fileId, reason: 'channel' } });

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  const person = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@archive.test`, name: null });

  async function connection(orgId: string, owner: string) {
    const id = randomUUID();
    await admin((c) =>
      c.query('INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, $3, $4, $5, $6)', [
        orgId,
        id,
        'sandbox',
        `acct-${id.slice(0, 8)}`,
        'Kênh thử',
        owner,
      ]),
    );
    return id;
  }

  async function org(): Promise<Org> {
    const owner = await person('owner');
    const member = await person('member');
    const limited = await person('limited');
    const viewer = await person('viewer');
    const { orgId } = await createOrg(rt, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    await admin((c) =>
      c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member'), ($1, $4, 'viewer')", [orgId, member, limited, viewer]),
    );
    const mine = await connection(orgId, owner);
    const other = await connection(orgId, owner);
    await admin((c) => c.query('INSERT INTO crove_social.channel_access (org_id, user_id, channel_connection_id, created_by) VALUES ($1, $2, $3, $4)', [orgId, limited, mine, owner]));
    return { orgId, owner, member, limited, viewer, mine, other };
  }

  // A stored Social file as the upload route records it.
  async function file(o: Org, filename: string, options: { source?: string; contentType?: string } = {}) {
    const id = randomUUID();
    const sha = createHash('sha256').update(id).digest('hex');
    await admin((c) =>
      c.query(
        `INSERT INTO crove_kernel.file (org_id, id, sha256, storage_key, generation, filename, content_type, size_bytes, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 120000, $8)`,
        [o.orgId, id, sha, `org/${o.orgId}/${sha}`, `content:${sha}`, filename, options.contentType ?? 'image/jpeg', options.source ?? 'social'],
      ),
    );
    return id;
  }

  const exec = <T = any>(o: Org, who: string, command: string, input: unknown) => rt.execute<T>(command, input, { actor: asUser(who), orgId: o.orgId });
  const query = <T = any>(o: Org, who: string, name: string, input: unknown) => rt.query<T>(name, input, { actor: asUser(who), orgId: o.orgId });
  const archive = (o: Org, fileIds: string[], who = o.member) => exec<{ archived: string[] }>(o, who, 'social.media.archive', { fileIds });
  const restore = (o: Org, fileIds: string[], who = o.member) => exec<{ restored: string[] }>(o, who, 'social.media.restore', { fileIds });
  const list = (o: Org, input: Record<string, unknown> = {}, who = o.member) => query<{ items: LibraryItem[] }>(o, who, 'social.media.list', input);
  const names = async (o: Org, input: Record<string, unknown> = {}, who = o.member) => (await list(o, input, who)).items.map((i) => i.filename).sort();
  const marks = (o: Org) => admin(async (c) => Number((await c.query<{ n: string }>('SELECT count(*) AS n FROM crove_social.media_archive WHERE org_id = $1', [o.orgId])).rows[0]?.n));
  const posts = (o: Org) => admin(async (c) => Number((await c.query<{ n: string }>('SELECT count(*) AS n FROM crove_social.post WHERE org_id = $1', [o.orgId])).rows[0]?.n));
  const create = (o: Org, who: string, input: Record<string, unknown>) => exec<{ postId: string; revision: number; variants: Array<{ variantId: string; connectionId: string }> }>(o, who, 'social.post.create', input);
  const revisionOf = (o: Org, table: 'post' | 'post_variant', id: string) =>
    admin(async (c) => Number((await c.query<{ revision: number }>(`SELECT revision FROM crove_social.${table} WHERE org_id = $1 AND id = $2`, [o.orgId, id])).rows[0]?.revision));

  // A post on the channel other with its own media only: for the limited member, another channel's own media (#1081).
  async function hiddenOwn(o: Org) {
    const hidden = await file(o, 'rieng-kenh-khac.jpg');
    const { variants } = await create(o, o.owner, { body: 'Bài kênh khác', channels: [{ connectionId: o.other, media: [{ fileId: hidden }] }] });
    expect(variants).toHaveLength(1);
    return hidden;
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

  it('takes files out of the library and its pickers, lists them alone when asked, and restores them', async () => {
    const o = await org();
    const a = await file(o, 'a-hong.jpg');
    const b = await file(o, 'b-mo.jpg');
    await file(o, 'c-giu.jpg');

    expect(await archive(o, [a, b])).toEqual({ archived: [a, b] });
    expect(await names(o)).toEqual(['c-giu.jpg']);
    expect(await names(o, { usable: true })).toEqual(['c-giu.jpg']);
    // usable never lists an archived file, even with archived.
    expect(await names(o, { usable: true, archived: true })).toEqual(['c-giu.jpg']);
    const archived = (await list(o, { archived: true })).items;
    expect(archived.map((i) => i.filename).sort()).toEqual(['a-hong.jpg', 'b-mo.jpg']);
    expect(archived.every((i) => typeof i.archivedAt === 'string')).toBe(true);
    expect((await list(o)).items.map((i) => i.archivedAt)).toEqual([null]);

    // Archiving again changes nothing; restoring a file not archived neither.
    expect(await archive(o, [a])).toEqual({ archived: [] });
    expect(await restore(o, [a])).toEqual({ restored: [a] });
    expect(await restore(o, [a])).toEqual({ restored: [] });
    expect(await names(o)).toEqual(['a-hong.jpg', 'c-giu.jpg']);
    expect(await names(o, { archived: true })).toEqual(['b-mo.jpg']);
    expect(await marks(o)).toBe(1);

    const audit = await admin((c) =>
      c.query("SELECT command, detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command IN ('social.media.archive', 'social.media.restore') ORDER BY occurred_at, id", [o.orgId]),
    );
    expect(audit.rows.map((r) => [r.command, r.detail.file_ids])).toEqual([
      ['social.media.archive', [a, b]],
      ['social.media.archive', []],
      ['social.media.restore', [a]],
      ['social.media.restore', []],
    ]);
  });

  it('archives for members and above only, library files only, up to 100 at once', async () => {
    const o = await org();
    const f = await file(o, 'anh.jpg');
    await expect(archive(o, [f], o.viewer)).rejects.toMatchObject({ status: 403 });
    await expect(restore(o, [f], o.viewer)).rejects.toMatchObject({ status: 403 });
    // An accounting upload, another org's file and an unknown id are not library files: nothing is written.
    const document = await file(o, 'hoa-don.jpg', { source: 'upload' });
    const theirs = await file(await org(), 'cua-org-khac.jpg');
    for (const id of [document, theirs, randomUUID()]) {
      await expect(archive(o, [f, id])).rejects.toMatchObject({ code: 'MEDIA_NOT_FOUND', status: 404, details: { fileId: id } });
    }
    expect(await marks(o)).toBe(0);
    await expect(archive(o, Array.from({ length: 101 }, () => randomUUID()))).rejects.toMatchObject({ status: 422 });
    await expect(archive(o, [f, f])).rejects.toMatchObject({ status: 422 });
    expect(await archive(o, [f], o.owner)).toEqual({ archived: [f] });
  });

  it("keeps a limited member from archiving or restoring another channel's own media", async () => {
    const o = await org();
    const hidden = await hiddenOwn(o);
    const shared = await file(o, 'chung.jpg');
    await expect(archive(o, [shared, hidden], o.limited)).rejects.toMatchObject(hiddenRefusal(hidden));
    expect(await marks(o)).toBe(0);
    expect(await archive(o, [shared], o.limited)).toEqual({ archived: [shared] });
    await archive(o, [hidden], o.owner);
    await expect(restore(o, [hidden], o.limited)).rejects.toMatchObject(hiddenRefusal(hidden));
    expect(await restore(o, [shared], o.limited)).toEqual({ restored: [shared] });
  });

  it('refuses an archived file on create, update, variant update, cover and add channels, and keeps one already attached', async () => {
    const o = await org();
    const kept = await file(o, 'dang-dung.jpg');
    const gone = await file(o, 'luu-tru.jpg');
    const fresh = await file(o, 'moi.jpg');
    const { postId, revision, variants } = await create(o, o.member, { body: 'Khai trương', media: [{ fileId: kept }], channels: [{ connectionId: o.mine }] });
    const variantId = (variants[0] as { variantId: string }).variantId;
    await archive(o, [kept, gone]);
    const before = await posts(o);

    // Create: as the post's media or as a channel's own.
    await expect(create(o, o.member, { body: 'Bài mới', media: [{ fileId: gone }], channels: [{ connectionId: o.mine }] })).rejects.toMatchObject(archivedRefusal(gone));
    await expect(create(o, o.member, { body: 'Bài mới', channels: [{ connectionId: o.mine, media: [{ fileId: gone }] }] })).rejects.toMatchObject(archivedRefusal(gone));
    expect(await posts(o)).toBe(before);

    // Update: a file the post holds stays, even archived; a new archived one is refused.
    await expect(exec(o, o.member, 'social.post.update', { postId, revision, media: [{ fileId: kept }, { fileId: gone }] })).rejects.toMatchObject(archivedRefusal(gone));
    const updated = await exec<{ revision: number }>(o, o.member, 'social.post.update', { postId, revision, body: 'Khai trương lớn', media: [{ fileId: kept, altText: 'Mặt tiền' }, { fileId: fresh }] });
    expect(updated.revision).toBe(revision + 1);

    // Variant update: the files the channel shows now stay; a new archived one, or an archived cover, is refused.
    const vRevision = await revisionOf(o, 'post_variant', variantId);
    await expect(exec(o, o.member, 'social.variant.update', { variantId, revision: vRevision, media: [{ fileId: gone }] })).rejects.toMatchObject(archivedRefusal(gone));
    await expect(exec(o, o.member, 'social.variant.update', { variantId, revision: vRevision, settings: { cover: { fileId: gone } } })).rejects.toMatchObject(archivedRefusal(gone));
    await exec(o, o.member, 'social.variant.update', { variantId, revision: vRevision, media: [{ fileId: kept }] });

    // Add channels: a channel's own archived file is refused; the post's own archived file may be repeated.
    await expect(exec(o, o.member, 'social.post.add_channels', { postId, channels: [{ connectionId: o.other, media: [{ fileId: gone }] }] })).rejects.toMatchObject(archivedRefusal(gone));
    await exec(o, o.member, 'social.post.add_channels', { postId, channels: [{ connectionId: o.other, media: [{ fileId: kept }] }] });

    // A restored file attaches again.
    await restore(o, [gone]);
    await create(o, o.member, { body: 'Bài mới', media: [{ fileId: gone }], channels: [{ connectionId: o.mine }] });
  });

  it('refuses a duplicate of a post whose files are archived, and keeps the post itself working', async () => {
    const o = await org();
    const shared = await file(o, 'chung.jpg');
    const own = await file(o, 'rieng.jpg');
    const { postId, variants } = await create(o, o.member, { body: 'Tuần lễ vàng', media: [{ fileId: shared }], channels: [{ connectionId: o.mine }, { connectionId: o.other, media: [{ fileId: own }] }] });
    await archive(o, [own]);
    const before = await posts(o);
    await expect(exec(o, o.member, 'social.post.duplicate', { postId })).rejects.toMatchObject(archivedRefusal(own));
    expect(await posts(o)).toBe(before);

    // The post that uses the archived file still goes to review, and a bulk add channel still adds a channel to it.
    const third = await connection(o.orgId, o.owner);
    const added = await exec<{ done: string[] }>(o, o.member, 'social.post.bulk_add_channel', { postIds: [postId], connectionId: third });
    expect(added.done).toEqual([postId]);
    await exec(o, o.member, 'social.post.submit', { postId, variantIds: variants.map((v) => v.variantId) });
    const statuses = await admin(async (c) => (await c.query<{ status: string; media: unknown }>('SELECT status, media FROM crove_social.post_variant WHERE org_id = $1 AND post_id = $2 AND channel_connection_id = $3', [o.orgId, postId, o.other])).rows);
    expect(statuses).toHaveLength(1);
    expect(statuses[0]?.status).not.toBe('draft');
    expect(JSON.stringify(statuses[0]?.media)).toContain(own);

    await restore(o, [own]);
    const copy = await exec<{ postId: string }>(o, o.member, 'social.post.duplicate', { postId });
    expect(copy.postId).not.toBe(postId);
  });

  it("refuses a duplicate whose channel's cover is archived, and keeps the cover on the post itself", async () => {
    const o = await org();
    const cover = await file(o, 'bia.jpg');
    const { postId, variants } = await create(o, o.member, { body: 'Video mới', channels: [{ connectionId: o.mine, settings: { cover: { fileId: cover } } }] });
    const variantId = (variants[0] as { variantId: string }).variantId;
    await archive(o, [cover]);
    await expect(exec(o, o.member, 'social.post.duplicate', { postId })).rejects.toMatchObject(archivedRefusal(cover));
    // The channel's cover already: an edit that keeps it goes through.
    await exec(o, o.member, 'social.variant.update', { variantId, revision: await revisionOf(o, 'post_variant', variantId), body: 'Video mới, chú thích riêng', settings: { cover: { fileId: cover } } });
  });

  it('refuses archived files in drafts from media, the CSV import, the AI draft photos and the file names it resolves', async () => {
    const o = await org();
    const ok = await file(o, 'duoc.jpg');
    const gone = await file(o, 'luu-tru.jpg');
    await archive(o, [gone]);
    const before = await posts(o);
    await expect(exec(o, o.member, 'social.post.create_from_media', { fileIds: [ok, gone], connectionIds: [o.mine] })).rejects.toMatchObject(archivedRefusal(gone));
    await expect(exec(o, o.member, 'social.post.import', { posts: [{ body: 'Dòng 1', connectionIds: [o.mine], media: [{ fileId: ok }] }, { body: 'Dòng 2', connectionIds: [o.mine], media: [{ fileId: gone }] }] })).rejects.toMatchObject(
      archivedRefusal(gone),
    );
    expect(await posts(o)).toBe(before);
    await expect(query(o, o.member, 'social.media.draft_images', { fileIds: [ok, gone] })).rejects.toMatchObject(archivedRefusal(gone));
    const resolved = await query<Array<{ ref: string; problem: string | null }>>(o, o.member, 'social.media.resolve', { refs: ['luu-tru.jpg', gone, 'duoc.jpg'] });
    expect(resolved.map((r) => r.problem)).toEqual(['FILE_NOT_ALLOWED', 'FILE_NOT_ALLOWED', null]);

    const made = await exec<{ status: string }>(o, o.member, 'social.post.create_from_media', { fileIds: [ok], connectionIds: [o.mine] });
    expect(made.status).toBe('created');
  });

  it("refuses another channel's own media to a limited member on every attach path (#1273)", async () => {
    const o = await org();
    const hidden = await hiddenOwn(o);
    const shared = await file(o, 'chung.jpg');
    const { postId, revision, variants } = await create(o, o.limited, { body: 'Bài của tôi', media: [{ fileId: shared }], channels: [{ connectionId: o.mine }] });
    const variantId = (variants[0] as { variantId: string }).variantId;
    const before = await posts(o);

    await expect(create(o, o.limited, { body: 'Bài', media: [{ fileId: hidden }], channels: [{ connectionId: o.mine }] })).rejects.toMatchObject(hiddenRefusal(hidden));
    await expect(create(o, o.limited, { body: 'Bài', channels: [{ connectionId: o.mine, media: [{ fileId: hidden }] }] })).rejects.toMatchObject(hiddenRefusal(hidden));
    await expect(exec(o, o.limited, 'social.post.update', { postId, revision, media: [{ fileId: shared }, { fileId: hidden }] })).rejects.toMatchObject(hiddenRefusal(hidden));
    const vRevision = await revisionOf(o, 'post_variant', variantId);
    await expect(exec(o, o.limited, 'social.variant.update', { variantId, revision: vRevision, media: [{ fileId: hidden }] })).rejects.toMatchObject(hiddenRefusal(hidden));
    await expect(exec(o, o.limited, 'social.variant.update', { variantId, revision: vRevision, settings: { cover: { fileId: hidden } } })).rejects.toMatchObject(hiddenRefusal(hidden));
    await expect(exec(o, o.limited, 'social.post.create_from_media', { fileIds: [hidden], connectionIds: [o.mine] })).rejects.toMatchObject(hiddenRefusal(hidden));
    await expect(exec(o, o.limited, 'social.post.import', { posts: [{ body: 'Dòng', connectionIds: [o.mine], media: [{ fileId: hidden }] }] })).rejects.toMatchObject(hiddenRefusal(hidden));
    expect(await posts(o)).toBe(before);

    // Add channels: a second channel of theirs, with the other channel's file as its own.
    const second = await connection(o.orgId, o.owner);
    await admin((c) => c.query('INSERT INTO crove_social.channel_access (org_id, user_id, channel_connection_id, created_by) VALUES ($1, $2, $3, $4)', [o.orgId, o.limited, second, o.owner]));
    await expect(exec(o, o.limited, 'social.post.add_channels', { postId, channels: [{ connectionId: second, media: [{ fileId: hidden }] }] })).rejects.toMatchObject(hiddenRefusal(hidden));

    // The owner and an unlimited member may use it.
    await create(o, o.member, { body: 'Bài', media: [{ fileId: hidden }], channels: [{ connectionId: o.mine }] });
  });

  it('removes the archive marks with their file', async () => {
    const o = await org();
    const f = await file(o, 'xoa.jpg');
    await archive(o, [f]);
    expect(await marks(o)).toBe(1);
    await admin((c) => c.query('DELETE FROM crove_kernel.file WHERE org_id = $1 AND id = $2', [o.orgId, f]));
    expect(await marks(o)).toBe(0);
  });
});
