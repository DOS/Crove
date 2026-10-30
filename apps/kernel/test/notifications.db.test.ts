// In-app notifications of the kernel and finance (#671) on a real PostgreSQL 17: an invoice read into a proposal tells
// the members who may approve it, and the notice reads as done once the proposal is decided; a file that failed to
// read tells whoever uploaded it; a bank import with lines to look at and a tax-portal list with missing invoices, or
// one that failed to read, tell the owners and admins (and the importer); a period whose VAT return is near and that is
// not locked tells the owners and admins once. Never the person who acted, never a kind the member turned off, never
// twice for one event, and each member reads and marks only their own. The worker routes the events to the
// dispatches; here the test runs the dispatch commands itself, as the worker's job does.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import type { ExtractClient } from '@crove/extract-contract';
import { zNotifications, type Notifications } from '@crove/kernel-contract';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime, fileKey, sha256Hex, type BlobStore } from '@crove/kernel-runtime';
import { extractAndPropose, financeCommands, financeQueries, recordExtractionFailure, sweepPeriodClosing } from '@crove/mod-finance';
import { inProcessExtract } from './extract-service.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const FIXTURE = readFileSync(new URL('../../extract/test/fixtures/einvoice-basic.xml', import.meta.url), 'utf8');
const SYSTEM = { type: 'system' as const, component: 'test.notify' };

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

const suite = ADMIN ? describe : describe.skip;

suite('in-app notifications of the kernel and finance (#671)', () => {
  const dbName = `crove_test_notify_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let runtime: Runtime;
  let workerRuntime: Runtime;
  let workerDb: Db;
  const store = new MemoryStore();
  let extract: ExtractClient;
  const people = { owner: '', admin: '', member: '', viewer: '', outsider: '' };
  let org = { slug: '', orgId: '' };
  let other = { slug: '', orgId: '' };
  let invoiceNo = 7000;

  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const asMfa = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal2' as const, sessionId: randomUUID(), mfaAt: Math.floor(Date.now() / 1000) });
  const list = async (userId: string, orgId = org.orgId) => zNotifications.parse(await runtime.query<Notifications>('kernel.notification.list', {}, { actor: asUser(userId), orgId }));
  const kinds = async (userId: string) => (await list(userId)).items.map((i) => i.kind);

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  // Runs the dispatch of every event of `type` in the org that has not been dispatched by this test yet, as the
  // worker's kernel-notify job does (the same command twice for each, to show a replay writes nothing).
  const dispatched = new Set<string>();
  async function dispatch(type: string, orgId = org.orgId): Promise<number> {
    const { rows } = await admin((c) => c.query<{ id: string }>('SELECT id FROM crove_kernel.outbox_event WHERE org_id = $1 AND type = $2 ORDER BY id', [orgId, type]));
    const command = type.startsWith('finance.') ? 'finance.notification.dispatch' : 'kernel.notification.dispatch';
    let sent = 0;
    for (const { id } of rows) {
      if (dispatched.has(id)) continue;
      dispatched.add(id);
      sent += (await workerRuntime.execute<{ sent: number }>(command, { eventId: id }, { actor: SYSTEM, orgId })).sent;
      expect((await workerRuntime.execute<{ sent: number }>(command, { eventId: id }, { actor: SYSTEM, orgId })).sent).toBe(0);
    }
    return sent;
  }

  async function ingest(who: string, bytes: Uint8Array, filename = 'hd.xml', target = org): Promise<string> {
    const sha256 = sha256Hex(bytes);
    const storageKey = fileKey(target.orgId, sha256);
    const generation = await store.put(storageKey, bytes);
    const { fileId } = await runtime.execute<{ fileId: string }>(
      'kernel.file.ingest',
      { filename, contentType: 'application/xml', sizeBytes: bytes.byteLength, sha256, storageKey, generation, source: 'upload' },
      { actor: asUser(who), orgId: target.orgId },
    );
    return fileId;
  }

  // The member uploads an invoice; the worker reads it into a purchase proposal.
  async function propose(who = people.member): Promise<string> {
    const bytes = new TextEncoder().encode(FIXTURE.replace('<SHDon>1234</SHDon>', `<SHDon>${invoiceNo++}</SHDon>`));
    const fileId = await ingest(who, bytes);
    const { proposalId } = await extractAndPropose({ runtime: workerRuntime, store, extractor: null, extract, today: () => '2026-10-17' }, org.orgId, fileId);
    if (!proposalId) throw new Error('the invoice raised no proposal');
    return proposalId;
  }

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
    pool = createPool({ connectionString: login('crove_app', 'test-app-pw'), max: 4 });
    workerPool = createPool({ connectionString: login('crove_worker', 'test-worker-pw'), max: 2 });
    const db = createDb(pool);
    workerDb = createDb(workerPool);
    const register = (target: Db) =>
      new Runtime(target, { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands, ...financeCommands], queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries] });
    runtime = register(db);
    workerRuntime = register(workerDb);
    for (const key of Object.keys(people) as (keyof typeof people)[]) {
      people[key] = await upsertIdentity(db, { issuer: 'test', subject: `notify-${key}`, email: `${key}@notify.test`, name: key });
    }
    org = await createOrg(runtime, asUser(people.owner), 'Công ty Thông báo');
    for (const [who, role] of [
      [people.admin, 'admin'],
      [people.member, 'member'],
      [people.viewer, 'viewer'],
    ] as const) {
      const { acceptPath } = await runtime.execute<{ acceptPath: string }>('kernel.member.invite.create', { email: `${Object.entries(people).find(([, id]) => id === who)?.[0]}@notify.test`, role }, { actor: asMfa(people.owner), orgId: org.orgId });
      await runtime.executeOrgless('kernel.member.invite.accept', { token: acceptPath.split('#')[1] }, { actor: asUser(who) });
    }
    other = await createOrg(runtime, asUser(people.outsider), 'Công ty Khác');
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('tells the members who may approve an invoice, once, and shows it done once decided', async () => {
    const proposalId = await propose();
    expect(await dispatch('kernel.proposal.created')).toBe(2);
    const owner = await list(people.owner);
    expect(owner.unread).toBe(1);
    // The proposal's title, read when the notice is shown; the notice keeps no copy of it (#1977).
    const { title } = (await admin((c) => c.query<{ title: string }>('SELECT title FROM crove_kernel.proposal WHERE id = $1', [proposalId]))).rows[0] as { title: string };
    expect(owner.items).toEqual([
      expect.objectContaining({ kind: 'kernel.approval_waiting', subjectType: 'kernel.proposal', subjectId: proposalId, read: false, detail: { title: title.slice(0, 200) } }),
    ]);
    expect((await admin((c) => c.query(`SELECT DISTINCT detail FROM crove_kernel.notification WHERE subject_id = $1`, [proposalId]))).rows).toEqual([{ detail: {} }]);
    expect(await kinds(people.admin)).toEqual(['kernel.approval_waiting']);
    // Members and viewers may not approve a purchase: nothing for them.
    expect(await kinds(people.member)).toEqual([]);
    expect(await kinds(people.viewer)).toEqual([]);

    // The admin approves (four-eyes: the member uploaded it): the owner's notice no longer counts as unread.
    // The fixture carries no signature (#674), so the approver confirms that, as for any unverified invoice.
    await runtime.execute('kernel.proposal.approve', { id: proposalId, revision: 1, acceptUnverifiedSignature: true }, { actor: asMfa(people.admin), orgId: org.orgId, idempotencyKey: randomUUID() });
    expect(await list(people.owner)).toMatchObject({ unread: 0, items: [expect.objectContaining({ subjectId: proposalId, read: true })] });
  });

  it('tells the uploader of a file that failed to read, and nobody for a kind they turned off', async () => {
    const fileId = await ingest(people.member, new TextEncoder().encode('not an invoice'), 'rac.xml');
    await recordExtractionFailure(workerRuntime, org.orgId, fileId, 'Không đọc được chứng từ');
    expect(await dispatch('kernel.file.read_failed')).toBe(1);
    expect((await list(people.member)).items).toEqual([expect.objectContaining({ kind: 'kernel.file_unreadable', subjectId: fileId, detail: { filename: 'rac.xml' } })]);
    // The name is the file's, read when the notice is shown (#1977).
    expect((await admin((c) => c.query(`SELECT detail FROM crove_kernel.notification WHERE subject_id = $1`, [fileId]))).rows).toEqual([{ detail: {} }]);

    // Turned off: the next one is not written for them.
    await runtime.execute('kernel.notification.mute', { kind: 'kernel.file_unreadable', muted: true }, { actor: asUser(people.member), orgId: org.orgId });
    expect((await list(people.member)).muted).toEqual(['kernel.file_unreadable']);
    const second = await ingest(people.member, new TextEncoder().encode('still not an invoice'), 'rac2.xml');
    await recordExtractionFailure(workerRuntime, org.orgId, second, 'Không đọc được chứng từ');
    expect(await dispatch('kernel.file.read_failed')).toBe(0);
    await runtime.execute('kernel.notification.mute', { kind: 'kernel.file_unreadable', muted: false }, { actor: asUser(people.member), orgId: org.orgId });
    expect((await list(people.member)).muted).toEqual([]);
  });

  it('keeps each member to their own notifications and lets them change only read_at', async () => {
    const mine = await list(people.member);
    const id = mine.items[0]?.id;
    expect(id).toBeDefined();
    // The owner cannot mark another member's notification read, nor see it.
    expect(await runtime.execute('kernel.notification.read', { ids: [id] }, { actor: asUser(people.owner), orgId: org.orgId })).toEqual({ read: 0 });
    expect((await list(people.owner)).items.map((i) => i.id)).not.toContain(id);
    expect(await runtime.execute('kernel.notification.read', { all: true }, { actor: asUser(people.member), orgId: org.orgId })).toEqual({ read: 1 });
    expect((await list(people.member)).unread).toBe(0);
    // Another org sees none of them.
    expect((await list(people.outsider, other.orgId)).items).toEqual([]);

    // Members may update read_at and no other column.
    await admin(async (c) => {
      const { rows } = await c.query<{ grantee: string; privilege_type: string; column_name: string }>(
        `SELECT grantee, privilege_type, column_name FROM information_schema.column_privileges
         WHERE table_schema = 'crove_kernel' AND table_name = 'notification' AND privilege_type = 'UPDATE' AND grantee = 'crove_tenant'`,
      );
      expect(rows.map((r) => r.column_name)).toEqual(['read_at']);
    });
  });

  it('tells the owners and admins about a bank import with lines to look at, never the importer', async () => {
    const importId = randomUUID();
    // The event finance.bank.import emits; written here as emit() writes it, with the admin as the actor.
    await admin((c) =>
      c.query(`INSERT INTO crove_kernel.outbox_event (org_id, type, payload, actor_type, actor_id) VALUES ($1, 'finance.bank.imported', $2, 'user', $3)`, [
        org.orgId,
        JSON.stringify({ importId, bankAccount: '1121', ambiguous: 2 }),
        people.admin,
      ]),
    );
    expect(await dispatch('finance.bank.imported')).toBe(1);
    expect((await list(people.owner)).items[0]).toMatchObject({ kind: 'finance.bank_attention', subjectId: importId, detail: { bankAccount: '1121', lines: '2' } });
    expect(await kinds(people.admin)).not.toContain('finance.bank_attention');
  });

  it('tells the importer and the owners and admins about a portal list with missing invoices or that failed to read', async () => {
    const pendingList = async () => {
      const fileId = await ingest(people.member, new TextEncoder().encode(`list ${randomUUID()}`), 'bang-ke.xlsx');
      return admin(async (c) => (await c.query<{ id: string }>(`INSERT INTO crove_finance.portal_invoice_list (org_id, period, file_id, filename, created_by) VALUES ($1, '2026-09', $2, 'bang-ke.xlsx', $3) RETURNING id`, [org.orgId, fileId, people.member])).rows[0]?.id as string);
    };
    const failed = await pendingList();
    await workerRuntime.execute('finance.portal_list.record', { listId: failed, status: 'failed', error: 'Không đọc được' }, { actor: SYSTEM, orgId: org.orgId });
    expect(await dispatch('finance.portal_list.recorded')).toBe(3);
    expect((await list(people.member)).items[0]).toMatchObject({ kind: 'finance.portal_attention', subjectId: failed, detail: { period: '2026-09', failed: 'true' } });

    // A list with an invoice Crove does not have.
    const done = await pendingList();
    await workerRuntime.execute(
      'finance.portal_list.record',
      {
        listId: done,
        status: 'done',
        listFrom: '2026-09-01',
        listTo: '2026-09-30',
        buyerTaxCode: null,
        rows: [
          { rowNo: 1, sellerTaxCode: '0309876546', sellerName: 'Nhà cung cấp lạ', template: '1', series: 'C26TAB', number: '99', issueDate: '2026-09-10', currency: 'VND', subtotal: '100000', vatAmount: '10000', total: '110000', status: 'original', statusLabel: null, checkResult: null },
        ],
        ownSalesCount: 0,
        otherBuyerCount: 0,
        skippedCount: 0,
        skipped: [],
      },
      { actor: SYSTEM, orgId: org.orgId },
    );
    expect(await dispatch('finance.portal_list.recorded')).toBe(3);
    expect((await list(people.owner)).items[0]).toMatchObject({ kind: 'finance.portal_attention', subjectId: done, detail: { period: '2026-09', missing: '1' } });
  });

  it('tells the owners and admins once when a VAT return is near and its period is not locked', async () => {
    const remind = (today: string) => workerRuntime.execute<{ sent: number }>('finance.period.closing_remind', { today }, { actor: SYSTEM, orgId: org.orgId });
    // September's monthly return is due on 20 October 2026: far on the 1st, near on the 16th.
    expect(await remind('2026-10-01')).toEqual({ sent: 0 });
    expect(await remind('2026-10-16')).toEqual({ sent: 2 });
    expect(await remind('2026-10-17')).toEqual({ sent: 0 });
    expect((await list(people.owner)).items[0]).toMatchObject({ kind: 'finance.period_closing', detail: { period: '2026-09', dueDate: '2026-10-20' } });
    expect(await kinds(people.member)).not.toContain('finance.period_closing');

    // The sweep reads the orgs through its definer, which only the worker may run: this org is told already, the other
    // org's owner now.
    expect(await sweepPeriodClosing({ runtime: workerRuntime, workerDb, today: '2026-10-16' })).toBe(1);
    expect((await list(people.outsider, other.orgId)).items).toEqual([expect.objectContaining({ kind: 'finance.period_closing' })]);
    await admin(async (c) => {
      const { rows } = await c.query<{ role: string }>(
        `SELECT r AS role FROM unnest(ARRAY['crove_app', 'crove_worker', 'crove_tenant', 'crove_definer_tenant']) r
         WHERE has_function_privilege(r, 'crove_finance.period_close_due(uuid, int)', 'EXECUTE')`,
      );
      expect(rows.map((r) => r.role)).toEqual(['crove_worker']);
    });
  });

  it("answers one row per org from the sweep's definer, with the earliest lock across its legal entities (#1532)", async () => {
    // Two more entities for the org, each with a lock of its own (one row per org and entity since #1503).
    const [second, third] = await admin(async (c) => {
      const add = async (name: string) =>
        (await c.query<{ id: string }>(`INSERT INTO crove_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, $2, 'branch', $3) RETURNING id`, [org.orgId, name, people.owner]))
          .rows[0]?.id as string;
      return [await add('Chi nhánh Một'), await add('Chi nhánh Hai')];
    });
    const lock = (entity: string | null, from: string | null, through: string | null) =>
      admin((c) =>
        c.query(
          `INSERT INTO crove_finance.period_lock (org_id, legal_entity_id, locked_from, locked_through)
           VALUES ($1, coalesce($2::uuid, (SELECT e.id FROM crove_kernel.legal_entity e WHERE e.org_id = $1 AND e.is_default)), $3::date, $4::date)
           ON CONFLICT (org_id, legal_entity_id) DO UPDATE SET locked_from = EXCLUDED.locked_from, locked_through = EXCLUDED.locked_through`,
          [org.orgId, entity, from, through],
        ),
      );
    await lock(null, '2026-01-01', '2026-09-30');
    await lock(second as string, '2026-01-01', '2026-07-31');
    await lock(third as string, '2026-01-01', '2026-08-31');
    // Every page the sweep reads: one org per page, or whole pages, each org once either way.
    const walk = async (page = 1) => {
      const seen: Array<{ org_id: string; locked_through: string | null }> = [];
      let after: string | null = null;
      for (;;) {
        const { rows }: { rows: Array<{ org_id: string; locked_through: string | null }> } = await sql<{ org_id: string; locked_through: string | null }>`
          SELECT org_id, pg_catalog.to_char(locked_through, 'YYYY-MM-DD') AS locked_through FROM crove_finance.period_close_due(${after}::uuid, ${page}::int)`.execute(workerDb);
        if (rows.length === 0) return seen;
        seen.push(...rows);
        after = rows.at(-1)?.org_id ?? null;
      }
    };
    for (const page of [1, 500]) {
      const seen = await walk(page);
      expect(new Set(seen.map((r) => r.org_id)).size, `page ${page}`).toBe(seen.length);
      expect(seen.filter((r) => r.org_id === org.orgId), `page ${page}`).toEqual([{ org_id: org.orgId, locked_through: '2026-07-31' }]);
    }
    // An entity whose lock row locks nothing leaves the period open: the org has no lock.
    await lock(third as string, null, null);
    expect((await walk()).filter((r) => r.org_id === org.orgId)).toEqual([{ org_id: org.orgId, locked_through: null }]);
  });
});
