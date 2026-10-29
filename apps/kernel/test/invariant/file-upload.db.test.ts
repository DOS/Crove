// Invariant suite: evidence integrity in the database (ADR-0013, issue #109, plan §7.6, red-team S25). A file row's
// triple (storage_key, generation, sha256) never changes for any role, every new file reference carries a
// generation, and a staged upload grant is created with the database's clock and creator, and used at most once,
// only by its creator, only before it expires. Self-contained like the rest of test/invariant/.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime, fileKey, sha256Hex } from '@crove/kernel-runtime';
import { financeCommands, financeQueries } from '@crove/mod-finance';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';
import { contextToken } from './fixtures/context-token.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));

const suite = ADMIN ? describe : describe.skip;

suite('evidence integrity on PostgreSQL (ADR-0013, issue #109)', () => {
  const dbName = `crove_test_evidence_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let runtime: Runtime;
  let workerRuntime: Runtime;
  let workerPool: pg.Pool;
  const users = { owner: '', member: '', viewer: '' };
  let orgA = '';
  let fileId = '';

  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const asMfa = (userId: string) => ({
    type: 'user' as const,
    userId,
    aal: 'aal2' as const,
    sessionId: '0f6c3a52-8d3b-4c1e-9a77-5b2f0e9d1c01',
    mfaAt: Math.floor(Date.now() / 1000),
  });

  async function connect(url: string) {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    return client;
  }

  async function withAdmin<T>(fn: (admin: pg.Client) => Promise<T>): Promise<T> {
    const admin = await connect(adminUrl);
    try {
      return await fn(admin);
    } finally {
      await admin.end();
    }
  }

  // Runs fn as crove_app in the user's context of org A, in a transaction that always rolls back.
  async function asApp<T>(userId: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = await connect(appUrl);
    try {
      await c.query('BEGIN');
      await c.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [orgA, contextToken(userId, orgA)]);
      return await fn(c);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      await c.end();
    }
  }

  const ingestInput = (bytes: Uint8Array, generation: unknown) => {
    const sha256 = sha256Hex(bytes);
    return { filename: 'hd.xml', contentType: 'application/xml', sizeBytes: bytes.byteLength, sha256, storageKey: fileKey(orgA, sha256), generation, source: 'upload' };
  };
  const unique = () => new TextEncoder().encode(`<HDon>${randomUUID()}</HDon>`);

  const begin = (userId = users.owner) =>
    runtime.execute<{ uploadId: string; stagingKey: string; maxBytes: number; expiresAt: string }>('kernel.file.upload.begin', {}, { actor: asUser(userId), orgId: orgA });
  const claim = (uploadId: string, userId = users.owner) =>
    runtime.execute<{ stagingKey: string; maxBytes: number }>('kernel.file.upload.claim', { uploadId }, { actor: asUser(userId), orgId: orgA });

  beforeAll(async () => {
    const url = new URL(ADMIN as string);
    const root = await connect(ADMIN as string);
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    url.pathname = `/${dbName}`;
    adminUrl = url.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    const login = (username: string, password: string) => {
      const u = new URL(adminUrl);
      u.username = username;
      u.password = password;
      return u.toString();
    };
    appUrl = login('crove_app', 'test-app-pw');
    const register = (target: Db) =>
      new Runtime(target, { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands, ...financeCommands], queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries] });
    pool = createPool({ connectionString: appUrl, max: 6 });
    db = createDb(pool);
    runtime = register(db);
    workerPool = createPool({ connectionString: login('crove_worker', 'test-worker-pw'), max: 2 });
    workerRuntime = register(createDb(workerPool));
    for (const name of Object.keys(users) as Array<keyof typeof users>) {
      users[name] = await upsertIdentity(db, { issuer: 'test', subject: `evidence-${name}`, email: `evidence-${name}@example.com`, name: null });
    }
    orgA = (await createOrg(runtime, asUser(users.owner), 'Evidence A')).orgId;
    for (const role of ['member', 'viewer'] as const) {
      const { acceptPath } = await runtime.execute<{ acceptPath: string }>(
        'kernel.member.invite.create',
        { email: `evidence-${role}@example.com`, role },
        { actor: asMfa(users.owner), orgId: orgA },
      );
      await runtime.executeOrgless('kernel.member.invite.accept', { token: acceptPath.split('#')[1] }, { actor: asUser(users[role]) });
    }
    const bytes = unique();
    ({ fileId } = await runtime.execute<{ fileId: string }>('kernel.file.ingest', ingestInput(bytes, 's3:original-version'), { actor: asUser(users.owner), orgId: orgA }));
  });

  afterAll(async () => {
    await pool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    const root = await connect(ADMIN);
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('records the triple on every new file and refuses a reference without a valid generation', async () => {
    const row = await withAdmin(async (a) => (await a.query('SELECT storage_key, sha256, generation FROM crove_kernel.file WHERE id = $1', [fileId])).rows[0]);
    expect(row).toMatchObject({ generation: 's3:original-version' });
    const actor = { actor: asUser(users.owner), orgId: orgA };
    const bytes = unique();
    for (const generation of [undefined, null, '', 'v1', 'local:x', 's3:', 's3:has space', `content:${'0'.repeat(64)}`]) {
      // VALIDATION (the schema) or INVALID_GENERATION (a content: address of other bytes).
      await expect(runtime.execute('kernel.file.ingest', ingestInput(bytes, generation), actor), String(generation)).rejects.toMatchObject({
        code: expect.stringMatching(/^(VALIDATION|INVALID_GENERATION)$/),
      });
    }
    // The database refuses a content: generation that is not the row's own sha256, whoever inserts it.
    await asApp(users.owner, async (c) => {
      const sha256 = sha256Hex(bytes);
      await expect(
        c.query(
          `INSERT INTO crove_kernel.file (org_id, sha256, storage_key, generation, filename, content_type, size_bytes, source)
           VALUES ($1, $2, $3, $4, 'x.xml', 'application/xml', 1, 'upload')`,
          [orgA, sha256, fileKey(orgA, sha256), `content:${'0'.repeat(64)}`],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    });
    // And a key that is not the org's content address of the row's sha256.
    for (const key of [`org/${randomUUID()}/${sha256Hex(bytes)}`, `staging/${sha256Hex(bytes)}`]) {
      await asApp(users.owner, async (c) => {
        const sha256 = sha256Hex(bytes);
        await expect(
          c.query(
            `INSERT INTO crove_kernel.file (org_id, sha256, storage_key, generation, filename, content_type, size_bytes, source)
             VALUES ($1, $2, $3, $4, 'x.xml', 'application/xml', 1, 'upload')`,
            [orgA, sha256, key, `content:${sha256}`],
          ),
          key,
        ).rejects.toMatchObject({ code: '23514' });
      });
    }
    await expect(runtime.execute('kernel.file.ingest', ingestInput(bytes, `content:${sha256Hex(bytes)}`), actor)).resolves.toMatchObject({ duplicate: false });
  });

  it('never changes a file reference, for any role, the database owner included', async () => {
    for (const set of ["generation = 's3:swapped'", 'generation = NULL', `sha256 = '${'a'.repeat(64)}'`, "storage_key = 'org/x'", "filename = 'other.xml'"]) {
      await asApp(users.owner, async (c) => {
        await expect(c.query(`UPDATE crove_kernel.file SET ${set} WHERE id = $1`, [fileId]), set).rejects.toMatchObject({ code: '42501', message: 'FILE_IMMUTABLE' });
      });
      await withAdmin(async (a) => {
        await expect(a.query(`UPDATE crove_kernel.file SET ${set} WHERE id = $1`, [fileId]), `owner: ${set}`).rejects.toMatchObject({ message: 'FILE_IMMUTABLE' });
      });
    }
    // Locking the row (what the commands do before they write) still works.
    await asApp(users.owner, async (c) => {
      const { rowCount } = await c.query('SELECT 1 FROM crove_kernel.file WHERE id = $1 FOR UPDATE', [fileId]);
      expect(rowCount).toBe(1);
    });
  });

  it('lets an image size go from none to set once, only in a system context (#668)', async () => {
    const sha256 = sha256Hex(new TextEncoder().encode(`image-${randomUUID()}`));
    const id = randomUUID();
    await withAdmin((a) =>
      a.query(
        `INSERT INTO crove_kernel.file (org_id, id, sha256, storage_key, generation, filename, content_type, size_bytes, source, created_by)
         VALUES ($1, $2, $3, $4, $5, 'anh.png', 'image/png', 1000, 'social', $6)`,
        [orgA, id, sha256, fileKey(orgA, sha256), `content:${sha256}`, users.owner],
      ),
    );
    // A member's session and the database owner may not set it.
    await asApp(users.owner, async (c) => {
      await expect(c.query('UPDATE crove_kernel.file SET image_width = 10, image_height = 20 WHERE id = $1', [id])).rejects.toMatchObject({ code: '42501', message: 'FILE_IMMUTABLE' });
    });
    await withAdmin(async (a) => {
      await expect(a.query('UPDATE crove_kernel.file SET image_width = 10, image_height = 20 WHERE id = $1', [id])).rejects.toMatchObject({ message: 'FILE_IMMUTABLE' });
    });
    const system = { actor: { type: 'system' as const, component: 'invariant' }, orgId: orgA };
    expect(await workerRuntime.execute('kernel.file.image_size.record', { fileId: id, width: 10, height: 20 }, system)).toEqual({ recorded: true });
    // Once set, it stays: the command leaves it, and no role may change or clear it.
    expect(await workerRuntime.execute('kernel.file.image_size.record', { fileId: id, width: 99, height: 99 }, system)).toEqual({ recorded: false });
    for (const set of ['image_width = 11, image_height = 21', 'image_width = NULL, image_height = NULL']) {
      await withAdmin(async (a) => {
        await expect(a.query(`UPDATE crove_kernel.file SET ${set} WHERE id = $1`, [id]), set).rejects.toMatchObject({ message: 'FILE_IMMUTABLE' });
      });
    }
    const { rows } = await withAdmin((a) => a.query('SELECT image_width, image_height FROM crove_kernel.file WHERE id = $1', [id]));
    expect(rows[0]).toEqual({ image_width: 10, image_height: 20 });
    // A file that is not a Social image gets no size from the command.
    expect(await workerRuntime.execute('kernel.file.image_size.record', { fileId, width: 10, height: 20 }, system)).toEqual({ recorded: false });

    // In a real system context, raw SQL may only set both sizes of a file that has none, and nothing else with them.
    const other = sha256Hex(new TextEncoder().encode(`image-${randomUUID()}`));
    const fresh = randomUUID();
    await withAdmin((a) =>
      a.query(
        `INSERT INTO crove_kernel.file (org_id, id, sha256, storage_key, generation, filename, content_type, size_bytes, source, created_by)
         VALUES ($1, $2, $3, $4, $5, 'anh.png', 'image/png', 1000, 'social', $6)`,
        [orgA, fresh, other, fileKey(orgA, other), `content:${other}`, users.owner],
      ),
    );
    const inSystem = async (text: string) => {
      const c = await workerPool.connect();
      try {
        await c.query('BEGIN');
        await c.query('SELECT crove_kernel.enter_system_context($1::uuid)', [orgA]);
        await c.query(text, [fresh]);
        await c.query('COMMIT');
      } catch (error) {
        await c.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        c.release();
      }
    };
    await expect(inSystem('UPDATE crove_kernel.file SET image_width = 10 WHERE id = $1')).rejects.toBeTruthy();
    await expect(inSystem("UPDATE crove_kernel.file SET image_width = 10, image_height = 20, filename = 'other.png' WHERE id = $1")).rejects.toMatchObject({ message: 'FILE_IMMUTABLE' });
    await expect(inSystem("UPDATE crove_kernel.file SET image_width = 10, image_height = 20, content_type = 'image/jpeg' WHERE id = $1")).rejects.toMatchObject({ message: 'FILE_IMMUTABLE' });
    await inSystem('UPDATE crove_kernel.file SET image_width = 30, image_height = 40 WHERE id = $1');
    await expect(inSystem('UPDATE crove_kernel.file SET image_width = 31, image_height = 41 WHERE id = $1')).rejects.toMatchObject({ message: 'FILE_IMMUTABLE' });
    const { rows: after } = await withAdmin((a) => a.query('SELECT image_width, image_height, filename FROM crove_kernel.file WHERE id = $1', [fresh]));
    expect(after[0]).toEqual({ image_width: 30, image_height: 40, filename: 'anh.png' });
  });

  it('records a retention hold only in a system context, and never clears or shortens one (#1009)', async () => {
    const sha256 = sha256Hex(new TextEncoder().encode(`held-${randomUUID()}`));
    const id = randomUUID();
    await withAdmin((a) =>
      a.query(
        `INSERT INTO crove_kernel.file (org_id, id, sha256, storage_key, generation, filename, content_type, size_bytes, source, created_by)
         VALUES ($1, $2, $3, $4, $5, 'hd.xml', 'application/xml', 10, 'upload', $6)`,
        [orgA, id, sha256, fileKey(orgA, sha256), `content:${sha256}`, users.owner],
      ),
    );
    // A member's session and the database owner may set none of the hold columns.
    for (const set of ["held_until = now() + interval '10 years'", 'hold_attempts = 1', "hold_error = 'x'", 'hold_attempted_at = now()']) {
      await asApp(users.owner, async (c) => {
        await expect(c.query(`UPDATE crove_kernel.file SET ${set} WHERE id = $1`, [id]), set).rejects.toMatchObject({ code: '42501', message: 'FILE_IMMUTABLE' });
      });
      await withAdmin(async (a) => {
        await expect(a.query(`UPDATE crove_kernel.file SET ${set} WHERE id = $1`, [id]), `owner: ${set}`).rejects.toMatchObject({ message: 'FILE_IMMUTABLE' });
      });
    }
    const system = { actor: { type: 'system' as const, component: 'invariant' }, orgId: orgA };
    // The worker records a failure, then the hold; a shorter hold recorded later leaves the longer one.
    await workerRuntime.execute('kernel.file.hold.record', { fileId: id, error: 'BLOB_NOT_FOUND' }, system);
    // A failure is a code: free text (a store message naming the bucket) never reaches a row members can read.
    await expect(workerRuntime.execute('kernel.file.hold.record', { fileId: id, error: 'Access Denied to bucket crove-prod' }, system)).rejects.toMatchObject({ status: 422 });
    const until = '2036-10-20T00:00:00.000Z';
    expect(await workerRuntime.execute('kernel.file.hold.record', { fileId: id, heldUntil: until }, system)).toEqual({ recorded: true, heldUntil: until });
    expect(await workerRuntime.execute('kernel.file.hold.record', { fileId: id, heldUntil: '2030-01-01T00:00:00.000Z' }, system)).toEqual({
      recorded: true,
      heldUntil: until,
    });
    // A member may not call it.
    await expect(runtime.execute('kernel.file.hold.record', { fileId: id, heldUntil: '2040-01-01T00:00:00Z' }, { actor: asUser(users.owner), orgId: orgA })).rejects.toMatchObject({ status: 403 });

    // In a real system context, raw SQL may lengthen the hold, never clear or shorten it, and never touch the reference.
    const inSystem = async (text: string) => {
      const c = await workerPool.connect();
      try {
        await c.query('BEGIN');
        await c.query('SELECT crove_kernel.enter_system_context($1::uuid)', [orgA]);
        await c.query(text, [id]);
        await c.query('COMMIT');
      } catch (error) {
        await c.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        c.release();
      }
    };
    await expect(inSystem('UPDATE crove_kernel.file SET held_until = NULL WHERE id = $1')).rejects.toMatchObject({ message: 'FILE_IMMUTABLE' });
    await expect(inSystem("UPDATE crove_kernel.file SET held_until = held_until - interval '1 second' WHERE id = $1")).rejects.toMatchObject({ message: 'FILE_IMMUTABLE' });
    await expect(inSystem("UPDATE crove_kernel.file SET held_until = held_until + interval '1 day', filename = 'other.xml' WHERE id = $1")).rejects.toMatchObject({
      message: 'FILE_IMMUTABLE',
    });
    await inSystem("UPDATE crove_kernel.file SET held_until = held_until + interval '1 day' WHERE id = $1");
    const { rows } = await withAdmin((a) => a.query('SELECT held_until, hold_attempts, hold_error FROM crove_kernel.file WHERE id = $1', [id]));
    expect(rows[0]).toEqual({ held_until: new Date('2036-10-21T00:00:00.000Z'), hold_attempts: 0, hold_error: null });
  });

  it('creates a grant with the database clock and the creator from the context, whatever the insert says', async () => {
    const other = users.member;
    const row = await asApp(users.owner, async (c) => {
      const { rows } = await c.query<{ created_by: string; used_at: Date | null; window: string }>(
        `INSERT INTO crove_kernel.file_upload (org_id, staging_key, created_by, max_bytes, created_at, expires_at, used_at)
         VALUES ($1, $2, $3, 10, now() - interval '1 day', now() + interval '1 year', now())
         RETURNING created_by, used_at, (expires_at - created_at)::text AS window`,
        [orgA, `staging/${'b'.repeat(64)}`, other],
      );
      return rows[0];
    });
    expect(row).toEqual({ created_by: users.owner, used_at: null, window: '00:05:00' });
    const grant = await begin();
    expect(grant.stagingKey).toMatch(/^staging\/[0-9a-f]{64}$/);
    expect(Date.parse(grant.expiresAt) - Date.now()).toBeLessThanOrEqual(5 * 60 * 1000 + 5000);
    expect(grant.maxBytes).toBe(25 * 1024 * 1024);
  });

  it('uses a grant once: a second claim is refused, also when two race', async () => {
    const { uploadId, stagingKey } = await begin();
    await expect(claim(uploadId)).resolves.toMatchObject({ stagingKey });
    await expect(claim(uploadId)).rejects.toMatchObject({ code: 'UPLOAD_USED', status: 409 });

    const raced = await begin();
    const results = await Promise.allSettled([claim(raced.uploadId), claim(raced.uploadId), claim(raced.uploadId)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected').map((r) => (r as PromiseRejectedResult).reason)).toEqual([
      expect.objectContaining({ code: 'UPLOAD_USED' }),
      expect.objectContaining({ code: 'UPLOAD_USED' }),
    ]);

    // Below the command, the guard trigger refuses a second claim and an un-claim, for the owner too.
    await asApp(users.owner, async (c) => {
      await expect(c.query('UPDATE crove_kernel.file_upload SET used_at = now() WHERE id = $1', [uploadId])).rejects.toMatchObject({ message: 'UPLOAD_USED' });
    });
    await withAdmin(async (a) => {
      await expect(a.query('UPDATE crove_kernel.file_upload SET used_at = NULL WHERE id = $1', [uploadId])).rejects.toMatchObject({ message: 'UPLOAD_USED' });
    });
  });

  it('refuses an expired grant, by the database clock', async () => {
    const { uploadId } = await begin();
    await withAdmin(async (a) => {
      await a.query('BEGIN');
      await a.query('SET LOCAL session_replication_role = replica');
      await a.query("UPDATE crove_kernel.file_upload SET created_at = now() - interval '6 minutes', expires_at = now() - interval '1 minute' WHERE id = $1", [uploadId]);
      await a.query('COMMIT');
    });
    await expect(claim(uploadId)).rejects.toMatchObject({ code: 'UPLOAD_EXPIRED' });
    await asApp(users.owner, async (c) => {
      await expect(c.query('UPDATE crove_kernel.file_upload SET used_at = now() WHERE id = $1', [uploadId])).rejects.toMatchObject({ message: 'UPLOAD_EXPIRED' });
    });
  });

  it("lets only the creator claim a grant; another member's claim reads as missing and changes nothing", async () => {
    const { uploadId } = await begin(users.owner);
    await expect(claim(uploadId, users.member)).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
    // The guard trigger refuses it below the command too.
    const c = await connect(appUrl);
    try {
      await c.query('BEGIN');
      await c.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [orgA, contextToken(users.member, orgA)]);
      await expect(c.query('UPDATE crove_kernel.file_upload SET used_at = now() WHERE id = $1', [uploadId])).rejects.toMatchObject({ message: 'UPLOAD_NOT_YOURS' });
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      await c.end();
    }
    await expect(claim(uploadId)).resolves.toBeTruthy();
  });

  it('refuses viewers and system actors, and never lets a grant change or disappear', async () => {
    await expect(begin(users.viewer)).rejects.toMatchObject({ status: 403 });
    await expect(
      workerRuntime.execute('kernel.file.upload.begin', {}, { actor: { type: 'system', component: 'test' }, orgId: orgA }),
    ).rejects.toMatchObject({ status: 403 });
    const { uploadId } = await begin();
    for (const set of [`staging_key = 'staging/${'c'.repeat(64)}'`, "expires_at = expires_at + interval '1 minute'", 'max_bytes = 2']) {
      await withAdmin(async (a) => {
        await expect(a.query(`UPDATE crove_kernel.file_upload SET ${set} WHERE id = $1`, [uploadId]), set).rejects.toMatchObject({ message: 'UPLOAD_IMMUTABLE' });
      });
    }
    for (const statement of ['UPDATE crove_kernel.file_upload SET max_bytes = 2 WHERE id = $1', 'DELETE FROM crove_kernel.file_upload WHERE id = $1']) {
      await asApp(users.owner, async (c) => {
        await expect(c.query(statement, [uploadId]), statement).rejects.toMatchObject({ code: '42501', message: expect.stringMatching(/permission denied/) });
      });
    }
  });

  it('caps open grants per user', async () => {
    const open = await withAdmin(async (a) =>
      Number(
        (await a.query<{ n: string }>('SELECT count(*) AS n FROM crove_kernel.file_upload WHERE created_by = $1 AND used_at IS NULL AND expires_at > now()', [users.member]))
          .rows[0]?.n,
      ),
    );
    for (let i = open; i < 20; i++) await begin(users.member);
    await expect(begin(users.member)).rejects.toMatchObject({ code: 'RATE_LIMITED', status: 429 });
  });
});
