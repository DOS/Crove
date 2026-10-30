// A person's data under the PDPL (issue #923), on PostgreSQL 17. Finding: an owner or admin looks up an email address,
// a phone number in any common spelling, or a tax code, and gets every matching row of the org with what an erasure
// would do to it; another org's rows never show; members cannot search; a value that is none of these is refused. A
// legal entity the org keeps books for (a household's 12-digit code is its owner's ID number) is found and kept by law,
// the default entity as the org's own (#1312).
// Erasing (owners, R3): the contact fields go, a party nothing in the books names loses its name and tax code too, a
// party in the books keeps them, the mail recipient goes but its hash stays, a report schedule loses the address (and
// goes when nobody is left), and the audit row holds counts only.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { ACTIVITY_SHORT_NUMBER_REASON, createOrg, kernelCommands, kernelQueries, PERSONAL_DATA_COLUMNS, personalDataProbe, upsertIdentity, type PersonalDataColumn } from '@crove/kernel';
import type { PersonalDataErasure, PersonalDataResult } from '@crove/kernel-contract';
import { Runtime } from '@crove/kernel-runtime';
import { enterUser } from './context-token.ts';
import { TEST_MANIFESTS } from './manifests.ts';
import { PII_TEXT_CASES } from './pii-text-cases.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('finding a person in the org (#923)', () => {
  const dbName = `crove_test_pdpl_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  let org = { orgId: '', owner: '', admin: '', member: '' };
  let other = { orgId: '', owner: '' };
  let person = '';

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  const identity = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@pdpl.test`, name: null });
  const find = (value: string, user = org.owner, orgId = org.orgId) =>
    rt.query<PersonalDataResult>('kernel.personal_data.find', { value }, { actor: asUser(user), orgId });
  const columns = (result: PersonalDataResult) => result.matches.map((m) => m.column).sort();
  const asMfa = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal2' as const, sessionId: randomUUID(), mfaAt: Math.floor(Date.now() / 1000) });
  const erase = (value: string, user = org.owner) =>
    rt.execute<PersonalDataErasure>('kernel.personal_data.erase', { value }, { actor: asMfa(user), orgId: org.orgId, idempotencyKey: randomUUID() });

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
    const app = new URL(adminUrl);
    app.username = 'crove_app';
    app.password = 'test-app-pw';
    pool = createPool({ connectionString: app.toString(), max: 4 });
    db = createDb(pool);
    rt = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) });

    const owner = await identity('owner');
    org = { orgId: (await createOrg(rt, asUser(owner), `Org ${randomUUID().slice(0, 6)}`)).orgId, owner, admin: await identity('admin'), member: await identity('member') };
    await admin((c) =>
      c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member')`, [org.orgId, org.admin, org.member]),
    );
    const otherOwner = await identity('other');
    other = { orgId: (await createOrg(rt, asUser(otherOwner), `Other ${randomUUID().slice(0, 6)}`)).orgId, owner: otherOwner };

    // A person among the org's parties, a mail sent to them, the org's contact; and the same person in another org.
    for (const orgId of [org.orgId, other.orgId]) {
      const { rows } = await admin((c) =>
        c.query<{ id: string }>(
          `INSERT INTO crove_kernel.party (org_id, kind, name, tax_code, email, phone)
           VALUES ($1, 'person', 'Nguyễn Văn Mẫu', '0101234564', 'Mau.Nguyen@example.vn', '+84 912 345 678') RETURNING id`,
          [orgId],
        ),
      );
      if (orgId === org.orgId) person = String(rows[0]?.id);
      await admin((c) =>
        c.query(
          `INSERT INTO crove_kernel.mail_message (org_id, stream, source, template_key, to_address, to_hash, message_id_header, status)
           VALUES ($1, 'transactional', 'social.report_schedule.run', 'social.report', 'mau.nguyen@example.vn', $2, $3, 'queued')`,
          [orgId, 'a'.repeat(63) + '0', `<pdpl-${randomUUID()}@test>`],
        ),
      );
    }
    await admin((c) => c.query(`UPDATE crove_kernel.tenant SET contact_email = 'mau.nguyen@example.vn' WHERE org_id = $1`, [org.orgId]));
  });

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('finds an email address in every column that holds one, case aside, with what an erasure does', async () => {
    const result = await find(' mau.nguyen@EXAMPLE.vn ');
    expect(result.kind).toBe('email');
    expect(columns(result)).toEqual(['crove_kernel.mail_message.to_address', 'crove_kernel.party.email', 'crove_kernel.tenant.contact_email']);
    const party = result.matches.find((m) => m.column === 'crove_kernel.party.email');
    expect(party).toMatchObject({ handling: 'erase', rowId: person, row: { name: 'Nguyễn Văn Mẫu', phone: '+84 912 345 678' } });
    // Only this org's rows.
    expect(result.matches.every((m) => m.row.org_id === org.orgId)).toBe(true);
    expect(result.truncated).toBe(false);
  });

  it('finds a phone number however it is spelled, and a tax code', async () => {
    for (const phone of ['0912345678', '0912.345.678', '+84 912 345 678', '84912345678', '(091) 234 5678']) {
      expect(columns(await find(phone)), phone).toContain('crove_kernel.party.phone');
    }
    const byCode = await find('0101234564');
    expect(byCode.matches.find((m) => m.column === 'crove_kernel.party.tax_code')).toMatchObject({ handling: 'keep_legal', rowId: person });
  });

  it('is for owners and admins only, and refuses a value that is not an email, a phone or a code', async () => {
    await expect(find('mau.nguyen@example.vn', org.member)).rejects.toMatchObject({ status: 403 });
    await expect(find('Nguyễn Văn Mẫu')).rejects.toMatchObject({ code: 'PERSONAL_DATA_QUERY', status: 422 });
    expect((await find('nobody@example.vn')).matches).toEqual([]);
  });

  // The shared free-text match (#1678, reused by #1948): whole addresses only, the value never read as a pattern,
  // digits however they are spaced, a phone with or without +84, and the redaction that goes with it.
  it('matches and edits out a value inside free text, and refuses a value of another shape (#1678)', async () => {
    const check = async (text: string | null, kind: string, value: string) =>
      admin(async (c) => (await c.query<{ found: boolean; edited: string | null }>(
        `SELECT crove_kernel.text_mentions($1, $2, $3) AS found, crove_kernel.text_redact($1, $2, $3, '[đã xóa]') AS edited`,
        [text, kind, value],
      )).rows[0]);
    // The shared table (pii-text-cases.ts), each value read as the finder reads it.
    for (const c of PII_TEXT_CASES) {
      const probe = personalDataProbe(c.value);
      if (!probe) {
        expect(c.redacted, c.name).toBe(c.text);
        continue;
      }
      const value = probe.kind === 'email' ? probe.email : probe.digits;
      expect(await check(c.text, probe.kind, value), c.name).toEqual({ found: c.redacted !== c.text, edited: c.redacted });
    }
    expect(await check(null, 'email', 'a@x.example')).toEqual({ found: false, edited: null });
    // The mark is taken literally: an & or a backslash in it never brings the value back (#1678 review).
    const marked = await admin(async (c) => (await c.query<{ edited: string }>(`SELECT crove_kernel.text_redact('mail a@x.example.', 'email', 'a@x.example', $1) AS edited`, ['R&D \\1 \\&'])).rows[0]?.edited);
    expect(marked).toBe('mail R&D \\1 \\&.');
    // A value of another shape, or another kind, raises instead of matching nothing.
    for (const [kind, value] of [['email', 'A@X.example'], ['email', 'not an email'], ['digits', '1234'], ['name', 'Nguyễn']]) {
      await expect(check('x', kind as string, value as string), `${kind} ${value}`).rejects.toMatchObject({ code: '22023' });
    }
  });

  // Notes and to-dos (#1678, notes step N9, ADR-0037 section 5): a value among other words. A shared note is listed with
  // its text; private notes and to-dos (always private) are counted per author and never shown, the finder's own
  // included. The finder searches whole addresses and digits however they are spaced.
  it('finds a value inside shared notes, and counts private notes and to-dos per author without their text (#1678)', async () => {
    const [shared, near] = [randomUUID(), randomUUID()];
    await admin(async (c) => {
      await c.query(
        `INSERT INTO crove_notes.note (org_id, id, author_user_id, visibility, title, body, tags) VALUES
           ($1, $2, $4, 'org', 'Khách hàng mới', 'Liên hệ giám đốc: Giam.Doc@khach.example.', '{}'),
           ($1, $3, $4, 'org', 'Địa chỉ khác', 'xgiam.doc@khach.example và giam.doc@khach.example.test', '{}'),
           ($1, crove_kernel.uuid_v7(), $5, 'private', 'Riêng một', 'gọi giam.doc@khach.example sau 15h', '{}'),
           ($1, crove_kernel.uuid_v7(), $5, 'private', 'Riêng hai: giam.doc@khach.example', '', '{}'),
           ($1, crove_kernel.uuid_v7(), $4, 'private', 'Của chủ', 'không liên quan', '{giam.doc@khach.example}')`,
        [org.orgId, shared, near, org.owner, org.member],
      );
      await c.query(
        `INSERT INTO crove_notes.todo (org_id, owner_user_id, title, details, checklist, sort_key) VALUES
           ($1, $2, 'Gọi giám đốc', 'Số (000) 777.66.55', '[]', 'a0'),
           ($1, $2, 'Gửi hồ sơ', NULL, '[{"text": "gửi tới giam.doc@khach.example", "done": false}]', 'a1')`,
        [org.orgId, org.member],
      );
    });
    const byAuthor = (result: PersonalDataResult) => [...result.privateItems].sort((a, b) => a.authorUserId.localeCompare(b.authorUserId));
    for (const user of [org.owner, org.admin]) {
      const result = await find('giam.doc@khach.example', user);
      // The shared note that holds the whole address, and not the one with longer addresses around it.
      expect(result.matches.filter((m) => m.column.startsWith('crove_notes.'))).toEqual([
        expect.objectContaining({ column: 'crove_notes.note.body', handling: 'erase', rowId: shared, row: expect.objectContaining({ visibility: 'org', title: 'Khách hàng mới' }) }),
      ]);
      expect(byAuthor(result), user).toEqual(
        [
          { authorUserId: org.member, notes: 2, todos: 1 },
          { authorUserId: org.owner, notes: 1, todos: 0 },
        ].sort((a, b) => a.authorUserId.localeCompare(b.authorUserId)),
      );
      // No private text, not even the owner's own.
      for (const secret of ['Riêng một', 'Riêng hai', 'Của chủ', 'Gửi hồ sơ', 'Gọi giám đốc']) expect(JSON.stringify(result), secret).not.toContain(secret);
    }
    // A phone written with brackets and dots in a to-do's details, found by any spelling.
    for (const phone of ['0007776655', '+84 007 776 655']) {
      expect((await find(phone)).privateItems, phone).toEqual([{ authorUserId: org.member, notes: 0, todos: 1 }]);
    }
    // Nothing for a value no item holds, and nothing from another org.
    expect((await find('nobody@khach.example')).privateItems).toEqual([]);
    expect((await find('giam.doc@khach.example', other.owner, other.orgId)).privateItems).toEqual([]);
  });

  it("finds the legal entities the org keeps books for, kept by law, and the default one as the org's own (#1312)", async () => {
    const exec = <T>(command: string, input: unknown, user = org.owner) =>
      rt.execute<T>(command, input, { actor: asUser(user), orgId: org.orgId, idempotencyKey: randomUUID() });
    await exec('kernel.org.set_tax_code', { taxCode: '0108888881' });
    const household = await exec<{ id: string }>('kernel.legal_entity.create', { name: 'Hộ kinh doanh Phạm Thị Hộ', kind: 'household', taxCode: '079091001234', parentId: null });
    const client = await exec<{ id: string }>('kernel.legal_entity.create', { name: 'Công ty TNHH Khách', kind: 'company', taxCode: '0317777773', parentId: null }, org.admin);

    // The household's 12-digit code, a person's national ID number, in any spelling: the row carries the name.
    const byId = await find('0790 9100 1234');
    expect(byId.matches).toEqual([
      {
        column: 'crove_kernel.legal_entity.tax_code',
        handling: 'keep_legal',
        reason: expect.stringContaining('national ID number'),
        rowId: household.id,
        row: expect.objectContaining({ name: 'Hộ kinh doanh Phạm Thị Hộ', kind: 'household', is_default: false, org_id: org.orgId }),
      },
    ]);
    // An admin finds a client company the same way; another org does not.
    expect((await find('0317777773', org.admin)).matches).toEqual([
      expect.objectContaining({ column: 'crove_kernel.legal_entity.tax_code', handling: 'keep_legal', rowId: client.id, row: expect.objectContaining({ name: 'Công ty TNHH Khách' }) }),
    ]);
    expect((await find('079091001234', other.owner, other.orgId)).matches).toEqual([]);
    // The default entity carries the org's own code, as the tenant row does.
    const own = await find('0108888881');
    expect(own.matches.map((m) => [m.column, m.handling]).sort()).toEqual([
      ['crove_kernel.legal_entity.tax_code', 'keep_org'],
      ['crove_kernel.tenant.tax_code', 'keep_org'],
    ]);
    expect(own.matches.find((m) => m.column === 'crove_kernel.legal_entity.tax_code')).toMatchObject({
      reason: expect.stringContaining('default legal entity'),
      row: expect.objectContaining({ is_default: true }),
    });

    // Erasing by the ID number keeps the entity as it is and says why.
    const erased = await erase('079091001234');
    expect(erased.erased).toEqual([]);
    expect(erased.kept).toEqual([{ column: 'crove_kernel.legal_entity.tax_code', rows: 1, reason: expect.stringContaining('Kept with its books') }]);
    const row = (await admin((c) => c.query('SELECT name, kind, tax_code FROM crove_kernel.legal_entity WHERE id = $1', [household.id]))).rows[0];
    expect(row).toEqual({ name: 'Hộ kinh doanh Phạm Thị Hộ', kind: 'household', tax_code: '079091001234' });

    // Every override names a boolean column of its table.
    for (const [key, entry] of Object.entries(PERSONAL_DATA_COLUMNS) as Array<[string, PersonalDataColumn]>) {
      if (!entry.override) continue;
      const [schema, table] = key.split('.');
      const { when } = entry.override;
      const { rows } = await admin((c) =>
        c.query<{ type: string }>(`SELECT data_type AS type FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND column_name = $3`, [
          schema,
          table,
          when,
        ]),
      );
      expect(rows, key).toEqual([{ type: 'boolean' }]);
    }
  });

  it('erases the contact fields and keeps what the books name, telling which and why', async () => {
    // A second person, in the books: a supplier on a recorded invoice (inserted as the superuser without the posting
    // checks, which this test is not about).
    const { rows } = await admin((c) =>
      c.query<{ id: string }>(
        `INSERT INTO crove_kernel.party (org_id, kind, name, tax_code, email, phone, address)
         VALUES ($1, 'person', 'Trần Thị Sổ', '0309876546', 'so.tran@example.vn', '0987 654 321', '1 Đường Sổ') RETURNING id`,
        [org.orgId],
      ),
    );
    const booked = String(rows[0]?.id);
    await admin(async (c) => {
      await c.query('BEGIN');
      await c.query("SET LOCAL session_replication_role = 'replica'");
      await c.query(
        `INSERT INTO crove_finance.purchase_document (org_id, party_id, invoice_series, invoice_number, invoice_date, subtotal, vat_amount, total)
         VALUES ($1, $2, 'C26TAA', '1', '2026-09-01', 100, 10, 110)`,
        [org.orgId, booked],
      );
      await c.query('COMMIT');
    });
    await admin((c) =>
      c.query(
        `INSERT INTO crove_social.report_schedule (org_id, name, cadence, weekday, period, recipients, next_run_at, created_by)
         VALUES ($1, 'Báo cáo tuần', 'weekly', 1, 'previous_week', ARRAY['so.tran@example.vn', 'ke.toan@example.vn'], now(), $2),
                ($1, 'Chỉ một người', 'weekly', 1, 'previous_week', ARRAY['SO.TRAN@example.vn', 'so.tran@example.vn'], now(), $2)`,
        [org.orgId, org.owner],
      ),
    );

    // Owners only, with a fresh second factor (R3); an admin may search but not erase.
    expect(columns(await find('so.tran@example.vn', org.admin))).toContain('crove_kernel.party.email');
    await expect(erase('so.tran@example.vn', org.admin)).rejects.toMatchObject({ status: 403 });
    await expect(erase('so.tran@example.vn', org.member)).rejects.toMatchObject({ status: 403 });
    await expect(
      rt.execute('kernel.personal_data.erase', { value: 'so.tran@example.vn' }, { actor: asUser(org.owner), orgId: org.orgId, idempotencyKey: randomUUID() }),
    ).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' });

    const result = await erase('So.Tran@example.vn');
    expect(Object.fromEntries(result.erased.map((e) => [e.column, e.rows]))).toEqual({
      'crove_kernel.party.email': 1,
      'crove_kernel.party.phone': 1,
      'crove_kernel.party.address': 1,
      'crove_social.report_schedule.recipients': 2,
    });
    const party = (await admin((c) => c.query('SELECT name, tax_code, email, phone, address FROM crove_kernel.party WHERE id = $1', [booked]))).rows[0];
    expect(party).toEqual({ name: 'Trần Thị Sổ', tax_code: '0309876546', email: null, phone: null, address: null });
    const schedules = (await admin((c) => c.query('SELECT name, recipients FROM crove_social.report_schedule WHERE org_id = $1', [org.orgId]))).rows;
    expect(schedules).toEqual([{ name: 'Báo cáo tuần', recipients: ['ke.toan@example.vn'] }]);
    // Erasing by the tax code now keeps the party's name and code, as the books need them.
    const byCode = await erase('0309876546');
    expect(byCode.erased).toEqual([]);
    expect(byCode.kept).toEqual([{ column: 'crove_kernel.party.tax_code', rows: 1, reason: expect.stringContaining('accounting records') }]);
  });

  it('keeps the original files of posted invoices naming the party, and says until when they are held (#1009)', async () => {
    const sha256 = randomUUID().replaceAll('-', '').padEnd(64, '0');
    const until = '2036-10-20T00:00:00.000Z';
    const fileId = randomUUID();
    await admin(async (c) => {
      await c.query('BEGIN');
      // Without the posting and guard triggers, which this test is not about.
      await c.query("SET LOCAL session_replication_role = 'replica'");
      const party = await c.query<{ id: string }>(
        `INSERT INTO crove_kernel.party (org_id, kind, name, tax_code, email) VALUES ($1, 'person', 'Lê Văn Giữ', '0312345678', 'giu.le@example.vn') RETURNING id`,
        [org.orgId],
      );
      await c.query(
        `INSERT INTO crove_kernel.file (org_id, id, sha256, storage_key, generation, filename, content_type, size_bytes, source, held_until)
         VALUES ($1, $2, $3, $4, 's3:v1', 'hd.xml', 'application/xml', 1, 'upload', $5)`,
        [org.orgId, fileId, sha256, `org/${org.orgId}/${sha256}`, until],
      );
      const doc = await c.query<{ id: string }>(
        `INSERT INTO crove_finance.purchase_document (org_id, party_id, invoice_series, invoice_number, invoice_date, subtotal, vat_amount, total, source_file_id)
         VALUES ($1, $2, 'C26TAA', '77', '2026-09-02', 100, 10, 110, $3) RETURNING id`,
        [org.orgId, party.rows[0]?.id, fileId],
      );
      await c.query(
        `INSERT INTO crove_finance.journal_entry (org_id, entry_date, description, source_type, source_id) VALUES ($1, '2026-09-02', 'HĐ 77', 'finance.purchase_document', $2)`,
        [org.orgId, doc.rows[0]?.id],
      );
      await c.query('COMMIT');
    });
    const result = await erase('giu.le@example.vn');
    expect(result.kept).toContainEqual({ column: 'crove_kernel.file', rows: 1, reason: expect.stringContaining('held in storage until 2036-10-20') });
    const file = (await admin((c) => c.query('SELECT held_until FROM crove_kernel.file WHERE id = $1', [fileId]))).rows[0];
    expect(file).toEqual({ held_until: new Date(until) });

    // A second posted file of the party with no hold recorded yet: no date is claimed for the group.
    const sha2 = randomUUID().replaceAll('-', '').padEnd(64, '1');
    await admin(async (c) => {
      await c.query('BEGIN');
      await c.query("SET LOCAL session_replication_role = 'replica'");
      const party = await c.query<{ id: string }>(`SELECT party_id AS id FROM crove_finance.purchase_document WHERE source_file_id = $1`, [fileId]);
      const second = randomUUID();
      await c.query(
        `INSERT INTO crove_kernel.file (org_id, id, sha256, storage_key, generation, filename, content_type, size_bytes, source)
         VALUES ($1, $2, $3, $4, 's3:v2', 'hd2.xml', 'application/xml', 1, 'upload')`,
        [org.orgId, second, sha2, `org/${org.orgId}/${sha2}`],
      );
      const doc = await c.query<{ id: string }>(
        `INSERT INTO crove_finance.purchase_document (org_id, party_id, invoice_series, invoice_number, invoice_date, subtotal, vat_amount, total, source_file_id)
         VALUES ($1, $2, 'C26TAA', '78', '2026-09-03', 100, 10, 110, $3) RETURNING id`,
        [org.orgId, party.rows[0]?.id, second],
      );
      await c.query(
        `INSERT INTO crove_finance.journal_entry (org_id, entry_date, description, source_type, source_id) VALUES ($1, '2026-09-03', 'HĐ 78', 'finance.purchase_document', $2)`,
        [org.orgId, doc.rows[0]?.id],
      );
      await c.query('COMMIT');
    });
    const again = await erase('0312345678');
    expect(again.kept).toContainEqual({ column: 'crove_kernel.file', rows: 2, reason: expect.stringContaining('kept for the legal period') });
  });

  it('forgets a party the books do not name, drops the mail recipient but keeps its hash, and audits counts only', async () => {
    const result = await erase('mau.nguyen@example.vn');
    expect(Object.fromEntries(result.erased.map((e) => [e.column, e.rows]))).toEqual({
      'crove_kernel.party.email': 1,
      'crove_kernel.party.phone': 1,
      'crove_kernel.party.name': 1,
      'crove_kernel.party.tax_code': 1,
      'crove_kernel.mail_message.to_address': 1,
      'crove_kernel.tenant.contact_email': 1,
    });
    expect(result.kept).toEqual([]);
    const party = (await admin((c) => c.query('SELECT name, tax_code, email, phone FROM crove_kernel.party WHERE id = $1', [person]))).rows[0];
    expect(party).toEqual({ name: 'Đã xóa theo yêu cầu', tax_code: null, email: null, phone: null });
    const mail = (await admin((c) => c.query('SELECT to_address, to_hash FROM crove_kernel.mail_message WHERE org_id = $1', [org.orgId]))).rows[0];
    expect(mail).toEqual({ to_address: null, to_hash: 'a'.repeat(63) + '0' });
    // Nothing is left to find, and the other org still has its copy.
    expect((await find('mau.nguyen@example.vn')).matches).toEqual([]);
    expect((await find('mau.nguyen@example.vn', other.owner, other.orgId)).matches.length).toBeGreaterThan(0);
    // The audit row carries the counts, not the address.
    const audit = (
      await admin((c) =>
        c.query<{ detail: unknown }>(
          `SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.personal_data.erase' AND outcome = 'ok' ORDER BY id DESC LIMIT 1`,
          [org.orgId],
        ),
      )
    ).rows[0];
    expect(JSON.stringify(audit)).not.toContain('mau.nguyen');
    expect(audit?.detail).toMatchObject({ kind: 'email', erased: { 'crove_kernel.party.email': 1 } });
  });

  it("erases a forwarded mail's text with its sender (#779), and leaves the mails of others", async () => {
    const mail = (from: string) =>
      admin((c) => c.query<{ id: string }>(`INSERT INTO crove_kernel.inbound_message (org_id, message_id, from_address, subject, body_text) VALUES ($1, $2, $3, 'Khuyến mãi', 'Chào chị Mẫu, ưu đãi 20%') RETURNING id`, [org.orgId, `<pdpl-${randomUUID()}@test>`, from]));
    const theirs = String((await mail('ban.hang@shop-mau.example')).rows[0]?.id);
    const others = String((await mail('khac@shop-khac.example')).rows[0]?.id);
    expect(columns(await find('ban.hang@shop-mau.example'))).toContain('crove_kernel.inbound_message.from_address');
    const erased = await erase('ban.hang@shop-mau.example');
    expect(erased.erased).toEqual(expect.arrayContaining([expect.objectContaining({ column: 'crove_kernel.inbound_message.from_address', rows: 1 }), expect.objectContaining({ column: 'crove_kernel.inbound_message.body_text', rows: 1 })]));
    const rows = (await admin((c) => c.query<{ id: string; from_address: string | null; body_text: string | null }>('SELECT id, from_address, body_text FROM crove_kernel.inbound_message WHERE id = ANY($1)', [[theirs, others]]))).rows;
    expect(rows.find((r) => r.id === theirs)).toMatchObject({ from_address: null, body_text: null });
    expect(rows.find((r) => r.id === others)).toMatchObject({ from_address: 'khac@shop-khac.example', body_text: 'Chào chị Mẫu, ưu đãi 20%' });
  });
  // Free text that quotes a person (#1948): the finder searches activity lines, task comments, journal entry
  // descriptions and the reasons on cash and journal vouchers for the value anywhere inside them. The erasure replaces
  // it in activity lines, and keeps the comments (append-only) and the books (kept by law), listed with their reasons;
  // its audit row holds counts only.
  it('finds a person quoted in free text, redacts it in activity lines and keeps the comments and the books (#1948)', async () => {
    const email = 'Tu.Tran@Example.vn';
    const seeded = await admin(async (c) => {
      const line = async (summary: string) =>
        (
          await c.query<{ id: string }>(
            `INSERT INTO crove_kernel.activity (org_id, record_type, record_id, kind, summary) VALUES ($1, 'kernel.party', $2, 'party.note', $3) RETURNING id`,
            [org.orgId, person, summary],
          )
        ).rows[0]?.id as string;
      const byEmail = await line(`Đã gửi hợp đồng cho ${email} hôm nay`);
      const byPhone = await line('Gọi chị Tú ở số 0987.654.321 lúc 9 giờ');
      const longer = await line('Mã đơn 0987654321999 không phải số điện thoại');
      const task = (
        await c.query<{ id: string }>(
          `INSERT INTO crove_kernel.task (org_id, title, source, created_by_type) VALUES ($1, 'Liên hệ khách', 'human', 'user') RETURNING id`,
          [org.orgId],
        )
      ).rows[0]?.id as string;
      await c.query(`INSERT INTO crove_kernel.task_comment (org_id, task_id, body, author_type, author_id) VALUES ($1, $2, $3, 'user', $4)`, [
        org.orgId,
        task,
        `Đã hẹn với tu.tran@example.vn`,
        org.owner,
      ]);
      // An entry, a cash receipt and a journal voucher, each entry with balanced lines, in one transaction (the ledger's
      // and the vouchers' checks run at commit).
      const receipt = randomUUID();
      const voucher = randomUUID();
      const lines = (entry: string, debit: string, credit: string) =>
        c.query(
          `INSERT INTO crove_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit) VALUES ($1, $2, 1, $3, 100000, 0), ($1, $2, 2, $4, 0, 100000)`,
          [org.orgId, entry, debit, credit],
        );
      await c.query('BEGIN');
      const advance = (
        await c.query<{ id: string }>(
          `INSERT INTO crove_finance.journal_entry (org_id, entry_date, description, source_type, source_id) VALUES ($1, '2026-09-04', $2, 'test.pdpl', $3) RETURNING id`,
          [org.orgId, `Tạm ứng cho ${email}`, randomUUID()],
        )
      ).rows[0]?.id as string;
      await lines(advance, '141', '1111');
      const entry = (
        await c.query<{ id: string }>(
          `INSERT INTO crove_finance.journal_entry (org_id, entry_date, description, source_type, source_id) VALUES ($1, '2026-09-05', 'PT', 'finance.cash_voucher', $2) RETURNING id`,
          [org.orgId, receipt],
        )
      ).rows[0]?.id as string;
      await lines(entry, '1111', '131');
      await c.query(
        `INSERT INTO crove_finance.cash_voucher (org_id, id, voucher_type, number, voucher_date, cash_account, description, amount)
         VALUES ($1, $2, 'cash_receipt', 1, '2026-09-05', '1111', $3, 100000)`,
        [org.orgId, receipt, `Thu tiền của ${email}`],
      );
      const adjustment = (
        await c.query<{ id: string }>(
          `INSERT INTO crove_finance.journal_entry (org_id, entry_date, description, source_type, source_id) VALUES ($1, '2026-09-06', 'PKT', 'finance.journal_voucher', $2) RETURNING id`,
          [org.orgId, voucher],
        )
      ).rows[0]?.id as string;
      await lines(adjustment, '6422', '331');
      await c.query(`INSERT INTO crove_finance.journal_voucher (org_id, id, number, voucher_date, description) VALUES ($1, $2, 1, '2026-09-06', $3)`, [
        org.orgId,
        voucher,
        `Điều chỉnh theo thư của ${email}`,
      ]);
      await c.query('COMMIT');
      return { byEmail, byPhone, longer };
    });

    const found = await find(email);
    expect(columns(found)).toEqual([
      'crove_finance.cash_voucher.description',
      'crove_finance.journal_entry.description',
      'crove_finance.journal_voucher.description',
      'crove_kernel.activity.summary',
      'crove_kernel.task_comment.body',
    ]);
    expect(found.matches.find((m) => m.column === 'crove_kernel.activity.summary')).toMatchObject({ handling: 'erase', rowId: seeded.byEmail });
    expect(found.matches.find((m) => m.column === 'crove_kernel.task_comment.body')?.handling).toBe('keep_record');
    expect(found.matches.filter((m) => m.column.startsWith('crove_finance.')).map((m) => m.handling)).toEqual(['keep_legal', 'keep_legal', 'keep_legal']);
    // A phone however it is spelled, never inside a longer number.
    const byPhone = await find('+84 987 654 321');
    expect(byPhone.matches.filter((m) => m.column === 'crove_kernel.activity.summary').map((m) => m.rowId)).toEqual([seeded.byPhone]);

    const erased = await erase(email);
    expect(erased.erased).toContainEqual({ column: 'crove_kernel.activity.summary', rows: 1 });
    for (const column of ['crove_kernel.task_comment.body', 'crove_finance.journal_entry.description', 'crove_finance.cash_voucher.description', 'crove_finance.journal_voucher.description']) {
      expect(erased.kept, column).toContainEqual({ column, rows: 1, reason: expect.any(String) });
    }
    await erase('0987654321');
    const summaries = (
      await admin((c) => c.query<{ id: string; summary: string }>('SELECT id, summary FROM crove_kernel.activity WHERE id = ANY($1)', [[seeded.byEmail, seeded.byPhone, seeded.longer]]))
    ).rows;
    const summary = (id: string) => summaries.find((r) => r.id === id)?.summary;
    expect(summary(seeded.byEmail)).toBe('Đã gửi hợp đồng cho [đã xóa] hôm nay');
    expect(summary(seeded.byPhone)).toBe('Gọi chị Tú ở số [đã xóa] lúc 9 giờ');
    expect(summary(seeded.longer)).toBe('Mã đơn 0987654321999 không phải số điện thoại');
    // The kept rows are still there to find, and nothing else is.
    expect(columns(await find(email))).toEqual([
      'crove_finance.cash_voucher.description',
      'crove_finance.journal_entry.description',
      'crove_finance.journal_voucher.description',
      'crove_kernel.task_comment.body',
    ]);
    const audits = (
      await admin((c) =>
        c.query<{ detail: unknown }>(
          `SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.personal_data.erase' AND outcome = 'ok' ORDER BY id DESC LIMIT 2`,
          [org.orgId],
        ),
      )
    ).rows;
    expect(JSON.stringify(audits).toLowerCase()).not.toContain('tu.tran');
    expect(JSON.stringify(audits)).not.toMatch(/987.?654/);
  });

  // A number of 8 or 9 digits (an old ID card number) may as well be an amount or a voucher number in a timeline line:
  // the erasure lists those lines with its reason and leaves them as they are; the definer changes nothing for it
  // either (#1948, the coordinator's review).
  it('lists the activity lines a short number matches and leaves them as they are (#1948)', async () => {
    const line = await admin(
      async (c) =>
        (
          await c.query<{ id: string }>(
            `INSERT INTO crove_kernel.activity (org_id, record_type, record_id, kind, summary) VALUES ($1, 'kernel.party', $2, 'party.note', 'Mã đối chiếu 23456789 của khách') RETURNING id`,
            [org.orgId, person],
          )
        ).rows[0]?.id as string,
    );
    expect((await find('23456789')).matches.filter((m) => m.column === 'crove_kernel.activity.summary').map((m) => m.rowId)).toEqual([line]);
    const result = await erase('23456789');
    expect(result.erased.map((e) => e.column)).not.toContain('crove_kernel.activity.summary');
    expect(result.kept).toContainEqual({ column: 'crove_kernel.activity.summary', rows: 1, reason: ACTIVITY_SHORT_NUMBER_REASON });
    const summary = (await admin((c) => c.query<{ summary: string }>('SELECT summary FROM crove_kernel.activity WHERE id = $1', [line]))).rows[0]?.summary;
    expect(summary).toBe('Mã đối chiếu 23456789 của khách');
  });

  // Only the erase command reaches the redaction: an owner's own context, never a member's or a raw tenant call.
  it('redacts activity lines only in an owner context (#1948)', async () => {
    const app = new URL(adminUrl);
    app.username = 'crove_app';
    app.password = 'test-app-pw';
    const call = async (user: string) => {
      const c = new pg.Client({ connectionString: app.toString() });
      await c.connect();
      try {
        await c.query('BEGIN');
        await enterUser(c, user, org.orgId);
        await c.query(`SELECT crove_kernel.personal_data_redact_activity('email', 'nobody@example.vn')`);
        return 'answered';
      } catch (error) {
        return (error as Error).message;
      } finally {
        await c.query('ROLLBACK').catch(() => {});
        await c.end();
      }
    };
    expect(await call(org.owner)).toBe('answered');
    expect(await call(org.admin)).toBe('PERSONAL_DATA_OWNER_ONLY');
    expect(await call(org.member)).toBe('PERSONAL_DATA_OWNER_ONLY');
    // Nobody but the API login may call it at all: the tenant and worker roles hold no EXECUTE.
    const grants = await admin(
      async (c) =>
        (
          await c.query<{ role: string; allowed: boolean }>(
            `SELECT r AS role, pg_catalog.has_function_privilege(r, 'crove_kernel.personal_data_redact_activity(text, text)', 'EXECUTE') AS allowed
               FROM pg_catalog.unnest(ARRAY['crove_app', 'crove_tenant', 'crove_worker']) AS r`,
          )
        ).rows,
    );
    expect(grants).toEqual([
      { role: 'crove_app', allowed: true },
      { role: 'crove_tenant', allowed: false },
      { role: 'crove_worker', allowed: false },
    ]);
  });
});
