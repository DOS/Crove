// Invariant suite (Decision 7): the invalidation stream's security rules (issue #69, moved here by #281), through the
// HTTP API on a real PostgreSQL 17 with the NOTIFY triggers, one LISTEN connection and the ticket definers.
//   - Hints of org A never reach a stream of org B, and carry {type, id} only.
//   - A ticket opens one stream once; an expired, malformed or missing one opens none, and a bearer token alone opens
//     none. Only its SHA-256 is stored. Tickets go only to members of the org, with a valid token.
//   - A removed member's stream closes with `membership` within the re-check interval, a stream whose session the
//     owner revoked in the org with `session_revoked_in_org`.
//   - Only crove_app may execute stream_ticket_issue and stream_ticket_redeem, nobody stream_notify, and no role may
//     read crove_kernel.stream_ticket.
//   - Failed redeems are capped per client address: past the cap the address is refused (429) before the database is
//     asked, other addresses are not, and a successful redeem costs nothing.
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
import { financeCommands, financeQueries } from '@crove/mod-finance';
import { createAuthenticator } from '../../src/auth.ts';
import { ConcurrencyLimiter } from '../../src/concurrency.ts';
import { loadConfig } from '../../src/config.ts';
import { STREAM_REDEEM_FAILURES_PER_MINUTE, createHttpApp, type HttpDeps, type StreamDeps } from '../../src/http.ts';
import { createSessionStatusSource } from '../../src/sessions.ts';
import { StreamHub, createDbTicketStore, createPgNotificationSource, type TicketStore } from '../../src/stream.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const SECRET = 'stream-invariant-secret-0123456789-abcdefghij';
const ISSUER = 'http://localhost:9999';
// The re-check interval of every stream in this file.
const RECHECK_SECONDS = 1;
const ROLES = ['crove_app', 'crove_tenant', 'crove_worker', 'crove_definer_tenant', 'crove_prober', 'crove_reporter'];

const suite = ADMIN ? describe : describe.skip;

interface SseEvent {
  event: string;
  data: Record<string, unknown>;
}

suite('invariant: the invalidation stream', () => {
  const dbName = `crove_test_stream_inv_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let runtime: Runtime;
  let hub: StreamHub;
  let deps: HttpDeps;
  let app: ReturnType<typeof createHttpApp>;
  // Redeems that reached the database, through `app`.
  let redeemCalls = 0;
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

  async function join(slug: string, owner: string, name: string) {
    await token(name);
    const invited = await rpc('org/invite', owner, { email: accounts.get(name)?.email, role: 'member' }, slug, true);
    expect(invited.status).toBe(200);
    const accepted = await rpc('invites/accept', name, { token: String(invited.body.acceptPath).split('#')[1] }, null);
    expect(accepted.status).toBe(200);
    const me = await rpc('me/get', name, undefined, null);
    userIds.set(name, String(me.body.userId));
  }

  async function ticket(name: string, slug: string, on = app): Promise<{ status: number; ticket?: string; body: Record<string, unknown> }> {
    const response = await on.request('/api/stream/tickets', {
      method: 'POST',
      headers: { authorization: `Bearer ${await token(name)}`, 'x-crove-org': slug },
    });
    const body = (await response.json()) as Record<string, unknown>;
    return { status: response.status, body, ...(typeof body.ticket === 'string' ? { ticket: body.ticket } : {}) };
  }

  // Opens GET /api/stream and collects its events until it ends or is cancelled. `from` is the client address the
  // trusted proxy reports (TRUSTED_PROXY_HOPS=1 below).
  async function open(value: string, from = '198.51.100.1', on = app) {
    const response = await on.request(`/api/stream?ticket=${value}`, { headers: { 'x-forwarded-for': from } });
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
    await s.waitFor((e) => e.some((x) => x.event === 'ready'), 5_000);
    return s;
  }

  // A file recorded in the org through execute(): fires the file trigger.
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
      // The test client sends X-Forwarded-For as the one trusted proxy would.
      TRUSTED_PROXY_HOPS: '1',
    });
    runtime = new Runtime(db, { sessions: createSessionStatusSource('off'), stepUp: 'required' }).register({
      commands: [...kernelCommands, ...financeCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries],
    });
    hub = new StreamHub(createPgNotificationSource({ connectionString: appUrl.toString() }));
    hub.start();
    const store = createDbTicketStore(pool);
    const counted: TicketStore = {
      issue: (hash, binding) => store.issue(hash, binding),
      redeem: (hash) => {
        redeemCalls++;
        return store.redeem(hash);
      },
    };
    const stream: StreamDeps = {
      hub,
      tickets: counted,
      slots: new ConcurrencyLimiter({ total: 50, perKey: 10 }),
      recheckSeconds: RECHECK_SECONDS,
    };
    deps = {
      config,
      runtime,
      store: new LocalDiskStore(joinPath(tmpdir(), dbName)),
      authenticate: createAuthenticator(config, db),
      pool,
      aiEnabled: false,
      // Off: this file opens many streams from one user.
      rateLimiter: null,
      stream,
    };
    app = createHttpApp(deps);
    const until = Date.now() + 10_000;
    while (!hub.ready) {
      if (Date.now() > until) throw new Error('the stream listener did not start');
      await new Promise((r) => setTimeout(r, 25));
    }
    for (const owner of ['ownerA', 'ownerB']) {
      const created = await rpc('org/create', owner, { name: `Stream ${randomUUID().slice(0, 6)}`, idempotencyKey: randomUUID() }, null);
      expect(created.status).toBe(200);
      orgs.set(owner, { slug: String(created.body.slug), orgId: String(created.body.orgId) });
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

  it('hands org A hints to org A only, as {type, id}', async () => {
    const a = orgs.get('ownerA') as { slug: string; orgId: string };
    const b = orgs.get('ownerB') as { slug: string; orgId: string };
    const streamA = await streamFor('ownerA', a.slug);
    const streamB = await streamFor('ownerB', b.slug);
    try {
      const fileA = await ingest(a.orgId, 'ownerA');
      await streamA.waitFor((e) => e.some((x) => x.event === 'invalidate' && x.data.id === fileA), 5_000);
      const hint = streamA.events.find((x) => x.event === 'invalidate' && x.data.id === fileA);
      expect(hint?.data).toEqual({ type: 'file', id: fileA });

      const fileB = await ingest(b.orgId, 'ownerB');
      await streamB.waitFor((e) => e.some((x) => x.event === 'invalidate' && x.data.id === fileB), 5_000);
      // Give a stray delivery time to arrive, then check neither stream saw the other org's file.
      await new Promise((r) => setTimeout(r, 300));
      expect(streamB.events.some((x) => x.data.id === fileA)).toBe(false);
      expect(streamA.events.some((x) => x.data.id === fileB)).toBe(false);
      for (const e of [...streamA.events, ...streamB.events].filter((x) => x.event === 'invalidate')) {
        expect(Object.keys(e.data).sort()).toEqual(['id', 'type']);
      }
    } finally {
      await streamA.cancel();
      await streamB.cancel();
    }
  });

  it("closes a removed member's stream within the re-check interval", async () => {
    const a = orgs.get('ownerA') as { slug: string; orgId: string };
    await join(a.slug, 'ownerA', 'leaver');
    const s = await streamFor('leaver', a.slug);
    const removed = await rpc('org/removeMember', 'ownerA', { userId: userIds.get('leaver'), idempotencyKey: randomUUID() }, a.slug, true);
    expect(removed.status).toBe(200);
    const at = Date.now();
    await s.waitFor((e) => e.some((x) => x.event === 'close'), RECHECK_SECONDS * 1000 * 2 + 1_000);
    expect(Date.now() - at).toBeLessThanOrEqual(RECHECK_SECONDS * 1000 + 1_000);
    expect(s.events.at(-1)).toEqual({ event: 'close', data: { reason: 'membership' } });
    await s.waitFor(() => s.ended(), 2_000);
    // The ex-member gets no new ticket for that org.
    expect((await ticket('leaver', a.slug)).status).toBe(403);
  });

  it('closes a stream whose session the owner revoked in the org', async () => {
    const a = orgs.get('ownerA') as { slug: string; orgId: string };
    await join(a.slug, 'ownerA', 'revoked');
    const s = await streamFor('revoked', a.slug);
    const revoked = await rpc(
      'sessions/revoke',
      'ownerA',
      { userId: userIds.get('revoked'), sessionId: accounts.get('revoked')?.session, reason: 'lost laptop' },
      a.slug,
      true,
    );
    expect(revoked.status).toBe(200);
    await s.waitFor((e) => e.some((x) => x.event === 'close'), RECHECK_SECONDS * 1000 * 2 + 1_000);
    expect(s.events.at(-1)).toEqual({ event: 'close', data: { reason: 'session_revoked_in_org' } });
  });

  it('accepts a ticket once, and stores only its hash', async () => {
    const a = orgs.get('ownerA') as { slug: string; orgId: string };
    const t = await ticket('ownerA', a.slug);
    expect(t.status).toBe(200);
    const stored = await admin(async (c) => (await c.query<{ ticket_hash: string }>('SELECT ticket_hash FROM crove_kernel.stream_ticket')).rows);
    expect(stored.map((r) => r.ticket_hash)).toContain(sha256Hex(new TextEncoder().encode(t.ticket as string)));
    expect(stored.map((r) => r.ticket_hash)).not.toContain(t.ticket);
    const first = await open(t.ticket as string);
    expect(first.response.status).toBe(200);
    const second = await open(t.ticket as string);
    expect(second.response.status).toBe(401);
    expect(await second.response.json()).toMatchObject({ code: 'STREAM_TICKET_INVALID' });
    await first.cancel();
    const left = await admin(async (c) => (await c.query<{ ticket_hash: string }>('SELECT ticket_hash FROM crove_kernel.stream_ticket')).rows);
    expect(left.map((r) => r.ticket_hash)).not.toContain(sha256Hex(new TextEncoder().encode(t.ticket as string)));
  });

  it('refuses an expired ticket, a malformed one, a stream without one and a bearer token alone', async () => {
    const a = orgs.get('ownerA') as { slug: string; orgId: string };
    const shortLived = createHttpApp({ ...deps, stream: { ...(deps.stream as StreamDeps), tickets: createDbTicketStore(pool, { ttlSeconds: 1 }) } });
    const t = await ticket('ownerA', a.slug, shortLived);
    expect(t.status).toBe(200);
    await new Promise((r) => setTimeout(r, 1_500));
    expect((await open(t.ticket as string, '198.51.100.2', shortLived)).response.status).toBe(401);
    expect((await app.request('/api/stream?ticket=short')).status).toBe(401);
    expect((await app.request('/api/stream')).status).toBe(401);
    expect((await app.request('/api/stream', { headers: { authorization: `Bearer ${await token('ownerA')}`, 'x-crove-org': a.slug } })).status).toBe(401);
  });

  it('issues tickets only to members of the org, with a valid token', async () => {
    const b = orgs.get('ownerB') as { slug: string; orgId: string };
    expect((await ticket('ownerA', b.slug)).status).toBe(403);
    const anonymous = await app.request('/api/stream/tickets', { method: 'POST', headers: { 'x-crove-org': b.slug } });
    expect(anonymous.status).toBe(401);
  });

  it('caps failed redeems per client address before the database is asked', async () => {
    const a = orgs.get('ownerA') as { slug: string; orgId: string };
    const probing = '203.0.113.7';
    // A well-formed ticket nobody issued.
    const unknown = () => Buffer.from(randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''), 'hex').toString('base64url').slice(0, 43);
    // Successful redeems from the address cost nothing.
    for (let i = 0; i < 3; i++) {
      const t = await ticket('ownerA', a.slug);
      const s = await open(t.ticket as string, probing);
      expect(s.response.status).toBe(200);
      await s.cancel();
    }
    const before = redeemCalls;
    for (let i = 0; i < STREAM_REDEEM_FAILURES_PER_MINUTE; i++) {
      expect((await open(unknown(), probing)).response.status).toBe(401);
    }
    expect(redeemCalls - before).toBe(STREAM_REDEEM_FAILURES_PER_MINUTE);
    const refused = await open(unknown(), probing);
    expect(refused.response.status).toBe(429);
    expect(refused.response.headers.get('retry-after')).toMatch(/^[1-9]\d*$/);
    expect(await refused.response.json()).toMatchObject({ code: 'RATE_LIMITED' });
    // Refused before the database: no redeem ran, so even a valid ticket from that address is not spent.
    const valid = await ticket('ownerA', a.slug);
    expect((await open(valid.ticket as string, probing)).response.status).toBe(429);
    expect(redeemCalls - before).toBe(STREAM_REDEEM_FAILURES_PER_MINUTE);
    // Another address is not affected, and the unspent ticket still works there.
    const elsewhere = await open(valid.ticket as string, '198.51.100.9');
    expect(elsewhere.response.status).toBe(200);
    await elsewhere.cancel();
    // IPv6 clients are bucketed by /64, so rotating the interface id does not escape the cap.
    for (let i = 0; i < STREAM_REDEEM_FAILURES_PER_MINUTE; i++) await open(unknown(), `2001:db8:1:2::${(i + 1).toString(16)}`);
    expect((await open(unknown(), '2001:db8:1:2:ffff::1')).response.status).toBe(429);
  });

  it('lets only crove_app issue and redeem tickets, nobody call stream_notify, and no role read the table', async () => {
    const rows = await admin(async (c) =>
      (
        await c.query<{ fn: string; role: string; can: boolean }>(
          `SELECT f AS fn, r AS role, has_function_privilege(r, f, 'EXECUTE') AS can
           FROM unnest(ARRAY['crove_kernel.stream_ticket_issue(text, uuid, uuid, uuid, text, bigint, timestamptz, integer, integer)',
                             'crove_kernel.stream_ticket_redeem(text)', 'crove_kernel.stream_notify()']) f,
                unnest($1::text[]) r`,
          [ROLES],
        )
      ).rows,
    );
    const granted = rows.filter((r) => r.can).map((r) => `${r.fn.split('(')[0]}:${r.role}`);
    expect(granted.sort()).toEqual(['crove_kernel.stream_ticket_issue:crove_app', 'crove_kernel.stream_ticket_redeem:crove_app']);
    const table = await admin(async (c) =>
      (
        await c.query<{ role: string; privilege: string }>(
          `SELECT r AS role, p AS privilege FROM unnest($1::text[]) r, unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) p
           WHERE has_table_privilege(r, 'crove_kernel.stream_ticket', p)`,
          [ROLES],
        )
      ).rows,
    );
    expect(table).toEqual([]);
    const rls = await admin(async (c) => (await c.query<{ on: boolean }>(`SELECT relrowsecurity AS on FROM pg_class WHERE oid = 'crove_kernel.stream_ticket'::regclass`)).rows);
    expect(rls).toEqual([{ on: true }]);
  });
});
