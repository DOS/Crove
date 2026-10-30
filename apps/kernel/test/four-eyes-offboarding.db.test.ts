// SPDX-License-Identifier: AGPL-3.0-only
// Four-eyes (P10) while an org is offboarding (#2064) on PostgreSQL 17. Only owners can enter an offboarding org, yet an
// admin in a pending proposal's eligible snapshot still counts toward the two eligible approvers four-eyes needs: the
// count is not narrowed to who can enter now, so a closing org's last postings keep their second pair of eyes (fail
// closed). The owner who wrote the proposal is refused FOUR_EYES_REQUIRED, the same answer from decideApproval and the
// database gate. The ways on are both audited: reject it, or demote the admin (kernel.member.change_role, whose audit
// row names the roles, #88), after which the owner is the sole eligible approver and approves it flagged
// self_approved. Set CROVE_TEST_ADMIN_URL to a superuser URL; the run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, decideApproval, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { sql } from 'kysely';
import { TEST_MANIFESTS } from './manifests.ts';
import { contextToken } from './context-token.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const LEDGER_COMMAND = 'finance.voucher.record';
const suite = ADMIN ? describe : describe.skip;

suite('four-eyes while an org is offboarding (#2064)', () => {
  const dbName = `crove_test_foureyes_off_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let pool: pg.Pool;
  let runtime: Runtime;
  let owner = '';
  let second = '';
  let orgId = '';

  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const asMfa = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal2' as const, sessionId: randomUUID(), mfaAt: Math.floor(Date.now() / 1000) });

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  // Runs fn in a user's context on the API login role, rolled back; the error's code and message when refused.
  async function asMember<T>(userId: string, fn: (c: pg.Client) => Promise<T>) {
    const c = new pg.Client({ connectionString: appUrl });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [orgId, contextToken(userId, orgId)]);
      return { ok: true as const, value: await fn(c) };
    } catch (error) {
      const e = error as { code?: string; message: string };
      return { ok: false as const, code: e.code, message: e.message };
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      await c.end();
    }
  }

  // A pending ledger proposal the owner wrote, with the owner and the admin in its eligible snapshot.
  const proposal = () =>
    admin(async (c) =>
      (
        await c.query<{ id: string }>(
          `INSERT INTO crove_kernel.proposal (org_id, kind, command, title, payload, eligible_approvers, authors)
           VALUES ($1, 't2064', $2, 'T2064', '{}', $3::uuid[], $4) RETURNING id`,
          [orgId, LEDGER_COMMAND, [owner, second], JSON.stringify([{ type: 'user', id: owner }])],
        )
      ).rows[0]?.id as string,
    );
  const gate = (id: string) => (c: pg.Client) =>
    c.query<{ d: Record<string, unknown> }>('SELECT crove_kernel.proposal_approve($1::uuid, 1, gen_random_uuid()) AS d', [id]).then((r) => r.rows[0]?.d);

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
    appUrl = app.toString();
    pool = createPool({ connectionString: appUrl, max: 2 });
    const db = createDb(pool);
    runtime = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) });
    owner = await upsertIdentity(db, { issuer: 't2064', subject: randomUUID(), email: 'owner@t2064.test', name: null });
    second = await upsertIdentity(db, { issuer: 't2064', subject: randomUUID(), email: 'admin@t2064.test', name: null });
    ({ orgId } = await createOrg(runtime, asUser(owner), 'Công ty đang đóng'));
    await admin(async (c) => {
      await c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin')`, [orgId, second]);
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query(`UPDATE crove_kernel.tenant SET status = 'offboarding' WHERE org_id = $1`, [orgId]);
      await c.query('COMMIT');
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

  it('keeps counting an admin who cannot enter the offboarding org, so the owner who wrote a proposal needs another way', async () => {
    const id = await proposal();
    // The admin cannot enter the org while it offboards; the owner can.
    await expect(asMember(second, async () => 'entered')).resolves.toMatchObject({ ok: false, code: '42501', message: 'NOT_A_MEMBER' });
    // The database gate and decideApproval agree: two eligible approvers, so the author is refused.
    await expect(asMember(owner, gate(id))).resolves.toMatchObject({ ok: false, code: '42501', message: 'FOUR_EYES_REQUIRED' });
    const decided = await createDb(pool)
      .transaction()
      .execute(async (trx) => {
        await sql`SELECT crove_kernel.enter_user_context(${orgId}::uuid, ${contextToken(owner, orgId)}::text)`.execute(trx);
        return decideApproval(
          trx,
          orgId,
          asUser(owner),
          { command: LEDGER_COMMAND, status: 'pending', eligible_approvers: [owner, second], authors: [{ type: 'user', id: owner }] },
          { lock: false },
        );
      });
    expect(decided).toMatchObject({ reason: 'four_eyes', eligibleCount: 2 });
    expect(await admin(async (c) => (await c.query<{ s: string }>('SELECT status AS s FROM crove_kernel.proposal WHERE id = $1', [id])).rows[0]?.s)).toBe('pending');

    // One way on: the owner demotes the admin, an audited R3 change; the owner is then the sole eligible approver.
    await runtime.execute('kernel.member.change_role', { userId: second, role: 'member' }, { actor: asMfa(owner), orgId });
    const audit = await admin(
      async (c) =>
        (
          await c.query<{ detail: Record<string, unknown> }>(
            `SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.member.change_role' AND outcome = 'ok'`,
            [orgId],
          )
        ).rows,
    );
    expect(audit).toEqual([{ detail: expect.objectContaining({ target_user: second, role: 'member', previous_role: 'admin' }) }]);
    await expect(asMember(owner, gate(id))).resolves.toMatchObject({ ok: true, value: { fourEyes: 'self_approved', selfApproved: true, eligibleCount: 1 } });

    // The other: an owner may always reject it.
    const other = await proposal();
    await runtime.execute('kernel.proposal.reject', { id: other, reason: 'Tổ chức đang đóng' }, { actor: asUser(owner), orgId });
    expect(await admin(async (c) => (await c.query<{ s: string }>('SELECT status AS s FROM crove_kernel.proposal WHERE id = $1', [other])).rows[0]?.s)).toBe('rejected');
  });
});
