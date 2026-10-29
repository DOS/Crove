// Review and report links of a member who loses the right to make them (#625) on PostgreSQL 17: removed, or moved
// below admin, their live links stop working; made admin again before the worker ran, they keep them. Set
// CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { socialCommands, socialQueries } from '@crove/mod-social';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const SYSTEM = { type: 'system' as const, component: 'social.links' };
const suite = ADMIN ? describe : describe.skip;

suite('links of a member who loses the right to make them (#625)', () => {
  const dbName = `crove_test_social_link_revoke_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let app: Runtime;
  let worker: Runtime;
  let db: Db;
  let appPool: pg.Pool;
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const asMfa = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal2' as const, sessionId: randomUUID(), mfaAt: Math.floor(Date.now() / 1000) });

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
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
    const runtimeFor = (user: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = user;
      url.password = password;
      const pool = createPool({ connectionString: url.toString(), max: 4 });
      pools.push(pool);
      const d = createDb(pool);
      return { pool, db: d, runtime: new Runtime(d, { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands, ...socialCommands], queries: [...kernelQueries({ inboundDomain: null }), ...socialQueries] }) };
    };
    const api = runtimeFor('crove_app', 'test-app-pw');
    app = api.runtime;
    db = api.db;
    appPool = api.pool;
    worker = runtimeFor('crove_worker', 'test-worker-pw').runtime;
  });

  afterAll(async () => {
    for (const pool of pools) await pool.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  async function setup() {
    const person = (name: string) => upsertIdentity(db, { issuer: 'links', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 6)}@links.test`, name: null });
    const owner = await person('owner');
    const editor = await person('editor');
    const { orgId } = await createOrg(app, asUser(owner), 'Agency');
    await admin((c) => c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin')", [orgId, editor]));
    const connection = randomUUID();
    await admin((c) =>
      c.query('INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, $3, $4, $5, $6)', [orgId, connection, 'sandbox', `acct-${connection.slice(0, 8)}`, 'Kênh thử', owner]),
    );
    const as = (user: string) => ({ actor: asUser(user), orgId });
    const { postId } = await app.execute<{ postId: string }>('social.post.create', { body: 'Bài cho khách', channels: [{ connectionId: connection }] }, as(editor));
    const mine = await app.execute<{ token: string }>('social.review_link.create', { postId }, as(editor));
    const theirs = await app.execute<{ token: string }>('social.review_link.create', { postId }, as(owner));
    const now = Date.now();
    await app.execute('social.report_link.create', { periodStart: new Date(now - 7 * 86_400_000).toISOString(), periodEnd: new Date(now).toISOString() }, as(editor));
    // The org's calendar feed (#862), made by the admin.
    await app.execute('social.calendar_feed.create', {}, as(editor));
    return { owner, editor, orgId, mine, theirs };
  }

  const live = async (orgId: string, table: 'review_link' | 'report_link' | 'calendar_feed', user: string) =>
    admin(async (c) => (await c.query(`SELECT count(*)::int AS n FROM crove_social.${table} WHERE org_id = $1 AND created_by = $2 AND revoked_at IS NULL`, [orgId, user])).rows[0]?.n as number);
  const view = async (token: string) => (await appPool.query<{ page: unknown }>('SELECT crove_social.review_link_view($1) AS page', [token])).rows[0]?.page ?? null;
  const lastEvent = async (orgId: string, type: string) =>
    admin(async (c) => (await c.query<{ id: string }>('SELECT id FROM crove_kernel.outbox_event WHERE org_id = $1 AND type = $2 ORDER BY created_at DESC, id DESC LIMIT 1', [orgId, type])).rows[0]?.id as string);

  it('revokes the review and report links and the calendar feed of an admin moved to member, and only theirs', async () => {
    const s = await setup();
    await app.execute('kernel.member.change_role', { userId: s.editor, role: 'member' }, { actor: asMfa(s.owner), orgId: s.orgId });
    const eventId = await lastEvent(s.orgId, 'kernel.member.role_changed');
    expect(await worker.execute('social.links.revoke_for_member', { eventId }, { actor: SYSTEM, orgId: s.orgId })).toEqual({ review: 1, report: 1, calendar: 1 });
    expect(await live(s.orgId, 'review_link', s.editor)).toBe(0);
    expect(await live(s.orgId, 'report_link', s.editor)).toBe(0);
    expect(await live(s.orgId, 'calendar_feed', s.editor)).toBe(0);
    expect(await view(s.mine.token)).toBeNull();
    // The owner's own link still works, and a second run changes nothing.
    expect(await view(s.theirs.token)).not.toBeNull();
    expect(await worker.execute('social.links.revoke_for_member', { eventId }, { actor: SYSTEM, orgId: s.orgId })).toEqual({ review: 0, report: 0, calendar: 0 });
    const by = await admin(async (c) => (await c.query('SELECT DISTINCT revoked_by FROM crove_social.review_link WHERE org_id = $1 AND created_by = $2', [s.orgId, s.editor])).rows);
    expect(by).toEqual([{ revoked_by: s.owner }]);
  });

  it('revokes them when the member is removed, and keeps them when the member is an admin again', async () => {
    const removed = await setup();
    await app.execute('kernel.member.remove', { userId: removed.editor }, { actor: asMfa(removed.owner), orgId: removed.orgId });
    const gone = await lastEvent(removed.orgId, 'kernel.member.removed');
    expect(await worker.execute('social.links.revoke_for_member', { eventId: gone }, { actor: SYSTEM, orgId: removed.orgId })).toEqual({ review: 1, report: 1, calendar: 1 });

    const back = await setup();
    await app.execute('kernel.member.change_role', { userId: back.editor, role: 'member' }, { actor: asMfa(back.owner), orgId: back.orgId });
    const demoted = await lastEvent(back.orgId, 'kernel.member.role_changed');
    await app.execute('kernel.member.change_role', { userId: back.editor, role: 'admin' }, { actor: asMfa(back.owner), orgId: back.orgId });
    expect(await worker.execute('social.links.revoke_for_member', { eventId: demoted }, { actor: SYSTEM, orgId: back.orgId })).toEqual({ review: 0, report: 0, calendar: 0 });
    expect(await view(back.mine.token)).not.toBeNull();
    // Only the worker runs it.
    await expect(app.execute('social.links.revoke_for_member', { eventId: demoted }, { actor: asUser(back.owner), orgId: back.orgId })).rejects.toMatchObject({ status: 403 });
  });
});
