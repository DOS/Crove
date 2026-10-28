// Invariant suite (Decision 7): invalidation hints honor the legal-entity scope (issue #1692, plan §9 Updates, Phase 1
// exit criterion 2), on a real PostgreSQL 17 with the NOTIFY triggers, one LISTEN connection and the HTTP API.
//   - Every table with a stream hint that sits under the RESTRICTIVE le_scope policy names its entity column in the
//     trigger, so its hints carry the row's entity; the hints of tables without le_scope stay org-wide. The API's
//     ENTITY_HINT_TYPES, whose hints it drops when they name no entity, are exactly the types of the scoped tables
//     (#1703).
//   - A member limited to one legal entity gets no hint about a journal entry or a purchase document of another entity
//     of the org, and does get those of its own entity; an owner (scope '*') gets both.
//   - Org-wide hints (a file) reach every stream of the org as before, as `<org> <type> <id>` on the channel and
//     {type, id} on the stream: the entity is never sent to a client.
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
import { createHttpApp, type StreamDeps } from '../../src/http.ts';
import { createSessionStatusSource } from '../../src/sessions.ts';
import { ENTITY_HINT_TYPES, StreamHub, createDbTicketStore, createPgNotificationSource } from '../../src/stream.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const SECRET = 'stream-le-invariant-secret-0123456789-abcdefghij';
const ISSUER = 'http://localhost:9999';
const RECHECK_SECONDS = 1;

const suite = ADMIN ? describe : describe.skip;

interface SseEvent {
  event: string;
  data: Record<string, unknown>;
}

suite('invariant: invalidation hints honor the legal-entity scope', () => {
  const dbName = `crove_test_stream_le_inv_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let runtime: Runtime;
  let hub: StreamHub;
  let app: ReturnType<typeof createHttpApp>;
  let orgId = '';
  let slug = '';
  let defaultEntity = '';
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
      who = { subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@stream-le.test`, session: randomUUID() };
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

  // A journal entry of `entity`, posted by the owner through the posting path.
  async function post(entity: string): Promise<string> {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT crove_kernel.enter_context($1::uuid, $2::uuid)', [userIds.get('owner'), orgId]);
      const { rows } = await c.query<{ id: string }>(
        `SELECT crove_finance.post_journal_entry('2026-10-01'::date, 'stream le invariant', 'test.stream', $1::uuid, $2::jsonb, NULL, 1, $3::uuid) AS id`,
        [
          randomUUID(),
          JSON.stringify([
            { line_no: 1, account_code: '6422', debit: '100000', credit: '0' },
            { line_no: 2, account_code: '331', debit: '0', credit: '100000' },
          ]),
          entity,
        ],
      );
      await c.query('COMMIT');
      return rows[0]?.id as string;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }

  // A sales document of `entity` with its journal entry, written by the database owner (b_legal_entity keeps the
  // entity it names; the triggers fire as for any writer). Returns both ids.
  async function document(entity: string): Promise<{ doc: string; entry: string }> {
    return admin(async (a) => {
      await a.query('BEGIN');
      try {
        const party = (await a.query<{ id: string }>(`INSERT INTO crove_kernel.party (org_id, name) VALUES ($1, 'Khách hàng') RETURNING id`, [orgId])).rows[0]?.id;
        const doc = (
          await a.query<{ id: string }>(
            `INSERT INTO crove_finance.purchase_document (org_id, party_id, invoice_series, invoice_number, invoice_date, subtotal, vat_amount, total, direction, legal_entity_id)
             VALUES ($1, $2, '1C26TAA', $3, '2026-10-01', 100, 0, 100, 'sale', $4) RETURNING id`,
            [orgId, party, String(Math.floor(Math.random() * 1e8)).padStart(8, '0'), entity],
          )
        ).rows[0]?.id as string;
        const entry = (
          await a.query<{ id: string }>(
            `INSERT INTO crove_finance.journal_entry (org_id, entry_date, description, source_type, source_id, legal_entity_id) VALUES ($1, '2026-10-01', 'bán', 'finance.purchase_document', $2, $3) RETURNING id`,
            [orgId, doc, entity],
          )
        ).rows[0]?.id as string;
        await a.query(`INSERT INTO crove_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit) VALUES ($1, $2, 1, '131', 100, 0), ($1, $2, 2, '5111', 0, 100)`, [
          orgId,
          entry,
        ]);
        await a.query('COMMIT');
        return { doc, entry };
      } catch (error) {
        await a.query('ROLLBACK');
        throw error;
      }
    });
  }

  // A file recorded in the org through execute(): an org-wide row.
  async function ingest(): Promise<string> {
    const bytes = new TextEncoder().encode(`stream le ${randomUUID()}`);
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
      { actor: { type: 'user', userId: userIds.get('owner') as string, aal: 'aal1', sessionId: accounts.get('owner')?.session as string, mfaAt: null }, orgId },
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
      commands: [...kernelCommands, ...financeCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries],
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

    const created = await rpc('org/create', 'owner', { name: `Stream LE ${randomUUID().slice(0, 6)}`, idempotencyKey: randomUUID() }, null);
    expect(created.status).toBe(200);
    slug = String(created.body.slug);
    orgId = String(created.body.orgId);
    userIds.set('owner', String((await rpc('me/get', 'owner', undefined, null)).body.userId));
    // The accountant joins as a member, then keeps the branch's books only (an entity-scoped assignment narrows
    // enter_context's le_scope to that entity).
    await token('accountant');
    const invited = await rpc('org/invite', 'owner', { email: accounts.get('accountant')?.email, role: 'member' }, slug, true);
    expect(invited.status).toBe(200);
    const accepted = await rpc('invites/accept', 'accountant', { token: String(invited.body.acceptPath).split('#')[1] }, null);
    expect(accepted.status).toBe(200);
    userIds.set('accountant', String((await rpc('me/get', 'accountant', undefined, null)).body.userId));
    await admin(async (a) => {
      defaultEntity = (await a.query<{ id: string }>('SELECT id FROM crove_kernel.legal_entity WHERE org_id = $1 AND is_default', [orgId])).rows[0]?.id as string;
      branch = (
        await a.query<{ id: string }>(`INSERT INTO crove_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhánh', 'branch', $2) RETURNING id`, [
          orgId,
          userIds.get('owner'),
        ])
      ).rows[0]?.id as string;
      await a.query(`INSERT INTO crove_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by) VALUES ($1, $2, 'external_accountant', $3, $4)`, [
        orgId,
        userIds.get('accountant'),
        branch,
        userIds.get('owner'),
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

  it('names the entity column in the stream hint of every table under le_scope, and of no other', async () => {
    const rows = await admin(async (c) =>
      (
        await c.query<{ tbl: string; args: Buffer; scoped: boolean }>(
          `SELECT t.tgrelid::regclass::text AS tbl, t.tgargs AS args,
                  EXISTS (SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid = t.tgrelid AND p.polname = 'le_scope') AS scoped
           FROM pg_catalog.pg_trigger t
           WHERE t.tgname = 'stream_hint' AND NOT t.tgisinternal
           ORDER BY 1`,
        )
      ).rows,
    );
    const triggers = rows.map((r) => ({ table: r.tbl, scoped: r.scoped, args: r.args.toString('utf8').split('\u0000').filter((a) => a !== '') }));
    // The tables the issue names are among the scoped ones.
    const scoped = triggers.filter((t) => t.scoped).map((t) => t.table);
    expect(scoped).toEqual(
      expect.arrayContaining([
        'crove_finance.journal_entry',
        'crove_finance.purchase_document',
        'crove_finance.purchase_document_void',
        'crove_kernel.extraction',
        'crove_kernel.notification',
      ]),
    );
    for (const t of triggers) {
      if (t.scoped) expect(t, t.table).toMatchObject({ args: [expect.any(String), expect.any(String), 'legal_entity_id'] });
      else expect(t.args, t.table).toHaveLength(2);
    }
  });

  it("lists in the API's ENTITY_HINT_TYPES exactly the hint types of the tables under le_scope (#1703)", async () => {
    const rows = await admin(async (c) =>
      (
        await c.query<{ args: Buffer; scoped: boolean }>(
          `SELECT t.tgargs AS args,
                  EXISTS (SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid = t.tgrelid AND p.polname = 'le_scope') AS scoped
           FROM pg_catalog.pg_trigger t
           WHERE t.tgname = 'stream_hint' AND NOT t.tgisinternal`,
        )
      ).rows,
    );
    const typeOf = (args: Buffer) => args.toString('utf8').split('\u0000')[0] as string;
    const scopedTypes = new Set(rows.filter((r) => r.scoped).map((r) => typeOf(r.args)));
    const orgWideTypes = new Set(rows.filter((r) => !r.scoped).map((r) => typeOf(r.args)));
    // The API drops a hint of these types that names no entity, so none may come from an org-wide table, and every
    // scoped table's type must be there: a hint of an unlisted scoped type that lost its entity would reach everyone.
    expect([...ENTITY_HINT_TYPES].sort()).toEqual([...scopedTypes].sort());
    expect([...orgWideTypes].filter((type) => scopedTypes.has(type))).toEqual([]);
  });

  it('carries the entity on the channel for an entity-scoped row and nothing more for an org-wide one', async () => {
    const listener = new pg.Client({ connectionString: adminUrl });
    await listener.connect();
    const payloads: string[] = [];
    listener.on('notification', (m) => {
      if (m.channel === 'crove_stream' && m.payload) payloads.push(m.payload);
    });
    await listener.query('LISTEN crove_stream');
    try {
      const entry = await post(branch);
      const sold = await document(defaultEntity);
      const file = await ingest();
      const until = Date.now() + 5_000;
      while (![entry, sold.doc, file].every((id) => payloads.some((p) => p.includes(id)))) {
        if (Date.now() > until) throw new Error(`timed out; payloads: ${JSON.stringify(payloads)}`);
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(payloads.filter((p) => p.includes(entry))).toEqual([`${orgId} journal_entry ${entry} ${branch}`]);
      expect(payloads.filter((p) => p.includes(sold.doc))).toEqual([`${orgId} document ${sold.doc} ${defaultEntity}`]);
      expect(payloads.filter((p) => p.includes(file))).toEqual([`${orgId} file ${file}`]);
    } finally {
      await listener.end();
    }
  });

  it("gives a member limited to one entity no hint about another entity's journal entry or document, and an owner every hint", async () => {
    const owner = await streamFor('owner');
    const accountant = await streamFor('accountant');
    try {
      const other = await post(defaultEntity);
      const otherSale = await document(defaultEntity);
      const own = await post(branch);
      const ownSale = await document(branch);
      const file = await ingest();
      const got = (events: SseEvent[], id: string) => events.some((x) => x.event === 'invalidate' && x.data.id === id);
      const all = [other, otherSale.doc, otherSale.entry, own, ownSale.doc, ownSale.entry, file];
      await owner.waitFor((e) => all.every((id) => got(e, id)), 5_000);
      await accountant.waitFor((e) => [own, ownSale.doc, ownSale.entry, file].every((id) => got(e, id)), 5_000);
      // The default entity's rows were written before the branch's: had their hints reached the accountant, they would
      // be there now. Wait a little for a stray delivery anyway.
      await new Promise((r) => setTimeout(r, 300));
      for (const id of [other, otherSale.doc, otherSale.entry]) {
        expect(got(accountant.events, id)).toBe(false);
        expect(accountant.events.some((x) => JSON.stringify(x.data).includes(id))).toBe(false);
      }
      expect(accountant.events.find((x) => x.data.id === ownSale.doc)?.data).toEqual({ type: 'document', id: ownSale.doc });
      // Org-wide hints unchanged, and the entity never reaches a client.
      expect(accountant.events.find((x) => x.data.id === file)?.data).toEqual({ type: 'file', id: file });
      expect(accountant.events.find((x) => x.data.id === own)?.data).toEqual({ type: 'journal_entry', id: own });
      for (const e of [...owner.events, ...accountant.events].filter((x) => x.event === 'invalidate')) {
        expect(Object.keys(e.data).sort()).toEqual(['id', 'type']);
      }
      expect(accountant.events.some((x) => x.event === 'resync' || x.event === 'close')).toBe(false);
    } finally {
      await owner.cancel();
      await accountant.cancel();
    }
  });
});
