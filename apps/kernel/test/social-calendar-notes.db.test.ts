// Notes on calendar dates (#794) on PostgreSQL 17: who adds, changes and removes them, the days they cover, the
// limits, and that one org never sees another's. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own
// database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { socialCommands, socialQueries, type CalendarNote } from '@crove/mod-social';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('social calendar notes on PostgreSQL (#794)', () => {
  const dbName = `crove_test_social_notes_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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

  const person = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@social.test`, name: null });

  async function org() {
    const owner = await person('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    const member = await person('member');
    const viewer = await person('viewer');
    await admin((c) => c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'viewer')", [orgId, member, viewer]));
    return { orgId, owner, member, viewer };
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
    const app = new URL(adminUrl);
    app.username = 'crove_app';
    app.password = 'test-app-pw';
    pool = createPool({ connectionString: app.toString(), max: 4 });
    db = createDb(pool);
    rt = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands, ...socialCommands], queries: [...kernelQueries({ inboundDomain: null }), ...socialQueries] });
  });

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('lets members add, change and remove notes, shows the ones overlapping the days asked, and keeps viewers to reading', async () => {
    const o = await org();
    const exec = <T>(user: string, name: string, input: unknown) => rt.execute<T>(name, input, { actor: asUser(user), orgId: o.orgId });
    const list = (user: string, from: string, to: string) => rt.query<CalendarNote[]>('social.calendar_note.list', { from, to }, { actor: asUser(user), orgId: o.orgId });
    const { noteId } = await exec<{ noteId: string }>(o.member, 'social.calendar_note.save', { startsOn: '2026-11-09', endsOn: '2026-11-11', title: '  Sale   11.11 ', color: 'red' });
    await exec(o.owner, 'social.calendar_note.save', { startsOn: '2026-12-24', endsOn: '2026-12-24', title: 'Giáng sinh' });
    expect(await list(o.viewer, '2026-11-01', '2026-11-30')).toEqual([expect.objectContaining({ id: noteId, startsOn: '2026-11-09', endsOn: '2026-11-11', title: 'Sale 11.11', color: 'red' })]);
    // Overlap counts: a view that starts inside the note still shows it.
    expect((await list(o.viewer, '2026-11-10', '2026-11-16')).map((n) => n.id)).toEqual([noteId]);
    expect((await list(o.viewer, '2026-12-01', '2026-12-31'))[0]).toMatchObject({ title: 'Giáng sinh', color: 'blue' });

    await exec(o.owner, 'social.calendar_note.save', { noteId, startsOn: '2026-11-10', endsOn: '2026-11-12', title: 'Sale 11.11 (đổi)' });
    expect((await list(o.member, '2026-11-01', '2026-11-30'))[0]).toMatchObject({ startsOn: '2026-11-10', title: 'Sale 11.11 (đổi)', color: 'red', updatedBy: o.owner });

    await expect(exec(o.viewer, 'social.calendar_note.save', { startsOn: '2026-11-01', endsOn: '2026-11-01', title: 'x' })).rejects.toMatchObject({ status: 403 });
    await expect(exec(o.member, 'social.calendar_note.save', { startsOn: '2026-11-05', endsOn: '2026-11-04', title: 'x' })).rejects.toMatchObject({ code: 'CALENDAR_NOTE_RANGE' });
    await expect(exec(o.member, 'social.calendar_note.save', { startsOn: '2026-11-01', endsOn: '2026-12-02', title: 'x' })).rejects.toMatchObject({ code: 'CALENDAR_NOTE_RANGE' });
    await expect(exec(o.member, 'social.calendar_note.save', { startsOn: '2026-02-30', endsOn: '2026-02-30', title: 'x' })).rejects.toMatchObject({ status: 422 });
    await expect(exec(o.member, 'social.calendar_note.save', { startsOn: '0000-01-01', endsOn: '0000-01-01', title: 'x' })).rejects.toMatchObject({ status: 422 });
    await expect(exec(o.member, 'social.calendar_note.save', { noteId: '018f0000-0000-7000-8000-000000000009', startsOn: '2026-11-01', endsOn: '2026-11-01', title: 'x' })).rejects.toMatchObject({ code: 'CALENDAR_NOTE_NOT_FOUND' });

    expect(await exec(o.member, 'social.calendar_note.remove', { noteId })).toEqual({ noteId, removed: true });
    expect(await list(o.member, '2026-11-01', '2026-11-30')).toEqual([]);
  });

  it('keeps each org to its own notes', async () => {
    const a = await org();
    const b = await org();
    const { noteId } = await rt.execute<{ noteId: string }>('social.calendar_note.save', { startsOn: '2026-11-01', endsOn: '2026-11-01', title: 'Của A' }, { actor: asUser(a.owner), orgId: a.orgId });
    expect(await rt.query('social.calendar_note.list', { from: '2026-11-01', to: '2026-11-30' }, { actor: asUser(b.owner), orgId: b.orgId })).toEqual([]);
    await expect(rt.execute('social.calendar_note.save', { noteId, startsOn: '2026-11-02', endsOn: '2026-11-02', title: 'Của B' }, { actor: asUser(b.owner), orgId: b.orgId })).rejects.toMatchObject({ code: 'CALENDAR_NOTE_NOT_FOUND' });
    expect(await rt.execute('social.calendar_note.remove', { noteId }, { actor: asUser(b.owner), orgId: b.orgId })).toEqual({ noteId, removed: false });
  });
});
