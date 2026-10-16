// Org offboarding with export (issue #38, plan §7.9) on a real PostgreSQL 17: the product flow. Access, status and
// audit invariants live in test/invariant/offboarding.db.test.ts. Set CROVE_TEST_ADMIN_URL to a superuser
// URL; the run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { EXPORT_TABLE_NAMES, createOrg, kernelCommands, kernelQueries, myOrgs, upsertIdentity, type OrgExportView } from '@crove/kernel';
import { Runtime, fileKey, sha256Hex, type BlobStore } from '@crove/kernel-runtime';
import { financeCommands, financeQueries } from '@crove/mod-finance';
import type { AuthUser } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { runOrgExport, type OrgExportManifest } from '../src/org-export.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));

class MemoryStore implements BlobStore {
  readonly blobs = new Map<string, Uint8Array>();
  // Memory has no object versions: the generation is the content address (ADR-0013).
  async put(key: string, bytes: Uint8Array) {
    this.blobs.set(key, bytes);
    return `content:${sha256Hex(bytes)}`;
  }
  async get(key: string) {
    const b = this.blobs.get(key);
    if (!b) throw new Error('missing blob');
    return b;
  }
  async delete(key: string) {
    this.blobs.delete(key);
  }
}

const suite = ADMIN ? describe : describe.skip;

suite('org offboarding on PostgreSQL (#38)', () => {
  const dbName = `crove_test_offboard_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let db: Db;
  let runtime: Runtime;
  let workerRuntime: Runtime;
  const store = new MemoryStore();

  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const asMfa = (userId: string) => ({
    type: 'user' as const,
    userId,
    aal: 'aal2' as const,
    sessionId: randomUUID(),
    mfaAt: Math.floor(Date.now() / 1000),
  });

  async function newUser(label: string) {
    const tag = `${label}-${randomUUID().slice(0, 8)}`;
    const email = `${tag}@example.com`;
    return { id: await upsertIdentity(db, { issuer: 'test', subject: tag, email, name: label }), email };
  }

  async function withAdmin<T>(fn: (admin: pg.Client) => Promise<T>): Promise<T> {
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      return await fn(admin);
    } finally {
      await admin.end();
    }
  }

  // An org with an owner and a member who joined through an invite, and a file.
  async function orgWithMember(name: string) {
    const owner = await newUser('owner');
    const member = await newUser('member');
    const org = await createOrg(runtime, asUser(owner.id), name);
    const { acceptPath } = await runtime.execute<{ acceptPath: string }>(
      'kernel.member.invite.create',
      { email: member.email, role: 'member' },
      { actor: asMfa(owner.id), orgId: org.orgId },
    );
    await runtime.executeOrgless('kernel.member.invite.accept', { token: acceptPath.split('#')[1] }, { actor: asUser(member.id) });
    const bytes = new TextEncoder().encode(`<xml>${name}</xml>`);
    const sha256 = sha256Hex(bytes);
    const generation = await store.put(fileKey(org.orgId, sha256), bytes);
    await runtime.execute(
      'kernel.file.ingest',
      { filename: 'hd.xml', contentType: 'application/xml', sizeBytes: bytes.byteLength, sha256, storageKey: fileKey(org.orgId, sha256), generation, source: 'upload' },
      { actor: asUser(member.id), orgId: org.orgId },
    );
    return { org, owner, member };
  }

  const status = (orgId: string) =>
    withAdmin(async (admin) => (await admin.query<{ status: string }>('SELECT status FROM crove_kernel.tenant WHERE org_id = $1', [orgId])).rows[0]?.status);

  beforeAll(async () => {
    const base = new URL(ADMIN as string);
    const admin = new pg.Client({ connectionString: ADMIN });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    const loginUrl = (username: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = username;
      url.password = password;
      return url.toString();
    };
    appUrl = loginUrl('crove_app', 'test-app-pw');
    pool = createPool({ connectionString: appUrl, max: 4 });
    workerPool = createPool({ connectionString: loginUrl('crove_worker', 'test-worker-pw'), max: 4 });
    db = createDb(pool);
    const register = (target: Db) =>
      new Runtime(target).register({
        commands: [...kernelCommands, ...financeCommands],
        queries: [...kernelQueries({ inboundDomain: 'in.test' }), ...financeQueries],
      });
    runtime = register(db);
    workerRuntime = register(createDb(workerPool));
  });

  afterAll(async () => {
    await pool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    const admin = new pg.Client({ connectionString: ADMIN });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  });

  it('is owner-only R3 with a typed slug, and refusals change nothing', async () => {
    const { org, owner, member } = await orgWithMember('Công ty Từ chối');
    await expect(runtime.execute('kernel.org.offboard', { confirmSlug: org.slug }, { actor: asMfa(member.id), orgId: org.orgId })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      status: 403,
    });
    await expect(runtime.execute('kernel.org.offboard', { confirmSlug: org.slug }, { actor: asUser(owner.id), orgId: org.orgId })).rejects.toMatchObject({
      code: 'STEP_UP_REQUIRED',
    });
    await expect(runtime.execute('kernel.org.offboard', { confirmSlug: 'khac' }, { actor: asMfa(owner.id), orgId: org.orgId })).rejects.toMatchObject({
      code: 'SLUG_MISMATCH',
      status: 422,
    });
    expect(await status(org.orgId)).toBe('active');
    const refusals = await withAdmin(async (admin) =>
      (
        await admin.query<{ outcome: string }>(
          `SELECT outcome FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.org.offboard' ORDER BY occurred_at, id`,
          [org.orgId],
        )
      ).rows.map((r) => r.outcome),
    );
    expect(refusals).toEqual(['denied', 'denied', 'failed']);
  });

  it('moves the org to offboarding, audited, and from then on only owners get in', async () => {
    const { org, owner, member } = await orgWithMember('Công ty Đóng');
    const result = await runtime.execute('kernel.org.offboard', { confirmSlug: org.slug }, { actor: asMfa(owner.id), orgId: org.orgId });
    expect(result).toEqual({ status: 'offboarding', exportRequested: true });
    expect(await status(org.orgId)).toBe('offboarding');
    const audit = await withAdmin(async (admin) =>
      (
        await admin.query<{ actor_id: string; outcome: string; detail: Record<string, unknown> }>(
          `SELECT actor_id, outcome, detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.org.offboard'`,
          [org.orgId],
        )
      ).rows,
    );
    expect(audit).toEqual([
      { actor_id: owner.id, outcome: 'ok', detail: expect.objectContaining({ previous_status: 'active', status: 'offboarding', aal: 'aal2' }) },
    ]);
    const events = await withAdmin(async (admin) =>
      (await admin.query<{ type: string }>(`SELECT type FROM crove_kernel.outbox_event WHERE org_id = $1 AND type LIKE 'kernel.org.%'`, [org.orgId])).rows,
    );
    expect(events).toEqual([{ type: 'kernel.org.export_requested' }]);

    // The member is refused like a non-member, and the org leaves the member's list; the owner keeps both.
    await expect(runtime.query('kernel.org.get', {}, { actor: asUser(member.id), orgId: org.orgId })).rejects.toMatchObject({ status: 403 });
    expect((await myOrgs(db, member.id)).map((o) => o.orgId)).not.toContain(org.orgId);
    expect((await myOrgs(db, owner.id)).map((o) => o.orgId)).toContain(org.orgId);
    await expect(runtime.query('kernel.org.get', {}, { actor: asUser(owner.id), orgId: org.orgId })).resolves.toMatchObject({ orgId: org.orgId });

    // New members cannot join: an invite created now cannot be accepted.
    const late = await newUser('late');
    const { acceptPath } = await runtime.execute<{ acceptPath: string }>(
      'kernel.member.invite.create',
      { email: late.email, role: 'viewer' },
      { actor: asMfa(owner.id), orgId: org.orgId },
    );
    await expect(
      runtime.executeOrgless('kernel.member.invite.accept', { token: acceptPath.split('#')[1] }, { actor: asUser(late.id) }),
    ).rejects.toMatchObject({ code: 'INVITE_NOT_FOUND' });

    // Asking again while the export has not finished is refused; status and events stay as they are.
    await expect(runtime.execute('kernel.org.offboard', { confirmSlug: org.slug }, { actor: asMfa(owner.id), orgId: org.orgId })).rejects.toMatchObject({
      code: 'EXPORT_PENDING',
      status: 409,
    });
    expect(await status(org.orgId)).toBe('offboarding');
  });

  it('exports every table of the org and the stored files list, records it and serves it to owners only', async () => {
    const other = await orgWithMember('Công ty Khác');
    const { org, owner, member } = await orgWithMember('Công ty Xuất');
    await runtime.execute('kernel.org.offboard', { confirmSlug: org.slug }, { actor: asMfa(owner.id), orgId: org.orgId });

    const record = await runOrgExport({ runtime: workerRuntime, store }, org.orgId, () => new Date('2026-10-16T00:00:00Z'));
    expect(record.parts.map((p) => p.table)).toEqual(EXPORT_TABLE_NAMES);
    expect(record.fileCount).toBe(1);
    const read = async (key: string) => JSON.parse(new TextDecoder().decode(await store.get(key))) as Record<string, unknown>;
    for (const part of record.parts) {
      expect(part.key).toBe(fileKey(org.orgId, part.sha256));
      const doc = (await read(part.key)) as { orgId: string; table: string; rows: Array<Record<string, unknown>> };
      expect(doc).toMatchObject({ format: 'crove.org-export.v1', orgId: org.orgId, table: part.table });
      expect(doc.rows).toHaveLength(part.rows);
      // Only this org's rows, whatever the table.
      expect(doc.rows.every((r) => r.org_id === org.orgId)).toBe(true);
    }
    const part = (table: string) => record.parts.find((p) => p.table === table)!;
    const rowsOf = async (table: string) => ((await read(part(table).key)) as { rows: Array<Record<string, unknown>> }).rows;
    // Secrets stay out.
    expect(await rowsOf('kernel.tenant')).toEqual([expect.not.objectContaining({ inbound_token: expect.anything() })]);
    expect((await rowsOf('kernel.member_invite')).every((r) => !('token_sha256' in r))).toBe(true);
    expect((await rowsOf('kernel.tenant_member')).map((r) => r.user_id).sort()).toEqual([owner.id, member.id].sort());
    expect((await rowsOf('kernel.audit_event')).some((r) => r.command === 'kernel.org.offboard')).toBe(true);
    const manifest = (await read(record.manifestKey)) as unknown as OrgExportManifest;
    expect(manifest).toMatchObject({ orgId: org.orgId, generatedAt: '2026-10-16T00:00:00.000Z', parts: record.parts });
    expect(manifest.files).toEqual([
      expect.objectContaining({ filename: 'hd.xml', contentType: 'application/xml', storageKey: expect.stringMatching(`^org/${org.orgId}/`), generation: expect.stringMatching(/^content:/) }),
    ]);

    // Recorded and visible to owners.
    const view = await runtime.query<OrgExportView>('kernel.org.export.get', {}, { actor: asUser(owner.id), orgId: org.orgId });
    expect(view).toMatchObject({ status: 'offboarding', requestedAt: expect.any(String), export: { manifestKey: record.manifestKey, fileCount: 1 } });
    // Once it finished, the owner may ask for a new export (the worker then exports again).
    await expect(runtime.execute('kernel.org.offboard', { confirmSlug: org.slug }, { actor: asMfa(owner.id), orgId: org.orgId })).resolves.toEqual({
      status: 'offboarding',
      exportRequested: true,
    });
    // The other org has no export and is untouched.
    const otherView = await runtime.query<OrgExportView>('kernel.org.export.get', {}, { actor: asUser(other.owner.id), orgId: other.org.orgId });
    expect(otherView).toEqual({ status: 'active', requestedAt: null, export: null });
    await expect(runtime.query('kernel.org.export.get', {}, { actor: asUser(other.member.id), orgId: other.org.orgId })).rejects.toMatchObject({
      status: 403,
    });

    // The system command refuses keys outside the org's prefix.
    await expect(
      workerRuntime.execute(
        'kernel.org.export.record',
        { ...record, manifestKey: fileKey(other.org.orgId, record.manifestSha256) },
        { actor: { type: 'system', component: 'test' }, orgId: org.orgId },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_STORAGE_KEY' });
    // Users cannot run the export query or record an export.
    await expect(runtime.query('kernel.org.export.snapshot', { table: 'kernel.party' }, { actor: asUser(owner.id), orgId: org.orgId })).rejects.toMatchObject({
      status: 403,
    });

    // Download through the API: owners only, parts named by the recorded export.
    const users = new Map<string, AuthUser>(
      [owner.id, other.owner.id].map((id) => [id, { userId: id, email: '', name: null, aal: 'aal1', sessionId: randomUUID(), mfaAt: null }]),
    );
    const app = createHttpApp({
      config: loadConfig({ DATABASE_URL: appUrl, AUTH_JWT_SECRET: 'test-only-jwt-secret-for-export-0123456789', AUTH_ISSUER: 'test-auth', WEB_DIST: '/nonexistent' }),
      runtime,
      store,
      authenticate: async (header) => users.get(String(header).replace('Bearer ', ''))!,
      pool,
      aiEnabled: false,
    });
    const get = (path: string, userId: string, slug: string) =>
      app.request(path, { headers: { authorization: `Bearer ${userId}`, 'x-crove-org': slug } });
    const manifestResponse = await get('/api/org-export/manifest', owner.id, org.slug);
    expect(manifestResponse.status).toBe(200);
    expect(manifestResponse.headers.get('content-disposition')).toContain('attachment');
    expect(sha256Hex(new Uint8Array(await manifestResponse.arrayBuffer()))).toBe(record.manifestSha256);
    const partyResponse = await get('/api/org-export/kernel.party', owner.id, org.slug);
    expect(sha256Hex(new Uint8Array(await partyResponse.arrayBuffer()))).toBe(part('kernel.party').sha256);
    expect((await get('/api/org-export/kernel.nope', owner.id, org.slug)).status).toBe(404);
    // Another org's owner gets nothing from this org, and nothing of their own yet.
    expect((await get('/api/org-export/manifest', other.owner.id, org.slug)).status).toBe(403);
    expect((await get('/api/org-export/manifest', other.owner.id, other.org.slug)).status).toBe(404);
  });
});
