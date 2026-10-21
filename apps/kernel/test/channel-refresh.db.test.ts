// Token refresh on PostgreSQL 17 (Social plan S6.4, issue #374): connections whose access token expires soon are
// renewed and their new tokens sealed in one transaction; a refused refresh marks the connection expired; one sweep
// runs at a time; only the worker scans across orgs. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its
// own database.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Refresher } from '@crove/channel';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity, type SealedChannelCredential } from '@crove/kernel';
import { CredentialVault, Runtime, parseVaultKey } from '@crove/kernel-runtime';
import { refreshChannels } from '../src/channel-refresh.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const HOUR = 3_600_000;

suite('channel token refresh on PostgreSQL (S6.4)', () => {
  const dbName = `crove_test_channel_refresh_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appPool: pg.Pool;
  let workerPool: pg.Pool;
  let appDb: Db;
  let workerDb: Db;
  let api: Runtime;
  let worker: Runtime;
  const vault = new CredentialVault([parseVaultKey(randomBytes(32).toString('base64'))]);
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const system = { type: 'system' as const, component: 'refresh-test' };

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
    const owner = await upsertIdentity(appDb, { issuer: 'test', subject: randomUUID(), email: `owner-${randomUUID().slice(0, 8)}@refresh.test`, name: null });
    const { orgId } = await createOrg(api, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    return { orgId, owner };
  }

  async function connect(o: { orgId: string; owner: string }, expiresInMs: number, secret = JSON.stringify({ accessToken: 'a-1', refreshToken: 'r-1' }), provider = 'zalo_oa') {
    const account = String(Math.floor(Math.random() * 1e15));
    const sealed = vault.seal(secret, { orgId: o.orgId, provider, externalAccountId: account });
    const { connectionId } = await api.execute<{ connectionId: string }>(
      'kernel.channel.connect',
      {
        provider,
        externalAccountId: account,
        displayName: 'Zalo OA',
        scopes: ['oa'],
        expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
        credential: { keyId: sealed.keyId, envelope: sealed.envelope.toString('base64') },
      },
      { actor: asUser(o.owner), orgId: o.orgId },
    );
    return connectionId;
  }

  const secretOf = async (orgId: string, connectionId: string) => {
    const s = await worker.query<SealedChannelCredential>('kernel.channel.credential', { connectionId }, { actor: system, orgId });
    return vault.open({ keyId: s.keyId, envelope: Buffer.from(s.envelope, 'base64') }, { orgId, provider: s.provider, externalAccountId: s.externalAccountId });
  };
  const row = (connectionId: string) =>
    admin(async (c) => (await c.query<{ status: string; expires_at: Date }>('SELECT status, expires_at FROM crove_kernel.channel_connection WHERE id = $1', [connectionId])).rows[0]);

  // Hands out a new pair per refresh and remembers what it was given.
  function fakeRefresher(answer: 'ok' | 'refused' | 'failed' = 'ok'): Refresher & { seen: string[] } {
    const seen: string[] = [];
    return {
      provider: 'zalo_oa',
      seen,
      refresh: async (secret) => {
        seen.push(secret);
        if (answer === 'refused') return { refused: '-14020' };
        if (answer === 'failed') return { failed: '503' };
        const n = seen.length + 1;
        return { secret: JSON.stringify({ accessToken: `a-${n}`, refreshToken: `r-${n}` }), expiresAt: new Date(Date.now() + 25 * HOUR) };
      },
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
    const defs = { commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) };
    api = new Runtime(appDb).register(defs);
    worker = new Runtime(workerDb).register(defs);
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

  it('connects an account of a provider with a one-character id, and starts its OAuth attempt (#784)', async () => {
    const o = await org();
    const id = await connect(o, 30 * 24 * HOUR, JSON.stringify({ accessToken: 'x-1', refreshToken: 'r-1' }), 'x');
    expect((await row(id))?.status).toBe('active');
    const begun = await api.execute<{ attemptId: string }>(
      'kernel.channel.oauth_begin',
      { provider: 'x', stateHash: `sha256:${'a'.repeat(64)}`, codeVerifier: 'v'.repeat(43) },
      { actor: asUser(o.owner), orgId: o.orgId },
    );
    expect(begun.attemptId).toMatch(/^[0-9a-f-]{36}$/);
    // Still refused: an id that starts with a digit, or is longer than 32.
    await expect(connect(o, HOUR, '{}', '9x')).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(connect(o, HOUR, '{}', 'x'.repeat(33))).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('renews only connections expiring soon, sealing the new pair and moving the expiry', async () => {
    const o = await org();
    const soon = await connect(o, HOUR);
    const later = await connect(o, 3 * 24 * HOUR);
    const refresher = fakeRefresher();
    const outcome = await refreshChannels({ runtime: worker, broker: vault, workerDb, refreshers: { zalo_oa: refresher } });
    expect(outcome).toMatchObject({ refreshed: 1, expired: 0, skipped: false });
    expect(refresher.seen).toEqual([JSON.stringify({ accessToken: 'a-1', refreshToken: 'r-1' })]);
    expect(await secretOf(o.orgId, soon)).toBe(JSON.stringify({ accessToken: 'a-2', refreshToken: 'r-2' }));
    expect((await row(soon))?.expires_at.getTime()).toBeGreaterThan(Date.now() + 24 * HOUR);
    expect(await secretOf(o.orgId, later)).toBe(JSON.stringify({ accessToken: 'a-1', refreshToken: 'r-1' }));
    // Renewed, it is no longer due: the next sweep leaves it alone.
    expect((await refreshChannels({ runtime: worker, broker: vault, workerDb, refreshers: { zalo_oa: refresher } })).refreshed).toBe(0);
    // No token in audit rows or events.
    const dump = await admin(async (c) => {
      const a = await c.query<{ t: string }>("SELECT coalesce(string_agg(detail::text, ' '), '') AS t FROM crove_kernel.audit_event WHERE org_id = $1", [o.orgId]);
      const e = await c.query<{ t: string }>("SELECT coalesce(string_agg(payload::text, ' '), '') AS t FROM crove_kernel.outbox_event WHERE org_id = $1", [o.orgId]);
      return `${a.rows[0]?.t} ${e.rows[0]?.t}`;
    });
    for (const token of ['a-2', 'r-2', 'r-1']) expect(dump).not.toContain(`"${token}"`);
  });

  it('marks a connection expired when the provider refuses the refresh, and keeps a failed one for the next sweep', async () => {
    const o = await org();
    const refused = await connect(o, HOUR);
    expect((await refreshChannels({ runtime: worker, broker: vault, workerDb, refreshers: { zalo_oa: fakeRefresher('refused') } })).expired).toBeGreaterThanOrEqual(1);
    expect((await row(refused))?.status).toBe('expired');
    const flaky = await connect(o, HOUR);
    expect((await refreshChannels({ runtime: worker, broker: vault, workerDb, refreshers: { zalo_oa: fakeRefresher('failed') } })).failed).toBeGreaterThanOrEqual(1);
    expect((await row(flaky))?.status).toBe('active');
  });

  it('drops tokens for a connection that changed during the refresh', async () => {
    const o = await org();
    const id = await connect(o, HOUR);
    const slow: Refresher = {
      provider: 'zalo_oa',
      refresh: async () => {
        // A reconnect lands while the provider answers.
        await admin((c) => c.query("UPDATE crove_kernel.channel_connection SET updated_at = now() + interval '1 second' WHERE id = $1", [id]));
        return { secret: JSON.stringify({ accessToken: 'late', refreshToken: 'late' }), expiresAt: new Date(Date.now() + 25 * HOUR) };
      },
    };
    await refreshChannels({ runtime: worker, broker: vault, workerDb, refreshers: { zalo_oa: slow } });
    expect(await secretOf(o.orgId, id)).toBe(JSON.stringify({ accessToken: 'a-1', refreshToken: 'r-1' }));
  });

  it('runs one sweep at a time, and only the worker scans across orgs', async () => {
    const o = await org();
    await connect(o, HOUR);
    const holder = new pg.Client({ connectionString: adminUrl });
    await holder.connect();
    try {
      await holder.query("SELECT pg_advisory_lock(hashtextextended('crove.channel-refresh', 0))");
      expect(await refreshChannels({ runtime: worker, broker: vault, workerDb, refreshers: { zalo_oa: fakeRefresher() } })).toMatchObject({ skipped: true, refreshed: 0 });
    } finally {
      await holder.end();
    }
    const { rows } = await admin((c) =>
      c.query<{ role: string }>(
        `SELECT r AS role FROM unnest(ARRAY['crove_app', 'crove_worker', 'crove_tenant', 'crove_definer_tenant']) r
         WHERE has_function_privilege(r, 'crove_kernel.channel_refresh_due(int, text[], int)', 'EXECUTE') ORDER BY 1`,
      ),
    );
    expect(rows.map((r) => r.role)).toEqual(['crove_worker']);
    // The API runtime cannot store a refresh: the command is the system's.
    await expect(api.execute('kernel.channel.refresh', { connectionId: randomUUID(), ifVersion: new Date().toISOString(), expiresAt: null, credential: { keyId: 'k', envelope: 'AA==' } }, { actor: asUser(o.owner), orgId: o.orgId })).rejects.toMatchObject({ status: 403 });
  });

  it('renews each provider within its own window', async () => {
    const o = await org();
    const zalo = await connect(o, 3 * 24 * HOUR);
    const threads = await connect(o, 3 * 24 * HOUR, JSON.stringify({ accessToken: 't-1' }), 'threads');
    const seen: string[] = [];
    const longLived: Refresher = {
      provider: 'threads',
      horizonSeconds: 7 * 24 * 3600,
      refresh: async (secret) => {
        seen.push(secret);
        return { secret: JSON.stringify({ accessToken: 't-2' }), expiresAt: new Date(Date.now() + 60 * 24 * HOUR) };
      },
    };
    await refreshChannels({ runtime: worker, broker: vault, workerDb, refreshers: { zalo_oa: fakeRefresher(), threads: longLived } });
    expect(seen).toEqual([JSON.stringify({ accessToken: 't-1' })]);
    expect(await secretOf(o.orgId, threads)).toBe(JSON.stringify({ accessToken: 't-2' }));
    // Three days out is outside Zalo's 6-hour window: untouched.
    expect(await secretOf(o.orgId, zalo)).toBe(JSON.stringify({ accessToken: 'a-1', refreshToken: 'r-1' }));
  });
});