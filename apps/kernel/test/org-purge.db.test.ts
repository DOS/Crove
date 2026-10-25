// The operator's org-purge role on PostgreSQL 17 (issue #1024): each precondition refuses with nothing changed, a purge
// keeps the books (the booked document's file and blob, its party anonymized) and what append-only rows pin, deletes
// the rest with its blobs, closes the org and writes one audit row with counts and the reason, a rerun changes
// nothing, a failed blob delete rolls everything back, held blobs stay, and another org is untouched. Who may run it is
// in test/invariant/org-purge.db.test.ts. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime, fileKey, sha256Hex, type BlobStore } from '@crove/kernel-runtime';
import { extractAndPropose, financeCommands, financeQueries } from '@crove/mod-finance';
import { orgPurgeCommand, parseOrgPurgeArgs, runOrgPurge, type HeldCheck } from '../src/org-purge.ts';
import { inProcessExtract } from './extract-service.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const FIXTURE = readFileSync(new URL('../../extract/test/fixtures/einvoice-basic.xml', import.meta.url));
const DAY = 24 * 60 * 60 * 1000;

class MemoryStore implements BlobStore {
  readonly blobs = new Map<string, Uint8Array>();
  failDeletes = false;
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
    if (this.failDeletes) throw new Error('store unavailable');
    this.blobs.delete(key);
  }
}

const suite = ADMIN ? describe : describe.skip;

suite('org purge on PostgreSQL (#1024)', () => {
  const dbName = `crove_test_orgpurge_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  let workerPool: pg.Pool;
  let workerDb: Db;
  let worker: Runtime;
  const store = new MemoryStore();
  let held: string | null = null;
  const isHeld: HeldCheck = async (key) => key === held;
  const extract = inProcessExtract();

  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const asMfa = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal2' as const, sessionId: randomUUID(), mfaAt: Math.floor(Date.now() / 1000) });

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }
  const one = async <T extends pg.QueryResultRow>(text: string, values: unknown[] = []) => admin(async (c) => (await c.query<T>(text, values)).rows[0] as T);
  const count = async (table: string, orgId: string) => Number((await one<{ n: string }>(`SELECT count(*) AS n FROM ${table} WHERE org_id = $1`, [orgId])).n);

  async function ingest(orgId: string, userId: string, bytes: Uint8Array, filename: string) {
    const sha256 = sha256Hex(bytes);
    const storageKey = fileKey(orgId, sha256);
    const generation = await store.put(storageKey, bytes);
    const { fileId } = await rt.execute<{ fileId: string }>(
      'kernel.file.ingest',
      { filename, contentType: 'application/xml', sizeBytes: bytes.byteLength, sha256, storageKey, generation, source: 'upload' },
      { actor: asUser(userId), orgId },
    );
    return { fileId, storageKey };
  }

  // An org with an owner, an admin, a booked purchase invoice (its file, party and journal entry), an unbooked file, a
  // party nothing books, a task with a comment (append-only) under a parent task and a position, and a task without.
  async function seed(name: string) {
    const tag = randomUUID().slice(0, 8);
    const ownerEmail = `owner-${tag}@purge.test`;
    const owner = await upsertIdentity(db, { issuer: 'test', subject: `owner-${tag}`, email: ownerEmail, name: null });
    const member = await upsertIdentity(db, { issuer: 'test', subject: `member-${tag}`, email: `member-${tag}@purge.test`, name: null });
    const org = await createOrg(rt, asUser(owner), name);
    const { acceptPath } = await rt.execute<{ acceptPath: string }>('kernel.member.invite.create', { email: `member-${tag}@purge.test`, role: 'admin' }, { actor: asMfa(owner), orgId: org.orgId });
    await rt.executeOrgless('kernel.member.invite.accept', { token: acceptPath.split('#')[1] }, { actor: asUser(member) });

    const booked = await ingest(org.orgId, owner, FIXTURE, 'booked.xml');
    const { proposalId } = await extractAndPropose({ runtime: worker, store, extractor: null, extract, today: () => '2026-10-13' }, org.orgId, booked.fileId);
    const detail = await rt.query<{ revision: number }>('kernel.inbox.get', { id: proposalId }, { actor: asUser(owner), orgId: org.orgId });
    await rt.execute(
      'kernel.proposal.approve',
      { acceptUnverifiedSignature: true, id: proposalId, revision: detail.revision, lineAccounts: [{ lineNo: 1, debitAccount: '6422' }] },
      // Four eyes (P10): the owner uploaded it, the admin approves.
      { actor: asMfa(member), orgId: org.orgId },
    );
    const loose = await ingest(org.orgId, owner, new TextEncoder().encode(`<loose>${tag}</loose>`), 'loose.xml');

    const partyEmail = `seller-${tag}@purge.test`;
    const ids = await admin(async (c) => {
      await c.query(`UPDATE crove_kernel.party SET email = $2, phone = '0900000000' WHERE org_id = $1`, [org.orgId, partyEmail]);
      const stray = (await c.query<{ id: string }>(`INSERT INTO crove_kernel.party (org_id, kind, name, email) VALUES ($1, 'person', 'Stray', $2) RETURNING id`, [org.orgId, `stray-${tag}@purge.test`])).rows[0]?.id;
      const position = (await c.query<{ id: string }>(`INSERT INTO crove_kernel.position (org_id, title, module, role_key) VALUES ($1, 'Kế toán', 'finance', 'accountant') RETURNING id`, [org.orgId])).rows[0]?.id;
      const parent = (await c.query<{ id: string }>(`INSERT INTO crove_kernel.task (org_id, title, source, created_by_type) VALUES ($1, 'Parent', 'human', 'system') RETURNING id`, [org.orgId])).rows[0]?.id;
      const pinned = (
        await c.query<{ id: string }>(
          `INSERT INTO crove_kernel.task (org_id, title, source, created_by_type, parent_task_id, assignee_position_id) VALUES ($1, 'Pinned', 'human', 'system', $2, $3) RETURNING id`,
          [org.orgId, parent, position],
        )
      ).rows[0]?.id;
      await c.query(`INSERT INTO crove_kernel.task_comment (org_id, task_id, body, author_type) VALUES ($1, $2, 'Đã xem', 'system')`, [org.orgId, pinned]);
      const free = (await c.query<{ id: string }>(`INSERT INTO crove_kernel.task (org_id, title, source, created_by_type) VALUES ($1, 'Free', 'human', 'system') RETURNING id`, [org.orgId])).rows[0]?.id;
      // A customer only a ledger line names (a sale on 131): no foreign key points at it.
      const ledgerParty = (await c.query<{ id: string }>(`INSERT INTO crove_kernel.party (org_id, kind, name, email) VALUES ($1, 'organization', 'Khách nợ', $2) RETURNING id`, [org.orgId, `ledger-${tag}@purge.test`])).rows[0]?.id;
      await c.query('BEGIN');
      const entry = (
        await c.query<{ id: string }>(
          `INSERT INTO crove_finance.journal_entry (org_id, entry_date, description, source_type, source_id) VALUES ($1, current_date, 'Bán hàng', 'test.sale', $2) RETURNING id`,
          [org.orgId, randomUUID()],
        )
      ).rows[0]?.id;
      await c.query(
        `INSERT INTO crove_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit, party_id) VALUES ($1, $2, 1, '131', 500000, 0, $3), ($1, $2, 2, '511', 0, 500000, NULL)`,
        [org.orgId, entry, ledgerParty],
      );
      await c.query('COMMIT');
      // A proposal nothing booked: deleted. The booked invoice's proposal is the approval trail and stays.
      await c.query(
        `INSERT INTO crove_kernel.proposal (org_id, kind, command, title, payload, status) VALUES ($1, 'finance.purchase', 'finance.purchase.record', 'Stray', '{}', 'rejected')`,
        [org.orgId],
      );
      // The owner's browser push subscription (#1238): deleted with the org's other Social rows.
      await c.query(`INSERT INTO crove_social.push_subscription (org_id, user_id, endpoint, p256dh, auth) VALUES ($1, $2, $3, $4, $5)`, [
        org.orgId,
        owner,
        `https://push.example.com/${tag}`,
        Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString('base64url'),
        Buffer.alloc(16, 9).toString('base64url'),
      ]);
      // The owner's saved view of the posts, shared with the org (#1300): deleted with the org's other Social rows.
      await c.query(`INSERT INTO crove_social.saved_view (org_id, user_id, name, filters, shared) VALUES ($1, $2, 'Tuần này', '{"tab":"calendar"}', true)`, [org.orgId, owner]);
      // Archive marks on a loose file and on the file the books keep (#1302): both deleted with the org's other Social
      // rows, though the booked file stays.
      await c.query(`INSERT INTO crove_social.media_archive (org_id, file_id, archived_by) VALUES ($1, $2, $4), ($1, $3, $4)`, [org.orgId, loose.fileId, booked.fileId, owner]);
      return { stray, position, parent, pinned, free, ledgerParty };
    });
    return { org, owner, ownerEmail, member, booked, loose, partyEmail, proposalId, ...ids };
  }

  // Moves the org to offboarding as staff, with the owner's request and the export recorded at the given ages.
  async function offboard(orgId: string, options: { requestedDaysAgo?: number; exportedDaysAgo?: number | null; format?: string } = {}) {
    const { requestedDaysAgo = 40, exportedDaysAgo = 31, format = 'crove.org-export.v2' } = options;
    await admin(async (c) => {
      const owner = (await c.query<{ user_id: string }>(`SELECT user_id FROM crove_kernel.tenant_member WHERE org_id = $1 AND role = 'owner' LIMIT 1`, [orgId])).rows[0]?.user_id;
      // As staff, without the triggers: the request's audit row below is backdated, not the one of this transaction.
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query(`UPDATE crove_kernel.tenant SET status = 'offboarding' WHERE org_id = $1 AND status = 'active'`, [orgId]);
      await c.query('COMMIT');
      await recordAudit(c, orgId, 'kernel.org.offboard', 'user', owner ?? null, new Date(Date.now() - requestedDaysAgo * DAY), {});
      if (exportedDaysAgo !== null) {
        await recordAudit(c, orgId, 'kernel.org.export.record', 'system', null, new Date(Date.now() - exportedDaysAgo * DAY), { format, file_count: 2 });
      }
    });
  }

  async function recordAudit(c: pg.Client, orgId: string, command: string, actorType: string, actorId: string | null, when: Date, detail: Record<string, unknown>) {
    await c.query(
      `INSERT INTO crove_kernel.audit_event (org_id, occurred_at, actor_type, actor_id, command, command_id, outcome, input_sha256, detail)
       VALUES ($1, $2, $3, $4, $5, $6, 'ok', $7, $8)`,
      [orgId, when, actorType, actorId, command, randomUUID(), '0'.repeat(64), JSON.stringify(detail)],
    );
  }

  const status = async (orgId: string) => (await one<{ status: string }>('SELECT status FROM crove_kernel.tenant WHERE org_id = $1', [orgId])).status;
  const purgeAudits = (orgId: string) =>
    admin(async (c) => (await c.query<{ outcome: string; actor_type: string; detail: Record<string, unknown> }>(
      `SELECT outcome, actor_type, detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.org.purge' ORDER BY occurred_at, id`,
      [orgId],
    )).rows);

  async function run(ref: string, minDays = 30, reason = 'Owner left, export downloaded') {
    const lines: string[] = [];
    const code = await runOrgPurge({ runtime: worker, minDays, log: (l) => lines.push(l), error: (l) => lines.push(l) }, [ref, '--reason', reason]);
    return { code, out: lines.join('\n') };
  }

  // Every row count of the org, per table with an org_id, to compare before and after.
  const snapshot = (orgId: string) =>
    admin(async (c) => {
      const { rows } = await c.query<{ t: string; q: string }>(
        `SELECT n.nspname || '.' || c.relname AS t, format('%I.%I', n.nspname, c.relname) AS q FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE c.relkind = 'r' AND n.nspname LIKE 'crove\\_%' AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'org_id' AND NOT a.attisdropped)
         ORDER BY 1`,
      );
      const out: Record<string, number> = {};
      for (const { t, q } of rows) out[t] = Number((await c.query<{ n: string }>(`SELECT count(*) AS n FROM ${q} WHERE org_id = $1`, [orgId])).rows[0]?.n);
      return out;
    });

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
    const login = (username: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = username;
      url.password = password;
      return url.toString();
    };
    pool = createPool({ connectionString: login('crove_app', 'test-app-pw'), max: 4 });
    db = createDb(pool);
    const registry = { commands: [...kernelCommands, ...financeCommands], queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries] };
    rt = new Runtime(db).register(registry);
    workerPool = createPool({ connectionString: login('crove_worker', 'test-worker-pw'), max: 4 });
    workerDb = createDb(workerPool);
    worker = new Runtime(workerDb).register(registry).register({ commands: [orgPurgeCommand({ store, held: isHeld })] });
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

  it('parses its arguments', () => {
    expect(parseOrgPurgeArgs(['acme', '--reason', ' left '])).toEqual({ ref: 'acme', reason: 'left' });
    expect(() => parseOrgPurgeArgs(['acme'])).toThrow(/--reason is required/);
    expect(() => parseOrgPurgeArgs(['--reason', 'x'])).toThrow(/name the org/);
    expect(() => parseOrgPurgeArgs(['a', 'b', '--reason', 'x'])).toThrow(/name one org/);
    expect(() => parseOrgPurgeArgs(['a', '--force', '--reason', 'x'])).toThrow(/unknown argument --force/);
  });

  // A new table with an org_id fails this until crove_kernel.org_purge and the runbook's deletion map say what happens
  // to its rows.
  it('has a rule for every table with an org_id', async () => {
    const kept = [
      'crove_kernel.tenant', 'crove_kernel.legal_entity', 'crove_kernel.audit_event', 'crove_kernel.outbox_event', 'crove_kernel.inbound_address',
      'crove_kernel.org_usage', 'crove_kernel.outbox_archive', 'crove_kernel.external_call', 'crove_social.post_approval', 'crove_kernel.task_comment',
      'crove_finance.bank_line', 'crove_finance.cash_voucher', 'crove_finance.depreciation_line', 'crove_finance.fixed_asset',
      'crove_finance.input_vat_check', 'crove_finance.journal_entry', 'crove_finance.journal_line', 'crove_finance.journal_voucher',
      'crove_finance.org_account', 'crove_finance.period_balance_delta', 'crove_finance.period_lock', 'crove_finance.portal_invoice_list', 'crove_finance.portal_invoice_row',
      'crove_finance.purchase_document', 'crove_finance.purchase_document_void', 'crove_finance.purchase_line', 'crove_finance.purchase_tax_rate',
      'crove_finance.vat_return_filed',
    ];
    const purged = (await one<{ src: string }>(`SELECT prosrc AS src FROM pg_proc WHERE oid = 'crove_kernel.org_purge(integer)'::regprocedure`)).src;
    const named = new Set([...purged.matchAll(/'(crove_[a-z]+\.[a-z_]+)'/g), ...purged.matchAll(/DELETE FROM (crove_[a-z]+\.[a-z_]+)/g)].map((m) => m[1]));
    // Tables whose rows go with a parent the purge deletes, through an ON DELETE CASCADE foreign key (checked below).
    const cascaded: Record<string, string> = { 'crove_kernel.role_assignment': 'crove_kernel.tenant_member' };
    const tables = Object.keys(await snapshot(randomUUID()));
    expect(tables.filter((t) => !kept.includes(t) && !named.has(t) && !(t in cascaded))).toEqual([]);
    for (const [child, parent] of Object.entries(cascaded)) {
      expect(named.has(parent), parent).toBe(true);
      const fk = await one<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_constraint WHERE contype = 'f' AND conrelid = $1::regclass AND confrelid = $2::regclass AND confdeltype = 'c'`,
        [child, parent],
      );
      expect(fk.n, `${child} cascades from ${parent}`).toBe(1);
    }
    expect(kept.filter((t) => named.has(t) && t !== 'crove_kernel.task_comment' && t !== 'crove_social.post_approval')).toEqual([]);
  });

  it('refuses each unmet precondition and changes nothing', async () => {
    const s = await seed('Công ty Chưa đi');
    const before = await snapshot(s.org.orgId);
    expect(await run('no-such-org')).toMatchObject({ code: 1, out: expect.stringContaining('no org has this id or slug') });
    expect(await run(s.org.slug)).toMatchObject({ code: 1, out: expect.stringContaining('not in offboarding') });

    // Offboarding, but the only export is of the old format.
    await offboard(s.org.orgId, { format: 'crove.org-export.v1' });
    expect(await run(s.org.orgId)).toMatchObject({ code: 1, out: expect.stringContaining('no finished export') });
    // A current export, but only 10 days old.
    await admin((c) => recordAudit(c, s.org.orgId, 'kernel.org.export.record', 'system', null, new Date(Date.now() - 10 * DAY), { format: 'crove.org-export.v2' }));
    expect(await run(s.org.slug)).toMatchObject({ code: 1, out: expect.stringContaining('younger than ORG_PURGE_MIN_DAYS') });
    // The newest record decides: an older one past the limit does not help.
    await admin((c) => recordAudit(c, s.org.orgId, 'kernel.org.export.record', 'system', null, new Date(Date.now() - 35 * DAY), { format: 'crove.org-export.v2' }));
    expect(await run(s.org.slug)).toMatchObject({ code: 1, out: expect.stringContaining('younger than ORG_PURGE_MIN_DAYS') });
    expect(await status(s.org.orgId)).toBe('offboarding');
    // Only the refused attempts are noted (their audit rows and the refusal tally).
    expect(await snapshot(s.org.orgId)).toMatchObject({ ...before, 'crove_kernel.audit_event': expect.any(Number), 'crove_kernel.refusal_tally': expect.any(Number) });

    const t = await seed('Công ty Đang xuất');
    await offboard(t.org.orgId, { requestedDaysAgo: 40, exportedDaysAgo: 35 });
    expect(await run(t.org.slug, 40)).toMatchObject({ code: 1, out: expect.stringContaining('younger than ORG_PURGE_MIN_DAYS') });
    // The owner asked for a newer export, which has not finished.
    await admin(async (c) => recordAudit(c, t.org.orgId, 'kernel.org.offboard', 'user', t.owner, new Date(Date.now() - 2 * DAY), {}));
    expect(await run(t.org.slug)).toMatchObject({ code: 1, out: expect.stringContaining('newer export') });
    expect(await status(t.org.orgId)).toBe('offboarding');
    // Refusals inside the command are audited as refused, with nothing else written.
    expect(await count('crove_kernel.tenant_member', t.org.orgId)).toBe(2);
  });

  it('keeps the books and what append-only rows pin, deletes the rest with its blobs, and closes the org', async () => {
    const s = await seed('Công ty Rời đi');
    const other = await seed('Công ty Ở lại');
    await offboard(s.org.orgId);
    const otherBefore = await snapshot(other.org.orgId);
    const before = await snapshot(s.org.orgId);
    expect(store.blobs.has(s.loose.storageKey)).toBe(true);

    const { code, out } = await run(s.org.slug);
    expect(out).toContain(`org ${s.org.orgId} is now closed`);
    expect(code).toBe(0);
    expect(await status(s.org.orgId)).toBe('closed');

    const after = await snapshot(s.org.orgId);
    // Kept whole: the books, the audit and outbox streams, inbound addresses.
    for (const table of Object.keys(before).filter((t) => t.startsWith('crove_finance.') && t !== 'crove_finance.vendor_account_rule')) {
      expect([table, after[table]]).toEqual([table, before[table]]);
    }
    expect(after['crove_finance.purchase_document']).toBe(1);
    expect(after['crove_finance.journal_entry']).toBeGreaterThan(0);
    expect(after['crove_kernel.outbox_event']).toBe(before['crove_kernel.outbox_event']);
    expect(after['crove_kernel.inbound_address']).toBe(before['crove_kernel.inbound_address']);
    expect(after['crove_kernel.audit_event']).toBe((before['crove_kernel.audit_event'] ?? 0) + 1);
    // The booked file and its blob stay; the loose one goes with its blob.
    expect(after['crove_kernel.file']).toBe(1);
    expect(await one('SELECT id FROM crove_kernel.file WHERE org_id = $1', [s.org.orgId])).toEqual({ id: s.booked.fileId });
    expect(store.blobs.has(s.booked.storageKey)).toBe(true);
    expect(store.blobs.has(s.loose.storageKey)).toBe(false);
    // The booked party and the one only a ledger line names stay, anonymized; the stray one is deleted.
    expect(after['crove_kernel.party']).toBe(2);
    expect(
      await admin(async (c) => (await c.query('SELECT name IS NOT NULL AS named, email, phone, address FROM crove_kernel.party WHERE org_id = $1', [s.org.orgId])).rows),
    ).toEqual([
      { named: true, email: null, phone: null, address: null },
      { named: true, email: null, phone: null, address: null },
    ]);
    expect(await one('SELECT id FROM crove_kernel.party WHERE org_id = $1 AND id = $2', [s.org.orgId, s.ledgerParty])).toEqual({ id: s.ledgerParty });
    // The booked invoice's proposal stays (the approval trail); the stray one is deleted.
    expect(await admin(async (c) => (await c.query('SELECT id FROM crove_kernel.proposal WHERE org_id = $1', [s.org.orgId])).rows)).toEqual([{ id: s.proposalId }]);
    // The comment pins its task, the parent and the assignee position; the free task is gone.
    expect(await admin(async (c) => (await c.query('SELECT id FROM crove_kernel.task WHERE org_id = $1 ORDER BY id', [s.org.orgId])).rows.map((r) => r.id).sort())).toEqual(
      [s.parent, s.pinned].sort(),
    );
    expect(after['crove_kernel.task_comment']).toBe(1);
    expect(after['crove_kernel.position']).toBe(1);
    // Members, invites, proposals, extractions, activity: gone. Every other table of the org is empty.
    const keptTables = new Set([
      'crove_kernel.tenant',
      'crove_kernel.legal_entity',
      'crove_kernel.audit_event',
      'crove_kernel.outbox_event',
      'crove_kernel.inbound_address',
      'crove_kernel.org_usage',
      'crove_kernel.outbox_archive',
      'crove_kernel.external_call',
      'crove_kernel.file',
      'crove_kernel.party',
      'crove_kernel.proposal',
      'crove_kernel.task',
      'crove_kernel.task_comment',
      'crove_kernel.position',
    ]);
    const leftovers = Object.entries(after).filter(([t, n]) => n > 0 && !keptTables.has(t) && !(t.startsWith('crove_finance.') && t !== 'crove_finance.vendor_account_rule'));
    expect(leftovers).toEqual([]);
    // The org's default legal entity stays with the tenant row (#1278).
    expect(after['crove_kernel.legal_entity']).toBe(1);
    expect(before['crove_kernel.tenant_member']).toBe(2);
    expect(before['crove_kernel.proposal']).toBe(2);
    expect(before['crove_social.push_subscription']).toBe(1);
    expect(before['crove_social.saved_view']).toBe(1);
    expect(before['crove_social.media_archive']).toBe(2);

    // One audit row: by the system, with counts and the reason, and no personal data.
    const audits = await purgeAudits(s.org.orgId);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      outcome: 'ok',
      actor_type: 'system',
      detail: {
        reason: 'Owner left, export downloaded',
        minDays: 30,
        blobs: { deleted: 1, held: 0 },
        counts: {
          deleted: expect.objectContaining({ 'crove_kernel.tenant_member': 2, 'crove_kernel.file': 1, 'crove_kernel.party': 1, 'crove_kernel.task': 1, 'crove_kernel.proposal': 1, 'crove_social.push_subscription': 1, 'crove_social.saved_view': 1, 'crove_social.media_archive': 2 }),
          pinned: expect.objectContaining({ 'crove_kernel.task_comment': 1, 'crove_kernel.task': 2, 'crove_kernel.position': 1 }),
          anonymized: { 'crove_kernel.party': 2 },
          keptFiles: 1,
          keptParties: 2,
          keptProposals: 1,
        },
      },
    });
    const text = JSON.stringify(audits[0]?.detail);
    for (const secret of [s.ownerEmail, s.partyEmail, 'Đã xem', 'booked.xml', 'loose.xml']) expect(text).not.toContain(secret);

    // The other org is untouched, its blobs included.
    expect(await snapshot(other.org.orgId)).toEqual(otherBefore);
    expect(await status(other.org.orgId)).toBe('active');
    expect(store.blobs.has(other.loose.storageKey)).toBe(true);
    expect(store.blobs.has(other.booked.storageKey)).toBe(true);

    // A rerun changes nothing.
    expect(await run(s.org.orgId)).toEqual({ code: 0, out: `[org-purge] org ${s.org.orgId} is already closed; nothing to do` });
    expect(await snapshot(s.org.orgId)).toEqual(after);
    expect(await purgeAudits(s.org.orgId)).toHaveLength(1);
  });

  it('rolls everything back when a blob delete fails, and finishes on the next run', async () => {
    const s = await seed('Công ty Lỗi kho');
    await offboard(s.org.orgId);
    const before = await snapshot(s.org.orgId);
    store.failDeletes = true;
    try {
      expect(await run(s.org.slug)).toMatchObject({ code: 2, out: expect.stringContaining('a blob could not be deleted, nothing was purged: store unavailable') });
    } finally {
      store.failDeletes = false;
    }
    expect(await status(s.org.orgId)).toBe('offboarding');
    // Only the refused attempts are noted (their audit rows and the refusal tally).
    expect(await snapshot(s.org.orgId)).toMatchObject({ ...before, 'crove_kernel.audit_event': expect.any(Number), 'crove_kernel.refusal_tally': expect.any(Number) });
    expect(store.blobs.has(s.loose.storageKey)).toBe(true);
    expect(await run(s.org.slug)).toMatchObject({ code: 0 });
    expect(await status(s.org.orgId)).toBe('closed');
    expect(store.blobs.has(s.loose.storageKey)).toBe(false);
  });

  // The write fence (enter_context and enter_system_context hold the org's purge lock shared while it offboards): the
  // purge waits for a transaction already in the org, holds back one that enters meanwhile, and that one then finds
  // the org closed.
  it('waits for transactions already in the org and refuses those that enter while it runs', async () => {
    const s = await seed('Công ty Đang ghi');
    await offboard(s.org.orgId);
    const login = new URL(adminUrl);
    login.username = 'crove_worker';
    login.password = 'test-worker-pw';
    const inFlight = new pg.Client({ connectionString: login.toString() });
    const late = new pg.Client({ connectionString: login.toString() });
    await inFlight.connect();
    await late.connect();
    try {
      await inFlight.query('BEGIN');
      await inFlight.query('SELECT crove_kernel.enter_system_context($1)', [s.org.orgId]);
      let settled = false;
      const purge = run(s.org.slug).finally(() => {
        settled = true;
      });
      const purgeWaiting = async () => {
        for (let i = 0; i < 100; i++) {
          const waiting = await one<{ n: string }>(
            `SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%org_purge(%'`,
          );
          if (Number(waiting.n) > 0) return true;
          await new Promise((r) => setTimeout(r, 50));
        }
        return false;
      };
      expect(await purgeWaiting()).toBe(true);
      // A transaction that enters now waits too.
      await late.query('BEGIN');
      const entered = late.query('SELECT crove_kernel.enter_system_context($1)', [s.org.orgId]).then(
        () => 'entered',
        (e: Error) => e.message,
      );
      await new Promise((r) => setTimeout(r, 300));
      expect(settled).toBe(false);
      expect(await status(s.org.orgId)).toBe('offboarding');
      await inFlight.query('COMMIT');
      expect(await purge).toMatchObject({ code: 0 });
      expect(await entered).toBe('TENANT_NOT_ACTIVE');
      await late.query('ROLLBACK');
      expect(await status(s.org.orgId)).toBe('closed');
    } finally {
      await inFlight.end();
      await late.end();
    }
  });

  it('leaves a held blob in place and reports it', async () => {
    const s = await seed('Công ty Giữ tệp');
    await offboard(s.org.orgId);
    held = s.loose.storageKey;
    try {
      const { code, out } = await run(s.org.slug);
      expect(code).toBe(0);
      expect(out).toContain('blobs deleted 0, held 1 (under a retention hold, left in place)');
    } finally {
      held = null;
    }
    expect(store.blobs.has(s.loose.storageKey)).toBe(true);
    expect((await purgeAudits(s.org.orgId))[0]?.detail).toMatchObject({ blobs: { deleted: 0, held: 1 } });
  });
});
