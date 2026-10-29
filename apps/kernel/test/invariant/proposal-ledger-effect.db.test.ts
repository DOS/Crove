// An approved ledger proposal moves to 'executed' only with its command's effect posted in the same transaction (#1842,
// option 3 of #1840) on PostgreSQL 17, as the real login role: besides the ok audit row of its command (#1816), a
// journal entry tied to the proposal through that command's path, posted in this transaction (journal_entry.
// created_xact_id). A session with raw SQL that writes the audit row itself and marks the proposal executed with nothing
// posted is refused, and so is an entry for another proposal or one posted by an earlier transaction. The entry of the
// reversal path (source kernel.proposal) and of the journal voucher path (a voucher naming the proposal) let the move
// pass. A command that is not a ledger command needs no effect, and the move keeps the command as approved, in the system
// context too. crove_finance.ledger_effect_recorded answers for the org of the context only. Part of the invariant suite:
// keep it self-contained (package code under test, no helpers from outside test/invariant/). Set CROVE_TEST_ADMIN_URL to
// a superuser URL; the run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';
import { contextToken } from './fixtures/context-token.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const REFUSED = { code: '23514', message: 'PROPOSAL_STATUS_TRANSITION' };
const LINES = JSON.stringify([
  { line_no: 1, account_code: '6422', debit: '100000', credit: '0' },
  { line_no: 2, account_code: '331', debit: '0', credit: '100000' },
]);
const MIRRORED = JSON.stringify([
  { line_no: 1, account_code: '6422', debit: '0', credit: '100000' },
  { line_no: 2, account_code: '331', debit: '100000', credit: '0' },
]);
const suite = ADMIN ? describe : describe.skip;

suite('ledger proposals executed only with their effect (#1842)', () => {
  const dbName = `crove_test_ledger_effect_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let workerUrl = '';
  let pool: pg.Pool;
  let owner = '';
  let orgId = '';
  let otherOrg = '';

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  // One transaction as crove_app in the owner's context; committed when commit is set, else rolled back.
  async function asOwner<T>(fn: (c: pg.Client) => Promise<T>, commit = false): Promise<{ ok: true; value: T } | { ok: false; code: string | undefined; message: string }> {
    const c = new pg.Client({ connectionString: appUrl });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [orgId, contextToken(owner, orgId)]);
      const value = await fn(c);
      await c.query(commit ? 'COMMIT' : 'ROLLBACK');
      return { ok: true, value };
    } catch (error) {
      const e = error as { code?: string; message: string };
      await c.query('ROLLBACK').catch(() => {});
      return { ok: false, code: e.code, message: e.message };
    } finally {
      await c.end();
    }
  }

  // An approved proposal of the given command, written by the database owner (staff are not checked).
  const approved = (command: string) =>
    admin(
      async (c) =>
        (
          await c.query<{ id: string }>(
            `INSERT INTO crove_kernel.proposal (org_id, kind, command, status, title, payload, eligible_approvers, authors, decided_by, decided_at, executed_command_id)
             VALUES ($1, 'test.ledger', $2, 'approved', 'T1842', '{"n": 1}', ARRAY[$3::uuid], '[]', $3, now(), gen_random_uuid()) RETURNING id`,
            [orgId, command, owner],
          )
        ).rows[0]?.id as string,
    );

  // The ok audit row the runtime writes when the command ran for the proposal; audit_event_stamp sets actor and time.
  const ran = (command: string, proposalId: string) => (c: pg.Client) =>
    c.query(
      `INSERT INTO crove_kernel.audit_event (org_id, actor_type, command, command_id, outcome, input_sha256, proposal_id)
       VALUES ($1, 'user', $2, gen_random_uuid(), 'ok', repeat('0', 64), $3)`,
      [orgId, command, proposalId],
    );
  // A journal entry of the given source, posted in the caller's transaction.
  const post = (sourceType: string, sourceId: string) => (c: pg.Client) =>
    c.query(`SELECT crove_finance.post_journal_entry('2026-10-15'::date, 'ledger effect', $1, $2::uuid, $3::jsonb)`, [sourceType, sourceId, LINES]);
  // An entry, then its reversal ordered by the proposal: the path of finance.journal.reverse (source kernel.proposal,
  // reverses_entry_id set, the lines mirrored, as the database checks).
  const reverse = (proposalId: string) => async (c: pg.Client) => {
    const { rows } = await c.query<{ id: string }>(
      `SELECT crove_finance.post_journal_entry('2026-10-15'::date, 'ledger effect', 'test.original', $1::uuid, $2::jsonb) AS id`,
      [randomUUID(), LINES],
    );
    await c.query(`SELECT crove_finance.post_journal_entry('2026-10-15'::date, 'ledger effect', 'kernel.proposal', $1::uuid, $2::jsonb, $3::uuid, 1)`, [
      proposalId,
      MIRRORED,
      rows[0]?.id,
    ]);
  };
  // A journal voucher naming the proposal, and its entry: the path of finance.journal_voucher.record.
  const voucher = (proposalId: string) => async (c: pg.Client) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO crove_finance.journal_voucher (org_id, voucher_date, description, proposal_id) VALUES ($1, '2026-10-15', 'ledger effect', $2) RETURNING id`,
      [orgId, proposalId],
    );
    await post('finance.journal_voucher', rows[0]?.id as string)(c);
  };
  const execute = (proposalId: string) => (c: pg.Client) =>
    c.query(`UPDATE crove_kernel.proposal SET status = 'executed', result = '{"ok": true}' WHERE org_id = $1 AND id = $2`, [orgId, proposalId]);

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
    appUrl = url.toString();
    const worker = new URL(adminUrl);
    worker.username = 'crove_worker';
    worker.password = 'test-worker-pw';
    workerUrl = worker.toString();
    pool = createPool({ connectionString: appUrl, max: 2 });
    const db = createDb(pool);
    const rt = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) });
    owner = await upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: 'owner@ledger-effect.test', name: null });
    ({ orgId } = await createOrg(rt, { type: 'user', userId: owner, aal: 'aal1' }, 'Sổ cái có hiệu lực'));
    ({ orgId: otherOrg } = await createOrg(rt, { type: 'user', userId: owner, aal: 'aal1' }, 'Tổ chức khác'));
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('refuses to mark a ledger proposal executed with its audit row alone, nothing posted', async () => {
    for (const command of ['finance.journal.reverse', 'finance.journal_voucher.record', 'finance.voucher.record', 'finance.purchase.record', 'finance.closing.record', 'finance.depreciation.record']) {
      const id = await approved(command);
      const outcome = await asOwner(async (c) => {
        await ran(command, id)(c);
        return execute(id)(c);
      });
      expect(outcome, command).toMatchObject({ ok: false, ...REFUSED });
    }
  });

  it("passes with the command's own entry posted in the same transaction, on the reversal and the journal voucher paths", async () => {
    const reversal = await approved('finance.journal.reverse');
    const reversed = await asOwner(async (c) => {
      await reverse(reversal)(c);
      await ran('finance.journal.reverse', reversal)(c);
      return execute(reversal)(c);
    });
    expect(reversed).toMatchObject({ ok: true, value: { rowCount: 1 } });

    const nvk = await approved('finance.journal_voucher.record');
    const posted = await asOwner(async (c) => {
      await voucher(nvk)(c);
      await ran('finance.journal_voucher.record', nvk)(c);
      return execute(nvk)(c);
    });
    expect(posted).toMatchObject({ ok: true, value: { rowCount: 1 } });
  });

  it("refuses an entry tied to another proposal, another command's path, or one posted by an earlier transaction", async () => {
    const id = await approved('finance.journal.reverse');
    const other = await approved('finance.journal.reverse');
    const nvk = await approved('finance.journal_voucher.record');
    for (const [label, effect, proposalId, command] of [
      ['a reversal for another proposal', reverse(other), id, 'finance.journal.reverse'],
      ['an entry of source kernel.proposal that reverses nothing', post('kernel.proposal', id), id, 'finance.journal.reverse'],
      ["a journal voucher's entry for a reversal", voucher(id), id, 'finance.journal.reverse'],
      ["a reversal's entry for a journal voucher", reverse(nvk), nvk, 'finance.journal_voucher.record'],
      ['a journal voucher of another proposal', voucher(other), nvk, 'finance.journal_voucher.record'],
    ] as const) {
      const outcome = await asOwner(async (c) => {
        await effect(c);
        await ran(command, proposalId)(c);
        return execute(proposalId)(c);
      });
      expect(outcome, label).toMatchObject({ ok: false, ...REFUSED });
    }
    // The entry committed by an earlier transaction does not carry a later move.
    expect(await asOwner(reverse(id), true)).toMatchObject({ ok: true });
    const later = await asOwner(async (c) => {
      await ran('finance.journal.reverse', id)(c);
      return execute(id)(c);
    });
    expect(later).toMatchObject({ ok: false, ...REFUSED });
  });

  it('refuses a move to executed that changes the command, in the system context too', async () => {
    // The system context may change a pending proposal's command (the worker revises what it extracted); executing one
    // under another command would check the old command's row and effect, not the new one's.
    const asSystem = async (fn: (c: pg.Client) => Promise<unknown>) => {
      const c = new pg.Client({ connectionString: workerUrl });
      await c.connect();
      try {
        await c.query('BEGIN');
        await c.query('SELECT crove_kernel.enter_system_context($1::uuid)', [orgId]);
        return { ok: true, value: await fn(c) };
      } catch (error) {
        const e = error as { code?: string; message: string };
        return { ok: false, code: e.code, message: e.message };
      } finally {
        await c.query('ROLLBACK').catch(() => {});
        await c.end();
      }
    };
    const runAs = (command: string, proposalId: string) => (c: pg.Client) =>
      c.query(
        `INSERT INTO crove_kernel.audit_event (org_id, actor_type, command, command_id, outcome, input_sha256, proposal_id)
         VALUES ($1, 'system', $2, gen_random_uuid(), 'ok', repeat('0', 64), $3)`,
        [orgId, command, proposalId],
      );
    const id = await approved('t1842.other');
    const turned = await asSystem(async (c) => {
      await runAs('t1842.other', id)(c);
      return c.query(`UPDATE crove_kernel.proposal SET command = 'finance.journal.reverse', status = 'executed' WHERE org_id = $1 AND id = $2`, [orgId, id]);
    });
    expect(turned).toMatchObject({ ok: false, ...REFUSED });
    // The same move with the command kept passes: a non-ledger command needs no effect.
    const kept = await asSystem(async (c) => {
      await runAs('t1842.other', id)(c);
      return c.query(`UPDATE crove_kernel.proposal SET status = 'executed' WHERE org_id = $1 AND id = $2`, [orgId, id]);
    });
    expect(kept).toMatchObject({ ok: true, value: { rowCount: 1 } });
  });

  it('asks no effect of a command that is not a ledger command, and answers for the org of the context only', async () => {
    const answer = await asOwner(async (c) => {
      const asked = async (org: string, proposalId: string, command: string) =>
        (await c.query<{ v: boolean }>('SELECT crove_finance.ledger_effect_recorded($1::uuid, $2::uuid, $3) AS v', [org, proposalId, command])).rows[0]?.v;
      const reversal = randomUUID();
      await reverse(reversal)(c);
      return {
        notLedger: await asked(orgId, randomUUID(), 't1842.other'),
        own: await asked(orgId, reversal, 'finance.journal.reverse'),
        otherOrg: await asked(otherOrg, reversal, 'finance.journal.reverse'),
        otherOrgNotLedger: await asked(otherOrg, randomUUID(), 't1842.other'),
      };
    });
    expect(answer).toEqual({ ok: true, value: { notLedger: true, own: true, otherOrg: false, otherOrgNotLedger: false } });
  });
});
