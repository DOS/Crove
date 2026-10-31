// SPDX-License-Identifier: AGPL-3.0-only
// Outside calendars (#2123, part of #1374) on PostgreSQL 17: a member connects an account, its tokens are sealed and only
// the worker reads them, the sync replaces a connection's busy blocks as a set, and a block takes slots away without
// carrying a title. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity, type SealedCalendarCredential } from '@crove/kernel';
import { calendarBinding, isVietnamHoliday, weekdayOf, zonedDate, zonedInstant } from '@crove/kernel-contract';
import { CredentialVault, Runtime, parseVaultKey } from '@crove/kernel-runtime';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const VN = 'Asia/Ho_Chi_Minh';
const DAY = 86_400_000;

// The next working day (Vietnam time, Monday to Friday, not a public holiday) at least two days from now.
function nextWorkday(): string {
  let date = zonedDate(VN, Date.now() + 2 * DAY);
  while (weekdayOf(date) > 5 || isVietnamHoliday(date)) date = zonedDate(VN, Date.parse(`${date}T12:00:00Z`) + DAY);
  return date;
}
const at = (date: string, minute: number) => new Date(zonedInstant(VN, date, minute)).toISOString();
const dayRange = (date: string) => ({ from: at(date, 0), to: at(date, 1440) });

suite('outside calendars on PostgreSQL (#2123)', () => {
  const dbName = `crove_test_calendar_conn_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appPool: pg.Pool;
  let workerPool: pg.Pool;
  let appDb: Db;
  let api: Runtime;
  let worker: Runtime;
  const vault = new CredentialVault([parseVaultKey(randomBytes(32).toString('base64'))]);
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const system = { type: 'system' as const, component: 'calendar-test' };

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  const person = (name: string) => upsertIdentity(appDb, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@calconn.test`, name: null });

  async function org() {
    const owner = await person('owner');
    const { orgId } = await createOrg(api, asUser(owner), `Công ty ${randomUUID().slice(0, 6)}`);
    const member = await person('member');
    const other = await person('other');
    const viewer = await person('viewer');
    await admin((c) =>
      c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member'), ($1, $4, 'viewer')", [orgId, member, other, viewer]),
    );
    const exec = <T>(user: string, command: string, input: unknown) => api.execute<T>(command, input, { actor: asUser(user), orgId });
    const query = <T>(user: string, name: string, input: unknown) => api.query<T>(name, input, { actor: asUser(user), orgId });
    const sys = <T>(command: string, input: unknown) => worker.execute<T>(command, input, { actor: system, orgId });
    const sysQuery = <T>(name: string, input: unknown) => worker.query<T>(name, input, { actor: system, orgId });
    return { orgId, owner, member, other, viewer, exec, query, sys, sysQuery };
  }

  type Org = Awaited<ReturnType<typeof org>>;

  async function connect(o: Org, user: string, account = `${randomUUID().slice(0, 8)}@gmail.test`, secret = JSON.stringify({ accessToken: 'access-1', refreshToken: 'refresh-1' })) {
    const sealed = vault.seal(secret, calendarBinding(o.orgId, 'google', account));
    const done = await o.exec<{ connectionId: string; reconnected: boolean }>(user, 'kernel.calendar.connect', {
      provider: 'google',
      externalAccount: account,
      displayName: account,
      scopes: ['https://www.googleapis.com/auth/calendar.freebusy'],
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      credential: { keyId: sealed.keyId, envelope: sealed.envelope.toString('base64') },
    });
    return { ...done, account };
  }

  const busy = (day: string, from: number, to: number) => ({ start: at(day, from), end: at(day, to) });

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
    const as = (user: string, password: string) => {
      const u = new URL(adminUrl);
      u.username = user;
      u.password = password;
      return u.toString();
    };
    appPool = createPool({ connectionString: as('crove_app', 'test-app-pw'), max: 4 });
    workerPool = createPool({ connectionString: as('crove_worker', 'test-worker-pw'), max: 4 });
    appDb = createDb(appPool);
    const defs = { commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) };
    api = new Runtime(appDb, { manifests: TEST_MANIFESTS }).register(defs);
    worker = new Runtime(createDb(workerPool), { manifests: TEST_MANIFESTS }).register(defs);
  });

  afterAll(async () => {
    await appPool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('lets a member connect their own account, shows it to nobody else, and refuses a viewer', async () => {
    const o = await org();
    const mine = await connect(o, o.member);
    expect(mine.reconnected).toBe(false);
    const list = await o.query<{ id: string; provider: string; displayName: string; status: string; lastSyncedAt: string | null; writeBack: boolean }[]>(o.member, 'kernel.calendar.connections', {});
    expect(list).toMatchObject([{ id: mine.connectionId, provider: 'google', displayName: mine.account, status: 'active', lastSyncedAt: null, writeBack: false }]);
    // A colleague, an owner and an admin see none of it: the row policy keeps a calendar to its member.
    expect(await o.query(o.other, 'kernel.calendar.connections', {})).toEqual([]);
    expect(await o.query(o.owner, 'kernel.calendar.connections', {})).toEqual([]);
    // Connecting the same account again is a reconnect of the same row.
    const again = await connect(o, o.member, mine.account);
    expect(again).toMatchObject({ connectionId: mine.connectionId, reconnected: true });
    await expect(connect(o, o.viewer)).rejects.toMatchObject({ status: 403 });
    // Someone else's connection is not found, not forbidden: a member cannot learn which ids exist.
    await expect(o.exec(o.other, 'kernel.calendar.disconnect', { connectionId: mine.connectionId })).rejects.toMatchObject({ code: 'CALENDAR_NOT_FOUND' });
  });

  it('seals the tokens: the API never reads them back, the worker opens them under their binding only', async () => {
    const o = await org();
    const c = await connect(o, o.member);
    await expect(o.query(o.member, 'kernel.calendar.credential', { connectionId: c.connectionId })).rejects.toMatchObject({ status: 403 });
    const sealed = await o.sysQuery<SealedCalendarCredential>('kernel.calendar.credential', { connectionId: c.connectionId });
    expect(sealed).toMatchObject({ provider: 'google', externalAccount: c.account });
    const open = (orgId: string, account: string) => vault.open({ keyId: sealed.keyId, envelope: Buffer.from(sealed.envelope, 'base64') }, calendarBinding(orgId, 'google', account));
    expect(JSON.parse(open(o.orgId, c.account))).toEqual({ accessToken: 'access-1', refreshToken: 'refresh-1' });
    expect(() => open(randomUUID(), c.account)).toThrow();
    expect(() => open(o.orgId, 'someone-else@gmail.test')).toThrow();
    // No Crove login role holds a grant on the credential table, and the audit trail holds no token.
    const grants = await admin((cl) =>
      cl.query<{ role: string }>(
        `SELECT r AS role FROM unnest(ARRAY['crove_app', 'crove_worker', 'crove_tenant', 'crove_definer_tenant']) r
         CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) p WHERE has_table_privilege(r, 'crove_kernel.calendar_credential', p)`,
      ),
    );
    expect(grants.rows).toEqual([]);
    const audit = await admin((cl) => cl.query<{ text: string }>("SELECT detail::text AS text FROM crove_kernel.audit_event WHERE org_id = $1", [o.orgId]));
    expect(audit.rows.map((r) => r.text).join('\n')).not.toMatch(/access-1|refresh-1|envelope/);
  });

  it('gives each member their own connection for the same account', async () => {
    const o = await org();
    const mine = await connect(o, o.member, 'shared@gmail.test');
    const theirs = await connect(o, o.other, 'shared@gmail.test');
    expect(theirs.connectionId).not.toBe(mine.connectionId);
    expect(theirs.reconnected).toBe(false);
  });

  it('starts and finishes a connect attempt once, for the same member and a calendar provider only', async () => {
    const o = await org();
    const hash = `sha256:${randomBytes(32).toString('hex')}`;
    const verifier = randomBytes(48).toString('base64url');
    await o.exec(o.member, 'kernel.calendar.oauth_begin', { provider: 'google_calendar', stateHash: hash, codeVerifier: verifier });
    // Another member, or another provider, cannot finish it, and one answer covers both.
    await expect(o.exec(o.other, 'kernel.calendar.oauth_consume', { provider: 'google_calendar', stateHash: hash })).rejects.toMatchObject({ code: 'OAUTH_STATE_INVALID' });
    await expect(o.exec(o.member, 'kernel.calendar.oauth_consume', { provider: 'microsoft_calendar', stateHash: hash })).rejects.toMatchObject({ code: 'OAUTH_STATE_INVALID' });
    expect(await o.exec(o.member, 'kernel.calendar.oauth_consume', { provider: 'google_calendar', stateHash: hash })).toEqual({ codeVerifier: verifier });
    await expect(o.exec(o.member, 'kernel.calendar.oauth_consume', { provider: 'google_calendar', stateHash: hash })).rejects.toMatchObject({ code: 'OAUTH_STATE_USED' });
    // The verifier is wiped with the consume; a viewer cannot start one.
    const row = await admin((c) => c.query<{ code_verifier: string | null }>('SELECT code_verifier FROM crove_kernel.oauth_state WHERE state_hash = $1', [hash]));
    expect(row.rows[0]?.code_verifier).toBeNull();
    await expect(o.exec(o.viewer, 'kernel.calendar.oauth_begin', { provider: 'google_calendar', stateHash: `sha256:${randomBytes(32).toString('hex')}`, codeVerifier: null })).rejects.toMatchObject({ status: 403 });
  });

  it('replaces a connection\'s busy blocks as a set, and a block takes slots away without a title', async () => {
    const o = await org();
    const c = await connect(o, o.member);
    const day = nextWorkday();
    const range = dayRange(day);
    const slots = () => o.query<{ start: string; end: string }[]>(o.member, 'kernel.calendar.slots', { ...range, durationMin: 30 });
    const before = await slots();
    expect(before.length).toBeGreaterThan(0);
    const window = { from: at(day, 0), to: new Date(Date.parse(at(day, 0)) + 60 * DAY).toISOString() };
    const first = await o.sys<{ replaced: boolean; added: number; removed: number }>('kernel.calendar.busy_replace', { connectionId: c.connectionId, ...window, busy: [busy(day, 480, 1020)] });
    expect(first).toMatchObject({ replaced: true, added: 1, removed: 0 });
    expect(await slots()).toEqual([]);
    // The same answer again changes nothing; a different one swaps exactly the difference.
    expect(await o.sys('kernel.calendar.busy_replace', { connectionId: c.connectionId, ...window, busy: [busy(day, 480, 1020)] })).toMatchObject({ added: 0, removed: 0 });
    expect(await o.sys('kernel.calendar.busy_replace', { connectionId: c.connectionId, ...window, busy: [busy(day, 480, 600)] })).toMatchObject({ added: 1, removed: 1 });
    expect((await slots()).length).toBeLessThan(before.length);
    expect((await slots()).length).toBeGreaterThan(0);
    // Only start and end are kept: no title, and the kind names the provider.
    const stored = await admin((cl) => cl.query<{ title: string | null; kind: string; source_id: string }>('SELECT title, kind, source_id FROM crove_kernel.calendar_event WHERE source_id = $1', [c.connectionId]));
    expect(stored.rows).toEqual([{ title: null, kind: 'google', source_id: c.connectionId }]);
    // The member sees the block on their calendar and cannot cancel it by hand.
    const mine = await o.query<{ events: { id: string; kind: string; title: string | null }[] }>(o.member, 'kernel.calendar.get', range);
    const block = mine.events.find((e) => e.kind === 'google');
    expect(block).toMatchObject({ title: null });
    await expect(o.exec(o.member, 'kernel.calendar.event.cancel', { eventId: (block as { id: string }).id })).rejects.toMatchObject({ code: 'CALENDAR_EVENT_IS_EXTERNAL' });
    // The last sync is noted on the connection.
    const list = await o.query<{ lastSyncedAt: string | null }[]>(o.member, 'kernel.calendar.connections', {});
    expect(list[0]?.lastSyncedAt).not.toBeNull();
  });

  it('merges overlapping intervals and cuts one longer than a block into pieces', async () => {
    const o = await org();
    const c = await connect(o, o.member);
    const day = nextWorkday();
    const from = at(day, 0);
    const to = new Date(Date.parse(from) + 90 * DAY).toISOString();
    const long = { start: at(day, 0), end: new Date(Date.parse(at(day, 0)) + 70 * DAY).toISOString() };
    const done = await o.sys<{ added: number }>('kernel.calendar.busy_replace', { connectionId: c.connectionId, from, to, busy: [long, busy(day, 600, 660), busy(day, 630, 700)] });
    // One merged interval of 70 days: three pieces of at most 30 days.
    expect(done.added).toBe(3);
  });

  it('disconnects in two steps: the blocks go and the member loses it at once, the worker revokes the grant, then the token and the row go', async () => {
    const o = await org();
    const a = await connect(o, o.member);
    const b = await connect(o, o.other);
    const day = nextWorkday();
    const window = { from: at(day, 0), to: new Date(Date.parse(at(day, 0)) + 60 * DAY).toISOString() };
    await o.sys('kernel.calendar.busy_replace', { connectionId: a.connectionId, ...window, busy: [busy(day, 480, 540)] });
    await o.sys('kernel.calendar.busy_replace', { connectionId: b.connectionId, ...window, busy: [busy(day, 480, 540)] });
    expect(await o.exec(o.member, 'kernel.calendar.disconnect', { connectionId: a.connectionId })).toEqual({ connectionId: a.connectionId, disconnected: true });
    // Step 1: the member's list and the slots are clean at once; a block of another connection stays.
    expect(await o.query(o.member, 'kernel.calendar.connections', {})).toEqual([]);
    const left = await admin((cl) => cl.query<{ source_id: string }>('SELECT source_id FROM crove_kernel.calendar_event WHERE org_id = $1 AND source_id IS NOT NULL', [o.orgId]));
    expect(left.rows.map((r) => r.source_id)).toEqual([b.connectionId]);
    // The token is still sealed, for the worker to revoke the grant with: the API cannot, so it could not revoke here.
    const sealed = await o.sysQuery<SealedCalendarCredential>('kernel.calendar.credential', { connectionId: a.connectionId });
    expect(JSON.parse(vault.open({ keyId: sealed.keyId, envelope: Buffer.from(sealed.envelope, 'base64') }, calendarBinding(o.orgId, 'google', a.account)))).toEqual({ accessToken: 'access-1', refreshToken: 'refresh-1' });
    // A sync of it stores nothing and a failure note does not bring it back; asking twice changes nothing.
    expect(await o.sys('kernel.calendar.busy_replace', { connectionId: a.connectionId, ...window, busy: [busy(day, 600, 660)] })).toMatchObject({ replaced: false });
    expect(await o.sys('kernel.calendar.mark_failed', { connectionId: a.connectionId, status: 'expired', reason: 'refused (x)' })).toMatchObject({ marked: false });
    expect(await o.exec(o.member, 'kernel.calendar.disconnect', { connectionId: a.connectionId })).toMatchObject({ disconnected: true });
    // The worker's list names it as disconnecting; only the system finishes it.
    const due = await workerPool.query<{ connection_id: string; disconnecting: boolean }>('SELECT connection_id, disconnecting FROM crove_kernel.calendar_sync_due(NULL, NULL, 1000) WHERE org_id = $1 ORDER BY connection_id', [o.orgId]);
    expect(Object.fromEntries(due.rows.map((r) => [r.connection_id, r.disconnecting]))).toEqual({ [a.connectionId]: true, [b.connectionId]: false });
    await expect(o.exec(o.member, 'kernel.calendar.finish_disconnect', { connectionId: a.connectionId, revoked: true })).rejects.toMatchObject({ status: 403 });
    // Step 2.
    expect(await o.sys('kernel.calendar.finish_disconnect', { connectionId: a.connectionId, revoked: true })).toEqual({ connectionId: a.connectionId, finished: true });
    const creds = await admin((cl) => cl.query('SELECT 1 FROM crove_kernel.calendar_credential WHERE org_id = $1 AND id = $2', [o.orgId, a.connectionId]));
    expect(creds.rowCount).toBe(0);
    const rows = await admin((cl) => cl.query('SELECT 1 FROM crove_kernel.calendar_connection WHERE org_id = $1 AND id = $2', [o.orgId, a.connectionId]));
    expect(rows.rowCount).toBe(0);
    // The audit row says whether the grant was revoked.
    const audit = await admin((cl) => cl.query<{ detail: { revoked?: boolean } }>("SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.calendar.finish_disconnect'", [o.orgId]));
    expect(audit.rows[0]?.detail).toMatchObject({ revoked: true });
  });

  it('removes an expired connection at once (its token is gone, nothing to revoke) and finishes only a disconnecting one', async () => {
    const o = await org();
    const c = await connect(o, o.member);
    await o.sys('kernel.calendar.mark_failed', { connectionId: c.connectionId, status: 'expired', reason: 'refused (invalid_grant)' });
    expect(await o.exec(o.member, 'kernel.calendar.disconnect', { connectionId: c.connectionId })).toMatchObject({ disconnected: true });
    const gone = await admin((cl) => cl.query('SELECT 1 FROM crove_kernel.calendar_connection WHERE org_id = $1 AND id = $2', [o.orgId, c.connectionId]));
    expect(gone.rowCount).toBe(0);
    // An active connection is not finished by the worker's command: a member who connected again keeps it.
    const kept = await connect(o, o.member);
    expect(await o.sys('kernel.calendar.finish_disconnect', { connectionId: kept.connectionId, revoked: false, reason: 'owner_left' })).toMatchObject({ finished: false });
    expect(await o.query<unknown[]>(o.member, 'kernel.calendar.connections', {})).toHaveLength(1);
  });

  it('keeps a connection the member connected again while its revoke was pending', async () => {
    const o = await org();
    const c = await connect(o, o.member);
    await o.exec(o.member, 'kernel.calendar.disconnect', { connectionId: c.connectionId });
    const again = await connect(o, o.member, c.account, JSON.stringify({ accessToken: 'access-4', refreshToken: 'refresh-4' }));
    expect(again).toMatchObject({ connectionId: c.connectionId, reconnected: true });
    // Active again: the worker's finish does nothing, and it shows in the list.
    expect(await o.sys('kernel.calendar.finish_disconnect', { connectionId: c.connectionId, revoked: true })).toMatchObject({ finished: false });
    expect(await o.query<unknown[]>(o.member, 'kernel.calendar.connections', {})).toHaveLength(1);
  });

  it('finishes the removal of a disconnecting connection whose member has left, with no token handed out', async () => {
    const o = await org();
    const c = await connect(o, o.member);
    await o.exec(o.member, 'kernel.calendar.disconnect', { connectionId: c.connectionId });
    await admin((cl) => cl.query('DELETE FROM crove_kernel.tenant_member WHERE org_id = $1 AND user_id = $2', [o.orgId, o.member]));
    await expect(o.sysQuery('kernel.calendar.credential', { connectionId: c.connectionId })).rejects.toMatchObject({ code: 'CALENDAR_OWNER_LEFT' });
    const due = await workerPool.query<{ disconnecting: boolean }>('SELECT disconnecting FROM crove_kernel.calendar_sync_due(NULL, NULL, 1000) WHERE org_id = $1 AND connection_id = $2', [o.orgId, c.connectionId]);
    expect(due.rows).toEqual([{ disconnecting: true }]);
    expect(await o.sys('kernel.calendar.finish_disconnect', { connectionId: c.connectionId, revoked: false, reason: 'owner_left' })).toMatchObject({ finished: true });
  });

  it('expires a refused connection (dropping its token, keeping its blocks) and notes a passing failure', async () => {
    const o = await org();
    const c = await connect(o, o.member);
    const day = nextWorkday();
    const window = { from: at(day, 0), to: new Date(Date.parse(at(day, 0)) + 60 * DAY).toISOString() };
    await o.sys('kernel.calendar.busy_replace', { connectionId: c.connectionId, ...window, busy: [busy(day, 480, 540)] });
    await o.sys('kernel.calendar.mark_failed', { connectionId: c.connectionId, status: 'retry', reason: 'sync failed (503)' });
    let list = await o.query<{ status: string; statusReason: string | null }[]>(o.member, 'kernel.calendar.connections', {});
    expect(list[0]).toMatchObject({ status: 'active', statusReason: 'sync failed (503)' });
    // The next good sync clears the note.
    await o.sys('kernel.calendar.busy_replace', { connectionId: c.connectionId, ...window, busy: [busy(day, 480, 540)] });
    list = await o.query(o.member, 'kernel.calendar.connections', {});
    expect(list[0]).toMatchObject({ status: 'active', statusReason: null });
    await o.sys('kernel.calendar.mark_failed', { connectionId: c.connectionId, status: 'expired', reason: 'refused (invalid_grant)' });
    list = await o.query(o.member, 'kernel.calendar.connections', {});
    expect(list[0]).toMatchObject({ status: 'expired' });
    await expect(o.sysQuery('kernel.calendar.credential', { connectionId: c.connectionId })).rejects.toMatchObject({ code: 'CALENDAR_NOT_ACTIVE' });
    // The refusal above comes before the credential lookup: the row itself is what must be gone.
    const sealedLeft = await admin((cl) => cl.query('SELECT 1 FROM crove_kernel.calendar_credential WHERE org_id = $1 AND id = $2', [o.orgId, c.connectionId]));
    expect(sealedLeft.rowCount).toBe(0);
    // Its blocks stay, so time that may still be busy is not offered; a sync of an expired connection stores nothing.
    expect(await o.sys('kernel.calendar.busy_replace', { connectionId: c.connectionId, ...window, busy: [] })).toMatchObject({ replaced: false });
    const blocks = await admin((cl) => cl.query('SELECT 1 FROM crove_kernel.calendar_event WHERE source_id = $1', [c.connectionId]));
    expect(blocks.rowCount).toBe(1);
    // Connecting again brings it back, with a new token.
    const again = await connect(o, o.member, c.account, JSON.stringify({ accessToken: 'access-2', refreshToken: 'refresh-2' }));
    expect(again).toMatchObject({ connectionId: c.connectionId, reconnected: true });
    list = await o.query(o.member, 'kernel.calendar.connections', {});
    expect(list[0]).toMatchObject({ status: 'active', statusReason: null });
  });

  it('renews a token only against the version it started from', async () => {
    const o = await org();
    const c = await connect(o, o.member);
    const state = await o.sysQuery<{ updatedAt: string }>('kernel.calendar.connection_state', { connectionId: c.connectionId });
    const next = vault.seal(JSON.stringify({ accessToken: 'access-9', refreshToken: 'refresh-9' }), calendarBinding(o.orgId, 'google', c.account));
    const command = { connectionId: c.connectionId, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), credential: { keyId: next.keyId, envelope: next.envelope.toString('base64') } };
    expect(await o.sys('kernel.calendar.refresh', { ...command, ifVersion: state.updatedAt })).toMatchObject({ refreshed: true });
    // The same version is now stale: a reconnect or another refresh moved it.
    expect(await o.sys('kernel.calendar.refresh', { ...command, ifVersion: state.updatedAt })).toMatchObject({ refreshed: false });
    await expect(o.exec(o.member, 'kernel.calendar.refresh', { ...command, ifVersion: state.updatedAt })).rejects.toMatchObject({ status: 403 });
  });

  it('marks a connection failed only against the version the caller saw', async () => {
    const o = await org();
    const c = await connect(o, o.member);
    const state = await o.sysQuery<{ updatedAt: string }>('kernel.calendar.connection_state', { connectionId: c.connectionId });
    // The member connects again: a newer version, and a refusal of the old token must leave it alone.
    await connect(o, o.member, c.account, JSON.stringify({ accessToken: 'access-3', refreshToken: 'refresh-3' }));
    expect(await o.sys('kernel.calendar.mark_failed', { connectionId: c.connectionId, status: 'expired', reason: 'refused (invalid_token)', ifVersion: state.updatedAt })).toMatchObject({ marked: false });
    const list = await o.query<{ status: string }[]>(o.member, 'kernel.calendar.connections', {});
    expect(list[0]?.status).toBe('active');
    const sealed = await o.sysQuery<SealedCalendarCredential>('kernel.calendar.credential', { connectionId: c.connectionId });
    expect(JSON.parse(vault.open({ keyId: sealed.keyId, envelope: Buffer.from(sealed.envelope, 'base64') }, calendarBinding(o.orgId, 'google', c.account)))).toEqual({ accessToken: 'access-3', refreshToken: 'refresh-3' });
  });

  it('drops the blocks that ended before the window with the sync that moved past them', async () => {
    const o = await org();
    const c = await connect(o, o.member);
    const day = nextWorkday();
    const window = { from: at(day, 0), to: new Date(Date.parse(at(day, 0)) + 60 * DAY).toISOString() };
    // A block of last week, put there as the sync of last week left it.
    await admin((cl) =>
      cl.query(
        "INSERT INTO crove_kernel.calendar_event (org_id, user_id, starts_at, ends_at, time_zone, kind, source_id, external_id, created_by) VALUES ($1, $2, now() - interval '20 days', now() - interval '20 days' + interval '1 hour', 'UTC', 'google', $3, 'old-block', $2)",
        [o.orgId, o.member, c.connectionId],
      ),
    );
    await o.sys('kernel.calendar.busy_replace', { connectionId: c.connectionId, ...window, busy: [busy(day, 480, 540)] });
    const left = await admin((cl) => cl.query<{ external_id: string }>('SELECT external_id FROM crove_kernel.calendar_event WHERE source_id = $1', [c.connectionId]));
    expect(left.rows.map((r) => r.external_id)).not.toContain('old-block');
    expect(left.rowCount).toBe(1);
  });

  it('lets a member demoted to viewer still disconnect their own calendar', async () => {
    const o = await org();
    const c = await connect(o, o.member);
    await admin((cl) => cl.query("UPDATE crove_kernel.tenant_member SET role = 'viewer' WHERE org_id = $1 AND user_id = $2", [o.orgId, o.member]));
    expect(await o.exec(o.member, 'kernel.calendar.disconnect', { connectionId: c.connectionId })).toEqual({ connectionId: c.connectionId, disconnected: true });
  });

  it('lists for the sync only active connections of members who are still in the org', async () => {
    const o = await org();
    const active = await connect(o, o.member);
    const expired = await connect(o, o.other);
    await o.sys('kernel.calendar.mark_failed', { connectionId: expired.connectionId, status: 'expired', reason: 'refused (invalid_grant)' });
    const due = async () => {
      const { rows } = await workerPool.query<{ org_id: string; connection_id: string }>('SELECT org_id, connection_id FROM crove_kernel.calendar_sync_due(NULL, NULL, 1000) WHERE org_id = $1', [o.orgId]);
      return rows.map((r) => r.connection_id);
    };
    expect(await due()).toEqual([active.connectionId]);
    await admin((c) => c.query('DELETE FROM crove_kernel.tenant_member WHERE org_id = $1 AND user_id = $2', [o.orgId, o.member]));
    expect(await due()).toEqual([]);
    // A worker cannot read the credential of a member who left.
    await expect(o.sysQuery('kernel.calendar.credential', { connectionId: active.connectionId })).rejects.toMatchObject({ code: 'CALENDAR_OWNER_LEFT' });
    // No login role but the worker may list them.
    await expect(appPool.query('SELECT * FROM crove_kernel.calendar_sync_due(NULL, NULL, 10)')).rejects.toThrow();
  });
});
