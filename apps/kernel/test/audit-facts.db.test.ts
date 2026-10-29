// Audit facts keep no classified value (#1626, plan §4.10) on PostgreSQL 17: the commands that used to write a party's
// or an org's name, tax code or address into audit_event.detail now write a marker naming the column's class, and the
// row still says which fields changed. A cleared value stays null. tenant_tax_code_requires_audit (20261103070000)
// accepts the marker for a tax code that is set and still refuses a row naming another value, or a marker for a code
// that is cleared. Their activity summaries name what happened and none of those values either (#1634). Set
// CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database. The tax codes are made up and fail the MST
// checksum (#157).
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import type { LegalEntity } from '@crove/kernel-contract';
import { Runtime } from '@crove/kernel-runtime';
import { TEST_MANIFESTS } from './manifests.ts';
import { contextToken } from './context-token.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

const ORG_TAX_CODE = '0101234564';
const ORG_TAX_CODE_2 = '0309876546';
const ENTITY_TAX_CODE = '012345678901';
const PARTY_TAX_CODE = '0312345670';
const ORG_ADDRESS = 'Số 9 Ngõ Huế, Hà Nội';
const ENTITY_NAME = 'Hộ kinh doanh Nguyễn Thị Bình';
const PARTY_NAME = 'Trần Văn Cường';
const PARTY_NAME_2 = 'Trần Văn Cường (cửa hàng)';
const PARTY_ADDRESS = 'Số 3 Phố Lò Đúc, Hà Nội';
const PARTY_EMAIL = 'cuong@audit-facts.example';
const PARTY_PHONE = '+84 24 3333 4444';
// Every classified value the commands below write somewhere, none of which may appear in an audit row.
const RAW_VALUES = [ORG_TAX_CODE, ORG_TAX_CODE_2, ENTITY_TAX_CODE, PARTY_TAX_CODE, ORG_ADDRESS, ENTITY_NAME, PARTY_NAME, PARTY_ADDRESS, PARTY_EMAIL, PARTY_PHONE, 'Cường', 'Bình'];

suite('audit facts keep no classified value (#1626)', () => {
  const dbName = `crove_test_audit_facts_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  let o: { orgId: string; owner: string; member: string };
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal2' as const, mfaAt: Math.floor(Date.now() / 1000) });

  async function connect<T>(url: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }
  const admin = <T>(fn: (client: pg.Client) => Promise<T>) => connect(adminUrl, fn);
  const person = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@facts.test`, name: null });
  const execute = <T>(name: string, input: unknown, user = o.owner) => rt.execute<T>(name, input, { actor: asUser(user), orgId: o.orgId, idempotencyKey: randomUUID() });
  const details = async (command: string) =>
    admin(async (c) =>
      (await c.query<{ detail: Record<string, unknown> }>(`SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = $2 AND outcome = 'ok' ORDER BY occurred_at, id`, [o.orgId, command])).rows.map(
        (r) => r.detail,
      ),
    );

  beforeAll(async () => {
    await connect(ADMIN as string, (c) => c.query(`CREATE DATABASE ${dbName}`));
    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    const app = new URL(adminUrl);
    app.username = 'crove_app';
    app.password = 'test-app-pw';
    appUrl = app.toString();
    pool = createPool({ connectionString: appUrl, max: 4 });
    db = createDb(pool);
    rt = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) });
    const owner = await person('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    o = { orgId, owner, member: await person('member') };
    await admin((c) => c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')`, [orgId, o.member]));
  });

  afterAll(async () => {
    await pool?.end();
    if (ADMIN) await connect(ADMIN, (c) => c.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`));
  });

  it('runs the org, legal entity and party commands and finds no classified value in any audit row', async () => {
    // The org's tax code and address: set, changed, cleared.
    await execute('kernel.org.set_tax_code', { taxCode: ORG_TAX_CODE });
    await execute('kernel.org.set_tax_code', { taxCode: ORG_TAX_CODE_2 });
    await execute('kernel.org.set_address', { address: ORG_ADDRESS });
    await execute('kernel.org.set_address', { address: null });
    // A household business as a legal entity, then renamed.
    const entity = await execute<LegalEntity>('kernel.legal_entity.create', { name: ENTITY_NAME, kind: 'household', taxCode: ENTITY_TAX_CODE, parentId: null });
    await execute('kernel.legal_entity.update', { legalEntityId: entity.id, name: `${ENTITY_NAME} 2`, kind: 'household', taxCode: ENTITY_TAX_CODE, parentId: null });
    // A person as a party: edited with every field, then marked as a duplicate of another and unmarked.
    const [party, other] = await admin(async (c) =>
      (
        await c.query<{ id: string }>(`INSERT INTO crove_kernel.party (org_id, name, source_trust) VALUES ($1, 'Khách lẻ', 'external'), ($1, $2, 'external') RETURNING id`, [
          o.orgId,
          PARTY_NAME_2,
        ])
      ).rows.map((r) => r.id),
    );
    await execute('kernel.party.update', { partyId: party, version: 1, name: PARTY_NAME, taxCode: PARTY_TAX_CODE, address: PARTY_ADDRESS, email: PARTY_EMAIL, phone: PARTY_PHONE }, o.member);
    await execute('kernel.party.mark_duplicate', { partyId: other, keepId: party });
    await execute('kernel.party.unmark_duplicate', { partyId: other });
    await execute('kernel.party.link_for_tax_code', { taxCode: PARTY_TAX_CODE }, o.member);

    expect(await details('kernel.org.set_tax_code')).toEqual([
      { previous: null, taxCode: { redacted: 'national_id_if_individual' }, changed: true },
      { previous: { redacted: 'national_id_if_individual' }, taxCode: { redacted: 'national_id_if_individual' }, changed: true },
    ]);
    expect(await details('kernel.org.set_address')).toEqual([
      { previous: null, address: { redacted: 'contact' }, changed: true },
      { previous: { redacted: 'contact' }, address: null, changed: true },
    ]);
    expect(await details('kernel.legal_entity.create')).toEqual([
      expect.objectContaining({ legalEntityId: entity.id, entity: { name: { redacted: 'pii' }, kind: 'household', taxCode: { redacted: 'national_id_if_individual' }, parentId: null } }),
    ]);
    expect(await details('kernel.legal_entity.update')).toEqual([
      expect.objectContaining({ changed: ['name'], previous: { name: { redacted: 'pii' } }, values: { name: { redacted: 'pii' } } }),
    ]);
    expect(await details('kernel.party.update')).toEqual([
      expect.objectContaining({
        partyId: party,
        changed: ['name', 'taxCode', 'address', 'email', 'phone'],
        previous: { name: { redacted: 'pii' }, taxCode: null, address: null },
        next: { name: { redacted: 'pii' }, taxCode: { redacted: 'national_id_if_individual' }, address: { redacted: 'contact' } },
      }),
    ]);
    for (const command of ['kernel.party.mark_duplicate', 'kernel.party.unmark_duplicate']) {
      expect(await details(command)).toEqual([expect.objectContaining({ partyId: other, keepId: party, name: { redacted: 'pii' }, keepName: { redacted: 'pii' } })]);
    }
    expect(await details('kernel.party.link_for_tax_code')).toEqual([expect.objectContaining({ taxCode: { redacted: 'national_id_if_individual' } })]);

    // Not one value in any row of the org, whatever the command.
    const all = await admin(async (c) => (await c.query<{ detail: unknown }>('SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1', [o.orgId])).rows);
    const text = JSON.stringify(all);
    for (const value of RAW_VALUES) expect(text, value).not.toContain(value);
    // Nor in any activity summary of the org (#1634): the timeline names what happened, the record shows the values.
    const summaries = await admin(async (c) => (await c.query<{ summary: string }>('SELECT summary FROM crove_kernel.activity WHERE org_id = $1', [o.orgId])).rows);
    expect(summaries.length).toBeGreaterThan(0);
    for (const value of RAW_VALUES) expect(JSON.stringify(summaries), value).not.toContain(value);
    // The values themselves were stored where they belong.
    const stored = await admin(async (c) => (await c.query('SELECT tax_code, address FROM crove_kernel.tenant WHERE org_id = $1', [o.orgId])).rows[0]);
    expect(stored).toEqual({ tax_code: ORG_TAX_CODE_2, address: null });
  });

  it('keeps the tax code guard: the marker counts for a code that is set, never for another value or a cleared code', async () => {
    const owner = await person('guard-owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Guard ${randomUUID().slice(0, 6)}`);
    const commit = (detail: unknown, code: string | null) =>
      connect(appUrl, async (c) => {
        await c.query('BEGIN');
        try {
          await c.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [orgId, contextToken(owner, orgId)]);
          await c.query(
            `INSERT INTO crove_kernel.audit_event (org_id, actor_type, actor_id, command, command_id, outcome, input_sha256, detail)
             VALUES ($1, 'user', $2, 'kernel.org.set_tax_code', gen_random_uuid(), 'ok', repeat('0', 64), $3::jsonb)`,
            [orgId, owner, JSON.stringify(detail)],
          );
          await c.query('UPDATE crove_kernel.tenant SET tax_code = $2 WHERE org_id = $1', [orgId, code]);
          await c.query('COMMIT');
        } catch (error) {
          await c.query('ROLLBACK').catch(() => {});
          throw error;
        }
      });
    const marker = { redacted: 'national_id_if_individual' };
    const current = () => admin(async (c) => (await c.query<{ tax_code: string | null }>('SELECT tax_code FROM crove_kernel.tenant WHERE org_id = $1', [orgId])).rows[0]?.tax_code);

    // Another class's marker, or an empty one, does not count.
    await expect(commit({ previous: null, taxCode: { redacted: 'pii' } }, ORG_TAX_CODE)).rejects.toThrow(/TAX_CODE_UNAUDITED/);
    await expect(commit({ previous: null, taxCode: {} }, ORG_TAX_CODE)).rejects.toThrow(/TAX_CODE_UNAUDITED/);
    await commit({ previous: null, taxCode: marker }, ORG_TAX_CODE);
    expect(await current()).toBe(ORG_TAX_CODE);
    // A row naming another value is still refused, and so is the marker for a code that is cleared.
    await expect(commit({ previous: marker, taxCode: ORG_TAX_CODE }, ORG_TAX_CODE_2)).rejects.toThrow(/TAX_CODE_UNAUDITED/);
    await expect(commit({ previous: marker, taxCode: marker }, null)).rejects.toThrow(/TAX_CODE_UNAUDITED/);
    await commit({ previous: marker, taxCode: null }, null);
    expect(await current()).toBeNull();
  });
});
