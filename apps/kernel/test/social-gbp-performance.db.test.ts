// A Google Business Profile location's performance on PostgreSQL 17 (#1477): the daily sweep keeps the figures per day
// the adapter gives on the day's snapshot, a refused token marks a Google Business connection expired and a quota
// waits; the Metrics tab and the client report take each day from the latest snapshot that holds it, so a day Google
// corrected counts once; the column's shape check; and a report link shows only its own channels' figures, of its own
// org, in its own periods. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { CredentialVault, Runtime, parseVaultKey } from '@crove/kernel-runtime';
import type { AccountMetricsInput, AccountMetricsResult, Publisher, PublishResult } from '@crove/channel';
import { socialCommands, socialQueries, sweepAccounts, utcDay, type AccountTrend } from '@crove/mod-social';
import { reportView, type ReportPage } from '../src/report-link.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

// A platform that answers each account from a table; null (no answer) where it has none.
class FakePlatform implements Publisher {
  readonly publishSafety = 'reconcile_only' as const;
  asked: AccountMetricsInput[] = [];
  answers = new Map<string, AccountMetricsResult>();
  readonly provider: 'google_business' | 'sandbox';
  constructor(provider: 'google_business' | 'sandbox') {
    this.provider = provider;
  }
  async publish(): Promise<PublishResult> {
    return { kind: 'rejected', error: 'bad_request', code: 'NOT_IN_THIS_TEST' };
  }
  async accountMetrics(input: AccountMetricsInput): Promise<AccountMetricsResult> {
    this.asked.push(input);
    return this.answers.get(input.externalAccountId) ?? null;
  }
}

type Figures = { calls: number; directions: number; websiteClicks: number; views: number };
const fig = (calls: number, directions: number, websiteClicks: number, views: number): Figures => ({ calls, directions, websiteClicks, views });

suite('Google Business performance on PostgreSQL (#1477)', () => {
  const dbName = `crove_test_social_gbp_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appPool: pg.Pool;
  let workerPool: pg.Pool;
  let appDb: Db;
  let workerDb: Db;
  let api: Runtime;
  let worker: Runtime;
  const vault = new CredentialVault([parseVaultKey(randomBytes(32).toString('base64'))]);
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const day = (ago: number) => utcDay(new Date(Date.now() - ago * 86_400_000));

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  async function org() {
    const owner = await upsertIdentity(appDb, { issuer: 'test', subject: randomUUID(), email: `owner-${randomUUID().slice(0, 8)}@gbp.test`, name: null });
    const { orgId } = await createOrg(api, asUser(owner), `Tiệm ${randomUUID().slice(0, 6)}`);
    return { orgId, owner };
  }

  async function connect(o: { orgId: string; owner: string }, provider: 'google_business' | 'sandbox', account: string, name = account) {
    const sealed = vault.seal(JSON.stringify({ accessToken: 'ya29.test', refreshToken: '1//test' }), { orgId: o.orgId, provider, externalAccountId: account });
    const { connectionId } = await api.execute<{ connectionId: string }>(
      'kernel.channel.connect',
      { provider, externalAccountId: account, displayName: name, scopes: ['https://www.googleapis.com/auth/business.manage'], expiresAt: null, credential: { keyId: sealed.keyId, envelope: sealed.envelope.toString('base64') } },
      { actor: asUser(o.owner), orgId: o.orgId },
    );
    return connectionId;
  }

  const snapshot = (orgId: string, conn: string, capturedOn: string, performance: Record<string, Figures> | null) =>
    admin((c) => c.query('INSERT INTO crove_social.account_snapshot (org_id, channel_connection_id, captured_on, performance) VALUES ($1, $2, $3, $4::jsonb)', [orgId, conn, capturedOn, performance === null ? null : JSON.stringify(performance)]));
  const trends = (o: { orgId: string; owner: string }, days: number) => api.query<AccountTrend[]>('social.account.trends', { days }, { actor: asUser(o.owner), orgId: o.orgId });
  const status = (conn: string) => admin(async (c) => (await c.query<{ status: string }>('SELECT status FROM crove_kernel.channel_connection WHERE id = $1', [conn])).rows[0]?.status);

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
    const as = (user: string, password: string) => {
      const u = new URL(adminUrl);
      u.username = user;
      u.password = password;
      return u.toString();
    };
    appPool = createPool({ connectionString: as('crove_app', 'test-app-pw'), max: 4 });
    workerPool = createPool({ connectionString: as('crove_worker', 'test-worker-pw'), max: 4 });
    appDb = createDb(appPool);
    workerDb = createDb(workerPool);
    const registry = { commands: [...kernelCommands, ...socialCommands], queries: [...kernelQueries({ inboundDomain: null }), ...socialQueries] };
    api = new Runtime(appDb).register(registry);
    worker = new Runtime(workerDb).register(registry);
  });

  afterAll(async () => {
    await appPool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('keeps the figures per day on the day\'s snapshot, marks a refused Google Business token expired and waits on a quota', async () => {
    const o = await org();
    const shop = await connect(o, 'google_business', 'accounts/1/locations/11');
    const refused = await connect(o, 'google_business', 'accounts/1/locations/12');
    const quota = await connect(o, 'google_business', 'accounts/1/locations/13');
    const oversize = await connect(o, 'google_business', 'accounts/1/locations/14');
    const other = await connect(o, 'sandbox', 'sandbox-refused');
    const gbp = new FakePlatform('google_business');
    const sandbox = new FakePlatform('sandbox');
    const figures = { [day(3)]: fig(3, 5, 7, 100), [day(2)]: fig(0, 1, 0, 2) };
    gbp.answers.set('accounts/1/locations/11', { followers: null, performance: figures });
    gbp.answers.set('accounts/1/locations/12', { refused: 'token_expired' });
    // accounts/1/locations/13: a quota answer is no answer (the adapter's null).
    // Out of bounds: kept as nothing given.
    gbp.answers.set('accounts/1/locations/14', { followers: null, performance: Object.fromEntries(Array.from({ length: 32 }, (_, i) => [day(i + 1), fig(1, 1, 1, 1)])) });
    sandbox.answers.set('sandbox-refused', { refused: 'token_expired' });
    await sweepAccounts({ runtime: worker, broker: vault, workerDb, publishers: { google_business: gbp, sandbox } });
    // One read per location per day.
    expect(gbp.asked.map((a) => a.externalAccountId).sort()).toEqual(['accounts/1/locations/11', 'accounts/1/locations/12', 'accounts/1/locations/13', 'accounts/1/locations/14']);
    const today = async (conn: string) =>
      (await admin(async (c) => (await c.query<{ followers: string | null; performance: unknown; error: string | null }>('SELECT followers, performance, error FROM crove_social.account_snapshot WHERE channel_connection_id = $1 AND captured_on = $2', [conn, day(0)])).rows))[0];
    expect(await today(shop)).toEqual({ followers: null, performance: figures, error: null });
    expect(await today(refused)).toEqual({ followers: null, performance: null, error: 'token_expired' });
    expect(await today(quota)).toEqual({ followers: null, performance: null, error: 'no_answer' });
    expect(await today(oversize)).toEqual({ followers: null, performance: null, error: null });
    expect(await status(refused)).toBe('expired');
    expect(await status(quota)).toBe('active');
    expect(await status(shop)).toBe('active');
    // Since #1546 every channel's refused token marks it expired, not only Google Business.
    expect(await today(other)).toMatchObject({ error: 'token_expired' });
    expect(await status(other)).toBe('expired');
    // Nothing is due again the same day.
    gbp.asked = [];
    await sweepAccounts({ runtime: worker, broker: vault, workerDb, publishers: { google_business: gbp, sandbox } });
    expect(gbp.asked.filter((a) => a.externalAccountId.startsWith('accounts/1/'))).toEqual([]);
    // The version check is the worker's alone.
    await expect(api.query('social.account.connection_version', { connectionId: shop }, { actor: asUser(o.owner), orgId: o.orgId })).rejects.toMatchObject({ status: 403 });
  });

  it('marks any channel expired on a refused token (#1546), but keeps one reconnected meanwhile and one only refused permission', async () => {
    const o = await org();
    const refused = await connect(o, 'sandbox', 'sandbox-1546-refused');
    const reconnected = await connect(o, 'sandbox', 'sandbox-1546-reconnected');
    const forbidden = await connect(o, 'sandbox', 'sandbox-1546-permission');
    const sandbox = new FakePlatform('sandbox');
    sandbox.answers.set('sandbox-1546-refused', { refused: 'token_expired' });
    sandbox.answers.set('sandbox-1546-reconnected', { refused: 'token_expired' });
    sandbox.answers.set('sandbox-1546-permission', { refused: 'permission' });
    const answer = sandbox.accountMetrics.bind(sandbox);
    // A reconnect lands between the sweep reading the connection and the platform refusing the old token.
    sandbox.accountMetrics = async (input) => {
      if (input.externalAccountId === 'sandbox-1546-reconnected') await admin((c) => c.query("UPDATE crove_kernel.channel_connection SET updated_at = now() + interval '1 second' WHERE id = $1", [reconnected]));
      return answer(input);
    };
    await sweepAccounts({ runtime: worker, broker: vault, workerDb, publishers: { sandbox } });
    expect(await status(refused)).toBe('expired');
    expect(await status(reconnected)).toBe('active');
    expect(await status(forbidden)).toBe('active');
  });

  it('shows each day on the Metrics tab as Google last gave it, within the window and only to its org', async () => {
    const o = await org();
    const stranger = await org();
    const shop = await connect(o, 'google_business', 'accounts/2/locations/21');
    await snapshot(o.orgId, shop, day(5), { [day(7)]: fig(1, 0, 0, 10), [day(6)]: fig(2, 0, 0, 20) });
    // A later read corrects day(6) and adds day(2).
    await snapshot(o.orgId, shop, day(1), { [day(6)]: fig(5, 1, 1, 25), [day(2)]: fig(3, 0, 2, 30) });
    const month = await trends(o, 30);
    expect(month).toEqual([
      {
        connectionId: shop,
        provider: 'google_business',
        points: [],
        audience: null,
        performance: [
          { day: day(7), ...fig(1, 0, 0, 10) },
          { day: day(6), ...fig(5, 1, 1, 25) },
          { day: day(2), ...fig(3, 0, 2, 30) },
        ],
      },
    ]);
    expect((await trends(o, 3))[0]?.performance).toEqual([{ day: day(2), ...fig(3, 0, 2, 30) }]);
    expect(await trends(stranger, 30)).toEqual([]);
  });

  it('keeps only figures of the right shape and size on a snapshot', async () => {
    const o = await org();
    const conn = await connect(o, 'google_business', 'accounts/3/locations/31');
    let n = 0;
    const insert = async (performance: unknown) => {
      n += 1;
      try {
        await admin((c) => c.query('INSERT INTO crove_social.account_snapshot (org_id, channel_connection_id, captured_on, performance) VALUES ($1, $2, $3, $4::jsonb)', [o.orgId, conn, day(100 + n), JSON.stringify(performance)]));
        return 'ok';
      } catch (error) {
        return (error as { constraint?: string }).constraint ?? String(error);
      }
    };
    expect(await insert({})).toBe('ok');
    expect(await insert({ '2026-10-20': fig(0, 0, 0, 0), '2026-10-21': fig(3, 5, 7, 1_000_000) })).toBe('ok');
    expect(await insert(Object.fromEntries(Array.from({ length: 31 }, (_, i) => [`2026-10-${String(i + 1).padStart(2, '0')}`, fig(1, 2, 3, 4)])))).toBe('ok');
    const bad: unknown[] = [
      [],
      'x',
      5,
      { 'not-a-day': fig(1, 1, 1, 1) },
      { '2026-10-20': [] },
      { '2026-10-20': 5 },
      { '2026-10-20': { calls: 1, directions: 1, websiteClicks: 1 } },
      { '2026-10-20': { ...fig(1, 1, 1, 1), extra: 1 } },
      { '2026-10-20': { ...fig(1, 1, 1, 1), calls: -1 } },
      { '2026-10-20': { ...fig(1, 1, 1, 1), views: 1.5 } },
      { '2026-10-20': { ...fig(1, 1, 1, 1), views: '1' } },
      { '2026-10-20': { ...fig(1, 1, 1, 1), views: null } },
      Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`2026-${String(10 + Math.floor(i / 28)).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`, fig(1, 2, 3, 4)])),
    ];
    for (const p of bad) expect([JSON.stringify(p).slice(0, 60), await insert(p)]).toEqual([JSON.stringify(p).slice(0, 60), 'account_snapshot_performance_shape']);
    // The table stays append-only for tenant roles, the new column with it.
    const grants = await admin(async (c) =>
      (await c.query<{ privilege_type: string }>("SELECT privilege_type FROM information_schema.role_table_grants WHERE grantee = 'crove_tenant' AND table_schema = 'crove_social' AND table_name = 'account_snapshot' ORDER BY 1")).rows.map((r) => r.privilege_type),
    );
    expect(grants).toEqual(['INSERT', 'SELECT']);
  });

  describe('in the client report', () => {
    const OCT = { periodStart: '2026-10-01T00:00:00+07:00', periodEnd: '2026-11-01T00:00:00+07:00' };
    const link = async (o: { orgId: string; owner: string }, extra: Record<string, unknown> = {}) =>
      (await api.execute<{ token: string }>('social.report_link.create', { ...OCT, ...extra }, { actor: asUser(o.owner), orgId: o.orgId })).token;
    const page = async (token: string) => (await reportView(api, { token })) as ReportPage & { performance: unknown };

    it("shows the period's figures of the link's Google Business channels only, each day as Google last gave it", async () => {
      const o = await org();
      const stranger = await org();
      const q1 = await connect(o, 'google_business', 'accounts/4/locations/41', 'Tiệm Bánh Quận 1');
      const td = await connect(o, 'google_business', 'accounts/4/locations/42', 'Tiệm Bánh Thủ Đức');
      const box = await connect(o, 'sandbox', 'sandbox-perf', 'Kênh thử');
      const theirs = await connect(stranger, 'google_business', 'accounts/5/locations/51', 'Tiệm của họ');
      // The period is 2026-09-30T17:00Z to 2026-10-31T17:00Z: 30 September's midday is in the period before, 31
      // October's in the period, 1 November's after it.
      await snapshot(o.orgId, q1, '2026-10-05', { '2026-09-30': fig(4, 4, 4, 40), '2026-10-01': fig(1, 2, 3, 10), '2026-10-02': fig(1, 1, 1, 5) });
      await snapshot(o.orgId, q1, '2026-10-06', { '2026-10-01': fig(2, 2, 3, 12) });
      await snapshot(o.orgId, q1, '2026-11-03', { '2026-10-31': fig(7, 0, 1, 30), '2026-11-01': fig(100, 100, 100, 100) });
      await snapshot(o.orgId, td, '2026-10-10', { '2026-10-09': fig(9, 9, 9, 9) });
      // A channel of another kind never shows figures, nor another org's channel.
      await snapshot(o.orgId, box, '2026-10-10', { '2026-10-09': fig(50, 50, 50, 50) });
      await snapshot(stranger.orgId, theirs, '2026-10-10', { '2026-10-09': fig(70, 70, 70, 70) });

      const one = await page(await link(o, { connectionIds: [q1, box] }));
      expect(one.performance).toEqual([
        {
          channel: 'Tiệm Bánh Quận 1',
          provider: 'google_business',
          days: 3,
          lastDay: '2026-10-31',
          totals: { calls: 10, directions: 3, websiteClicks: 5, views: 47 },
          previous: { days: 1, totals: { calls: 4, directions: 4, websiteClicks: 4, views: 40 } },
        },
      ]);
      expect(JSON.stringify(one)).not.toMatch(/Thủ Đức|Tiệm của họ|[0-9a-f]{8}-[0-9a-f]{4}-/);
      // Every channel of the org: both locations, never the sandbox's figures or another org's.
      const all = await page(await link(o));
      expect((all.performance as { channel: string; totals: Figures }[]).map((p) => [p.channel, p.totals.calls])).toEqual([
        ['Tiệm Bánh Quận 1', 10],
        ['Tiệm Bánh Thủ Đức', 9],
      ]);
      // Without the comparison, no period before; without the channels section, nothing.
      const noBefore = await page(await link(o, { connectionIds: [q1], sections: ['channels'] }));
      expect(noBefore.performance).toEqual([{ channel: 'Tiệm Bánh Quận 1', provider: 'google_business', days: 3, lastDay: '2026-10-31', totals: { calls: 10, directions: 3, websiteClicks: 5, views: 47 }, previous: null }]);
      expect((await page(await link(o, { sections: ['totals'] }))).performance).toBeNull();
      // Another org's link sees only its own channel.
      const theirsPage = await page(await link(stranger));
      expect((theirsPage.performance as { channel: string }[]).map((p) => p.channel)).toEqual(['Tiệm của họ']);
      expect(JSON.stringify(theirsPage)).not.toMatch(/Quận 1|Thủ Đức/);
    });

    it('shows a Google Business channel with no figures in the period as no entry', async () => {
      const o = await org();
      const q1 = await connect(o, 'google_business', 'accounts/6/locations/61', 'Tiệm Bánh Quận 1');
      await snapshot(o.orgId, q1, '2026-12-05', { '2026-12-04': fig(1, 1, 1, 1) });
      expect((await page(await link(o))).performance).toEqual([]);
    });
  });
});
