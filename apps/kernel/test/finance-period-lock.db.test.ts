// Period lock (issue #329), on a real PostgreSQL 17, through the HTTP API: lock a month, then posting, approving and
// reversing into it are refused with PERIOD_LOCKED; months lock in order and unlock newest first; unlock is the
// owner's alone, R3 with a reason on the audit row; the database guard holds for the database owner too; and a lock
// and a posting in flight wait for each other (ADR-0021 cases A and B).
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import type { ExtractClient } from '@crove/extract-contract';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { kernelCommands, kernelQueries } from '@crove/kernel';
import { Runtime, defineCommand, fileKey, sha256Hex, type BlobStore } from '@crove/kernel-runtime';
import { extractAndPropose, financeCommands, financeQueries, vietnamMonth } from '@crove/mod-finance';
import { createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { z } from 'zod';
import { inProcessExtract } from './extract-service.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const FIXTURE = readFileSync(new URL('../../extract/test/fixtures/einvoice-basic.xml', import.meta.url), 'utf8');
const SECRET = 'test-only-jwt-secret-for-period-lock-0123456789';
const ISSUER = 'crove-auth';

class MemoryStore implements BlobStore {
  private readonly blobs = new Map<string, Uint8Array>();
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

interface Account {
  subject: string;
  email: string;
  session: string;
  userId: string;
}

interface OrgRef {
  slug: string;
  orgId: string;
}

// Test-only commands that call the lock functions directly, open to every member: the database still refuses a caller
// who may not lock or unlock, so a path that skips the real commands' access rule cannot move the lock.
const rawCall = (name: string, fn: 'lock_period' | 'unlock_period') =>
  defineCommand({
    name,
    input: z.object({ month: z.string() }),
    risk: 'R1',
    access: ['owner', 'admin', 'member', 'viewer'],
    handler: async (ctx, input) => {
      await sql`SELECT crove_finance.${sql.raw(fn)}(${`${input.month}-01`}::date)`.execute(ctx.trx);
      return { ok: true as const };
    },
  });
const RAW_COMMANDS = [rawCall('test.period.lock_raw', 'lock_period'), rawCall('test.period.unlock_raw', 'unlock_period')];

const suite = ADMIN ? describe : describe.skip;

suite('period lock (#329)', () => {
  const dbName = `crove_test_period_lock_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let runtime: Runtime;
  let workerRuntime: Runtime;
  let app: ReturnType<typeof createHttpApp>;
  const store = new MemoryStore();
  let extract: ExtractClient;
  const owner: Account = { subject: randomUUID(), email: 'owner@lock.test', session: randomUUID(), userId: '' };
  const adminUser: Account = { subject: randomUUID(), email: 'admin@lock.test', session: randomUUID(), userId: '' };
  const viewer: Account = { subject: randomUUID(), email: 'viewer@lock.test', session: randomUUID(), userId: '' };
  const outsider: Account = { subject: randomUUID(), email: 'outsider@lock.test', session: randomUUID(), userId: '' };
  let org: OrgRef = { slug: '', orgId: '' };
  let otherOrg: OrgRef = { slug: '', orgId: '' };
  let invoiceNo = 5000;

  const asUser = (who: Account) => ({ type: 'user' as const, userId: who.userId, aal: 'aal1' as const, sessionId: who.session });

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  async function tokenFor(who: Account, options: { mfa?: boolean } = {}) {
    const now = Math.floor(Date.now() / 1000);
    const mfa = options.mfa ? { aal: 'aal2', amr: [{ method: 'totp', timestamp: now }] } : {};
    return new SignJWT({ role: 'authenticated', email: who.email, session_id: who.session, aal: 'aal1', is_anonymous: false, ...mfa })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(who.subject)
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(new TextEncoder().encode(SECRET));
  }

  async function rpc(path: string, token: string, input: unknown, slug: string | null = org.slug) {
    const response = await app.request(`/api/rpc/${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(slug ? { 'x-crove-org': slug } : {}) },
      body: JSON.stringify(input === undefined ? {} : { json: input }),
    });
    const body = (await response.json().catch(() => null)) as ({ json?: unknown } & Record<string, unknown>) | null;
    return { status: response.status, body: (body && 'json' in body ? body.json : body) as any };
  }

  const state = async (who: Account = owner, target = org) => rpc('periodLock/state', await tokenFor(who), undefined, target.slug);
  const lock = async (month: string, who: Account = owner, target = org) =>
    rpc('periodLock/lock', await tokenFor(who), { month, idempotencyKey: randomUUID() }, target.slug);
  const unlock = async (month: string, reason: string, who: Account = owner, options: { mfa?: boolean } = { mfa: true }) =>
    rpc('periodLock/unlock', await tokenFor(who, options), { month, reason, idempotencyKey: randomUUID() });

  // The fixture invoice (1,800,000 + VAT 180,000 = 1,980,000 owed to the seller on 331) under a new number and date.
  const invoice = (number: string, date: string) =>
    new TextEncoder().encode(FIXTURE.replace('<SHDon>1234</SHDon>', `<SHDon>${number}</SHDon>`).replace('<NLap>2026-09-15</NLap>', `<NLap>${date}</NLap>`));

  // Uploads and reads one invoice dated `date` in an org; returns the purchase proposal waiting for approval.
  async function propose(date: string, target: OrgRef = org, who: Account = owner): Promise<string> {
    const bytes = invoice(String(invoiceNo++), date);
    const sha256 = sha256Hex(bytes);
    const storageKey = fileKey(target.orgId, sha256);
    const generation = await store.put(storageKey, bytes);
    const { fileId } = await runtime.execute<{ fileId: string }>(
      'kernel.file.ingest',
      { filename: 'hd.xml', contentType: 'application/xml', sizeBytes: bytes.byteLength, sha256, storageKey, generation, source: 'upload' },
      { actor: asUser(who), orgId: target.orgId },
    );
    const { proposalId } = await extractAndPropose({ runtime: workerRuntime, store, extractor: null, extract, today: () => '2026-10-17' }, target.orgId, fileId);
    if (!proposalId) throw new Error('the invoice raised no proposal');
    return proposalId;
  }

  // The owner uploads and the admin approves (four-eyes, P10); in the other org its owner is the only approver.
  const approve = async (proposalId: string, who: Account = adminUser, slug = org.slug) =>
    rpc('inbox/approve', await tokenFor(who, { mfa: true }), { id: proposalId, revision: 1, idempotencyKey: randomUUID() }, slug);

  async function record(date: string, target: OrgRef = org, who: Account = owner): Promise<string> {
    const approved = await approve(await propose(date, target, who), target === org ? adminUser : who, target.slug);
    expect(approved.status).toBe(200);
    return String(approved.body.journalEntryId);
  }

  const entriesOn = (date: string, orgId = org.orgId) =>
    admin(async (c) => (await c.query('SELECT id FROM crove_finance.journal_entry WHERE org_id = $1 AND entry_date = $2', [orgId, date])).rows.length);

  const auditsOf = (command: string) =>
    admin(
      async (c) =>
        (
          await c.query<{ actor_id: string; outcome: string; detail: Record<string, unknown> }>(
            `SELECT actor_id, outcome, detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = $2 ORDER BY occurred_at, id`,
            [org.orgId, command],
          )
        ).rows,
    );

  // A balanced entry inserted by the database owner, in its own transaction left open until `done` is called.
  async function heldEntry(date: string): Promise<{ client: pg.Client; done: () => Promise<void> }> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    const id = randomUUID();
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO crove_finance.journal_entry (org_id, id, entry_date, description, source_type, source_id) VALUES ($1, $2, $3, 'held', 'test.held', $4)`,
      [org.orgId, id, date, randomUUID()],
    );
    await client.query(
      `INSERT INTO crove_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit) VALUES ($1, $2, 1, '6422', 100, 0), ($1, $2, 2, '331', 0, 100)`,
      [org.orgId, id],
    );
    return {
      client,
      done: async () => {
        await client.query('COMMIT');
        await client.end();
      },
    };
  }

  // Resolves to 'pending' when `promise` has not settled within `ms`.
  const settledWithin = <T>(promise: Promise<T>, ms: number) =>
    Promise.race([promise.then(() => 'settled' as const), new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), ms))]);

  beforeAll(async () => {
    extract = inProcessExtract();
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
    const appUrl = login('crove_app', 'test-app-pw');
    pool = createPool({ connectionString: appUrl, max: 6 });
    const db: Db = createDb(pool);
    workerPool = createPool({ connectionString: login('crove_worker', 'test-worker-pw'), max: 2 });
    const register = (target: Db, sessions = false) =>
      new Runtime(target, sessions ? { sessions: createSessionStatusSource('off'), stepUp: 'required' } : {}).register({
        commands: [...kernelCommands, ...financeCommands, ...RAW_COMMANDS],
        queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries],
      });
    runtime = register(db, true);
    workerRuntime = register(createDb(workerPool));
    const config = loadConfig({
      DATABASE_URL: appUrl,
      AUTH_JWT_SECRET: SECRET,
      AUTH_ISSUER: ISSUER,
      AUTH_SESSION_CHECK: 'off',
      MIGRATIONS_DIR: MIGRATIONS,
      WEB_DIST: '/nonexistent',
    });
    app = createHttpApp({ config, runtime, store, authenticate: createAuthenticator(config, db), pool, aiEnabled: false });

    for (const who of [owner, adminUser, viewer, outsider]) {
      const me = await rpc('me/get', await tokenFor(who), undefined, null);
      expect(me.status).toBe(200);
      who.userId = String(me.body?.userId);
    }
    const created = await rpc('org/create', await tokenFor(owner), { name: 'Công ty Khóa sổ', idempotencyKey: randomUUID() }, null);
    expect(created.status).toBe(200);
    org = { slug: String(created.body?.slug), orgId: String(created.body?.orgId) };
    for (const [who, role] of [
      [adminUser, 'admin'],
      [viewer, 'viewer'],
    ] as const) {
      const invite = await rpc('org/invite', await tokenFor(owner, { mfa: true }), { email: who.email, role });
      expect(invite.status).toBe(200);
      expect((await rpc('invites/accept', await tokenFor(who), { token: String(invite.body?.acceptPath).split('#')[1] }, null)).status).toBe(200);
    }
    const other = await rpc('org/create', await tokenFor(outsider), { name: 'Công ty khác', idempotencyKey: randomUUID() }, null);
    otherOrg = { slug: String(other.body?.slug), orgId: String(other.body?.orgId) };
  });

  afterAll(async () => {
    await pool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('starts with nothing locked, which every member can read', async () => {
    expect(await state(viewer)).toMatchObject({
      status: 200,
      body: { lockedFrom: null, lockedThrough: null, nextMonth: null, lastMonth: null, updatedBy: null, updatedAt: null },
    });
  });

  it('refuses to post, approve or reverse into a locked month, dates before the first locked month included', async () => {
    const august = await record('2026-08-10');
    const pending = await propose('2026-08-25');
    const july = await propose('2026-07-05');

    const locked = await lock('2026-08', adminUser);
    expect(locked).toMatchObject({
      status: 200,
      body: { lockedFrom: '2026-08-01', lockedThrough: '2026-08-31', nextMonth: '2026-09', lastMonth: '2026-08', updatedBy: adminUser.email },
    });
    expect(Date.parse(locked.body.updatedAt)).toBeGreaterThan(Date.now() - 60_000);
    expect(await auditsOf('finance.period.lock')).toEqual([expect.objectContaining({ actor_id: adminUser.userId, outcome: 'ok', detail: expect.objectContaining({ month: '2026-08' }) })]);

    // Approving a purchase dated in the locked month, or before it, is refused and leaves the proposal waiting.
    expect(await approve(pending)).toMatchObject({
      status: 409,
      body: { code: 'PERIOD_LOCKED', data: { lockedThrough: '2026-08-31', entryDate: '2026-08-25' } },
    });
    expect(await approve(july)).toMatchObject({ status: 409, body: { code: 'PERIOD_LOCKED', data: { entryDate: '2026-07-05' } } });
    expect(await entriesOn('2026-08-25')).toBe(0);
    const inbox = await rpc('inbox/get', await tokenFor(owner), { id: pending });
    expect(inbox.body.status).toBe('pending');

    // In a bulk approval only the item dated in the locked month is refused; the September one is still approved.
    const september = await propose('2026-09-12');
    const bulk = await rpc('inbox/approveMany', await tokenFor(adminUser, { mfa: true }), {
      items: [
        { id: pending, revision: 1 },
        { id: september, revision: 1 },
      ],
      idempotencyKey: randomUUID(),
    });
    expect(bulk.status).toBe(200);
    expect(bulk.body.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: pending, outcome: 'refused', code: 'PERIOD_LOCKED' }),
        expect.objectContaining({ id: september, outcome: 'approved' }),
      ]),
    );
    expect(await entriesOn('2026-09-12')).toBe(1);
    expect((await rpc('inbox/get', await tokenFor(owner), { id: pending })).body.status).toBe('pending');

    // A reversal dated in the locked month is refused at approval; dated in September it posts.
    const reverse = async (entryDate: string) => {
      const asked = await rpc('inbox/request', await tokenFor(owner), {
        command: 'finance.journal.reverse',
        input: { entryId: august, entryDate, reason: 'Ghi nhầm' },
        idempotencyKey: randomUUID(),
      });
      expect(asked.status).toBe(200);
      return asked.body.proposalId as string;
    };
    const intoAugust = await reverse('2026-08-31');
    expect(await approve(intoAugust)).toMatchObject({ status: 409, body: { code: 'PERIOD_LOCKED', data: { entryDate: '2026-08-31' } } });
    expect((await rpc('inbox/reject', await tokenFor(owner), { id: intoAugust, reason: 'Đảo vào tháng 9' })).status).toBe(200);
    expect((await approve(await reverse('2026-09-01'))).status).toBe(200);

    // September is open; the other org has locked nothing.
    await record('2026-09-03');
    await record('2026-08-20', otherOrg, outsider);
    expect(await state(outsider, otherOrg)).toMatchObject({ status: 200, body: { lockedThrough: null } });
  });

  it('holds for the database owner too', async () => {
    await expect(
      admin((c) =>
        c.query(
          `INSERT INTO crove_finance.journal_entry (org_id, entry_date, description, source_type, source_id) VALUES ($1, '2026-08-15', 'direct', 'test.direct', $2)`,
          [org.orgId, randomUUID()],
        ),
      ),
    ).rejects.toMatchObject({ code: '55000', message: 'PERIOD_LOCKED' });
    // The login roles cannot move the lock themselves: they only read it.
    await expect(
      admin(async (c) => {
        await c.query('BEGIN');
        try {
          await c.query('SET LOCAL ROLE crove_app');
          await c.query(`UPDATE crove_finance.period_lock SET locked_through = NULL WHERE org_id = $1`, [org.orgId]);
        } finally {
          await c.query('ROLLBACK');
        }
      }),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('locks months in order, once they are over, and only owners and admins lock', async () => {
    expect(await lock('2026-08')).toMatchObject({ status: 409, body: { code: 'PERIOD_ALREADY_LOCKED', data: { lockedThrough: '2026-08-31' } } });
    expect(await lock('2026-07')).toMatchObject({ status: 409, body: { code: 'PERIOD_ALREADY_LOCKED' } });
    expect(await lock('2026-10')).toMatchObject({ status: 409, body: { code: 'EARLIER_PERIOD_OPEN', data: { lockedThrough: '2026-08-31' } } });
    // The month in progress cannot be locked (in the other org, where nothing is locked so any month may come first),
    // and the refusal leaves nothing locked.
    expect(await lock(vietnamMonth(new Date()), outsider, otherOrg)).toMatchObject({ status: 422, body: { code: 'PERIOD_NOT_ENDED' } });
    expect(await state(outsider, otherOrg)).toMatchObject({ status: 200, body: { lockedThrough: null } });
    expect(await lock('2026-09', viewer)).toMatchObject({ status: 403, body: { code: 'FORBIDDEN' } });
    expect((await lock('2026-09', outsider)).status).toBe(403);
    expect(await lock('2026-09')).toMatchObject({ status: 200, body: { lockedFrom: '2026-08-01', lockedThrough: '2026-09-30', nextMonth: '2026-10', lastMonth: '2026-09' } });
  });

  it('unlocks only the last locked month, by an owner with fresh MFA and a reason', async () => {
    expect(await unlock('2026-09', 'Sửa hóa đơn', adminUser)).toMatchObject({ status: 403, body: { code: 'FORBIDDEN' } });
    expect(await unlock('2026-09', 'Sửa hóa đơn', owner, {})).toMatchObject({ status: 403, body: { code: 'STEP_UP_REQUIRED' } });
    expect((await unlock('2026-09', '   ')).status).toBe(400);
    expect(await unlock('2026-08', 'Sửa hóa đơn')).toMatchObject({ status: 409, body: { code: 'LATER_PERIOD_LOCKED', data: { lockedThrough: '2026-09-30' } } });
    expect(await unlock('2026-10', 'Sửa hóa đơn')).toMatchObject({ status: 409, body: { code: 'PERIOD_NOT_LOCKED' } });

    const reopened = await unlock('2026-09', 'Bổ sung hóa đơn mua vào tháng 9');
    expect(reopened).toMatchObject({ status: 200, body: { lockedFrom: '2026-08-01', lockedThrough: '2026-08-31', nextMonth: '2026-09', lastMonth: '2026-08', updatedBy: owner.email } });
    const audits = (await auditsOf('finance.period.unlock')).filter((a) => a.outcome === 'ok');
    expect(audits).toEqual([expect.objectContaining({ actor_id: owner.userId, detail: expect.objectContaining({ month: '2026-09', reason: 'Bổ sung hóa đơn mua vào tháng 9', aal: 'aal2' }) })]);
    // September posts again; August stays locked.
    await record('2026-09-28');
    expect((await approve(await propose('2026-08-30'))).body.code).toBe('PERIOD_LOCKED');

    // Unlocking the first locked month clears the lock, so every month posts again.
    expect(await unlock('2026-08', 'Mở lại toàn bộ')).toMatchObject({ status: 200, body: { lockedFrom: null, lockedThrough: null, nextMonth: null, lastMonth: null } });
    await record('2026-07-20');
    // Nothing locked: the first lock may name any month that is over.
    expect(await lock('2026-06')).toMatchObject({ status: 200, body: { lockedFrom: '2026-06-01', lockedThrough: '2026-06-30' } });
    expect((await unlock('2026-06', 'Thử khóa nhầm tháng')).status).toBe(200);
  });

  it('makes a lock wait for a posting in flight, and a posting wait for a lock in flight (ADR-0021 cases A and B)', async () => {
    // A: a posting into October 2025 is in flight; the lock of that month waits for it, then locks.
    const held = await heldEntry('2025-10-15');
    const locking = lock('2025-10');
    expect(await settledWithin(locking, 500)).toBe('pending');
    await held.done();
    expect(await locking).toMatchObject({ status: 200, body: { lockedThrough: '2025-10-31' } });
    expect(await entriesOn('2025-10-15')).toBe(1);

    // B: the lock of November 2025 is in flight (held open by the database owner); a posting into November waits, then
    // is refused.
    const proposal = await propose('2025-11-20');
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT 1 FROM crove_finance.period_lock WHERE org_id = $1 FOR UPDATE`, [org.orgId]);
      await client.query(`UPDATE crove_finance.period_lock SET locked_through = '2025-11-30' WHERE org_id = $1`, [org.orgId]);
      const approving = approve(proposal);
      expect(await settledWithin(approving, 500)).toBe('pending');
      await client.query('COMMIT');
      expect(await approving).toMatchObject({ status: 409, body: { code: 'PERIOD_LOCKED', data: { lockedThrough: '2025-11-30', entryDate: '2025-11-20' } } });
    } finally {
      await client.end();
    }
    expect(await entriesOn('2025-11-20')).toBe(0);
  });

  it('checks the roles in the database too: a raw call by a viewer or an admin does not move the lock', async () => {
    const raw = (command: string, who: Account) => runtime.execute(command, { month: '2025-12' }, { actor: asUser(who), orgId: org.orgId });
    await expect(raw('test.period.lock_raw', viewer)).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    await expect(raw('test.period.unlock_raw', adminUser)).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    // The same call by an admin locks (December 2025 follows November), and by the owner unlocks.
    await expect(raw('test.period.lock_raw', adminUser)).resolves.toEqual({ ok: true });
    await expect(raw('test.period.unlock_raw', owner)).resolves.toEqual({ ok: true });
    expect(await state()).toMatchObject({ status: 200, body: { lockedThrough: '2025-11-30' } });
  });

  it('refuses a non-member', async () => {
    expect((await rpc('periodLock/state', await tokenFor(outsider), undefined, org.slug)).status).toBe(403);
    expect((await rpc('periodLock/unlock', await tokenFor(outsider, { mfa: true }), { month: '2025-11', reason: 'x', idempotencyKey: randomUUID() })).status).toBe(403);
  });
});
