// Asking a client company for its missing purchase invoices (#669), on a real PostgreSQL 17, through the HTTP API and the
// worker functions: the org's contact email (owners and admins only, and a database guard for every other writer), the
// request for a period's missing invoices (queued through the kernel mail pipeline, once an hour per period, refused
// without a contact email or with nothing missing), the mail the worker sends (To, Reply-To the org's inbound address,
// the invoices), a suppressed address, the monthly reminder (on, once a month, off by itself when nothing is missing),
// the worker's scan of due reminders, roles and the org boundary. The mail's wording is unit-tested in
// modules/finance/test/missing-invoices.test.ts. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run creates and
// drops its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import type { ExtractClient } from '@crove/extract-contract';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { kernelCommands, kernelQueries } from '@crove/kernel';
import { Runtime, sha256Hex, type BlobStore } from '@crove/kernel-runtime';
import type { MailProvider, OutboundMail } from '@crove/mail';
import { financeCommands, financeQueries, importPortalList } from '@crove/mod-finance';
import { portalListXlsx, type PortalInvoiceSpec } from '../../extract/test/xlsx-fixture.ts';
import { createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { runMailJob } from '../src/mail-queue.ts';
import { MAIL_TEMPLATES } from '../src/mail-templates.ts';
import { sweepMissingInvoiceReminders } from '../src/missing-invoice-mail.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { inProcessExtract } from './extract-service.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const SECRET = 'test-only-jwt-secret-for-missing-invoices-669-0123456789';
const ISSUER = 'crove-auth';
const BUYER = '0309876546';
const INBOUND = 'in.crove.test';
const ACTOR = { type: 'system' as const, component: 'finance.missing_invoices' };

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

// A mailer that accepts every mail and keeps it.
function recordingMailer() {
  const sent: OutboundMail[] = [];
  const mailer: MailProvider = {
    name: 'test',
    enabled: true,
    sendRetrySafety: 'never',
    async send(mail) {
      sent.push(mail);
      return { status: 'accepted', providerMessageId: `em_${sent.length}` };
    },
  };
  return { mailer, sent };
}

const suite = ADMIN ? describe : describe.skip;

suite('missing invoice requests (#669)', () => {
  const dbName = `crove_test_missing_inv_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let workerDb: Db;
  let workerRuntime: Runtime;
  let app: ReturnType<typeof createHttpApp>;
  const store = new MemoryStore();
  let extract: ExtractClient;
  const owner: Account = { subject: randomUUID(), email: 'owner@missing.test', session: randomUUID(), userId: '' };
  const member: Account = { subject: randomUUID(), email: 'member@missing.test', session: randomUUID(), userId: '' };
  const viewer: Account = { subject: randomUUID(), email: 'viewer@missing.test', session: randomUUID(), userId: '' };
  const outsider: Account = { subject: randomUUID(), email: 'outsider@missing.test', session: randomUUID(), userId: '' };
  let org = { slug: '', orgId: '' };
  let otherOrg = { slug: '', orgId: '' };

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

  async function rpc(path: string, who: Account, input: unknown, slug: string | null = org.slug) {
    const response = await app.request(`/api/rpc/${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await tokenFor(who)}`, 'content-type': 'application/json', ...(slug ? { 'x-crove-org': slug } : {}) },
      body: JSON.stringify(input === undefined ? {} : { json: input }),
    });
    const body = (await response.json().catch(() => null)) as ({ json?: unknown } & Record<string, unknown>) | null;
    return { status: response.status, body: (body && 'json' in body ? body.json : body) as any };
  }

  const spec = (number: string, date: string, extra: Partial<PortalInvoiceSpec> = {}): PortalInvoiceSpec => ({
    template: 1,
    series: 'C26TAB',
    number,
    date,
    sellerTaxCode: '0101234564',
    subtotal: 1_800_000,
    vat: 180_000,
    total: 1_980_000,
    ...extra,
  });

  // Uploads a list, imports it for the period and runs the worker step.
  async function importList(invoices: PortalInvoiceSpec[], period: string) {
    const form = new FormData();
    form.append('file', new File([Buffer.from(portalListXlsx(invoices))], `ds-${period}.xlsx`));
    form.append('purpose', 'import');
    const uploaded = await app.request('/api/files', { method: 'POST', headers: { authorization: `Bearer ${await tokenFor(owner)}`, 'x-crove-org': org.slug }, body: form });
    expect(uploaded.status).toBe(200);
    const fileId = ((await uploaded.json()) as any).files[0].fileId as string;
    const imported = await rpc('portalList/import', owner, { period, fileId });
    expect(imported.status, JSON.stringify(imported.body)).toBe(200);
    await importPortalList({ runtime: workerRuntime, store, extract }, org.orgId, imported.body.listId);
    return imported.body.listId as string;
  }

  const mailRow = (id: string) =>
    admin(async (c) => (await c.query('SELECT source, stream, status, to_address, subject, template_key, payload, error_code FROM crove_kernel.mail_message WHERE id = $1', [id])).rows[0]);

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
    pool = createPool({ connectionString: appUrl, max: 4 });
    const db: Db = createDb(pool);
    workerPool = createPool({ connectionString: login('crove_worker', 'test-worker-pw'), max: 2 });
    workerDb = createDb(workerPool);
    const register = (target: Db, sessions = false) =>
      new Runtime(target, { manifests: TEST_MANIFESTS, ...sessions ? { sessions: createSessionStatusSource('off'), stepUp: 'required' } : {} }).register({
        commands: [...kernelCommands, ...financeCommands],
        queries: [...kernelQueries({ inboundDomain: INBOUND }), ...financeQueries],
      });
    const runtime = register(db, true);
    workerRuntime = register(workerDb);
    const config = loadConfig({
      DATABASE_URL: appUrl,
      AUTH_JWT_SECRET: SECRET,
      AUTH_ISSUER: ISSUER,
      AUTH_SESSION_CHECK: 'off',
      MIGRATIONS_DIR: MIGRATIONS,
      WEB_DIST: '/nonexistent',
    });
    app = createHttpApp({ config, runtime, store, authenticate: createAuthenticator(config, db), pool, aiEnabled: false });

    for (const who of [owner, member, viewer, outsider]) {
      const me = await rpc('me/get', who, undefined, null);
      expect(me.status).toBe(200);
      who.userId = String(me.body?.userId);
    }
    const created = await rpc('org/create', owner, { name: 'Công ty Người Mua Mẫu', idempotencyKey: randomUUID() }, null);
    org = { slug: String(created.body?.slug), orgId: String(created.body?.orgId) };
    expect((await rpc('org/setTaxCode', owner, { taxCode: BUYER })).status).toBe(200);
    for (const [who, role] of [
      [member, 'member'],
      [viewer, 'viewer'],
    ] as const) {
      const invite = await app.request('/api/rpc/org/invite', {
        method: 'POST',
        headers: { authorization: `Bearer ${await tokenFor(owner, { mfa: true })}`, 'content-type': 'application/json', 'x-crove-org': org.slug },
        body: JSON.stringify({ json: { email: who.email, role } }),
      });
      const body = ((await invite.json()) as any).json;
      expect((await rpc('invites/accept', who, { token: String(body.acceptPath).split('#')[1] }, null)).status).toBe(200);
    }
    const other = await rpc('org/create', outsider, { name: 'Công ty khác', idempotencyKey: randomUUID() }, null);
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

  it('lets only owners and admins set the contact email, and the database refuses every other writer', async () => {
    expect((await rpc('missingInvoices/status', viewer, undefined)).body).toEqual({ contactEmail: null, reminderDay: null, mails: [] });
    const denied = await rpc('org/setContactEmail', member, { email: 'ketoan@khach.test' });
    expect(denied.status).toBe(403);
    expect((await rpc('org/setContactEmail', owner, { email: 'not an email' })).status).toBe(400);
    const set = await rpc('org/setContactEmail', owner, { email: 'KeToan@Khach.Test' });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body).toEqual({ contactEmail: 'ketoan@khach.test' });
    expect((await rpc('org/get', viewer, undefined)).body.contactEmail).toBe('ketoan@khach.test');
    // The audit row and the activity feed say it changed, never the address.
    const audit = await admin(async (c) => (await c.query(`SELECT detail FROM crove_kernel.audit_event WHERE command = 'kernel.org.set_contact_email' AND outcome = 'ok'`)).rows);
    expect(JSON.stringify(audit)).not.toContain('khach.test');
    // A writer outside the command (here the worker in the org's system context) is refused by the guard.
    await expect(
      workerDb.transaction().execute(async (trx) => {
        await sql`SELECT crove_kernel.enter_system_context(${org.orgId}::uuid)`.execute(trx);
        await sql`UPDATE crove_kernel.tenant SET contact_email = 'attacker@evil.test' WHERE org_id = ${org.orgId}::uuid`.execute(trx);
      }),
    ).rejects.toThrow(/CONTACT_EMAIL_FORBIDDEN/);
  });

  it('queues one request per period with the missing invoices, and the worker sends it to the contact with the inbound Reply-To', async () => {
    expect((await rpc('missingInvoices/request', member, { period: '2026-09' })).body.code).toBe('NOTHING_MISSING');
    await importList([spec('9007', '20/09/2026'), spec('9008', '21/09/2026', { total: 2_200_000 }), spec('9009', '22/09/2026', { status: 'Hóa đơn đã bị hủy' })], '2026-09');
    expect((await rpc('missingInvoices/request', viewer, { period: '2026-09' })).status).toBe(403);
    const sent = await rpc('missingInvoices/request', member, { period: '2026-09' });
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    expect(sent.body).toMatchObject({ status: 'queued', count: 2 });
    const row = await mailRow(sent.body.messageId);
    expect(row).toMatchObject({
      source: 'finance.missing_invoices.request',
      stream: 'transactional',
      status: 'queued',
      to_address: 'ketoan@khach.test',
      template_key: 'finance.missing_invoices',
      subject: 'Đề nghị bổ sung hóa đơn đầu vào tháng 9/2026',
    });
    expect(row.payload).toMatchObject({ kind: 'request', requestPeriod: '2026-09', count: 2, periods: [{ period: '2026-09', count: 2 }] });
    expect(row.payload.periods[0].items.map((i: { number: string }) => i.number)).toEqual(['9007', '9008']);
    // A second click within the hour mails the company once.
    expect((await rpc('missingInvoices/request', owner, { period: '2026-09' })).body.code).toBe('REQUEST_TOO_SOON');

    const { mailer, sent: outbox } = recordingMailer();
    const deps = { runtime: workerRuntime, mailer, templates: MAIL_TEMPLATES, publicUrl: 'https://crove.test', bounceDomain: INBOUND, sleep: async () => {} };
    expect(await runMailJob(deps, { orgId: org.orgId, messageId: sent.body.messageId })).toEqual({ action: 'recorded', outcome: 'sent', code: null });
    const token = await admin(async (c) => (await c.query('SELECT inbound_token FROM crove_kernel.tenant WHERE org_id = $1', [org.orgId])).rows[0].inbound_token as string);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ to: 'ketoan@khach.test', subject: 'Đề nghị bổ sung hóa đơn đầu vào tháng 9/2026', replyTo: `${token}@${INBOUND}` });
    expect(outbox[0]?.text).toContain('hóa đơn số 9007');
    expect(outbox[0]?.text).toContain('tổng tiền 2.200.000 đồng');
    expect(outbox[0]?.text).not.toContain('9009');
    // Still refused once the mail went out.
    expect((await rpc('missingInvoices/request', member, { period: '2026-09' })).body.code).toBe('REQUEST_TOO_SOON');
    const status = await rpc('missingInvoices/status', viewer, undefined);
    expect(status.body.mails).toEqual([expect.objectContaining({ id: sent.body.messageId, kind: 'request', status: 'sent', periods: ['2026-09'], count: 2 })]);
    // The other org sees none of it.
    expect((await rpc('missingInvoices/status', outsider, undefined, otherOrg.slug)).body).toEqual({ contactEmail: null, reminderDay: null, mails: [] });
  });

  it('records a request to a suppressed contact as suppressed and sends nothing', async () => {
    await importList([spec('1001', '02/10/2026')], '2026-10');
    await admin((c) =>
      c.query(`INSERT INTO crove_kernel.mail_suppression (org_id, to_hash, scope, reason) SELECT $1, crove_kernel.mail_address_hash('ketoan@khach.test'), 'all', 'manual' ON CONFLICT DO NOTHING`, [org.orgId]),
    );
    const sent = await rpc('missingInvoices/request', owner, { period: '2026-10' });
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    expect(sent.body).toMatchObject({ status: 'suppressed', count: 1 });
    expect(await mailRow(sent.body.messageId)).toMatchObject({ status: 'suppressed', source: 'finance.missing_invoices.request' });
    const { mailer, sent: outbox } = recordingMailer();
    expect(await runMailJob({ runtime: workerRuntime, mailer, templates: MAIL_TEMPLATES, publicUrl: 'https://crove.test', bounceDomain: INBOUND }, { orgId: org.orgId, messageId: sent.body.messageId })).toMatchObject({ action: 'none' });
    expect(outbox).toEqual([]);
    await admin((c) => c.query(`UPDATE crove_kernel.mail_suppression SET lifted_at = now(), lifted_by = $2, lift_reason = 'test' WHERE org_id = $1 AND lifted_at IS NULL`, [org.orgId, owner.userId]));
  });

  it('reminds once a month while invoices are missing, and turns itself off when none are', async () => {
    expect((await rpc('missingInvoices/setReminder', viewer, { day: 5 })).status).toBe(403);
    expect((await rpc('missingInvoices/setReminder', member, { day: 29 })).status).toBe(400);
    expect((await rpc('missingInvoices/setReminder', member, { day: 5 })).body).toEqual({ day: 5 });
    // A list for the quarter as well: its invoices of September are listed once, under the month.
    await importList([spec('9007', '20/09/2026'), spec('9008', '21/09/2026', { total: 2_200_000 })], '2026-Q3');
    const first = await workerRuntime.execute<any>('finance.missing_invoices.remind', {}, { actor: ACTOR, orgId: org.orgId });
    expect(first).toMatchObject({ action: 'sent', status: 'queued', count: 3 });
    const row = await mailRow(first.messageId);
    expect(row).toMatchObject({ source: 'finance.missing_invoices.remind', subject: 'Nhắc bổ sung hóa đơn đầu vào còn thiếu' });
    expect(row.payload.periods.map((p: { period: string }) => p.period)).toEqual(['2026-09', '2026-10']);
    expect(await workerRuntime.execute('finance.missing_invoices.remind', {}, { actor: ACTOR, orgId: org.orgId })).toEqual({ action: 'already' });
    expect((await rpc('missingInvoices/status', member, undefined)).body.reminderDay).toBe(5);

    // The other org: a reminder on, a contact, nothing missing (no list): no mail, and the reminder is off.
    await admin((c) => c.query(`UPDATE crove_kernel.tenant SET contact_email = 'ketoan@khac.test', missing_invoice_reminder_day = 7 WHERE org_id = $1`, [otherOrg.orgId]));
    expect(await workerRuntime.execute('finance.missing_invoices.remind', {}, { actor: ACTOR, orgId: otherOrg.orgId })).toEqual({ action: 'stopped' });
    expect((await rpc('missingInvoices/status', outsider, undefined, otherOrg.slug)).body).toMatchObject({ reminderDay: null, mails: [] });

    // Turning it off.
    expect((await rpc('missingInvoices/setReminder', owner, { day: null })).body).toEqual({ day: null });
    expect(await workerRuntime.execute('finance.missing_invoices.remind', {}, { actor: ACTOR, orgId: org.orgId })).toEqual({ action: 'off' });
  });

  it('scans for due reminders on their day from 08:00 Vietnam time, once a month', async () => {
    const local = new Date(Date.now() + 7 * 3_600_000);
    const today = local.getUTCDate();
    const due = async () => admin(async (c) => (await c.query('SELECT org_id FROM crove_finance.missing_invoice_reminders_due(100)')).rows.map((r) => r.org_id as string));
    if (today > 28) return;
    // The org reminded this month is not due again; the other org (contact, reminder today) is, from 08:00.
    await admin((c) => c.query('UPDATE crove_kernel.tenant SET missing_invoice_reminder_day = $2 WHERE org_id = ANY($1::uuid[])', [[org.orgId, otherOrg.orgId], today]));
    const rows = await due();
    expect(rows).not.toContain(org.orgId);
    if (local.getUTCHours() >= 8) {
      expect(rows).toContain(otherOrg.orgId);
      // The sweep runs it: nothing missing there, so the reminder turns off and the org is no longer due.
      expect(await sweepMissingInvoiceReminders({ runtime: workerRuntime, workerDb })).toBe(0);
      expect(await due()).not.toContain(otherOrg.orgId);
      // A run that could reconcile none of its periods (detail.skipped) counts as this month's run.
      const third = await rpc('org/create', member, { name: 'Công ty thứ ba', idempotencyKey: randomUUID() }, null);
      const thirdId = String(third.body?.orgId);
      await admin((c) => c.query(`UPDATE crove_kernel.tenant SET contact_email = 'ketoan@thuba.test', missing_invoice_reminder_day = $2 WHERE org_id = $1`, [thirdId, today]));
      expect(await due()).toContain(thirdId);
      await admin((c) =>
        c.query(
          `INSERT INTO crove_kernel.audit_event (org_id, actor_type, command, command_id, outcome, input_sha256, detail)
           VALUES ($1, 'system', 'finance.missing_invoices.remind', gen_random_uuid(), 'ok', repeat('0', 64), '{"skipped":["2026-09"]}')`,
          [thirdId],
        ),
      );
      expect(await due()).not.toContain(thirdId);
      expect(await workerRuntime.execute('finance.missing_invoices.remind', {}, { actor: ACTOR, orgId: thirdId })).toEqual({ action: 'already' });
    } else {
      expect(rows).not.toContain(otherOrg.orgId);
    }
    // Only the worker may scan.
    await expect(pool.query('SELECT * FROM crove_finance.missing_invoice_reminders_due(1)')).rejects.toThrow(/permission denied/);
  });
});
