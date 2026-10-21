// Finding a person's data under the PDPL (issue #923), on PostgreSQL 17: an owner or admin looks up an email address,
// a phone number in any common spelling, or a tax code, and gets every matching row of the org with what an erasure
// would do to it; another org's rows never show; members cannot search; a value that is none of these is refused.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import type { PersonalDataResult } from '@crove/kernel-contract';
import { Runtime } from '@crove/kernel-runtime';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('finding a person in the org (#923)', () => {
  const dbName = `crove_test_pdpl_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  let org = { orgId: '', owner: '', member: '' };
  let other = { orgId: '', owner: '' };
  let person = '';

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  const identity = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@pdpl.test`, name: null });
  const find = (value: string, user = org.owner, orgId = org.orgId) =>
    rt.query<PersonalDataResult>('kernel.personal_data.find', { value }, { actor: asUser(user), orgId });
  const columns = (result: PersonalDataResult) => result.matches.map((m) => m.column).sort();

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
    rt = new Runtime(db).register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) });

    const owner = await identity('owner');
    org = { orgId: (await createOrg(rt, asUser(owner), `Org ${randomUUID().slice(0, 6)}`)).orgId, owner, member: await identity('member') };
    await admin((c) => c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')`, [org.orgId, org.member]));
    const otherOwner = await identity('other');
    other = { orgId: (await createOrg(rt, asUser(otherOwner), `Other ${randomUUID().slice(0, 6)}`)).orgId, owner: otherOwner };

    // A person among the org's parties, a mail sent to them, the org's contact; and the same person in another org.
    for (const orgId of [org.orgId, other.orgId]) {
      const { rows } = await admin((c) =>
        c.query<{ id: string }>(
          `INSERT INTO crove_kernel.party (org_id, kind, name, tax_code, email, phone)
           VALUES ($1, 'person', 'Nguyễn Văn Mẫu', '0101234564', 'Mau.Nguyen@example.vn', '+84 912 345 678') RETURNING id`,
          [orgId],
        ),
      );
      if (orgId === org.orgId) person = String(rows[0]?.id);
      await admin((c) =>
        c.query(
          `INSERT INTO crove_kernel.mail_message (org_id, stream, source, template_key, to_address, to_hash, message_id_header, status)
           VALUES ($1, 'transactional', 'social.report_schedule.run', 'social.report', 'mau.nguyen@example.vn', $2, $3, 'queued')`,
          [orgId, 'a'.repeat(63) + '0', `<pdpl-${randomUUID()}@test>`],
        ),
      );
    }
    await admin((c) => c.query(`UPDATE crove_kernel.tenant SET contact_email = 'mau.nguyen@example.vn' WHERE org_id = $1`, [org.orgId]));
  });

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('finds an email address in every column that holds one, case aside, with what an erasure does', async () => {
    const result = await find(' mau.nguyen@EXAMPLE.vn ');
    expect(result.kind).toBe('email');
    expect(columns(result)).toEqual(['crove_kernel.mail_message.to_address', 'crove_kernel.party.email', 'crove_kernel.tenant.contact_email']);
    const party = result.matches.find((m) => m.column === 'crove_kernel.party.email');
    expect(party).toMatchObject({ handling: 'erase', rowId: person, row: { name: 'Nguyễn Văn Mẫu', phone: '+84 912 345 678' } });
    // Only this org's rows.
    expect(result.matches.every((m) => m.row.org_id === org.orgId)).toBe(true);
    expect(result.truncated).toBe(false);
  });

  it('finds a phone number however it is spelled, and a tax code', async () => {
    for (const phone of ['0912345678', '0912.345.678', '+84 912 345 678', '84912345678', '(091) 234 5678']) {
      expect(columns(await find(phone)), phone).toContain('crove_kernel.party.phone');
    }
    const byCode = await find('0101234564');
    expect(byCode.matches.find((m) => m.column === 'crove_kernel.party.tax_code')).toMatchObject({ handling: 'keep_legal', rowId: person });
  });

  it('is for owners and admins only, and refuses a value that is not an email, a phone or a code', async () => {
    await expect(find('mau.nguyen@example.vn', org.member)).rejects.toMatchObject({ status: 403 });
    await expect(find('Nguyễn Văn Mẫu')).rejects.toMatchObject({ code: 'PERSONAL_DATA_QUERY', status: 422 });
    expect((await find('nobody@example.vn')).matches).toEqual([]);
  });
});
