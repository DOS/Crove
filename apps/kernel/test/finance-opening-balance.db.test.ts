// Opening balances from Excel (issue #320) on a real PostgreSQL 17, through the HTTP API where a user acts: the preview
// with per-row problems, posting one opening entry (R3: owners and admins, fresh MFA), the one-opening-entry rule and
// replacing an entry by reversing it first, the date rule against other entries, two posts at once, and another org's
// entries staying out of the check. The pure rules are in modules/finance/test/opening-balance.test.ts.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { kernelCommands, kernelQueries } from '@crove/kernel';
import { Runtime, sha256Hex, type BlobStore } from '@crove/kernel-runtime';
import { financeCommands, financeQueries, OPENING_BALANCE_SOURCE } from '@crove/mod-finance';
import { createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { createSessionStatusSource } from '../src/sessions.ts';

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
    runtime = new Runtime(db, { sessions: createSessionStatusSource('off'), stepUp: 'required' }).register({
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
    const approved = await rpc('inbox/approve', await tokenFor(owner, { mfa: true }), { id: asked.body.proposalId, revision: 1, idempotencyKey: randomUUID() });
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
});
