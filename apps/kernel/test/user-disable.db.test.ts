// The operator's user-disable and user-enable roles on PostgreSQL 17 (issue #985): an account found by id or email is
// blocked and unblocked, each of its orgs gets an audit row with the reason and without the email, a repeated run is
// noted as unchanged, and an unknown or ambiguous account changes nothing. Who may run it is in
// test/invariant/user-disable.db.test.ts. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { runUserDisable, setUserDisabled } from '../src/user-disable.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('user disable and enable on PostgreSQL (#985)', () => {
  const dbName = `crove_test_userdis_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  let workerPool: pg.Pool;
  let worker: Runtime;
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

  const person = (email: string, issuer = 'test') => upsertIdentity(db, { issuer, subject: randomUUID(), email, name: null });
  const disabledAt = (userId: string) =>
    admin(async (c) => (await c.query<{ disabled_at: Date | null }>('SELECT disabled_at FROM crove_kernel.user_account WHERE id = $1', [userId])).rows[0]?.disabled_at);
  const notes = (userId: string) =>
    admin(async (c) =>
      (
        await c.query<{ org_id: string; actor_type: string; outcome: string; target_type: string; detail: Record<string, unknown> }>(
          `SELECT org_id, actor_type, outcome, target_type, detail FROM crove_kernel.audit_event
           WHERE command = 'kernel.user.status_note' AND target_id = $1 ORDER BY occurred_at, id`,
          [userId],
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
    const app = new URL(adminUrl);
    app.username = 'crove_app';
    app.password = 'test-app-pw';
    pool = createPool({ connectionString: app.toString(), max: 2 });
    db = createDb(pool);
    const registry = { commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) };
    rt = new Runtime(db).register(registry);
    const asWorker = new URL(adminUrl);
    asWorker.username = 'crove_worker';
    asWorker.password = 'test-worker-pw';
    workerPool = createPool({ connectionString: asWorker.toString(), max: 2 });
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

  it('blocks an account by email, notes it in each of its orgs, and unblocks it by id', async () => {
    const email = `Spammer-${randomUUID().slice(0, 8)}@Disable.test`;
    const userId = await person(email);
    const { orgId: a } = await createOrg(rt, asUser(userId), 'Org A');
    const { orgId: b } = await createOrg(rt, asUser(userId), 'Org B');

    const disabled = await setUserDisabled(worker, true, { ref: email.toLowerCase(), reason: 'Gửi hóa đơn rác hàng loạt' });
    expect(disabled).toMatchObject({ userId, changed: true, orgs: 2 });
    expect(await disabledAt(userId)).toBeInstanceOf(Date);
    const disabledNotes = await notes(userId);
    expect(disabledNotes.map((n) => n.org_id).sort()).toEqual([a, b].sort());
    for (const note of disabledNotes) {
      expect(note).toMatchObject({ actor_type: 'system', outcome: 'ok', target_type: 'kernel.user' });
      expect(note.detail).toMatchObject({ disabled: true, changed: true, reason: 'Gửi hóa đơn rác hàng loạt' });
      expect(JSON.stringify(note.detail).toLowerCase()).not.toContain(email.toLowerCase());
    }

    // Again: nothing changes, and the run is noted as unchanged.
    expect(await setUserDisabled(worker, true, { ref: email, reason: 'Chạy lại' })).toMatchObject({ changed: false, orgs: 2 });
    expect((await notes(userId)).slice(2).map((n) => n.detail)).toEqual([
      expect.objectContaining({ disabled: true, changed: false }),
      expect.objectContaining({ disabled: true, changed: false }),
    ]);

    expect(await setUserDisabled(worker, false, { ref: userId, reason: 'Đã xác minh' })).toMatchObject({ changed: true });
    expect(await disabledAt(userId)).toBeNull();
    expect((await notes(userId)).slice(4).map((n) => n.detail)).toEqual([
      expect.objectContaining({ disabled: false, changed: true }),
      expect.objectContaining({ disabled: false, changed: true }),
    ]);
  });

  it('blocks an account with no org, and changes nothing for an unknown or shared email', async () => {
    const lonely = await person(`lonely-${randomUUID().slice(0, 8)}@disable.test`);
    expect(await setUserDisabled(worker, true, { ref: lonely, reason: 'Không thuộc tổ chức nào' })).toMatchObject({ changed: true, orgs: 0 });

    const shared = `shared-${randomUUID().slice(0, 8)}@disable.test`;
    const first = await person(shared, 'issuer-a');
    await person(shared, 'issuer-b');
    await expect(setUserDisabled(worker, true, { ref: shared, reason: 'x' })).rejects.toThrow(/several accounts share this email/);
    await expect(setUserDisabled(worker, true, { ref: 'nobody@disable.test', reason: 'x' })).rejects.toThrow(/no account has this id or email/);
    expect(await disabledAt(first)).toBeNull();

    // Through the role's entry point: one line on stderr and exit code 2.
    const errors: string[] = [];
    expect(await runUserDisable({ runtime: worker, log: () => {}, error: (l) => errors.push(l) }, true, [shared, '--reason', 'x'])).toBe(2);
    expect(errors).toEqual(['[user-disable] several accounts share this email; name the account id instead']);
    const lines: string[] = [];
    expect(await runUserDisable({ runtime: worker, log: (l) => lines.push(l) }, true, [first, '--reason', 'Lạm dụng'])).toBe(0);
    expect(lines).toEqual([`[user-disable] account ${first} is now disabled; noted in 0 org(s)`]);
  });
});
