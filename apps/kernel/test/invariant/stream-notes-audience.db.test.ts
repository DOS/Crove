// Invariant suite (Decision 7): the invalidation hints of to-dos and notes reach only the members who may read the row
// (issue #1753), on a real PostgreSQL 17 with the NOTIFY triggers, one LISTEN connection and the HTTP API. One actor
// of each kind: the author (an owner), a member with the whole org, a viewer, and a member limited to one legal entity.
//   - On the channel a to-do names its owner, a private note its author, and a shared note its author with `+shared`
//     (also the update that makes it private); an org-wide row names nobody.
//   - kernel.stream.check grants sharedNotes to exactly the actors whose context reads another member's shared note
//     under note_read.
//   - The author's stream gets every hint of their to-dos and notes. The whole-org member's stream gets the shared
//     note's, including the update that makes it private, and nothing of the to-do or the private note. The viewer's
//     and the entity-limited member's streams get none of them. Org-wide hints reach all four, as {type, id}.
// Keep this file self-contained: import package code under test, never helpers from outside test/invariant/. Set
// CROVE_TEST_ADMIN_URL to a superuser URL; each run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { kernelCommands, kernelQueries } from '@crove/kernel';
import { LocalDiskStore, Runtime, sha256Hex } from '@crove/kernel-runtime';
import { createAuthenticator } from '../../src/auth.ts';
import { ConcurrencyLimiter } from '../../src/concurrency.ts';
import { loadConfig } from '../../src/config.ts';
import { createHttpApp, type StreamDeps } from '../../src/http.ts';
import { createSessionStatusSource } from '../../src/sessions.ts';
import { StreamHub, createDbTicketStore, createPgNotificationSource } from '../../src/stream.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const SECRET = 'stream-notes-invariant-secret-0123456789-abcdefghij';
const ISSUER = 'http://localhost:9999';
const RECHECK_SECONDS = 1;
// The author owns the org; the others join with these roles. The accountant is then limited to one legal entity.
const ACTORS = ['author', 'member', 'viewer', 'accountant'] as const;
type Actor = (typeof ACTORS)[number];

const suite = ADMIN ? describe : describe.skip;

interface SseEvent {
  event: string;
  data: Record<string, unknown>;
}

suite('invariant: the hints of to-dos and notes reach only the members who may read them', () => {
  const dbName = `crove_test_stream_notes_inv_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let runtime: Runtime;
  let hub: StreamHub;
  let app: ReturnType<typeof createHttpApp>;
  let orgId = '';
  let slug = '';
  let branch = '';
  const accounts = new Map<string, { subject: string; email: string; session: string }>();
  const userIds = new Map<string, string>();

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  async function token(name: string, mfa = false) {
    let who = accounts.get(name);
    if (!who) {
      who = { subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@stream-notes.test`, session: randomUUID() };
      accounts.set(name, who);
    }
    const now = Math.floor(Date.now() / 1000);
    const extra = mfa ? { aal: 'aal2', amr: [{ method: 'totp', timestamp: now }] } : { aal: 'aal1' };
    return new SignJWT({ role: 'authenticated', email: who.email, session_id: who.session, is_anonymous: false, ...extra })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(who.subject)
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(new TextEncoder().encode(SECRET));
  }

  async function rpc(path: string, name: string, input: unknown, org: string | null, mfa = false) {
    const response = await app.request(`/api/rpc/${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await token(name, mfa)}`, 'content-type': 'application/json', ...(org ? { 'x-crove-org': org } : {}) },
      body: JSON.stringify(input === undefined ? {} : { json: input }),
    });
    const body = (await response.json()) as { json?: Record<string, unknown> };
    return { status: response.status, body: (body.json ?? body) as Record<string, unknown> };
  }

  function actorOf(name: Actor) {
    return { type: 'user' as const, userId: userIds.get(name) as string, aal: 'aal1' as const, sessionId: accounts.get(name)?.session as string, mfaAt: null };
  }

  // Opens a stream for `name` in the org and collects its events until it is cancelled.
  async function streamFor(name: Actor) {
    const issued = await app.request('/api/stream/tickets', {
      method: 'POST',
      headers: { authorization: `Bearer ${await token(name)}`, 'x-crove-org': slug },
    });
    expect(issued.status).toBe(200);
    const { ticket } = (await issued.json()) as { ticket: string };
    const response = await app.request(`/api/stream?ticket=${ticket}`, { headers: { 'x-forwarded-for': '198.51.100.1' } });
    expect(response.status).toBe(200);
    const events: SseEvent[] = [];
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    void (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let end: number;
          while ((end = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const lines = block.split('\n');
            const event = lines.find((l) => l.startsWith('event: '))?.slice(7);
            const data = lines.find((l) => l.startsWith('data: '))?.slice(6);
            if (event && data) events.push({ event, data: JSON.parse(data) as Record<string, unknown> });
          }
        }
      } catch {
        // cancelled
      }
    })();
    const waitFor = async (predicate: (events: SseEvent[]) => boolean, ms: number) => {
      const until = Date.now() + ms;
      while (!predicate(events)) {
        if (Date.now() > until) throw new Error(`timed out; events: ${JSON.stringify(events)}`);
        await new Promise((r) => setTimeout(r, 25));
      }
    };
    await waitFor((e) => e.some((x) => x.event === 'ready'), 5_000);
    return { events, waitFor, cancel: () => reader.cancel().catch(() => {}) };
  }

  // A note or a to-do of `name`, written by the database owner (the triggers fire as for the commands that write them).
  async function note(name: Actor, visibility: 'private' | 'org'): Promise<string> {
    return admin(
      async (a) =>
        (
          await a.query<{ id: string }>(`INSERT INTO crove_notes.note (org_id, author_user_id, visibility, title) VALUES ($1, $2, $3, 'Ghi chú') RETURNING id`, [
            orgId,
            userIds.get(name),
            visibility,
          ])
        ).rows[0]?.id as string,
    );
  }

  async function todo(name: Actor): Promise<string> {
    return admin(
      async (a) =>
        (
          await a.query<{ id: string }>(`INSERT INTO crove_notes.todo (org_id, owner_user_id, title, sort_key) VALUES ($1, $2, 'Việc', 'a0') RETURNING id`, [
            orgId,
            userIds.get(name),
          ])
        ).rows[0]?.id as string,
    );
  }

  async function setVisibility(id: string, visibility: 'private' | 'org'): Promise<void> {
    await admin((a) => a.query('UPDATE crove_notes.note SET visibility = $3, revision = revision + 1 WHERE org_id = $1 AND id = $2', [orgId, id, visibility]));
  }

  // A file recorded in the org through execute(): an org-wide row, whose hint reaches every stream.
  async function ingest(): Promise<string> {
    const bytes = new TextEncoder().encode(`stream notes ${randomUUID()}`);
    const sha256 = sha256Hex(bytes);
    const result = await runtime.execute<{ fileId: string }>(
      'kernel.file.ingest',
      {
        filename: 'hd.xml',
        contentType: 'application/xml',
        sizeBytes: bytes.byteLength,
        sha256,
        storageKey: `org/${orgId}/${sha256}`,
        generation: `content:${sha256}`,
        source: 'upload',
      },
      { actor: actorOf('author'), orgId },
    );
    return result.fileId;
  }

  async function join(name: Actor, role: 'member' | 'viewer') {
    await token(name);
    const invited = await rpc('org/invite', 'author', { email: accounts.get(name)?.email, role }, slug, true);
    expect(invited.status).toBe(200);
    const accepted = await rpc('invites/accept', name, { token: String(invited.body.acceptPath).split('#')[1] }, null);
    expect(accepted.status).toBe(200);
    userIds.set(name, String((await rpc('me/get', name, undefined, null)).body.userId));
  }

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
    const appUrl = new URL(adminUrl);
    appUrl.username = 'crove_app';
    appUrl.password = 'test-app-pw';
    pool = createPool({ connectionString: appUrl.toString(), max: 8 });
    const db = createDb(pool);
    const config = loadConfig({
      DATABASE_URL: appUrl.toString(),
      AUTH_JWT_SECRET: SECRET,
      AUTH_ISSUER: ISSUER,
      AUTH_SESSION_CHECK: 'off',
      MIGRATIONS_DIR: MIGRATIONS,
      WEB_DIST: '/nonexistent',
      TRUSTED_PROXY_HOPS: '1',
    });
    runtime = new Runtime(db, { sessions: createSessionStatusSource('off'), stepUp: 'required' }).register({
      commands: [...kernelCommands],
      queries: [...kernelQueries({ inboundDomain: null })],
    });
    hub = new StreamHub(createPgNotificationSource({ connectionString: appUrl.toString() }));
    hub.start();
    const stream: StreamDeps = {
      hub,
      tickets: createDbTicketStore(pool),
      slots: new ConcurrencyLimiter({ total: 50, perKey: 10 }),
      recheckSeconds: RECHECK_SECONDS,
    };
    app = createHttpApp({
      config,
      runtime,
      store: new LocalDiskStore(joinPath(tmpdir(), dbName)),
      authenticate: createAuthenticator(config, db),
      pool,
      aiEnabled: false,
      rateLimiter: null,
      stream,
    });
    const until = Date.now() + 10_000;
    while (!hub.ready) {
      if (Date.now() > until) throw new Error('the stream listener did not start');
      await new Promise((r) => setTimeout(r, 25));
    }

    const created = await rpc('org/create', 'author', { name: `Stream notes ${randomUUID().slice(0, 6)}`, idempotencyKey: randomUUID() }, null);
    expect(created.status).toBe(200);
    slug = String(created.body.slug);
    orgId = String(created.body.orgId);
    userIds.set('author', String((await rpc('me/get', 'author', undefined, null)).body.userId));
    await join('member', 'member');
    await join('viewer', 'viewer');
    // The accountant joins as a member, then keeps the branch's books only (an entity-scoped assignment narrows
    // enter_context's le_scope to that entity).
    await join('accountant', 'member');
    await admin(async (a) => {
      branch = (
        await a.query<{ id: string }>(`INSERT INTO crove_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhánh', 'branch', $2) RETURNING id`, [
          orgId,
          userIds.get('author'),
        ])
      ).rows[0]?.id as string;
      await a.query(`INSERT INTO crove_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by) VALUES ($1, $2, 'external_accountant', $3, $4)`, [
        orgId,
        userIds.get('accountant'),
        branch,
        userIds.get('author'),
      ]);
    });
  }, 120_000);

  afterAll(async () => {
    await hub?.stop();
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('names the owner of a to-do, the author of a note and a shared note on the channel', async () => {
    const listener = new pg.Client({ connectionString: adminUrl });
    await listener.connect();
    const payloads: string[] = [];
    listener.on('notification', (m) => {
      if (m.channel === 'crove_stream' && m.payload) payloads.push(m.payload);
    });
    await listener.query('LISTEN crove_stream');
    try {
      const author = userIds.get('author') as string;
      const task = await todo('author');
      const privateNote = await note('author', 'private');
      const shared = await note('author', 'org');
      await setVisibility(shared, 'private');
      await setVisibility(shared, 'private');
      const file = await ingest();
      const until = Date.now() + 5_000;
      while (!payloads.some((p) => p.includes(file))) {
        if (Date.now() > until) throw new Error(`timed out; payloads: ${JSON.stringify(payloads)}`);
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(payloads.filter((p) => p.includes(task))).toEqual([`${orgId} todo ${task} @${author}`]);
      expect(payloads.filter((p) => p.includes(privateNote))).toEqual([`${orgId} note ${privateNote} @${author}`]);
      // Shared, then made private (still told to those who could read it), then changed while private.
      expect(payloads.filter((p) => p.includes(shared))).toEqual([
        `${orgId} note ${shared} @${author}+shared`,
        `${orgId} note ${shared} @${author}+shared`,
        `${orgId} note ${shared} @${author}`,
      ]);
      expect(payloads.filter((p) => p.includes(file))).toEqual([`${orgId} file ${file}`]);
    } finally {
      await listener.end();
    }
  });

  it("grants sharedNotes to exactly the actors whose context reads another member's shared note", async () => {
    const shared = await note('author', 'org');
    const results: Record<string, { sharedNotes: unknown; reads: boolean }> = {};
    for (const name of ['member', 'viewer', 'accountant'] as const) {
      const check = await runtime.query<{ sharedNotes: unknown }>('kernel.stream.check', {}, { actor: actorOf(name), orgId });
      const c = await pool.connect();
      let reads = false;
      try {
        await c.query('BEGIN');
        await c.query('SELECT crove_kernel.enter_context($1::uuid, $2::uuid)', [userIds.get(name), orgId]);
        reads = (await c.query('SELECT 1 FROM crove_notes.note WHERE org_id = $1 AND id = $2', [orgId, shared])).rowCount === 1;
      } finally {
        await c.query('ROLLBACK');
        c.release();
      }
      results[name] = { sharedNotes: check.sharedNotes, reads };
    }
    expect(results).toEqual({
      member: { sharedNotes: true, reads: true },
      viewer: { sharedNotes: false, reads: false },
      accountant: { sharedNotes: false, reads: false },
    });
  });

  it("gives each actor the hints of exactly the to-dos and notes it may read, and nothing of another's private rows", async () => {
    const streams = Object.fromEntries(await Promise.all(ACTORS.map(async (name) => [name, await streamFor(name)] as const))) as Record<
      Actor,
      Awaited<ReturnType<typeof streamFor>>
    >;
    try {
      const got = (events: SseEvent[], id: string) => events.filter((x) => x.event === 'invalidate' && x.data.id === id).length;
      const task = await todo('author');
      const privateNote = await note('author', 'private');
      const shared = await note('author', 'org');
      // The whole-org member's own to-do: theirs alone, not the author's.
      const memberTask = await todo('member');
      // A stream sends a held hint once, so each update waits until the hint before it went out.
      await streams.author.waitFor((e) => [task, privateNote, shared].every((id) => got(e, id) >= 1), 5_000);
      await streams.member.waitFor((e) => got(e, shared) >= 1, 5_000);
      await setVisibility(shared, 'private');
      await streams.author.waitFor((e) => got(e, shared) >= 2, 5_000);
      await streams.member.waitFor((e) => got(e, shared) >= 2, 5_000);
      await setVisibility(shared, 'private');
      // Written last: once every stream has its hint, every earlier hint has had its chance to arrive.
      const file = await ingest();
      await streams.author.waitFor((e) => got(e, shared) >= 3 && got(e, file) >= 1, 5_000);
      for (const name of ACTORS) await streams[name].waitFor((e) => got(e, file) >= 1, 5_000);
      await streams.member.waitFor((e) => got(e, memberTask) >= 1, 5_000);
      await new Promise((r) => setTimeout(r, 300));

      const counts = Object.fromEntries(
        ACTORS.map((name) => [name, [task, privateNote, shared, memberTask].map((id) => got(streams[name].events, id))]),
      );
      expect(counts).toEqual({
        // [author's to-do, author's private note, shared note (shared, made private, changed while private), member's to-do]
        author: [1, 1, 3, 0],
        member: [0, 0, 2, 1],
        viewer: [0, 0, 0, 0],
        accountant: [0, 0, 0, 0],
      });
      for (const name of ['viewer', 'accountant'] as const) {
        for (const id of [task, privateNote, shared, memberTask]) {
          expect(streams[name].events.some((x) => JSON.stringify(x.data).includes(id))).toBe(false);
        }
      }
      // The routing never reaches a client.
      for (const name of ACTORS) {
        for (const e of streams[name].events.filter((x) => x.event === 'invalidate')) {
          expect(Object.keys(e.data).sort()).toEqual(['id', 'type']);
        }
        expect(streams[name].events.some((x) => x.event === 'resync' || x.event === 'close')).toBe(false);
      }
    } finally {
      for (const name of ACTORS) await streams[name].cancel();
    }
  });
});
