// Source revisions of journal entries (issue #1283, ADR-0021 decision 5, red-team S32) on a real PostgreSQL 17: the
// revision rules of crove_finance.post_journal_entry() in one session. The same revision with the same payload is a
// replay that returns the posted entry and writes nothing; with another payload it is refused (IDEMPOTENCY_CONFLICT);
// a new revision follows the latest one (REVISION_OUT_OF_ORDER) and only after its reversal (SOURCE_STILL_POSTED). An
// entry posted before the payload hash existed is compared by its stored lines. Concurrent replays are in the invariant
// suite (apps/kernel/test/invariant/ledger-source-revision.db.test.ts).
// Set CROVE_TEST_ADMIN_URL to a superuser URL; the run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { sourceRevisionError } from '@crove/mod-finance';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));

type Line = { line_no: number; account_code: string; debit: string; credit: string; party_id?: string | null; memo?: string | null };
type PgError = { code?: string; message: string; detail?: string; constraint?: string };

const PARTY = randomUUID();
const SALE: Line[] = [
  { line_no: 1, account_code: '6422', debit: '100500', credit: '0', memo: 'Văn phòng phẩm' },
  { line_no: 2, account_code: '1331', debit: '10050', credit: '0' },
  { line_no: 3, account_code: '331', debit: '0', credit: '110550', party_id: PARTY, memo: 'Phải trả' },
];
const mirror = (lines: Line[]): Line[] => lines.map((l) => ({ ...l, debit: l.credit, credit: l.debit }));

interface Posting {
  date?: string;
  description?: string;
  sourceType?: string;
  sourceId: string;
  lines: Line[];
  reverses?: string | null;
  revision?: number | null;
  // The session's DateStyle, when not the server default.
  dateStyle?: string;
}

const suite = ADMIN ? describe : describe.skip;

suite('journal entry source revisions (#1283)', () => {
  const dbName = `crove_test_source_revision_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let pool: pg.Pool;
  let userId = '';
  const orgs = { a: '', b: '' };

  async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }
  const withAdmin = <T>(fn: (c: pg.Client) => Promise<T>) => withClient(adminUrl, fn);

  // Posts as the API login role in the org's context through the 7-argument signature (or the 6-argument one when the
  // revision is undefined) and commits; the error, if any, with nothing left behind.
  async function post(orgId: string, p: Posting): Promise<{ id: string } | { error: PgError }> {
    return withClient(appUrl, async (app) => {
      if (p.dateStyle) await app.query(`SELECT set_config('DateStyle', $1, false)`, [p.dateStyle]);
      await app.query('BEGIN');
      try {
        await app.query('SELECT crove_kernel.enter_context($1::uuid, $2::uuid)', [userId, orgId]);
        const args = [p.date ?? '2026-10-01', p.description ?? 'Mua văn phòng phẩm', p.sourceType ?? 'test.source', p.sourceId, JSON.stringify(p.lines), p.reverses ?? null];
        const { rows } =
          p.revision === undefined
            ? await app.query<{ id: string }>('SELECT crove_finance.post_journal_entry($1::date, $2, $3, $4::uuid, $5::jsonb, $6::uuid) AS id', args)
            : await app.query<{ id: string }>('SELECT crove_finance.post_journal_entry($1::date, $2, $3, $4::uuid, $5::jsonb, $6::uuid, $7::int) AS id', [
                ...args,
                p.revision,
              ]);
        await app.query('COMMIT');
        return { id: rows[0]?.id ?? '' };
      } catch (error) {
        await app.query('ROLLBACK').catch(() => {});
        return { error: error as PgError };
      }
    });
  }

  async function posted(orgId: string, p: Posting): Promise<string> {
    const result = await post(orgId, p);
    if ('error' in result) throw new Error(`posting failed: ${result.error.message}`);
    return result.id;
  }

  const entriesOf = (orgId: string, sourceId: string) =>
    withAdmin(async (c) =>
      (
        await c.query<{ id: string; source_revision: number; hash_bytes: number | null; reverses_entry_id: string | null }>(
          `SELECT id, source_revision, octet_length(payload_sha256) AS hash_bytes, reverses_entry_id
           FROM crove_finance.journal_entry WHERE org_id = $1 AND source_id = $2 ORDER BY source_revision`,
          [orgId, sourceId],
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
    const url = new URL(adminUrl);
    url.username = 'crove_app';
    url.password = 'test-app-pw';
    appUrl = url.toString();
    pool = createPool({ connectionString: appUrl, max: 1 });
    const db = createDb(pool);
    const runtime = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: 'in.test' }) });
    userId = await upsertIdentity(db, { issuer: 'test', subject: 'source-revision', email: 'rev@source.test', name: null });
    const actor = { type: 'user' as const, userId, aal: 'aal1' as const };
    orgs.a = (await createOrg(runtime, actor, 'Revision A')).orgId;
    orgs.b = (await createOrg(runtime, actor, 'Revision B')).orgId;
  });

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('keys entries by source and revision, with no key on the source alone', async () => {
    const constraints = await withAdmin(async (c) =>
      (
        await c.query<{ name: string; def: string }>(
          `SELECT conname AS name, pg_get_constraintdef(oid) AS def FROM pg_constraint
           WHERE conrelid = 'crove_finance.journal_entry'::regclass AND contype IN ('u', 'c') ORDER BY conname`,
        )
      ).rows,
    );
    expect(constraints).toEqual(
      expect.arrayContaining([
        { name: 'journal_entry_source_revision_key', def: 'UNIQUE (org_id, source_type, source_id, source_revision)' },
        { name: 'journal_entry_source_revision_positive', def: 'CHECK ((source_revision >= 1))' },
        { name: 'journal_entry_payload_sha256_length', def: 'CHECK (((payload_sha256 IS NULL) OR (octet_length(payload_sha256) = 32)))' },
      ]),
    );
    expect(constraints.filter((c) => c.def.startsWith('UNIQUE'))).toHaveLength(1);
    const column = await withAdmin(async (c) =>
      (
        await c.query<{ def: string; nullable: string }>(
          `SELECT column_default AS def, is_nullable AS nullable FROM information_schema.columns
           WHERE table_schema = 'crove_finance' AND table_name = 'journal_entry' AND column_name = 'source_revision'`,
        )
      ).rows[0],
    );
    expect(column).toEqual({ def: '1', nullable: 'NO' });
  });

  it('posts revision 1 by default and stores the payload hash', async () => {
    const sourceId = randomUUID();
    const id = await posted(orgs.a, { sourceId, lines: SALE });
    expect(await entriesOf(orgs.a, sourceId)).toEqual([{ id, source_revision: 1, hash_bytes: 32, reverses_entry_id: null }]);
  });

  it('replays the same revision and payload: the posted entry, nothing written, whatever the wording or the amount format', async () => {
    const sourceId = randomUUID();
    const id = await posted(orgs.a, { sourceId, lines: SALE, revision: 1 });
    // The same payload again, through both signatures; wording and memos are not part of it, '100500.0000' is 100500,
    // and the line order in the request does not matter.
    expect(await post(orgs.a, { sourceId, lines: SALE })).toEqual({ id });
    const reworded = [...SALE].reverse().map((l) => ({ ...l, debit: `${l.debit}.0000`, memo: 'khác' }));
    expect(await post(orgs.a, { sourceId, lines: reworded, description: 'Mô tả khác', revision: 1 })).toEqual({ id });
    expect(await entriesOf(orgs.a, sourceId)).toHaveLength(1);
  });

  it('hashes the entry date alike whatever the session DateStyle', async () => {
    const sourceId = randomUUID();
    const id = await posted(orgs.a, { sourceId, lines: SALE, date: '2026-03-04' });
    for (const dateStyle of ['SQL, DMY', 'SQL, MDY', 'German', 'Postgres, YMD']) {
      expect(await post(orgs.a, { sourceId, lines: SALE, date: '2026-03-04', dateStyle })).toEqual({ id });
    }
    // And the other way round: posted under a non-ISO DateStyle, replayed under the default.
    const other = randomUUID();
    const otherId = await posted(orgs.a, { sourceId: other, lines: SALE, date: '2026-03-04', dateStyle: 'SQL, DMY' });
    expect(await post(orgs.a, { sourceId: other, lines: SALE, date: '2026-03-04' })).toEqual({ id: otherId });
    expect(await entriesOf(orgs.a, sourceId)).toHaveLength(1);
    expect(await entriesOf(orgs.a, other)).toHaveLength(1);
  });

  it('refuses the same revision with another payload (IDEMPOTENCY_CONFLICT)', async () => {
    const sourceId = randomUUID();
    const id = await posted(orgs.a, { sourceId, lines: SALE });
    const changes: Array<Partial<Posting>> = [
      { lines: SALE.map((l) => (l.line_no === 1 ? { ...l, debit: '100400' } : l.line_no === 2 ? { ...l, debit: '10150' } : l)) },
      { lines: SALE.map((l) => (l.line_no === 1 ? { ...l, account_code: '6421' } : l)) },
      { lines: SALE.map((l) => (l.line_no === 3 ? { ...l, party_id: randomUUID() } : l)) },
      { date: '2026-10-02' },
    ];
    for (const change of changes) {
      const result = await post(orgs.a, { sourceId, lines: SALE, ...change });
      expect(result).toMatchObject({ error: { code: '23505', message: 'IDEMPOTENCY_CONFLICT', constraint: 'journal_entry_source_revision_key' } });
      if (!('error' in result)) continue;
      expect(JSON.parse(result.error.detail ?? '{}')).toEqual({ sourceType: 'test.source', sourceId, revision: 1, entryId: id });
      expect(sourceRevisionError(result.error)).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', status: 409 });
    }
    expect(await entriesOf(orgs.a, sourceId)).toHaveLength(1);
  });

  it('re-posts a source only as the next revision and only after the previous one is reversed', async () => {
    const sourceId = randomUUID();
    const first = await posted(orgs.a, { sourceId, lines: SALE });
    const corrected = SALE.map((l) => (l.line_no === 1 ? { ...l, debit: '90500' } : l.line_no === 3 ? { ...l, credit: '100550' } : l));

    // Revision 2 while revision 1 is still on the books.
    const still = await post(orgs.a, { sourceId, lines: corrected, revision: 2 });
    expect(still).toMatchObject({ error: { code: '23514', message: 'SOURCE_STILL_POSTED' } });
    if ('error' in still) {
      expect(JSON.parse(still.error.detail ?? '{}')).toEqual({ sourceType: 'test.source', sourceId, revision: 1, entryId: first });
      expect(sourceRevisionError(still.error)).toMatchObject({ code: 'SOURCE_STILL_POSTED', status: 409 });
    }
    // Revision 3, skipping 2.
    const skipped = await post(orgs.a, { sourceId, lines: corrected, revision: 3 });
    expect(skipped).toMatchObject({ error: { code: '23514', message: 'REVISION_OUT_OF_ORDER' } });
    if ('error' in skipped) {
      expect(JSON.parse(skipped.error.detail ?? '{}')).toEqual({ sourceType: 'test.source', sourceId, expected: 2, revision: 3 });
      expect(sourceRevisionError(skipped.error)).toMatchObject({ code: 'REVISION_OUT_OF_ORDER', status: 409 });
    }

    // Reverse revision 1 (its own source, revision 1), then revision 2 posts.
    const reversal = await posted(orgs.a, { sourceType: 'test.reversal', sourceId: randomUUID(), lines: mirror(SALE), reverses: first, date: '2026-10-15' });
    const second = await posted(orgs.a, { sourceId, lines: corrected, revision: 2, date: '2026-10-15' });
    expect(await entriesOf(orgs.a, sourceId)).toEqual([
      { id: first, source_revision: 1, hash_bytes: 32, reverses_entry_id: null },
      { id: second, source_revision: 2, hash_bytes: 32, reverses_entry_id: null },
    ]);
    // Each revision still replays to its own entry; revision 3 now waits for the reversal of revision 2.
    expect(await post(orgs.a, { sourceId, lines: SALE })).toEqual({ id: first });
    expect(await post(orgs.a, { sourceId, lines: corrected, revision: 2, date: '2026-10-15' })).toEqual({ id: second });
    expect(await post(orgs.a, { sourceId, lines: SALE, revision: 3, date: '2026-10-16' })).toMatchObject({ error: { message: 'SOURCE_STILL_POSTED' } });
    expect(await post(orgs.a, { sourceId, lines: SALE, revision: 4, date: '2026-10-16' })).toMatchObject({ error: { message: 'REVISION_OUT_OF_ORDER' } });

    // Revision 1 and its reversal net to zero on every account.
    const net = await withAdmin(async (c) =>
      (
        await c.query<{ account_code: string; net: string }>(
          `SELECT account_code, sum(debit - credit)::text AS net FROM crove_finance.journal_line
           WHERE org_id = $1 AND entry_id IN ($2, $3) GROUP BY account_code ORDER BY account_code`,
          [orgs.a, first, reversal],
        )
      ).rows,
    );
    expect(net).toEqual([
      { account_code: '1331', net: '0.0000' },
      { account_code: '331', net: '0.0000' },
      { account_code: '6422', net: '0.0000' },
    ]);
  });

  it('starts every source at revision 1 and refuses a revision below 1', async () => {
    const sourceId = randomUUID();
    expect(await post(orgs.a, { sourceId, lines: SALE, revision: 2 })).toMatchObject({ error: { code: '23514', message: 'REVISION_OUT_OF_ORDER' } });
    expect(await post(orgs.a, { sourceId, lines: SALE, revision: 0 })).toMatchObject({ error: { code: '22023', message: 'SOURCE_REVISION_INVALID' } });
    expect(await post(orgs.a, { sourceId, lines: SALE, revision: null })).toMatchObject({ error: { code: '22023', message: 'SOURCE_REVISION_INVALID' } });
    expect(await entriesOf(orgs.a, sourceId)).toEqual([]);
  });

  it('posts a reversal only as revision 1 of its own source', async () => {
    const target = await posted(orgs.a, { sourceId: randomUUID(), lines: SALE });
    const sourceId = randomUUID();
    expect(await post(orgs.a, { sourceType: 'test.reversal', sourceId, lines: mirror(SALE), reverses: target, revision: 2, date: '2026-10-15' })).toMatchObject({
      error: { code: '23514', message: 'REVERSAL_REVISION' },
    });
    const refused = await post(orgs.a, { sourceType: 'test.reversal', sourceId, lines: mirror(SALE), reverses: target, revision: 2, date: '2026-10-15' });
    if ('error' in refused) expect(sourceRevisionError(refused.error)).toMatchObject({ code: 'REVERSAL_REVISION', status: 409, details: { revision: 2, entryId: target } });
    // Replaying the reversal returns it, so a retried reversal cannot double the correction.
    const reversal = await posted(orgs.a, { sourceType: 'test.reversal', sourceId, lines: mirror(SALE), reverses: target, revision: 1, date: '2026-10-15' });
    expect(await post(orgs.a, { sourceType: 'test.reversal', sourceId, lines: mirror(SALE), reverses: target, date: '2026-10-15' })).toEqual({ id: reversal });
  });

  it('keeps each org to its own sources', async () => {
    const sourceId = randomUUID();
    const inA = await posted(orgs.a, { sourceId, lines: SALE });
    // The same source in another org is another source: revision 1 posts there, and its lines may differ.
    const inB = await posted(orgs.b, { sourceId, lines: SALE.map((l) => (l.line_no === 2 ? { ...l, account_code: '1332' } : l)) });
    expect(inB).not.toBe(inA);
    expect(await entriesOf(orgs.b, sourceId)).toEqual([{ id: inB, source_revision: 1, hash_bytes: 32, reverses_entry_id: null }]);
  });

  it('compares a replay of an entry posted before payload hashes with its stored lines', async () => {
    // An entry as every entry on main before this change: revision 1 by default, no payload hash.
    const sourceId = randomUUID();
    const legacy = await withAdmin(async (c) => {
      await c.query('BEGIN');
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO crove_finance.journal_entry (org_id, entry_date, description, source_type, source_id) VALUES ($1, '2026-10-01', 'Trước #1283', 'test.source', $2) RETURNING id`,
        [orgs.a, sourceId],
      );
      const id = rows[0]?.id ?? '';
      for (const l of SALE) {
        await c.query(
          `INSERT INTO crove_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit, party_id, memo) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [orgs.a, id, l.line_no, l.account_code, l.debit, l.credit, l.party_id ?? null, l.memo ?? null],
        );
      }
      await c.query('COMMIT');
      return id;
    });
    expect(await entriesOf(orgs.a, sourceId)).toEqual([{ id: legacy, source_revision: 1, hash_bytes: null, reverses_entry_id: null }]);
    expect(await post(orgs.a, { sourceId, lines: SALE })).toEqual({ id: legacy });
    expect(await post(orgs.a, { sourceId, lines: SALE, date: '2026-10-02' })).toMatchObject({ error: { message: 'IDEMPOTENCY_CONFLICT' } });
    expect(await post(orgs.a, { sourceId, lines: SALE.map((l) => (l.line_no === 3 ? { ...l, party_id: null } : l)) })).toMatchObject({
      error: { message: 'IDEMPOTENCY_CONFLICT' },
    });
    expect(await entriesOf(orgs.a, sourceId)).toHaveLength(1);
  });
});
