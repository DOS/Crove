// Opening balances from Excel (issue #320) on a real PostgreSQL 17, through the HTTP API where a user acts: the preview
// with per-row problems, posting one opening entry (R3: owners and admins, fresh MFA), the one-opening-entry rule and
// replacing an entry by reversing it first, the date rule against other entries, two posts at once, and another org's
// entries staying out of the check. The posting guard keeps the opening entry first for every writer (#366): another
// entry dated on or before it is refused, and an import and a posting in flight wait for each other. The pure rules are in modules/finance/test/opening-balance.test.ts.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { normalizeStatementAmount } from '@crove/kernel-contract';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { kernelCommands, kernelQueries } from '@crove/kernel';
import { Runtime, sha256Hex, type BlobStore } from '@crove/kernel-runtime';
import { financeCommands, financeQueries, OPENING_BALANCE_SOURCE } from '@crove/mod-finance';
import { createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const SECRET = 'test-only-jwt-secret-for-opening-balances-0123456789';
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

const suite = ADMIN ? describe : describe.skip;

suite('opening balances from Excel (#320)', () => {
  const dbName = `crove_test_opening_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let runtime: Runtime;
  let app: ReturnType<typeof createHttpApp>;
  const account = (name: string): Account => ({ subject: randomUUID(), email: `${name}@opening.test`, session: randomUUID(), userId: '' });
  const owner = account('owner');
  const member = account('member');
  const other = account('other');
  let org = { slug: '', orgId: '' };
  let otherOrg = { slug: '', orgId: '' };

  const asMfa = (who: Account) => ({ type: 'user' as const, userId: who.userId, aal: 'aal2' as const, sessionId: who.session, mfaAt: Math.floor(Date.now() / 1000) });

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

  let rowNo = 1;
  const row = (accountCode: string, debit: string, credit: string) => ({ rowNo: ++rowNo, accountCode, accountName: '', debit, credit });
  const balanced = (asOf: string, amount = '100000000') => ({
    asOf,
    rows: [row('111', '40000000', ''), row('112', String(BigInt(amount) - 40000000n), ''), row('411', '', amount)],
  });

  const post = (who: Account, input: unknown, slug = org.slug, idempotencyKey: string = randomUUID()) =>
    tokenFor(who, { mfa: true }).then((token) => rpc('openingBalance/post', token, { ...(input as object), idempotencyKey }, slug));

  // A posted entry that is not an opening entry, written as the superuser (the purchase flow needs an extraction).
  async function plainEntry(orgId: string, entryDate: string) {
    await admin(async (c) => {
      await c.query('BEGIN');
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO crove_finance.journal_entry (org_id, entry_date, description, source_type, source_id) VALUES ($1, $2, 'Bán hàng', 'test.sale', $3) RETURNING id`,
        [orgId, entryDate, randomUUID()],
      );
      const id = rows[0]?.id;
      await c.query(
        `INSERT INTO crove_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit) VALUES ($1, $2, 1, '111', 500, 0), ($1, $2, 2, '511', 0, 500)`,
        [orgId, id],
      );
      await c.query('COMMIT');
    });
  }

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
    const appUrl = new URL(adminUrl);
    appUrl.username = 'crove_app';
    appUrl.password = 'test-app-pw';
    pool = createPool({ connectionString: appUrl.toString(), max: 6 });
    db = createDb(pool);
    runtime = new Runtime(db, { manifests: TEST_MANIFESTS, sessions: createSessionStatusSource('off'), stepUp: 'required' }).register({
      commands: [...kernelCommands, ...financeCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries],
    });
    const config = loadConfig({
      DATABASE_URL: appUrl.toString(),
      AUTH_JWT_SECRET: SECRET,
      AUTH_ISSUER: ISSUER,
      AUTH_SESSION_CHECK: 'off',
      MIGRATIONS_DIR: MIGRATIONS,
      WEB_DIST: '/nonexistent',
    });
    app = createHttpApp({ config, runtime, store: new MemoryStore(), authenticate: createAuthenticator(config, db), pool, aiEnabled: false });

    for (const who of [owner, member, other]) {
      const me = await rpc('me/get', await tokenFor(who), undefined, null);
      expect(me.status).toBe(200);
      who.userId = String(me.body?.userId);
    }
    const created = await rpc('org/create', await tokenFor(owner), { name: 'Công ty Số dư đầu kỳ', idempotencyKey: randomUUID() }, null);
    org = { slug: String(created.body?.slug), orgId: String(created.body?.orgId) };
    const invite = await rpc('org/invite', await tokenFor(owner, { mfa: true }), { email: member.email, role: 'member' });
    expect((await rpc('invites/accept', await tokenFor(member), { token: String(invite.body?.acceptPath).split('#')[1] }, null)).status).toBe(200);
    const second = await rpc('org/create', await tokenFor(other), { name: 'Công ty Khác', idempotencyKey: randomUUID() }, null);
    otherOrg = { slug: String(second.body?.slug), orgId: String(second.body?.orgId) };
  });

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  // Shared by the tests below, in order.
  let firstEntry = '';

  it('previews a trial balance with per-row problems and writes nothing', async () => {
    const preview = await rpc('openingBalance/preview', await tokenFor(owner), {
      asOf: '2025-12-31',
      rows: [row('111', '1.5', ''), row('9999', '5', ''), row('411', '', '1000'), row('411', '', '5'), row('', '', '')],
    });
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({
      ok: false,
      // Rows with an invalid amount count for nothing.
      errors: ['UNBALANCED'],
      totals: { debit: '5', credit: '1005', difference: '-1000' },
      openingEntry: null,
      firstEntryDate: null,
      lines: 0,
    });
    expect(preview.body.rows.map((r: any) => [r.accountCode, r.accountName, r.errors, r.skipped])).toEqual([
      ['111', 'Tiền mặt', ['AMOUNT_FRACTION'], false],
      ['9999', '', ['ACCOUNT_UNKNOWN'], false],
      ['411', 'Vốn đầu tư của chủ sở hữu', ['ACCOUNT_DUPLICATE'], false],
      ['411', 'Vốn đầu tư của chủ sở hữu', ['ACCOUNT_DUPLICATE'], false],
      ['', '', [], true],
    ]);
    // Members and viewers do not post, so they do not preview either.
    expect(await rpc('openingBalance/preview', await tokenFor(member), balanced('2025-12-31'))).toMatchObject({ status: 403, body: { code: 'FORBIDDEN' } });
    expect(await admin((c) => c.query('SELECT count(*)::int AS n FROM crove_finance.journal_entry WHERE org_id = $1', [org.orgId]))).toMatchObject({
      rows: [{ n: 0 }],
    });
  });

  it('posts one opening entry: R3 for owners and admins, refused while invalid, retried by its key', async () => {
    const input = balanced('2025-12-31');
    // A member may not post; an owner needs a fresh second factor.
    expect(await post(member, input)).toMatchObject({ status: 403, body: { code: 'FORBIDDEN' } });
    expect(await rpc('openingBalance/post', await tokenFor(owner), { ...input, idempotencyKey: randomUUID() })).toMatchObject({
      status: 403,
      body: { code: 'STEP_UP_REQUIRED' },
    });
    // The server checks again whatever the preview said.
    expect(await post(owner, { asOf: '2025-12-31', rows: [row('111', '100', ''), row('411', '', '99')] })).toMatchObject({
      status: 422,
      body: { code: 'UNBALANCED', data: { difference: '1' } },
    });
    expect(await post(owner, { asOf: '2025-12-31', rows: [row('111', '100', ''), row('9999', '', '100')] })).toMatchObject({
      status: 422,
      body: { code: 'OPENING_BALANCE_INVALID' },
    });

    const key = randomUUID();
    const posted = await post(owner, input, org.slug, key);
    expect(posted).toMatchObject({ status: 200, body: { journalEntryId: expect.any(String), lines: 3 } });
    firstEntry = String(posted.body.journalEntryId);
    // A retry with the same key returns the first result instead of a second entry or a refusal.
    expect((await post(owner, input, org.slug, key)).body).toEqual(posted.body);

    const entry = await rpc('journal/get', await tokenFor(member), { id: firstEntry });
    expect(entry.body).toMatchObject({
      entryDate: '2025-12-31',
      description: 'Số dư đầu kỳ tại ngày 2025-12-31',
      sourceType: OPENING_BALANCE_SOURCE,
      lines: [
        { lineNo: 1, accountCode: '111', debit: '40000000.0000', credit: '0.0000' },
        { lineNo: 2, accountCode: '112', debit: '60000000.0000', credit: '0.0000' },
        { lineNo: 3, accountCode: '411', debit: '0.0000', credit: '100000000.0000' },
      ],
    });
    const audit = await admin((c) =>
      c.query(`SELECT outcome, detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'finance.opening_balance.post' AND outcome = 'ok'`, [org.orgId]),
    );
    expect(audit.rows).toEqual([
      expect.objectContaining({ detail: expect.objectContaining({ as_of: '2025-12-31', lines: 3, total_debit: '100000000', aal: 'aal2' }) }),
    ]);
  });

  it('keeps one opening entry per org until it is reversed', async () => {
    expect(await post(owner, balanced('2025-12-31', '200000000'))).toMatchObject({
      status: 409,
      body: { code: 'OPENING_BALANCE_EXISTS', data: { entryId: firstEntry } },
    });
    const preview = await rpc('openingBalance/preview', await tokenFor(owner), balanced('2025-12-31'));
    expect(preview.body).toMatchObject({ ok: false, errors: ['OPENING_EXISTS'], openingEntry: { id: firstEntry, entryDate: '2025-12-31' } });

    // An opening entry is reversed on its own date only, so it never counts twice next to the next one.
    expect(
      await rpc('inbox/request', await tokenFor(owner), {
        command: 'finance.journal.reverse',
        input: { entryId: firstEntry, entryDate: '2026-01-15', reason: 'Nhập sai số dư tiền gửi' },
        idempotencyKey: randomUUID(),
      }),
    ).toMatchObject({ status: 422, body: { code: 'OPENING_REVERSAL_DATE', data: { entryDate: '2025-12-31' } } });
    // Reverse it the usual way (a proposal approved under R3), on its date, then import again.
    const asked = await rpc('inbox/request', await tokenFor(owner), {
      command: 'finance.journal.reverse',
      input: { entryId: firstEntry, entryDate: '2025-12-31', reason: 'Nhập sai số dư tiền gửi' },
      idempotencyKey: randomUUID(),
    });
    const approved = await rpc('inbox/approve', await tokenFor(owner, { mfa: true }), { acceptUnverifiedSignature: true, id: asked.body.proposalId, revision: 1, idempotencyKey: randomUUID() });
    expect(approved).toMatchObject({ status: 200, body: { reversedEntryId: firstEntry } });

    // The old entry and its reversal are not "other entries": the same date is still before everything else.
    expect((await rpc('openingBalance/preview', await tokenFor(owner), balanced('2025-12-31', '200000000'))).body).toMatchObject({
      ok: true,
      errors: [],
      openingEntry: null,
      firstEntryDate: null,
    });
    const replaced = await post(owner, balanced('2025-12-31', '200000000'));
    expect(replaced).toMatchObject({ status: 200, body: { lines: 3 } });
    expect(replaced.body.journalEntryId).not.toBe(firstEntry);
  });

  it('dates the opening balances before every other entry', async () => {
    await plainEntry(otherOrg.orgId, '2026-01-05');
    // Another org's entries are not this org's; neither is its opening entry.
    const preview = await rpc('openingBalance/preview', await tokenFor(owner), balanced('2026-03-01'));
    expect(preview.body).toMatchObject({ firstEntryDate: null, errors: ['OPENING_EXISTS'] });

    expect(await post(other, balanced('2026-01-05'), otherOrg.slug)).toMatchObject({
      status: 422,
      body: { code: 'OPENING_BALANCE_AFTER_ENTRIES', data: { firstEntryDate: '2026-01-05' } },
    });
    expect(await post(other, balanced('2026-01-04'), otherOrg.slug)).toMatchObject({ status: 200 });
    // Not a member of the first org.
    expect((await rpc('openingBalance/preview', await tokenFor(other), balanced('2025-12-31'))).status).toBe(403);
  });

  it('posts at most one of two opening entries sent at once', async () => {
    const third = await rpc('org/create', await tokenFor(owner), { name: 'Công ty Đồng thời', idempotencyKey: randomUUID() }, null);
    const orgId = String(third.body?.orgId);
    const results = await Promise.allSettled(
      ['100000000', '300000000'].map((amount) =>
        runtime.execute('finance.opening_balance.post', balanced('2025-12-31', amount), { actor: asMfa(owner), orgId, idempotencyKey: randomUUID() }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({ reason: { code: 'OPENING_BALANCE_EXISTS' } });
    const { rows } = await admin((c) =>
      c.query('SELECT count(*)::int AS n FROM crove_finance.journal_entry WHERE org_id = $1 AND source_type = $2', [orgId, OPENING_BALANCE_SOURCE]),
    );
    expect(rows).toEqual([{ n: 1 }]);
  });

  // The opening entry stays first for every writer (#366): the posting guard refuses an entry dated on or before the
  // opening entry in force, and an opening entry dated on or after another entry, whatever the path.
  // Waits until a backend of this database posting through post_journal_entry() waits on a lock (a row lock of the
  // guard), so a test knows the posting is held by the lock under test rather than by a timer.
  async function waitForPostingLock() {
    await admin(async (c) => {
      for (let i = 0; i < 400; i++) {
        const { rows } = await c.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_catalog.pg_stat_activity
           WHERE datname = pg_catalog.current_database() AND wait_event_type = 'Lock' AND query LIKE '%post_journal_entry%'`,
        );
        if ((rows[0]?.n ?? 0) > 0) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error('no posting waited on a lock');
    });
  }

  // A balanced entry written as the superuser in its own transaction (any writer: the guard runs for every role); the
  // database error, or null once committed.
  async function rawEntry(orgId: string, entryDate: string, sourceType = 'test.sale'): Promise<{ code: string | undefined; message: string; detail: string | undefined } | null> {
    return admin(async (c) => {
      await c.query('BEGIN');
      try {
        const { rows } = await c.query<{ id: string }>(
          `INSERT INTO crove_finance.journal_entry (org_id, entry_date, description, source_type, source_id) VALUES ($1, $2, 'Thử', $3, $4) RETURNING id`,
          [orgId, entryDate, sourceType, randomUUID()],
        );
        await c.query(
          `INSERT INTO crove_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit) VALUES ($1, $2, 1, '111', 500, 0), ($1, $2, 2, '411', 0, 500)`,
          [orgId, rows[0]?.id],
        );
        await c.query('COMMIT');
        return null;
      } catch (error) {
        await c.query('ROLLBACK');
        const e = error as { code?: string; message: string; detail?: string };
        return { code: e.code, message: e.message, detail: e.detail };
      }
    });
  }

  // A cash payment of an expense (no party needed), asked and approved by the owner; the approval's answer.
  const voucher = async (date: string, slug = org.slug) => {
    const asked = await rpc(
      'inbox/request',
      await tokenFor(owner),
      {
        command: 'finance.voucher.record',
        input: { type: 'cash_payment', date, cashAccount: '1111', description: 'Chi tiền văn phòng phẩm', lines: [{ account: '6422', amount: '100000' }] },
        idempotencyKey: randomUUID(),
      },
      slug,
    );
    expect(asked.status, JSON.stringify(asked.body)).toBe(200);
    return rpc('inbox/approve', await tokenFor(owner, { mfa: true }), { acceptUnverifiedSignature: true, id: asked.body.proposalId, revision: 1, idempotencyKey: randomUUID() }, slug);
  };

  it('refuses any other entry dated on or before the opening entry, for every writer (#366)', async () => {
    // The org's opening entry in force is dated 2025-12-31 (replaced above).
    expect(await rawEntry(org.orgId, '2025-12-31')).toMatchObject({ code: '55000', message: 'BEFORE_OPENING_BALANCE', detail: expect.stringContaining('2025-12-31') });
    expect(await rawEntry(org.orgId, '2025-06-30')).toMatchObject({ code: '55000', message: 'BEFORE_OPENING_BALANCE' });
    // A second opening entry dated earlier is no way around it: refused while the first stands.
    expect(await rawEntry(org.orgId, '2025-12-30', OPENING_BALANCE_SOURCE)).toMatchObject({ code: '55000', message: 'OPENING_BALANCE_EXISTS' });

    // The opening entry's reversal is exempt only on the opening date: dated earlier, it is held to the rule. (The
    // guard runs first; nothing is written.)
    const opening = await admin(async (c) =>
      (
        await c.query<{ id: string }>(
          `SELECT id FROM crove_finance.journal_entry o WHERE org_id = $1 AND source_type = $2
           AND NOT EXISTS (SELECT 1 FROM crove_finance.journal_entry r WHERE r.org_id = o.org_id AND r.reverses_entry_id = o.id)`,
          [org.orgId, OPENING_BALANCE_SOURCE],
        )
      ).rows[0]?.id,
    );
    const earlyReversal = await admin(async (c) =>
      c
        .query(
          `INSERT INTO crove_finance.journal_entry (org_id, entry_date, description, source_type, source_id, reverses_entry_id) VALUES ($1, '2025-12-30', 'Đảo', 'kernel.proposal', $2, $3)`,
          [org.orgId, randomUUID(), opening],
        )
        .then(
          () => null,
          (error: { code?: string; message: string }) => ({ code: error.code, message: error.message }),
        ),
    );
    expect(earlyReversal).toEqual({ code: '55000', message: 'BEFORE_OPENING_BALANCE' });

    // Through a command: refused with the dates, and posted the day after.
    const refused = await voucher('2025-12-31');
    expect(refused).toMatchObject({
      status: 409,
      body: { code: 'BEFORE_OPENING_BALANCE', data: { openingDate: '2025-12-31', entryDate: '2025-12-31', rule: 'before_opening_later_date' } },
    });
    expect(refused.body.message).toContain('31/12/2025');
    expect((await voucher('2026-01-01')).status).toBe(200);
    expect(await rawEntry(org.orgId, '2026-01-01')).toBeNull();
  });

  it('lets the opening entry be reversed on its own date and re-imported earlier, and then holds the new date', async () => {
    const fresh = await rpc('org/create', await tokenFor(owner), { name: 'Công ty Đảo số dư', idempotencyKey: randomUUID() }, null);
    const slug = String(fresh.body?.slug);
    const orgId = String(fresh.body?.orgId);
    const posted = await post(owner, balanced('2025-12-31'), slug);
    expect(posted.status).toBe(200);
    const asked = await rpc(
      'inbox/request',
      await tokenFor(owner),
      { command: 'finance.journal.reverse', input: { entryId: posted.body.journalEntryId, entryDate: '2025-12-31', reason: 'Sai ngày' }, idempotencyKey: randomUUID() },
      slug,
    );
    // The reversal is dated on the opening date, which the rule exempts: it goes with the entry it cancels.
    expect((await rpc('inbox/approve', await tokenFor(owner, { mfa: true }), { acceptUnverifiedSignature: true, id: asked.body.proposalId, revision: 1, idempotencyKey: randomUUID() }, slug)).status).toBe(200);
    // Nothing in force any more: an entry on that date posts, and the new opening entry must come before it.
    expect(await rawEntry(orgId, '2025-12-31')).toBeNull();
    expect(await post(owner, balanced('2025-12-31'), slug)).toMatchObject({ status: 422, body: { code: 'OPENING_BALANCE_AFTER_ENTRIES' } });
    expect((await post(owner, balanced('2025-11-30'), slug)).status).toBe(200);
    expect(await rawEntry(orgId, '2025-11-30')).toMatchObject({ message: 'BEFORE_OPENING_BALANCE' });
  });

  it('makes an opening import and a posting in flight wait for each other, and refuses the second (#366)', async () => {
    const fresh = await rpc('org/create', await tokenFor(owner), { name: 'Công ty Cùng lúc', idempotencyKey: randomUUID() }, null);
    const slug = String(fresh.body?.slug);
    const orgId = String(fresh.body?.orgId);
    // A first entry, after every date below, creates the org's period_lock row, so the postings below meet on its row
    // lock (on a fresh org they would meet on the row's unique index instead, whatever lock the guard takes).
    expect(await rawEntry(orgId, '2026-03-01')).toBeNull();
    // Holds a balanced entry dated `entryDate` open as the superuser, until the returned client commits or rolls back.
    const hold = async (entryDate: string, sourceType: string) => {
      const client = new pg.Client({ connectionString: adminUrl });
      await client.connect();
      await client.query('BEGIN');
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO crove_finance.journal_entry (org_id, entry_date, description, source_type, source_id) VALUES ($1, $2, 'Thử', $3, $4) RETURNING id`,
        [orgId, entryDate, sourceType, randomUUID()],
      );
      await client.query(
        `INSERT INTO crove_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit) VALUES ($1, $2, 1, '111', 500, 0), ($1, $2, 2, '411', 0, 500)`,
        [orgId, rows[0]?.id],
      );
      return client;
    };

    // A posting dated 2026-01-10 in flight: the opening import of 2026-01-31 passes its own check (it cannot see the
    // posting yet), then waits in the guard, and is refused once the posting commits.
    let client = await hold('2026-01-10', 'test.sale');
    try {
      const importing = post(owner, balanced('2026-01-31'), slug);
      await waitForPostingLock();
      await client.query('COMMIT');
      expect(await importing).toMatchObject({ status: 422, body: { code: 'OPENING_BALANCE_AFTER_ENTRIES', data: { firstEntryDate: '2026-01-10' } } });
    } finally {
      await client.end();
    }

    // An opening entry dated 2026-01-05 in flight: a voucher dated on it waits, then is refused once it commits.
    client = await hold('2026-01-05', OPENING_BALANCE_SOURCE);
    try {
      const posting = voucher('2026-01-05', slug);
      await waitForPostingLock();
      await client.query('COMMIT');
      expect(await posting).toMatchObject({ status: 409, body: { code: 'BEFORE_OPENING_BALANCE', data: { openingDate: '2026-01-05' } } });
    } finally {
      await client.end();
    }
    const { rows } = await admin((c) =>
      c.query<{ entry_date: string; source_type: string }>(
        `SELECT entry_date::text, source_type FROM crove_finance.journal_entry WHERE org_id = $1 ORDER BY entry_date, source_type`,
        [orgId],
      ),
    );
    expect(rows).toEqual([
      { entry_date: '2026-01-05', source_type: OPENING_BALANCE_SOURCE },
      { entry_date: '2026-01-10', source_type: 'test.sale' },
      { entry_date: '2026-03-01', source_type: 'test.sale' },
    ]);
  });
  it('splits 131 and 331 per customer and vendor: the per-party report and a bank line find the opening balances (#689)', async () => {
    const fresh = await rpc('org/create', await tokenFor(owner), { name: 'Công ty Công nợ đầu kỳ', idempotencyKey: randomUUID() }, null);
    const slug = String(fresh.body?.slug);
    const orgId = String(fresh.body?.orgId);
    // A vendor already in the books is reused by its tax code; the others are created. Fake tax codes only.
    const known = randomUUID();
    await admin((c) => c.query(`INSERT INTO crove_kernel.party (org_id, id, name, tax_code) VALUES ($1, $2, 'Nhà cung cấp Cũ', '0312345670')`, [orgId, known]));
    const party = (accountCode: string, debit: string, credit: string, partyTaxCode: string, partyName: string) => ({
      ...row(accountCode, debit, credit),
      ...(partyTaxCode ? { partyTaxCode } : {}),
      ...(partyName ? { partyName } : {}),
    });
    const input = {
      asOf: '2025-12-31',
      rows: [
        row('112', '100000000', ''),
        party('131', '30000000', '', '0101234564', 'Công ty Khách A'),
        party('131', '5000000', '', '', 'Khách lẻ'),
        // The rest of 131 that the firm cannot split yet.
        row('131', '2000000', ''),
        party('331', '', '25000000', '0312345670', 'Tên khác trong bảng'),
        row('411', '', '112000000'),
      ],
    };
    // A party on another account is refused, and nothing is created while the sheet is refused.
    const refused = await post(owner, { ...input, rows: [...input.rows.slice(0, -1), party('411', '', '112000000', '0309876546', '')] }, slug);
    expect(refused).toMatchObject({ status: 422, body: { code: 'OPENING_BALANCE_INVALID' } });
    expect((await admin((c) => c.query('SELECT count(*)::int AS n FROM crove_kernel.party WHERE org_id = $1', [orgId]))).rows[0].n).toBe(1);

    const preview = await rpc('openingBalance/preview', await tokenFor(owner), input, slug);
    expect(preview.body).toMatchObject({ ok: true, lines: 6 });
    expect(preview.body.rows.map((r: any) => [r.accountCode, r.partyTaxCode, r.partyName])).toEqual([
      ['112', null, null],
      ['131', '0101234564', 'Công ty Khách A'],
      ['131', null, 'Khách lẻ'],
      ['131', null, null],
      ['331', '0312345670', 'Tên khác trong bảng'],
      ['411', null, null],
    ]);
    const posted = await post(owner, input, slug);
    expect(posted).toMatchObject({ status: 200, body: { lines: 6 } });

    const parties = await admin(
      async (c) => (await c.query<{ id: string; name: string; tax_code: string | null }>('SELECT id, name, tax_code FROM crove_kernel.party WHERE org_id = $1 ORDER BY name', [orgId])).rows,
    );
    expect(parties.map((p) => [p.name, p.tax_code])).toEqual([
      ['Công ty Khách A', '0101234564'],
      ['Khách lẻ', null],
      ['Nhà cung cấp Cũ', '0312345670'],
    ]);
    const idOf = (name: string) => parties.find((p) => p.name === name)?.id;
    const lines = await admin(
      async (c) =>
        (await c.query('SELECT account_code, party_id, debit::text, credit::text FROM crove_finance.journal_line WHERE org_id = $1 AND entry_id = $2 ORDER BY line_no', [orgId, posted.body.journalEntryId]))
          .rows,
    );
    expect(lines.map((l) => [l.account_code, l.party_id])).toEqual([
      ['112', null],
      ['131', idOf('Công ty Khách A')],
      ['131', idOf('Khách lẻ')],
      ['131', null],
      ['331', known],
      ['411', null],
    ]);
    const audit = await admin((c) => c.query(`SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'finance.opening_balance.post' AND outcome = 'ok'`, [orgId]));
    expect(audit.rows[0].detail).toMatchObject({ lines: 6, parties: 3 });

    // The receivables and payables report of the next month opens with each party's balance and the unallocated rest.
    const ledger = await rpc('ledger/period', await tokenFor(owner), { period: '2026-01' }, slug);
    expect(ledger.status).toBe(200);
    expect(ledger.body.receivables.rows.map((r: any) => [r.partyId, r.opening, r.closing])).toEqual([
      [idOf('Công ty Khách A'), '30000000', '30000000'],
      [idOf('Khách lẻ'), '5000000', '5000000'],
      [null, '2000000', '2000000'],
    ]);
    expect(ledger.body.payables.rows.map((r: any) => [r.partyId, r.opening])).toEqual([[known, '25000000']]);

    // A payment in January of the vendor's opening balance, with nothing in the description to name it, is matched
    // by that balance.
    const imported = await rpc(
      'bank/import',
      await tokenFor(owner),
      {
        bankAccount: '1121',
        filename: 'sao-ke-01.xlsx',
        rows: [
          {
            rowNo: 2,
            date: '05/01/2026',
            description: 'CHUYEN KHOAN THANH TOAN',
            moneyIn: '',
            moneyOut: normalizeStatementAmount('25.000.000'),
            balance: '',
            reference: 'FT689',
          },
        ],
        idempotencyKey: randomUUID(),
      },
      slug,
    );
    expect(imported.status).toBe(200);
    const [line] = (await admin((c) => c.query<{ id: string }>('SELECT id FROM crove_finance.bank_line WHERE org_id = $1', [orgId]))).rows;
    const suggested = await rpc('bank/lineVoucher', await tokenFor(owner), { bankLineId: line?.id }, slug);
    expect(suggested.body).toMatchObject({ voucher: { counterAccount: '331', amount: '25000000' }, suggested: { party: { id: known }, reason: 'balance' } });
  });
});
