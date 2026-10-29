// The crm module's event types (#1314) on PostgreSQL 17: who lists, creates and changes them, the host rules (a
// member manages only what they host, a host may change their calendar), slugs unique per org, archiving instead of
// deleting, and the database's own checks. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own
// database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import type { EventType, EventTypeInput } from '@crove/kernel-contract';
import { Runtime } from '@crove/kernel-runtime';
import { crmCommands, crmQueries } from '@crove/mod-crm';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('crm event types on PostgreSQL (#1314)', () => {
  const dbName = `crove_test_crm_event_types_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  const person = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@crm.test`, name: null });

  async function org() {
    const owner = await person('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Công ty ${randomUUID().slice(0, 6)}`);
    const member = await person('member');
    const other = await person('other');
    const viewer = await person('viewer');
    await admin((c) =>
      c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member'), ($1, $4, 'viewer')", [orgId, member, other, viewer]),
    );
    const exec = <T>(user: string, command: string, input: unknown) => rt.execute<T>(command, input, { actor: asUser(user), orgId });
    const list = (user: string) => rt.query<EventType[]>('crm.event_type.list', {}, { actor: asUser(user), orgId });
    return { orgId, owner, member, other, viewer, exec, list };
  }

  const draft = (hostUserId: string, over: Partial<EventTypeInput> = {}): EventTypeInput => ({
    slug: 'tu-van-thue',
    title: 'Tư vấn thuế',
    description: null,
    durationMin: 30,
    bufferBeforeMin: 0,
    bufferAfterMin: 10,
    minNoticeMin: 240,
    horizonDays: 30,
    dailyLimit: 4,
    locationKind: 'video',
    locationValue: 'https://meet.example.test/ke-toan',
    hostUserId,
    assignment: 'single',
    coHostUserIds: [],
    ...over,
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
    const app = new URL(adminUrl);
    app.username = 'crove_app';
    app.password = 'test-app-pw';
    pool = createPool({ connectionString: app.toString(), max: 4 });
    db = createDb(pool);
    rt = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands, ...crmCommands], queries: [...kernelQueries({ inboundDomain: null }), ...crmQueries] });
  });

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('lets an owner create an event type for a member, lists it to everyone, and keeps slugs unique per org', async () => {
    const o = await org();
    const created = await o.exec<EventType>(o.owner, 'crm.event_type.create', draft(o.member, { description: '  Gọi 30 phút  ' }));
    expect(created).toMatchObject({ slug: 'tu-van-thue', title: 'Tư vấn thuế', description: 'Gọi 30 phút', durationMin: 30, bufferAfterMin: 10, dailyLimit: 4, hostUserId: o.member, active: true });
    for (const user of [o.owner, o.member, o.viewer]) expect(await o.list(user)).toEqual([created]);

    await expect(o.exec(o.owner, 'crm.event_type.create', draft(o.owner))).rejects.toMatchObject({ code: 'EVENT_TYPE_SLUG_TAKEN', status: 409 });
    await expect(o.exec(o.owner, 'crm.event_type.create', draft(o.owner, { slug: 'Tu Van' }))).rejects.toMatchObject({ code: 'VALIDATION' });
    // Another org may use the same slug.
    const p = await org();
    expect(await p.exec<EventType>(p.owner, 'crm.event_type.create', draft(p.owner))).toMatchObject({ slug: 'tu-van-thue' });
    expect(await o.list(o.owner)).toHaveLength(1);
  });

  it('lets a member manage only the event types they host, and only members who may edit a calendar host', async () => {
    const o = await org();
    const mine = await o.exec<EventType>(o.member, 'crm.event_type.create', draft(o.member));
    await expect(o.exec(o.member, 'crm.event_type.create', draft(o.other, { slug: 'cho-nguoi-khac' }))).rejects.toMatchObject({ code: 'EVENT_TYPE_HOST_FORBIDDEN' });
    const theirs = await o.exec<EventType>(o.owner, 'crm.event_type.create', draft(o.other, { slug: 'cua-nguoi-khac' }));
    await expect(o.exec(o.member, 'crm.event_type.update', { eventTypeId: theirs.id, ...draft(o.other, { slug: 'cua-nguoi-khac', title: 'Đổi' }) })).rejects.toMatchObject({
      code: 'EVENT_TYPE_HOST_FORBIDDEN',
    });
    // Nor hand their own to someone else.
    await expect(o.exec(o.member, 'crm.event_type.update', { eventTypeId: mine.id, ...draft(o.other) })).rejects.toMatchObject({ code: 'EVENT_TYPE_HOST_FORBIDDEN' });
    await expect(o.exec(o.member, 'crm.event_type.set_active', { eventTypeId: theirs.id, active: false })).rejects.toMatchObject({ code: 'EVENT_TYPE_HOST_FORBIDDEN' });
    // A viewer neither manages nor hosts; a stranger cannot host.
    await expect(o.exec(o.viewer, 'crm.event_type.create', draft(o.viewer, { slug: 'nguoi-xem' }))).rejects.toMatchObject({ status: 403 });
    await expect(o.exec(o.owner, 'crm.event_type.create', draft(o.viewer, { slug: 'nguoi-xem' }))).rejects.toMatchObject({ code: 'EVENT_TYPE_HOST_INVALID' });
    await expect(o.exec(o.owner, 'crm.event_type.create', draft(randomUUID(), { slug: 'nguoi-la' }))).rejects.toMatchObject({ code: 'EVENT_TYPE_HOST_INVALID' });

    const updated = await o.exec<EventType>(o.member, 'crm.event_type.update', { eventTypeId: mine.id, ...draft(o.member, { title: 'Tư vấn thuế (60 phút)', durationMin: 60, dailyLimit: null }) });
    expect(updated).toMatchObject({ id: mine.id, title: 'Tư vấn thuế (60 phút)', durationMin: 60, dailyLimit: null });
    // A slug another type holds is refused on update too; keeping one's own is fine.
    await expect(o.exec(o.member, 'crm.event_type.update', { eventTypeId: mine.id, ...draft(o.member, { slug: 'cua-nguoi-khac' }) })).rejects.toMatchObject({ code: 'EVENT_TYPE_SLUG_TAKEN' });
    await expect(o.exec(o.owner, 'crm.event_type.update', { eventTypeId: randomUUID(), ...draft(o.member) })).rejects.toMatchObject({ code: 'EVENT_TYPE_NOT_FOUND' });

    const audit = await admin((c) =>
      c.query<{ command: string }>("SELECT command FROM crove_kernel.audit_event WHERE org_id = $1 AND command LIKE 'crm.event_type.%' AND outcome = 'ok' ORDER BY occurred_at, id", [o.orgId]),
    );
    expect(audit.rows.map((r) => r.command)).toEqual(['crm.event_type.create', 'crm.event_type.create', 'crm.event_type.update']);
    // The update's audit names the changed fields, never their free-text values.
    const detail = await admin((c) =>
      c.query<{ detail: { changed: string[] } }>("SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'crm.event_type.update' AND outcome = 'ok'", [o.orgId]),
    );
    expect(detail.rows[0]?.detail.changed.sort()).toEqual(['dailyLimit', 'durationMin', 'title']);
    expect(JSON.stringify(detail.rows[0]?.detail)).not.toContain('meet.example.test');
  });

  it('archives and restores instead of deleting', async () => {
    const o = await org();
    const type = await o.exec<EventType>(o.member, 'crm.event_type.create', draft(o.member));
    expect(await o.exec<EventType>(o.member, 'crm.event_type.set_active', { eventTypeId: type.id, active: false })).toMatchObject({ active: false });
    expect((await o.list(o.viewer))[0]).toMatchObject({ id: type.id, active: false });
    // The slug stays taken while archived.
    await expect(o.exec(o.owner, 'crm.event_type.create', draft(o.owner))).rejects.toMatchObject({ code: 'EVENT_TYPE_SLUG_TAKEN' });
    // A host who became a viewer cannot be brought back as host.
    await admin((c) => c.query("UPDATE crove_kernel.tenant_member SET role = 'viewer' WHERE org_id = $1 AND user_id = $2", [o.orgId, o.member]));
    await expect(o.exec(o.owner, 'crm.event_type.set_active', { eventTypeId: type.id, active: true })).rejects.toMatchObject({ code: 'EVENT_TYPE_HOST_INVALID' });
    await admin((c) => c.query("UPDATE crove_kernel.tenant_member SET role = 'member' WHERE org_id = $1 AND user_id = $2", [o.orgId, o.member]));
    expect(await o.exec<EventType>(o.owner, 'crm.event_type.set_active', { eventTypeId: type.id, active: true })).toMatchObject({ active: true });
    // No role deletes one.
    const app = new pg.Client({ connectionString: adminUrl });
    await app.connect();
    try {
      await app.query('SET ROLE crove_tenant');
      await expect(app.query('DELETE FROM crove_crm.event_type WHERE org_id = $1', [o.orgId])).rejects.toThrow(/permission denied/);
    } finally {
      await app.end();
    }
  });

  it('checks slugs, lengths and limits in the database too', async () => {
    const o = await org();
    const insert = (cols: string, values: string) =>
      admin((c) => c.query(`INSERT INTO crove_crm.event_type (org_id, host_user_id, created_by, title, ${cols}) VALUES ($1, $2, $2, 'T', ${values})`, [o.orgId, o.owner]));
    await expect(insert('slug, duration_min', "'Bad Slug', 30")).rejects.toThrow(/event_type_slug_check/);
    await expect(insert('slug, duration_min', "'ok', 4")).rejects.toThrow(/event_type_duration_min_check/);
    await expect(insert('slug, duration_min, daily_limit', "'ok', 30, 0")).rejects.toThrow(/event_type_daily_limit_check/);
    await expect(insert('slug, duration_min, location_kind', "'ok', 30, 'zoom'")).rejects.toThrow(/event_type_location_kind_check/);
  });
});
