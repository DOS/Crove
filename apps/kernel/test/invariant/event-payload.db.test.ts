// Invariant suite (Decision 7): every event the outbox takes carries ids and codes only, whoever writes it (#1949,
// #1970, ADR-0017 section 1). An event row is append-only and the outbox archive keeps payloads as plain JSON for 400
// days, so no erasure reaches a value once it is in one. ctx.emit checks the payload in TypeScript; the database holds
// every insert into crove_kernel.outbox_event to the same rule (crove_kernel.event_payload_problem), so a definer that
// writes an event directly is held too. This file keeps the two rules in step on one corpus, shows the database
// refusing a personal value from a tenant session and taking a clean one, and pins the sign-out job's subject lookup
// to the worker login. Keep this directory self-contained: import package code under test, never helpers from outside
// test/invariant/. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime, eventPayloadProblem } from '@crove/kernel-runtime';
import { contextToken } from './fixtures/context-token.ts';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const ID = '0193a3f4-5b6c-7d8e-9f01-23456789abcd';
const ROLES = ['crove_app', 'crove_worker', 'crove_tenant', 'crove_definer_tenant', 'crove_auth_reader', 'crove_prober', 'crove_reporter'];

// Payloads either rule must judge alike: allowed ones, and one of each refusal. One problem each: with two, the rules
// may name different ones (jsonb orders keys by length), though both refuse.
const CORPUS: Array<[string, unknown]> = [
  ['kernel.proposal.created', { proposalId: ID, kind: 'finance.purchase' }],
  ['kernel.channel.expired', { connection_id: ID, provider: 'facebook', reason: 'token_expired' }],
  ['finance.bank.imported', { bankAccount: '112100001', amount: '-1250000.5000', count: 3, held: false, at: '2026-10-30T19:00:00+07:00', none: null }],
  ['social.post.submitted', { post_id: ID, variant_ids: [ID], agent_task: { title: 'Rà soát bài gửi duyệt: 2 kênh', ref: { type: 'social.post', id: ID }, tainted: false } }],
  ['crm.booking.cancelled', { booking_id: ID, agent_task: { title: 'Khách hủy lịch hẹn', ref: { type: 'crm.booking', id: ID }, tainted: true } }],
  ['social.post.created', { agent_task: { title: 'Rà soát bài gửi duyệt: 2 kênh' } }],
  ['kernel.session.revoked', { userId: ID, actor: 'auth0|abc', sessionId: ID, scope: 'local' }],
  ['kernel.test', { note: 'Nguyễn Văn A' }],
  ['kernel.test', { to: 'ketoan@example.com' }],
  ['kernel.test', { party: { phone: '0901234567' } }],
  ['kernel.test', { sellerTaxCode: '0101234564' }],
  ['kernel.test', { list: ['ok', 'two words'] }],
  ['kernel.test', { long: 'x'.repeat(201) }],
  ['kernel.test', { a: { b: { c: { d: { e: { f: { g: { h: { i: 1 } } } } } } } } }],
];

const suite = ADMIN ? describe : describe.skip;

suite('event payloads: ids and codes only, in TypeScript and in the database (#1970)', () => {
  const dbName = `crove_test_evpayload_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let workerUrl = '';
  let pool: pg.Pool;
  let runtime: Runtime;

  async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
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
    const login = (user: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = user;
      url.password = password;
      return url.toString();
    };
    appUrl = login('crove_app', 'test-app-pw');
    workerUrl = login('crove_worker', 'test-worker-pw');
    pool = createPool({ connectionString: appUrl, max: 2 });
    runtime = new Runtime(createDb(pool), { manifests: TEST_MANIFESTS }).register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('judges every payload of the corpus as the TypeScript rule does, path for path', async () => {
    const sqlProblems = await withClient(adminUrl, async (c) => {
      const out: Array<string | null> = [];
      for (const [type, payload] of CORPUS) {
        const { rows } = await c.query<{ p: string | null }>('SELECT crove_kernel.event_payload_problem($1, $2::jsonb) AS p', [type, JSON.stringify(payload)]);
        out.push(rows[0]?.p ?? null);
      }
      return out;
    });
    expect(sqlProblems).toEqual(CORPUS.map(([type, payload]) => eventPayloadProblem(payload, type)));
    // The corpus holds both outcomes, so agreement says something.
    expect(sqlProblems.filter((p) => p === null).length).toBeGreaterThanOrEqual(5);
    expect(sqlProblems.filter((p) => p !== null).length).toBeGreaterThanOrEqual(9);
  });

  // The one difference, for one release (#1980 drops it): what the previous release emits, which a rollback may bring
  // back, still passes the database while ctx.emit refuses it: its CRM cancel title and its session revoke's subject.
  it("still lets the previous release's CRM cancel title and revoke subject through the database only", async () => {
    const legacy: Array<[string, unknown, string]> = [
      ['crm.booking.cancelled', { booking_id: ID, agent_task: { title: 'Khách hủy lịch hẹn: Tư vấn thuế', ref: { type: 'crm.booking', id: ID } } }, 'payload.agent_task.title'],
      ['kernel.session.revoked', { userId: ID, subject: 'auth0|abc', sessionId: ID, scope: 'local' }, 'payload.subject'],
    ];
    for (const [type, payload, path] of legacy) {
      expect(eventPayloadProblem(payload, type)).toBe(`${path}: a string that is neither an id nor a code`);
      const sqlProblem = await withClient(adminUrl, async (c) =>
        (await c.query<{ p: string | null }>('SELECT crove_kernel.event_payload_problem($1, $2::jsonb) AS p', [type, JSON.stringify(payload)])).rows[0]?.p,
      );
      expect(sqlProblem, type).toBeNull();
    }
  });

  it('refuses a personal value from a tenant session that writes an event past ctx.emit, and takes a clean one', async () => {
    const owner = await upsertIdentity(createDb(pool), { issuer: 'test', subject: randomUUID(), email: `owner-${randomUUID().slice(0, 8)}@evpayload.test`, name: null });
    const { orgId } = await createOrg(runtime, { type: 'user', userId: owner, aal: 'aal1', sessionId: randomUUID() }, 'Event payloads');
    const emit = (payload: unknown) =>
      withClient(appUrl, async (c) => {
        await c.query('BEGIN');
        try {
          await c.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [orgId, contextToken(owner, orgId)]);
          await c.query('SELECT crove_kernel.emit($1, $2::jsonb, $3::uuid)', ['kernel.test', JSON.stringify(payload), randomUUID()]);
          return null;
        } catch (error) {
          return error as { code?: string; message?: string; detail?: string };
        } finally {
          await c.query('ROLLBACK');
        }
      });
    expect(await emit({ note: 'Nguyễn Văn A' })).toMatchObject({ code: '23514', message: 'EVENT_PAYLOAD_NOT_ALLOWED', detail: 'kernel.test: payload.note: a string that is neither an id nor a code' });
    expect(await emit({ party: { email: 'x' } })).toMatchObject({ code: '23514', message: 'EVENT_PAYLOAD_NOT_ALLOWED' });
    // The refusal names the path, never the value.
    expect(JSON.stringify(await emit({ note: 'Nguyễn Văn A' }))).not.toContain('Nguyễn');
    expect(await emit({ proposalId: ID, kind: 'finance.purchase' })).toBeNull();
  });

  it('lets only the worker login role read an account subject, through a pinned definer that refuses any other session', async () => {
    const fn = 'crove_kernel.user_auth_subject(uuid)';
    const { matrix, shape } = await withClient(adminUrl, async (c) => {
      const { rows } = await c.query<{ role: string }>(
        `SELECT r AS role FROM unnest($1::text[]) r WHERE has_function_privilege(r, $2::regprocedure, 'EXECUTE') ORDER BY 1`,
        [ROLES, fn],
      );
      const { rows: defs } = await c.query<{ definer: boolean; config: string[] }>('SELECT p.prosecdef AS definer, p.proconfig AS config FROM pg_proc p WHERE p.oid = $1::regprocedure', [fn]);
      return { matrix: rows, shape: defs };
    });
    expect(matrix).toEqual([{ role: 'crove_worker' }]);
    expect(shape).toEqual([{ definer: true, config: ['search_path=pg_catalog, pg_temp'] }]);
    const subject = randomUUID();
    const user = await upsertIdentity(createDb(pool), { issuer: 'test', subject, email: `subject-${randomUUID().slice(0, 8)}@evpayload.test`, name: null });
    await expect(withClient(workerUrl, async (c) => (await c.query<{ s: string }>('SELECT crove_kernel.user_auth_subject($1) AS s', [user])).rows[0]?.s)).resolves.toBe(subject);
    await expect(withClient(appUrl, (c) => c.query('SELECT crove_kernel.user_auth_subject($1)', [user]))).rejects.toThrow(/permission denied for function user_auth_subject/);
    // The session_user check holds on its own: with EXECUTE granted to crove_app (rolled back), it is refused.
    await withClient(adminUrl, async (c) => {
      await c.query('BEGIN');
      try {
        await c.query(`GRANT EXECUTE ON FUNCTION ${fn} TO crove_app`);
        await c.query('SET SESSION AUTHORIZATION crove_app');
        await expect(c.query('SELECT crove_kernel.user_auth_subject($1)', [user])).rejects.toMatchObject({ code: '42501', message: 'USER_SUBJECT_WORKER_ONLY' });
      } finally {
        await c.query('ROLLBACK');
      }
    });
  });
});
