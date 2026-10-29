// Security properties of channel credentials (ADR-0025, Social plan S2, issue #232) on a real PostgreSQL 17:
// - tokens are stored only sealed, under a key the database never sees, bound to (org, provider, account);
// - no Crove role reads crove_kernel.credential directly; only the worker opens a credential, in the system context
//   of its org, and only while the member who connected the account is still in the org;
// - only owners and admins seal tokens in or drop them, also when calling the definers directly;
// - no token reaches an audit row, an event, an idempotency record or a query answer;
// - a disconnect leaves nothing to decrypt.
// Part of the invariant suite: CI runs this file from the base branch on protected-path PRs (AGENTS.md). Set
// CROVE_TEST_ADMIN_URL to a superuser URL; each run creates and drops its own database.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity, type ChannelConnectInput, type SealedChannelCredential } from '@crove/kernel';
import { CredentialVault, parseVaultKey, Runtime, type CredentialBinding } from '@crove/kernel-runtime';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';
import { contextToken } from './fixtures/context-token.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('channel credentials on PostgreSQL (ADR-0025)', () => {
  const dbName = `crove_test_channels_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appPool: pg.Pool;
  let workerPool: pg.Pool;
  let api: Runtime;
  let worker: Runtime;
  let appDb: Db;
  const vault = new CredentialVault([parseVaultKey(randomBytes(32).toString('base64'))]);
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const system = { type: 'system' as const, component: 'channel-test' };

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
    return upsertIdentity(appDb, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@channels.test`, name: null });
  }

  async function orgWith(roles: Array<'admin' | 'member' | 'viewer'>) {
    const owner = await person('owner');
    const { orgId } = await createOrg(api, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    const others: string[] = [];
    for (const role of roles) {
      const id = await person(role);
      await admin((c) => c.query('INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, $3)', [orgId, id, role]));
      others.push(id);
    }
    return { orgId, owner, others };
  }

  function connectInput(orgId: string, secret: string, account = `acct-${randomUUID().slice(0, 8)}`, binding?: Partial<CredentialBinding>): ChannelConnectInput {
    const sealed = vault.seal(secret, { orgId, provider: 'sandbox', externalAccountId: account, ...binding });
    return {
      provider: 'sandbox',
      externalAccountId: account,
      displayName: 'Trang thử nghiệm',
      scopes: ['publish'],
      expiresAt: null,
      credential: { keyId: sealed.keyId, envelope: sealed.envelope.toString('base64') },
    };
  }

  // Runs SQL as crove_app in a member's context, the way the runtime enters it, skipping the commands.
  async function asMemberSql<T extends pg.QueryResultRow>(userId: string, orgId: string, text: string, values: unknown[]): Promise<pg.QueryResult<T>> {
    const u = new URL(adminUrl);
    u.username = 'crove_app';
    u.password = 'test-app-pw';
    const client = new pg.Client({ connectionString: u.toString() });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [orgId, contextToken(userId, orgId)]);
      return await client.query<T>(text, values);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      await client.end();
    }
  }

  // Runs and commits SQL as crove_worker in the system context of an org, as a provider job would.
  async function asWorkerSql(orgId: string, text: string, values: unknown[]): Promise<void> {
    const u = new URL(adminUrl);
    u.username = 'crove_worker';
    u.password = 'test-worker-pw';
    const client = new pg.Client({ connectionString: u.toString() });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT crove_kernel.enter_system_context($1::uuid)', [orgId]);
      await client.query(text, values);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      await client.end();
    }
  }

  const connect = (orgId: string, userId: string, input: ChannelConnectInput) =>
    api.execute<{ connectionId: string; reconnected: boolean }>('kernel.channel.connect', input, { actor: asUser(userId), orgId });
  const sealedOf = (orgId: string, connectionId: string) => worker.query<SealedChannelCredential>('kernel.channel.credential', { connectionId }, { actor: system, orgId });
  const openFor = (orgId: string, s: SealedChannelCredential) =>
    vault.open({ keyId: s.keyId, envelope: Buffer.from(s.envelope, 'base64') }, { orgId, provider: s.provider, externalAccountId: s.externalAccountId });

  beforeAll(async () => {
    const base = new URL(ADMIN as string);
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    const url = (user: string, password: string) => {
      const u = new URL(adminUrl);
      u.username = user;
      u.password = password;
      return u.toString();
    };
    appPool = createPool({ connectionString: url('crove_app', 'test-app-pw'), max: 4 });
    workerPool = createPool({ connectionString: url('crove_worker', 'test-worker-pw'), max: 4 });
    appDb = createDb(appPool);
    const defs = { commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) };
    api = new Runtime(appDb, { manifests: TEST_MANIFESTS }).register(defs);
    worker = new Runtime(createDb(workerPool), { manifests: TEST_MANIFESTS }).register(defs);
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

  it('stores only the sealed envelope, which the worker opens for the bound org and account', async () => {
    const { orgId, owner } = await orgWith([]);
    const secret = `tok_${randomBytes(24).toString('hex')}`;
    const { connectionId } = await connect(orgId, owner, connectInput(orgId, secret));
    const stored = await admin((c) => c.query<{ envelope: Buffer }>('SELECT envelope FROM crove_kernel.credential WHERE connection_id = $1', [connectionId]));
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]?.envelope.includes(Buffer.from(secret))).toBe(false);
    expect(openFor(orgId, await sealedOf(orgId, connectionId))).toBe(secret);
  });

  it('gives no Crove role direct access to the credential table', async () => {
    const { rows } = await admin((c) =>
      c.query<{ role: string; op: string }>(
        `SELECT r AS role, p AS op FROM unnest(ARRAY['crove_app', 'crove_worker', 'crove_tenant', 'crove_definer_tenant']) r,
                unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) p
         WHERE has_table_privilege(r, 'crove_kernel.credential', p)`,
      ),
    );
    expect(rows).toEqual([]);
  });

  it('lets only the worker read a credential out (EXECUTE matrix)', async () => {
    const { rows } = await admin((c) =>
      c.query<{ fn: string; role: string; can: boolean }>(
        `SELECT f AS fn, r AS role, has_function_privilege(r, f, 'EXECUTE') AS can
         FROM unnest(ARRAY['crove_kernel.credential_get(uuid)', 'crove_kernel.credential_put(uuid, text, bytea)', 'crove_kernel.credential_drop(uuid)']) f,
              unnest(ARRAY['crove_app', 'crove_worker', 'crove_tenant', 'crove_definer_tenant']) r
         ORDER BY 1, 2`,
      ),
    );
    const allowed = rows.filter((r) => r.can).map((r) => `${r.fn} ${r.role}`);
    expect(allowed).toEqual([
      'crove_kernel.credential_drop(uuid) crove_app',
      'crove_kernel.credential_drop(uuid) crove_worker',
      'crove_kernel.credential_get(uuid) crove_worker',
      'crove_kernel.credential_put(uuid, text, bytea) crove_app',
      'crove_kernel.credential_put(uuid, text, bytea) crove_worker',
    ]);
  });

  it('refuses the API runtime and a user context when they ask for a credential', async () => {
    const { orgId, owner } = await orgWith([]);
    const { connectionId } = await connect(orgId, owner, connectInput(orgId, 'secret-a'));
    // The query is system-only, and the API's login role may neither enter system context nor run credential_get.
    await expect(api.query('kernel.channel.credential', { connectionId }, { actor: asUser(owner), orgId })).rejects.toMatchObject({ status: 403 });
    await expect(api.query('kernel.channel.credential', { connectionId }, { actor: system, orgId })).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    await expect(
      admin(async (c) => (await c.query<{ can: boolean }>("SELECT has_function_privilege('crove_app', 'crove_kernel.enter_system_context(uuid)', 'EXECUTE') AS can")).rows[0]?.can),
    ).resolves.toBe(false);
    // A worker connection in a user context (not system) is refused by the definer itself.
    await expect(worker.query('kernel.channel.credential', { connectionId }, { actor: asUser(owner), orgId })).rejects.toMatchObject({ status: 403 });
  });

  it('never hands one org another org’s credential', async () => {
    const a = await orgWith([]);
    const b = await orgWith([]);
    const { connectionId } = await connect(a.orgId, a.owner, connectInput(a.orgId, 'secret-of-a'));
    await expect(sealedOf(b.orgId, connectionId)).rejects.toMatchObject({ code: 'CHANNEL_NOT_FOUND' });
  });

  it('refuses an envelope sealed for another org or account, even when stored', async () => {
    const a = await orgWith([]);
    const b = await orgWith([]);
    const account = `acct-${randomUUID().slice(0, 8)}`;
    // Sealed for org B, stored by org A for the same account: it stores, but never opens for org A.
    const { connectionId } = await connect(a.orgId, a.owner, connectInput(a.orgId, 'replayed', account, { orgId: b.orgId }));
    const sealed = await sealedOf(a.orgId, connectionId);
    expect(() => openFor(a.orgId, sealed)).toThrow(/does not open/);
    // A correctly bound envelope opens only for its own account.
    const own = await connect(a.orgId, a.owner, connectInput(a.orgId, 'bound', account));
    expect(own.connectionId).toBe(connectionId);
    const rebound = await sealedOf(a.orgId, connectionId);
    expect(openFor(a.orgId, rebound)).toBe('bound');
    expect(() => openFor(a.orgId, { ...rebound, externalAccountId: 'other-account' })).toThrow(/does not open/);
    expect(() => openFor(b.orgId, rebound)).toThrow(/does not open/);
  });

  it('lets only owners and admins connect and disconnect, through the commands and the definers', async () => {
    const { orgId, owner, others } = await orgWith(['admin', 'member', 'viewer']);
    const [adminUser, member, viewer] = others as [string, string, string];
    await expect(connect(orgId, adminUser, connectInput(orgId, 'by-admin'))).resolves.toMatchObject({ reconnected: false });
    for (const who of [member, viewer]) {
      await expect(connect(orgId, who, connectInput(orgId, 'by-member'))).rejects.toMatchObject({ status: 403 });
    }
    const { connectionId } = await connect(orgId, owner, connectInput(orgId, 'by-owner'));
    await expect(api.execute('kernel.channel.disconnect', { connectionId }, { actor: asUser(member), orgId })).rejects.toMatchObject({ status: 403 });
    // A member or viewer who skips the commands and calls the definers in their own context is refused by the database.
    for (const who of [member, viewer]) {
      await expect(asMemberSql(who, orgId, 'SELECT crove_kernel.credential_put($1::uuid, $2, $3::bytea)', [connectionId, 'k', Buffer.from([1])])).rejects.toThrow(
        'CREDENTIAL_FORBIDDEN',
      );
      await expect(asMemberSql(who, orgId, 'SELECT crove_kernel.credential_drop($1::uuid)', [connectionId])).rejects.toThrow('CREDENTIAL_FORBIDDEN');
    }
    // An owner in their own context may (rolled back here), so the refusal above is about the role.
    await expect(asMemberSql(owner, orgId, 'SELECT crove_kernel.credential_drop($1::uuid)', [connectionId])).resolves.toBeDefined();
    // Not even the owner reads a credential out through the API's login role.
    await expect(asMemberSql(owner, orgId, 'SELECT * FROM crove_kernel.credential_get($1::uuid)', [connectionId])).rejects.toThrow(/permission denied/);
    // credential_put refuses a connection of another org: org A's owner cannot seal into org B's connection.
    const other = await orgWith([]);
    const foreign = await connect(other.orgId, other.owner, connectInput(other.orgId, 'b-token'));
    await expect(asMemberSql(owner, orgId, 'SELECT crove_kernel.credential_put($1::uuid, $2, $3::bytea)', [foreign.connectionId, 'k', Buffer.from([1])])).rejects.toThrow(
      'CHANNEL_NOT_FOUND',
    );
  });

  it('reconnecting an account keeps its connection and replaces its token', async () => {
    const { orgId, owner } = await orgWith([]);
    const account = `acct-${randomUUID().slice(0, 8)}`;
    const first = await connect(orgId, owner, connectInput(orgId, 'old-token', account));
    const again = await connect(orgId, owner, connectInput(orgId, 'new-token', account));
    expect(again).toEqual({ connectionId: first.connectionId, reconnected: true });
    expect(openFor(orgId, await sealedOf(orgId, first.connectionId))).toBe('new-token');
  });

  it('stops handing out a credential once the member who connected it leaves, is demoted or is disabled', async () => {
    const { orgId, others } = await orgWith(['admin', 'admin', 'admin']);
    const [leaves, demoted, disabled] = others as [string, string, string];
    const conns: Record<string, string> = {};
    for (const who of [leaves, demoted, disabled]) conns[who] = (await connect(orgId, who, connectInput(orgId, `token-${who}`))).connectionId;
    for (const who of [leaves, demoted, disabled]) expect(openFor(orgId, await sealedOf(orgId, conns[who] as string))).toBe(`token-${who}`);
    await admin(async (c) => {
      await c.query('DELETE FROM crove_kernel.tenant_member WHERE org_id = $1 AND user_id = $2', [orgId, leaves]);
      await c.query("UPDATE crove_kernel.tenant_member SET role = 'member' WHERE org_id = $1 AND user_id = $2", [orgId, demoted]);
      await c.query('UPDATE crove_kernel.user_account SET disabled_at = now() WHERE id = $1', [disabled]);
    });
    for (const who of [leaves, demoted, disabled]) {
      await expect(sealedOf(orgId, conns[who] as string)).rejects.toMatchObject({ code: 'CHANNEL_OWNER_LEFT' });
    }
  });

  it('lets the worker reseal a token (the refresh path), never into a revoked connection', async () => {
    const { orgId, owner } = await orgWith([]);
    const account = `acct-${randomUUID().slice(0, 8)}`;
    const { connectionId } = await connect(orgId, owner, connectInput(orgId, 'before-refresh', account));
    const refreshed = vault.seal('after-refresh', { orgId, provider: 'sandbox', externalAccountId: account });
    await asWorkerSql(orgId, 'SELECT crove_kernel.credential_put($1::uuid, $2, $3::bytea)', [connectionId, refreshed.keyId, refreshed.envelope]);
    expect(openFor(orgId, await sealedOf(orgId, connectionId))).toBe('after-refresh');
    await api.execute('kernel.channel.disconnect', { connectionId }, { actor: asUser(owner), orgId });
    await expect(asMemberSql(owner, orgId, 'SELECT crove_kernel.credential_put($1::uuid, $2, $3::bytea)', [connectionId, 'k', Buffer.from([1])])).rejects.toThrow(
      'CHANNEL_NOT_FOUND',
    );
  });

  it('refuses to disconnect another org’s connection', async () => {
    const a = await orgWith([]);
    const b = await orgWith([]);
    const { connectionId } = await connect(a.orgId, a.owner, connectInput(a.orgId, 'a-token'));
    await expect(api.execute('kernel.channel.disconnect', { connectionId }, { actor: asUser(b.owner), orgId: b.orgId })).rejects.toMatchObject({
      code: 'CHANNEL_NOT_FOUND',
    });
    expect(openFor(a.orgId, await sealedOf(a.orgId, connectionId))).toBe('a-token');
  });

  it('turns two connects of one new account at once into a connect and a reconnect', async () => {
    const { orgId, owner } = await orgWith([]);
    const account = `acct-${randomUUID().slice(0, 8)}`;
    const results = await Promise.all([connect(orgId, owner, connectInput(orgId, 'one', account)), connect(orgId, owner, connectInput(orgId, 'two', account))]);
    expect(new Set(results.map((r) => r.connectionId)).size).toBe(1);
    expect(results.map((r) => r.reconnected).sort()).toEqual([false, true]);
  });

  it('forgets the token on disconnect and keeps the connection as history', async () => {
    const { orgId, owner } = await orgWith([]);
    const { connectionId } = await connect(orgId, owner, connectInput(orgId, 'to-forget'));
    await api.execute('kernel.channel.disconnect', { connectionId }, { actor: asUser(owner), orgId });
    const left = await admin((c) => c.query('SELECT 1 FROM crove_kernel.credential WHERE connection_id = $1', [connectionId]));
    expect(left.rowCount).toBe(0);
    await expect(sealedOf(orgId, connectionId)).rejects.toMatchObject({ code: 'CHANNEL_NOT_ACTIVE' });
    const listed = await api.query<Array<{ id: string; status: string }>>('kernel.channel.list', { includeRevoked: true }, { actor: asUser(owner), orgId });
    expect(listed.find((c) => c.id === connectionId)?.status).toBe('revoked');
    // Reconnecting the same account after a disconnect makes a new connection; the revoked one stays history.
    const account = listed.find((c) => c.id === connectionId) as unknown as { externalAccountId: string };
    const fresh = await connect(orgId, owner, connectInput(orgId, 'fresh', account.externalAccountId));
    expect(fresh.connectionId).not.toBe(connectionId);
  });

  it('puts no token in audit rows, events, idempotency records or answers', async () => {
    const { orgId, owner } = await orgWith([]);
    const secret = `leak_${randomBytes(24).toString('hex')}`;
    const { connectionId } = await connect(orgId, owner, connectInput(orgId, secret));
    await api.execute('kernel.channel.disconnect', { connectionId }, { actor: asUser(owner), orgId, idempotencyKey: randomUUID() });
    const listed = await api.query('kernel.channel.list', { includeRevoked: true }, { actor: asUser(owner), orgId });
    expect(JSON.stringify(listed)).not.toContain(secret);
    const dump = await admin(async (c) => {
      const parts: string[] = [];
      for (const q of [
        'SELECT detail::text AS t FROM crove_kernel.audit_event WHERE org_id = $1',
        'SELECT payload::text AS t FROM crove_kernel.outbox_event WHERE org_id = $1',
        'SELECT coalesce(response::text, \'\') AS t FROM crove_kernel.idempotency_key WHERE org_id = $1',
        'SELECT row_to_json(c)::text AS t FROM crove_kernel.channel_connection c WHERE org_id = $1',
      ]) {
        const { rows } = await c.query<{ t: string }>(q, [orgId]);
        parts.push(...rows.map((r) => r.t));
      }
      return parts.join('\n');
    });
    expect(dump.length).toBeGreaterThan(0);
    expect(dump).not.toContain(secret);
  });
});
