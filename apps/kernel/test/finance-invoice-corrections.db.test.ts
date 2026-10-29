// Replacement and adjustment e-invoices (issue #916), on PostgreSQL 17, from the XML through crove-extract to the
// books: the proposal names the original and says whether it is in the books; approving a replacement reverses the
// original's entry and voids its document in the same transaction, so cost, input VAT and the payable count once; an
// adjustment is recorded with its signed difference and linked to the original, which stays in force; a correction
// whose original is not in the books is recorded alone, with a warning. The database refuses a link to a document of
// another invoice. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import type { ExtractClient } from '@crove/extract-contract';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime, fileKey, sha256Hex, type BlobStore } from '@crove/kernel-runtime';
import { extractAndPropose, financeCommands, financeQueries } from '@crove/mod-finance';
import { inProcessExtract } from './extract-service.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const fixture = (name: string) => readFileSync(new URL(`../../extract/test/fixtures/${name}`, import.meta.url), 'utf8');
const BASIC = fixture('einvoice-basic.xml');
const REPLACEMENT = fixture('einvoice-replacement.xml');
const ADJUSTMENT = fixture('einvoice-adjustment.xml');

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

const suite = ADMIN ? describe : describe.skip;

suite('replacement and adjustment invoices (#916)', () => {
  const dbName = `crove_test_corrections_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let runtime: Runtime;
  let workerRuntime: Runtime;
  let extract: ExtractClient;
  const store = new MemoryStore();
  let orgId = '';
  let owner = '';
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const asMfa = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal2' as const, sessionId: randomUUID(), mfaAt: Math.floor(Date.now() / 1000) });

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  async function read(xml: string) {
    const bytes = new TextEncoder().encode(xml);
    const sha256 = sha256Hex(bytes);
    const storageKey = fileKey(orgId, sha256);
    const generation = await store.put(storageKey, bytes);
    const { fileId } = await runtime.execute<{ fileId: string }>(
      'kernel.file.ingest',
      { filename: 'hd.xml', contentType: 'application/xml', sizeBytes: bytes.byteLength, sha256, storageKey, generation, source: 'upload' },
      { actor: asUser(owner), orgId },
    );
    const { proposalId } = await extractAndPropose({ runtime: workerRuntime, store, extractor: null, extract, today: () => '2026-10-13' }, orgId, fileId);
    return String(proposalId);
  }

  const detail = (id: string) =>
    runtime.query<{ payload: { invoice: { related?: unknown }; checks: Array<{ id: string; status: string; code?: string }> } }>('kernel.inbox.get', { id }, { actor: asUser(owner), orgId });

  const approve = (id: string) =>
    runtime.execute<{ documentId: string; journalEntryId: string; correctsDocumentId?: string; voidedDocumentId?: string }>(
      'kernel.proposal.approve',
      { acceptUnverifiedSignature: true, id, revision: 1 },
      { actor: asMfa(owner), orgId, idempotencyKey: randomUUID() },
    );

  // The fixture invoice under another number and date, and the original a correction names.
  const numbered = (xml: string, number: string, date: string, original?: string) => {
    const out = xml.replace(/<SHDon>\d+<\/SHDon>/, `<SHDon>${number}</SHDon>`).replace(/<NLap>[\d-]+<\/NLap>/, `<NLap>${date}</NLap>`);
    return original ? out.replace(/<SHDCLQuan>\d+<\/SHDCLQuan>/, `<SHDCLQuan>${original}</SHDCLQuan>`) : out;
  };

  // The org's balance of an account (debit minus credit) over every entry.
  const balance = async (account: string) =>
    Number(
      (
        await admin((c) =>
          c.query<{ net: string }>(`SELECT coalesce(sum(debit - credit), 0)::text AS net FROM crove_finance.journal_line WHERE org_id = $1 AND account_code = $2`, [orgId, account]),
        )
      ).rows[0]?.net,
    );

  beforeAll(async () => {
    extract = inProcessExtract();
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
    pool = createPool({ connectionString: login('crove_app', 'test-app-pw'), max: 4 });
    workerPool = createPool({ connectionString: login('crove_worker', 'test-worker-pw'), max: 2 });
    const register = (target: Db) =>
      new Runtime(target, { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands, ...financeCommands], queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries] });
    runtime = register(createDb(pool));
    workerRuntime = register(createDb(workerPool));
    owner = await upsertIdentity(createDb(pool), { issuer: 'test', subject: randomUUID(), email: `owner-${randomUUID().slice(0, 8)}@corrections.test`, name: null });
    ({ orgId } = await createOrg(runtime, asUser(owner), `Org ${randomUUID().slice(0, 6)}`));
  });

  afterAll(async () => {
    await pool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  let original = '';
  let replacement = '';

  it('replaces an invoice in the books: the original is reversed and voided, so the payable counts once', async () => {
    const first = await approve(await read(numbered(BASIC, '8001', '2026-09-15')));
    original = first.documentId;
    expect(await balance('331')).toBe(-1980000);

    const proposal = await read(numbered(REPLACEMENT, '8002', '2026-09-20', '8001'));
    const asked = await detail(proposal);
    expect(asked.payload.invoice.related).toEqual({
      kind: 'replacement',
      template: '1',
      series: 'C26TAB',
      number: '8001',
      issueDate: '2026-09-15',
      documentId: original,
    });
    expect(asked.payload.checks).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'related', status: 'pass', code: 'related.replaces' })]));

    const recorded = await approve(proposal);
    replacement = recorded.documentId;
    expect(recorded).toMatchObject({ correctsDocumentId: original, voidedDocumentId: original });
    // The original's 1,980,000 is reversed and the replacement's booked: one payable, not two.
    expect(await balance('331')).toBe(-1980000);
    expect(await balance('1331')).toBe(180000);
    const rows = await admin((c) =>
      c.query(
        `SELECT d.invoice_number, d.correction_kind, d.corrects_document_id, d.corrected_series, d.corrected_number, d.corrected_date::text,
                EXISTS (SELECT 1 FROM crove_finance.purchase_document_void v WHERE v.org_id = d.org_id AND v.document_id = d.id) AS voided
           FROM crove_finance.purchase_document d WHERE d.org_id = $1 ORDER BY d.invoice_number`,
        [orgId],
      ),
    );
    expect(rows.rows).toEqual([
      { invoice_number: '8001', correction_kind: null, corrects_document_id: null, corrected_series: null, corrected_number: null, corrected_date: null, voided: true },
      {
        invoice_number: '8002',
        correction_kind: 'replacement',
        corrects_document_id: original,
        corrected_series: 'C26TAB',
        corrected_number: '8001',
        corrected_date: '2026-09-15',
        voided: false,
      },
    ]);
    // The reversal is dated the replacement's day.
    const reversal = await admin((c) =>
      c.query<{ entry_date: string }>(`SELECT entry_date::text FROM crove_finance.journal_entry WHERE org_id = $1 AND reverses_entry_id = $2`, [orgId, first.journalEntryId]),
    );
    expect(reversal.rows).toEqual([{ entry_date: '2026-09-20' }]);
  });

  it('records an adjustment with its signed difference, linked to the original, which stays in force', async () => {
    const proposal = await read(numbered(ADJUSTMENT, '8003', '2026-10-05', '8002'));
    expect((await detail(proposal)).payload.checks).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'related', code: 'related.adjusts' })]));
    const recorded = await approve(proposal);
    expect(recorded.correctsDocumentId).toBe(replacement);
    expect(recorded.voidedDocumentId).toBeUndefined();
    // 1,980,000 less the 220,000 adjustment.
    expect(await balance('331')).toBe(-1760000);
    expect(await balance('1331')).toBe(160000);
    const voided = await admin((c) =>
      c.query(`SELECT 1 FROM crove_finance.purchase_document_void WHERE org_id = $1 AND document_id = $2`, [orgId, replacement]),
    );
    expect(voided.rows).toEqual([]);
  });

  it('records a correction whose original is not in the books alone, with a warning', async () => {
    const proposal = await read(numbered(REPLACEMENT, '8004', '2026-09-25', '7777'));
    const asked = await detail(proposal);
    expect(asked.payload.invoice.related).toMatchObject({ number: '7777', documentId: null });
    expect(asked.payload.checks).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'related', status: 'warn', code: 'related.replaces_missing' })]));
    const recorded = await approve(proposal);
    expect(recorded.correctsDocumentId).toBeUndefined();
    const row = await admin((c) =>
      c.query(`SELECT correction_kind, corrects_document_id, corrected_number FROM crove_finance.purchase_document WHERE org_id = $1 AND id = $2`, [orgId, recorded.documentId]),
    );
    expect(row.rows).toEqual([{ correction_kind: 'replacement', corrects_document_id: null, corrected_number: '7777' }]);
  });

  it('shows the links both ways on the documents list and in the journal', async () => {
    type Doc = { id: string; number: string; corrects: unknown; correctedBy: unknown[] };
    const docs = await runtime.query<Doc[]>('finance.documents.list', {}, { actor: asUser(owner), orgId });
    const byNumber = new Map(docs.map((d) => [d.number, d]));
    expect(byNumber.get('8001')).toMatchObject({ corrects: null, correctedBy: [{ kind: 'replacement', documentId: replacement, series: 'C26TAB', number: '8002' }] });
    expect(byNumber.get('8002')).toMatchObject({
      corrects: { kind: 'replacement', series: 'C26TAB', number: '8001', documentId: original },
      correctedBy: [{ kind: 'adjustment', series: 'C26TAB', number: '8003' }],
    });
    expect(byNumber.get('8003')).toMatchObject({ corrects: { kind: 'adjustment', number: '8002', documentId: replacement }, correctedBy: [] });
    expect(byNumber.get('8004')).toMatchObject({ corrects: { kind: 'replacement', number: '7777', documentId: null } });

    const journal = await runtime.query<Array<{ document?: { number: string; corrects?: unknown; correctedBy?: unknown[] } }>>(
      'finance.journal.list',
      {},
      { actor: asUser(owner), orgId },
    );
    const entry = journal.find((e) => e.document?.number === '8002');
    expect(entry?.document).toMatchObject({ corrects: { kind: 'replacement', number: '8001' }, correctedBy: [{ kind: 'adjustment', number: '8003' }] });
  });

  it('refuses a link to a document of another invoice, or an adjustment of a voided one', async () => {
    const insert = (kind: string, corrects: string, number: string) =>
      admin((c) =>
        c.query(
          `INSERT INTO crove_finance.purchase_document
             (org_id, direction, party_id, invoice_series, invoice_number, invoice_date, subtotal, vat_amount, total,
              correction_kind, corrects_document_id, corrected_series, corrected_number)
           SELECT org_id, direction, party_id, 'C26TAB', $4, '2026-10-10', 0, 0, 0, $2, $3, 'C26TAB', $5
             FROM crove_finance.purchase_document WHERE org_id = $1 AND id = $3`,
          [orgId, kind, corrects, `X${randomUUID().slice(0, 6)}`, number],
        ),
      );
    // The reference names 9999, the linked document is 8002.
    await expect(insert('adjustment', replacement, '9999')).rejects.toThrow(/may correct only the document of the invoice it names/);
    // 8001 is voided: an adjustment cannot link to it, and a second replacement cannot take its place.
    await expect(insert('adjustment', original, '8001')).rejects.toThrow(/a replacement corrects a voided document, an adjustment one in force/);
    await expect(insert('replacement', original, '8001')).rejects.toThrow(/purchase_document_replacement_uq/);
  });
});
