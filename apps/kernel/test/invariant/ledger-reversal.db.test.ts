// Journal entry reversal (issue #138, External-tenant gate T3) on a real PostgreSQL 17. A reversal is a new entry
// posted through crove_finance.post_journal_entry() whose lines mirror the original's; the pair nets to zero per
// account. It is a posting, so it runs only through an approved proposal (R3: P10 four-eyes, P11 step-up, P12), an
// entry is reversed at most once even under concurrency, a reversal is never reversed, and the database holds every
// writer to the mirror rules, counting lines the caller cannot see.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; the run creates and drops its own database.
// Part of the invariant suite: CI runs this file from the base branch on protected-path PRs (AGENTS.md).
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { financeCommands, financeQueries } from '@crove/mod-finance';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
// Lines with this memo are invisible to every tenant role (a stand-in for legal-entity policies, as in #76).
const HIDDEN = 'outside-legal-entity-scope-138';
const ROLES = ['crove_app', 'crove_worker', 'crove_tenant', 'crove_definer_tenant', 'crove_auth_reader'];

type Line = { line_no: number; account_code: string; debit: string; credit: string; party_id?: string | null; memo?: string | null };

const mirror = (lines: Line[]): Line[] => lines.map((l) => ({ ...l, debit: l.credit, credit: l.debit }));

const suite = ADMIN ? describe : describe.skip;

suite('journal reversal on PostgreSQL (#138)', () => {
  const dbName = `crove_test_reversal_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let pool: pg.Pool;
  let runtime: Runtime;
  const clients: pg.Client[] = [];
  const users = { solo: '', owner: '', admin: '', member: '', viewer: '' };
  // solo: one owner, who may self-approve (flagged). team: owner and admin are two eligible approvers (four-eyes).
  let solo = '';
  let team = '';

  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const asMfa = (userId: string) => ({
    type: 'user' as const,
    userId,
    aal: 'aal2' as const,
    sessionId: '0f6c3a52-8d3b-4c1e-9a77-5b2f0e9d1c00',
    mfaAt: Math.floor(Date.now() / 1000),
  });

  async function connect(url: string): Promise<pg.Client> {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    clients.push(client);
    return client;
  }

  async function withAdmin<T>(fn: (admin: pg.Client) => Promise<T>): Promise<T> {
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      return await fn(admin);
    } finally {
      await admin.end();
    }
  }

  async function join(orgId: string, inviter: string, userId: string, email: string, role: 'admin' | 'member' | 'viewer') {
    const { acceptPath } = await runtime.execute<{ acceptPath: string }>('kernel.member.invite.create', { email, role }, { actor: asMfa(inviter), orgId });
    await runtime.executeOrgless('kernel.member.invite.accept', { token: acceptPath.split('#')[1] }, { actor: asUser(userId) });
  }

  // Runs fn as the API login role in the user's context of the org, and commits.
  async function asApp<T>(userId: string, orgId: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const app = await connect(appUrl);
    await app.query('BEGIN');
    try {
      await app.query('SELECT crove_kernel.enter_context($1::uuid, $2::uuid)', [userId, orgId]);
      const result = await fn(app);
      await app.query('COMMIT');
      return result;
    } catch (error) {
      await app.query('ROLLBACK').catch(() => {});
      throw error;
    }
  }

  const postSql = (c: pg.Client, date: string, lines: Line[], reverses: string | null = null) =>
    c
      .query<{ id: string }>(`SELECT crove_finance.post_journal_entry($1::date, 'test', 'test', $2::uuid, $3::jsonb, $4::uuid) AS id`, [
        date,
        randomUUID(),
        JSON.stringify(lines),
        reverses,
      ])
      .then((r) => r.rows[0]?.id ?? '');

  // An original entry, posted through the posting path as the API login role.
  const original = (userId: string, orgId: string, lines: Line[], date = '2026-10-01') => asApp(userId, orgId, (c) => postSql(c, date, lines));

  const request = (orgId: string, userId: string, input: Record<string, unknown>, idempotencyKey: string = randomUUID()) =>
    runtime.execute<{ proposalId: string }>(
      'kernel.proposal.request',
      { command: 'finance.journal.reverse', input: { entryDate: '2026-10-15', reason: 'Ghi nhầm tài khoản', ...input } },
      { actor: asUser(userId), orgId, idempotencyKey },
    );

  const approve = (orgId: string, actor: ReturnType<typeof asUser> | ReturnType<typeof asMfa>, id: string) =>
    runtime.execute<{ journalEntryId: string; reversedEntryId: string }>(
      'kernel.proposal.approve',
      { id, revision: 1 },
      { actor, orgId, idempotencyKey: randomUUID() },
    );

  // A second open proposal for an entry that already has one, copied as the database owner (authorId sets who asked).
  // A user's second request for the same entry is refused while the first is pending (#254), but a proposal raised
  // before that rule, or by any other writer, must still meet the checks at approval tested here.
  const copyProposal = (orgId: string, id: string, authorId?: string) =>
    withAdmin(async (a) => {
      const { rows } = await a.query<{ id: string }>(
        `INSERT INTO crove_kernel.proposal (org_id, kind, command, title, payload, eligible_approvers, authors)
         SELECT org_id, kind, command, title, payload, eligible_approvers, coalesce($3::jsonb, authors)
         FROM crove_kernel.proposal WHERE org_id = $1 AND id = $2 RETURNING id`,
        [orgId, id, authorId ? JSON.stringify([{ type: 'user', id: authorId }]) : null],
      );
      return { proposalId: rows[0]?.id ?? '' };
    });

  const SALE: Line[] = [
    { line_no: 1, account_code: '6422', debit: '100500', credit: '0', memo: 'Văn phòng phẩm' },
    { line_no: 2, account_code: '1331', debit: '10050', credit: '0', memo: null },
    { line_no: 3, account_code: '331', debit: '0', credit: '110550', party_id: randomUUID(), memo: 'Phải trả' },
  ];

  beforeAll(async () => {
    const base = new URL(ADMIN as string);
    const admin = new pg.Client({ connectionString: ADMIN });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    const url = new URL(adminUrl);
    url.username = 'crove_app';
    url.password = 'test-app-pw';
    appUrl = url.toString();
    pool = createPool({ connectionString: appUrl, max: 4 });
    const db = createDb(pool);
    runtime = new Runtime(db).register({
      commands: [...kernelCommands, ...financeCommands],
      queries: [...kernelQueries({ inboundDomain: 'in.test' }), ...financeQueries],
    });
    for (const name of Object.keys(users) as (keyof typeof users)[]) {
      users[name] = await upsertIdentity(db, { issuer: 'test', subject: `rev-${name}`, email: `${name}@reversal.test`, name: null });
    }
    solo = (await createOrg(runtime, asUser(users.solo), 'Reversal Solo')).orgId;
    team = (await createOrg(runtime, asUser(users.owner), 'Reversal Team')).orgId;
    await join(team, users.owner, users.admin, 'admin@reversal.test', 'admin');
    await join(team, users.owner, users.member, 'member@reversal.test', 'member');
    await join(team, users.owner, users.viewer, 'viewer@reversal.test', 'viewer');
    await withAdmin((a) =>
      a.query(`CREATE POLICY crove_test_le_scope_138 ON crove_finance.journal_line AS RESTRICTIVE FOR SELECT TO crove_tenant
               USING (memo IS DISTINCT FROM '${HIDDEN}')`),
    );
  });

  afterAll(async () => {
    for (const c of clients) await c.end().catch(() => {});
    await pool?.end();
    if (!ADMIN) return;
    const admin = new pg.Client({ connectionString: ADMIN });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  });

  let soloEntry = '';
  let soloReversal = '';

  it('posts the mirror entry through the posting path, and the pair nets to zero per account', async () => {
    soloEntry = await original(users.solo, solo, SALE);
    const { proposalId } = await request(solo, users.solo, { entryId: soloEntry });
    const result = await approve(solo, asMfa(users.solo), proposalId);
    expect(result.reversedEntryId).toBe(soloEntry);
    soloReversal = result.journalEntryId;

    const { net, lines, entry, proposal, audit } = await withAdmin(async (a) => {
      const n = await a.query<{ account_code: string; party_id: string | null; net: string }>(
        `SELECT account_code, party_id, sum(debit - credit)::text AS net FROM crove_finance.journal_line
         WHERE org_id = $1 AND entry_id = ANY ($2::uuid[]) GROUP BY 1, 2 ORDER BY 1`,
        [solo, [soloEntry, soloReversal]],
      );
      const l = await a.query<Line>(
        `SELECT line_no, account_code, debit::text, credit::text, party_id, memo FROM crove_finance.journal_line
         WHERE org_id = $1 AND entry_id = $2 ORDER BY line_no`,
        [solo, soloReversal],
      );
      const e = await a.query(
        `SELECT reverses_entry_id, source_type, source_id, created_by, entry_date::text FROM crove_finance.journal_entry WHERE org_id = $1 AND id = $2`,
        [solo, soloReversal],
      );
      const p = await a.query(`SELECT kind, command, status, authors, eligible_approvers FROM crove_kernel.proposal WHERE org_id = $1 AND id = $2`, [
        solo,
        proposalId,
      ]);
      const au = await a.query<{ command: string; outcome: string; proposal_id: string | null; detail: Record<string, unknown> }>(
        `SELECT command, outcome, proposal_id, detail FROM crove_kernel.audit_event
         WHERE org_id = $1 AND command IN ('kernel.proposal.request', 'finance.journal.prepare_reversal', 'kernel.proposal.approve', 'finance.journal.reverse')
         ORDER BY occurred_at, command`,
        [solo],
      );
      return { net: n.rows, lines: l.rows, entry: e.rows[0], proposal: p.rows[0], audit: au.rows };
    });
    // Every account (and party) the pair touches nets to exactly zero.
    expect(net.map((r) => r.account_code)).toEqual(['1331', '331', '6422']);
    expect(net.every((r) => /^0(\.0+)?$/.test(r.net))).toBe(true);
    // Line by line: same number, account, party and memo, debit and credit swapped.
    expect(lines).toEqual([
      { line_no: 1, account_code: '6422', debit: '0.0000', credit: '100500.0000', party_id: null, memo: 'Văn phòng phẩm' },
      { line_no: 2, account_code: '1331', debit: '0.0000', credit: '10050.0000', party_id: null, memo: null },
      { line_no: 3, account_code: '331', debit: '110550.0000', credit: '0.0000', party_id: SALE[2]?.party_id, memo: 'Phải trả' },
    ]);
    expect(entry).toEqual({ reverses_entry_id: soloEntry, source_type: 'kernel.proposal', source_id: proposalId, created_by: users.solo, entry_date: '2026-10-15' });
    expect(proposal).toMatchObject({
      kind: 'finance.journal_reversal',
      command: 'finance.journal.reverse',
      status: 'executed',
      authors: [{ type: 'user', id: users.solo }],
      eligible_approvers: [users.solo],
    });
    // Audited: the request (R1), the preparation, the approval (P10 self-approval flagged, aal recorded) and the posting.
    expect(audit.map((r) => [r.command, r.outcome])).toEqual(
      expect.arrayContaining([
        ['kernel.proposal.request', 'ok'],
        ['finance.journal.prepare_reversal', 'ok'],
        ['kernel.proposal.approve', 'ok'],
        ['finance.journal.reverse', 'ok'],
      ]),
    );
    const approval = audit.find((r) => r.command === 'kernel.proposal.approve');
    expect(approval?.detail).toMatchObject({ aal: 'aal2', self_approved: true, policy: { P10: 'self_approved', P12: 'pass' } });
    const posting = audit.find((r) => r.command === 'finance.journal.reverse');
    expect(posting).toMatchObject({ proposal_id: proposalId, detail: { reversed_entry_id: soloEntry, reversal_entry_id: soloReversal, aal: 'aal2' } });
  });

  it('reverses an entry at most once, never reverses a reversal, and never dates one before the original', async () => {
    await expect(request(solo, users.solo, { entryId: soloEntry })).rejects.toMatchObject({ code: 'ALREADY_REVERSED', status: 409 });
    await expect(request(solo, users.solo, { entryId: soloReversal })).rejects.toMatchObject({ code: 'ENTRY_IS_REVERSAL', status: 422 });
    const fresh = await original(users.solo, solo, SALE, '2026-10-10');
    await expect(request(solo, users.solo, { entryId: fresh, entryDate: '2026-10-09' })).rejects.toMatchObject({
      code: 'REVERSAL_DATE_BEFORE_ENTRY',
      status: 422,
    });
    await expect(request(solo, users.solo, { entryId: randomUUID() })).rejects.toMatchObject({ code: 'ENTRY_NOT_FOUND', status: 404 });
    // Another org's entry does not exist here.
    await expect(request(team, users.owner, { entryId: fresh })).rejects.toMatchObject({ code: 'ENTRY_NOT_FOUND', status: 404 });

    // Two proposals for one entry: the second approval, after the first, is refused and leaves its proposal pending.
    const first = await request(solo, users.solo, { entryId: fresh, entryDate: '2026-10-10' });
    const second = await copyProposal(solo, first.proposalId);
    await approve(solo, asMfa(users.solo), first.proposalId);
    await expect(approve(solo, asMfa(users.solo), second.proposalId)).rejects.toMatchObject({ code: 'ALREADY_REVERSED', status: 409 });
    const status = await withAdmin((a) =>
      a.query<{ status: string }>(`SELECT status FROM crove_kernel.proposal WHERE org_id = $1 AND id = $2`, [solo, second.proposalId]),
    );
    expect(status.rows[0]?.status).toBe('pending');
  });

  it('lets exactly one of two concurrent reversals of the same entry win', async () => {
    const entry = await original(users.solo, solo, SALE);
    const a = await request(solo, users.solo, { entryId: entry });
    const b = await copyProposal(solo, a.proposalId);
    const results = await Promise.allSettled([approve(solo, asMfa(users.solo), a.proposalId), approve(solo, asMfa(users.solo), b.proposalId)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({ code: 'ALREADY_REVERSED', status: 409 });
    const count = await withAdmin((c) =>
      c.query<{ n: number }>(`SELECT count(*)::int AS n FROM crove_finance.journal_entry WHERE org_id = $1 AND reverses_entry_id = $2`, [solo, entry]),
    );
    expect(count.rows[0]?.n).toBe(1);

    // The same race in SQL, made deterministic: the second insert waits on the unique index, then fails when the
    // first commits.
    const target = await original(users.solo, solo, SALE);
    const c1 = await connect(appUrl);
    const c2 = await connect(appUrl);
    await c1.query('BEGIN');
    await c1.query('SELECT crove_kernel.enter_context($1::uuid, $2::uuid)', [users.solo, solo]);
    await postSql(c1, '2026-10-15', mirror(SALE), target);
    await c2.query('BEGIN');
    await c2.query('SELECT crove_kernel.enter_context($1::uuid, $2::uuid)', [users.solo, solo]);
    const pid2 = (await c2.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
    const second = postSql(c2, '2026-10-15', mirror(SALE), target).then(
      () => null,
      (e: unknown) => e,
    );
    await withAdmin(async (adm) => {
      for (let i = 0; i < 200; i++) {
        const { rows } = await adm.query<{ waiting: boolean }>(`SELECT wait_event_type = 'Lock' AS waiting FROM pg_stat_activity WHERE pid = $1`, [pid2]);
        if (rows[0]?.waiting) return;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error('the second reversal never waited for the first');
    });
    await c1.query('COMMIT');
    expect(await second).toMatchObject({ code: '23505', constraint: 'journal_entry_reverses_uq' });
    await c2.query('ROLLBACK');
  });

  it('runs only through an approved proposal, with approval rights, four-eyes and step-up', async () => {
    const entry = await original(users.owner, team, SALE);
    // Viewers ask for nothing; the posting command never runs outside an approval.
    await expect(request(team, users.viewer, { entryId: entry })).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    await expect(
      runtime.execute(
        'finance.journal.reverse',
        { payload: { entryId: entry, entryDate: '2026-10-15', reason: 'x' } },
        { actor: asMfa(users.owner), orgId: team, idempotencyKey: randomUUID() },
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });

    // A member may ask; a member may not approve (only the roles that may post approve, #71).
    const byMember = await request(team, users.member, { entryId: entry });
    await expect(approve(team, asMfa(users.member), byMember.proposalId)).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    const snapshot = await withAdmin((a) =>
      a.query<{ eligible_approvers: string[] }>(`SELECT eligible_approvers FROM crove_kernel.proposal WHERE org_id = $1 AND id = $2`, [team, byMember.proposalId]),
    );
    expect([...(snapshot.rows[0]?.eligible_approvers ?? [])].sort()).toEqual([users.owner, users.admin].sort());

    // The admin asks, so the admin may not approve their own request while another approver exists (P10).
    const byAdmin = await copyProposal(team, byMember.proposalId, users.admin);
    await expect(approve(team, asMfa(users.admin), byAdmin.proposalId)).rejects.toMatchObject({ code: 'FOUR_EYES_REQUIRED', status: 403 });
    // The owner approves, but only with a fresh second factor (P11).
    await expect(approve(team, asUser(users.owner), byAdmin.proposalId)).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED', status: 403 });
    const done = await approve(team, asMfa(users.owner), byAdmin.proposalId);
    expect(done.reversedEntryId).toBe(entry);
    // The member's earlier request is now refused on approval.
    await expect(approve(team, asMfa(users.admin), byMember.proposalId)).rejects.toMatchObject({ code: 'ALREADY_REVERSED', status: 409 });
  });

  it('refuses a second request for an entry while one is pending, also when both arrive at once (#254)', async () => {
    const entry = await original(users.owner, team, SALE);
    const first = await request(team, users.owner, { entryId: entry });
    const pending = { code: 'REVERSAL_PENDING', status: 409, details: { proposalId: first.proposalId } };
    // Another user, another key, the id in another spelling: still the same entry, so refused.
    await expect(request(team, users.member, { entryId: entry })).rejects.toMatchObject(pending);
    await expect(request(team, users.admin, { entryId: entry.toUpperCase() })).rejects.toMatchObject(pending);
    // The stored payload holds the id lower-cased, so every request for the entry finds it.
    const stored = await withAdmin((a) =>
      a.query<{ entry_id: string }>(`SELECT payload->>'entryId' AS entry_id FROM crove_kernel.proposal WHERE org_id = $1 AND id = $2`, [team, first.proposalId]),
    );
    expect(stored.rows[0]?.entry_id).toBe(entry.toLowerCase());

    // Once the pending request is rejected, the entry may be asked for again.
    await runtime.execute('kernel.proposal.reject', { id: first.proposalId }, { actor: asUser(users.admin), orgId: team });
    const again = await request(team, users.member, { entryId: entry.toUpperCase() });
    await expect(request(team, users.owner, { entryId: entry })).rejects.toMatchObject({ code: 'REVERSAL_PENDING', details: { proposalId: again.proposalId } });
    // Once it is approved and posted, a request is refused as already reversed.
    await approve(team, asMfa(users.owner), again.proposalId);
    await expect(request(team, users.member, { entryId: entry })).rejects.toMatchObject({ code: 'ALREADY_REVERSED', status: 409 });

    // Requests for one entry at once: exactly one proposal; every other request is refused as pending.
    const target = await original(users.owner, team, SALE);
    const results = await Promise.allSettled(
      [users.owner, users.admin, users.member, users.owner].map((userId) => request(team, userId, { entryId: target })),
    );
    const created = results.filter((r): r is PromiseFulfilledResult<{ proposalId: string }> => r.status === 'fulfilled');
    expect(created).toHaveLength(1);
    for (const r of results) {
      if (r.status === 'rejected') expect(r.reason).toMatchObject({ code: 'REVERSAL_PENDING', details: { proposalId: created[0]?.value.proposalId } });
    }
    const open = await withAdmin((a) =>
      a.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM crove_kernel.proposal WHERE org_id = $1 AND kind = 'finance.journal_reversal' AND status = 'pending' AND payload->>'entryId' = $2`,
        [team, target],
      ),
    );
    expect(open.rows[0]?.n).toBe(1);
  });

  it('makes a request wait for one in flight for the same entry, then refuses it as pending (#302)', async () => {
    // Deterministic: a second connection plays the first request. It takes the per-entry lock the request takes and
    // writes a pending reversal proposal for the entry, then holds its transaction open. The request must wait on the
    // lock (it would pass if it looked before the first commits), and once the first commits, see its proposal.
    const entry = await original(users.owner, team, SALE);
    const holder = await connect(adminUrl);
    await holder.query('BEGIN');
    await holder.query(`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))`, [`finance.journal_reversal:${entry}`]);
    const { rows } = await holder.query<{ id: string }>(
      `INSERT INTO crove_kernel.proposal (org_id, kind, command, title, payload, eligible_approvers, authors)
       VALUES ($1, 'finance.journal_reversal', 'finance.journal.reverse', 'Đảo bút toán (đang ghi)', $2::jsonb, ARRAY[$3::uuid, $4::uuid], $5::jsonb)
       RETURNING id`,
      [
        team,
        JSON.stringify({ entryId: entry, entryDate: '2026-10-15', reason: 'Ghi nhầm tài khoản' }),
        users.owner,
        users.admin,
        JSON.stringify([{ type: 'user', id: users.owner }]),
      ],
    );
    const inFlight = rows[0]?.id ?? '';
    let settled = false;
    const second = request(team, users.member, { entryId: entry }).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    void second.then(() => {
      settled = true;
    });
    // The request waits on the advisory lock the holder has.
    await withAdmin(async (a) => {
      for (let i = 0; i < 200; i++) {
        const waiting = await a.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_catalog.pg_locks l
           WHERE l.locktype = 'advisory' AND NOT l.granted AND l.database = (SELECT oid FROM pg_catalog.pg_database WHERE datname = pg_catalog.current_database())`,
        );
        if ((waiting.rows[0]?.n ?? 0) > 0) return;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error('the request never waited for the one in flight');
    });
    expect(settled).toBe(false);
    await holder.query('COMMIT');
    expect(await second).toMatchObject({ error: { code: 'REVERSAL_PENDING', status: 409, details: { proposalId: inFlight } } });
    // Only the proposal in flight is open for the entry.
    const open = await withAdmin((a) =>
      a.query<{ id: string }>(
        `SELECT id FROM crove_kernel.proposal WHERE org_id = $1 AND kind = 'finance.journal_reversal' AND status = 'pending' AND payload->>'entryId' = $2`,
        [team, entry],
      ),
    );
    expect(open.rows.map((r) => r.id)).toEqual([inFlight]);

    // A holder that rolls back (the first request was refused or failed) lets the waiting request through.
    const other = await original(users.owner, team, SALE);
    await holder.query('BEGIN');
    await holder.query(`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))`, [`finance.journal_reversal:${other}`]);
    const third = request(team, users.member, { entryId: other });
    await withAdmin(async (a) => {
      for (let i = 0; i < 200; i++) {
        const waiting = await a.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_catalog.pg_locks WHERE locktype = 'advisory' AND NOT granted`);
        if ((waiting.rows[0]?.n ?? 0) > 0) return;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error('the request never waited for the lock holder');
    });
    await holder.query('ROLLBACK');
    expect(await third).toMatchObject({ proposalId: expect.any(String) });
  });

  it('replays a request with the same idempotency key and refuses the key for another request', async () => {
    const entry = await original(users.owner, team, SALE);
    const key = randomUUID();
    const first = await request(team, users.owner, { entryId: entry }, key);
    const replay = await request(team, users.owner, { entryId: entry }, key);
    expect(replay.proposalId).toBe(first.proposalId);
    await expect(request(team, users.owner, { entryId: entry, reason: 'Khác' }, key)).rejects.toMatchObject({ code: 'IDEMPOTENCY_MISMATCH' });
  });

  it('holds every writer to the mirror rules in the database', async () => {
    const entry = await original(users.solo, solo, SALE);
    // Not a mirror: an amount changed (the pair still balances, so only the mirror check refuses it).
    const changed = mirror(SALE).map((l) => (l.line_no === 1 ? { ...l, credit: '90500' } : l.line_no === 3 ? { ...l, debit: '100550' } : l));
    await expect(asApp(users.solo, solo, (c) => postSql(c, '2026-10-15', changed, entry))).rejects.toThrow(/does not mirror the entry it reverses/);
    // Not a mirror: another account, or a line missing (the rest rebalanced).
    const moved = mirror(SALE).map((l) => (l.line_no === 2 ? { ...l, account_code: '6422' } : l));
    await expect(asApp(users.solo, solo, (c) => postSql(c, '2026-10-15', moved, entry))).rejects.toThrow(/does not mirror/);
    // Dated before the original.
    await expect(asApp(users.solo, solo, (c) => postSql(c, '2026-09-30', mirror(SALE), entry))).rejects.toThrow(/dated before the entry it reverses/);
    // A reversal of a reversal, and a second reversal.
    await expect(asApp(users.solo, solo, (c) => postSql(c, '2026-10-15', SALE, soloReversal))).rejects.toThrow(/is a reversal and cannot be reversed/);
    await expect(asApp(users.solo, solo, (c) => postSql(c, '2026-10-15', mirror(SALE), soloEntry))).rejects.toMatchObject({
      code: '23505',
      constraint: 'journal_entry_reverses_uq',
    });
    // Another org's entry cannot be named: the link is (org_id, reverses_entry_id), and org_id is the context's.
    await expect(asApp(users.owner, team, (c) => postSql(c, '2026-10-15', mirror(SALE), entry))).rejects.toMatchObject({ code: '23503' });

    // A superuser writing the rows directly is still checked at commit.
    await expect(
      withAdmin(async (a) => {
        await a.query('BEGIN');
        try {
          const { rows } = await a.query<{ id: string }>(
            `INSERT INTO crove_finance.journal_entry (org_id, entry_date, description, source_type, source_id, reverses_entry_id)
             VALUES ($1, '2026-10-15', 'direct', 'test', $2, $3) RETURNING id`,
            [solo, randomUUID(), entry],
          );
          for (const l of changed) {
            await a.query(
              `INSERT INTO crove_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit, party_id, memo)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
              [solo, rows[0]?.id, l.line_no, l.account_code, l.debit, l.credit, l.party_id ?? null, l.memo ?? null],
            );
          }
          await a.query('COMMIT');
        } catch (error) {
          await a.query('ROLLBACK').catch(() => {});
          throw error;
        }
      }),
    ).rejects.toThrow(/does not mirror the entry it reverses/);

    // The exact mirror is accepted.
    const ok = await asApp(users.solo, solo, (c) => postSql(c, '2026-10-15', mirror(SALE), entry));
    expect(ok).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('keeps the mirror rules when a writer runs the deferred checks early and adds lines afterwards', async () => {
    // As a superuser, writing rows directly. SET CONSTRAINTS ALL IMMEDIATE fires the entry's full mirror check now
    // (it passes); every later line is checked on its own, as it is inserted.
    const attempt = (after: (a: pg.Client, reversal: string, original: string) => Promise<void>) =>
      withAdmin(async (a) => {
        await a.query('BEGIN');
        try {
          const original = (
            await a.query<{ id: string }>(
              `INSERT INTO crove_finance.journal_entry (org_id, entry_date, description, source_type, source_id)
               VALUES ($1, '2026-10-01', 'direct original', 'test', $2) RETURNING id`,
              [solo, randomUUID()],
            )
          ).rows[0]?.id as string;
          const insertLines = async (entry: string, lines: Line[]) => {
            for (const l of lines) {
              await a.query(
                `INSERT INTO crove_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit, party_id, memo)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                [solo, entry, l.line_no, l.account_code, l.debit, l.credit, l.party_id ?? null, l.memo ?? null],
              );
            }
          };
          await insertLines(original, SALE);
          const reversal = (
            await a.query<{ id: string }>(
              `INSERT INTO crove_finance.journal_entry (org_id, entry_date, description, source_type, source_id, reverses_entry_id)
               VALUES ($1, '2026-10-15', 'direct reversal', 'test', $2, $3) RETURNING id`,
              [solo, randomUUID(), original],
            )
          ).rows[0]?.id as string;
          await insertLines(reversal, mirror(SALE));
          await a.query('SET CONSTRAINTS ALL IMMEDIATE');
          await after(a, reversal, original);
          await a.query('COMMIT');
        } catch (error) {
          await a.query('ROLLBACK').catch(() => {});
          throw error;
        }
      });
    const pair = (from: number): Line[] => [
      { line_no: from, account_code: '6422', debit: '5', credit: '0' },
      { line_no: from + 1, account_code: '111', debit: '0', credit: '5' },
    ];
    // One statement, so the immediate triggers fire after both lines exist and the balance check passes.
    const add = async (a: pg.Client, entry: string, lines: Line[]) => {
      await a.query(
        `INSERT INTO crove_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit)
         SELECT $1, $2, l.line_no, l.account_code, l.debit, l.credit
         FROM jsonb_to_recordset($3::jsonb) AS l (line_no int, account_code text, debit numeric, credit numeric)`,
        [solo, entry, JSON.stringify(lines)],
      );
    };
    // Original and reversal in one transaction, checked early: accepted as they are.
    await expect(attempt(async () => {})).resolves.toBeUndefined();
    // A balanced pair added to the reversal after its check passed.
    await expect(attempt((a, reversal) => add(a, reversal, pair(4)))).rejects.toThrow(/does not mirror the entry it reverses/);
    // A balanced pair added to the original after its reversal's check passed.
    await expect(attempt((a, _reversal, original) => add(a, original, pair(4)))).rejects.toThrow(/does not mirror the entry it reverses/);
    // Both gain the mirrored pair: whichever grows first no longer mirrors the other at that moment, so it is refused
    // too (checks that ran early hold the entries to what they were then).
    await expect(
      attempt(async (a, reversal, original) => {
        await add(a, original, pair(4));
        await add(a, reversal, mirror(pair(4)));
      }),
    ).rejects.toThrow(/does not mirror/);
  });

  it('reverses a large entry once, checked once per entry', async () => {
    const lines: Line[] = [];
    for (let i = 1; i <= 400; i += 2) {
      lines.push({ line_no: i, account_code: '6422', debit: `${i}250`, credit: '0', memo: `dòng ${i}` });
      lines.push({ line_no: i + 1, account_code: '331', debit: '0', credit: `${i}250`, memo: null });
    }
    const entry = await original(users.solo, solo, lines);
    const { proposalId } = await request(solo, users.solo, { entryId: entry });
    const started = Date.now();
    const { journalEntryId } = await approve(solo, asMfa(users.solo), proposalId);
    expect(Date.now() - started).toBeLessThan(10_000);
    const net = await withAdmin((a) =>
      a.query<{ n: number; nonzero: number }>(
        `SELECT count(*)::int AS n, count(*) FILTER (WHERE net <> 0)::int AS nonzero FROM (
           SELECT line_no, sum(debit - credit) AS net FROM crove_finance.journal_line
           WHERE org_id = $1 AND entry_id = ANY ($2::uuid[]) GROUP BY line_no) x`,
        [solo, [entry, journalEntryId]],
      ),
    );
    expect(net.rows[0]).toEqual({ n: 400, nonzero: 0 });
  });

  it('refuses to delete an original that has a reversal instead of taking the reversal with it', async () => {
    // Entries are append-only; with those triggers off (rolled back), the foreign key alone still refuses.
    await expect(
      withAdmin(async (a) => {
        await a.query('BEGIN');
        try {
          await a.query('ALTER TABLE crove_finance.journal_entry DISABLE TRIGGER USER');
          await a.query('ALTER TABLE crove_finance.journal_line DISABLE TRIGGER USER');
          await a.query('DELETE FROM crove_finance.journal_entry WHERE org_id = $1 AND id = $2', [solo, soloEntry]);
        } finally {
          await a.query('ROLLBACK');
        }
      }),
    ).rejects.toMatchObject({ code: '23503', constraint: 'journal_entry_reverses_fk' });
    const still = await withAdmin((a) =>
      a.query<{ n: number }>(`SELECT count(*)::int AS n FROM crove_finance.journal_entry WHERE org_id = $1 AND id = ANY ($2::uuid[])`, [
        solo,
        [soloEntry, soloReversal],
      ]),
    );
    expect(still.rows[0]?.n).toBe(2);
  });

  it('refuses to reverse an entry with lines the caller cannot see', async () => {
    // The hidden pair balances on its own, so a mirror of the visible lines balances too; only the mirror check,
    // which counts every line, refuses it.
    const entry = await original(users.solo, solo, [
      ...SALE,
      { line_no: 4, account_code: '6422', debit: '30', credit: '0', memo: HIDDEN },
      { line_no: 5, account_code: '331', debit: '0', credit: '30', memo: HIDDEN },
    ]);
    const { proposalId } = await request(solo, users.solo, { entryId: entry });
    await expect(approve(solo, asMfa(users.solo), proposalId)).rejects.toMatchObject({ code: 'INVALID', status: 422 });
    await expect(asApp(users.solo, solo, (c) => postSql(c, '2026-10-15', mirror(SALE), entry))).rejects.toThrow(/does not mirror/);
  });

  it('keeps the mirror check out of reach and the reversal posting function with the definer', async () => {
    const { grants, shape } = await withAdmin(async (a) => {
      const g = await a.query<{ fn: string; role: string }>(
        `SELECT f AS fn, r AS role FROM unnest($1::text[]) f CROSS JOIN unnest($2::text[]) r
         WHERE has_function_privilege(r, f, 'EXECUTE') ORDER BY 1, 2`,
        [['crove_finance.require_entry_mirrors(uuid,uuid)', 'crove_finance.post_journal_entry(date,text,text,uuid,jsonb,uuid)'], ROLES],
      );
      const s = await a.query<{ fn: string; owner: string; definer: boolean; config: string[]; public: boolean }>(
        `SELECT p.oid::regprocedure::text AS fn, pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS definer, p.proconfig AS config,
                EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x WHERE x.grantee = 0) AS public
         FROM pg_proc p
         WHERE p.oid IN ('crove_finance.post_journal_entry(date,text,text,uuid,jsonb,uuid)'::regprocedure,
                         'crove_finance.post_journal_entry(date,text,text,uuid,jsonb)'::regprocedure)
         ORDER BY 1`,
      );
      return { grants: g.rows, shape: s.rows };
    });
    // The tenant role (and the API and worker login roles through it) may post; the definer owns it. Nobody may call
    // the mirror check directly.
    expect(grants).toEqual([
      { fn: 'crove_finance.post_journal_entry(date,text,text,uuid,jsonb,uuid)', role: 'crove_app' },
      { fn: 'crove_finance.post_journal_entry(date,text,text,uuid,jsonb,uuid)', role: 'crove_definer_tenant' },
      { fn: 'crove_finance.post_journal_entry(date,text,text,uuid,jsonb,uuid)', role: 'crove_tenant' },
      { fn: 'crove_finance.post_journal_entry(date,text,text,uuid,jsonb,uuid)', role: 'crove_worker' },
    ]);
    expect(shape).toEqual([
      { fn: 'crove_finance.post_journal_entry(date,text,text,uuid,jsonb)', owner: 'crove_definer_tenant', definer: true, config: ['search_path=pg_catalog, pg_temp'], public: false },
      { fn: 'crove_finance.post_journal_entry(date,text,text,uuid,jsonb,uuid)', owner: 'crove_definer_tenant', definer: true, config: ['search_path=pg_catalog, pg_temp'], public: false },
    ]);
    const app = await connect(appUrl);
    await expect(app.query('SELECT crove_finance.require_entry_mirrors($1::uuid, $2::uuid)', [solo, soloReversal])).rejects.toThrow(/permission denied/);
  });
});
