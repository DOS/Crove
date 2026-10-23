// Pinned internal comments on PostgreSQL 17 (issue #1180): a comment on a spot of an image or a moment of a video of
// the post. The table's CHECKs and its foreign key to the org's own files, the command's refusals (a file outside the
// post or the channel, the wrong kind of pin, a viewer, a channel the member may not use), the pin in the timeline
// and on an earlier image, no UPDATE of the pin columns for crove_tenant, and the events of a comment left as they were.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { socialCommands, socialQueries, type ActivityItem, type PostView } from '@crove/mod-social';
import { mentionToken } from '@crove/mod-social/contract';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('pinned internal comments on PostgreSQL (#1180)', () => {
  const dbName = `crove_test_social_comment_pins_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  type Org = { orgId: string; owner: string; member: string; viewer: string };

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
    return upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@pins.test`, name: null });
  }

  async function org(): Promise<Org> {
    const owner = await person('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    const roles: Record<'member' | 'viewer', string> = { member: await person('member'), viewer: await person('viewer') };
    for (const [role, id] of Object.entries(roles)) {
      await admin((c) => c.query('INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, $3)', [orgId, id, role]));
    }
    return { orgId, owner, ...roles };
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

  // A stored file as the upload route records it.
  async function file(o: Org, filename: string, contentType = 'image/jpeg') {
    const id = randomUUID();
    const sha = createHash('sha256').update(id).digest('hex');
    await admin((c) =>
      c.query(
        `INSERT INTO crove_kernel.file (org_id, id, sha256, storage_key, generation, filename, content_type, size_bytes, source, duration_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 120000, 'social', $8)`,
        [o.orgId, id, sha, `org/${o.orgId}/${sha}`, `content:${sha}`, filename, contentType, contentType.startsWith('video/') ? 30000 : null],
      ),
    );
    return id;
  }

  const exec = <O>(o: Org, user: string, name: string, input: unknown) => rt.execute<O>(name, input, { actor: asUser(user), orgId: o.orgId });
  const get = (o: Org, user: string, postId: string) => rt.query<PostView>('social.post.get', { postId }, { actor: asUser(user), orgId: o.orgId });
  const activity = async (o: Org, user: string, postId: string) =>
    (await rt.query<{ items: ActivityItem[]; more: boolean }>('social.post.activity', { postId }, { actor: asUser(user), orgId: o.orgId })).items;
  const comment = (o: Org, user: string, input: Record<string, unknown>) => exec<{ commentId: string }>(o, user, 'social.post_comment.add', input);

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
    rt = new Runtime(db).register({
      commands: [...kernelCommands, ...socialCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...socialQueries],
    });
  });

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('pins a comment to a spot on the post’s image or a moment in a channel’s own video, and shows it in the timeline', async () => {
    const o = await org();
    const [a, b] = [await connection(o), await connection(o)];
    const photo = await file(o, 'banner.jpg');
    const clip = await file(o, 'clip.mp4', 'video/mp4');
    const { postId } = await exec<{ postId: string }>(o, o.member, 'social.post.create', {
      body: 'Khai trương',
      media: [{ fileId: photo }],
      channels: [{ connectionId: a }, { connectionId: b, media: [{ fileId: clip }] }],
    });
    const post = await get(o, o.member, postId);
    const vb = post.variants.find((v) => v.connectionId === b)?.id as string;

    const logo = await comment(o, o.member, { postId, body: 'Logo nhỏ quá', pin: { fileId: photo, x: 0.25, y: 0.75 } });
    const moment = await comment(o, o.owner, { postId, variantId: vb, body: 'Chữ ở giây 12 bị che', pin: { fileId: clip, atSeconds: 12.5 } });
    await comment(o, o.member, { postId, body: 'Không ghim' });

    const items = await activity(o, o.viewer, postId);
    const byId = new Map(items.map((i) => [i.id, i]));
    expect(byId.get(logo.commentId)?.pin).toEqual({ fileId: photo, mime: 'image/jpeg', filename: 'banner.jpg', x: 0.25, y: 0.75, atSeconds: null, current: true });
    expect(byId.get(moment.commentId)?.pin).toEqual({ fileId: clip, mime: 'video/mp4', filename: 'clip.mp4', x: null, y: null, atSeconds: 12.5, current: true });
    expect(items.filter((i) => i.kind === 'comment' && i.pin === null)).toHaveLength(1);
    expect(items.filter((i) => i.kind !== 'comment').every((i) => i.pin === null)).toBe(true);

    // The image taken out of the post: the pin stays, on an earlier image.
    const fresh = await get(o, o.member, postId);
    const other = await file(o, 'banner-2.jpg');
    await exec(o, o.member, 'social.post.update', { postId, revision: fresh.revision, media: [{ fileId: other }] });
    const after = await activity(o, o.member, postId);
    expect(after.find((i) => i.id === logo.commentId)?.pin).toMatchObject({ fileId: photo, current: false });
    expect(after.find((i) => i.id === moment.commentId)?.pin).toMatchObject({ fileId: clip, current: true });
  });

  it('refuses a file outside the post or the channel, another org’s file, the wrong kind of pin, and viewers', async () => {
    const o = await org();
    const [a, b] = [await connection(o), await connection(o)];
    const photo = await file(o, 'a.jpg');
    const clip = await file(o, 'b.mp4', 'video/mp4');
    const stray = await file(o, 'stray.jpg');
    const { postId } = await exec<{ postId: string }>(o, o.member, 'social.post.create', {
      body: 'Bài',
      media: [{ fileId: photo }],
      channels: [{ connectionId: a }, { connectionId: b, media: [{ fileId: clip }] }],
    });
    const post = await get(o, o.member, postId);
    const va = post.variants.find((v) => v.connectionId === a)?.id as string;
    const vb = post.variants.find((v) => v.connectionId === b)?.id as string;
    const notInPost = { code: 'PIN_FILE_NOT_IN_POST', status: 422 };

    // A library file the post does not use, and another org's file (its id guessed or leaked).
    await expect(comment(o, o.member, { postId, body: 'x', pin: { fileId: stray, x: 0.5, y: 0.5 } })).rejects.toMatchObject(notInPost);
    const p = await org();
    const foreign = await file(p, 'foreign.jpg');
    await expect(comment(o, o.member, { postId, body: 'x', pin: { fileId: foreign, x: 0.5, y: 0.5 } })).rejects.toMatchObject(notInPost);
    // A channel's own video, but on the whole post or on another channel.
    await expect(comment(o, o.member, { postId, body: 'x', pin: { fileId: clip, atSeconds: 1 } })).rejects.toMatchObject(notInPost);
    await expect(comment(o, o.member, { postId, variantId: va, body: 'x', pin: { fileId: clip, atSeconds: 1 } })).rejects.toMatchObject(notInPost);
    // A spot on a video, a moment on an image.
    await expect(comment(o, o.member, { postId, variantId: vb, body: 'x', pin: { fileId: clip, x: 0.1, y: 0.1 } })).rejects.toMatchObject({ code: 'PIN_KIND_MISMATCH', status: 422 });
    await expect(comment(o, o.member, { postId, body: 'x', pin: { fileId: photo, atSeconds: 3 } })).rejects.toMatchObject({ code: 'PIN_KIND_MISMATCH', status: 422 });
    // Out of range, half a spot, both kinds at once.
    for (const pin of [{ fileId: photo, x: 1.5, y: 0.5 }, { fileId: photo, x: 0.5 }, { fileId: photo, x: 0.5, y: 0.5, atSeconds: 1 }, { fileId: clip, atSeconds: -1 }, { fileId: clip, atSeconds: 86401 }]) {
      await expect(comment(o, o.member, { postId, variantId: vb, body: 'x', pin })).rejects.toMatchObject({ code: 'VALIDATION', status: 422 });
    }
    // Viewers read pins; they never add one.
    await expect(comment(o, o.viewer, { postId, body: 'x', pin: { fileId: photo, x: 0.5, y: 0.5 } })).rejects.toMatchObject({ status: 403 });
    // The post's image is pinned on a channel comment too.
    await comment(o, o.member, { postId, variantId: va, body: 'Ảnh chung', pin: { fileId: photo, x: 0, y: 1 } });

    // A member limited to channel A (#1081) cannot pin on channel B.
    await exec(o, o.owner, 'social.channel_access.set', { userId: o.member, channelConnectionIds: [a] });
    await expect(comment(o, o.member, { postId, variantId: vb, body: 'x', pin: { fileId: clip, atSeconds: 1 } })).rejects.toMatchObject({ code: 'CHANNEL_NOT_ALLOWED', status: 403 });
    // Nothing refused was written.
    const rows = await admin((c) => c.query<{ n: string }>('SELECT count(*) AS n FROM crove_social.post_comment WHERE org_id = $1 AND post_id = $2', [o.orgId, postId]));
    expect(rows.rows[0]?.n).toBe('1');
  });

  it('leaves the events of a comment and its mentions as they were', async () => {
    const o = await org();
    const conn = await connection(o);
    const photo = await file(o, 'a.jpg');
    const { postId } = await exec<{ postId: string }>(o, o.member, 'social.post.create', { body: 'Bài', media: [{ fileId: photo }], channels: [{ connectionId: conn }] });
    const { commentId } = await comment(o, o.member, { postId, body: `Hỏi ${mentionToken(o.owner)} chỗ này`, pin: { fileId: photo, x: 0.5, y: 0.5 } });
    const events = await admin((c) =>
      c.query<{ type: string; payload: Record<string, unknown> }>(
        "SELECT type, payload FROM crove_kernel.outbox_event WHERE org_id = $1 AND type IN ('social.post.commented', 'social.post.mentioned') ORDER BY created_at, type",
        [o.orgId],
      ),
    );
    expect(events.rows).toEqual([
      { type: 'social.post.commented', payload: { post_id: postId, comment_id: commentId, mentioned: [o.owner] } },
      { type: 'social.post.mentioned', payload: { post_id: postId, comment_id: commentId, user_ids: [o.owner] } },
    ]);
  });

  it('keeps the CHECKs and the foreign key to the org’s own files in the table, and no UPDATE of a pin', async () => {
    const o = await org();
    const p = await org();
    const conn = await connection(o);
    const photo = await file(o, 'a.jpg');
    const foreign = await file(p, 'b.jpg');
    const { postId } = await exec<{ postId: string }>(o, o.member, 'social.post.create', { body: 'Bài', media: [{ fileId: photo }], channels: [{ connectionId: conn }] });
    const insert = (pin: { file_id?: string | null; pin_x?: number | string | null; pin_y?: number | string | null; pin_seconds?: number | string | null }) =>
      admin((c) =>
        c.query('INSERT INTO crove_social.post_comment (org_id, post_id, author_user_id, body, file_id, pin_x, pin_y, pin_seconds) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', [
          o.orgId,
          postId,
          o.member,
          'x',
          pin.file_id ?? null,
          pin.pin_x ?? null,
          pin.pin_y ?? null,
          pin.pin_seconds ?? null,
        ]),
      );
    const check = (name: string) => expect.objectContaining({ code: '23514', constraint: name });
    // A spot: both coordinates, each in 0..1, never NaN.
    await expect(insert({ file_id: photo, pin_x: 0.5 })).rejects.toEqual(check('post_comment_pin_xy_check'));
    await expect(insert({ file_id: photo, pin_y: 0.5, pin_seconds: null })).rejects.toEqual(expect.objectContaining({ code: '23514', constraint: expect.stringMatching(/^post_comment_pin_(xy_)?check$/) }));
    await expect(insert({ file_id: photo, pin_x: 1.01, pin_y: 0.5 })).rejects.toEqual(check('post_comment_pin_xy_check'));
    await expect(insert({ file_id: photo, pin_x: 0.5, pin_y: -0.01 })).rejects.toEqual(check('post_comment_pin_xy_check'));
    await expect(insert({ file_id: photo, pin_x: 'NaN', pin_y: 0.5 })).rejects.toEqual(check('post_comment_pin_xy_check'));
    // A moment: from 0 to a day, never NaN or infinite.
    await expect(insert({ file_id: photo, pin_seconds: -1 })).rejects.toEqual(check('post_comment_pin_seconds_check'));
    await expect(insert({ file_id: photo, pin_seconds: 'NaN' })).rejects.toEqual(check('post_comment_pin_seconds_check'));
    await expect(insert({ file_id: photo, pin_seconds: 'Infinity' })).rejects.toEqual(check('post_comment_pin_seconds_check'));
    // A pin needs its file, a file needs one pin, and a spot and a moment exclude each other.
    await expect(insert({ pin_x: 0.5, pin_y: 0.5 })).rejects.toEqual(check('post_comment_pin_check'));
    await expect(insert({ pin_seconds: 3 })).rejects.toEqual(check('post_comment_pin_check'));
    await expect(insert({ file_id: photo })).rejects.toEqual(check('post_comment_pin_check'));
    await expect(insert({ file_id: photo, pin_x: 0.5, pin_y: 0.5, pin_seconds: 3 })).rejects.toEqual(check('post_comment_pin_check'));
    // Another org's file, or none at all.
    await expect(insert({ file_id: foreign, pin_x: 0.5, pin_y: 0.5 })).rejects.toEqual(expect.objectContaining({ code: '23503', constraint: 'post_comment_file_fk' }));
    await expect(insert({ file_id: randomUUID(), pin_seconds: 1 })).rejects.toEqual(expect.objectContaining({ code: '23503', constraint: 'post_comment_file_fk' }));
    // The edges are fine.
    await insert({ file_id: photo, pin_x: 0, pin_y: 1 });
    await insert({ file_id: photo, pin_seconds: 0 });
    await insert({});

    // A file a pin names is not deleted from under it.
    const loose = await file(o, 'loose.jpg');
    await insert({ file_id: loose, pin_x: 0.1, pin_y: 0.1 });
    await expect(admin((c) => c.query('DELETE FROM crove_kernel.file WHERE org_id = $1 AND id = $2', [o.orgId, loose]))).rejects.toEqual(
      expect.objectContaining({ code: '23503', constraint: 'post_comment_file_fk' }),
    );

    // crove_tenant inserts a pin but never changes one; its text and resolve grants stay, and a suggestion's state
    // (#1236).
    for (const column of ['file_id', 'pin_x', 'pin_y', 'pin_seconds']) {
      await expect(
        admin(async (c) => {
          await c.query('BEGIN');
          try {
            await c.query('SET LOCAL ROLE crove_tenant');
            await c.query(`UPDATE crove_social.post_comment SET ${column} = NULL WHERE false`);
          } finally {
            await c.query('ROLLBACK');
          }
        }),
      ).rejects.toMatchObject({ code: '42501' });
    }
    const grants = await admin((c) =>
      c.query<{ column_name: string }>(
        "SELECT column_name FROM information_schema.column_privileges WHERE table_schema = 'crove_social' AND table_name = 'post_comment' AND grantee = 'crove_tenant' AND privilege_type = 'UPDATE' ORDER BY column_name",
      ),
    );
    expect(grants.rows.map((r) => r.column_name)).toEqual(['body', 'edited_at', 'resolved_at', 'resolved_by', 'suggest_state']);
  });
});
