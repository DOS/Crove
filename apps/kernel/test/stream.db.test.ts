// The invalidation stream (issue #69) through the HTTP API against a real PostgreSQL 17: the NOTIFY triggers, one
// LISTEN connection and tickets. The security rules (org isolation, single-use tickets, closing on removal and revoke,
// the EXECUTE matrix, the redeem cap) are in test/invariant/stream.db.test.ts (#281); this file keeps the product
// flows: rolled-back writes send nothing, the per-user caps, the ticket outcomes, and the listener's self-probe.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run creates and drops its database.
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
import { financeCommands, financeQueries } from '@crove/mod-finance';
import { createAuthenticator } from '../src/auth.ts';
import { ConcurrencyLimiter } from '../src/concurrency.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp, type HttpDeps, type StreamDeps } from '../src/http.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { StreamHub, createDbTicketStore, createPgNotificationSource, newTicket } from '../src/stream.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const SECRET = 'stream-test-secret-0123456789-abcdefghij';
const ISSUER = 'http://localhost:9999';
// The re-check interval of every stream in this file.
const RECHECK_SECONDS = 1;

const suite = ADMIN ? describe : describe.skip;

interface SseEvent {
  event: string;
  data: Record<string, unknown>;
}

suite('invalidation stream on PostgreSQL', () => {
  const dbName = `crove_test_stream_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let runtime: Runtime;
  let hub: StreamHub;
  let deps: HttpDeps;
  let app: ReturnType<typeof createHttpApp>;
  const accounts = new Map<string, { subject: string; email: string; session: string }>();
  const orgs = new Map<string, { slug: string; orgId: string }>();
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
      who = { subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@stream.test`, session: randomUUID() };
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

  async function createOrgOf(name: string) {
    const created = await rpc('org/create', name, { name: `Stream ${randomUUID().slice(0, 6)}`, idempotencyKey: randomUUID() }, null);
    expect(created.status).toBe(200);
    const org = { slug: String(created.body.slug), orgId: String(created.body.orgId) };
    orgs.set(name, org);
    return org;
  }

  async function ticket(name: string, slug: string): Promise<{ status: number; ticket?: string; body: Record<string, unknown> }> {
    const response = await app.request('/api/stream/tickets', {
      method: 'POST',
      headers: { authorization: `Bearer ${await token(name)}`, 'x-crove-org': slug },
    });
    const body = (await response.json()) as Record<string, unknown>;
    return { status: response.status, body, ...(typeof body.ticket === 'string' ? { ticket: body.ticket } : {}) };
  }

  // Opens GET /api/stream on the app itself and collects its events until it ends or is cancelled.
  async function open(value: string, on = app) {
    const response = await on.request(`/api/stream?ticket=${value}`);
    const events: SseEvent[] = [];
    let ended = false;
    let cancel = async () => {};
    if (response.status === 200 && response.body) {
      const reader = response.body.getReader();
      cancel = () => reader.cancel().catch(() => {});
      const decoder = new TextDecoder();
      let buffer = '';
      void (async () => {
        try {
          for (;;) {
            const { value: chunk, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(chunk, { stream: true });
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
        } finally {
          ended = true;
        }
      })();
    }
    const waitFor = async (predicate: (events: SseEvent[]) => boolean, ms: number) => {
      const until = Date.now() + ms;
      while (!predicate(events)) {
        if (Date.now() > until) throw new Error(`timed out; events: ${JSON.stringify(events)}`);
        await new Promise((r) => setTimeout(r, 25));
      }
    };
    return { response, events, waitFor, cancel, ended: () => ended };
  }

  async function streamFor(name: string, slug: string) {
    const t = await ticket(name, slug);
    expect(t.status).toBe(200);
    const s = await open(t.ticket as string);
    expect(s.response.status).toBe(200);
    expect(s.response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(s.response.headers.get('cache-control')).toBe('no-store');
    await s.waitFor((e) => e.some((x) => x.event === 'ready'), 5_000);
    return s;
  }

  // A file recorded in the org through execute() (the bytes do not matter here): fires the file trigger.
  async function ingest(orgId: string, owner: string) {
    const bytes = new TextEncoder().encode(`stream ${randomUUID()}`);
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
      { actor: { type: 'user', userId: userIds.get(owner) as string, aal: 'aal1', sessionId: accounts.get(owner)?.session as string, mfaAt: null }, orgId },
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
    });
    runtime = new Runtime(db, { sessions: createSessionStatusSource('off'), stepUp: 'required' }).register({
      commands: [...kernelCommands, ...financeCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries],
    });
    hub = new StreamHub(createPgNotificationSource({ connectionString: appUrl.toString() }));
    hub.start();
    const stream: StreamDeps = {
      hub,
      tickets: createDbTicketStore(pool),
      slots: new ConcurrencyLimiter({ total: 20, perKey: 3 }),
      recheckSeconds: RECHECK_SECONDS,
    };
    deps = {
      config,
      runtime,
      store: new LocalDiskStore(joinPath(tmpdir(), dbName)),
      authenticate: createAuthenticator(config, db),
      pool,
      aiEnabled: false,
      stream,
    };
    app = createHttpApp(deps);
    const until = Date.now() + 10_000;
    while (!hub.ready) {
      if (Date.now() > until) throw new Error('the stream listener did not start');
      await new Promise((r) => setTimeout(r, 25));
    }
    for (const owner of ['ownerA', 'ownerB']) {
      await createOrgOf(owner);
      const me = await rpc('me/get', owner, undefined, null);
      userIds.set(owner, String(me.body.userId));
    }
  });

  afterAll(async () => {
    await hub?.stop();
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('tells the app that streams are on', async () => {
    const response = await app.request('/api/config');
    expect(await response.json()).toMatchObject({ stream: true });
  });

  it('sends nothing for a rolled-back write', async () => {
    const a = orgs.get('ownerA') as { slug: string; orgId: string };
    const s = await streamFor('ownerA', a.slug);
    try {
      const id = randomUUID();
      await admin(async (c) => {
        await c.query('BEGIN');
        await c.query(
          `INSERT INTO crove_kernel.file (org_id, id, sha256, storage_key, filename, content_type, size_bytes, source, generation)
           VALUES ($1, $2, $3, $4, 'x.xml', 'application/xml', 1, 'upload', $5)`,
          [a.orgId, id, 'a'.repeat(64), `org/${a.orgId}/${'a'.repeat(64)}`, `content:${'a'.repeat(64)}`],
        );
        await c.query('ROLLBACK');
      });
      const committed = await ingest(a.orgId, 'ownerA');
      await s.waitFor((e) => e.some((x) => x.data.id === committed), 5_000);
      expect(s.events.some((x) => x.data.id === id)).toBe(false);
    } finally {
      await s.cancel();
    }
  });

  it('bounds the open streams per user and frees the slot when one closes', async () => {
    const b = orgs.get('ownerB') as { slug: string; orgId: string };
    const open3 = [await streamFor('ownerB', b.slug), await streamFor('ownerB', b.slug), await streamFor('ownerB', b.slug)];
    const t = await ticket('ownerB', b.slug);
    const fourth = await open(t.ticket as string);
    expect(fourth.response.status).toBe(503);
    expect(await fourth.response.json()).toMatchObject({ code: 'STREAM_BUSY' });
    await open3[0]?.cancel();
    await new Promise((r) => setTimeout(r, 100));
    const again = await streamFor('ownerB', b.slug);
    for (const s of [...open3.slice(1), again]) await s.cancel();
  });

  it('caps the unexpired tickets of one user', async () => {
    const b = orgs.get('ownerB') as { slug: string; orgId: string };
    await admin((c) => c.query('DELETE FROM crove_kernel.stream_ticket'));
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await ticket('ownerB', b.slug)).status);
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(200));
    expect(statuses[10]).toBe(429);
  });

  it('tells an expired token apart from the per-user limit when issuing (issue #281)', async () => {
    const b = orgs.get('ownerB') as { slug: string; orgId: string };
    await admin((c) => c.query('DELETE FROM crove_kernel.stream_ticket'));
    const store = createDbTicketStore(pool, { perUser: 1 });
    const binding = {
      userId: userIds.get('ownerB') as string,
      orgId: b.orgId,
      sessionId: accounts.get('ownerB')?.session as string,
      aal: 'aal1' as const,
      mfaAt: null,
      tokenExp: Math.floor(Date.now() / 1000) + 600,
    };
    // By the database's clock: a token that expired a second ago, and one that is still valid.
    expect(await store.issue(newTicket().hash, { ...binding, tokenExp: Math.floor(Date.now() / 1000) - 1 })).toBe('expired');
    expect(await store.issue(newTicket().hash, binding)).toBe('issued');
    expect(await store.issue(newTicket().hash, binding)).toBe('limit');
    // Expired wins over the limit: the client must sign in again, not wait.
    expect(await store.issue(newTicket().hash, { ...binding, tokenExp: Math.floor(Date.now() / 1000) - 1 })).toBe('expired');
    await admin((c) => c.query('DELETE FROM crove_kernel.stream_ticket'));
  });

  it("probes the LISTEN connection and drops it when its own NOTIFY stops coming back (issue #281)", async () => {
    const appUrl = new URL(adminUrl);
    appUrl.username = 'crove_app';
    appUrl.password = 'test-app-pw';
    let deaf = false;
    const clients: pg.Client[] = [];
    const source = createPgNotificationSource({
      connectionString: appUrl.toString(),
      probeIntervalMs: 200,
      probeTimeoutMs: 500,
      minDelayMs: 100,
      log: () => {},
      // A real client whose notifications stop arriving once `deaf` is set, as behind a transaction pooler.
      createClient: (config) => {
        const client = new pg.Client(config);
        const emit = client.emit.bind(client);
        client.emit = ((event: string, ...args: unknown[]) => (deaf && event === 'notification' ? false : emit(event, ...args))) as typeof client.emit;
        clients.push(client);
        return client;
      },
    });
    const events: string[] = [];
    const payloads: string[] = [];
    source.start({ notify: (p) => void payloads.push(p), ready: () => void events.push('ready'), lost: () => void events.push('lost') });
    const waitFor = async (predicate: () => boolean, ms: number) => {
      const until = Date.now() + ms;
      while (!predicate()) {
        if (Date.now() > until) throw new Error(`timed out; events: ${JSON.stringify(events)}`);
        await new Promise((r) => setTimeout(r, 20));
      }
    };
    try {
      await waitFor(() => events.includes('ready'), 5_000);
      // Several probes come and go, none reaches the hub, and the connection stays.
      await new Promise((r) => setTimeout(r, 1_000));
      expect(events).toEqual(['ready']);
      expect(payloads.filter((p) => p.startsWith('probe '))).toEqual([]);
      const id = randomUUID();
      const a = orgs.get('ownerA') as { slug: string; orgId: string };
      await admin((c) => c.query(`SELECT pg_notify('crove_stream', $1)`, [`${a.orgId} file ${id}`]));
      await waitFor(() => payloads.includes(`${a.orgId} file ${id}`), 2_000);
      // The connection goes deaf: the next probe is not answered, it is dropped, and a new one comes back.
      deaf = true;
      await waitFor(() => events.includes('lost'), 3_000);
      deaf = false;
      await waitFor(() => events.filter((e) => e === 'ready').length === 2, 5_000);
      expect(clients.length).toBeGreaterThanOrEqual(2);
    } finally {
      await source.stop();
    }
  });
});
