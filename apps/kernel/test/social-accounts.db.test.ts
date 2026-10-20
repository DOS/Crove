// Account growth of Social channels on PostgreSQL 17 (#645): the worker's daily sweep through the adapters'
// accountMetrics, one snapshot per channel and day (a try without an answer kept too), and the trends the Metrics tab
// reads. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
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

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

// A platform that answers each account's followers from a table, refuses or stays silent where told.
class FakeAccounts implements Publisher {
  readonly provider = 'sandbox' as const;
  readonly publishSafety = 'reconcile_only' as const;
  asked: AccountMetricsInput[] = [];
  answers = new Map<string, AccountMetricsResult>();
  throwing = new Set<string>();
  async publish(): Promise<PublishResult> {
    return { kind: 'rejected', error: 'bad_request', code: 'NOT_IN_THIS_TEST' };
  }
  async accountMetrics(input: AccountMetricsInput): Promise<AccountMetricsResult> {
    this.asked.push(input);
    if (this.throwing.has(input.externalAccountId)) throw new Error('socket hang up');
    return this.answers.has(input.externalAccountId) ? (this.answers.get(input.externalAccountId) as AccountMetricsResult) : null;
  }
}

suite('social account growth on PostgreSQL (#645)', () => {
  const dbName = `crove_test_social_accounts_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appPool: pg.Pool;
  let workerPool: pg.Pool;
  let appDb: Db;
  let workerDb: Db;
  let api: Runtime;
  let worker: Runtime;
  const vault = new CredentialVault([parseVaultKey(randomBytes(32).toString('base64'))]);
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

  async function org() {
    const owner = await upsertIdentity(appDb, { issuer: 'test', subject: randomUUID(), email: `owner-${randomUUID().slice(0, 8)}@accounts.test`, name: null });
    const { orgId } = await createOrg(api, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    return { orgId, owner };
  }

  async function connect(o: { orgId: string; owner: string }, account: string) {
    const sealed = vault.seal(JSON.stringify({ accessToken: 'sbx_test' }), { orgId: o.orgId, provider: 'sandbox', externalAccountId: account });
    const { connectionId } = await api.execute<{ connectionId: string }>(
      'kernel.channel.connect',
      { provider: 'sandbox', externalAccountId: account, displayName: account, scopes: ['publish'], expiresAt: null, credential: { keyId: sealed.keyId, envelope: sealed.envelope.toString('base64') } },
      { actor: asUser(o.owner), orgId: o.orgId },
    );
    return connectionId;
  }

  const trends = (o: { orgId: string; owner: string }, days: number) => api.query<AccountTrend[]>('social.account.trends', { days }, { actor: asUser(o.owner), orgId: o.orgId });
  const sweep = (platform: FakeAccounts) => sweepAccounts({ runtime: worker, broker: vault, workerDb, publishers: { sandbox: platform } });

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

  it('takes one snapshot per channel and day, keeps a try with no answer, and reads trends oldest first', async () => {
    const o = await org();
    const a = await connect(o, 'acct-a');
    const b = await connect(o, 'acct-b');
    const c = await connect(o, 'acct-c');
    const platform = new FakeAccounts();
    platform.answers.set('acct-a', { followers: 1200, reach: 80 });
    platform.answers.set('acct-b', { refused: 'token_expired' });
    // acct-c: no answer.
    const first = await sweep(platform);
    expect(first).toEqual({ recorded: 1, skipped: 2 });
    expect(platform.asked.map((x) => x.externalAccountId).sort()).toEqual(['acct-a', 'acct-b', 'acct-c']);
    // The secret reached the adapter opened, never sealed.
    expect(platform.asked.every((x) => x.secret === JSON.stringify({ accessToken: 'sbx_test' }))).toBe(true);
    const rows = await admin(async (cl) => (await cl.query<{ channel_connection_id: string; followers: string | null; reach: string | null; error: string | null }>('SELECT channel_connection_id, followers, reach, error FROM crove_social.account_snapshot WHERE org_id = $1 ORDER BY followers NULLS LAST, error', [o.orgId])).rows);
    expect(rows).toEqual([
      { channel_connection_id: a, followers: '1200', reach: '80', error: null },
      { channel_connection_id: c, followers: null, reach: null, error: 'no_answer' },
      { channel_connection_id: b, followers: null, reach: null, error: 'token_expired' },
    ]);
    // The same day, nothing is due again for this org.
    platform.asked = [];
    await sweep(platform);
    expect(platform.asked.filter((x) => ['acct-a', 'acct-b', 'acct-c'].includes(x.externalAccountId))).toEqual([]);

    // Earlier days, as the worker would have kept them.
    const day = (ago: number) => utcDay(new Date(Date.now() - ago * 86_400_000));
    await admin((cl) =>
      cl.query('INSERT INTO crove_social.account_snapshot (org_id, channel_connection_id, captured_on, followers) VALUES ($1, $2, $3, 1100), ($1, $2, $4, 1150), ($1, $2, $5, 900)', [o.orgId, a, day(5), day(2), day(40)]),
    );
    const week = await trends(o, 7);
    expect(week).toEqual([{ connectionId: a, provider: 'sandbox', points: [{ day: day(5), followers: 1100, reach: null }, { day: day(2), followers: 1150, reach: null }, { day: day(0), followers: 1200, reach: 80 }] }]);
    expect((await trends(o, 90))[0]?.points[0]).toEqual({ day: day(40), followers: 900, reach: null });
    expect((await trends(o, 1))[0]?.points).toEqual([{ day: day(0), followers: 1200, reach: 80 }]);
  });

  it('asks only active channels of active orgs, keeps snapshots to their org, and lets only the system record them', async () => {
    const o = await org();
    const stranger = await org();
    const live = await connect(o, 'acct-live');
    const gone = await connect(o, 'acct-gone');
    await admin((cl) => cl.query("UPDATE crove_kernel.channel_connection SET status = 'expired' WHERE id = $1", [gone]));
    const platform = new FakeAccounts();
    platform.answers.set('acct-live', { followers: 10 });
    platform.answers.set('acct-gone', { followers: 99 });
    // An adapter that throws: the try is still kept for today, so the channel does not come back first on every pass.
    const boom = await connect(o, 'acct-boom');
    platform.throwing.add('acct-boom');
    await sweep(platform);
    const kept = await admin(async (cl) => (await cl.query<{ error: string | null }>('SELECT error FROM crove_social.account_snapshot WHERE channel_connection_id = $1', [boom])).rows);
    expect(kept).toEqual([{ error: 'no_answer' }]);
    expect(platform.asked.map((x) => x.externalAccountId)).toContain('acct-live');
    expect(platform.asked.map((x) => x.externalAccountId)).not.toContain('acct-gone');
    expect(await trends(stranger, 30)).toEqual([]);
    expect((await trends(o, 30)).map((t) => t.connectionId)).toEqual([live]);
    await expect(api.execute('social.account.record', { connectionId: live, capturedOn: '2026-01-01', followers: 1 }, { actor: asUser(o.owner), orgId: o.orgId })).rejects.toMatchObject({ status: 403 });
    // Another org's channel is not this org's to record.
    await expect(worker.execute('social.account.record', { connectionId: live, capturedOn: '2026-01-01', followers: 1 }, { actor: { type: 'system', component: 'test' }, orgId: stranger.orgId })).rejects.toMatchObject({ code: 'CHANNEL_NOT_FOUND' });
    // Append-only for tenant roles.
    const grants = await admin(async (cl) =>
      (await cl.query<{ privilege_type: string }>("SELECT privilege_type FROM information_schema.role_table_grants WHERE grantee = 'crove_tenant' AND table_schema = 'crove_social' AND table_name = 'account_snapshot' ORDER BY 1")).rows.map((r) => r.privilege_type),
    );
    expect(grants).toEqual(['INSERT', 'SELECT']);
    // The scan is the worker's alone.
    await expect(appPool.query("SELECT * FROM crove_social.account_snapshots_due(10, ARRAY['sandbox'])")).rejects.toMatchObject({ code: '42501' });
  });
});
