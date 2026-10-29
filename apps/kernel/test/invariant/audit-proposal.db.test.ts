// An audit row that names a proposal names one of its own org, in a state the runtime writes such a row in (issue
// #1695, plan §4.10; coordinator decision option A) on a real PostgreSQL 17:
// - a tenant-role insert naming another org's proposal, or an id that does not exist, is refused, and a row aimed at
//   another org gets that same refusal whatever the org holds;
// - a row for the proposal's own command needs the proposal 'approved' (a state only the approving transaction sees),
//   so a pending, executed, rejected, failed or expired proposal is refused for it;
// - a row for another command needs 'approved' (a command the execution runs) or 'pending' (an edit's reviser), so an
//   executed, rejected, failed or expired proposal is refused for it too; a pending one passes for it (the gap left
//   for option B, #1706, written down here so a change to it is seen);
// - the runtime's own flows still pass: uploading, editing (the reviser's row names the pending proposal) and
//   approving a purchase invoice (the record's row names it approved, and so does the row of
//   kernel.party.link_for_tax_code, which the record runs for a supplier the org does not know yet);
// - staff writes are not checked, as audit_event_stamp.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; the run creates and drops its own database.
// Part of the invariant suite: CI runs this file from the base branch on protected-path PRs (AGENTS.md).
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CompiledQuery, sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createExtractApp } from '@crove/extract';
import { createExtractClient } from '@crove/extract-contract';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { DomainError, Runtime, defineCommand, fileKey, sha256Hex, type BlobStore } from '@crove/kernel-runtime';
import { extractAndPropose, financeCommands, financeQueries } from '@crove/mod-finance';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';
import { contextToken } from './fixtures/context-token.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const FIXTURE = readFileSync(new URL('./fixtures/einvoice-basic.xml', import.meta.url));
// The command every proposal in this file executes, and another command that may run under it.
const OWN = 'finance.purchase.record';
const OTHER = 'kernel.party.link_for_tax_code';
// What the record of OWN posts, as it would post it, in the transaction that marks the proposal executed: a purchase
// document naming the proposal and its journal entry (#1842 asks it of a ledger proposal's move to executed). $1 the
// org (whose first party is the seller), $2 the proposal, $3 the invoice number.
const PURCHASED = `
  WITH d AS (
    INSERT INTO crove_finance.purchase_document (org_id, party_id, invoice_number, invoice_date, subtotal, vat_amount, total, proposal_id)
    SELECT $1::uuid, p.id, $3::text, '2026-10-15', 100000, 0, 100000, $2::uuid FROM crove_kernel.party p WHERE p.org_id = $1::uuid ORDER BY p.id LIMIT 1
    RETURNING id)
  SELECT crove_finance.post_journal_entry('2026-10-15'::date, 'audit proposal', 'finance.purchase_document', d.id,
    '[{"line_no": 1, "account_code": "6422", "debit": "100000", "credit": "0"}, {"line_no": 2, "account_code": "331", "debit": "0", "credit": "100000"}]'::jsonb)
  FROM d`;
const STATUSES = ['pending', 'approved', 'executed', 'rejected', 'failed', 'expired'] as const;
type Status = (typeof STATUSES)[number];
const REFUSED = { code: '42501', message: 'AUDIT_PROPOSAL_MISMATCH' };
const suite = ADMIN ? describe : describe.skip;

const extractApp = createExtractApp({ concurrency: 2 });
const extract = createExtractClient({ url: 'http://crove-extract.test', fetch: async (input, init) => extractApp.fetch(new Request(input, init)) });

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

type Line = { lineNo: number; debitAccount: string };

suite('audit rows naming a proposal on PostgreSQL (#1695)', () => {
  const dbName = `crove_test_audit_proposal_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let workerUrl = '';
  const pools: pg.Pool[] = [];
  let db: Db;
  let runtime: Runtime;
  let workerRuntime: Runtime;
  const store = new MemoryStore();
  let invoiceNo = 5000;
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const asMfa = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal2' as const, sessionId: randomUUID(), mfaAt: Math.floor(Date.now() / 1000) });

  // Stands in for kernel.proposal.approve around a command the execution runs: it marks the proposal approved by
  // itself (as the approval does), runs `OTHER` with the proposal's id (the runtime passes it on, as to every command an
  // execution runs), writes the ok row of the proposal's own command `OWN` and the purchase it posts as its run would
  // (#1816 and #1842: the move to executed needs both) and marks it executed. With approve false it runs `OTHER` with
  // the id as the proposal stands.
  const approveNested = defineCommand({
    sideEffect: 'none',
    name: 'kernel.test_approve_nested',
    input: z.object({ proposalId: z.uuid(), approve: z.boolean() }),
    risk: 'R1',
    access: ['owner'],
    handler: async (ctx, input) => {
      if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'users only');
      // A user's context approves only through the database's gate (#1793), as kernel.proposal.approve does.
      if (input.approve) await sql`SELECT crove_kernel.proposal_approve(${input.proposalId}::uuid, 1, ${ctx.commandId}::uuid)`.execute(ctx.trx);
      await ctx.run(OTHER, { taxCode: '0101234567' }, { proposalId: input.proposalId });
      if (input.approve) {
        await sql`INSERT INTO crove_kernel.audit_event (org_id, actor_type, actor_id, command, command_id, outcome, input_sha256, proposal_id)
                  VALUES (${ctx.orgId}::uuid, 'user', ${ctx.actor.userId}::uuid, ${OWN}, gen_random_uuid(), 'ok', repeat('0', 64), ${input.proposalId}::uuid)`.execute(ctx.trx);
        await ctx.trx.executeQuery(CompiledQuery.raw(PURCHASED, [ctx.orgId, input.proposalId, randomUUID()]));
        await ctx.trx.updateTable('crove_kernel.proposal').set({ status: 'executed' }).where('org_id', '=', ctx.orgId).where('id', '=', input.proposalId).execute();
      }
      return {};
    },
  });

  async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }
  const admin = <T>(fn: (c: pg.Client) => Promise<T>) => withClient(adminUrl, fn);

  async function org() {
    const tag = randomUUID().slice(0, 8);
    const person = (name: string) => upsertIdentity(db, { issuer: 'test', subject: `${name}-${tag}`, email: `${name}-${tag}@audit-proposal.test`, name: null });
    const owner = await person('owner');
    const { orgId } = await createOrg(runtime, asUser(owner), `Đề xuất ${tag}`);
    // The seller of the purchases the hand-made executions post.
    await admin((c) => c.query(`INSERT INTO crove_kernel.party (org_id, name, source_trust) VALUES ($1, 'Người bán', 'external')`, [orgId]));
    // An admin who uploads and edits, so the owner may approve (four-eyes, P10).
    const adminUser = await person('admin');
    const email = `admin-${tag}@audit-proposal.test`;
    const { acceptPath } = await runtime.execute<{ acceptPath: string }>('kernel.member.invite.create', { email, role: 'admin' }, { actor: asMfa(owner), orgId });
    await runtime.executeOrgless('kernel.member.invite.accept', { token: acceptPath.split('#')[1] }, { actor: asUser(adminUser) });
    return { orgId, owner, admin: adminUser };
  }

  // A proposal of `OWN` in the given state, written by staff (a state the runtime leaves only inside a transaction,
  // 'approved', is written here as committed so each insert below can name it).
  async function proposal(orgId: string, approver: string, status: Status): Promise<string> {
    const id = randomUUID();
    await admin((c) =>
      c.query(
        `INSERT INTO crove_kernel.proposal (org_id, id, kind, command, status, title, payload, eligible_approvers, authors)
         VALUES ($1, $2, 'finance.purchase', $3, $4, 'Hóa đơn', '{}', ARRAY[$5::uuid], '[]')`,
        [orgId, id, OWN, status, approver],
      ),
    );
    return id;
  }

  // Inserts one audit row naming `proposalId` for `command`, as a login role in a context, and commits it.
  async function write(login: string, enter: { sql: string; params: unknown[] } | null, orgId: string, command: string, proposalId: string): Promise<void> {
    await withClient(login, async (c) => {
      await c.query('BEGIN');
      try {
        if (enter) await c.query(enter.sql, enter.params);
        await c.query(
          `INSERT INTO crove_kernel.audit_event (org_id, actor_type, actor_id, command, command_id, outcome, input_sha256, proposal_id)
           VALUES ($1, 'user', NULL, $2, gen_random_uuid(), 'ok', repeat('0', 64), $3)`,
          [orgId, command, proposalId],
        );
        await c.query('COMMIT');
      } catch (error) {
        await c.query('ROLLBACK').catch(() => {});
        throw error;
      }
    });
  }
  const userContext = (userId: string, orgId: string) => ({ sql: 'SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', params: [orgId, contextToken(userId, orgId)] });
  const systemContext = (orgId: string) => ({ sql: 'SELECT crove_kernel.enter_system_context($1::uuid)', params: [orgId] });
  const outcome = (promise: Promise<unknown>) =>
    promise.then(
      () => 'written',
      (error: unknown) => {
        const e = error as { code?: string; message?: string; detail?: string };
        return e.code === REFUSED.code && e.message === REFUSED.message && e.detail === undefined ? 'refused' : `other: ${e.code} ${e.message}`;
      },
    );
  const rowsNaming = (proposalId: string) =>
    admin(async (c) =>
      (
        await c.query<{ command: string; outcome: string }>(
          'SELECT command, outcome FROM crove_kernel.audit_event WHERE proposal_id = $1 ORDER BY command, occurred_at, id',
          [proposalId],
        )
      ).rows,
    );

  beforeAll(async () => {
    await withClient(ADMIN as string, (c) => c.query(`CREATE DATABASE ${dbName}`));
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
    appUrl = login('crove_app', 'test-app-pw');
    workerUrl = login('crove_worker', 'test-worker-pw');
    const runtimeFor = (url: string) => {
      const pool = createPool({ connectionString: url, max: 4 });
      pools.push(pool);
      const target = createDb(pool);
      return {
        db: target,
        runtime: new Runtime(target, { manifests: TEST_MANIFESTS }).register({
          commands: [...kernelCommands, ...financeCommands, approveNested],
          queries: [...kernelQueries({ inboundDomain: 'in.test' }), ...financeQueries],
        }),
      };
    };
    const api = runtimeFor(appUrl);
    db = api.db;
    runtime = api.runtime;
    workerRuntime = runtimeFor(workerUrl).runtime;
  }, 300_000);

  afterAll(async () => {
    for (const pool of pools) await pool.end();
    if (!ADMIN) return;
    await withClient(ADMIN, (c) => c.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`));
  });

  it("refuses a member's row naming another org's proposal or one that does not exist", async () => {
    const o = await org();
    const other = await org();
    const foreign = await proposal(other.orgId, other.owner, 'approved');
    for (const command of [OWN, OTHER]) {
      await expect(outcome(write(appUrl, userContext(o.owner, o.orgId), o.orgId, command, foreign))).resolves.toBe('refused');
      await expect(outcome(write(appUrl, userContext(o.owner, o.orgId), o.orgId, command, randomUUID()))).resolves.toBe('refused');
    }
    // A row aimed at the other org gets the same refusal whatever that org holds, before its policy refuses the row, so
    // the answer tells nothing of its proposals; without a context too.
    const foreignPending = await proposal(other.orgId, other.owner, 'pending');
    for (const id of [foreign, foreignPending, randomUUID()]) {
      for (const command of [OWN, OTHER]) {
        await expect(outcome(write(appUrl, userContext(o.owner, o.orgId), other.orgId, command, id))).resolves.toBe('refused');
        await expect(outcome(write(appUrl, null, other.orgId, command, id))).resolves.toBe('refused');
      }
    }
    expect(await rowsNaming(foreign)).toEqual([]);
    expect(await rowsNaming(foreignPending)).toEqual([]);
  });

  it("needs the proposal approved for its own command's row, and approved or pending for another command's", async () => {
    const o = await org();
    const seen: Record<string, Record<string, string>> = {};
    for (const status of STATUSES) {
      const id = await proposal(o.orgId, o.owner, status);
      seen[status] = {
        own: await outcome(write(appUrl, userContext(o.admin, o.orgId), o.orgId, OWN, id)),
        other: await outcome(write(appUrl, userContext(o.admin, o.orgId), o.orgId, OTHER, id)),
      };
    }
    expect(seen).toEqual({
      pending: { own: 'refused', other: 'written' },
      approved: { own: 'written', other: 'written' },
      executed: { own: 'refused', other: 'refused' },
      rejected: { own: 'refused', other: 'refused' },
      failed: { own: 'refused', other: 'refused' },
      expired: { own: 'refused', other: 'refused' },
    });
  });

  // The member below moves the proposal's status itself, as kernel.proposal.approve does in its transaction: the check
  // binds a row to the state the session's transaction sees (a status transition guard is #1707).
  it('holds in a system context too, and passes the approving transaction its own row', async () => {
    const o = await org();
    const executed = await proposal(o.orgId, o.owner, 'executed');
    await expect(outcome(write(workerUrl, systemContext(o.orgId), o.orgId, OWN, executed))).resolves.toBe('refused');
    await expect(outcome(write(workerUrl, systemContext(o.orgId), o.orgId, OTHER, executed))).resolves.toBe('refused');
    // A member's own transaction that approves the proposal, as kernel.proposal.approve does, may name it.
    const pending = await proposal(o.orgId, o.owner, 'pending');
    await expect(
      outcome(
        withClient(appUrl, async (c) => {
          await c.query('BEGIN');
          try {
            await c.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [o.orgId, contextToken(o.owner, o.orgId)]);
            // A user's context approves only through the gate (#1793).
            await c.query('SELECT crove_kernel.proposal_approve($1::uuid, 1, gen_random_uuid())', [pending]);
            await c.query(
              `INSERT INTO crove_kernel.audit_event (org_id, actor_type, actor_id, command, command_id, outcome, input_sha256, proposal_id)
               VALUES ($1, 'user', $4, $2, gen_random_uuid(), 'ok', repeat('0', 64), $3)`,
              [o.orgId, OWN, pending, o.owner],
            );
            await c.query(PURCHASED, [o.orgId, pending, randomUUID()]);
            await c.query(`UPDATE crove_kernel.proposal SET status = 'executed' WHERE org_id = $1 AND id = $2`, [o.orgId, pending]);
            await c.query('COMMIT');
          } catch (error) {
            await c.query('ROLLBACK').catch(() => {});
            throw error;
          }
        }),
      ),
    ).resolves.toBe('written');
    // Once it committed executed, nobody names it again.
    await expect(outcome(write(appUrl, userContext(o.owner, o.orgId), o.orgId, OWN, pending))).resolves.toBe('refused');
  });

  it('leaves staff rows as written', async () => {
    const o = await org();
    await expect(outcome(write(adminUrl, null, o.orgId, OWN, randomUUID()))).resolves.toBe('written');
  });

  it("keeps the runtime's upload, edit and approval of a purchase invoice", async () => {
    const o = await org();
    invoiceNo += 1;
    const bytes = new TextEncoder().encode(FIXTURE.toString('utf8').replace('<SHDon>1234</SHDon>', `<SHDon>${invoiceNo}</SHDon>`));
    const sha256 = sha256Hex(bytes);
    const storageKey = fileKey(o.orgId, sha256);
    const generation = await store.put(storageKey, bytes);
    const { fileId } = await runtime.execute<{ fileId: string }>(
      'kernel.file.ingest',
      { filename: 'hd.xml', contentType: 'application/xml', sizeBytes: bytes.byteLength, sha256, storageKey, generation, source: 'upload' },
      { actor: asUser(o.admin), orgId: o.orgId },
    );
    const { proposalId } = await extractAndPropose({ runtime: workerRuntime, store, extractor: null, extract, today: () => '2026-10-16' }, o.orgId, fileId);
    if (!proposalId) throw new Error('no proposal');
    // The edit runs the reviser with the pending proposal's id.
    const detail = await runtime.query<{ revision: number; payload: { lines: Line[] } }>('kernel.inbox.get', { id: proposalId }, { actor: asUser(o.admin), orgId: o.orgId });
    const line = detail.payload.lines[0] as Line;
    const { revision } = await runtime.execute<{ revision: number }>(
      'kernel.proposal.edit',
      { id: proposalId, revision: detail.revision, lineAccounts: [{ lineNo: line.lineNo, debitAccount: line.debitAccount === '6421' ? '6422' : '6421' }] },
      { actor: asUser(o.admin), orgId: o.orgId },
    );
    // The approval runs the record with the approved proposal's id.
    await runtime.execute('kernel.proposal.approve', { id: proposalId, revision, acceptUnverifiedSignature: true }, { actor: asMfa(o.owner), orgId: o.orgId });
    // The record finds no party with the seller's tax code in the new org, so it runs kernel.party.link_for_tax_code,
    // whose row names the approved proposal too.
    expect(await rowsNaming(proposalId)).toEqual([
      { command: OWN, outcome: 'ok' },
      { command: 'finance.purchase.revise', outcome: 'ok' },
      { command: OTHER, outcome: 'ok' },
    ]);
    const status = await admin(async (c) => (await c.query<{ status: string }>('SELECT status FROM crove_kernel.proposal WHERE id = $1', [proposalId])).rows[0]?.status);
    expect(status).toBe('executed');
  });

  it('keeps the row of a command the execution runs, and refuses it once the proposal is executed', async () => {
    const o = await org();
    const id = await proposal(o.orgId, o.owner, 'pending');
    await runtime.execute('kernel.test_approve_nested', { proposalId: id, approve: true }, { actor: asUser(o.owner), orgId: o.orgId });
    expect(await rowsNaming(id)).toEqual([
      { command: OWN, outcome: 'ok' },
      { command: OTHER, outcome: 'ok' },
    ]);
    // The same run against the executed proposal writes nothing: its nested row is refused, so the command fails.
    await expect(runtime.execute('kernel.test_approve_nested', { proposalId: id, approve: false }, { actor: asUser(o.owner), orgId: o.orgId })).rejects.toThrow();
    expect(await rowsNaming(id)).toEqual([
      { command: OWN, outcome: 'ok' },
      { command: OTHER, outcome: 'ok' },
    ]);
  });
});
