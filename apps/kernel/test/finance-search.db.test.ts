// Search across parties, documents and journal entries (issue #673) on a real PostgreSQL 17: Vietnamese without marks,
// tax codes, invoice numbers with or without their leading zeros, entry descriptions and amounts, the cap per group,
// the org boundary, and the planner using the search indexes on an org of 50,000 documents within 200 ms at p95.
// The amount reading is unit-tested in modules/finance/test/search.test.ts.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run creates and drops its own database.
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { zSearchResult } from '@crove/kernel-contract';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { SEARCH_LIMIT, financeCommands, financeQueries, type SearchResult } from '@crove/mod-finance';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
// The seeded org's size, from the issue's acceptance criterion.
const DOCUMENTS = 50_000;
const PARTIES = 2_000;

const suite = ADMIN ? describe : describe.skip;

suite('finance search (#673)', () => {
  const dbName = `crove_test_search_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let runtime: Runtime;
  let owner = '';
  let outsider = '';
  let org = { slug: '', orgId: '' };
  let big = { slug: '', orgId: '' };
  let other = { slug: '', orgId: '' };

  const asUser = (userId: string) => ({
    type: 'user' as const,
    userId,
    aal: 'aal1' as const,
  });
  const search = async (q: string, orgId = org.orgId, who = owner) =>
    zSearchResult.parse(await runtime.query<SearchResult>('finance.search', { q }, { actor: asUser(who), orgId }));

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  // A recorded document with its journal entry (6422 / 331), inserted by the database owner in one transaction: the
  // deferred checks want each document posted and each entry balanced.
  async function seed(
    orgId: string,
    rows: Array<{
      party: { name: string; taxCode: string | null };
      series: string;
      number: string;
      date: string;
      total: string;
      description: string;
      direction?: 'purchase' | 'sale';
    }>,
  ) {
    await admin(async (c) => {
      await c.query('BEGIN');
      for (const r of rows) {
        const party = await c.query<{ id: string }>(
          `INSERT INTO crove_kernel.party (org_id, name, tax_code) VALUES ($1, $2, $3)
           ON CONFLICT (org_id, tax_code) WHERE tax_code IS NOT NULL DO UPDATE SET name = excluded.name RETURNING id`,
          [orgId, r.party.name, r.party.taxCode],
        );
        const doc = await c.query<{ id: string }>(
          `INSERT INTO crove_finance.purchase_document (org_id, party_id, invoice_series, invoice_number, invoice_date, subtotal, vat_amount, total, direction)
           VALUES ($1, $2, $3, $4, $5, $6, 0, $6, $7) RETURNING id`,
          [orgId, party.rows[0]?.id, r.series, r.number, r.date, r.total, r.direction ?? 'purchase'],
        );
        const entry = await c.query<{ id: string }>(
          `INSERT INTO crove_finance.journal_entry (org_id, entry_date, description, source_type, source_id)
           VALUES ($1, $2, $3, 'finance.purchase_document', $4) RETURNING id`,
          [orgId, r.date, r.description, doc.rows[0]?.id],
        );
        await c.query(
          `INSERT INTO crove_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit) VALUES ($1, $2, 1, '6422', $3, 0), ($1, $2, 2, '331', 0, $3)`,
          [orgId, entry.rows[0]?.id, r.total],
        );
      }
      await c.query('COMMIT');
    });
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
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw' });
    const appUrl = new URL(adminUrl);
    appUrl.username = 'crove_app';
    appUrl.password = 'test-app-pw';
    pool = createPool({ connectionString: appUrl.toString(), max: 4 });
    db = createDb(pool);
    runtime = new Runtime(db, { manifests: TEST_MANIFESTS }).register({
      commands: [...kernelCommands, ...financeCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries],
    });
    owner = await upsertIdentity(db, {
      issuer: 'test',
      subject: 'search-owner',
      email: 'owner@search.test',
      name: 'Owner',
    });
    outsider = await upsertIdentity(db, {
      issuer: 'test',
      subject: 'search-outsider',
      email: 'outsider@search.test',
      name: 'Outsider',
    });
    org = await createOrg(runtime, asUser(owner), 'Công ty Tìm kiếm');
    big = await createOrg(runtime, asUser(owner), 'Công ty Lớn');
    other = await createOrg(runtime, asUser(outsider), 'Công ty Khác');

    await seed(org.orgId, [
      {
        party: { name: 'Công ty Điện lực Hà Nội', taxCode: '0101234564' },
        series: '1C26TAA',
        number: '00000123',
        date: '2026-09-15',
        total: '1980000',
        description: 'Tiền điện tháng 9',
      },
      {
        party: { name: 'Công ty Điện lực Hà Nội', taxCode: '0101234564' },
        series: '1C26TAA',
        number: '00000456',
        date: '2026-10-15',
        total: '2100000',
        description: 'Tiền điện tháng 10',
      },
      {
        party: { name: 'Nhà sách Phương Nam', taxCode: '0309876546' },
        series: 'AA/26E',
        number: '0000789',
        date: '2026-08-01',
        total: '350000',
        description: 'Mua văn phòng phẩm',
      },
      {
        party: { name: 'Khách lẻ Đà Nẵng', taxCode: null },
        series: 'C26TCR',
        number: '12',
        date: '2026-10-02',
        total: '5500000',
        description: 'Bán hàng cho khách lẻ',
        direction: 'sale',
      },
    ]);
    // The other org holds the same names, numbers and amounts: none of it may show up in the first org.
    await seed(other.orgId, [
      {
        party: { name: 'Công ty Điện lực Hà Nội', taxCode: '0101234564' },
        series: '1C26TAA',
        number: '00000999',
        date: '2026-09-20',
        total: '1980000',
        description: 'Tiền điện khác',
      },
    ]);
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('finds parties by name without Vietnamese marks, by prefix and by tax code', async () => {
    const byName = await search('dien luc');
    expect(byName.parties).toEqual([
      expect.objectContaining({
        name: 'Công ty Điện lực Hà Nội',
        taxCode: '0101234564',
        customerOnly: false,
      }),
    ]);
    expect((await search('ĐIỆN LỰC')).parties).toHaveLength(1);
    expect((await search('cong dien ha')).parties).toHaveLength(1);
    expect((await search('0101234')).parties).toEqual([expect.objectContaining({ taxCode: '0101234564' })]);
    // Only the first 8 words count: the ninth, which matches nothing, is not read.
    expect((await search('cong ty dien luc ha noi cong ty zzz')).parties).toHaveLength(1);
    // Every word must match: one that matches nothing leaves no party.
    expect((await search('dien saigon')).parties).toEqual([]);
    // A customer of sales only is marked, so the palette opens it with the documents rather than the vendors.
    expect((await search('khach le da nang')).parties).toEqual([expect.objectContaining({ name: 'Khách lẻ Đà Nẵng', customerOnly: true })]);
  });

  it('finds documents by number with or without leading zeros, by series, and by their party', async () => {
    const byNumber = await search('123');
    expect(byNumber.documents).toEqual([
      expect.objectContaining({
        number: '00000123',
        series: '1C26TAA',
        partyName: 'Công ty Điện lực Hà Nội',
        issueDate: '2026-09-15',
        total: '1980000.0000',
        voided: false,
        direction: 'purchase',
      }),
    ]);
    expect((await search('00000123')).documents.map((d) => d.number)).toEqual(['00000123']);
    expect((await search('AA/26E')).documents.map((d) => d.number)).toEqual(['0000789']);
    // The party's documents, newest first.
    expect((await search('dien luc')).documents.map((d) => d.number)).toEqual(['00000456', '00000123']);
    expect((await search('khach le')).documents).toEqual([expect.objectContaining({ number: '12', direction: 'sale' })]);
  });

  it('finds journal entries by description and by amount, whichever way the amount is written', async () => {
    expect((await search('tien dien')).entries.map((e) => e.description)).toEqual(['Tiền điện tháng 10', 'Tiền điện tháng 9']);
    for (const typed of ['1.980.000', '1,980,000', '1980000', '1 980 000', '1.980.000 đ']) {
      expect((await search(typed)).entries, typed).toEqual([
        expect.objectContaining({
          description: 'Tiền điện tháng 9',
          entryDate: '2026-09-15',
          amount: '1980000.0000',
        }),
      ]);
    }
    expect((await search('1.980.001')).entries).toEqual([]);
  });

  it('stays inside the org and treats the typed text as words only', async () => {
    const elsewhere = await search('dien', other.orgId, outsider);
    expect(elsewhere.documents.map((d) => d.number)).toEqual(['00000999']);
    expect(elsewhere.entries.map((e) => e.description)).toEqual(['Tiền điện khác']);
    // A member of another org cannot search this one.
    await expect(runtime.query('finance.search', { q: 'dien' }, { actor: asUser(outsider), orgId: org.orgId })).rejects.toMatchObject({ code: 'NOT_A_MEMBER' });
    // tsquery syntax is just punctuation here.
    for (const q of ['dien & !luc', "'; DROP TABLE x; --", 'dien:* | luc', '()', '!!']) {
      await expect(search(q), q).resolves.toBeDefined();
    }
    expect(await search('()')).toEqual({
      parties: [],
      documents: [],
      entries: [],
    });
    await expect(runtime.query('finance.search', { q: 'd' }, { actor: asUser(owner), orgId: org.orgId })).rejects.toThrow();
  });

  describe('on an org of 50,000 documents', () => {
    beforeAll(async () => {
      await admin(async (c) => {
        await c.query('BEGIN');
        await c.query(
          `INSERT INTO crove_kernel.party (org_id, name, tax_code)
           SELECT $1, 'Công ty TNHH Thương mại ' || g, pg_catalog.lpad(g::text, 10, '0') FROM pg_catalog.generate_series(1, $2::int) g`,
          [big.orgId, PARTIES],
        );
        await c.query(
          `CREATE TEMP TABLE seeded ON COMMIT DROP AS
           SELECT g, crove_kernel.uuid_v7() AS doc_id, crove_kernel.uuid_v7() AS entry_id,
                  (SELECT p.id FROM crove_kernel.party p WHERE p.org_id = $1 AND p.tax_code = pg_catalog.lpad((1 + g % $3::int)::text, 10, '0')) AS party_id,
                  DATE '2024-01-01' + (g % 1000) AS day, (100000 + g * 7)::numeric AS total
           FROM pg_catalog.generate_series(1, $2::int) g`,
          [big.orgId, DOCUMENTS, PARTIES],
        );
        await c.query(
          `INSERT INTO crove_finance.purchase_document (org_id, id, party_id, invoice_series, invoice_number, invoice_date, subtotal, vat_amount, total)
           SELECT $1, doc_id, party_id, '1C26TAA', pg_catalog.lpad(g::text, 8, '0'), day, total, 0, total FROM seeded`,
          [big.orgId],
        );
        await c.query(
          `INSERT INTO crove_finance.journal_entry (org_id, id, entry_date, description, source_type, source_id)
           SELECT $1, entry_id, day, 'Mua hàng hóa đơn số ' || g, 'finance.purchase_document', doc_id FROM seeded`,
          [big.orgId],
        );
        await c.query(
          `INSERT INTO crove_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit)
           SELECT $1::uuid, entry_id, 1, '6422', total, 0 FROM seeded UNION ALL SELECT $1::uuid, entry_id, 2, '331', 0, total FROM seeded`,
          [big.orgId],
        );
        await c.query('COMMIT');
        // VACUUM as autovacuum would: it also moves the GIN indexes' pending lists (rows inserted since) into the indexes.
        await c.query('VACUUM ANALYZE crove_kernel.party, crove_finance.purchase_document, crove_finance.journal_entry, crove_finance.journal_line');
      });
    }, 300_000);

    it('caps each group and answers within 200 ms at p95', async () => {
      // A word that every row holds: each group is full, and capped.
      const broad = await search('thuong mai', big.orgId);
      expect(broad.parties).toHaveLength(SEARCH_LIMIT);
      expect(broad.documents).toHaveLength(SEARCH_LIMIT);
      expect((await search('mua hang', big.orgId)).entries).toHaveLength(SEARCH_LIMIT);
      // The newest documents first.
      const dates = broad.documents.map((d) => d.issueDate);
      expect(dates).toEqual(dates.toSorted().reverse());

      const queries = [
        'thuong mai 1234',
        '0000012345',
        '12345',
        'hoa don so 4321',
        '100700',
        'cong ty tnhh',
        'khong co gi',
        '0000001',
        'mua hang 999',
        '1C26TAA',
      ];
      for (const q of queries) await search(q, big.orgId);
      const times: number[] = [];
      for (let round = 0; round < 4; round++) {
        for (const q of queries) {
          const start = performance.now();
          await search(q, big.orgId);
          times.push(performance.now() - start);
        }
      }
      times.sort((a, b) => a - b);
      const p95 = times[Math.ceil(times.length * 0.95) - 1] ?? Infinity;
      expect(p95, `p95 ${p95.toFixed(1)} ms over ${times.length} searches`).toBeLessThan(200);
    }, 120_000);

    it('reads the search indexes, not the whole tables', async () => {
      const plan = await admin(async (c) => {
        // A word few rows hold: one document, one entry. (A word every row holds is read faster by org, and 2,000
        // parties are read faster whole.)
        const vector = (table: string, q: string) =>
          c.query<{ 'QUERY PLAN': string }>(`EXPLAIN SELECT 1 FROM ${table} t WHERE t.org_id = $1 AND t.search @@ crove_kernel.search_query($2)`, [
            big.orgId,
            q,
          ]);
        const rows = [
          ...(await vector('crove_finance.purchase_document', '00012345')).rows,
          ...(await vector('crove_finance.journal_entry', 'so 12345')).rows,
          ...(await c.query(`EXPLAIN SELECT 1 FROM crove_finance.journal_line l WHERE l.org_id = $1 AND (l.debit + l.credit) = 100700`, [big.orgId])).rows,
        ];
        return rows.map((r) => r['QUERY PLAN']).join('\n');
      });
      for (const index of ['purchase_document_search_idx', 'journal_entry_search_idx', 'journal_line_amount_idx']) expect(plan).toContain(index);
    });
  });
});
