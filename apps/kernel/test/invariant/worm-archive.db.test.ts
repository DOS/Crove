// The WORM fact stream (plan §4.10, issue #891, Phase 1 exit criterion 3) on a real PostgreSQL 17. The worker
// anchors every audit event and journal entry, across orgs, in a hash-chained archive, and the nightly verifier
// recomputes them from the database. The database owner (here a superuser) disables a trigger and edits a journal
// line, deletes an audit event and inserts a backdated one: the verifier fails on each, and its job fails (the prober
// alerts on the dead letter). Only the worker may run the archive functions; nobody may rewrite a recorded batch.
// Part of the invariant suite: CI runs this file from the base branch on protected-path PRs (AGENTS.md).
// Set CROVE_TEST_ADMIN_URL to a superuser URL; the run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, statSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import {
  ArchiveMismatchError,
  ArchiveObjectExistsError,
  LocalArchiveStore,
  archiveKey,
  runArchiveVerification,
  verifyArchive,
  writeArchive,
  type ArchiveStore,
} from '../../src/worm.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const ARCHIVE_FUNCTIONS = [
  'crove_kernel.archive_row_hashes(timestamptz,timestamptz)',
  'crove_kernel.archive_next_window(int)',
  'crove_kernel.archive_head()',
  'crove_kernel.archive_batches()',
  'crove_kernel.archive_record(bigint,timestamptz,timestamptz,int,text,text,text)',
  'crove_kernel.archive_verified(boolean,int,bigint,jsonb)',
];

const suite = ADMIN ? describe : describe.skip;

suite('WORM fact stream: archive and tamper detection on PostgreSQL (#891)', () => {
  const dbName = `crove_test_worm_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let db: Db;
  let worker: Db;
  let runtime: Runtime;
  let dir = '';
  let store: LocalArchiveStore;
  const orgs: string[] = [];
  const users: string[] = [];

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  const login = (user: string, password: string) => {
    const url = new URL(adminUrl);
    url.username = user;
    url.password = password;
    return url.toString();
  };

  async function post(userId: string, orgId: string, amount: string): Promise<string> {
    return db.transaction().execute(async (trx) => {
      await sql`SELECT crove_kernel.enter_context(${userId}::uuid, ${orgId}::uuid)`.execute(trx);
      const lines = [
        { line_no: 1, account_code: '6422', debit: amount, credit: '0' },
        { line_no: 2, account_code: '331', debit: '0', credit: amount },
      ];
      const { rows } = await sql<{ id: string }>`
        SELECT crove_finance.post_journal_entry('2026-10-01', 'worm test', 'test', ${randomUUID()}::uuid, ${JSON.stringify(lines)}::jsonb) AS id`.execute(trx);
      return rows[0]?.id ?? '';
    });
  }

  // Everything written so far moves an hour back, past the archiver's lag. Triggers are off for this (replica mode)
  // as only a superuser can do; it is setup, not part of what is checked.
  async function age(): Promise<void> {
    await admin(async (c) => {
      await c.query(`SET session_replication_role = replica`);
      await c.query(`UPDATE crove_kernel.audit_event SET occurred_at = occurred_at - interval '1 hour' WHERE occurred_at > now() - interval '50 minutes'`);
      await c.query(`UPDATE crove_finance.journal_entry SET created_at = created_at - interval '1 hour' WHERE created_at > now() - interval '50 minutes'`);
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
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    pool = createPool({ connectionString: login('crove_app', 'test-app-pw'), max: 4 });
    db = createDb(pool);
    workerPool = createPool({ connectionString: login('crove_worker', 'test-worker-pw'), max: 2 });
    worker = createDb(workerPool);
    runtime = new Runtime(db).register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) });
    for (const name of ['a', 'b']) {
      const userId = await upsertIdentity(db, { issuer: 'test', subject: `worm-${name}`, email: `worm-${name}@example.com`, name: null });
      const { orgId } = await createOrg(runtime, { type: 'user', userId, aal: 'aal1' }, `Org ${name.toUpperCase()}`);
      users.push(userId);
      orgs.push(orgId);
      await post(userId, orgId, '100000');
      await post(userId, orgId, '250001');
    }
    await age();
    dir = mkdtempSync(join(tmpdir(), 'crove-worm-'));
    store = new LocalArchiveStore(dir);
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await workerPool?.end();
    if (dir) {
      // The batches are read-only files.
      rmSync(dir, { recursive: true, force: true });
    }
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('lets only the worker run the archive functions, and no runtime role read or write the archive tables', async () => {
    const grants = await admin(async (c) => {
      const { rows } = await c.query<{ fn: string; role: string; allowed: boolean }>(
        `SELECT f AS fn, r AS role, has_function_privilege(r, f, 'EXECUTE') AS allowed
         FROM unnest($1::text[]) f CROSS JOIN unnest(ARRAY['crove_app', 'crove_worker', 'crove_tenant', 'crove_definer_tenant', 'crove_prober']) r`,
        [ARCHIVE_FUNCTIONS],
      );
      return rows.filter((r) => r.allowed).map((r) => `${r.role} ${r.fn}`);
    });
    expect(grants.sort()).toEqual(ARCHIVE_FUNCTIONS.map((f) => `crove_worker ${f}`).sort());
    const tables = await admin(async (c) => {
      const { rows } = await c.query<{ grantee: string }>(
        `SELECT grantee FROM information_schema.role_table_grants
         WHERE table_schema = 'crove_kernel' AND table_name IN ('archive_batch', 'archive_verification')`,
      );
      return rows.map((r) => r.grantee).filter((g) => g !== 'postgres' && g !== 'crove_owner');
    });
    expect(tables).toEqual([]);
    // The app login cannot run them even by name.
    await expect(sql`SELECT * FROM crove_kernel.archive_head()`.execute(db)).rejects.toThrow(/permission denied/);
  });

  it('anchors every audit event and journal entry of every org in chained, read-only batches', async () => {
    const written = await writeArchive(worker, store, { lagSeconds: 600 });
    expect(written).toBeGreaterThan(0);
    // Nothing more is due.
    expect(await writeArchive(worker, store, { lagSeconds: 600 })).toBe(0);

    const counts = await admin(async (c) => ({
      audit: Number((await c.query(`SELECT count(*) AS n FROM crove_kernel.audit_event`)).rows[0].n),
      journal: Number((await c.query(`SELECT count(*) AS n FROM crove_finance.journal_entry`)).rows[0].n),
      orgsInJournal: Number((await c.query(`SELECT count(DISTINCT org_id) AS n FROM crove_finance.journal_entry`)).rows[0].n),
    }));
    expect(counts.journal).toBe(4);
    expect(counts.orgsInJournal).toBe(2);
    const keys = await store.list('chain/v1/');
    expect(keys).toEqual(Array.from({ length: written }, (_, i) => archiveKey(i + 1)));
    const batches = await Promise.all(keys.map(async (k) => JSON.parse(new TextDecoder().decode((await store.get(k)) as Uint8Array))));
    const refs = batches.flatMap((b: { rows: Array<[string, string]> }) => b.rows.map(([ref]) => ref));
    expect(refs.filter((r) => r.startsWith('audit:'))).toHaveLength(counts.audit);
    expect(refs.filter((r) => r.startsWith('journal:'))).toHaveLength(counts.journal);
    // Each batch's rows span at most 5 minutes of their window, and each window starts where the last one ended.
    batches.forEach((b: { window: { from: string; to: string }; seq: number }, i: number) => {
      if (i > 0) expect(b.window.from).toBe(batches[i - 1].window.to);
    });
    // Hashes and references only. A later batch version may also anchor a journal entry's legal entity under its own
    // reference (entity:journal:<org>:<id>, #1489).
    for (const b of batches) for (const [ref, hash] of b.rows as Array<[string, string]>) expect([ref, hash]).toEqual([expect.stringMatching(/^(entity:)?(audit:|journal:)[0-9a-f:-]+$/), expect.stringMatching(/^[0-9a-f]{64}$/)]);
    // Written once, read-only.
    for (const key of keys) expect(statSync(join(dir, key)).mode & 0o222).toBe(0);
    await expect(store.put(keys[0] as string, new Uint8Array([1]))).rejects.toBeInstanceOf(ArchiveObjectExistsError);

    // The verifier checks every anchored row: each audit event and journal entry, plus whatever rows a later batch
    // version anchors for them (the legal entity rows of version 3, #1489).
    const result = await runArchiveVerification(worker, store);
    expect(result).toMatchObject({ ok: true, batches: written, rows: refs.length, problems: [] });
    const recorded = await admin(async (c) => (await c.query(`SELECT ok, batches, rows_checked FROM crove_kernel.archive_verification ORDER BY verified_at DESC LIMIT 1`)).rows[0]);
    expect(recorded).toEqual({ ok: true, batches: written, rows_checked: String(refs.length) });
  });

  it('keeps the recorded batches append-only, in order', async () => {
    await admin(async (c) => {
      await expect(c.query(`UPDATE crove_kernel.archive_batch SET row_count = row_count + 1`)).rejects.toThrow();
      await expect(c.query(`DELETE FROM crove_kernel.archive_batch`)).rejects.toThrow();
    });
    const head = (await sql<{ seq: string; window_to: Date }>`SELECT * FROM crove_kernel.archive_head()`.execute(worker)).rows[0];
    const hash = 'a'.repeat(64);
    // A sequence that skips one, or a window that does not start at the head's end, is refused.
    await expect(
      sql`SELECT crove_kernel.archive_record(${Number(head?.seq) + 2}::bigint, ${head?.window_to}::timestamptz, now(), 0, ${hash}, ${hash}, 'x')`.execute(worker),
    ).rejects.toThrow(/ARCHIVE_OUT_OF_ORDER/);
    await expect(
      sql`SELECT crove_kernel.archive_record(${Number(head?.seq) + 1}::bigint, 'epoch'::timestamptz, now(), 0, ${hash}, ${hash}, 'x')`.execute(worker),
    ).rejects.toThrow(/ARCHIVE_OUT_OF_ORDER/);
  });

  it('fails the verifier when the database owner disables the trigger and edits a line, deletes an event or backdates one', async () => {
    const entry = await admin(async (c) => (await c.query<{ org_id: string; id: string }>(`SELECT org_id, id FROM crove_finance.journal_entry ORDER BY created_at LIMIT 1`)).rows[0]);
    const deleted = await admin(async (c) => (await c.query<{ id: string }>(`SELECT id FROM crove_kernel.audit_event ORDER BY occurred_at LIMIT 1`)).rows[0]?.id);
    const backdated = randomUUID();
    await admin(async (c) => {
      // The owner turns the append-only trigger off and moves 1 dong between the two sides: the entry still balances.
      await c.query(`ALTER TABLE crove_finance.journal_line DISABLE TRIGGER USER`);
      await c.query(`UPDATE crove_finance.journal_line SET debit = debit + 1 WHERE org_id = $1 AND entry_id = $2 AND line_no = 1`, [entry?.org_id, entry?.id]);
      await c.query(`UPDATE crove_finance.journal_line SET credit = credit + 1 WHERE org_id = $1 AND entry_id = $2 AND line_no = 2`, [entry?.org_id, entry?.id]);
      await c.query(`ALTER TABLE crove_finance.journal_line ENABLE TRIGGER USER`);
      await c.query(`SET session_replication_role = replica`);
      await c.query(`DELETE FROM crove_kernel.audit_event WHERE id = $1`, [deleted]);
      // A row slipped into a window already archived.
      await c.query(
        `INSERT INTO crove_kernel.audit_event (org_id, id, occurred_at, actor_type, actor_id, command, command_id, outcome, target_type, target_id, input_sha256, detail)
         SELECT org_id, $1, occurred_at, actor_type, actor_id, command, gen_random_uuid(), outcome, target_type, target_id, input_sha256, detail
         FROM crove_kernel.audit_event ORDER BY occurred_at LIMIT 1`,
        [backdated],
      );
    });

    const result = await verifyArchive(worker, store);
    expect(result.ok).toBe(false);
    expect(result.problems.map((p) => [p.code, p.ref])).toEqual(
      expect.arrayContaining([
        ['row_changed', `journal:${entry?.org_id}:${entry?.id}`],
        ['row_missing', `audit:${deleted}`],
        ['row_added', `audit:${backdated}`],
      ]),
    );
    // The nightly job fails, with codes only in its message, so pg-boss keeps it as a dead letter.
    const failure = await runArchiveVerification(worker, store).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ArchiveMismatchError);
    expect((failure as Error).message).toMatch(/^ARCHIVE_MISMATCH: \d+ problem\(s\) over \d+ batch\(es\): .*row_changed/);
    expect((failure as Error).message).not.toContain(entry?.id as string);
    // The recorded result names references and codes only.
    const recorded = await admin(async (c) => (await c.query(`SELECT problems FROM crove_kernel.archive_verification ORDER BY verified_at DESC LIMIT 1`)).rows[0]?.problems);
    expect(recorded).toEqual(result.problems);
  });

  it('fails the verifier when a batch in the store is rewritten or removed', async () => {
    const first = join(dir, archiveKey(1));
    const batch = JSON.parse(readFileSync(first, 'utf8'));
    batch.rows = batch.rows.slice(1);
    chmodSync(first, 0o644);
    writeFileSync(first, JSON.stringify(batch));
    const result = await verifyArchive(worker, store);
    expect(result.problems.map((p) => p.code)).toEqual(expect.arrayContaining(['batch_hash_mismatch']));

    const keys = await store.list('chain/v1/');
    const last = join(dir, keys.at(-1) as string);
    rmSync(last, { force: true });
    const after = await verifyArchive(worker, store);
    expect(after.problems).toEqual(expect.arrayContaining([{ code: 'object_missing', seq: keys.length }]));
  });

  it('fails the batch write when the store refuses it, and writes nothing out of order', async () => {
    await post(users[0] as string, orgs[0] as string, '42');
    // After the archived windows, before the lag: due now.
    await admin(async (c) => {
      await c.query(`SET session_replication_role = replica`);
      await c.query(`UPDATE crove_finance.journal_entry SET created_at = now() - interval '20 minutes' WHERE created_at > now() - interval '5 minutes'`);
    });
    const refusing: ArchiveStore = {
      put: async () => {
        throw new Error('store unreachable');
      },
      get: async (key) => store.get(key),
      list: async (prefix) => store.list(prefix),
      describe: () => 'refusing',
    };
    const before = await admin(async (c) => Number((await c.query(`SELECT count(*) AS n FROM crove_kernel.archive_batch`)).rows[0].n));
    await expect(writeArchive(worker, refusing, { lagSeconds: 600 })).rejects.toThrow('store unreachable');
    expect(await admin(async (c) => Number((await c.query(`SELECT count(*) AS n FROM crove_kernel.archive_batch`)).rows[0].n))).toBe(before);
  });

  it('lets two runs at once write each batch once, the loser going on from the new head', async () => {
    await post(users[1] as string, orgs[1] as string, '7');
    await admin(async (c) => {
      await c.query(`SET session_replication_role = replica`);
      await c.query(`UPDATE crove_finance.journal_entry SET created_at = now() - interval '15 minutes' WHERE created_at > now() - interval '5 minutes'`);
    });
    const before = await admin(async (c) => Number((await c.query(`SELECT count(*) AS n FROM crove_kernel.archive_batch`)).rows[0].n));
    const [a, b] = await Promise.all([writeArchive(worker, store, { lagSeconds: 600 }), writeArchive(worker, store, { lagSeconds: 600 })]);
    const after = await admin(async (c) => (await c.query<{ seq: string; object_key: string }>(`SELECT seq, object_key FROM crove_kernel.archive_batch WHERE seq > $1 ORDER BY seq`, [before])).rows);
    expect(after.length).toBeGreaterThan(0);
    expect(a + b).toBe(after.length);
    for (const row of after) expect(await store.get(row.object_key)).not.toBeNull();
  });
});
