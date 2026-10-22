// White-label client reports (#1053) on PostgreSQL 17: owners and admins save the org's report branding, members and
// viewers only read it; a wrong logo type, a logo whose bytes are not its declared type, an oversized logo and a
// low-contrast accent are refused, by the command and again by the table's CHECK; the public report and review views
// return the brand of the link's own org only, and still return nothing for a revoked or expired link; the report mail
// carries the agency's name and accent. The public side runs as the API login role with no org context, as the HTTP
// edge does. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import type { MailProvider, OutboundMail } from '@crove/mail';
import { BRAND_LOGO_MAX_BYTES, socialCommands, socialQueries } from '@crove/mod-social';
import { MAIL_TEMPLATES } from '../src/mail-templates.ts';
import { runMailJob, sweepMail, type MailJob } from '../src/mail-queue.ts';
import { reportView, type PageBrand } from '../src/report-link.ts';
import { reviewView } from '../src/review-link.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

const png = (pad = 40) => `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array.from({ length: pad }, () => 7)]).toString('base64')}`;
const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]).toString('base64');

suite('white-label client reports on PostgreSQL (#1053)', () => {
  const dbName = `crove_test_report_branding_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  let worker: Runtime;
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  type Org = { orgId: string; owner: string; admin: string; member: string; viewer: string; name: string };

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  const person = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@branding.test`, name: null });

  async function org(): Promise<Org> {
    const owner = await person('owner');
    const name = `Agency ${randomUUID().slice(0, 6)}`;
    const { orgId } = await createOrg(rt, asUser(owner), name);
    const adminUser = await person('admin');
    const member = await person('member');
    const viewer = await person('viewer');
    await admin((c) =>
      c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'viewer')", [orgId, adminUser, member, viewer]),
    );
    return { orgId, owner, admin: adminUser, member, viewer, name };
  }

  async function connection(o: Org) {
    const id = randomUUID();
    await admin((c) =>
      c.query('INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, $3, $4, $5, $6)', [o.orgId, id, 'sandbox', `acct-${id.slice(0, 8)}`, 'Trang', o.owner]),
    );
    return id;
  }

  const exec = <O>(o: Org, user: string, name: string, input: unknown) => rt.execute<O>(name, input, { actor: asUser(user), orgId: o.orgId });
  const get = (o: Org, user: string) => rt.query<(PageBrand & { updatedAt: string }) | null>('social.report_branding.get', {}, { actor: asUser(user), orgId: o.orgId });
  const save = (o: Org, user: string, input: Record<string, unknown>) => exec<{ saved: boolean }>(o, user, 'social.report_branding.save', { hideCrove: false, ...input });
  const refusal = (p: Promise<unknown>) => p.then(() => 'resolved', (e: unknown) => (e as { code?: string }).code ?? String(e));
  const reportLink = (o: Org) => exec<{ token: string; linkId: string }>(o, o.owner, 'social.report_link.create', { periodStart: '2026-10-01T00:00:00+07:00', periodEnd: '2026-11-01T00:00:00+07:00' });
  const brandOf = async (token: string) => ((await reportView(rt, { token })) as { brand: PageBrand | null } | null)?.brand;

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
    const login = (user: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = user;
      url.password = password;
      return url.toString();
    };
    pool = createPool({ connectionString: login('crove_app', 'test-app-pw'), max: 4 });
    workerPool = createPool({ connectionString: login('crove_worker', 'test-worker-pw'), max: 2 });
    db = createDb(pool);
    const registry = { commands: [...kernelCommands, ...socialCommands], queries: [...kernelQueries({ inboundDomain: null }), ...socialQueries] };
    rt = new Runtime(db).register(registry);
    worker = new Runtime(createDb(workerPool)).register(registry);
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

  it('lets owners and admins save and remove the branding, and members and viewers only read it', async () => {
    const o = await org();
    expect(await get(o, o.viewer)).toBeNull();
    for (const user of [o.member, o.viewer]) {
      await expect(save(o, user, { name: 'Không được' })).rejects.toMatchObject({ status: 403 });
      await expect(exec(o, user, 'social.report_branding.remove', {})).rejects.toMatchObject({ status: 403 });
    }
    await save(o, o.admin, { name: '  Sao   Mai  Agency ', logo: png(), accent: '#1D4ED8', hideCrove: true });
    // Saved again: still one row.
    await save(o, o.owner, { name: 'Sao Mai Agency', logo: png(), accent: '#1d4ed8', hideCrove: true });
    const shown = await get(o, o.viewer);
    expect(shown).toMatchObject({ name: 'Sao Mai Agency', logo: png(), accent: '#1d4ed8', hideCrove: true });
    expect(await admin(async (c) => (await c.query('SELECT 1 FROM crove_social.report_branding WHERE org_id = $1', [o.orgId])).rowCount)).toBe(1);
    // The audit keeps the logo's size, never its bytes.
    const audit = await admin(async (c) => JSON.stringify((await c.query("SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command LIKE 'social.report_branding.%'", [o.orgId])).rows));
    expect(audit).toContain('"logo_bytes":48');
    expect(audit).not.toContain('base64');
    // An empty name is the org's own.
    await save(o, o.owner, { name: '', hideCrove: false });
    expect(await get(o, o.owner)).toMatchObject({ name: null, logo: null, accent: null, hideCrove: false });
    expect(await exec(o, o.admin, 'social.report_branding.remove', {})).toEqual({ removed: true });
    expect(await get(o, o.owner)).toBeNull();
    expect(await exec(o, o.admin, 'social.report_branding.remove', {})).toEqual({ removed: false });
  });

  it('refuses a wrong logo type, a mismatched magic number, an oversized logo and a low-contrast accent', async () => {
    const o = await org();
    const svg = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>').toString('base64')}`;
    expect(await refusal(save(o, o.owner, { logo: svg }))).toBe('BRAND_LOGO_INVALID');
    expect(await refusal(save(o, o.owner, { logo: `data:image/png;base64,${jpegBytes}` }))).toBe('BRAND_LOGO_INVALID');
    expect(await refusal(save(o, o.owner, { logo: 'https://logo.example/a.png' }))).toBe('BRAND_LOGO_INVALID');
    expect(await refusal(save(o, o.owner, { logo: png(BRAND_LOGO_MAX_BYTES) }))).toBe('BRAND_LOGO_TOO_LARGE');
    await expect(save(o, o.owner, { logo: png(BRAND_LOGO_MAX_BYTES) })).rejects.toMatchObject({ status: 413 });
    expect(await refusal(save(o, o.owner, { accent: '#ffff00' }))).toBe('BRAND_ACCENT_LOW_CONTRAST');
    expect(await refusal(save(o, o.owner, { accent: 'red' }))).toBe('BRAND_ACCENT_INVALID');
    expect(await refusal(save(o, o.owner, { name: 'a\u0000b' }))).toBe('VALIDATION');
    expect(await refusal(save(o, o.owner, { name: 'x'.repeat(101) }))).toBe('VALIDATION');
    // Format characters are dropped before the name is stored.
    await save(o, o.owner, { name: 'Sao\u202eMai\u200b Agency' });
    expect((await get(o, o.owner))?.name).toBe('SaoMai Agency');
    await exec(o, o.owner, 'social.report_branding.remove', {});
    expect(await get(o, o.owner)).toBeNull();
    // The JPEG it says it is passes; so does the largest logo allowed.
    await save(o, o.owner, { logo: `data:image/jpeg;base64,${jpegBytes}` });
    await save(o, o.owner, { logo: png(BRAND_LOGO_MAX_BYTES - 8) });

    // The table's CHECK says the same to anyone who writes around the command.
    const insert = (logo: string | null, accent: string | null = null) =>
      admin((c) => c.query('INSERT INTO crove_social.report_branding (org_id, logo, accent, updated_by) VALUES ($1, $2, $3, $4)', [o.orgId, logo, accent, o.owner])).then(
        () => 'inserted',
        (e: unknown) => (e as { code?: string }).code,
      );
    expect(await insert(svg)).toBe('23514');
    expect(await insert(`data:image/png;base64,${jpegBytes}`)).toBe('23514');
    expect(await insert(png(BRAND_LOGO_MAX_BYTES))).toBe('23514');
    // 65538 bytes as unpadded base64 fit the 87407-character bound with the PNG prefix, but not the decoded size.
    expect(await insert(png(BRAND_LOGO_MAX_BYTES - 8 + 2))).toBe('23514');
    expect(await insert(png(BRAND_LOGO_MAX_BYTES - 8 + 1))).toBe('23514');
    expect(await insert(`${png()}"><script>`)).toBe('23514');
    expect(await insert(null, '#1D4ED8')).toBe('23514');
    expect(await insert(null, 'red;x')).toBe('23514');
    expect(await insert(png())).toBe('inserted');
    expect(await insert(png(BRAND_LOGO_MAX_BYTES - 8))).toBe('inserted');
  });

  it("returns the brand of the link's own org only, and nothing for a revoked or expired link", async () => {
    const a = await org();
    const b = await org();
    const c = await org();
    await save(a, a.owner, { name: 'Brand A', logo: png(), accent: '#1d4ed8', hideCrove: true });
    await save(b, b.owner, { name: 'Brand B', accent: '#b91c1c' });
    const linkA = await reportLink(a);
    const linkB = await reportLink(b);
    const linkC = await reportLink(c);
    expect(await brandOf(linkA.token)).toEqual({ name: 'Brand A', logo: png(), accent: '#1d4ed8', hideCrove: true });
    expect(await brandOf(linkB.token)).toEqual({ name: 'Brand B', logo: null, accent: '#b91c1c', hideCrove: false });
    // An org with no branding: null, and the page as before.
    const pageC = (await reportView(rt, { token: linkC.token })) as { org: string; brand: unknown };
    expect(pageC.brand).toBeNull();
    expect(pageC.org).toBe(c.name);
    expect(JSON.stringify(await reportView(rt, { token: linkA.token }))).not.toContain('Brand B');

    // The review page, for one post and for a plan.
    const conn = await connection(a);
    const { postId } = await exec<{ postId: string }>(a, a.owner, 'social.post.create', { body: 'Bài duyệt', channels: [{ connectionId: conn }], scheduledAt: new Date(Date.now() + 86_400_000).toISOString() });
    const single = await exec<{ token: string; linkId: string }>(a, a.owner, 'social.review_link.create', { postId });
    expect(((await reviewView(rt, { token: single.token })) as { brand: unknown }).brand).toMatchObject({ name: 'Brand A', hideCrove: true });
    const plan = await exec<{ token: string; linkId: string }>(a, a.owner, 'social.review_link.create_plan', { postIds: [postId] });
    expect((await reviewView(rt, { token: plan.token })) as { kind: string; brand: unknown }).toMatchObject({ kind: 'plan', brand: { name: 'Brand A', accent: '#1d4ed8' } });
    const connB = await connection(b);
    const { postId: postB } = await exec<{ postId: string }>(b, b.owner, 'social.post.create', { body: 'Bài B', channels: [{ connectionId: connB }] });
    const singleB = await exec<{ token: string }>(b, b.owner, 'social.review_link.create', { postId: postB });
    expect(((await reviewView(rt, { token: singleB.token })) as { brand: unknown }).brand).toMatchObject({ name: 'Brand B' });
    const connC = await connection(c);
    const { postId: postC } = await exec<{ postId: string }>(c, c.owner, 'social.post.create', { body: 'Bài C', channels: [{ connectionId: connC }] });
    const singleC = await exec<{ token: string }>(c, c.owner, 'social.review_link.create', { postId: postC });
    expect(((await reviewView(rt, { token: singleC.token })) as { brand: unknown }).brand).toBeNull();

    // Revoked or expired: nothing, brand or not, the same answer as a wrong token.
    await exec(a, a.owner, 'social.report_link.revoke', { linkId: linkA.linkId });
    expect(await reportView(rt, { token: linkA.token })).toBeNull();
    await admin((cl) => cl.query("UPDATE crove_social.report_link SET created_at = now() - interval '2 days', expires_at = now() - interval '1 second' WHERE id = $1", [linkB.linkId]));
    expect(await reportView(rt, { token: linkB.token })).toBeNull();
    await exec(a, a.owner, 'social.review_link.revoke', { linkId: single.linkId });
    expect(await reviewView(rt, { token: single.token })).toBeNull();
    await admin((cl) => cl.query("UPDATE crove_social.review_link SET created_at = now() - interval '2 days', expires_at = now() - interval '1 second' WHERE id = $1", [plan.linkId]));
    expect(await reviewView(rt, { token: plan.token })).toBeNull();
    // A closed org's links open nothing either.
    await admin((cl) => cl.query("UPDATE crove_kernel.tenant SET status = 'closed' WHERE org_id = $1", [c.orgId]));
    expect(await reportView(rt, { token: linkC.token })).toBeNull();
  });

  it('keeps the branding helper and the definers to their grants: no role calls report_brand, no tenant reads another org', async () => {
    const a = await org();
    const b = await org();
    await save(a, a.owner, { name: 'Brand A' });
    for (const role of ['crove_app', 'crove_worker', 'crove_tenant']) {
      expect(await admin(async (c) => (await c.query<{ ok: boolean }>("SELECT has_function_privilege($1, 'crove_social.report_brand(uuid)', 'EXECUTE') AS ok", [role])).rows[0]?.ok)).toBe(false);
    }
    expect(await admin(async (c) => (await c.query<{ ok: boolean }>("SELECT has_function_privilege('crove_app', 'crove_social.report_link_view(text)', 'EXECUTE') AS ok")).rows[0]?.ok)).toBe(true);
    expect(await admin(async (c) => (await c.query<{ ok: boolean }>("SELECT has_function_privilege('crove_tenant', 'crove_social.report_link_view(text)', 'EXECUTE') AS ok")).rows[0]?.ok)).toBe(false);
    // The API role cannot call the helper with another org's id.
    await expect(pool.query('SELECT crove_social.report_brand($1)', [a.orgId])).rejects.toMatchObject({ code: '42501' });
    expect(await get(b, b.owner)).toBeNull();
  });

  it("puts the agency's name and accent in the report mail, and no Crove when hidden", async () => {
    const o = await org();
    await save(o, o.owner, { name: 'Sao Mai Agency', logo: png(), accent: '#0f766e', hideCrove: true });
    const { scheduleId } = await exec<{ scheduleId: string }>(o, o.owner, 'social.report_schedule.save', {
      name: 'Báo cáo tuần',
      cadence: 'weekly',
      weekday: 1,
      sendHour: 8,
      timeZone: 'Asia/Ho_Chi_Minh',
      period: 'previous_week',
      connectionIds: [],
      recipients: ['khach@example.vn'],
    });
    await exec(o, o.owner, 'social.report_schedule.test', { scheduleId });
    const sent: OutboundMail[] = [];
    const mailer: MailProvider = { name: 'resend', enabled: true, sendRetrySafety: 'idempotent', send: async (mail) => (sent.push(mail), { status: 'accepted', providerMessageId: `em_${randomUUID()}` }) };
    const jobs: MailJob[] = [];
    await sweepMail({ send: async (_q, data) => jobs.push(data) }, createDb(workerPool), worker, mailer);
    for (const job of jobs) await runMailJob({ runtime: worker, mailer, templates: MAIL_TEMPLATES, publicUrl: 'https://crove.example', bounceDomain: null }, job);
    expect(sent).toHaveLength(1);
    const html = sent[0]?.html ?? '';
    expect(html).toContain('border-bottom:3px solid #0f766e">Sao Mai Agency</p>');
    expect(html).toContain('Thư này được Sao Mai Agency gửi tự động theo lịch gửi báo cáo.');
    expect(html).not.toContain('Crove');
    // No logo in the mail: the mailer sends no inline images.
    expect(html).not.toContain('data:image');
  });
});
