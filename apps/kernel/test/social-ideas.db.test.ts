// The Social ideas board on PostgreSQL 17 (#701): members add, change and move ideas and viewers only read; files and
// labels must be the org's; a draft made from an idea links them, copies its labels and moves it to drafted, once;
// tenants keep apart. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { socialCommands, socialQueries, type Idea, type PostView } from '@crove/mod-social';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('social ideas board on PostgreSQL (#701)', () => {
  const dbName = `crove_test_social_ideas_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
  const get = (o: Org, user: string, postId: string) => rt.query<PostView>('social.post.get', { postId }, { actor: asUser(user), orgId: o.orgId });

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

  type Board = { ideas: Idea[]; truncated: boolean };
  const board = (o: Org, user: string, input: Record<string, unknown> = {}) => rt.query<Board>('social.idea.list', input, { actor: asUser(user), orgId: o.orgId });
  async function socialFile(orgId: string, owner: string, type = 'image/png') {
    const id = randomUUID();
    const sha = createHash('sha256').update(id).digest('hex');
    await admin((c) =>
      c.query(
        "INSERT INTO crove_kernel.file (org_id, id, sha256, storage_key, generation, filename, content_type, size_bytes, source, created_by) VALUES ($1, $2, $3, $4, $5, 'y-tuong.png', $6, 1000, 'social', $7)",
        [orgId, id, sha, `org/${orgId}/${sha}`, `content:${sha}`, type, owner],
      ),
    );
    return id;
  }

  it('adds, changes and moves ideas, and turns one into a draft once', async () => {
    const o = await org();
    const conn = await connection(o.orgId, o.owner);
    const file = await socialFile(o.orgId, o.owner);
    const { labelId } = await exec<{ labelId: string }>(o, o.member, 'social.label.create', { name: 'Mùa thu' });
    const { ideaId } = await exec<{ ideaId: string }>(o, o.member, 'social.idea.create', { title: '  Món mới mùa thu ', note: 'Chụp ở quầy', linkUrl: 'https://cuahang.vn/thu', fileIds: [file], labelIds: [labelId] });
    const { ideaId: other } = await exec<{ ideaId: string }>(o, o.other, 'social.idea.create', { title: 'Khuyến mãi 20/10', stage: 'planned' });
    const seen = await board(o, o.viewer);
    expect(seen.ideas.map((i) => [i.title, i.stage])).toEqual([
      ['Khuyến mãi 20/10', 'planned'],
      ['Món mới mùa thu', 'new'],
    ]);
    expect(seen.ideas[1]).toMatchObject({ note: 'Chụp ở quầy', linkUrl: 'https://cuahang.vn/thu', labelIds: [labelId], media: [{ fileId: file, mime: 'image/png', sizeBytes: 1000 }], postId: null });
    expect((await board(o, o.owner, { labelId })).ideas.map((i) => i.id)).toEqual([ideaId]);

    // Viewers read only; drafted is reached only by a draft.
    await expect(exec(o, o.viewer, 'social.idea.create', { title: 'Không được' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(exec(o, o.member, 'social.idea.move', { ideaId, stage: 'drafted' })).rejects.toThrow();
    await exec(o, o.admin, 'social.idea.move', { ideaId: other, stage: 'archived' });
    expect((await board(o, o.owner)).ideas.map((i) => i.id)).toEqual([ideaId]);
    expect((await board(o, o.owner, { archived: true })).ideas.map((i) => i.id)).toEqual([other]);
    // An archived idea makes no draft until it is restored.
    await expect(exec(o, o.member, 'social.post.create', { body: 'x', ideaId: other, channels: [{ connectionId: conn }] })).rejects.toMatchObject({ code: 'IDEA_ARCHIVED' });

    // An edit keeps what it leaves out.
    await exec(o, o.member, 'social.idea.update', { ideaId, title: 'Món mới mùa thu 2026' });
    expect((await rt.query<Idea>('social.idea.get', { ideaId }, { actor: asUser(o.owner), orgId: o.orgId }))).toMatchObject({ title: 'Món mới mùa thu 2026', note: 'Chụp ở quầy', labelIds: [labelId], media: [{ fileId: file }] });

    const { postId } = await exec<{ postId: string }>(o, o.member, 'social.post.create', { body: 'Món mới mùa thu 2026\n\nChụp ở quầy', ideaId, media: [{ fileId: file }], channels: [{ connectionId: conn }] });
    const idea = await rt.query<Idea>('social.idea.get', { ideaId }, { actor: asUser(o.owner), orgId: o.orgId });
    expect(idea).toMatchObject({ stage: 'drafted', postId });
    const post = await get(o, o.owner, postId);
    expect(post.labelIds).toEqual([labelId]);
    expect(post.idea).toEqual({ id: ideaId, title: 'Món mới mùa thu 2026' });
    // Once: a second draft of the same idea is refused, and the idea stays drafted.
    await expect(exec(o, o.member, 'social.post.create', { body: 'Lần hai', ideaId, channels: [{ connectionId: conn }] })).rejects.toMatchObject({ code: 'IDEA_DRAFTED' });
    await expect(exec(o, o.member, 'social.idea.move', { ideaId, stage: 'new' })).rejects.toMatchObject({ code: 'IDEA_DRAFTED' });
    expect((await board(o, o.owner)).ideas.map((i) => [i.id, i.stage])).toEqual([[ideaId, 'drafted']]);
  });

  it("refuses another org's files, labels and ideas, and members never delete ideas", async () => {
    const a = await org();
    const b = await org();
    const conn = await connection(b.orgId, b.owner);
    const foreignFile = await socialFile(a.orgId, a.owner);
    const { labelId: foreignLabel } = await exec<{ labelId: string }>(a, a.owner, 'social.label.create', { name: 'Nhãn A' });
    const { ideaId: foreignIdea } = await exec<{ ideaId: string }>(a, a.owner, 'social.idea.create', { title: 'Ý tưởng của A' });
    await expect(exec(b, b.member, 'social.idea.create', { title: 'x', fileIds: [foreignFile] })).rejects.toMatchObject({ code: 'MEDIA_NOT_FOUND' });
    await expect(exec(b, b.member, 'social.idea.create', { title: 'x', labelIds: [foreignLabel] })).rejects.toMatchObject({ code: 'LABEL_NOT_FOUND' });
    await expect(exec(b, b.member, 'social.idea.move', { ideaId: foreignIdea, stage: 'planned' })).rejects.toMatchObject({ code: 'IDEA_NOT_FOUND' });
    await expect(exec(b, b.member, 'social.post.create', { body: 'x', ideaId: foreignIdea, channels: [{ connectionId: conn }] })).rejects.toMatchObject({ code: 'IDEA_NOT_FOUND' });
    expect((await board(b, b.owner)).ideas).toEqual([]);
    // A file of a type posts never take is not a library file (a PDF is one since #1119).
    const doc = await socialFile(b.orgId, b.owner, 'application/xml');
    await expect(exec(b, b.member, 'social.idea.create', { title: 'x', fileIds: [doc] })).rejects.toMatchObject({ code: 'MEDIA_NOT_FOUND' });
    // crove_tenant holds no DELETE on ideas.
    const { rows } = await admin((c) => c.query<{ ok: boolean }>("SELECT has_table_privilege('crove_tenant', 'crove_social.idea', 'DELETE') AS ok"));
    expect(rows).toEqual([{ ok: false }]);
  });
});
