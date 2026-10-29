// Who may mark a due done, per legal entity (issue #1917), with finance installed. kernel.org.overview answers canMark
// for each open entity of each due row from the rule the mark itself applies: owners, admins and members mark any
// obligation, and the VAT return's mark (finance.vat.return_mark, #1400) is for owners, admins and a holder of
// finance.vat.file org-wide or for that entity (#1508). kernel.tax_obligation.done and .undo apply the same rule, so a
// member who is not a filer cannot mark the VAT return through them either.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; the run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TaxDueView } from '@crove/kernel-contract';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { financeCommands, financeQueries } from '@crove/mod-finance';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));

const suite = ADMIN ? describe : describe.skip;

suite('who may mark a tax due done, per legal entity (#1917)', () => {
  const dbName = `crove_test_tax_mark_rights_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let rt: Runtime;
  let orgId = '';
  let defaultEntity = '';
  let branch = '';
  const users = { owner: '', member: '', chief: '', branchChief: '', viewer: '' };

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const exec = (user: string, command: string, input: unknown) => rt.execute(command, input, { actor: asUser(user), orgId });
  const dues = async (user: string) => (await rt.query<{ taxDues: TaxDueView[] }>('kernel.org.overview', {}, { actor: asUser(user), orgId })).taxDues;
  // Each open entity of the first due of an obligation, with whether the user may mark it there.
  const rights = async (user: string, obligation: TaxDueView['obligation']) =>
    (await dues(user)).find((d) => d.obligation === obligation)?.openEntities.map((e) => [e.id, e.canMark]);

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
    pool = createPool({ connectionString: url.toString(), max: 2 });
    const db = createDb(pool);
    rt = new Runtime(db, { manifests: TEST_MANIFESTS }).register({
      commands: [...kernelCommands, ...financeCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries],
    });
    for (const name of Object.keys(users) as Array<keyof typeof users>) {
      users[name] = await upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name.toLowerCase()}@tax-mark.test`, name: null });
    }
    ({ orgId } = await createOrg(rt, asUser(users.owner), 'Quyền đánh dấu'));
    await admin(async (c) => {
      // The VAT return monthly, and the PIT withholding return monthly from the org's tax profile.
      await c.query(`UPDATE crove_kernel.tenant SET vat_filing_period = 'month' WHERE org_id = $1`, [orgId]);
      await c.query(`INSERT INTO crove_kernel.tax_profile (org_id, obligations, pit_filing_period, updated_by) VALUES ($1, '{pit_withholding}', 'month', $2)`, [
        orgId,
        users.owner,
      ]);
      defaultEntity = (await c.query<{ id: string }>('SELECT id FROM crove_kernel.legal_entity WHERE org_id = $1 AND is_default', [orgId])).rows[0]?.id as string;
      // A branch that has existed for years, so it owes every period the calendar lists.
      branch = (
        await c.query<{ id: string }>(`INSERT INTO crove_kernel.legal_entity (org_id, name, kind, created_by, created_at) VALUES ($1, 'Chi nhánh', 'branch', $2, '2020-01-01') RETURNING id`, [
          orgId,
          users.owner,
        ])
      ).rows[0]?.id as string;
      for (const [user, role] of [
        [users.member, 'member'],
        [users.chief, 'member'],
        [users.branchChief, 'member'],
        [users.viewer, 'viewer'],
      ] as const) {
        await c.query('INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, $3)', [orgId, user, role]);
      }
      // A chief accountant of the whole org, and one of the branch alone (whose assignment narrows its scope to the branch).
      const assign = (user: string, role: string, entity: string | null) =>
        c.query('INSERT INTO crove_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by) VALUES ($1, $2, $3, $4, $5)', [
          orgId,
          user,
          role,
          entity,
          users.owner,
        ]);
      await assign(users.chief, 'finance.chief_accountant', null);
      await assign(users.branchChief, 'finance.entity_chief_accountant', branch);
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

  it('answers canMark per entity from the rule the mark applies', async () => {
    // The VAT return: owners, admins and chief accountants, a branch's chief accountant for the branch only.
    expect(await rights(users.owner, 'vat_return')).toEqual([
      [defaultEntity, true],
      [branch, true],
    ]);
    expect(await rights(users.chief, 'vat_return')).toEqual([
      [defaultEntity, true],
      [branch, true],
    ]);
    expect(await rights(users.member, 'vat_return')).toEqual([
      [defaultEntity, false],
      [branch, false],
    ]);
    expect(await rights(users.branchChief, 'vat_return')).toEqual([[branch, true]]);
    expect(await rights(users.viewer, 'vat_return')).toEqual([
      [defaultEntity, false],
      [branch, false],
    ]);
    // Any other obligation: every member, never a viewer.
    for (const user of [users.owner, users.chief, users.member]) {
      expect(await rights(user, 'pit_withholding')).toEqual([
        [defaultEntity, true],
        [branch, true],
      ]);
    }
    expect(await rights(users.branchChief, 'pit_withholding')).toEqual([[branch, true]]);
    expect(await rights(users.viewer, 'pit_withholding')).toEqual([
      [defaultEntity, false],
      [branch, false],
    ]);
  });

  it('applies the same rule in kernel.tax_obligation.done and .undo', async () => {
    const vat = (await dues(users.owner)).find((d) => d.obligation === 'vat_return');
    const pit = (await dues(users.owner)).find((d) => d.obligation === 'pit_withholding');
    expect(vat && pit).toBeTruthy();
    const vatMark = { obligation: 'vat_return', period: vat!.period };
    const pitMark = { obligation: 'pit_withholding', period: pit!.period };
    // A member who is not a filer cannot mark the VAT return through the kernel command, for either entity.
    for (const legalEntityId of [defaultEntity, branch]) {
      await expect(exec(users.member, 'kernel.tax_obligation.done', { ...vatMark, legalEntityId })).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
      await expect(exec(users.member, 'kernel.tax_obligation.undo', { ...vatMark, legalEntityId })).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
    }
    // The branch's chief accountant marks the branch's, and takes it back.
    expect(await exec(users.branchChief, 'kernel.tax_obligation.done', { ...vatMark, legalEntityId: branch })).toMatchObject({ legalEntityId: branch, done: true });
    expect(await exec(users.branchChief, 'kernel.tax_obligation.undo', { ...vatMark, legalEntityId: branch })).toMatchObject({ legalEntityId: branch, done: false });
    // The member marks any other obligation, as before.
    expect(await exec(users.member, 'kernel.tax_obligation.done', { ...pitMark, legalEntityId: branch })).toMatchObject({ legalEntityId: branch, done: true });
    expect(await exec(users.member, 'kernel.tax_obligation.undo', { ...pitMark, legalEntityId: branch })).toMatchObject({ legalEntityId: branch, done: false });
    const left = await admin((c) => c.query('SELECT 1 FROM crove_kernel.tax_obligation_done WHERE org_id = $1', [orgId]));
    expect(left.rowCount).toBe(0);
  });
});
