// Inbound address rotation (issue #37, plan §7.6), the product flow: the RPC procedure, idempotent retries and
// mail through the real worker. The security invariants (owner only, EXECUTE matrix, tombstones, forced
// collisions) are in test/invariant/inbound-rotation.db.test.ts. Set CROVE_TEST_ADMIN_URL to a superuser URL;
// each run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ExtractClient } from '@crove/extract-contract';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime, sha256Hex, type BlobStore } from '@crove/kernel-runtime';
import { financeCommands, financeQueries } from '@crove/mod-finance';
import type { AuthUser } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { migrateJobs, startWorker } from '../src/worker.ts';
import { startExtractService } from './extract-service.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const FIXTURE = readFileSync(new URL('../../extract/test/fixtures/einvoice-basic.xml', import.meta.url), 'utf8');
const TOKEN = /^[0-9a-f]{24}$/;
const INBOUND_SECRET = 'test-only-inbound-secret-0123456789abcdef';

class MemoryStore implements BlobStore {
  private readonly blobs = new Map<string, Uint8Array>();
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
  keys(prefix: string) {
    return [...this.blobs.keys()].filter((k) => k.startsWith(prefix));
  }
}

const suite = ADMIN ? describe : describe.skip;

suite('inbound address rotation on PostgreSQL', () => {
  const dbName = `crove_test_rot_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let workerUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let runtime: Runtime;
  let workerPool: pg.Pool;
  let workerDb: Db;
  let workerRuntime: Runtime;
  const store = new MemoryStore();
  // The real crove-extract service on a random port: worker code parses through HTTP and the sandbox.
  let extract: ExtractClient;
  let stopExtract: (() => Promise<void>) | undefined;
  const users = { owner: '', viewer: '' };
  let org = { orgId: '', slug: '' };

  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const asMfa = (userId: string) => ({
    type: 'user' as const,
    userId,
    aal: 'aal2' as const,
    sessionId: '0f6c3a52-8d3b-4c1e-9a77-5b2f0e9d1c00',
    mfaAt: Math.floor(Date.now() / 1000),
  });

  // Members join by accepting an invite (issue #35): the inviter invites the email, the user signed in with it accepts.
  async function join(orgId: string, inviter: string, userId: string, email: string, role: 'admin' | 'member' | 'viewer') {
    const { acceptPath } = await runtime.execute<{ acceptPath: string }>('kernel.member.invite.create', { email, role }, { actor: asMfa(inviter), orgId });
    await runtime.executeOrgless('kernel.member.invite.accept', { token: acceptPath.split('#')[1] }, { actor: asUser(userId) });
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

  const tokenOf = (orgId: string) =>
    withAdmin(async (admin) => {
      const { rows } = await admin.query<{ inbound_token: string }>('SELECT inbound_token FROM crove_kernel.tenant WHERE org_id = $1', [orgId]);
      return rows[0]?.inbound_token ?? '';
    });

  const ledger = (orgId: string) =>
    withAdmin(async (admin) => {
      const { rows } = await admin.query<{ token: string; retired: boolean }>(
        'SELECT token, retired_at IS NOT NULL AS retired FROM crove_kernel.inbound_address WHERE org_id = $1 ORDER BY created_at, id',
        [orgId],
      );
      return rows;
    });

  const rotateAudits = (orgId: string) =>
    withAdmin(async (admin) => {
      const { rows } = await admin.query<{ actor_id: string; outcome: string; detail: Record<string, unknown> }>(
        `SELECT actor_id, outcome, detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.inbound.rotate' ORDER BY occurred_at, id`,
        [orgId],
      );
      return rows;
    });

  const count = (query: string, params: unknown[]) =>
    withAdmin(async (admin) => Number((await admin.query<{ n: string }>(query, params)).rows[0]?.n ?? 0));

  beforeAll(async () => {
    ({ client: extract, stop: stopExtract } = await startExtractService());
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const base = new URL(ADMIN as string);
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
    const register = (target: Db) =>
      new Runtime(target).register({
        commands: [...kernelCommands, ...financeCommands],
        queries: [...kernelQueries({ inboundDomain: 'in.test' }), ...financeQueries],
      });
    pool = createPool({ connectionString: loginUrl('crove_app', 'test-app-pw'), max: 4 });
    db = createDb(pool);
    runtime = register(db);
    workerUrl = loginUrl('crove_worker', 'test-worker-pw');
    workerPool = createPool({ connectionString: workerUrl, max: 4 });
    workerDb = createDb(workerPool);
    workerRuntime = register(workerDb);
    for (const name of Object.keys(users) as Array<keyof typeof users>) {
      users[name] = await upsertIdentity(db, { issuer: 'test', subject: `rot-${name}`, email: `rot-${name}@example.com`, name: null });
    }
    const created = await createOrg(runtime, asUser(users.owner), 'Rotation Org');
    org = { orgId: created.orgId, slug: created.slug };
    await join(org.orgId, users.owner, users.viewer, 'rot-viewer@example.com', 'viewer');
  });

  afterAll(async () => {
    await stopExtract?.();
    await pool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  // The HTTP app as the API runs it; the RPC caller is whoever `caller` names. Rotation is R3 (#113), so the caller
  // has a fresh second factor unless `callerMfa` is false.
  let caller = '';
  let callerMfa = true;
  const SESSION = '5b0c1f2e-3d4a-4b5c-8d6e-7f8091a2b3c4';
  let app: ReturnType<typeof createHttpApp>;
  const httpApp = () =>
    (app ??= createHttpApp({
      config: loadConfig({
        DATABASE_URL: 'postgres://unused@localhost/unused',
        AUTH_JWT_SECRET: 'test-only-jwt-secret-for-rotation-0123456789',
        AUTH_ISSUER: 'test-auth',
        INBOUND_DOMAIN: 'in.test',
        INBOUND_SECRET,
        WEB_DIST: '/nonexistent',
      }),
      runtime,
      store,
      authenticate: async (): Promise<AuthUser> => ({
        userId: caller,
        email: 'rot@example.com',
        name: null,
        aal: callerMfa ? 'aal2' : 'aal1',
        sessionId: SESSION,
        mfaAt: callerMfa ? Math.floor(Date.now() / 1000) : null,
      }),
      pool,
      aiEnabled: false,
    }));
  const rotate = (idempotencyKey: string) =>
    httpApp().request('/api/rpc/org/rotateInbound', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-crove-org': org.slug },
      body: JSON.stringify({ json: { idempotencyKey } }),
    });
  const mime = (token: string, number: string) =>
    [
      'From: Nha cung cap <ketoan@vendor.example>',
      `To: ${token}@in.test`,
      `Subject: Hoa don ${number}`,
      `Message-ID: <rot-${number}@vendor.example>`,
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="b1"',
      '',
      '--b1',
      'Content-Type: application/xml; name="hd.xml"',
      'Content-Disposition: attachment; filename="hd.xml"',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(FIXTURE.replace('<SHDon>1234</SHDon>', `<SHDon>${number}</SHDon>`))
        .toString('base64')
        .replace(/.{76}/g, '$&\r\n'),
      '--b1--',
      '',
    ].join('\r\n');
  const deliver = (token: string, number: string) =>
    httpApp().request('/api/inbound/email', {
      method: 'POST',
      headers: { authorization: `Bearer ${INBOUND_SECRET}`, 'content-type': 'message/rfc822', 'x-crove-recipient': `${token}@in.test` },
      body: mime(token, number),
    });
  const messages = (id: string) => count('SELECT count(*) AS n FROM crove_kernel.inbound_message WHERE message_id LIKE $1', [`%${id}%`]);
  const pending = () => count('SELECT count(*) AS n FROM crove_kernel.inbound_pending', []);
  const emailFiles = () => count(`SELECT count(*) AS n FROM crove_kernel.file WHERE org_id = $1 AND source = 'email'`, [org.orgId]);
  const receiveAudits = () => count(`SELECT count(*) AS n FROM crove_kernel.audit_event WHERE command = 'kernel.inbound.receive'`, []);
  const drops = () =>
    withAdmin(async (admin) => {
      const { rows } = await admin.query<{ org_id: string; token: string; dropped_count: string }>(
        `SELECT d.org_id, a.token, d.dropped_count::text FROM crove_kernel.inbound_drop d
         JOIN crove_kernel.inbound_address a ON a.org_id = d.org_id AND a.id = d.address_id ORDER BY d.first_dropped_at`,
      );
      return rows;
    });
  const droppedCount = async (userId: string) =>
    (await runtime.query<{ inboundDroppedCount: number | null }>('kernel.org.get', {}, { actor: asUser(userId), orgId: org.orgId })).inboundDroppedCount;
  const until = async (check: () => Promise<boolean>) => {
    const deadline = Date.now() + 60_000;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error('timed out waiting for the worker');
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  };
  // Starts the real worker, runs fn, stops it. The job schema is installed once.
  let jobsReady = false;
  async function withWorker(fn: () => Promise<void>) {
    if (!jobsReady) {
      await migrateJobs(adminUrl);
      jobsReady = true;
    }
    const stop = await startWorker({ connectionString: workerUrl, workerDb, runtime: workerRuntime, store, extractor: null, extract, inboundDomain: 'in.test' });
    try {
      await fn();
    } finally {
      await stop();
    }
  }

  it('rotates as owner through the RPC procedure, once per idempotency key, and only the new address receives mail', { timeout: 90_000 }, async () => {
    caller = users.owner;
    const oldToken = await tokenOf(org.orgId);
    const key = randomUUID();
    const first = await rotate(key);
    expect(first.status).toBe(200);
    const { json: result } = (await first.json()) as { json: { inboundAddress: string } };
    const newToken = result.inboundAddress.replace(/@in\.test$/, '');
    expect(result.inboundAddress).toBe(`${newToken}@in.test`);
    expect(newToken).toMatch(TOKEN);
    expect(newToken).not.toBe(oldToken);
    expect(await tokenOf(org.orgId)).toBe(newToken);
    expect(await ledger(org.orgId)).toEqual([
      { token: oldToken, retired: true },
      { token: newToken, retired: false },
    ]);
    expect(await rotateAudits(org.orgId)).toMatchObject([{ actor_id: users.owner, outcome: 'ok', detail: { aal: 'aal2', sessionId: SESSION } }]);
    await expect(runtime.query('kernel.org.get', {}, { actor: asUser(users.owner), orgId: org.orgId })).resolves.toMatchObject({
      inboundAddress: `${newToken}@in.test`,
      inboundDroppedCount: 0,
    });

    // A replayed key returns the same address and rotates nothing, also when the retries race.
    const replays = await Promise.all([rotate(key), rotate(key)]);
    for (const replay of replays) {
      expect(replay.status).toBe(200);
      expect(await replay.json()).toEqual({ json: result });
    }
    expect(await tokenOf(org.orgId)).toBe(newToken);
    expect(await ledger(org.orgId)).toHaveLength(2);
    expect(await rotateAudits(org.orgId)).toHaveLength(1);

    // A viewer calling the procedure is refused.
    caller = users.viewer;
    expect((await rotate(randomUUID())).status).toBe(403);
    expect(await tokenOf(org.orgId)).toBe(newToken);
    // So is the owner without a fresh second factor (R3, #113): the SPA is told to run an MFA challenge.
    caller = users.owner;
    callerMfa = false;
    const noMfa = await rotate(randomUUID());
    expect(noMfa.status).toBe(403);
    expect(JSON.stringify(await noMfa.json())).toContain('STEP_UP_REQUIRED');
    callerMfa = true;
    expect(await tokenOf(org.orgId)).toBe(newToken);

    // Mail to the new address and to the retired one: the API answers 202 to both (no oracle).
    expect((await deliver(oldToken, '7701')).status).toBe(202);
    expect((await deliver(newToken, '7702')).status).toBe(202);
    // A token that never existed gets the same answer.
    expect((await deliver('0123456789abcdef01234567', '7703')).status).toBe(202);

    await withWorker(async () => {
      // The new address files the invoice, and its extraction job turns it into a proposal in the org.
      const emailProposals = () =>
        count(
          `SELECT count(*) AS n FROM crove_kernel.proposal p JOIN crove_kernel.file f ON f.org_id = p.org_id AND f.id = p.source_file_id
           WHERE p.org_id = $1 AND f.source = 'email'`,
          [org.orgId],
        );
      await until(async () => (await emailProposals()) === 1);
      // All three messages are handled: nothing pending, every raw message deleted.
      await until(async () => (await pending()) === 0 && store.keys('inbound/').length === 0);
      expect(await messages('rot-7702@')).toBe(1);
      // The retired address is dropped exactly like the unknown one: no message, no audit, blob deleted.
      expect(await messages('rot-7701@')).toBe(0);
      expect(await messages('rot-7703@')).toBe(0);
      expect(await receiveAudits()).toBe(1);
    });
    // The drop to the retired address is counted for the org (#139), the one to the unknown token nowhere. The owner
    // sees the count with the address; a viewer sees neither.
    expect(await drops()).toEqual([{ org_id: org.orgId, token: oldToken, dropped_count: '1' }]);
    await expect(droppedCount(users.owner)).resolves.toBe(1);
    await expect(droppedCount(users.viewer)).resolves.toBeNull();

    // The worker's resolver itself knows only the active token.
    const resolve = (token: string) =>
      workerDb.transaction().execute(async (trx) => {
        const { rows } = await sql<{ org_id: string | null }>`SELECT crove_kernel.org_by_inbound_token(${token}) AS org_id`.execute(trx);
        return rows[0]?.org_id ?? null;
      });
    expect(await resolve(newToken)).toBe(org.orgId);
    expect(await resolve(newToken.toUpperCase())).toBe(org.orgId);
    expect(await resolve(oldToken)).toBeNull();

    // After a later rotation, replaying the first key rotates nothing and shows the current address, never the
    // retired one stored with the key.
    caller = users.owner;
    const later = await rotate(randomUUID());
    const { json: latest } = (await later.json()) as { json: { inboundAddress: string } };
    expect(latest.inboundAddress).not.toBe(result.inboundAddress);
    const stale = await rotate(key);
    expect(await stale.json()).toEqual({ json: latest });
    expect(await ledger(org.orgId)).toHaveLength(3);
    expect((await rotateAudits(org.orgId)).map((a) => [a.outcome, a.detail.code ?? null])).toEqual([
      ['ok', null],
      ['denied', 'FORBIDDEN'],
      ['denied', 'STEP_UP_REQUIRED'],
      ['ok', null],
    ]);
  });

  it('drops mail queued for a token that is rotated away before the worker processes it', { timeout: 90_000 }, async () => {
    caller = users.owner;
    const token = await tokenOf(org.orgId);
    const filesBefore = await emailFiles();
    const auditsBefore = await receiveAudits();
    // Accepted and queued while the token is still active; no worker runs yet.
    expect((await deliver(token, '7801')).status).toBe(202);
    expect(await pending()).toBe(1);
    expect(store.keys('inbound/')).toHaveLength(1);
    // The org rotates before the message is processed.
    const rotated = await rotate(randomUUID());
    expect(rotated.status).toBe(200);
    expect(await tokenOf(org.orgId)).not.toBe(token);
    // The org is resolved when the worker processes the message, so it is dropped with its blob.
    await withWorker(async () => {
      await until(async () => (await pending()) === 0 && store.keys('inbound/').length === 0);
    });
    expect(await messages('rot-7801@')).toBe(0);
    expect(await emailFiles()).toBe(filesBefore);
    expect(await receiveAudits()).toBe(auditsBefore);
    // Counted against the address it was sent to, which the org retired in between (#139).
    expect((await drops()).find((d) => d.token === token)).toEqual({ org_id: org.orgId, token, dropped_count: '1' });
    await expect(droppedCount(users.owner)).resolves.toBe(2);
  });

});
