// The AI summary of a period (#1237) on PostgreSQL 17, with the two fixes it folds in. #1164: a channel that mixes
// posts with and without reach gets its engagement rate from the posts that report reach, in the Metrics tab's totals
// and in the client report. #1075: a report link that counts outside posts counts Crove's posts only in its goals, as
// the app's goals do. The summary through the API: written from the tab's own figures by a recorded model, refused
// when it cites another number, refused for viewers, a server without AI and a limited member naming another channel
// before the model is asked, and saved nowhere. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own
// database.
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { kernelCommands, kernelQueries } from '@crove/kernel';
import { monthBounds, socialCommands, socialQueries, type GoalsProgressView, type WindowTotals } from '@crove/mod-social';
import { engagementRate, engagementRateOfBases } from '@crove/mod-social/contract';
import { CredentialVault, Runtime, parseVaultKey, type BlobStore } from '@crove/kernel-runtime';
import { SocialWriter, type SummaryGenerator } from '@crove/agent';
import { createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { socialDrafter } from '../src/kernel.ts';
import { reportView, type ReportPage } from '../src/report-link.ts';
import { createSessionStatusSource } from '../src/sessions.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const SECRET = 'test-only-jwt-secret-for-ai-summary-0123456789';
const ISSUER = 'crove-auth';
const HCM = 'Asia/Ho_Chi_Minh';
const suite = ADMIN ? describe : describe.skip;

interface Account {
  subject: string;
  email: string;
  session: string;
  userId: string;
}

// September 2026 in Ho Chi Minh City, as a report link's period.
const SEP = monthBounds('2026-09', HCM) as { start: number; end: number };
const SEPTEMBER = { periodStart: new Date(SEP.start).toISOString(), periodEnd: new Date(SEP.end).toISOString() };

suite('AI summary of a period, and the rate and goals it repeats (#1237, #1164, #1075)', () => {
  const dbName = `crove_test_social_ai_summary_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  let apps: Record<'on' | 'noAi', ReturnType<typeof createHttpApp>>;
  // The model, recorded: what it was asked, and the answers the tests queue. By default it writes back the posts
  // figure it was given, which is faithful.
  const asked: Parameters<SummaryGenerator>[0][] = [];
  const answers: string[] = [];
  const generateSummary: SummaryGenerator = async (args) => {
    asked.push(args);
    const queued = answers.shift();
    if (queued !== undefined) return { summary: queued };
    const posts = /Posts published, this period: ([\d.,]+)/.exec(args.prompt)?.[1] ?? '';
    return { summary: `Kỳ này chúng tôi đã đăng ${posts} bài.` };
  };
  const owner: Account = { subject: randomUUID(), email: 'owner@ai-summary.test', session: randomUUID(), userId: '' };
  const viewer: Account = { subject: randomUUID(), email: 'viewer@ai-summary.test', session: randomUUID(), userId: '' };
  const member: Account = { subject: randomUUID(), email: 'member@ai-summary.test', session: randomUUID(), userId: '' };
  let org = { slug: '', orgId: '' };
  // fb: the member's channel; zalo: another channel of the org.
  let channels: { fb: string; zalo: string };
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

  async function tokenFor(who: Account) {
    return new SignJWT({ role: 'authenticated', email: who.email, session_id: who.session, aal: 'aal1', is_anonymous: false })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(who.subject)
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(new TextEncoder().encode(SECRET));
  }

  async function rpc(path: string, token: string, input: unknown, options: { slug?: string | null; app?: keyof typeof apps } = {}) {
    const slug = options.slug === undefined ? org.slug : options.slug;
    const response = await apps[options.app ?? 'on'].request(`/api/rpc/${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(slug ? { 'x-crove-org': slug } : {}) },
      body: JSON.stringify(input === undefined ? {} : { json: input }),
    });
    const body = (await response.json().catch(() => null)) as ({ json?: unknown } & Record<string, unknown>) | null;
    return { status: response.status, body: (body && 'json' in body ? body.json : body) as any };
  }

  async function connection(orgId: string, provider: string, by: string, name: string) {
    const id = randomUUID();
    await admin((c) =>
      c.query('INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, $3, $4, $5, $6)', [
        orgId,
        id,
        provider,
        `acct-${id.slice(0, 8)}`,
        name,
        by,
      ]),
    );
    return id;
  }

  const exec = <O>(orgId: string, user: string, name: string, input: unknown) => rt.execute<O>(name, input, { actor: asUser(user), orgId });
  const query = <O>(orgId: string, user: string, name: string, input: unknown) => rt.query<O>(name, input, { actor: asUser(user), orgId });

  // A post published on a channel at a time (an ISO instant, or days ago), with its latest counts.
  async function published(orgId: string, conn: string, body: string, at: string | number, metrics: Record<string, number>) {
    const { postId } = await exec<{ postId: string }>(orgId, owner.userId, 'social.post.create', { body, channels: [{ connectionId: conn }] });
    await admin(async (c) => {
      const when = typeof at === 'number' ? new Date(Date.now() - at * 86_400_000).toISOString() : at;
      const { rows } = await c.query<{ id: string }>("UPDATE crove_social.post_variant SET status = 'published', published_at = $2 WHERE post_id = $1 RETURNING id", [postId, when]);
      await c.query("INSERT INTO crove_social.metric_snapshot (org_id, variant_id, capture_key, metrics) VALUES ($1, $2, 'k', $3)", [orgId, rows[0]?.id, JSON.stringify(metrics)]);
    });
    return postId;
  }
  const outside = (orgId: string, conn: string, id: string, at: string | number, metrics: Record<string, number>) =>
    admin((c) =>
      c.query('INSERT INTO crove_social.external_post (org_id, channel_connection_id, external_post_id, excerpt, published_at, metrics) VALUES ($1, $2, $3, $4, $5, $6)', [
        orgId,
        conn,
        id,
        'Bài đăng thẳng trên trang',
        typeof at === 'number' ? new Date(Date.now() - at * 86_400_000).toISOString() : at,
        JSON.stringify(metrics),
      ]),
    );

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
    const appUrl = new URL(adminUrl);
    appUrl.username = 'crove_app';
    appUrl.password = 'test-app-pw';
    pool = createPool({ connectionString: appUrl.toString(), max: 4 });
    db = createDb(pool);
    const kernel = { commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) };
    rt = new Runtime(db).register({ commands: [...kernel.commands, ...socialCommands], queries: [...kernel.queries, ...socialQueries] });
    const runtime = new Runtime(db, { sessions: createSessionStatusSource('off'), stepUp: 'required' }).register({
      commands: [...kernel.commands, ...socialCommands],
      queries: [...kernel.queries, ...socialQueries],
    });
    const config = loadConfig({ DATABASE_URL: appUrl.toString(), AUTH_JWT_SECRET: SECRET, AUTH_ISSUER: ISSUER, AUTH_SESSION_CHECK: 'off', MIGRATIONS_DIR: MIGRATIONS, WEB_DIST: '/nonexistent' });
    // The writer as the kernel wires it, with the recorded model in place of the endpoint.
    const writer = new SocialWriter({ baseURL: 'http://localhost:1/v1', apiKey: null, model: 'test' }, undefined, undefined, undefined, undefined, undefined, generateSummary);
    const vault = new CredentialVault([parseVaultKey(randomBytes(32).toString('base64'))]);
    const store = {} as BlobStore;
    const make = (socialWriter?: ReturnType<typeof socialDrafter>) =>
      createHttpApp({ config, runtime, store, authenticate: createAuthenticator(config, db), pool, aiEnabled: true, channels: { broker: vault, sandbox: true }, ...(socialWriter ? { socialWriter } : {}) });
    apps = { on: make(socialDrafter(writer, null)), noAi: make() };

    for (const who of [owner, viewer, member]) {
      const me = await rpc('me/get', await tokenFor(who), undefined, { slug: null });
      expect(me.status).toBe(200);
      who.userId = String(me.body?.userId);
    }
    const created = await rpc('org/create', await tokenFor(owner), { name: 'Tiệm bánh Mai', idempotencyKey: randomUUID() }, { slug: null });
    expect(created.status).toBe(200);
    org = { slug: String(created.body?.slug), orgId: String(created.body?.orgId) };
    await admin(async (c) => {
      await c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'viewer')", [org.orgId, viewer.userId]);
      await c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')", [org.orgId, member.userId]);
    });
    channels = { fb: await connection(org.orgId, 'facebook_page', owner.userId, 'Trang Bánh Mai 24h'), zalo: await connection(org.orgId, 'zalo_oa', owner.userId, 'Zalo Bí Mật') };
    // The member may use the Facebook page only (#1081).
    await admin((c) =>
      c.query('INSERT INTO crove_social.channel_access (org_id, user_id, channel_connection_id, created_by) VALUES ($1, $2, $3, $4)', [org.orgId, member.userId, channels.fb, owner.userId]),
    );
    // The last 30 days: on the page, a post that reports reach and one that does not (an older capture), and one with
    // impressions only; on Zalo, views only. 10 days before the window, one post on the page.
    await published(org.orgId, channels.fb, 'Bánh mới ra lò, giảm 50% hôm nay', 2, { reach: 2000, reactions: 40 });
    await published(org.orgId, channels.fb, 'Bánh kem sinh nhật', 3, { reactions: 20 });
    await published(org.orgId, channels.fb, 'Hậu trường bếp', 4, { impressions: 500, comments: 5 });
    await published(org.orgId, channels.zalo, 'Tin Zalo', 5, { views: 300, reactions: 3 });
    await published(org.orgId, channels.fb, 'Tháng trước', 40, { reach: 1000, reactions: 10 });
  });

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it("takes a channel's engagement rate from the posts that report reach, next to the plain sums (#1164)", async () => {
    const t = await query<WindowTotals & { previous: WindowTotals }>(org.orgId, owner.userId, 'social.metrics.totals', { days: 30 });
    const page = t.channels.find((c) => c.connectionId === channels.fb);
    // The plain sums are as before.
    expect(page?.metrics).toEqual({ reach: 2000, reactions: 60, impressions: 500, comments: 5 });
    // The rate sums: 40 over the 2000 reached by the post that reports reach; 5 over the 500 impressions of the other.
    expect(page?.rateBases).toEqual({ reach: { engagement: 40, denominator: 2000 }, impressions: { engagement: 5, denominator: 500 } });
    expect(engagementRateOfBases([page?.rateBases])).toMatchObject({ rate: 0.02, basis: 'reach' });
    // The plain sums would have read 65 over 2000 (3.25%).
    expect(engagementRate(page?.metrics ?? {})?.rate).toBe(65 / 2000);
    // Zalo reports neither; the window adds up its channels'.
    expect(t.channels.find((c) => c.connectionId === channels.zalo)?.rateBases).toEqual({});
    expect(t.rateBases).toEqual(page?.rateBases);
    expect(t.previous.rateBases).toEqual({ reach: { engagement: 10, denominator: 1000 } });
    // An outside post without reach adds to the sums, never to the rate over reach.
    await outside(org.orgId, channels.fb, 'ext-noreach', 1, { reactions: 100 });
    const withOutside = await query<WindowTotals>(org.orgId, owner.userId, 'social.metrics.totals', { days: 30, includeExternal: true });
    expect(withOutside.channels.find((c) => c.connectionId === channels.fb)).toMatchObject({ metrics: { reactions: 160 }, rateBases: { reach: { engagement: 40, denominator: 2000 } } });
    await admin((c) => c.query("DELETE FROM crove_social.external_post WHERE external_post_id = 'ext-noreach'"));
  });

  it("gives the client report the same rate sums, and counts its goals as the app's goals, without outside posts (#1164, #1075)", async () => {
    const o = (await rpc('org/create', await tokenFor(owner), { name: 'Tiệm thứ hai', idempotencyKey: randomUUID() }, { slug: null })).body;
    const orgId = String(o.orgId);
    const fb = await connection(orgId, 'facebook_page', owner.userId, 'Trang thứ hai');
    await published(orgId, fb, 'Có reach', '2026-09-05T03:00:00Z', { reach: 2000, reactions: 40 });
    await published(orgId, fb, 'Không có reach', '2026-09-06T03:00:00Z', { reactions: 20 });
    await published(orgId, fb, 'Tháng 8', '2026-08-20T03:00:00Z', { reach: 500, reactions: 5 });
    await outside(orgId, fb, 'ext-1', '2026-09-07T03:00:00Z', { reach: 800, reactions: 80 });
    await exec(orgId, owner.userId, 'social.goal.set', { connectionId: null, targets: { posts: 3, reach: 2500, engagement: 100 }, timeZone: HCM });
    const plain = await exec<{ token: string }>(orgId, owner.userId, 'social.report_link.create', SEPTEMBER);
    const page = (await reportView(rt, { token: plain.token })) as ReportPage;
    expect(page.totals).toMatchObject({ reach: 2000, reactions: 60 });
    expect(page.rateBases).toEqual({ reach: { engagement: 40, denominator: 2000 } });
    expect(page.channels[0]?.rateBases).toEqual({ reach: { engagement: 40, denominator: 2000 } });
    expect(page.previous.rateBases).toEqual({ reach: { engagement: 5, denominator: 500 } });
    expect(page.channels[0]?.previous.rateBases).toEqual({ reach: { engagement: 5, denominator: 500 } });
    // With outside posts: they count in the totals and the rate, but the goals count Crove's posts only, as the app's.
    const withOutside = await exec<{ token: string }>(orgId, owner.userId, 'social.report_link.create', { ...SEPTEMBER, includeExternal: true });
    const page2 = (await reportView(rt, { token: withOutside.token })) as ReportPage;
    expect(page2.posts).toBe(3);
    expect(page2.totals).toMatchObject({ reach: 2800, reactions: 140 });
    expect(page2.rateBases).toEqual({ reach: { engagement: 120, denominator: 2800 } });
    const items = Object.fromEntries((page2.goals?.groups[0]?.items ?? []).map((i) => [i.metric, i.actual]));
    expect(items).toEqual({ posts: 2, reach: 2000, engagement: 60 });
    const app = await query<GoalsProgressView>(orgId, owner.userId, 'social.goal.progress', { month: '2026-09' });
    expect(Object.fromEntries((app.goals[0]?.progress ?? []).map((p) => [p.metric, p.actual]))).toEqual(items);
    // And the link without outside posts shows the same goals.
    expect(page.goals?.groups).toEqual(page2.goals?.groups);
  });

  // The view is re-created from 20261029110000: a link without outside posts gives what that definition gives, but for
  // the rateBases objects.
  it('gives exactly the previous output, but for the rate sums, for a link without outside posts', async () => {
    const o = (await rpc('org/create', await tokenFor(owner), { name: 'Tiệm thứ ba', idempotencyKey: randomUUID() }, { slug: null })).body;
    const orgId = String(o.orgId);
    const fb = await connection(orgId, 'facebook_page', owner.userId, 'Trang ba');
    const zalo = await connection(orgId, 'zalo_oa', owner.userId, 'Zalo ba');
    await published(orgId, fb, 'Một', '2026-09-05T03:00:00Z', { reach: 700, impressions: 900, reactions: 40, comments: 8, shares: 6, saves: 4, clicks: 3, views: 1200 });
    await published(orgId, zalo, 'Hai', '2026-09-06T03:00:00Z', { views: 80, reactions: 2 });
    await published(orgId, fb, 'Ba', '2026-08-20T03:00:00Z', { reach: 30, reactions: 2 });
    await exec(orgId, owner.userId, 'social.goal.set', { connectionId: null, targets: { posts: 3, reach: 1000 }, timeZone: HCM });
    const link = await exec<{ token: string }>(orgId, owner.userId, 'social.report_link.create', { ...SEPTEMBER, title: 'Tháng 9' });
    const previous = readFileSync(join(MIGRATIONS, '20261029110000_crove_social_campaign_report.sql'), 'utf8');
    const strip = (value: unknown): unknown =>
      Array.isArray(value) ? value.map(strip) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([k]) => k !== 'rateBases').map(([k, v]) => [k, strip(v)])) : value;
    const pages = await admin(async (c) => {
      const read = async () => (await c.query<{ page: unknown }>('SELECT crove_social.report_link_view($1) AS page', [link.token])).rows[0]?.page;
      const now = await read();
      await c.query('BEGIN');
      try {
        await c.query(previous);
        return { now, before: await read() };
      } finally {
        await c.query('ROLLBACK');
      }
    });
    expect(pages.now).toMatchObject({ posts: 2, goals: { month: '2026-09' }, rateBases: { reach: { engagement: 61, denominator: 700 } } });
    // The sections key came after (#1259): null for a link without sections, left out here.
    const { sections, ...now } = pages.now as Record<string, unknown>;
    expect(sections).toBeNull();
    expect(strip(now)).toEqual(pages.before);
  });

  it("writes the summary from the tab's own figures and saves nothing", async () => {
    const links = async () => Number((await admin((c) => c.query<{ n: string }>('SELECT count(*) AS n FROM crove_social.report_link WHERE org_id = $1', [org.orgId]))).rows[0]?.n);
    const before = await links();
    const answer = await rpc('social/metrics/writeSummary', await tokenFor(owner), { days: 30, language: 'vi', timeZone: HCM });
    expect(answer).toMatchObject({ status: 200, body: { text: 'Kỳ này chúng tôi đã đăng 4 bài.' } });
    const prompt = asked.at(-1)?.prompt ?? '';
    expect(prompt).toContain('- Posts published, this period: 4');
    expect(prompt).toContain('- Posts published, previous period: 1');
    // The rate the tab shows (#1164): 40 over 2000, not 65 over 2000.
    expect(prompt).toContain('- Engagement rate (engagement over reach), this period: 2%');
    expect(prompt).toContain('- Channel Trang Bánh Mai 24h (facebook_page): engagement rate over reach this period: 2%');
    expect(prompt).toContain('- Reach (people reached), this period: 2.000');
    // Every channel the owner sees, and the best post's opening words fenced as data.
    expect(prompt).toContain('Channels: Trang Bánh Mai 24h; Zalo Bí Mật');
    expect(prompt).toContain('Best posts (their opening words):\n<<<\n- Best post, on Trang Bánh Mai 24h: Bánh mới ra lò, giảm 50% hôm nay');
    expect(await links()).toBe(before);
    // With the posts published outside Crove: one more post, and its counts.
    await outside(org.orgId, channels.fb, 'ext-summary', 1, { reach: 500, reactions: 60 });
    expect((await rpc('social/metrics/writeSummary', await tokenFor(owner), { days: 30, includeExternal: true })).status).toBe(200);
    expect(asked.at(-1)?.prompt).toContain('- Posts published, this period: 5');
    expect(asked.at(-1)?.prompt).toContain('- Best post: engagement: 60');
    await admin((c) => c.query("DELETE FROM crove_social.external_post WHERE external_post_id = 'ext-summary'"));
    // In English, the English forms.
    expect((await rpc('social/metrics/writeSummary', await tokenFor(owner), { days: 30, language: 'en' })).status).toBe(200);
    expect(asked.at(-1)?.prompt).toContain('- Reach (people reached), this period: 2,000');
    expect(asked.at(-1)?.system).toContain('Write in English');
  });

  it('refuses a summary that cites a number not among the figures', async () => {
    // 50 comes from the best post's own text, 77 is made up: neither is a figure.
    answers.push('Kỳ này đăng 4 bài, bài giảm 50% được yêu thích nhất với 77 lượt tương tác.');
    expect(await rpc('social/metrics/writeSummary', await tokenFor(owner), { days: 30 })).toMatchObject({ status: 422, body: { code: 'AI_SUMMARY_FIGURE_INVENTED', data: { numbers: 2 } } });
    // A faithful one with the figures, the dates and the channel's own digits passes.
    answers.push('Trong 30 ngày, Trang Bánh Mai 24h có lượt tiếp cận 2.000 và tỷ lệ tương tác 2%; kỳ này đăng 4 bài, kỳ trước 1 bài.');
    expect((await rpc('social/metrics/writeSummary', await tokenFor(owner), { days: 30 })).status).toBe(200);
  });

  it('refuses a viewer, a server without AI and a limited member naming another channel before asking the model', async () => {
    const count = asked.length;
    expect(await rpc('social/metrics/writeSummary', await tokenFor(viewer), { days: 30 })).toMatchObject({ status: 403, body: { code: 'FORBIDDEN' } });
    expect(await rpc('social/metrics/writeSummary', await tokenFor(owner), { days: 30 }, { app: 'noAi' })).toMatchObject({ status: 503, body: { code: 'AI_NOT_CONFIGURED' } });
    expect(await rpc('social/metrics/writeSummary', await tokenFor(member), { ...SEPTEMBER, connectionIds: [channels.zalo] })).toMatchObject({
      status: 403,
      body: { code: 'CHANNEL_NOT_ALLOWED', data: { connectionIds: [channels.zalo] } },
    });
    // days or a period, not both.
    expect((await rpc('social/metrics/writeSummary', await tokenFor(owner), { days: 30, ...SEPTEMBER })).status).toBe(400);
    expect(asked).toHaveLength(count);
    // The limited member's own summary: their channel only, nothing of the other.
    expect((await rpc('social/metrics/writeSummary', await tokenFor(member), { days: 30 })).status).toBe(200);
    expect(asked).toHaveLength(count + 1);
    expect(asked.at(-1)?.prompt).toContain('- Posts published, this period: 3');
    expect(asked.at(-1)?.prompt).not.toContain('Zalo');
  });

  it("puts the month's goals in a report period's figures, and asks nothing for a period without posts", async () => {
    const o = (await rpc('org/create', await tokenFor(owner), { name: 'Tiệm thứ tư', idempotencyKey: randomUUID() }, { slug: null })).body;
    const slug = String(o.slug);
    const orgId = String(o.orgId);
    const fb = await connection(orgId, 'facebook_page', owner.userId, 'Trang bốn');
    const count = asked.length;
    // Nothing published in September or August yet.
    expect(await rpc('social/metrics/writeSummary', await tokenFor(owner), SEPTEMBER, { slug })).toMatchObject({ status: 422, body: { code: 'AI_SUMMARY_NO_DATA' } });
    expect(asked).toHaveLength(count);
    await published(orgId, fb, 'Một', '2026-09-05T03:00:00Z', { reach: 1500, reactions: 30 });
    await exec(orgId, owner.userId, 'social.goal.set', { connectionId: null, targets: { posts: 3, reach: 1000 }, timeZone: HCM });
    expect((await rpc('social/metrics/writeSummary', await tokenFor(owner), { ...SEPTEMBER, timeZone: HCM }, { slug })).status).toBe(200);
    const prompt = asked.at(-1)?.prompt ?? '';
    expect(prompt).toContain('Period: 2026-09-01 to 2026-09-30 (30 days). Previous period: 2026-08-02 to 2026-08-31.');
    expect(prompt).toContain('- Monthly goal for the whole account: posts published, target: 3');
    expect(prompt).toContain('- Monthly goal for the whole account: posts published, actual (missed): 1');
    expect(prompt).toContain('- Monthly goal for the whole account: reach, actual (met): 1.500');
  });
});
