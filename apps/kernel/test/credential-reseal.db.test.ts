// Credential reseal after a key rotation on PostgreSQL 17 (#776): the worker seals every active credential still under the
// previous key with the current one, once, with a compare on the key it read, and counts what is left. Set
// CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity, type SealedChannelCredential } from '@crove/kernel';
import { CredentialVault, Runtime, parseVaultKey } from '@crove/kernel-runtime';
import { resealCredentials } from '../src/credential-reseal.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const HOUR = 3_600_000;

suite('credential reseal after a key rotation on PostgreSQL (#776)', () => {
  const dbName = `crove_test_credential_reseal_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appPool: pg.Pool;
  let workerPool: pg.Pool;
  let appDb: Db;
  let workerDb: Db;
  let api: Runtime;
  let worker: Runtime;
  const oldKey = parseVaultKey(randomBytes(32).toString('base64'));
  const newKey = parseVaultKey(randomBytes(32).toString('base64'));
  // Before the rotation the old key seals; after it the new one seals and the old one still opens.
  const vault = new CredentialVault([oldKey]);
  const rotated = new CredentialVault([newKey, oldKey]);
  const after = new CredentialVault([newKey]);
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const system = { type: 'system' as const, component: 'reseal-test' };

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
    const owner = await upsertIdentity(appDb, { issuer: 'test', subject: randomUUID(), email: `owner-${randomUUID().slice(0, 8)}@reseal.test`, name: null });
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
    api = new Runtime(appDb, { manifests: TEST_MANIFESTS }).register(defs);
    worker = new Runtime(workerDb, { manifests: TEST_MANIFESTS }).register(defs);
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

  const keyOf = (connectionId: string) => admin(async (c) => (await c.query<{ key_id: string }>('SELECT key_id FROM crove_kernel.credential WHERE connection_id = $1', [connectionId])).rows[0]?.key_id);

  it('seals every active credential under the old key with the new one, once, and counts what is left', async () => {
    const o = await org();
    const a = await connect(o, 30 * 24 * HOUR, JSON.stringify({ accessToken: 'token-a' }));
    const b = await connect(o, 30 * 24 * HOUR, JSON.stringify({ accessToken: 'token-b' }));
    const gone = await connect(o, 30 * 24 * HOUR, JSON.stringify({ accessToken: 'token-c' }));
    await admin((c) => c.query("UPDATE crove_kernel.channel_connection SET status = 'expired' WHERE id = $1", [gone]));
    expect(await keyOf(a)).toBe(oldKey.id);
    const versionBefore = await admin(async (c) => (await c.query<{ updated_at: Date }>('SELECT updated_at FROM crove_kernel.channel_connection WHERE id = $1', [a])).rows[0]?.updated_at);

    const first = await resealCredentials({ runtime: worker, broker: rotated, workerDb });
    expect(first).toMatchObject({ resealed: 2, failed: 0, leftActive: 0, skipped: false });
    expect(first.leftInactive).toBeGreaterThanOrEqual(1);
    expect(await keyOf(a)).toBe(newKey.id);
    expect(await keyOf(b)).toBe(newKey.id);
    // The expired one waits for a reconnect, still under the old key.
    expect(await keyOf(gone)).toBe(oldKey.id);
    // The same token, now opening with the new key alone; the connection's version is untouched.
    const s = await worker.query<SealedChannelCredential>('kernel.channel.credential', { connectionId: a }, { actor: system, orgId: o.orgId });
    expect(after.open({ keyId: s.keyId, envelope: Buffer.from(s.envelope, 'base64') }, { orgId: o.orgId, provider: s.provider, externalAccountId: s.externalAccountId })).toBe(JSON.stringify({ accessToken: 'token-a' }));
    expect(await admin(async (c) => (await c.query<{ updated_at: Date }>('SELECT updated_at FROM crove_kernel.channel_connection WHERE id = $1', [a])).rows[0]?.updated_at)).toEqual(versionBefore);
    // Nothing more to do on a second pass.
    expect(await resealCredentials({ runtime: worker, broker: rotated, workerDb })).toMatchObject({ resealed: 0, failed: 0, leftActive: 0 });
    // Audit rows name key ids, never a token.
    const audits = await admin(async (c) => (await c.query<{ detail: Record<string, unknown> }>("SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.channel.reseal'", [o.orgId])).rows);
    expect(audits).toHaveLength(2);
    expect(audits[0]?.detail).toMatchObject({ from_key_id: oldKey.id, key_id: newKey.id });
    expect(JSON.stringify(audits)).not.toContain('token-a');
  });

  it('changes nothing when the envelope moved on since it was read, and is the worker alone', async () => {
    const o = await org();
    const id = await connect(o, 30 * 24 * HOUR, JSON.stringify({ accessToken: 'token-d' }));
    const sealed = rotated.seal(JSON.stringify({ accessToken: 'token-d' }), { orgId: o.orgId, provider: 'zalo_oa', externalAccountId: (await admin(async (c) => (await c.query<{ external_account_id: string }>('SELECT external_account_id FROM crove_kernel.channel_connection WHERE id = $1', [id])).rows[0]?.external_account_id)) as string });
    const credential = { keyId: sealed.keyId, envelope: sealed.envelope.toString('base64') };
    // A reconnect or refresh sealed a newer envelope after the worker read it: the read key no longer matches.
    const stored = await worker.query<SealedChannelCredential>('kernel.channel.credential', { connectionId: id }, { actor: system, orgId: o.orgId });
    const readSha = createHash('sha256').update(Buffer.from(stored.envelope, 'base64')).digest('hex');
    expect(await worker.execute('kernel.channel.reseal', { connectionId: id, fromKeyId: newKey.id, fromEnvelopeSha256: readSha, credential }, { actor: system, orgId: o.orgId })).toMatchObject({ resealed: false });
    // A replica still on the old key refreshed it: same key id, other bytes. The worker's copy is stale, nothing changes.
    expect(await worker.execute('kernel.channel.reseal', { connectionId: id, fromKeyId: oldKey.id, fromEnvelopeSha256: '0'.repeat(64), credential }, { actor: system, orgId: o.orgId })).toMatchObject({ resealed: false });
    expect(await keyOf(id)).toBe(oldKey.id);
    await expect(api.execute('kernel.channel.reseal', { connectionId: id, fromKeyId: oldKey.id, fromEnvelopeSha256: readSha, credential }, { actor: asUser(o.owner), orgId: o.orgId })).rejects.toMatchObject({ status: 403 });
    const roles = await admin(async (c) =>
      (await c.query<{ role: string }>(`SELECT r AS role FROM unnest(ARRAY['crove_app', 'crove_worker', 'crove_tenant', 'crove_definer_tenant']) r WHERE has_function_privilege(r, 'crove_kernel.credential_reseal_due(text, int, timestamptz, uuid)', 'EXECUTE') OR has_function_privilege(r, 'crove_kernel.credential_key_counts()', 'EXECUTE')`)).rows,
    );
    expect(roles.map((r) => r.role)).toEqual(['crove_worker']);
  });

  it('leaves credentials whose member left to their reconnect, counted apart, and goes past them', async () => {
    const o = await org();
    const usable = await connect(o, 30 * 24 * HOUR, JSON.stringify({ accessToken: 'token-e' }));
    const orphan = await connect(o, 30 * 24 * HOUR, JSON.stringify({ accessToken: 'token-f' }));
    // The orphan was sealed first, so a scan that stopped at it would never reach the other one.
    await admin((c) => c.query("UPDATE crove_kernel.credential SET sealed_at = now() - interval '1 day' WHERE connection_id = $1", [orphan]));
    const admin2 = await upsertIdentity(appDb, { issuer: 'test', subject: randomUUID(), email: `gone-${randomUUID().slice(0, 8)}@reseal.test`, name: null });
    await admin((c) => c.query('UPDATE crove_kernel.channel_connection SET connected_by = $2 WHERE id = $1', [orphan, admin2]));
    const done = await resealCredentials({ runtime: worker, broker: rotated, workerDb });
    expect(await keyOf(usable)).toBe(newKey.id);
    expect(await keyOf(orphan)).toBe(oldKey.id);
    expect(done.leftActive).toBe(0);
    expect(done.leftInactive).toBeGreaterThanOrEqual(1);
  });

  it('skips a broker that does not say which key it seals with', async () => {
    const opaque = { id: 'other', seal: rotated.seal.bind(rotated), open: rotated.open.bind(rotated) };
    expect(await resealCredentials({ runtime: worker, broker: opaque, workerDb })).toMatchObject({ skipped: true, resealed: 0 });
  });
});