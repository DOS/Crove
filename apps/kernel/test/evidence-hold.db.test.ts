// Retention holds on evidence files (issue #1009) on PostgreSQL 17: an invoice is read and posted the way a user posts
// one, and the worker's job then holds the original file in the store from the posting for EVIDENCE_LOCK_DAYS and
// records it. A file that is not posted is never held; a hold the store refuses is recorded with its reason, never
// touches the posting, and is tried again after a backoff; a bucket without Object Lock or a store without holds gets
// nothing recorded per file; a longer period lengthens a hold and a shorter one never shortens it.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import type { ExtractClient } from '@crove/extract-contract';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { BlobNotFoundError, Runtime, fileKey, sha256Hex, type BlobRef, type BlobStore, type EvidenceHolds } from '@crove/kernel-runtime';
import { extractAndPropose, financeCommands, financeQueries } from '@crove/mod-finance';
import { holdErrorText, runEvidenceHolds, type EvidenceHoldState } from '../src/evidence-hold.ts';
import { inProcessExtract } from './extract-service.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const FIXTURE = readFileSync(new URL('../../extract/test/fixtures/einvoice-basic.xml', import.meta.url)).toString('utf8');
const DAY = 86_400_000;

// An in-memory store whose holds the test controls: the calls are recorded, and `refuse` makes the next ones fail.
class HoldingStore implements BlobStore {
  readonly blobs = new Map<string, Uint8Array>();
  readonly held = new Map<string, Date>();
  readonly calls: { ref: BlobRef; until: Date }[] = [];
  lockEnabled = true;
  refuse: Error | null = null;
  readonly holds: EvidenceHolds = {
    available: async () => this.lockEnabled,
    hold: async (ref, until) => {
      this.calls.push({ ref, until });
      if (this.refuse) throw this.refuse;
      const current = this.held.get(ref.key);
      if (current && current >= until) return current;
      this.held.set(ref.key, until);
      return until;
    },
  };
  async put(key: string, bytes: Uint8Array) {
    this.blobs.set(key, bytes);
    return `content:${sha256Hex(bytes)}`;
  }
  async get(key: string) {
    const b = this.blobs.get(key);
    if (!b) throw new BlobNotFoundError(key);
    return b;
  }
  async delete(key: string) {
    this.blobs.delete(key);
  }
}

const suite = ADMIN ? describe : describe.skip;

suite('retention holds on evidence files (#1009)', () => {
  const dbName = `crove_test_holds_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let runtime: Runtime;
  let workerPool: pg.Pool;
  let workerDb: Db;
  let workerRuntime: Runtime;
  let extract: ExtractClient;
  const store = new HoldingStore();
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

  // The fixture invoice under a new number, so each one is a new document.
  const invoice = () => new TextEncoder().encode(FIXTURE.replace(/<SHDon>[^<]*<\/SHDon>/, `<SHDon>${Math.floor(Math.random() * 1e7)}</SHDon>`));

  async function ingest(bytes: Uint8Array) {
    const sha256 = sha256Hex(bytes);
    const storageKey = fileKey(orgId, sha256);
    const generation = await store.put(storageKey, bytes);
    const { fileId } = await runtime.execute<{ fileId: string }>(
      'kernel.file.ingest',
      { filename: 'hd.xml', contentType: 'application/xml', sizeBytes: bytes.byteLength, sha256, storageKey, generation, source: 'upload' },
      { actor: asUser(owner), orgId },
    );
    return { fileId, storageKey };
  }

  // Reads an invoice into a proposal, and posts it when asked; returns the file, the journal entry and its creation
  // time in microseconds since the epoch. A JS Date keeps milliseconds only, and the hold rounds the microseconds up to
  // the second (#1664).
  async function invoiceFile(post: boolean) {
    const file = await ingest(invoice());
    const { proposalId } = await extractAndPropose({ runtime: workerRuntime, store, extractor: null, extract, today: () => '2026-10-13' }, orgId, file.fileId);
    if (!post) return { ...file, journalEntryId: null, postedUs: null };
    const { journalEntryId } = await runtime.execute<{ journalEntryId: string }>(
      'kernel.proposal.approve',
      { acceptUnverifiedSignature: true, id: String(proposalId), revision: 1 },
      { actor: asMfa(owner), orgId, idempotencyKey: randomUUID() },
    );
    return { ...file, journalEntryId, postedUs: await postedUs(journalEntryId) };
  }
  const postedUs = async (journalEntryId: string) => {
    const { rows } = await admin((c) =>
      c.query<{ us: string }>('SELECT (extract(epoch FROM created_at) * 1000000)::bigint::text AS us FROM crove_finance.journal_entry WHERE id = $1', [journalEntryId]),
    );
    return BigInt(rows[0]?.us ?? '0');
  };
  // The hold for a posting `us` microseconds after the epoch: `days` later, rounded up to the whole second.
  const holdFor = (us: bigint | null, days: number) => {
    const end = (us ?? 0n) + BigInt(days) * 86_400_000_000n;
    return new Date(Number(((end + 999_999n) / 1_000_000n) * 1000n));
  };

  const holdRow = async (fileId: string) =>
    (
      await admin((c) =>
        c.query<{ held_until: Date | null; hold_attempts: number; hold_error: string | null; hold_attempted_at: Date | null }>(
          'SELECT held_until, hold_attempts, hold_error, hold_attempted_at FROM crove_kernel.file WHERE id = $1',
          [fileId],
        ),
      )
    ).rows[0];
  // Moves the last attempt back, as the backoff's waiting time passing would (bypassing the guard as the superuser).
  const pastBackoff = (fileId: string) =>
    admin(async (c) => {
      await c.query('BEGIN');
      await c.query("SET LOCAL session_replication_role = 'replica'");
      await c.query("UPDATE crove_kernel.file SET hold_attempted_at = now() - interval '2 days' WHERE id = $1", [fileId]);
      await c.query('COMMIT');
    });
  const run = (days = 3650, state: EvidenceHoldState = { unavailableReportedAt: 0 }, target: BlobStore = store) =>
    runEvidenceHolds({ runtime: workerRuntime, workerDb, store: target }, days, state);

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
    db = createDb(pool);
    workerPool = createPool({ connectionString: login('crove_worker', 'test-worker-pw'), max: 2 });
    workerDb = createDb(workerPool);
    const register = (target: Db) =>
      new Runtime(target, { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands, ...financeCommands], queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries] });
    runtime = register(db);
    workerRuntime = register(workerDb);
    owner = await upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `owner-${randomUUID().slice(0, 8)}@holds.test`, name: null });
    orgId = (await createOrg(runtime, asUser(owner), `Holds ${randomUUID().slice(0, 6)}`)).orgId;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    store.refuse = null;
    store.lockEnabled = true;
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

  it('holds the original file of a posted invoice from its posting, records it once, and never holds an unposted file', async () => {
    const posted = await invoiceFile(true);
    const pending = await invoiceFile(false);
    expect(await run()).toEqual({ held: 1, failed: 0, waiting: 0 });
    const until = holdFor(posted.postedUs, 3650);
    expect(store.calls.map((c) => c.ref.key)).toEqual([posted.storageKey]);
    expect(store.calls[0]?.until).toEqual(until);
    expect(await holdRow(posted.fileId)).toMatchObject({ held_until: until, hold_attempts: 0, hold_error: null });
    expect(await holdRow(pending.fileId)).toMatchObject({ held_until: null, hold_attempted_at: null });
    // Done: the next run finds nothing to hold.
    expect(await run()).toEqual({ held: 0, failed: 0, waiting: 0 });
    expect(store.calls).toHaveLength(1);
    // The hold is audited as a system command.
    const { rows } = await admin((c) => c.query("SELECT count(*)::int AS n FROM crove_kernel.audit_event WHERE command = 'kernel.file.hold.record' AND org_id = $1", [orgId]));
    expect(rows[0]?.n).toBe(1);
  });

  it('records a refused hold with its reason, leaves the posting alone, and tries again after the backoff', async () => {
    const posted = await invoiceFile(true);
    store.refuse = new BlobNotFoundError(posted.storageKey);
    const alert = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await run()).toEqual({ held: 0, failed: 1, waiting: 0 });
    expect(alert.mock.calls.flat().join(' ')).toMatch(/ALERT 1 retention hold\(s\) failed/);
    expect(await holdRow(posted.fileId)).toMatchObject({ held_until: null, hold_attempts: 1, hold_error: 'BLOB_NOT_FOUND' });
    // Other failures are recorded by the error's name only; the message (bucket, request id) stays in the log.
    expect(holdErrorText(Object.assign(new Error('Access Denied on crove-prod'), { name: 'AccessDenied' }))).toBe('STORE_ERROR:AccessDenied');
    expect(holdErrorText(Object.assign(new Error('x'), { name: 'not a name!' }))).toBe('STORE_ERROR');
    // The posting stands.
    const { rows } = await admin((c) => c.query('SELECT count(*)::int AS n FROM crove_finance.purchase_document WHERE source_file_id = $1', [posted.fileId]));
    expect(rows[0]?.n).toBe(1);
    // Within the backoff nothing is tried; past it, the hold is set and the error cleared.
    store.refuse = null;
    expect(await run()).toEqual({ held: 0, failed: 0, waiting: 0 });
    await pastBackoff(posted.fileId);
    expect(await run()).toEqual({ held: 1, failed: 0, waiting: 0 });
    expect(await holdRow(posted.fileId)).toMatchObject({ held_until: expect.any(Date), hold_attempts: 0, hold_error: null });
  });

  it('records nothing per file on a bucket without Object Lock or a store without holds, and alerts once a day', async () => {
    const posted = await invoiceFile(true);
    store.lockEnabled = false;
    const alert = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const state = { unavailableReportedAt: 0 };
    expect(await run(3650, state)).toEqual({ held: 0, failed: 0, waiting: 1 });
    expect(await run(3650, state)).toEqual({ held: 0, failed: 0, waiting: 1 });
    expect(alert.mock.calls.filter((c) => String(c[0]).includes('has no Object Lock'))).toHaveLength(1);
    expect(await holdRow(posted.fileId)).toMatchObject({ held_until: null, hold_attempted_at: null, hold_attempts: 0 });
    // Local disk: no holds API at all, nothing attempted.
    const plain = { put: store.put.bind(store), get: store.get.bind(store), delete: store.delete.bind(store) } satisfies BlobStore;
    expect(await run(3650, state, plain)).toEqual({ held: 0, failed: 0, waiting: 0 });
    // Holds off.
    store.lockEnabled = true;
    expect(await run(0)).toEqual({ held: 0, failed: 0, waiting: 0 });
    expect(await holdRow(posted.fileId)).toMatchObject({ held_until: null });
    expect(await run()).toMatchObject({ held: 1 });
  });

  it('lengthens a hold when the period grows and never shortens one when it shrinks', async () => {
    const posted = await invoiceFile(true);
    await run();
    const tenYears = (await holdRow(posted.fileId))?.held_until as Date;
    expect(await run(3000)).toEqual({ held: 0, failed: 0, waiting: 0 });
    expect((await holdRow(posted.fileId))?.held_until).toEqual(tenYears);
    // Every posted file of the run gets the longer hold, this one among them.
    const longer = await run(4015);
    expect(longer.held).toBeGreaterThanOrEqual(1);
    expect(longer.failed).toBe(0);
    expect((await holdRow(posted.fileId))?.held_until).toEqual(holdFor(posted.postedUs, 4015));
  });

  // #1664: a posting a few microseconds past a whole second is held to the next second, which a millisecond Date reads
  // as the same second; one on the whole second stays on it.
  it('rounds the hold up to the second from the microseconds of the posting', async () => {
    const setPostedAt = (journalEntryId: string, at: string) =>
      admin(async (c) => {
        await c.query('BEGIN');
        await c.query("SET LOCAL session_replication_role = 'replica'");
        await c.query('UPDATE crove_finance.journal_entry SET created_at = $2::timestamptz WHERE id = $1', [journalEntryId, at]);
        await c.query('COMMIT');
      });
    for (const [at, until] of [
      ['2026-10-24T12:03:18.000400Z', '2036-10-21T12:03:19.000Z'],
      ['2026-10-24T12:03:18.999999Z', '2036-10-21T12:03:19.000Z'],
      ['2026-10-24T12:03:18.000000Z', '2036-10-21T12:03:18.000Z'],
    ] as const) {
      const posted = await invoiceFile(true);
      await setPostedAt(posted.journalEntryId as string, at);
      const us = await postedUs(posted.journalEntryId as string);
      // What the old test computed from a millisecond Date, wrong by a second for the first case.
      const fromMs = new Date(Math.ceil((Number(us / 1000n) + 3650 * DAY) / 1000) * 1000);
      await run();
      expect((await holdRow(posted.fileId))?.held_until, at).toEqual(new Date(until));
      expect(holdFor(us, 3650), at).toEqual(new Date(until));
      if (at.endsWith('.000400Z')) expect(fromMs).not.toEqual(new Date(until));
    }
  });
});
