// The keyed input hash (issue #1732) on PostgreSQL 17. A command's audit row (append-only, in the owner's export and
// anchored in the WORM stream) and its idempotency row store an HMAC-SHA256 of its canonical input under the
// deployment's hash key, which no runtime role can read, bound to the org of the sealed context, the actor and the
// command. Whoever holds the row and a guess of a private note (ADR-0037) cannot confirm it, as they could with the
// plain SHA-256; the same input hashes differently in two orgs, for two actors and in two deployments; a retry still
// replays, and one against a row claimed before the switch is refused, never run again (#1750); the WORM verifier
// passes over plain and keyed rows alike; the runtime the server builds (createKernel) and a runtime built without
// the option (the default, #1741) write keyed rows; and an agent run and the system hash under their own keys.
// Part of the invariant suite; it imports package code under test, never helpers from outside test/invariant/. Set
// CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { ORG_HEADER } from '@crove/kernel-contract';
import { DomainError, Runtime, defineCommand, type AgentActor, type BlobStore } from '@crove/kernel-runtime';
import { financeCommands, financeQueries } from '@crove/mod-finance';
import { notesCommands, notesQueries } from '@crove/mod-notes';
import { loadConfig } from '../../src/config.ts';
import { createKernel, defaultAdapters, type IdentityPort } from '../../src/kernel.ts';
import { createSessionStatusSource } from '../../src/sessions.ts';
import { LocalArchiveStore, verifyArchive, writeArchive } from '../../src/worm.ts';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';
import { contextToken } from './fixtures/context-token.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const CREATE = 'notes.note.create';
const ORG_CREATE = 'kernel.org.create';
const SYSTEM = { type: 'system' as const, component: 'kernel.agent' };
const COMMENT = 'kernel.task.comment';
const suite = ADMIN ? describe : describe.skip;

// The canonical input the runtime hashes: JSON with object keys sorted and undefined members left out.
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
// A private note's create input as the command parses it (defaults filled in).
const parsedNote = (title: string) => ({ body: '', tags: [], title, visibility: 'private' });

// Files for the server's runtime; the test uploads none.
class MemoryStore implements BlobStore {
  private readonly blobs = new Map<string, Uint8Array>();
  async put(key: string, bytes: Uint8Array) {
    this.blobs.set(key, bytes);
    return `content:${createHash('sha256').update(bytes).digest('hex')}`;
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

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

suite('keyed input hash on PostgreSQL (#1732)', () => {
  const dbName = `crove_test_input_hash_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let workerUrl = '';
  const pools: pg.Pool[] = [];
  let db: Db;
  let worker: Db;
  let keyed: Runtime;
  let keyedWorker: Runtime;
  let byDefault: Runtime;
  let plain: Runtime;
  let dir = '';
  const orgs = { a: '', b: '', c: '' };
  let slugA = '';
  const users = { ownerA: '', member: '', ownerB: '' };
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const asMfa = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal2' as const, sessionId: randomUUID(), mfaAt: Math.floor(Date.now() / 1000) });

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  // HMAC-SHA256 under the deployment's key as it stands, recomputed with the key the admin reads: what
  // crove_kernel.command_input_hash answers, without its 'k1:' prefix.
  async function hmacOf(orgId: string, actorKey: string, command: string, input: string): Promise<string> {
    const key = await admin(async (c) => (await c.query<{ k_ipad: Buffer; k_opad: Buffer }>('SELECT k_ipad, k_opad FROM crove_kernel.mail_hash_key WHERE id = 1')).rows[0]);
    if (!key) throw new Error('no key');
    const message = ['crove.input.v1', orgId, actorKey, command, input].join(String.fromCharCode(31));
    const inner = createHash('sha256').update(key.k_ipad).update(message, 'utf8').digest();
    return createHash('sha256').update(key.k_opad).update(inner).digest('hex');
  }

  // The input hash of the newest audit row of `command` by `userId` in `orgId`.
  const lastHash = (orgId: string, userId: string, command: string, outcome = 'ok') =>
    admin(async (c) =>
      (
        await c.query<{ h: string }>(
          `SELECT input_sha256 AS h FROM crove_kernel.audit_event WHERE org_id = $1 AND actor_id = $2 AND command = $3 AND outcome = $4 ORDER BY id DESC LIMIT 1`,
          [orgId, userId, command, outcome],
        )
      ).rows[0]?.h,
    );

  const refusalCode = (p: Promise<unknown>) => p.then(() => null, (e: { code?: string }) => e.code ?? 'none');

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
    const login = (username: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = username;
      url.password = password;
      return url.toString();
    };
    appUrl = login('crove_app', 'test-app-pw');
    workerUrl = login('crove_worker', 'test-worker-pw');
    const appPool = createPool({ connectionString: appUrl, max: 4 });
    const workerPool = createPool({ connectionString: workerUrl, max: 2 });
    pools.push(appPool, workerPool);
    db = createDb(appPool);
    worker = createDb(workerPool);
    // A nested command that is refused, and one that runs it under ctx.tryRun and goes on (#429).
    const zThing = z.object({ id: z.string().uuid() });
    const refused = defineCommand({
      sideEffect: 'none',
      name: 'test.refused',
      input: zThing,
      risk: 'R1',
      access: ['owner'],
      target: (input: { id: string }) => ({ type: 'test.thing', id: input.id }),
      handler: async () => {
        throw new DomainError('NOT_FOUND', 404, 'x');
      },
    });
    const tries = defineCommand({
      sideEffect: 'none',
      name: 'test.tries',
      input: zThing,
      risk: 'R1',
      access: ['owner'],
      handler: async (ctx, input) => (await ctx.tryRun('test.refused', input, { recover: () => true })).status,
    });
    const defs = {
      commands: [...kernelCommands, ...financeCommands, ...notesCommands, refused, tries],
      queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries, ...notesQueries],
    };
    keyed = new Runtime(db, { manifests: TEST_MANIFESTS, inputHash: 'keyed' }).register(defs);
    // System and agent actors run as the worker role, which alone enters their contexts.
    keyedWorker = new Runtime(worker, { manifests: TEST_MANIFESTS, inputHash: 'keyed' }).register(defs);
    // Said explicitly: the plain SHA-256 a runtime wrote before #1732, whatever the default (#1741).
    plain = new Runtime(db, { manifests: TEST_MANIFESTS, inputHash: 'sha256' }).register(defs);
    byDefault = new Runtime(db, { manifests: TEST_MANIFESTS }).register(defs);

    const tag = randomUUID().slice(0, 8);
    const person = (name: string) => upsertIdentity(db, { issuer: 'test', subject: `${name}-${tag}`, email: `${name}-${tag}@example.com`, name: null });
    users.ownerA = await person('owner-a');
    users.ownerB = await person('owner-b');
    users.member = await person('member');
    ({ orgId: orgs.a, slug: slugA } = await createOrg(keyed, asUser(users.ownerA), `Input hash A ${tag}`));
    orgs.b = (await createOrg(keyed, asUser(users.ownerB), `Input hash B ${tag}`)).orgId;
    orgs.c = (await createOrg(keyed, asUser(users.ownerA), `Input hash C ${tag}`)).orgId;
    const { acceptPath } = await keyed.execute<{ acceptPath: string }>(
      'kernel.member.invite.create',
      { email: `member-${tag}@example.com`, role: 'member' },
      { actor: asMfa(users.ownerA), orgId: orgs.a },
    );
    await keyed.executeOrgless('kernel.member.invite.accept', { token: acceptPath.split('#')[1] }, { actor: asUser(users.member) });
    dir = mkdtempSync(join(tmpdir(), 'crove-input-hash-'));
  }, 180_000);

  afterAll(async () => {
    for (const pool of pools) await pool.end();
    if (dir) rmSync(dir, { recursive: true, force: true });
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('confirms a guessed private note from the plain hash, and none from the keyed one without the key', async () => {
    const secret = 'PIN 4821';
    const guesses = Array.from({ length: 10_000 }, (_, i) => `PIN ${String(i).padStart(4, '0')}`);
    // Before #1732 (a runtime in 'sha256' mode): hashing every guess finds the note.
    await plain.execute(CREATE, { title: secret }, { actor: asUser(users.ownerA), orgId: orgs.a });
    const plainHash = await lastHash(orgs.a, users.ownerA, CREATE);
    expect(guesses.filter((g) => sha256(canonical(parsedNote(g))) === plainHash)).toEqual([secret]);

    // Keyed: the row holds 'k1:' and an HMAC no guess's hash matches, with or without the prefix.
    await keyed.execute(CREATE, { title: secret }, { actor: asUser(users.ownerA), orgId: orgs.a });
    const keyedHash = (await lastHash(orgs.a, users.ownerA, CREATE)) ?? '';
    expect(keyedHash).toMatch(/^k1:[0-9a-f]{64}$/);
    const hex = keyedHash.slice(3);
    expect(guesses.filter((g) => [sha256(canonical(parsedNote(g))), sha256(JSON.stringify({ title: g }))].includes(hex))).toEqual([]);
    expect(hex).not.toBe(plainHash);
    // With the key, it is the HMAC of the domain label, the org, the actor key, the command and the canonical input.
    expect(hex).toBe(await hmacOf(orgs.a, `user:${users.ownerA}`, CREATE, canonical(parsedNote(secret))));
  });

  it('hashes one input differently in two orgs, for two actors and under another deployment key, and alike for one actor', async () => {
    const input = { title: 'Mã két sắt 2580' };
    const run = async (userId: string, orgId: string) => {
      await keyed.execute(CREATE, input, { actor: asUser(userId), orgId });
      return lastHash(orgId, userId, CREATE);
    };
    const first = await run(users.ownerA, orgs.a);
    expect(await run(users.ownerA, orgs.a)).toBe(first);
    // The same actor in another org, another actor in the same org, another actor in another org.
    const sameActorOtherOrg = await run(users.ownerA, orgs.c);
    const otherActor = await run(users.member, orgs.a);
    const otherOrg = await run(users.ownerB, orgs.b);
    expect(new Set([first, sameActorOtherOrg, otherActor, otherOrg]).size).toBe(4);

    // Another deployment: the same org, actor and input under a different key. The key is put back afterwards.
    const saved = await admin(async (c) => (await c.query<{ k_ipad: Buffer; k_opad: Buffer }>('SELECT k_ipad, k_opad FROM crove_kernel.mail_hash_key')).rows[0]);
    const key = Buffer.concat([randomBytes(32), Buffer.alloc(32)]);
    const pad = (byte: number) => Buffer.from(key.map((b) => b ^ byte));
    await admin((c) => c.query('UPDATE crove_kernel.mail_hash_key SET k_ipad = $1, k_opad = $2 WHERE id = 1', [pad(0x36), pad(0x5c)]));
    let otherDeployment: string | undefined;
    try {
      otherDeployment = await run(users.ownerA, orgs.a);
    } finally {
      await admin((c) => c.query('UPDATE crove_kernel.mail_hash_key SET k_ipad = $1, k_opad = $2 WHERE id = 1', [saved?.k_ipad, saved?.k_opad]));
    }
    expect(otherDeployment).toMatch(/^k1:[0-9a-f]{64}$/);
    expect(otherDeployment).not.toBe(first);
    expect(await run(users.ownerA, orgs.a)).toBe(first);
  });

  it('keys the hash of a refused command the same way', async () => {
    const input = { noteId: randomUUID(), revision: 1, title: 'Lương tháng 10', body: '', tags: [] };
    expect(await refusalCode(keyed.execute('notes.note.update', input, { actor: asUser(users.member), orgId: orgs.a }))).toBe('NOTE_NOT_FOUND');
    const hash = await lastHash(orgs.a, users.member, 'notes.note.update', 'failed');
    expect(hash).toBe(`k1:${await hmacOf(orgs.a, `user:${users.member}`, 'notes.note.update', canonical(input))}`);

    // A refusal caught by ctx.tryRun: its row is written in the calling command's transaction, keyed alike.
    const id = randomUUID();
    expect(await keyed.execute('test.tries', { id }, { actor: asUser(users.ownerA), orgId: orgs.a })).toBe('refused');
    const nested = await lastHash(orgs.a, users.ownerA, 'test.refused', 'failed');
    expect(nested).toBe(`k1:${await hmacOf(orgs.a, `user:${users.ownerA}`, 'test.refused', canonical({ id }))}`);
  });

  it('keeps idempotency: a retry replays, another input is refused, and a row claimed with the plain hash never runs again', async () => {
    const actor = asUser(users.ownerA);
    const key = randomUUID();
    const title = `Ghi chú ${randomUUID().slice(0, 8)}`;
    const first = await keyed.execute<{ noteId: string }>(CREATE, { title }, { actor, orgId: orgs.a, idempotencyKey: key });
    expect(await keyed.execute(CREATE, { title }, { actor, orgId: orgs.a, idempotencyKey: key })).toEqual(first);
    expect(await refusalCode(keyed.execute(CREATE, { title: `${title} khác` }, { actor, orgId: orgs.a, idempotencyKey: key }))).toBe('IDEMPOTENCY_MISMATCH');
    const stored = await admin(async (c) => {
      const notes = (await c.query<{ n: number }>('SELECT count(*)::int AS n FROM crove_notes.note WHERE org_id = $1 AND title = $2', [orgs.a, title])).rows[0]?.n;
      const request = (await c.query<{ h: string }>('SELECT request_sha256 AS h FROM crove_kernel.idempotency_key WHERE org_id = $1 AND key = $2', [orgs.a, key])).rows[0]?.h;
      return { notes, request };
    });
    expect(stored.notes).toBe(1);
    expect(stored.request).toBe(`k1:${await hmacOf(orgs.a, `user:${users.ownerA}`, CREATE, canonical(parsedNote(title)))}`);

    // A key claimed before the switch holds the plain SHA-256 of the same input: it matches no keyed hash, so the retry
    // is refused as another request (#1750) and the command never runs again.
    const legacy = randomUUID();
    const legacyTitle = `cũ ${randomUUID().slice(0, 8)}`;
    await admin((c) =>
      c.query(
        `INSERT INTO crove_kernel.idempotency_key (org_id, actor_key, key, command, request_sha256, response) VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
        [orgs.a, `user:${users.ownerA}`, legacy, CREATE, sha256(canonical(parsedNote(legacyTitle))), JSON.stringify({ value: { noteId: 'legacy', revision: 1 } })],
      ),
    );
    expect(await refusalCode(keyed.execute(CREATE, { title: legacyTitle }, { actor, orgId: orgs.a, idempotencyKey: legacy }))).toBe('IDEMPOTENCY_MISMATCH');
    expect(await refusalCode(keyed.execute(CREATE, { title: 'mới' }, { actor, orgId: orgs.a, idempotencyKey: legacy }))).toBe('IDEMPOTENCY_MISMATCH');
    const reran = await admin(async (c) => (await c.query<{ n: number }>('SELECT count(*)::int AS n FROM crove_notes.note WHERE org_id = $1 AND title = $2', [orgs.a, legacyTitle])).rows[0]?.n);
    expect(reran).toBe(0);
    // A keyed row never matches the plain hash: a stored 'k1:' value is compared with the keyed hash only.
    const forged = randomUUID();
    await admin((c) =>
      c.query(
        `INSERT INTO crove_kernel.idempotency_key (org_id, actor_key, key, command, request_sha256, response) VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
        [orgs.a, `user:${users.ownerA}`, forged, CREATE, `k1:${sha256(canonical(parsedNote('cũ')))}`, JSON.stringify({ value: { noteId: 'forged', revision: 1 } })],
      ),
    );
    expect(await refusalCode(keyed.execute(CREATE, { title: 'cũ' }, { actor, orgId: orgs.a, idempotencyKey: forged }))).toBe('IDEMPOTENCY_MISMATCH');
  });

  it('replays an org-less command: the org the definer replays is the one its keyed row was claimed in', async () => {
    const key = randomUUID();
    const name = `Input hash replay ${randomUUID().slice(0, 8)}`;
    const first = await createOrg(keyed, asUser(users.ownerB), name, key);
    expect(await createOrg(keyed, asUser(users.ownerB), name, key)).toEqual(first);
    const request = await admin(
      async (c) => (await c.query<{ h: string }>('SELECT request_sha256 AS h FROM crove_kernel.idempotency_key WHERE org_id = $1 AND key = $2', [first.orgId, key])).rows[0]?.h,
    );
    expect(request).toBe(`k1:${await hmacOf(first.orgId, `user:${users.ownerB}`, ORG_CREATE, canonical({ name }))}`);
    expect(await lastHash(first.orgId, users.ownerB, ORG_CREATE)).toBe(request);
  });

  it('hashes only for the org of the sealed context, in a definer no one else may call, under a key no login reads', async () => {
    const app = new pg.Client({ connectionString: appUrl });
    await app.connect();
    try {
      await expect(app.query(`SELECT crove_kernel.command_input_hash('user:x', 'c', '{}')`)).rejects.toThrow(/NO_CONTEXT/);
      await expect(app.query('SELECT * FROM crove_kernel.mail_hash_key')).rejects.toThrow(/permission denied/);
      await app.query('BEGIN');
      await app.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [orgs.a, contextToken(users.ownerA, orgs.a)]);
      const own = `user:${users.ownerA}`;
      const { rows } = await app.query<{ h: string }>('SELECT crove_kernel.command_input_hash($1, $2, $3) AS h', [own, 'c', '{}']);
      expect(rows[0]?.h).toBe(`k1:${await hmacOf(orgs.a, own, 'c', '{}')}`);
      const refusal = async (actorKey: string, command = 'c') => {
        await app.query('SAVEPOINT s');
        const outcome = await app.query('SELECT crove_kernel.command_input_hash($1, $2, $3)', [actorKey, command, '{}']).then(
          () => 'hashed',
          (e: { message: string }) => e.message,
        );
        await app.query('ROLLBACK TO SAVEPOINT s');
        return outcome;
      };
      // Another member's key (the member could then hash guesses and compare them with that member's audit rows),
      // an agent's or the system's key: refused in a user context.
      expect(await refusal(`user:${users.member}`)).toBe('INPUT_HASH_ACTOR');
      expect(await refusal(`agent:${randomUUID()}:${randomUUID()}`)).toBe('INPUT_HASH_ACTOR');
      expect(await refusal('system:kernel.agent')).toBe('INPUT_HASH_ACTOR');
      // A separator in the actor key or the command could make two triples one message: refused.
      expect(await refusal(`${own}${String.fromCharCode(31)}c`, 'd')).toBe('INPUT_HASH_ARGUMENT');
      await app.query('ROLLBACK');
    } finally {
      await app.end();
    }
    // The system context (the worker's alone) hashes for a system component only.
    const worker = new pg.Client({ connectionString: workerUrl });
    await worker.connect();
    try {
      await worker.query('BEGIN');
      await worker.query('SELECT crove_kernel.enter_system_context($1::uuid)', [orgs.a]);
      const { rows } = await worker.query<{ h: string }>(`SELECT crove_kernel.command_input_hash('system:kernel.agent', 'c', '{}') AS h`);
      expect(rows[0]?.h).toBe(`k1:${await hmacOf(orgs.a, 'system:kernel.agent', 'c', '{}')}`);
      await expect(worker.query('SELECT crove_kernel.command_input_hash($1, $2, $3)', [`user:${users.ownerA}`, 'c', '{}'])).rejects.toThrow(/INPUT_HASH_ACTOR/);
      await worker.query('ROLLBACK');
    } finally {
      await worker.end();
    }
    const fn = await admin(async (c) =>
      (
        await c.query<{ args: string; definer: boolean; config: string[]; public_grant: boolean; tenant: boolean }>(
          `SELECT pg_get_function_identity_arguments(p.oid) AS args, p.prosecdef AS definer, p.proconfig AS config,
                  EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0) AS public_grant,
                  has_function_privilege('crove_tenant', p.oid, 'EXECUTE') AS tenant
           FROM pg_proc p WHERE p.oid = 'crove_kernel.command_input_hash(text,text,text)'::regprocedure`,
        )
      ).rows[0],
    );
    // No org argument: the org is the sealed context's.
    expect(fn).toEqual({ args: 'p_actor_key text, p_command text, p_input text', definer: true, config: ['search_path=pg_catalog, pg_temp'], public_grant: false, tenant: true });
  });

  it('writes keyed hashes from a runtime built without the option: keyed is the default (#1741)', async () => {
    const actor = asUser(users.ownerA);
    const title = `Mặc định ${randomUUID().slice(0, 8)}`;
    const key = randomUUID();
    await byDefault.execute(CREATE, { title }, { actor, orgId: orgs.a, idempotencyKey: key });
    const expected = `k1:${await hmacOf(orgs.a, `user:${users.ownerA}`, CREATE, canonical(parsedNote(title)))}`;
    expect(await lastHash(orgs.a, users.ownerA, CREATE)).toBe(expected);
    const request = await admin(
      async (c) => (await c.query<{ h: string }>('SELECT request_sha256 AS h FROM crove_kernel.idempotency_key WHERE org_id = $1 AND key = $2', [orgs.a, key])).rows[0]?.h,
    );
    expect(request).toBe(expected);
  });

  it('writes keyed hashes from the runtime the server builds (createKernel)', { timeout: 60_000 }, async () => {
    // The API role as main.ts starts it, with a fixed user for the one header this test sends. A server whose runtime
    // asks for 'sha256' (apps/kernel/src/kernel.ts) writes the plain SHA-256, and this fails.
    const port = await freePort();
    const config = loadConfig({
      DATABASE_URL: appUrl,
      AUTH_JWT_SECRET: 'test-only-jwt-secret-for-input-hash-0123',
      AUTH_ISSUER: 'test-auth',
      WEB_DIST: '/nonexistent',
      HOST: '127.0.0.1',
      PORT: String(port),
      STREAM_MAX_CONNECTIONS: '0',
    });
    const identity: IdentityPort = {
      // The real 'off' check (Crove's own session records), as an API on a local URL runs it: #1822 step 2 requires the
      // session a context token names to be recorded, which a check that does nothing would not.
      sessions: createSessionStatusSource('off'),
      revoker: null,
      authenticator: () => async () => ({ userId: users.ownerA, email: 'owner-a@example.com', name: null, aal: 'aal1', sessionId: randomUUID(), mfaAt: null }),
    };
    const kernel = createKernel(config, { ...defaultAdapters(config), identity, ai: null, storage: new MemoryStore() });
    const stop = await kernel.start('api');
    try {
      const title = `Mã cửa ${randomUUID().slice(0, 8)}`;
      const response = await fetch(`http://127.0.0.1:${port}/api/rpc/notes/create`, {
        method: 'POST',
        headers: { authorization: 'Bearer test', 'content-type': 'application/json', [ORG_HEADER]: slugA },
        body: JSON.stringify({ json: { title } }),
      });
      expect(response.status).toBe(200);
      expect(await lastHash(orgs.a, users.ownerA, CREATE)).toBe(`k1:${await hmacOf(orgs.a, `user:${users.ownerA}`, CREATE, canonical(parsedNote(title)))}`);
    } finally {
      await stop();
    }
  });

  it('keys the rows of a live agent run and of the system under their own actor keys, in the contexts of the worker role', async () => {
    const { agentId, positionId } = await keyed.execute<{ agentId: string; positionId: string }>(
      'kernel.agent.template.install',
      { templateKey: 'finance.chief_accountant', reportsTo: null },
      { actor: asMfa(users.ownerA), orgId: orgs.a },
    );
    const { taskId } = await keyed.execute<{ taskId: string }>('kernel.task.create', { title: 'Đối chiếu sao kê', assigneePositionId: positionId }, { actor: asUser(users.ownerA), orgId: orgs.a });
    // The system starts the run (system context): its row is keyed under the system component's key.
    const { runId } = await keyedWorker.execute<{ runId: string | null }>('kernel.agent.run.start', { agentId }, { actor: SYSTEM, orgId: orgs.a });
    if (!runId) throw new Error('no run');
    const system = await admin(
      async (c) =>
        (
          await c.query<{ h: string }>(
            `SELECT input_sha256 AS h FROM crove_kernel.audit_event WHERE org_id = $1 AND actor_type = 'system' AND command = 'kernel.agent.run.start' AND outcome = 'ok' AND target_id = $2 ORDER BY id DESC LIMIT 1`,
            [orgs.a, agentId],
          )
        ).rows[0]?.h,
    );
    expect(system).toBe(`k1:${await hmacOf(orgs.a, 'system:kernel.agent', 'kernel.agent.run.start', canonical({ agentId }))}`);

    // The agent (agent context): an ok row and its idempotency row under agent:<agent>:<run>, a retry that replays,
    // and a refused command keyed alike.
    const actor: AgentActor = { type: 'agent', agentId, runId };
    const agentKey = `agent:${agentId}:${runId}`;
    const { fence } = await keyedWorker.execute<{ fence: string }>('kernel.task.checkout', { id: taskId }, { actor, orgId: orgs.a });
    const key = randomUUID();
    const comment = { id: taskId, fence, body: 'Số tài khoản 0123 4567' };
    const first = await keyedWorker.execute(COMMENT, comment, { actor, orgId: orgs.a, idempotencyKey: key });
    expect(await keyedWorker.execute(COMMENT, comment, { actor, orgId: orgs.a, idempotencyKey: key })).toEqual(first);
    expect(await refusalCode(keyedWorker.execute(COMMENT, { ...comment, body: 'Số tài khoản khác' }, { actor, orgId: orgs.a, idempotencyKey: key }))).toBe('IDEMPOTENCY_MISMATCH');
    const expected = `k1:${await hmacOf(orgs.a, agentKey, COMMENT, canonical(comment))}`;
    expect(await lastHash(orgs.a, agentId, COMMENT)).toBe(expected);
    const request = await admin(
      async (c) =>
        (await c.query<{ h: string }>('SELECT request_sha256 AS h FROM crove_kernel.idempotency_key WHERE org_id = $1 AND actor_key = $2 AND key = $3', [orgs.a, agentKey, key])).rows[0]?.h,
    );
    expect(request).toBe(expected);
    const selfAssigned = { title: 'Tự giao việc', assigneePositionId: null };
    expect(await refusalCode(keyedWorker.execute('kernel.task.create', selfAssigned, { actor, orgId: orgs.a }))).toBe('FORBIDDEN');
    expect(await lastHash(orgs.a, agentId, 'kernel.task.create', 'denied')).toBe(`k1:${await hmacOf(orgs.a, agentKey, 'kernel.task.create', canonical(selfAssigned))}`);
  });

  it('anchors plain and keyed rows in the WORM stream, and the verifier passes over both', async () => {
    // One row of each scheme, whatever ran before.
    await plain.execute(CREATE, { title: 'Hàng cũ' }, { actor: asUser(users.ownerA), orgId: orgs.a });
    await keyed.execute(CREATE, { title: 'Hàng mới' }, { actor: asUser(users.ownerA), orgId: orgs.a });
    const hashes = await admin(async (c) => (await c.query<{ keyed: boolean; n: number }>(`SELECT starts_with(input_sha256, 'k1:') AS keyed, count(*)::int AS n FROM crove_kernel.audit_event GROUP BY 1`)).rows);
    expect(hashes.find((h) => h.keyed)?.n).toBeGreaterThan(0);
    expect(hashes.find((h) => !h.keyed)?.n).toBeGreaterThan(0);
    // Everything written so far moves an hour back, past the archiver's lag (setup only, with triggers off).
    await admin(async (c) => {
      await c.query('SET session_replication_role = replica');
      await c.query(`UPDATE crove_kernel.audit_event SET occurred_at = occurred_at - interval '1 hour'`);
      await c.query(`UPDATE crove_finance.journal_entry SET created_at = created_at - interval '1 hour'`);
    });
    const store = new LocalArchiveStore(dir);
    expect(await writeArchive(worker, store, { lagSeconds: 600 })).toBeGreaterThan(0);
    const total = await admin(async (c) => Number((await c.query('SELECT count(*) AS n FROM crove_kernel.audit_event')).rows[0].n));
    const result = await verifyArchive(worker, store);
    expect(result.ok).toBe(true);
    expect(result.problems).toEqual([]);
    expect(result.rows).toBeGreaterThanOrEqual(total);
  });
});
