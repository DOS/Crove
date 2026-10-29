// Period lock (issue #329), on a real PostgreSQL 17, through the HTTP API: lock a month, then posting, approving and
// reversing into it are refused with PERIOD_LOCKED; months lock in order and unlock newest first; unlock is the
// owner's alone, R3 with a reason on the audit row; the database guard holds for the database owner too; a lock
// and a posting in flight wait for each other (ADR-0021 cases A and B); and a lock or unlock and a change of the
// caller's role or permission wait for each other (#1348), without a deadlock under the accountant preset (#1922).
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
import { vietnamMonth } from '@crove/kernel-contract';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { kernelCommands, kernelQueries } from '@crove/kernel';
import { Runtime, defineCommand, fileKey, sha256Hex, type BlobStore } from '@crove/kernel-runtime';
import { extractAndPropose, financeCommands, financeQueries } from '@crove/mod-finance';
import { createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { z } from 'zod';
import { inProcessExtract } from './extract-service.ts';
import { enterUser } from './context-token.ts';
import { TEST_MANIFESTS } from './manifests.ts';

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
    sideEffect: 'none',
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
    rpc('inbox/approve', await tokenFor(who, { mfa: true }), { acceptUnverifiedSignature: true, id: proposalId, revision: 1, idempotencyKey: randomUUID() }, slug);

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
      new Runtime(target, { manifests: TEST_MANIFESTS, ...(sessions ? { sessions: createSessionStatusSource('off'), stepUp: 'required' } : {}) }).register({
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
        { id: pending, revision: 1, acceptUnverifiedSignature: true },
        { id: september, revision: 1, acceptUnverifiedSignature: true },
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
    // The month in progress is refused by the database too, for a caller who may lock (the other org has nothing locked,
    // so any month may come first).
    const current = runtime.execute('test.period.lock_raw', { month: vietnamMonth(new Date()) }, { actor: asUser(outsider), orgId: otherOrg.orgId });
    await expect(current).rejects.toMatchObject({ status: 500 });
    expect(await state(outsider, otherOrg)).toMatchObject({ status: 200, body: { lockedThrough: null } });
  });

  // The lock functions lock the caller's membership before their role and permission checks (#1348), as the role and
  // permission commands lock the member rows before they change them. A revoke or demotion in flight (its member row
  // locked FOR UPDATE, its change not committed) makes the lock or unlock wait, which then reads the change and is
  // refused; one that starts after the unlock waits for it. Raw calls in the admin's context, as the commands make them.
  it("serializes the lock and unlock with a change of the caller's role or permission (#1348)", async () => {
    const appLogin = new URL(adminUrl);
    appLogin.username = 'crove_app';
    appLogin.password = 'test-app-pw';
    const grant = () =>
      admin(
        async (c) =>
          (
            await c.query<{ id: string }>(
              `INSERT INTO crove_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by)
               VALUES ($1, $2, 'finance.chief_accountant', NULL, $3) RETURNING id`,
              [org.orgId, adminUser.userId, owner.userId],
            )
          ).rows[0]?.id as string,
      );
    // A change of the admin's member row held open by the database owner, as the commands hold it.
    const held = async (change: (c: pg.Client) => Promise<unknown>) => {
      const c = new pg.Client({ connectionString: adminUrl });
      await c.connect();
      await c.query('BEGIN');
      await c.query('SELECT 1 FROM crove_kernel.tenant_member WHERE org_id = $1 AND user_id = $2 FOR UPDATE', [org.orgId, adminUser.userId]);
      await change(c);
      return c;
    };
    // The admin's own transaction, in its context; the call is left in flight.
    const asAdmin = async () => {
      const c = new pg.Client({ connectionString: appLogin.toString() });
      await c.connect();
      await c.query('BEGIN');
      await enterUser(c, adminUser.userId, org.orgId);
      return c;
    };
    const refusal = (call: Promise<unknown>) => call.then(() => 'done', (error: Error) => error.message);
    const clients: pg.Client[] = [];
    try {
      // The chief accountant role is revoked while the admin unlocks November 2025: the unlock waits, then is refused.
      const first = await grant();
      const revoking = await held((c) => c.query('DELETE FROM crove_kernel.role_assignment WHERE org_id = $1 AND id = $2', [org.orgId, first]));
      clients.push(revoking);
      const unlocker = await asAdmin();
      clients.push(unlocker);
      const unlocking = refusal(unlocker.query(`SELECT crove_finance.unlock_period('2025-11-01'::date, NULL::uuid)`));
      expect(await settledWithin(unlocking, 500)).toBe('pending');
      await revoking.query('COMMIT');
      expect(await unlocking).toBe('PERIOD_LOCK_FORBIDDEN');
      await unlocker.query('ROLLBACK');

      // With the role again, the unlock goes first: the member-row lock a revoke takes first then waits for it.
      await grant();
      const second = await asAdmin();
      clients.push(second);
      await expect(second.query(`SELECT crove_finance.unlock_period('2025-11-01'::date, NULL::uuid)`)).resolves.toBeDefined();
      const later = new pg.Client({ connectionString: adminUrl });
      await later.connect();
      clients.push(later);
      await later.query('BEGIN');
      const locking = later.query('SELECT 1 FROM crove_kernel.tenant_member WHERE org_id = $1 AND user_id = $2 FOR UPDATE', [org.orgId, adminUser.userId]);
      expect(await settledWithin(locking, 500)).toBe('pending');
      await second.query('ROLLBACK');
      await locking;
      await later.query('ROLLBACK');

      // The admin is made a member while locking December 2025: the lock waits, then is refused.
      const demoting = await held((c) => c.query(`UPDATE crove_kernel.tenant_member SET role = 'member' WHERE org_id = $1 AND user_id = $2`, [org.orgId, adminUser.userId]));
      clients.push(demoting);
      const locker = await asAdmin();
      clients.push(locker);
      const lockingMonth = refusal(locker.query(`SELECT crove_finance.lock_period('2025-12-01'::date, NULL::uuid)`));
      expect(await settledWithin(lockingMonth, 500)).toBe('pending');
      await demoting.query('COMMIT');
      expect(await lockingMonth).toBe('PERIOD_LOCK_FORBIDDEN');
      await locker.query('ROLLBACK');
    } finally {
      for (const c of clients) {
        await c.query('ROLLBACK').catch(() => {});
        await c.end().catch(() => {});
      }
      await admin(async (c) => {
        await c.query(`UPDATE crove_kernel.tenant_member SET role = 'admin' WHERE org_id = $1 AND user_id = $2`, [org.orgId, adminUser.userId]);
        await c.query(`DELETE FROM crove_kernel.role_assignment WHERE org_id = $1 AND user_id = $2 AND role_key = 'finance.chief_accountant'`, [
          org.orgId,
          adminUser.userId,
        ]);
      });
    }
    expect(await state()).toMatchObject({ status: 200, body: { lockedThrough: '2025-11-30' } });
  });

  // In an org on the accountant preset, a revoke of a chief accountant runs the keep guard, which serializes on the
  // org's tenant row (#1922). It used to take that row FOR UPDATE, which waits for every command of the org in flight
  // (their idempotency rows hold it FOR KEY SHARE): an owner's unlock in flight, which then locks its member row, which
  // the revoke holds, was a deadlock. The guard now takes FOR NO KEY UPDATE: the revoke does not wait for the unlock,
  // and the unlock goes through after it. The owner unlocks in a session that holds the row FOR KEY SHARE, as the
  // command's idempotency row does, while the owner revokes the admin's role through the command.
  it('lets a revoke under the accountant preset and an unlock in flight both finish (#1922)', async () => {
    const grant = (who: Account) =>
      admin(
        async (c) =>
          (
            await c.query<{ id: string }>(
              `INSERT INTO crove_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by)
               VALUES ($1, $2, 'finance.chief_accountant', NULL, $3) RETURNING id`,
              [org.orgId, who.userId, owner.userId],
            )
          ).rows[0]?.id as string,
      );
    // Two chief accountants, so that the revoke of one keeps the preset's rule.
    await grant(owner);
    const revoked = await grant(adminUser);
    await admin((c) => c.query(`UPDATE crove_kernel.tenant SET approval_preset = 'accountant' WHERE org_id = $1`, [org.orgId]));
    const unlocker = new pg.Client({ connectionString: adminUrl });
    await unlocker.connect();
    try {
      await unlocker.query('BEGIN');
      await enterUser(unlocker, owner.userId, org.orgId);
      await unlocker.query('SELECT 1 FROM crove_kernel.tenant WHERE org_id = $1 FOR KEY SHARE', [org.orgId]);
      const fresh = { type: 'user' as const, userId: owner.userId, aal: 'aal2' as const, sessionId: owner.session, mfaAt: Math.floor(Date.now() / 1000) };
      let settled = false;
      const revoking = runtime.execute('kernel.member.role.revoke', { assignmentId: revoked }, { actor: fresh, orgId: org.orgId }).then(
        (value) => {
          settled = true;
          return value;
        },
        (error: { code?: string }) => {
          settled = true;
          return error.code;
        },
      );
      // The revoke finishes, or (the old guard) waits for the unlocker's row lock; then the unlocker locks its member row.
      for (let tries = 0; !settled; tries++) {
        const { rows } = await admin((c) =>
          c.query(
            `SELECT 1 FROM pg_catalog.pg_locks l JOIN pg_catalog.pg_stat_activity a ON a.pid = l.pid
             WHERE NOT l.granted AND a.usename = 'crove_app' AND a.datname = pg_catalog.current_database()`,
          ),
        );
        if (rows.length > 0) break;
        if (tries > 400) throw new Error('the revoke neither finished nor waited');
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const unlocking = unlocker.query<{ through: string | null }>(`SELECT crove_finance.unlock_period('2025-11-01'::date, NULL::uuid)::text AS through`).then(
        (r) => r.rows[0]?.through,
        (error: Error) => error.message,
      );
      expect(await revoking).toEqual({ assignmentId: revoked });
      expect(await unlocking).toBe('2025-10-31');
    } finally {
      await unlocker.query('ROLLBACK').catch(() => {});
      await unlocker.end();
      await admin(async (c) => {
        await c.query(`UPDATE crove_kernel.tenant SET approval_preset = 'founder' WHERE org_id = $1`, [org.orgId]);
        await c.query(`DELETE FROM crove_kernel.role_assignment WHERE org_id = $1 AND role_key = 'finance.chief_accountant'`, [org.orgId]);
      });
    }
    expect(await state()).toMatchObject({ status: 200, body: { lockedThrough: '2025-11-30' } });
  });

  it('refuses a non-member', async () => {
    expect((await rpc('periodLock/state', await tokenFor(outsider), undefined, org.slug)).status).toBe(403);
    expect((await rpc('periodLock/unlock', await tokenFor(outsider, { mfa: true }), { month: '2025-11', reason: 'x', idempotencyKey: randomUUID() })).status).toBe(403);
  });
});
