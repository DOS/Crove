// One draft per library file on PostgreSQL 17 (#1080): files in order become drafts in order, a file a channel cannot
// take is reported per file with nothing saved, queueing takes the next free slots, and the refusals (another org's
// file, a viewer, more than 50 files). Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { socialCommands, socialQueries, type ActivityItem, type DraftsFromMediaResult, type PostView } from '@crove/mod-social';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

type Created = Extract<DraftsFromMediaResult, { status: 'created' }>;
type Invalid = Extract<DraftsFromMediaResult, { status: 'invalid' }>;

suite('social drafts from library files on PostgreSQL (#1080)', () => {
  const dbName = `crove_test_social_bulk_drafts_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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

  type Org = { orgId: string; owner: string; member: string; viewer: string };
  async function org(): Promise<Org> {
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

  async function connection(o: Org, provider: string) {
    const id = randomUUID();
    await admin((c) =>
      c.query('INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, $3, $4, $5, $6)', [
        o.orgId,
        id,
        provider,
        `acct-${id.slice(0, 8)}`,
        'Kênh thử',
        o.owner,
      ]),
    );
    return id;
  }

  // A library file as the upload route records it.
  async function file(o: Org, filename: string, options: { contentType?: string; durationMs?: number; source?: string } = {}) {
    const id = randomUUID();
    const sha = createHash('sha256').update(id).digest('hex');
    await admin((c) =>
      c.query(
        `INSERT INTO crove_kernel.file (org_id, id, sha256, storage_key, generation, filename, content_type, size_bytes, source, duration_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 200000, $8, $9)`,
        [o.orgId, id, sha, `org/${o.orgId}/${sha}`, `content:${sha}`, filename, options.contentType ?? 'image/jpeg', options.source ?? 'social', options.durationMs ?? null],
      ),
    );
    return id;
  }

  const exec = <O>(o: Org, user: string, name: string, input: unknown) => rt.execute<O>(name, input, { actor: asUser(user), orgId: o.orgId });
  const fromMedia = <O = DraftsFromMediaResult>(o: Org, user: string, input: unknown) => exec<O>(o, user, 'social.post.create_from_media', input);
  const get = (o: Org, postId: string) => rt.query<PostView>('social.post.get', { postId }, { actor: asUser(o.viewer), orgId: o.orgId });
  const postCount = (o: Org) => admin(async (c) => Number((await c.query<{ n: string }>('SELECT count(*) AS n FROM crove_social.post WHERE org_id = $1', [o.orgId])).rows[0]?.n));
  const audits = (o: Org, command: string) =>
    admin(async (c) => (await c.query<{ detail: Record<string, unknown> | null }>("SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = $2 AND outcome = 'ok' ORDER BY occurred_at, id", [o.orgId, command])).rows);
  const daily = (minute: number) => [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, minute }));

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

  it('makes ten drafts from ten images, in order, each a normal create with its own audit row and timeline', async () => {
    const o = await org();
    const sandbox = await connection(o, 'sandbox');
    const threads = await connection(o, 'threads');
    const files: string[] = [];
    for (let i = 1; i <= 10; i++) files.push(await file(o, `ra_mat_${String(i).padStart(2, '0')}.jpg`));
    const result = await fromMedia<Created>(o, o.member, { fileIds: files, connectionIds: [sandbox, threads], caption: { kind: 'filename' } });
    expect(result.status).toBe('created');
    expect(result.posts.map((p) => p.fileId)).toEqual(files);
    expect(new Set(result.posts.map((p) => p.postId)).size).toBe(10);
    for (const [i, p] of result.posts.entries()) {
      const view = await get(o, p.postId);
      expect(view.body).toBe(`ra mat ${String(i + 1).padStart(2, '0')}`);
      expect(view.media.map((m) => m.fileId)).toEqual([files[i]]);
      expect(view.variants.map((v) => [v.connectionId, v.status, v.queueSlotAt])).toEqual([
        [sandbox, 'draft', null],
        [threads, 'draft', null],
      ]);
      expect(view.authorUserId).toBe(o.member);
      expect(p.variants.every((v) => v.queueSlotAt === null)).toBe(true);
    }
    // Each draft is audited as a create of its own, and the batch on one row naming them in order.
    expect(await audits(o, 'social.post.create')).toHaveLength(10);
    const [batch] = await audits(o, 'social.post.create_from_media');
    expect(batch?.detail).toMatchObject({ files: 10, channels: 2, post_ids: result.posts.map((p) => p.postId), caption: 'filename', queued: false });
    const timeline = await rt.query<{ items: ActivityItem[] }>('social.post.activity', { postId: result.posts[0]?.postId }, { actor: asUser(o.viewer), orgId: o.orgId });
    expect(timeline.items.map((i) => i.kind)).toContain('created');
  });

  it('reports a video on a channel that cannot take it, per file, and saves nothing', async () => {
    const o = await org();
    const sandbox = await connection(o, 'sandbox');
    // A Zalo OA post takes images only.
    const zalo = await connection(o, 'zalo_oa');
    const photo = await file(o, 'anh.jpg');
    const clip = await file(o, 'khai-truong.mp4', { contentType: 'video/mp4', durationMs: 12_500 });
    const other = await file(o, 'anh-2.png', { contentType: 'image/png' });
    const before = await postCount(o);
    const result = await fromMedia<Invalid>(o, o.member, { fileIds: [photo, clip, other], connectionIds: [sandbox, zalo] });
    expect(result).toEqual({ status: 'invalid', files: [{ fileId: clip, issues: [{ connectionId: zalo, provider: 'zalo_oa', code: 'MEDIA_KIND_NOT_ALLOWED', field: 'media.0', limit: null, actual: null }] }] });
    expect(await postCount(o)).toBe(before);
    expect(await audits(o, 'social.post.create')).toHaveLength(0);
    // Without that channel, the same files go through; a title Zalo would need is the writer's to add later, not a refusal.
    const fine = await fromMedia<Created>(o, o.member, { fileIds: [photo, other], connectionIds: [sandbox, zalo] });
    expect(fine.status).toBe('created');
    expect(await postCount(o)).toBe(before + 2);
  });

  it('places the drafts in the next free slots of each queue, in file order, after the slots already held', async () => {
    const o = await org();
    const sandbox = await connection(o, 'sandbox');
    const second = await connection(o, 'sandbox');
    for (const conn of [sandbox, second]) await exec(o, o.owner, 'social.queue.set', { connectionId: conn, timeZone: 'Asia/Ho_Chi_Minh', slots: [...daily(540), ...daily(1200)] });
    // A post already queued on the first channel holds its first slot.
    const held = await exec<{ postId: string }>(o, o.member, 'social.post.create', { body: 'Bài đã xếp', channels: [{ connectionId: sandbox }] });
    await exec(o, o.member, 'social.post.submit', { postId: held.postId });
    const heldView = await get(o, held.postId);
    await exec(o, o.owner, 'social.variant.decide', {
      postId: held.postId,
      decision: 'approved',
      variants: heldView.variants.map((v) => ({ variantId: v.id, revision: v.revision, contentHash: v.contentHash })),
    });
    await exec(o, o.owner, 'social.variant.schedule', { postId: held.postId, queue: true });
    const free = async (conn: string) => (await rt.query<{ nextFree: string[] }>('social.queue.get', { connectionId: conn }, { actor: asUser(o.viewer), orgId: o.orgId })).nextFree;
    const [freeFirst, freeSecond] = [await free(sandbox), await free(second)];
    const snippet = await exec<{ snippetId: string }>(o, o.member, 'social.snippet.create', { name: 'Chữ ký', body: '#ramat' });
    const set = await exec<{ setId: string }>(o, o.owner, 'social.channel_set.save', { name: 'Hai kênh', connectionIds: [sandbox, second] });
    const files = [await file(o, 'a.jpg'), await file(o, 'b.jpg'), await file(o, 'c.jpg')];
    const result = await fromMedia<Created>(o, o.member, { fileIds: files, channelSetId: set.setId, caption: { kind: 'snippet', snippetId: snippet.snippetId }, queue: true });
    expect(result.status).toBe('created');
    const slotsOf = (conn: string) => result.posts.map((p) => p.variants.find((v) => v.connectionId === conn)?.queueSlotAt);
    expect(slotsOf(sandbox)).toEqual(freeFirst.slice(0, 3));
    expect(slotsOf(second)).toEqual(freeSecond.slice(0, 3));
    for (const p of result.posts) {
      const view = await get(o, p.postId);
      expect(view.body).toBe('#ramat');
      // Still drafts: a slot is held, nothing is scheduled before a review.
      expect(view.variants.map((v) => v.status)).toEqual(['draft', 'draft']);
      expect(view.variants.map((v) => v.queueSlotAt)).toEqual(p.variants.map((v) => v.queueSlotAt));
    }
    // The next post queued on the first channel goes after the drafts.
    expect((await free(sandbox))[0]).toBe(freeFirst[3]);
    // A channel without a queue refuses the batch before anything is made.
    const bare = await connection(o, 'sandbox');
    const before = await postCount(o);
    await expect(fromMedia(o, o.member, { fileIds: [await file(o, 'd.jpg')], connectionIds: [sandbox, bare], queue: true })).rejects.toMatchObject({ code: 'QUEUE_EMPTY' });
    expect(await postCount(o)).toBe(before);
  });

  it("refuses another org's file, a file not uploaded for posts, a viewer, and more than 50 files", async () => {
    const o = await org();
    const elsewhere = await org();
    const sandbox = await connection(o, 'sandbox');
    const mine = await file(o, 'anh.jpg');
    const theirs = await file(elsewhere, 'cua-ho.jpg');
    const invoice = await file(o, 'hoa-don.jpg', { source: 'upload' });
    await expect(fromMedia(o, o.member, { fileIds: [mine, theirs], connectionIds: [sandbox] })).rejects.toMatchObject({ code: 'MEDIA_NOT_FOUND' });
    await expect(fromMedia(o, o.member, { fileIds: [invoice], connectionIds: [sandbox] })).rejects.toMatchObject({ code: 'MEDIA_NOT_FOUND' });
    expect(await postCount(o)).toBe(0);
    expect(await postCount(elsewhere)).toBe(0);
    await expect(fromMedia(o, o.viewer, { fileIds: [mine], connectionIds: [sandbox] })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // Another org's channel is not one of this org's.
    const theirChannel = await connection(elsewhere, 'sandbox');
    await expect(fromMedia(o, o.member, { fileIds: [mine], connectionIds: [theirChannel] })).rejects.toMatchObject({ code: 'CHANNEL_NOT_FOUND' });
    const many = Array.from({ length: 51 }, () => randomUUID());
    await expect(fromMedia(o, o.member, { fileIds: many, connectionIds: [sandbox] })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(fromMedia(o, o.member, { fileIds: [mine, mine], connectionIds: [sandbox] })).rejects.toMatchObject({ code: 'VALIDATION' });
    // Channels or a set, never both or neither.
    await expect(fromMedia(o, o.member, { fileIds: [mine] })).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(await postCount(o)).toBe(0);
    // Fifty is the cap, not a refusal.
    const fifty: string[] = [];
    for (let i = 0; i < 50; i++) fifty.push(await file(o, `anh-${i}.jpg`));
    const result = await fromMedia<Created>(o, o.owner, { fileIds: fifty, connectionIds: [sandbox] });
    expect(result.posts).toHaveLength(50);
    expect(await postCount(o)).toBe(50);
  });
});
