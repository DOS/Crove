// SPDX-License-Identifier: AGPL-3.0-only
// Security properties of outside calendar connections (#2123, part of #1374) on a real PostgreSQL 17:
// - tokens are stored only sealed, under a key the database never sees, bound to (org, provider, account);
// - no Crove role reads crove_kernel.calendar_credential directly; only the worker opens a credential, in the system
//   context of its org, and only while the member who owns the connection is still in the org and not disabled;
// - the API login cannot open a credential, whatever actor its runtime claims to be;
// - only the member who owns a connection seals into it or drops its credential, also when calling the definers
//   directly, and never across orgs;
// - a connect attempt is single use, bound to the member, the org and a calendar provider, and refused to a viewer;
// - no token reaches an audit row, an event or a query answer.
// Part of the invariant suite: CI runs this file from the base branch on protected-path PRs (AGENTS.md). Set
// CROVE_TEST_ADMIN_URL to a superuser URL; each run creates and drops its own database.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity, type SealedCalendarCredential } from '@crove/kernel';
import { CredentialVault, parseVaultKey, Runtime } from '@crove/kernel-runtime';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';
import { contextToken } from './fixtures/context-token.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const SECRET = JSON.stringify({ accessToken: 'ya29.calendar-access-secret', refreshToken: '1//calendar-refresh-secret' });

suite('calendar credentials on PostgreSQL (#2123)', () => {
  const dbName = `crove_test_calendar_cred_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appPool: pg.Pool;
  let workerPool: pg.Pool;
  let api: Runtime;
  let worker: Runtime;
  let appDb: Db;
  const vault = new CredentialVault([parseVaultKey(randomBytes(32).toString('base64'))]);
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const system = { type: 'system' as const, component: 'calendar-cred-test' };
  const urlFor = (user: string, password: string) => {
    const u = new URL(adminUrl);
    u.username = user;
    u.password = password;
    return u.toString();
  };

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  const person = (name: string) => upsertIdentity(appDb, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@calcred.test`, name: null });

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

  async function connect(orgId: string, userId: string, secret = SECRET, account = `acct-${randomUUID().slice(0, 8)}@gmail.test`) {
    const sealed = vault.seal(secret, { orgId, provider: 'calendar:google', externalAccountId: account });
    const done = await api.execute<{ connectionId: string }>(
      'kernel.calendar.connect',
      {
        provider: 'google',
        externalAccount: account,
        displayName: account,
        scopes: ['https://www.googleapis.com/auth/calendar.freebusy'],
        expiresAt: null,
        credential: { keyId: sealed.keyId, envelope: sealed.envelope.toString('base64') },
      },
      { actor: asUser(userId), orgId },
    );
    return { connectionId: done.connectionId, account };
  }

  // Runs SQL as crove_app in a member's context, the way the runtime enters it, skipping the commands.
  async function asMemberSql<T extends pg.QueryResultRow>(userId: string, orgId: string, text: string, values: unknown[]): Promise<pg.QueryResult<T>> {
    const client = new pg.Client({ connectionString: urlFor('crove_app', 'test-app-pw') });
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

  // Runs SQL as crove_worker in the system context of an org, as a sync would.
  async function asWorkerSql<T extends pg.QueryResultRow>(orgId: string, text: string, values: unknown[]): Promise<pg.QueryResult<T>> {
    const client = new pg.Client({ connectionString: urlFor('crove_worker', 'test-worker-pw') });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT crove_kernel.enter_system_context($1::uuid)', [orgId]);
      return await client.query<T>(text, values);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      await client.end();
    }
  }

  const sealedOf = (orgId: string, connectionId: string) => worker.query<SealedCalendarCredential>('kernel.calendar.credential', { connectionId }, { actor: system, orgId });

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
    appPool = createPool({ connectionString: urlFor('crove_app', 'test-app-pw'), max: 4 });
    workerPool = createPool({ connectionString: urlFor('crove_worker', 'test-worker-pw'), max: 4 });
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

  it('stores only the sealed envelope, bound to org, provider and account, and no token anywhere else', async () => {
    const { orgId, others } = await orgWith(['member']);
    const c = await connect(orgId, others[0] as string);
    const row = await admin((cl) => cl.query<{ envelope: Buffer }>('SELECT envelope FROM crove_kernel.calendar_credential WHERE org_id = $1 AND id = $2', [orgId, c.connectionId]));
    const stored = row.rows[0]?.envelope.toString('utf8') ?? '';
    expect(stored).not.toContain('calendar-access-secret');
    expect(stored).not.toContain('calendar-refresh-secret');
    const sealed = await sealedOf(orgId, c.connectionId);
    const open = (binding: { orgId: string; provider: string; externalAccountId: string }) => vault.open({ keyId: sealed.keyId, envelope: Buffer.from(sealed.envelope, 'base64') }, binding);
    expect(open({ orgId, provider: 'calendar:google', externalAccountId: c.account })).toBe(SECRET);
    expect(() => open({ orgId: randomUUID(), provider: 'calendar:google', externalAccountId: c.account })).toThrow();
    expect(() => open({ orgId, provider: 'calendar:microsoft', externalAccountId: c.account })).toThrow();
    expect(() => open({ orgId, provider: 'calendar:google', externalAccountId: 'other@gmail.test' })).toThrow();
    // Not in the audit trail, the outbox or the connection row either.
    const audit = await admin((cl) => cl.query<{ text: string }>('SELECT detail::text AS text FROM crove_kernel.audit_event WHERE org_id = $1', [orgId]));
    const events = await admin((cl) => cl.query<{ text: string }>('SELECT payload::text AS text FROM crove_kernel.outbox_event WHERE org_id = $1', [orgId]));
    const connection = await admin((cl) => cl.query<{ text: string }>('SELECT row_to_json(c)::text AS text FROM crove_kernel.calendar_connection c WHERE org_id = $1', [orgId]));
    for (const found of [...audit.rows, ...events.rows, ...connection.rows]) expect(found.text).not.toMatch(/calendar-access-secret|calendar-refresh-secret|envelope/);
  });

  it('lets no Crove login role touch the credential table, and only the right logins execute each definer', async () => {
    const roles = ['crove_app', 'crove_worker', 'crove_tenant', 'crove_definer_tenant'];
    const grants = await admin((cl) =>
      cl.query<{ role: string; privilege: string }>(
        `SELECT r AS role, p AS privilege FROM unnest($1::text[]) r CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) p
         WHERE has_table_privilege(r, 'crove_kernel.calendar_credential', p)`,
        [roles],
      ),
    );
    expect(grants.rows).toEqual([]);
    const execute = await admin((cl) =>
      cl.query<{ fn: string; role: string }>(
        `SELECT f AS fn, r AS role FROM unnest(ARRAY[
            'crove_kernel.calendar_credential_get(uuid)', 'crove_kernel.calendar_credential_put(uuid, text, bytea)', 'crove_kernel.calendar_credential_drop(uuid)',
            'crove_kernel.calendar_oauth_begin(text, text, text, integer)', 'crove_kernel.calendar_oauth_consume(text, text)', 'crove_kernel.calendar_sync_due(uuid, uuid, integer)']) f,
          unnest($1::text[]) r WHERE has_function_privilege(r, f, 'EXECUTE') ORDER BY 1, 2`,
        [roles],
      ),
    );
    expect(execute.rows.map((r) => `${r.fn} ${r.role}`)).toEqual([
      'crove_kernel.calendar_credential_drop(uuid) crove_app',
      'crove_kernel.calendar_credential_drop(uuid) crove_worker',
      'crove_kernel.calendar_credential_get(uuid) crove_worker',
      'crove_kernel.calendar_credential_put(uuid, text, bytea) crove_app',
      'crove_kernel.calendar_credential_put(uuid, text, bytea) crove_worker',
      'crove_kernel.calendar_oauth_begin(text, text, text, integer) crove_app',
      'crove_kernel.calendar_oauth_consume(text, text) crove_app',
      'crove_kernel.calendar_sync_due(uuid, uuid, integer) crove_worker',
    ]);
  });

  it('refuses the API login every way of opening a credential, whatever actor its runtime claims', async () => {
    const { orgId, others } = await orgWith(['member']);
    const c = await connect(orgId, others[0] as string);
    // The runtime on the API login, as a system actor: the system context is the worker's alone.
    await expect(api.query('kernel.calendar.credential', { connectionId: c.connectionId }, { actor: system, orgId })).rejects.toBeDefined();
    // The definer directly, in the owner's own member context.
    await expect(asMemberSql(others[0] as string, orgId, 'SELECT * FROM crove_kernel.calendar_credential_get($1::uuid)', [c.connectionId])).rejects.toThrow(/permission denied/);
    // The table directly.
    await expect(asMemberSql(others[0] as string, orgId, 'SELECT envelope FROM crove_kernel.calendar_credential', [])).rejects.toThrow(/permission denied/);
    // The worker opens it only in the system context of the connection's own org.
    await expect(asWorkerSql(randomUUID(), 'SELECT * FROM crove_kernel.calendar_credential_get($1::uuid)', [c.connectionId])).rejects.toThrow();
    const other = await orgWith([]);
    await expect(asWorkerSql(other.orgId, 'SELECT * FROM crove_kernel.calendar_credential_get($1::uuid)', [c.connectionId])).rejects.toThrow('CALENDAR_NOT_FOUND');
    expect((await asWorkerSql(orgId, 'SELECT key_id FROM crove_kernel.calendar_credential_get($1::uuid)', [c.connectionId])).rowCount).toBe(1);
  });

  it('opens a credential only while its member is still in the org and not disabled', async () => {
    const { orgId, others } = await orgWith(['member', 'member']);
    const gone = await connect(orgId, others[0] as string);
    const disabled = await connect(orgId, others[1] as string);
    await admin((cl) => cl.query('DELETE FROM crove_kernel.tenant_member WHERE org_id = $1 AND user_id = $2', [orgId, others[0]]));
    await expect(sealedOf(orgId, gone.connectionId)).rejects.toMatchObject({ code: 'CALENDAR_OWNER_LEFT' });
    await admin((cl) => cl.query('UPDATE crove_kernel.user_account SET disabled_at = now() WHERE id = $1', [others[1]]));
    await expect(sealedOf(orgId, disabled.connectionId)).rejects.toMatchObject({ code: 'CALENDAR_OWNER_LEFT' });
    // Demoted to viewer: a viewer has no calendar of their own to sync.
    const demoted = await orgWith(['member']);
    const kept = await connect(demoted.orgId, demoted.others[0] as string);
    await admin((cl) => cl.query("UPDATE crove_kernel.tenant_member SET role = 'viewer' WHERE org_id = $1 AND user_id = $2", [demoted.orgId, demoted.others[0]]));
    await expect(sealedOf(demoted.orgId, kept.connectionId)).rejects.toMatchObject({ code: 'CALENDAR_OWNER_LEFT' });
  });

  it('seals into and drops a credential only for the member who owns the connection, never across orgs', async () => {
    const a = await orgWith(['member', 'member']);
    const b = await orgWith([]);
    const mine = await connect(a.orgId, a.others[0] as string);
    const put = (user: string, orgId: string, connectionId: string) =>
      asMemberSql(user, orgId, 'SELECT crove_kernel.calendar_credential_put($1::uuid, $2, $3::bytea)', [connectionId, 'k', Buffer.from([1])]);
    const drop = (user: string, orgId: string, connectionId: string) => asMemberSql(user, orgId, 'SELECT crove_kernel.calendar_credential_drop($1::uuid)', [connectionId]);
    // A colleague, and the org's owner, are refused: the credential is the member's own.
    for (const who of [a.others[1] as string, a.owner]) {
      await expect(put(who, a.orgId, mine.connectionId)).rejects.toThrow('CALENDAR_FORBIDDEN');
      await expect(drop(who, a.orgId, mine.connectionId)).rejects.toThrow('CALENDAR_FORBIDDEN');
    }
    // Another org's owner finds no such connection to seal into, and cannot drop it.
    await expect(put(b.owner, b.orgId, mine.connectionId)).rejects.toThrow('CALENDAR_NOT_FOUND');
    await expect(drop(b.owner, b.orgId, mine.connectionId)).rejects.toThrow('CALENDAR_FORBIDDEN');
    // Nothing above changed it.
    expect(JSON.parse(vault.open(await sealedOf(a.orgId, mine.connectionId).then((s) => ({ keyId: s.keyId, envelope: Buffer.from(s.envelope, 'base64') })), { orgId: a.orgId, provider: 'calendar:google', externalAccountId: mine.account }))).toMatchObject({ refreshToken: '1//calendar-refresh-secret' });
    // The owner of the connection may drop it.
    await expect(drop(a.others[0] as string, a.orgId, mine.connectionId)).resolves.toBeDefined();
  });

  it('binds a connect attempt to the member, the org and a calendar provider, once', async () => {
    const a = await orgWith(['member', 'member', 'viewer']);
    const b = await orgWith([]);
    const [member, colleague, viewer] = a.others as [string, string, string];
    const hash = () => `sha256:${randomBytes(32).toString('hex')}`;
    const begin = (user: string, orgId: string, provider: string, stateHash: string, verifier: string | null = null) =>
      asMemberSql(user, orgId, 'SELECT crove_kernel.calendar_oauth_begin($1, $2, $3, 600)', [provider, stateHash, verifier]);
    const consume = (user: string, orgId: string, provider: string, stateHash: string) => asMemberSql(user, orgId, 'SELECT * FROM crove_kernel.calendar_oauth_consume($1, $2)', [provider, stateHash]);
    // Only calendar providers: a channel provider's attempt cannot be started through this door.
    await expect(begin(member, a.orgId, 'facebook_page', hash())).rejects.toThrow('OAUTH_INVALID');
    await expect(begin(viewer, a.orgId, 'google_calendar', hash())).rejects.toThrow('OAUTH_FORBIDDEN');
    await expect(begin(member, a.orgId, 'google_calendar', 'plain-state')).rejects.toThrow('OAUTH_INVALID');
    // An attempt lives in the database, not in a transaction that rolled back: start one and finish it with commits.
    const state = hash();
    const client = new pg.Client({ connectionString: urlFor('crove_app', 'test-app-pw') });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [a.orgId, contextToken(member, a.orgId)]);
      await client.query("SELECT crove_kernel.calendar_oauth_begin('google_calendar', $1, NULL, 600)", [state]);
      await client.query('COMMIT');
    } finally {
      await client.end();
    }
    // The colleague, another org's member and the wrong provider all see the same refusal as no attempt.
    await expect(consume(colleague, a.orgId, 'google_calendar', state)).rejects.toThrow('OAUTH_STATE_INVALID');
    await expect(consume(b.owner, b.orgId, 'google_calendar', state)).rejects.toThrow('OAUTH_STATE_INVALID');
    await expect(consume(member, a.orgId, 'microsoft_calendar', state)).rejects.toThrow('OAUTH_STATE_INVALID');
    await expect(consume(member, a.orgId, 'facebook_page', state)).rejects.toThrow('OAUTH_STATE_INVALID');
    // The state itself never reaches the table, only its hash.
    const rows = await admin((cl) => cl.query<{ state_hash: string }>('SELECT state_hash FROM crove_kernel.oauth_state WHERE org_id = $1', [a.orgId]));
    expect(rows.rows.map((r) => r.state_hash)).toEqual([state]);
  });
});
