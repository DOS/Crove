// Client review links on PostgreSQL 17 (issue #589): owners and admins make and revoke them, the token is kept only as a
// hash, the public definers answer for a live link and nothing else, clients' answers are capped and recorded with the
// name they typed, and a content change shows. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own
// database.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { reviewFile } from '../src/review-link.ts';
import { reviewTokenHash, socialCommands, socialQueries, type PostView, type ReviewFeedbackView, type ReviewLinkView } from '@crove/mod-social';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('social client review links on PostgreSQL (#589)', () => {
  const dbName = `crove_test_social_review_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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

  async function org() {
    const owner = await person('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    const roles: Record<'member' | 'viewer', string> = { member: await person('member'), viewer: await person('viewer') };
    for (const [role, id] of Object.entries(roles)) {
      await admin((c) => c.query('INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, $3)', [orgId, id, role]));
    }
    return { orgId, owner, ...roles };
  }

  async function connection(orgId: string, owner: string, provider = 'sandbox') {
    const id = randomUUID();
    await admin((c) =>
      c.query(
        'INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, $3, $4, $5, $6)',
        [orgId, id, provider, `acct-${id.slice(0, 8)}`, 'Kênh thử', owner],
      ),
    );
    return id;
  }

  const exec = <O>(o: { orgId: string }, user: string, name: string, input: unknown) => rt.execute<O>(name, input, { actor: asUser(user), orgId: o.orgId });
  const get = (o: { orgId: string }, user: string, postId: string) => rt.query<PostView>('social.post.get', { postId }, { actor: asUser(user), orgId: o.orgId });

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
  type Page = { org: string; changed: boolean; channels: { provider: string; channel: string; body: string; mediaCount: number }[]; feedback: { name: string; verdict: string; body: string | null }[] } | null;
  // The public side runs as the API login role, with no org context, as the HTTP edge does.
  const view = async (token: string) => (await pool.query<{ page: Page }>('SELECT crove_social.review_link_view($1) AS page', [token])).rows[0]?.page ?? null;
  const answer = async (token: string, name: string, verdict: string, body: string | null) =>
    (await pool.query<{ done: { recorded: boolean } | null }>('SELECT crove_social.review_feedback_add($1, $2, $3, $4) AS done', [token, name, verdict, body])).rows[0]?.done ?? null;
  const links = (o: { orgId: string }, user: string, postId: string) =>
    rt.query<{ links: ReviewLinkView[]; feedback: ReviewFeedbackView[] }>('social.review_link.list', { postId }, { actor: asUser(user), orgId: o.orgId });

  async function draft(o: { orgId: string; owner: string; member: string }) {
    const conn = await connection(o.orgId, o.owner);
    const { postId } = await exec<{ postId: string }>(o, o.member, 'social.post.create', { body: 'Khai trương cửa hàng mới', channels: [{ connectionId: conn }] });
    return postId;
  }

  it('lets owners and admins make a link whose token is kept only as a hash, and shows the post through it', async () => {
    const o = await org();
    const postId = await draft(o);
    await expect(exec(o, o.member, 'social.review_link.create', { postId })).rejects.toMatchObject({ status: 403 });
    const made = await exec<{ linkId: string; token: string; expiresAt: string }>(o, o.owner, 'social.review_link.create', { postId, days: 3 });
    expect(made.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Date.parse(made.expiresAt) - Date.now()).toBeGreaterThan(2.9 * 86_400_000);
    // Only the hash is stored; the token is in no table, audit row or event.
    const stored = await admin(async (c) => (await c.query<{ token_sha256: string }>('SELECT token_sha256 FROM crove_social.review_link WHERE id = $1', [made.linkId])).rows[0]?.token_sha256);
    expect(stored).toBe(reviewTokenHash(made.token));
    const leaks = await admin(async (c) =>
      (
        await c.query<{ n: string }>(
          `SELECT (SELECT count(*) FROM crove_kernel.audit_event a WHERE a.detail::text LIKE '%' || $1 || '%')
                + (SELECT count(*) FROM crove_kernel.outbox_event e WHERE e.payload::text LIKE '%' || $1 || '%') AS n`,
          [made.token],
        )
      ).rows[0]?.n,
    );
    expect(Number(leaks)).toBe(0);

    const page = await view(made.token);
    expect(page).toMatchObject({ changed: false, channels: [{ provider: 'sandbox', channel: 'Kênh thử', body: 'Khai trương cửa hàng mới', mediaCount: 0 }], feedback: [] });
    expect(page?.org).toMatch(/^Org /);
    // Anything else gets nothing: a malformed token, a well-formed unknown one.
    expect(await view('nope')).toBeNull();
    expect(await view(randomBytes(32).toString('base64url'))).toBeNull();
  });

  it('records clients\' answers with their name, says when the post changed, and stops at revocation or expiry', async () => {
    const o = await org();
    const postId = await draft(o);
    const { linkId, token } = await exec<{ linkId: string; token: string }>(o, o.owner, 'social.review_link.create', { postId });
    expect(await answer(token, '  Chị Lan  ', 'approved', null)).toEqual({ recorded: true });
    // A comment needs text; a name is required; the verdict is one of three.
    await expect(answer(token, 'Chị Lan', 'comment', '  ')).rejects.toMatchObject({ code: '22023' });
    await expect(answer(token, ' ', 'approved', null)).rejects.toMatchObject({ code: '22023' });
    await expect(answer(token, 'Chị Lan', 'publish', null)).rejects.toMatchObject({ code: '22023' });

    // The post changes after the link was made: the page and the next answer say so.
    const post = await get(o, o.member, postId);
    await exec(o, o.member, 'social.post.update', { postId, revision: post.revision, body: 'Khai trương, giảm 20%' });
    expect((await view(token))?.changed).toBe(true);
    expect(await answer(token, 'Anh Minh', 'changes_requested', 'Thêm giờ mở cửa')).toEqual({ recorded: true });
    const seen = await links(o, o.viewer, postId);
    expect(seen.links).toEqual([expect.objectContaining({ id: linkId, changed: true, revokedAt: null, answers: 2 })]);
    expect(seen.feedback.map((f) => [f.name, f.verdict, f.body, f.changed])).toEqual([
      ['Anh Minh', 'changes_requested', 'Thêm giờ mở cửa', true],
      ['Chị Lan', 'approved', null, false],
    ]);
    // A client's answer is no approval: the channel is still a draft.
    expect((await get(o, o.member, postId)).variants[0]?.status).toBe('draft');

    // At most 100 answers per link.
    await pool.query("SELECT crove_social.review_feedback_add($1, 'Khách', 'approved', NULL) FROM generate_series(1, 98)", [token]);
    await expect(answer(token, 'Khách', 'approved', null)).rejects.toMatchObject({ code: '54000' });
    // The card counts every answer, past the 200 it lists (#626).
    expect((await links(o, o.viewer, postId)).links[0]?.answers).toBe(100);

    // Revoked: nothing more, by either function.
    await expect(exec(o, o.member, 'social.review_link.revoke', { linkId })).rejects.toMatchObject({ status: 403 });
    await exec(o, o.owner, 'social.review_link.revoke', { linkId });
    expect(await view(token)).toBeNull();
    expect(await answer(token, 'Chị Lan', 'approved', null)).toBeNull();

    // Expired: the same.
    const other = await exec<{ token: string; linkId: string }>(o, o.owner, 'social.review_link.create', { postId, days: 1 });
    await admin((c) => c.query("UPDATE crove_social.review_link SET created_at = now() - interval '3 days', expires_at = now() - interval '1 minute' WHERE id = $1", [other.linkId]));
    expect(await view(other.token)).toBeNull();
  });

  it('keeps links to their org, lets no tenant transaction write answers, and lets only the API role use a token', async () => {
    const o = await org();
    const stranger = await org();
    const postId = await draft(o);
    const { linkId } = await exec<{ linkId: string }>(o, o.owner, 'social.review_link.create', { postId });
    expect(await links(stranger, stranger.owner, postId)).toEqual({ links: [], feedback: [] });
    await expect(exec(stranger, stranger.owner, 'social.review_link.revoke', { linkId })).rejects.toMatchObject({ code: 'REVIEW_LINK_NOT_FOUND' });
    await expect(exec(stranger, stranger.owner, 'social.review_link.create', { postId })).rejects.toMatchObject({ code: 'POST_NOT_FOUND' });

    const grants = await admin(async (c) =>
      Object.fromEntries(
        await Promise.all(
          ['review_link', 'review_feedback'].map(async (t) => [
            t,
            (
              await c.query<{ p: string }>(
                "SELECT privilege_type AS p FROM information_schema.role_table_grants WHERE grantee = 'crove_tenant' AND table_schema = 'crove_social' AND table_name = $1 ORDER BY 1",
                [t],
              )
            ).rows.map((r) => r.p),
          ]),
        ),
      ),
    );
    expect(grants).toEqual({ review_link: ['INSERT', 'SELECT'], review_feedback: ['SELECT'] });

    const fns = ['crove_social.review_link_view(text)', 'crove_social.review_feedback_add(text,text,text,text)', 'crove_social.review_link_by_token(text,boolean)', 'crove_social.review_link_media(text)', 'crove_social.review_link_file(text,uuid)'];
    const roles = ['crove_app', 'crove_worker', 'crove_tenant', 'crove_definer_tenant', 'public'];
    const matrix = await admin(async (c) => {
      const { rows } = await c.query<{ fn: string; role: string; can: boolean }>(
        `SELECT f AS fn, r AS role, has_function_privilege(r, f, 'EXECUTE') AS can FROM unnest($1::text[]) f CROSS JOIN unnest($2::text[]) r`,
        [fns, roles],
      );
      return Object.fromEntries(fns.map((f) => [f, roles.filter((r) => rows.some((row) => row.fn === f && row.role === r && row.can))]));
    });
    expect(matrix).toEqual({
      'crove_social.review_link_view(text)': ['crove_app'],
      'crove_social.review_feedback_add(text,text,text,text)': ['crove_app'],
      'crove_social.review_link_by_token(text,boolean)': [],
      'crove_social.review_link_media(text)': ['crove_app'],
      'crove_social.review_link_file(text,uuid)': ['crove_app'],
    });
  });

  it('shows the post\'s files through the link, and only those, checked by their hash (#624)', async () => {
    const o = await org();
    const conn = await connection(o.orgId, o.owner);
    const image = async (bytes: Uint8Array) => {
      const id = randomUUID();
      const sha = createHash('sha256').update(bytes).digest('hex');
      await admin((c) =>
        c.query(
          `INSERT INTO crove_kernel.file (org_id, id, sha256, storage_key, generation, filename, content_type, size_bytes, source)
           VALUES ($1, $2, $3, $4, $5, 'anh.jpg', 'image/jpeg', $6, 'social')`,
          [o.orgId, id, sha, `org/${o.orgId}/${sha}`, `content:${sha}`, bytes.byteLength],
        ),
      );
      return { id, key: `org/${o.orgId}/${sha}` };
    };
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]);
    const shown = await image(bytes);
    const other = await image(new Uint8Array([0xff, 0xd8, 0xff, 9]));
    const { postId } = await exec<{ postId: string }>(o, o.member, 'social.post.create', { body: 'Ảnh khai trương', media: [{ fileId: shown.id }], channels: [{ connectionId: conn }] });
    await exec(o, o.member, 'social.post.create', { body: 'Bài khác', media: [{ fileId: other.id }], channels: [{ connectionId: conn }] });
    const { token, linkId } = await exec<{ token: string; linkId: string }>(o, o.owner, 'social.review_link.create', { postId });
    const media = async (t: string) => (await pool.query<{ media: unknown }>('SELECT crove_social.review_link_media($1) AS media', [t])).rows[0]?.media ?? null;
    const file = async (t: string, id: string) => (await pool.query<{ file: unknown }>('SELECT crove_social.review_link_file($1, $2::uuid) AS file', [t, id])).rows[0]?.file ?? null;
    expect(await media(token)).toEqual([[{ id: shown.id, type: 'image/jpeg' }]]);
    expect(await file(token, shown.id)).toMatchObject({ key: shown.key, type: 'image/jpeg', filename: 'anh.jpg' });
    // Another post's file, an unknown id, a malformed token: nothing.
    expect(await file(token, other.id)).toBeNull();
    expect(await file(token, randomUUID())).toBeNull();
    expect(await media('nope')).toBeNull();

    // The API reads the bytes and checks them against the recorded hash; a store without download URLs streams them.
    const store = { get: async (key: string) => (key === shown.key ? bytes : new Uint8Array([0])), direct: undefined };
    expect(await reviewFile(rt, store, { token, fileId: shown.id })).toMatchObject({ type: 'image/jpeg', bytes });
    const tampered = { get: async () => new Uint8Array([1]), direct: undefined };
    await expect(reviewFile(rt, tampered, { token, fileId: shown.id })).rejects.toThrow();
    expect(await reviewFile(rt, store, { token, fileId: other.id })).toBeNull();
    expect(await reviewFile(rt, store, { token: 'nope', fileId: shown.id })).toBeNull();

    // Revoked: the files go with the page.
    await exec(o, o.owner, 'social.review_link.revoke', { linkId });
    expect(await media(token)).toBeNull();
    expect(await file(token, shown.id)).toBeNull();
  });
});