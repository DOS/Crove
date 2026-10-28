// Invariant suite (Decision 7): a notification's invalidation hint reaches only its recipient's streams (issue #1702),
// on a real PostgreSQL 17 with the NOTIFY triggers, one LISTEN connection and the HTTP API.
//   - The hint of a crove_kernel.notification row names its recipient last on the channel,
//     `<org> notification <id> <legal_entity_id> @<user_id>`; other hints name nobody.
//   - Member B's stream gets no hint about member A's notification, when it arrives or when A reads it, and A's stream
//     gets it; org-wide hints still reach both. The recipient is never sent to a client: an `invalidate` is {type, id}.
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
const SECRET = 'stream-recipient-invariant-secret-0123456789-abcdefghij';
const ISSUER = 'http://localhost:9999';
const RECHECK_SECONDS = 1;

const suite = ADMIN ? describe : describe.skip;

interface SseEvent {
  event: string;
  data: Record<string, unknown>;
}

suite("invariant: a notification's hint reaches only its recipient", () => {
  const dbName = `crove_test_stream_rcpt_inv_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let runtime: Runtime;
  let hub: StreamHub;
  let app: ReturnType<typeof createHttpApp>;
  let orgId = '';
  let slug = '';
  let entity = '';
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
      who = { subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@stream-rcpt.test`, session: randomUUID() };
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

  // Opens a stream for `name` in the org and collects its events until it is cancelled.
  async function streamFor(name: string) {
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

  // A notification for `name`, written by the database owner (the triggers fire as for the system context that writes
  // them in the product).
  async function notify(name: string): Promise<string> {
    return admin(
      async (a) =>
        (
          await a.query<{ id: string }>(
            `INSERT INTO crove_kernel.notification (org_id, user_id, kind, dedupe_key, legal_entity_id) VALUES ($1, $2, 'kernel.approval_waiting', $3, $4) RETURNING id`,
            [orgId, userIds.get(name), `stream-rcpt:${randomUUID()}`, entity],
          )
        ).rows[0]?.id as string,
    );
  }

  async function markRead(id: string): Promise<void> {
    await admin((a) => a.query('UPDATE crove_kernel.notification SET read_at = now() WHERE org_id = $1 AND id = $2', [orgId, id]));
  }

  // A file recorded in the org through execute(): an org-wide row, whose hint reaches every stream.
  async function ingest(): Promise<string> {
    const bytes = new TextEncoder().encode(`stream rcpt ${randomUUID()}`);
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
      { actor: { type: 'user', userId: userIds.get('alice') as string, aal: 'aal1', sessionId: accounts.get('alice')?.session as string, mfaAt: null }, orgId },
    );
    return result.fileId;
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
    pool = createPool({ connectionString: appUrl.toString(), max: 6 });
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

    // Alice owns the org; Bob joins as a member with the same whole-org scope, so only the recipient tells them apart.
    const created = await rpc('org/create', 'alice', { name: `Stream rcpt ${randomUUID().slice(0, 6)}`, idempotencyKey: randomUUID() }, null);
    expect(created.status).toBe(200);
    slug = String(created.body.slug);
    orgId = String(created.body.orgId);
    userIds.set('alice', String((await rpc('me/get', 'alice', undefined, null)).body.userId));
    await token('bob');
    const invited = await rpc('org/invite', 'alice', { email: accounts.get('bob')?.email, role: 'member' }, slug, true);
    expect(invited.status).toBe(200);
    const accepted = await rpc('invites/accept', 'bob', { token: String(invited.body.acceptPath).split('#')[1] }, null);
    expect(accepted.status).toBe(200);
    userIds.set('bob', String((await rpc('me/get', 'bob', undefined, null)).body.userId));
    entity = await admin(
      async (a) => (await a.query<{ id: string }>('SELECT id FROM crove_kernel.legal_entity WHERE org_id = $1 AND is_default', [orgId])).rows[0]?.id as string,
    );
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

  it('names the recipient last on the channel for a notification, and nobody for an org-wide row', async () => {
    const listener = new pg.Client({ connectionString: adminUrl });
    await listener.connect();
    const payloads: string[] = [];
    listener.on('notification', (m) => {
      if (m.channel === 'crove_stream' && m.payload) payloads.push(m.payload);
    });
    await listener.query('LISTEN crove_stream');
    try {
      const forAlice = await notify('alice');
      await markRead(forAlice);
      const file = await ingest();
      const until = Date.now() + 5_000;
      while (!(payloads.filter((p) => p.includes(forAlice)).length >= 2 && payloads.some((p) => p.includes(file)))) {
        if (Date.now() > until) throw new Error(`timed out; payloads: ${JSON.stringify(payloads)}`);
        await new Promise((r) => setTimeout(r, 25));
      }
      const expected = `${orgId} notification ${forAlice} ${entity} @${userIds.get('alice')}`;
      expect(payloads.filter((p) => p.includes(forAlice))).toEqual([expected, expected]);
      expect(payloads.filter((p) => p.includes(file))).toEqual([`${orgId} file ${file}`]);
    } finally {
      await listener.end();
    }
  });

  it("gives member B no hint about member A's notification, as it arrives or is read, and A every one", async () => {
    const alice = await streamFor('alice');
    const bob = await streamFor('bob');
    try {
      const got = (events: SseEvent[], id: string) => events.filter((x) => x.event === 'invalidate' && x.data.id === id).length;
      const forAlice = await notify('alice');
      const forBob = await notify('bob');
      // A stream sends a held hint once, so the read waits until the arrival's hint went out.
      await alice.waitFor((e) => got(e, forAlice) >= 1, 5_000);
      await markRead(forAlice);
      // Written last: once both streams have its hint, every earlier hint has had its chance to arrive.
      const file = await ingest();
      await alice.waitFor((e) => got(e, forAlice) >= 2 && got(e, file) >= 1, 5_000);
      await bob.waitFor((e) => got(e, forBob) >= 1 && got(e, file) >= 1, 5_000);
      await new Promise((r) => setTimeout(r, 300));
      // The arrival and the read of Alice's notification each reached her stream, and neither reached Bob's.
      expect(got(alice.events, forAlice)).toBe(2);
      expect(bob.events.some((x) => JSON.stringify(x.data).includes(forAlice))).toBe(false);
      expect(alice.events.some((x) => JSON.stringify(x.data).includes(forBob))).toBe(false);
      expect(got(bob.events, forBob)).toBe(1);
      // The recipient and the entity never reach a client.
      expect(bob.events.find((x) => x.data.id === forBob)?.data).toEqual({ type: 'notification', id: forBob });
      for (const e of [...alice.events, ...bob.events].filter((x) => x.event === 'invalidate')) {
        expect(Object.keys(e.data).sort()).toEqual(['id', 'type']);
      }
      expect([...alice.events, ...bob.events].some((x) => x.event === 'resync' || x.event === 'close')).toBe(false);
    } finally {
      await alice.cancel();
      await bob.cancel();
    }
  });
});
