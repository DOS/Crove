// Links of parties to legal entities (#1280 part 3b, plan §4.6, coordinator decision (b)) on PostgreSQL 17: a member
// limited to one entity gets its own new parties linked to it, writes no link itself, and finds a company the org
// already knows by its tax code (linked into its own scope only), but never a person's party; agent and system contexts
// may not use that lookup; a proposal carries its extraction's entity. The policy that limits what such a member sees
// of parties waits; proposals are scoped by le_scope since #1538. Part of the invariant suite; it imports package
// code under test, never helpers from outside test/invariant/. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run
// makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime, type AgentActor } from '@crove/kernel-runtime';
import { financeCommands, financeQueries } from '@crove/mod-finance';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';
import { contextToken } from './fixtures/context-token.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const TEMPLATE = 'finance.chief_accountant';
const SYSTEM = { type: 'system' as const, component: 'kernel.agent' };
const COMPANY_TAX = '0101234567';
const PERSON_TAX = '012345678901';
const suite = ADMIN ? describe : describe.skip;

suite('parties scoped by record_le on PostgreSQL (#1280)', () => {
  const dbName = `crove_test_record_le_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let workerUrl = '';
  const pools: pg.Pool[] = [];
  let db: Db;
  let app: Runtime;
  let worker: Runtime;
  let owner = '';
  let accountant = '';
  let orgId = '';
  let defaultEntity = '';
  let branch = '';
  const parties = { company: randomUUID(), person: randomUUID(), linkedDefault: randomUUID() };
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

  // Runs fn as a login role in a context, always rolled back.
  async function inContext<T>(url: string, enter: (c: pg.Client) => Promise<unknown>, fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    try {
      await c.query('BEGIN');
      await enter(c);
      return await fn(c);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      await c.end();
    }
  }
  const asMember = <T>(userId: string, fn: (c: pg.Client) => Promise<T>) =>
    inContext(appUrl, (c) => c.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [orgId, contextToken(userId, orgId)]), fn);
  const linksOf = (partyId: string) =>
    admin((c) =>
      c.query<{ legal_entity_id: string }>(`SELECT legal_entity_id FROM crove_kernel.record_le WHERE org_id = $1 AND record_type = 'kernel.party' AND record_id = $2`, [orgId, partyId]),
    ).then((r) => r.rows.map((row) => row.legal_entity_id));

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
    const login = (username: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = username;
      url.password = password;
      return url.toString();
    };
    appUrl = login('crove_app', 'test-app-pw');
    workerUrl = login('crove_worker', 'test-worker-pw');
    const runtimeFor = (url: string) => {
      const pool = createPool({ connectionString: url, max: 4 });
      pools.push(pool);
      const target = createDb(pool);
      return { db: target, runtime: new Runtime(target, { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands, ...financeCommands], queries: [...kernelQueries({ inboundDomain: 'in.test' }), ...financeQueries] }) };
    };
    const api = runtimeFor(appUrl);
    db = api.db;
    app = api.runtime;
    worker = runtimeFor(workerUrl).runtime;
    owner = await upsertIdentity(db, { issuer: 'record-le', subject: 'owner', email: 'owner@record-le.test', name: null });
    accountant = await upsertIdentity(db, { issuer: 'record-le', subject: 'accountant', email: 'accountant@record-le.test', name: null });
    orgId = (await createOrg(app, asUser(owner), 'Hai pháp nhân')).orgId;
    await admin(async (c) => {
      defaultEntity = (await c.query<{ id: string }>('SELECT id FROM crove_kernel.legal_entity WHERE org_id = $1 AND is_default', [orgId])).rows[0]?.id as string;
      branch = (await c.query<{ id: string }>(`INSERT INTO crove_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhánh', 'branch', $2) RETURNING id`, [orgId, owner]))
        .rows[0]?.id as string;
      // The accountant keeps the branch's books only.
      await c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')`, [orgId, accountant]);
      await c.query(`INSERT INTO crove_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by) VALUES ($1, $2, 'external_accountant', $3, $4)`, [
        orgId,
        accountant,
        branch,
        owner,
      ]);
      // A company and a person the org already knows (no link), and a company linked to the default entity.
      await c.query(
        `INSERT INTO crove_kernel.party (org_id, id, kind, name, tax_code) VALUES ($1, $2, 'organization', 'Công ty Đã Biết', $3), ($1, $4, 'person', 'Nguyễn Văn A', $5), ($1, $6, 'organization', 'Công ty Mặc Định', NULL)`,
        [orgId, parties.company, COMPANY_TAX, parties.person, PERSON_TAX, parties.linkedDefault],
      );
      await c.query(`INSERT INTO crove_kernel.record_le (org_id, record_type, record_id, legal_entity_id) VALUES ($1, 'kernel.party', $2, $3)`, [orgId, parties.linkedDefault, defaultEntity]);
    });
  }, 300_000);

  afterAll(async () => {
    for (const pool of pools) await pool.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('reads only the links of its own entities', async () => {
    const links = await asMember(accountant, (c) => c.query<{ record_id: string }>('SELECT record_id FROM crove_kernel.record_le'));
    expect(links.rows).toEqual([]);
    const all = await asMember(owner, (c) => c.query<{ record_id: string }>('SELECT record_id FROM crove_kernel.record_le'));
    expect(all.rows).toEqual([{ record_id: parties.linkedDefault }]);
  });

  it('links a party the member creates to its branch, and an owner creates no link', async () => {
    const id = randomUUID();
    const links = await asMember(accountant, async (c) => {
      await c.query(`INSERT INTO crove_kernel.party (org_id, id, kind, name) VALUES ($1, $2, 'organization', 'Nhà cung cấp mới')`, [orgId, id]);
      return (await c.query<{ legal_entity_id: string }>('SELECT legal_entity_id FROM crove_kernel.record_le WHERE record_id = $1', [id])).rows.map((r) => r.legal_entity_id);
    });
    expect(links).toEqual([branch]);
    const ownerLinks = await asMember(owner, async (c) => {
      await c.query(`INSERT INTO crove_kernel.party (org_id, id, kind, name) VALUES ($1, $2, 'organization', 'Nhà cung cấp của chủ')`, [orgId, id]);
      return (await c.query('SELECT 1 FROM crove_kernel.record_le WHERE record_id = $1', [id])).rowCount;
    });
    expect(ownerLinks).toBe(0);
  });

  it('lets a member limited to a branch write no link, into its own entity or another', async () => {
    const insert = `INSERT INTO crove_kernel.record_le (org_id, record_type, record_id, legal_entity_id) VALUES ($1, 'kernel.party', $2, $3)`;
    await expect(asMember(accountant, (c) => c.query(insert, [orgId, parties.company, branch]))).rejects.toThrow(/row-level security/);
    await expect(asMember(accountant, (c) => c.query(insert, [orgId, parties.company, defaultEntity]))).rejects.toThrow(/row-level security/);
    expect((await asMember(accountant, (c) => c.query('DELETE FROM crove_kernel.record_le'))).rowCount).toBe(0);
  });

  it("finds a company by its tax code and links it into the member's own scope only", async () => {
    const result = await asMember(accountant, async (c) => {
      const found = await c.query<{ party_id: string; linked: string[] }>('SELECT party_id, linked FROM crove_kernel.party_link_for_tax_code($1)', [COMPANY_TAX]);
      const links = await c.query<{ legal_entity_id: string }>('SELECT legal_entity_id FROM crove_kernel.record_le WHERE record_id = $1', [parties.company]);
      return { found: found.rows, links: links.rows.map((r) => r.legal_entity_id) };
    });
    expect(result).toEqual({ found: [{ party_id: parties.company, linked: [branch] }], links: [branch] });
    // Rolled back: nothing stays linked.
    expect(await linksOf(parties.company)).toEqual([]);
    // An unknown tax code finds nothing; a caller who sees every party needs no link.
    expect((await asMember(accountant, (c) => c.query('SELECT * FROM crove_kernel.party_link_for_tax_code($1)', ['0109999999']))).rows).toEqual([]);
    expect((await asMember(owner, (c) => c.query('SELECT * FROM crove_kernel.party_link_for_tax_code($1)', [COMPANY_TAX]))).rows).toEqual([]);
  });

  it("never links a person's party, and the refusal names nothing of it", async () => {
    const outcome = await asMember(accountant, (c) => c.query('SELECT * FROM crove_kernel.party_link_for_tax_code($1)', [PERSON_TAX])).catch((error: unknown) => error);
    expect(outcome).toMatchObject({ code: '42501', message: 'PARTY_LINK_REQUIRED' });
    expect((outcome as { detail?: string }).detail).toBeUndefined();
    expect(await linksOf(parties.person)).toEqual([]);
    await expect(app.execute('kernel.party.link_for_tax_code', { taxCode: PERSON_TAX }, { actor: asUser(accountant), orgId })).rejects.toMatchObject({
      status: 403,
      code: 'PARTY_LINK_REQUIRED',
      message: expect.not.stringContaining('Nguyễn'),
    });
  });

  it('refuses the lookup to system and agent contexts', async () => {
    const system = await inContext(
      workerUrl,
      (c) => c.query('SELECT crove_kernel.enter_system_context($1::uuid)', [orgId]),
      (c) => c.query('SELECT * FROM crove_kernel.party_link_for_tax_code($1)', [COMPANY_TAX]),
    ).catch((error: unknown) => error);
    expect(system).toMatchObject({ code: '42501' });

    const { agentId, positionId } = await app.execute<{ agentId: string; positionId: string }>('kernel.agent.template.install', { templateKey: TEMPLATE, reportsTo: null }, { actor: asMfa(owner), orgId });
    await app.execute('kernel.task.create', { title: 'Việc thử', assigneePositionId: positionId }, { actor: asUser(owner), orgId });
    const started = await worker.execute<{ runId: string | null }>('kernel.agent.run.start', { agentId }, { actor: SYSTEM, orgId });
    const actor: AgentActor = { type: 'agent', agentId, runId: started.runId as string };
    const agent = await inContext(
      workerUrl,
      (c) => c.query('SELECT crove_kernel.enter_agent_context($1::uuid, $2::uuid, $3::uuid)', [orgId, actor.agentId, actor.runId]),
      (c) => c.query('SELECT * FROM crove_kernel.party_link_for_tax_code($1)', [COMPANY_TAX]),
    ).catch((error: unknown) => error);
    expect(agent).toMatchObject({ code: '42501' });
    await expect(app.execute('kernel.party.link_for_tax_code', { taxCode: COMPANY_TAX }, { actor, orgId })).rejects.toMatchObject({ status: 403 });
    expect(await linksOf(parties.company)).toEqual([]);
  });

  it('links through audited commands: the lookup for a member, link and unlink for owners and admins only', async () => {
    expect(await app.execute('kernel.party.link_for_tax_code', { taxCode: COMPANY_TAX }, { actor: asUser(accountant), orgId })).toEqual({ partyId: parties.company });
    expect(await linksOf(parties.company)).toEqual([branch]);
    const audit = await admin((c) =>
      c.query<{ actor_id: string; detail: { partyId: string; linked: string[] } }>(
        `SELECT actor_id, detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.party.link_for_tax_code' AND outcome = 'ok'`,
        [orgId],
      ),
    );
    expect(audit.rows).toEqual([expect.objectContaining({ actor_id: accountant, detail: expect.objectContaining({ partyId: parties.company, linked: [branch] }) })]);

    const pair = { partyId: parties.person, legalEntityId: branch };
    await expect(app.execute('kernel.party.link_entity', pair, { actor: asUser(accountant), orgId })).rejects.toMatchObject({ status: 403 });
    expect(await app.execute('kernel.party.link_entity', pair, { actor: asUser(owner), orgId })).toMatchObject({ linked: true });
    expect(await linksOf(parties.person)).toEqual([branch]);
    expect(await app.execute('kernel.party.unlink_entity', pair, { actor: asUser(owner), orgId })).toMatchObject({ linked: false });
    expect(await linksOf(parties.person)).toEqual([]);
  });

  it('stamps a proposal read from a file with the entity of its extraction, and refuses another', async () => {
    const file = randomUUID();
    const extraction = randomUUID();
    const sha = randomUUID().replaceAll('-', '').padEnd(64, '0');
    const proposal = (id: string, entity: string | null) =>
      admin((c) =>
        c.query(
          `INSERT INTO crove_kernel.proposal (org_id, id, kind, command, title, payload, eligible_approvers, authors, source_file_id, extraction_id, legal_entity_id)
           VALUES ($1, $2, 'finance.purchase', 'finance.purchase.record', 'Hóa đơn', '{}', ARRAY[$3::uuid], '[]', $4, $5, $6)`,
          [orgId, id, owner, file, extraction, entity],
        ),
      );
    await admin(async (c) => {
      await c.query(
        `INSERT INTO crove_kernel.file (org_id, id, sha256, storage_key, filename, content_type, size_bytes, source) VALUES ($1, $2, $3, $4, 'hd.pdf', 'application/pdf', 10, 'upload')`,
        [orgId, file, sha, `org/${orgId}/${sha}`],
      );
      await c.query(`INSERT INTO crove_kernel.extraction (org_id, id, file_id, method, status, checks, legal_entity_id) VALUES ($1, $2, $3, 'pdf_text_ai', 'done', '[]', $4)`, [
        orgId,
        extraction,
        file,
        branch,
      ]);
    });
    const id = randomUUID();
    await proposal(id, null);
    const stamped = await admin((c) => c.query<{ legal_entity_id: string }>('SELECT legal_entity_id FROM crove_kernel.proposal WHERE org_id = $1 AND id = $2', [orgId, id]));
    expect(stamped.rows).toEqual([{ legal_entity_id: branch }]);
    await expect(proposal(randomUUID(), defaultEntity)).rejects.toThrow(/LEGAL_ENTITY_MISMATCH/);
  });
});
