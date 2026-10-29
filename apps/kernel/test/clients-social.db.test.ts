// Social figures on the multi-client home (#1261) on PostgreSQL 17: me.clients gives each org the Social figures its
// member sees on that org's own Social screens (the Review and Attention tabs, the channels to reconnect for owners and
// admins, the Upcoming agenda's next 7 days, which leaves out drafts and posts in review with a planned time, the last
// post), for an owner and for a member limited to some channels (#1081), read in the org's own context, and the org's
// own overview (org.overview, #1249) gives the same; a deployment without the Social module shows no Social figures;
// and one org whose figures fail is an error row while the others load (#495).
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { sql } from 'kysely';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { zClientOverviews } from '@crove/kernel-contract';
import { clientOverviews, createOrg, kernelCommands, kernelQueries, upsertIdentity, type ClientOverview } from '@crove/kernel';
import { Runtime, defineQuery } from '@crove/kernel-runtime';
import { AGENDA_STATUSES, socialCommands, socialOverviewContributions, socialQueries, type PostView, type SocialClientFigures } from '@crove/mod-social';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const DAY = 86_400_000;

suite('Social figures on the multi-client home on PostgreSQL (#1261)', () => {
  const dbName = `crove_test_clients_social_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  // The accountant owns both companies; the freelancer is a member of An Bình limited to channels A and D.
  let owner = '';
  let freelancer = '';
  let anBinh = '';
  let binhMinh = '';
  const ch = { a: '', b: '', c: '', d: '', e: '' };
  const at = { lastByFreelancer: '', lastByOwner: '' };

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  const person = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@clients-social.test`, name: null });
  async function connection(orgId: string, name: string) {
    const id = randomUUID();
    await admin((c) =>
      c.query('INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, $3, $4, $5, $6)', [orgId, id, 'sandbox', `acct-${id.slice(0, 8)}`, name, owner]),
    );
    return id;
  }
  const exec = <O>(user: string, name: string, input: unknown, orgId = anBinh) => rt.execute<O>(name, input, { actor: asUser(user), orgId });
  const query = <O>(user: string, name: string, input: unknown, orgId = anBinh, runtime = rt) => runtime.query<O>(name, input, { actor: asUser(user), orgId });
  async function post(user: string, connections: string[], body: string, extra: Record<string, unknown> = {}) {
    const { postId } = await exec<{ postId: string }>(user, 'social.post.create', { body, channels: connections.map((connectionId) => ({ connectionId })), ...extra });
    return postId;
  }
  const seen = (p: PostView) => p.variants.map((v) => ({ variantId: v.id, revision: v.revision, contentHash: v.contentHash }));
  const home = async (user: string, runtime = rt): Promise<ClientOverview[]> => {
    const answer = await clientOverviews(runtime, asUser(user));
    // The answer is what the contract lets through to the SPA.
    zClientOverviews.parse(answer);
    return answer.clients;
  };
  const socialOf = (rows: ClientOverview[], orgId: string) => {
    const row = rows.find((r) => r.orgId === orgId);
    expect(row?.error).toBeNull();
    return row?.overview?.modules.social as SocialClientFigures | undefined;
  };

  // What the member sees on the org's own Social screens, read with the queries those screens call: the tabs' lists,
  // the attention inbox's channels (owners and admins only), and the Upcoming agenda's lines (a variant in
  // AGENDA_STATUSES at its time) in the next 7 days.
  async function screens(user: string, orgId: string) {
    const list = (input: Record<string, unknown>) => query<PostView[]>(user, 'social.post.list', { ...input, limit: 200 }, orgId);
    const review = await list({ stage: 'review' });
    const now = Date.now();
    const inbox = await query<{ channels: unknown[] }>(user, 'social.attention.inbox', {}, orgId);
    const agenda = await list({ from: new Date(now - DAY).toISOString(), to: new Date(now + 8 * DAY).toISOString() });
    return {
      review: review.length,
      waitingClient: review.filter((p) => p.variants.some((v) => v.status === 'in_review' && v.review.client && v.review.approvedBy.length >= v.review.required)).length,
      attention: (await list({ stage: 'attention' })).length,
      reconnect: inbox.channels.length,
      upcoming: agenda.filter((p) =>
        p.variants.some((v) => (AGENDA_STATUSES as readonly string[]).includes(v.status) && v.effectiveAt !== null && Date.parse(v.effectiveAt) >= now && Date.parse(v.effectiveAt) < now + 7 * DAY),
      ).length,
    };
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
    pool = createPool({ connectionString: app.toString(), max: 6 });
    db = createDb(pool);
    rt = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands, ...socialCommands], queries: [...kernelQueries({ inboundDomain: null, overview: socialOverviewContributions }), ...socialQueries] });

    owner = await person('owner');
    freelancer = await person('freelancer');
    ({ orgId: anBinh } = await createOrg(rt, asUser(owner), 'Công ty An Bình'));
    ({ orgId: binhMinh } = await createOrg(rt, asUser(owner), 'Công ty Bình Minh'));
    await admin((c) => c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')", [anBinh, freelancer]));
    for (const key of Object.keys(ch) as (keyof typeof ch)[]) ch[key] = await connection(anBinh, `Kênh ${key.toUpperCase()}`);
    // C waits for the client's approval on a review link (#770); D's sign-in expired and E's broke.
    await exec(owner, 'social.channel.set_client_approval', { connectionId: ch.c, clientApproval: true });
    await admin((c) => c.query("UPDATE crove_kernel.channel_connection SET status = CASE WHEN id = $1 THEN 'expired' ELSE 'error' END WHERE id IN ($1, $2)", [ch.d, ch.e]));
    await exec(owner, 'social.channel_access.set', { userId: freelancer, channelConnectionIds: [ch.a, ch.d] });

    // In review: the freelancer's post on A, the owner's on B, and one on C the team approved that waits for the client.
    await exec(freelancer, 'social.post.submit', { postId: await post(freelancer, [ch.a], 'Bài chờ duyệt trên A') });
    await exec(owner, 'social.post.submit', { postId: await post(owner, [ch.b], 'Bài chờ duyệt trên B') });
    const forClient = await post(owner, [ch.c], 'Bài chờ khách duyệt');
    await exec(owner, 'social.post.submit', { postId: forClient });
    await exec(owner, 'social.variant.decide', { postId: forClient, decision: 'approved', variants: seen(await query<PostView>(owner, 'social.post.get', { postId: forClient })) });
    // A post on A and B whose B channel failed: it needs attention, but not for the freelancer, who cannot see B.
    const failed = await post(owner, [ch.a, ch.b], 'Bài lỗi trên B');
    await admin((c) => c.query("UPDATE crove_social.post_variant SET status = 'failed', error_code = 'TOKEN_EXPIRED' WHERE post_id = $1 AND channel_connection_id = $2", [failed, ch.b]));
    // Scheduled in the next 7 days on A and on B, and one later on B: the agenda's lines.
    const scheduled = async (connection: string, body: string, days: number) => {
      const postId = await post(owner, [connection], body);
      await exec(owner, 'social.post.submit', { postId });
      await exec(owner, 'social.variant.decide', { postId, decision: 'approved', variants: seen(await query<PostView>(owner, 'social.post.get', { postId })) });
      await exec(owner, 'social.variant.schedule', { postId, at: new Date(Date.now() + days * DAY).toISOString() });
    };
    await scheduled(ch.a, 'Bài tuần này trên A', 2);
    await scheduled(ch.b, 'Bài tuần này trên B', 3);
    await scheduled(ch.b, 'Bài tháng sau trên B', 10);
    // A draft on A and a post in review on B with a planned time this week: not on the agenda, so not counted.
    await post(owner, [ch.a], 'Nháp có giờ trên A', { scheduledAt: new Date(Date.now() + 2 * DAY).toISOString() });
    await exec(owner, 'social.post.submit', { postId: await post(owner, [ch.b], 'Bài chờ duyệt có giờ trên B', { scheduledAt: new Date(Date.now() + 2 * DAY).toISOString() }) });
    // Gone out: on A three days ago, on B yesterday.
    const outA = await post(owner, [ch.a], 'Bài đã đăng trên A');
    const outB = await post(owner, [ch.b], 'Bài đã đăng trên B');
    const published = async (postId: string, daysAgo: number) =>
      admin(async (c) => (await c.query<{ at: Date }>("UPDATE crove_social.post_variant SET status = 'published', published_at = now() - make_interval(days => $2) WHERE post_id = $1 RETURNING published_at AS at", [postId, daysAgo])).rows[0]?.at.toISOString() ?? '');
    at.lastByFreelancer = await published(outA, 3);
    at.lastByOwner = await published(outB, 1);
  });

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it("gives the owner each org's figures as that org's Social screens count them", async () => {
    const rows = await home(owner);
    expect(rows.map((r) => r.orgId).sort()).toEqual([anBinh, binhMinh].sort());
    const figures = socialOf(rows, anBinh);
    expect(figures).toEqual({ review: 4, waitingClient: 1, attention: 1, reconnect: 2, upcoming: 2, lastPostAt: at.lastByOwner });
    const { lastPostAt: _, ...counts } = figures as SocialClientFigures;
    expect(counts).toEqual(await screens(owner, anBinh));
    // The org's own overview (org.overview, #1249) reads the same figures.
    expect(await query(owner, 'kernel.org.overview', {})).toEqual(rows.find((r) => r.orgId === anBinh)?.overview);
    // The other company has nothing yet.
    expect(socialOf(rows, binhMinh)).toEqual({ review: 0, waitingClient: 0, attention: 0, reconnect: 0, upcoming: 0, lastPostAt: null });
    expect(await screens(owner, binhMinh)).toEqual({ review: 0, waitingClient: 0, attention: 0, reconnect: 0, upcoming: 0 });
  });

  it("gives a member limited to some channels their channels' figures only, as their own screens show them", async () => {
    const rows = await home(freelancer);
    // The freelancer belongs to An Bình only.
    expect(rows.map((r) => r.orgId)).toEqual([anBinh]);
    const figures = socialOf(rows, anBinh);
    // Channels to reconnect are for owners and admins, who can reconnect them.
    expect(figures).toEqual({ review: 1, waitingClient: 0, attention: 0, reconnect: 0, upcoming: 1, lastPostAt: at.lastByFreelancer });
    const { lastPostAt: _, ...counts } = figures as SocialClientFigures;
    expect(counts).toEqual(await screens(freelancer, anBinh));
    // Lifting the limit gives them every channel's figures, as their screens then show.
    await exec(owner, 'social.channel_access.set', { userId: freelancer, channelConnectionIds: [] });
    try {
      const all = socialOf(await home(freelancer), anBinh);
      expect(all).toMatchObject({ review: 4, waitingClient: 1, attention: 1, reconnect: 0, upcoming: 2, lastPostAt: at.lastByOwner });
      const { lastPostAt: __, ...lifted } = all as SocialClientFigures;
      expect(lifted).toEqual(await screens(freelancer, anBinh));
    } finally {
      await exec(owner, 'social.channel_access.set', { userId: freelancer, channelConnectionIds: [ch.a, ch.d] });
    }
  });

  it('shows no Social figures on a deployment without the Social module, and the other figures as before', async () => {
    const withSocial = await home(owner);
    // The contribution is named, but the runtime leaves Social out: the lookup answers not_installed and adds nothing.
    const kernelOnly = new Runtime(db, { manifests: TEST_MANIFESTS, absentModules: ['social'] }).register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: null, overview: socialOverviewContributions }) });
    // And a deployment whose composition root names no contribution at all.
    const unnamed = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) });
    for (const runtime of [kernelOnly, unnamed]) {
      const rows = await home(owner, runtime);
      for (const row of rows) {
        expect(row.error).toBeNull();
        expect(row.overview?.modules).toEqual({});
        const { modules: _, ...rest } = row.overview ?? { modules: {} };
        const { modules: __, ...before } = withSocial.find((r) => r.orgId === row.orgId)?.overview ?? { modules: {} };
        expect(rest).toEqual(before);
      }
    }
  });

  it('shows an org whose figures fail as an error row, and the other org as usual (#495)', async () => {
    // A module whose figures fail in Bình Minh with a real database error, which aborts that org's transaction.
    const broken = defineQuery({
      name: 'broken.figures',
      input: z.object({}),
      access: ['owner', 'admin', 'member', 'viewer'],
      handler: async (ctx) => {
        if (ctx.orgId === binhMinh) await sql`SELECT 1 / 0`.execute(ctx.trx);
        return { ok: true };
      },
    });
    const runtime = new Runtime(db, { manifests: TEST_MANIFESTS }).register({
      commands: [...kernelCommands, ...socialCommands],
      queries: [...kernelQueries({ inboundDomain: null, overview: [...socialOverviewContributions, { module: 'broken', query: 'broken.figures' }] }), ...socialQueries, broken],
    });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const rows = await home(owner, runtime);
      const failed = rows.find((r) => r.orgId === binhMinh);
      expect(failed).toMatchObject({ name: 'Công ty Bình Minh', overview: null, error: expect.any(String) });
      expect(failed?.error).not.toBe('');
      const ok = rows.find((r) => r.orgId === anBinh);
      expect(ok?.error).toBeNull();
      expect(ok?.overview?.modules.social).toMatchObject({ review: 4, attention: 1 });
      expect(logged).toHaveBeenCalled();
      // Nothing of the failure reaches the answer but its code.
      expect(JSON.stringify(rows)).not.toContain('division by zero');
    } finally {
      logged.mockRestore();
    }
  });
});
