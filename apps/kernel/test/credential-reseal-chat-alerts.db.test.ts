// Credential reseal after a key rotation, for team chat alert targets (#863, #776) on PostgreSQL 17: the worker's
// sweep seals every usable target still under the previous key with the current one, with a compare on the envelope
// it read, leaves the targets whose saver is no longer an owner or admin to a new save, and counts both. Set
// CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { CredentialVault, Runtime, parseVaultKey } from '@crove/kernel-runtime';
import { CHAT_ALERT_PROVIDER, socialCommands, socialQueries, type SealedChatAlert } from '@crove/mod-social';
import { resealCredentials } from '../src/credential-reseal.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const BOT_TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw1';

suite('team chat alert targets resealed after a key rotation on PostgreSQL (#863)', () => {
  const dbName = `crove_test_chat_alert_reseal_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appPool: pg.Pool;
  let workerPool: pg.Pool;
  let appDb: Db;
  let workerDb: Db;
  let api: Runtime;
  let worker: Runtime;
  const keyA = parseVaultKey(randomBytes(32).toString('base64'));
  const keyB = parseVaultKey(randomBytes(32).toString('base64'));
  // Before the rotation A seals; after it B seals and A still opens; once it is done, B alone.
  const beforeRotation = new CredentialVault([keyA]);
  const rotated = new CredentialVault([keyB, keyA]);
  const onlyB = new CredentialVault([keyB]);
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

  const person = (name: string) => upsertIdentity(appDb, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@reseal.test`, name: null });
  async function org() {
    const owner = await person('owner');
    const { orgId } = await createOrg(api, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    const adminUser = await person('admin');
    await admin((c) => c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin')", [orgId, adminUser]));
    return { orgId, owner, admin: adminUser };
  }
  const secretOf = (chatId: string) => JSON.stringify({ botToken: BOT_TOKEN, chatId });
  // What the API does on save: seal with the key of the day for a new alert id, then the command seals it in.
  async function save(orgId: string, user: string, chatId: string) {
    const id = randomUUID();
    const sealed = beforeRotation.seal(secretOf(chatId), { orgId, provider: CHAT_ALERT_PROVIDER, externalAccountId: id });
    await api.execute('social.chat_alert.save', { id, kind: 'telegram', keyId: sealed.keyId, envelope: sealed.envelope.toString('base64'), label: 'Nhóm', events: ['failed'] }, { actor: asUser(user), orgId });
    return id;
  }
  const keyOf = (alertId: string) => admin(async (c) => (await c.query<{ key_id: string }>('SELECT key_id FROM crove_social.chat_alert_target WHERE alert_id = $1', [alertId])).rows[0]?.key_id);
  const target = (orgId: string, alertId: string) => worker.query<SealedChatAlert>('social.chat_alert.target', { alertId }, { actor: system, orgId });

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
    const defs = { commands: [...kernelCommands, ...socialCommands], queries: [...kernelQueries({ inboundDomain: null }), ...socialQueries] };
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

  it('reseals a usable target under the new key, once, and leaves one whose saver was demoted to a new save', async () => {
    const a = await org();
    const b = await org();
    const usable = await save(a.orgId, a.owner, '-4012345678');
    const demoted = await save(b.orgId, b.admin, '-4012345679');
    await admin((c) => c.query("UPDATE crove_kernel.tenant_member SET role = 'member' WHERE org_id = $1 AND user_id = $2", [b.orgId, b.admin]));
    expect(await keyOf(usable)).toBe(keyA.id);

    const first = await resealCredentials({ runtime: worker, broker: rotated, workerDb });
    expect(first).toMatchObject({ resealed: 1, failed: 0, leftActive: 0, leftInactive: 1, skipped: false });
    expect(await keyOf(usable)).toBe(keyB.id);
    expect(await keyOf(demoted)).toBe(keyA.id);
    // The same target, now opening under B alone and no longer under A.
    const sealed = await target(a.orgId, usable);
    const envelope = { keyId: sealed.keyId, envelope: Buffer.from(sealed.envelope, 'base64') };
    const binding = { orgId: a.orgId, provider: CHAT_ALERT_PROVIDER, externalAccountId: usable };
    expect(onlyB.open(envelope, binding)).toBe(secretOf('-4012345678'));
    expect(() => beforeRotation.open(envelope, binding)).toThrow();
    // Nothing more to do on a second pass; the demoted saver's target is still counted, apart.
    expect(await resealCredentials({ runtime: worker, broker: rotated, workerDb })).toMatchObject({ resealed: 0, failed: 0, leftActive: 0, leftInactive: 1 });
    // Saved again by an owner, it is sealed under the key of the day, and nothing is left.
    const sealedAgain = rotated.seal(secretOf('-4012345679'), { orgId: b.orgId, provider: CHAT_ALERT_PROVIDER, externalAccountId: demoted });
    await api.execute('social.chat_alert.save', { id: demoted, kind: 'telegram', keyId: sealedAgain.keyId, envelope: sealedAgain.envelope.toString('base64'), label: 'Nhóm', events: ['failed'] }, { actor: asUser(b.owner), orgId: b.orgId });
    expect(await resealCredentials({ runtime: worker, broker: rotated, workerDb })).toMatchObject({ resealed: 0, leftActive: 0, leftInactive: 0 });
    // Audit rows name key ids, never the target.
    const audits = await admin(async (c) => (await c.query<{ detail: Record<string, unknown> }>("SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'social.chat_alert.reseal'", [a.orgId])).rows);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.detail).toMatchObject({ alert_id: usable, from_key_id: keyA.id, key_id: keyB.id });
    expect(JSON.stringify(audits)).not.toContain(BOT_TOKEN.split(':')[1]);
  });

  it('counts the targets under the old key with the Social module left out, apart, and reseals them once it is on (#1878)', async () => {
    // A worker of a deployment that leaves Social out: the tables stay (ADR-0031), its commands do not.
    const kernelOnly = new Runtime(workerDb, { manifests: TEST_MANIFESTS }).register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) });
    expect(kernelOnly.installed('social')).toBe(false);
    const c = await org();
    const waiting = await save(c.orgId, c.owner, '-4012345680');
    expect(await keyOf(waiting)).toBe(keyA.id);
    const off = await resealCredentials({ runtime: kernelOnly, broker: rotated, workerDb });
    // Not resealed, not lost from the counts: it keeps the previous key from being retired.
    expect(off).toMatchObject({ resealed: 0, failed: 0, skipped: false });
    expect(off.leftWaiting).toBeGreaterThanOrEqual(1);
    expect(await keyOf(waiting)).toBe(keyA.id);
    // Social on again: the next pass reseals it, and nothing waits.
    const on = await resealCredentials({ runtime: worker, broker: rotated, workerDb });
    expect(on.resealed).toBeGreaterThanOrEqual(1);
    expect(on.leftWaiting).toBe(0);
    expect(await keyOf(waiting)).toBe(keyB.id);
  });

  it('changes nothing when the envelope moved on since it was read, and is the worker alone', async () => {
    const o = await org();
    const id = await save(o.orgId, o.owner, '-4012345670');
    const next = rotated.seal(secretOf('-4012345670'), { orgId: o.orgId, provider: CHAT_ALERT_PROVIDER, externalAccountId: id });
    const sealed = await target(o.orgId, id);
    const readSha = createHash('sha256').update(Buffer.from(sealed.envelope, 'base64')).digest('hex');
    const input = (fromKeyId: string, fromEnvelopeSha256: string) => ({ alertId: id, fromKeyId, fromEnvelopeSha256, keyId: next.keyId, envelope: next.envelope.toString('base64') });
    // Another key read, or other bytes: a newer save came in between, nothing changes.
    expect(await worker.execute('social.chat_alert.reseal', input(keyB.id, readSha), { actor: system, orgId: o.orgId })).toEqual({ resealed: false });
    expect(await worker.execute('social.chat_alert.reseal', input(keyA.id, '0'.repeat(64)), { actor: system, orgId: o.orgId })).toEqual({ resealed: false });
    expect(await keyOf(id)).toBe(keyA.id);
    await expect(api.execute('social.chat_alert.reseal', input(keyA.id, readSha), { actor: asUser(o.owner), orgId: o.orgId })).rejects.toMatchObject({ status: 403 });
    expect(await worker.execute('social.chat_alert.reseal', input(keyA.id, readSha), { actor: system, orgId: o.orgId })).toEqual({ resealed: true });
    expect(await keyOf(id)).toBe(keyB.id);
    const roles = await admin(
      async (c) =>
        (
          await c.query<{ role: string }>(
            `SELECT r AS role FROM unnest(ARRAY['crove_app', 'crove_worker', 'crove_tenant', 'crove_definer_tenant']) r
              WHERE has_function_privilege(r, 'crove_social.chat_alert_target_reseal_due(text, int, timestamptz, uuid)', 'EXECUTE')
                 OR has_function_privilege(r, 'crove_social.chat_alert_target_key_counts()', 'EXECUTE')
                 OR has_function_privilege(r, 'crove_social.chat_alert_target_reseal(uuid, text, text, text, bytea)', 'EXECUTE')`,
          )
        ).rows,
    );
    expect(roles.map((r) => r.role)).toEqual(['crove_worker']);
    const usableRoles = await admin(
      async (c) =>
        (await c.query<{ role: string }>(`SELECT r AS role FROM unnest(ARRAY['crove_app', 'crove_worker', 'crove_tenant', 'crove_definer_tenant']) r WHERE has_function_privilege(r, 'crove_social.chat_alert_target_usable(uuid, uuid)', 'EXECUTE')`)).rows,
    );
    expect(usableRoles).toEqual([]);
  });
});
