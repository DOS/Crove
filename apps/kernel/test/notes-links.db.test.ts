// Notes linked to documents, vouchers and bookings on PostgreSQL 17 (issue #1672, plan docs/plan/notes.md step N3): a
// link to a finance or crm record is checked through that module's own get query in the writer's context, and shown to
// each reader as they may open the record now. A voucher of entity A shows to a member of A and as unavailable
// ("Bản ghi không mở được") to a member limited to B; with finance off the notes still load and its links show as
// unavailable; a private note's audit rows never name the record. Set CROVE_TEST_ADMIN_URL to a superuser URL; the run
// makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import type { Note, NoteRecordPanel, NoteSummary, NoteWritten } from '@crove/kernel-contract';
import { Runtime } from '@crove/kernel-runtime';
import { crmCommands, crmQueries } from '@crove/mod-crm';
import { financeCommands, financeQueries } from '@crove/mod-finance';
import { notesCommands, notesQueries } from '@crove/mod-notes';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('notes linked to documents, vouchers and bookings on PostgreSQL (#1672)', () => {
  const dbName = `crove_test_notes_links_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  // Every module, and a deployment without finance (CROVE_MODULES leaves it out).
  let app: Runtime;
  let noFinance: Runtime;
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  // A sales document of an entity and the journal entry that posts it, written by the database owner.
  const book = (c: pg.Client, orgId: string, party: string, entity: string, number: string) =>
    (async () => {
      await c.query('BEGIN');
      try {
        const doc = (
          await c.query<{ id: string }>(
            `INSERT INTO crove_finance.purchase_document (org_id, party_id, invoice_series, invoice_number, invoice_date, subtotal, vat_amount, total, direction, legal_entity_id)
             VALUES ($1, $2, '1C26TAA', $3, '2026-09-10', 100, 0, 100, 'sale', $4) RETURNING id`,
            [orgId, party, number, entity],
          )
        ).rows[0]?.id as string;
        const entry = (
          await c.query<{ id: string }>(
            `INSERT INTO crove_finance.journal_entry (org_id, entry_date, description, source_type, source_id, legal_entity_id)
             VALUES ($1, '2026-09-10', 'bán', 'finance.purchase_document', $2, $3) RETURNING id`,
            [orgId, doc, entity],
          )
        ).rows[0]?.id as string;
        await c.query(`INSERT INTO crove_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit) VALUES ($1, $2, 1, '131', 100, 0), ($1, $2, 2, '5111', 0, 100)`, [
          orgId,
          entry,
        ]);
        await c.query('COMMIT');
        return { doc, entry };
      } catch (error) {
        await c.query('ROLLBACK');
        throw error;
      }
    })();

  // An org with two legal entities: the default one (A) and a branch (B). The author and another member reach every
  // entity; accountantA and accountantB are members limited to A and to B (external_accountant). A document and its
  // entry in each entity, and a confirmed booking of a type the author hosts.
  async function org() {
    const tag = randomUUID().slice(0, 8);
    const user = (name: string) => upsertIdentity(db, { issuer: 'notes-links', subject: `${name}-${tag}`, email: `${name}-${tag}@notes-links.test`, name: null });
    const owner = await user('owner');
    const author = await user('author');
    const other = await user('other');
    const accountantA = await user('accountant-a');
    const accountantB = await user('accountant-b');
    const { orgId } = await createOrg(app, asUser(owner), `Liên kết ${tag}`);
    const fixtures = await admin(async (c) => {
      const entityA = (await c.query<{ id: string }>('SELECT id FROM crove_kernel.legal_entity WHERE org_id = $1 AND is_default', [orgId])).rows[0]?.id as string;
      const entityB = (await c.query<{ id: string }>(`INSERT INTO crove_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhánh', 'branch', $2) RETURNING id`, [orgId, owner]))
        .rows[0]?.id as string;
      for (const [u, role] of [
        [author, 'member'],
        [other, 'member'],
        [accountantA, 'member'],
        [accountantB, 'member'],
      ] as const) {
        await c.query('INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, $3)', [orgId, u, role]);
      }
      for (const [u, entity] of [
        [accountantA, entityA],
        [accountantB, entityB],
      ] as const) {
        await c.query(`INSERT INTO crove_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by) VALUES ($1, $2, 'external_accountant', $3, $4)`, [
          orgId,
          u,
          entity,
          owner,
        ]);
      }
      const party = (await c.query<{ id: string }>(`INSERT INTO crove_kernel.party (org_id, name) VALUES ($1, 'Khách hàng') RETURNING id`, [orgId])).rows[0]?.id as string;
      const a = await book(c, orgId, party, entityA, '00000001');
      const b = await book(c, orgId, party, entityB, '00000002');
      const type = (
        await c.query<{ id: string }>(
          `INSERT INTO crove_crm.event_type (org_id, slug, title, duration_min, host_user_id, created_by) VALUES ($1, 'tu-van', 'Tư vấn', 30, $2, $2) RETURNING id`,
          [orgId, author],
        )
      ).rows[0]?.id as string;
      const event = (
        await c.query<{ id: string }>(
          `INSERT INTO crove_kernel.calendar_event (org_id, user_id, starts_at, ends_at, time_zone, title, kind, created_by)
           VALUES ($1, $2, '2026-12-01T03:00:00Z', '2026-12-01T03:30:00Z', 'Asia/Ho_Chi_Minh', 'Tư vấn', 'booking', $2) RETURNING id`,
          [orgId, author],
        )
      ).rows[0]?.id as string;
      const booking = (
        await c.query<{ id: string }>(
          `INSERT INTO crove_crm.booking (org_id, event_type_id, starts_at, ends_at, status, calendar_event_id, visitor_name, email, time_zone, decided_at)
           VALUES ($1, $2, '2026-12-01T03:00:00Z', '2026-12-01T03:30:00Z', 'confirmed', $3, 'Khách', 'khach@notes-links.test', 'Asia/Ho_Chi_Minh', now()) RETURNING id`,
          [orgId, type, event],
        )
      ).rows[0]?.id as string;
      return { entityA, entityB, party, a, b, booking };
    });
    const exec = <O>(userId: string, name: string, input: unknown = {}, rt: Runtime = app) => rt.execute<O>(name, input, { actor: asUser(userId), orgId });
    const query = <O>(userId: string, name: string, input: unknown = {}, rt: Runtime = app) => rt.query<O>(name, input, { actor: asUser(userId), orgId });
    // Each link of a note as the reader gets it: its type and whether they can open the record.
    const links = async (userId: string, noteId: string, rt: Runtime = app) =>
      (await query<Note>(userId, 'notes.note.get', { noteId }, rt)).links.map((l) => [l.targetType, l.targetId, l.available]);
    return { orgId, owner, author, other, accountantA, accountantB, ...fixtures, exec, query, links };
  }

  const audit = (orgId: string, noteId: string) =>
    admin(
      async (c) =>
        (
          await c.query<{ command: string; detail: Record<string, unknown> }>(
            `SELECT command, detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command LIKE 'notes.%' AND detail ->> 'noteId' = $2 ORDER BY occurred_at, id`,
            [orgId, noteId],
          )
        ).rows,
    );

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
    const url = new URL(adminUrl);
    url.username = 'crove_app';
    url.password = 'test-app-pw';
    pool = createPool({ connectionString: url.toString(), max: 4 });
    db = createDb(pool);
    const kernel = { commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) };
    app = new Runtime(db).register({
      commands: [...kernel.commands, ...financeCommands, ...crmCommands, ...notesCommands],
      queries: [...kernel.queries, ...financeQueries, ...crmQueries, ...notesQueries],
    });
    noFinance = new Runtime(db, { absentModules: ['finance'] }).register({
      commands: [...kernel.commands, ...crmCommands, ...notesCommands],
      queries: [...kernel.queries, ...crmQueries, ...notesQueries],
    });
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('links a note to a voucher, a document and a booking, each checked through its own module, and shows each reader what they can open', async () => {
    const o = await org();
    const { noteId } = await o.exec<NoteWritten>(o.author, 'notes.note.create', {
      title: 'Hóa đơn bán hàng tháng 9',
      visibility: 'org',
      link: { targetType: 'finance.journal_entry', targetId: o.a.entry },
    });
    await o.exec(o.author, 'notes.link.add', { noteId, targetType: 'finance.purchase_document', targetId: o.a.doc });
    await o.exec(o.author, 'notes.link.add', { noteId, targetType: 'crm.booking', targetId: o.booking });
    const all: Array<[string, string, boolean]> = [
      ['finance.journal_entry', o.a.entry, true],
      ['finance.purchase_document', o.a.doc, true],
      ['crm.booking', o.booking, true],
    ];
    // The author hosts the booking; an owner sees every booking of the org.
    expect(await o.links(o.author, noteId)).toEqual(all);
    expect(await o.links(o.owner, noteId)).toEqual(all);
    // Another member reads the shared note and the books, but the booking is not of a type they host or hold.
    expect(await o.links(o.other, noteId)).toEqual([
      ['finance.journal_entry', o.a.entry, true],
      ['finance.purchase_document', o.a.doc, true],
      ['crm.booking', o.booking, false],
    ]);
    // The record's panel lists the note on each of the three pages.
    for (const [targetType, targetId] of all) {
      const panel = await o.query<NoteRecordPanel>(o.other, 'notes.record.panel', { targetType, targetId });
      expect(panel.latest.map((n) => n.id), targetType).toEqual([noteId]);
    }
    // A record that is not there, of another type, or that the writer cannot open is refused, the same way each time.
    for (const [targetType, targetId] of [
      ['finance.journal_entry', randomUUID()],
      ['finance.journal_entry', o.a.doc],
      ['finance.purchase_document', o.a.entry],
      ['crm.booking', randomUUID()],
    ]) {
      await expect(o.exec(o.author, 'notes.link.add', { noteId, targetType, targetId })).rejects.toMatchObject({ code: 'NOTE_LINK_TARGET_NOT_FOUND', status: 404 });
    }
    const { noteId: mine } = await o.exec<NoteWritten>(o.other, 'notes.note.create', { title: 'Lịch hẹn của đồng nghiệp' });
    await expect(o.exec(o.other, 'notes.link.add', { noteId: mine, targetType: 'crm.booking', targetId: o.booking })).rejects.toMatchObject({ code: 'NOTE_LINK_TARGET_NOT_FOUND' });
    // A shared note's audit rows name the records it links.
    expect((await audit(o.orgId, noteId)).map((r) => r.detail)).toEqual([
      expect.objectContaining({ targetType: 'finance.journal_entry', targetId: o.a.entry }),
      expect.objectContaining({ targetType: 'finance.purchase_document', targetId: o.a.doc }),
      expect.objectContaining({ targetType: 'crm.booking', targetId: o.booking }),
    ]);
    // A module record has no column of its own on the link: party_id and file_id stay empty.
    const rows = await admin((c) => c.query('SELECT target_type, party_id, file_id FROM crove_notes.link WHERE org_id = $1 AND note_id = $2 ORDER BY created_at, id', [o.orgId, noteId]));
    expect(rows.rows).toEqual(all.map(([t]) => ({ target_type: t, party_id: null, file_id: null })));
  });

  it("shows a voucher of entity A to a member of A, and as unavailable to a member limited to B, without naming it in a private note's audit", async () => {
    const o = await org();
    // A member of A links their private note to A's voucher and document and sees both.
    const { noteId } = await o.exec<NoteWritten>(o.accountantA, 'notes.note.create', {
      title: 'Kiểm tra hóa đơn',
      link: { targetType: 'finance.journal_entry', targetId: o.a.entry },
    });
    await o.exec(o.accountantA, 'notes.link.add', { noteId, targetType: 'finance.purchase_document', targetId: o.a.doc });
    expect(await o.links(o.accountantA, noteId)).toEqual([
      ['finance.journal_entry', o.a.entry, true],
      ['finance.purchase_document', o.a.doc, true],
    ]);
    // A member limited to B cannot link A's records, and links B's.
    const { noteId: noteB } = await o.exec<NoteWritten>(o.accountantB, 'notes.note.create', { title: 'Chi nhánh' });
    for (const [targetType, targetId] of [
      ['finance.journal_entry', o.a.entry],
      ['finance.purchase_document', o.a.doc],
    ]) {
      await expect(o.exec(o.accountantB, 'notes.link.add', { noteId: noteB, targetType, targetId })).rejects.toMatchObject({ code: 'NOTE_LINK_TARGET_NOT_FOUND', status: 404 });
    }
    await expect(o.exec(o.accountantB, 'notes.note.create', { title: 'A', link: { targetType: 'finance.journal_entry', targetId: o.a.entry } })).rejects.toMatchObject({
      code: 'NOTE_LINK_TARGET_NOT_FOUND',
    });
    await o.exec(o.accountantB, 'notes.link.add', { noteId: noteB, targetType: 'finance.journal_entry', targetId: o.b.entry });
    expect(await o.links(o.accountantB, noteB)).toEqual([['finance.journal_entry', o.b.entry, true]]);
    // The member of A is moved to B: their note stays theirs, and A's records show as unavailable.
    await admin(async (c) => {
      await c.query('DELETE FROM crove_kernel.role_assignment WHERE org_id = $1 AND user_id = $2', [o.orgId, o.accountantA]);
      await c.query(`INSERT INTO crove_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by) VALUES ($1, $2, 'external_accountant', $3, $4)`, [
        o.orgId,
        o.accountantA,
        o.entityB,
        o.owner,
      ]);
    });
    expect(await o.links(o.accountantA, noteId)).toEqual([
      ['finance.journal_entry', o.a.entry, false],
      ['finance.purchase_document', o.a.doc, false],
    ]);
    // Nobody else reads the private note or its links, whole-org members included.
    for (const reader of [o.owner, o.author, o.accountantB]) {
      await expect(o.query(reader, 'notes.note.get', { noteId })).rejects.toMatchObject({ code: 'NOTE_NOT_FOUND', status: 404 });
      const panel = await o.query<NoteRecordPanel>(reader, 'notes.record.panel', { targetType: 'finance.journal_entry', targetId: o.a.entry });
      expect([...panel.pinned, ...panel.latest], reader).toEqual([]);
    }
    // The private note's audit rows say a link was made, never to which record (ADR-0037 §3).
    const rows = await audit(o.orgId, noteId);
    expect(rows.map((r) => r.command)).toEqual(['notes.note.create', 'notes.link.add']);
    for (const r of rows) {
      expect(r.detail).toMatchObject({ target: 'private' });
      expect(JSON.stringify(r.detail)).not.toContain(o.a.entry);
      expect(JSON.stringify(r.detail)).not.toContain(o.a.doc);
      expect(r.detail).not.toHaveProperty('targetType');
    }
    // A shared note on A's voucher is read only by whole-org members (decision N-4): a member limited to B sees none.
    const { noteId: shared } = await o.exec<NoteWritten>(o.author, 'notes.note.create', {
      title: 'Bút toán A',
      visibility: 'org',
      link: { targetType: 'finance.journal_entry', targetId: o.a.entry },
    });
    await expect(o.query(o.accountantB, 'notes.note.get', { noteId: shared })).rejects.toMatchObject({ code: 'NOTE_NOT_FOUND' });
    expect(await o.query<NoteSummary[]>(o.accountantB, 'notes.note.list', { view: 'shared' })).toEqual([]);
  });

  it('keeps the notes working with finance off, and shows its links as unavailable', async () => {
    const o = await org();
    const { noteId } = await o.exec<NoteWritten>(o.author, 'notes.note.create', {
      title: 'Ghi chú nhiều liên kết',
      visibility: 'org',
      link: { targetType: 'finance.journal_entry', targetId: o.a.entry },
    });
    await o.exec(o.author, 'notes.link.add', { noteId, targetType: 'crm.booking', targetId: o.booking });
    await o.exec(o.author, 'notes.link.add', { noteId, targetType: 'kernel.party', targetId: o.party });
    expect(await o.links(o.author, noteId, noFinance)).toEqual([
      ['finance.journal_entry', o.a.entry, false],
      ['crm.booking', o.booking, true],
      ['kernel.party', o.party, true],
    ]);
    // The lists and the panels still load, the finance record's included.
    expect((await o.query<NoteSummary[]>(o.other, 'notes.note.list', { view: 'shared' }, noFinance)).map((n) => n.id)).toEqual([noteId]);
    const panel = await o.query<NoteRecordPanel>(o.other, 'notes.record.panel', { targetType: 'finance.journal_entry', targetId: o.a.entry }, noFinance);
    expect(panel.latest.map((n) => n.id)).toEqual([noteId]);
    // No new link to a record of a module that is off.
    const { noteId: fresh } = await o.exec<NoteWritten>(o.author, 'notes.note.create', { title: 'Mới' }, noFinance);
    await expect(o.exec(o.author, 'notes.link.add', { noteId: fresh, targetType: 'finance.purchase_document', targetId: o.a.doc }, noFinance)).rejects.toMatchObject({
      code: 'NOTE_LINK_TARGET_NOT_FOUND',
    });
    // The link added while finance was on still opens once it is back.
    expect((await o.links(o.author, noteId))[0]).toEqual(['finance.journal_entry', o.a.entry, true]);
  });
});
