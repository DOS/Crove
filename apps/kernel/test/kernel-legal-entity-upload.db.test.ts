// A member limited to one legal entity keeps sight of what it uploads (#1280 part 3a) on PostgreSQL 17: the worker's
// first reading of its file takes the member's entity, so the member sees the reading in its file list, gets the
// unreadable-file notice and reads the file again, while another member limited elsewhere sees none of it. Set
// CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { InvoiceExtractor } from '@crove/agent';
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
const SYSTEM = { type: 'system' as const, component: 'kernel.notify' };

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

interface FileStatus {
  id: string;
  status: string;
  version: number | null;
  canReextract: boolean;
}

const suite = ADMIN ? describe : describe.skip;

suite('uploads of a member limited to a legal entity (#1280)', () => {
  const dbName = `crove_test_le_upload_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let runtime: Runtime;
  let workerRuntime: Runtime;
  const store = new MemoryStore();
  let extract: ExtractClient;
  let orgId = '';
  let owner = '';
  let accountant = '';
  let other = '';
  let branch = '';
  // Every reading fails, so each file ends with an unreadable-file notice to its uploader.
  const ai = { fromText: async () => null, fromImage: async () => null } as unknown as InvoiceExtractor;
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  async function upload(userId: string): Promise<string> {
    const bytes = randomBytes(64);
    const sha256 = sha256Hex(bytes);
    const storageKey = fileKey(orgId, sha256);
    const generation = await store.put(storageKey, bytes);
    const { fileId } = await runtime.execute<{ fileId: string }>(
      'kernel.file.ingest',
      { filename: 'hd.png', contentType: 'image/png', sizeBytes: bytes.byteLength, sha256, storageKey, generation, source: 'upload' },
      { actor: asUser(userId), orgId },
    );
    return fileId;
  }
  const recent = async (fileId: string, userId: string) =>
    (await runtime.query<FileStatus[]>('kernel.files.recent', {}, { actor: asUser(userId), orgId })).find((f) => f.id === fileId);
  // Runs the dispatch of the org's unreadable-file events, as the worker's kernel-notify job does.
  async function dispatchUnreadable() {
    const { rows } = await admin((c) => c.query<{ id: string }>(`SELECT id FROM crove_kernel.outbox_event WHERE org_id = $1 AND type = 'kernel.file.read_failed'`, [orgId]));
    for (const { id } of rows) await workerRuntime.execute('kernel.notification.dispatch', { eventId: id }, { actor: SYSTEM, orgId });
  }
  const notices = async (userId: string) =>
    (await runtime.query<{ items: Array<{ kind: string; subjectId: string | null }> }>('kernel.notification.list', {}, { actor: asUser(userId), orgId })).items;

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
      const u = new URL(adminUrl);
      u.username = username;
      u.password = password;
      return u.toString();
    };
    const register = (url: string) => {
      const pool = createPool({ connectionString: url, max: 4 });
      pools.push(pool);
      const db: Db = createDb(pool);
      return { db, runtime: new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands, ...financeCommands], queries: [...kernelQueries({ inboundDomain: 'in.test' }), ...financeQueries] }) };
    };
    const api = register(login('crove_app', 'test-app-pw'));
    runtime = api.runtime;
    workerRuntime = register(login('crove_worker', 'test-worker-pw')).runtime;
    owner = await upsertIdentity(api.db, { issuer: 'test', subject: 'le-upload-owner', email: 'owner@le-upload.test', name: null });
    accountant = await upsertIdentity(api.db, { issuer: 'test', subject: 'le-upload-accountant', email: 'accountant@le-upload.test', name: null });
    other = await upsertIdentity(api.db, { issuer: 'test', subject: 'le-upload-other', email: 'other@le-upload.test', name: null });
    orgId = (await createOrg(runtime, asUser(owner), 'Hai pháp nhân')).orgId;
    await admin(async (c) => {
      const defaultEntity = (await c.query<{ id: string }>('SELECT id FROM crove_kernel.legal_entity WHERE org_id = $1 AND is_default', [orgId])).rows[0]?.id as string;
      branch = (await c.query<{ id: string }>(`INSERT INTO crove_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhánh', 'branch', $2) RETURNING id`, [orgId, owner]))
        .rows[0]?.id as string;
      // The accountant keeps the branch's books; the other member keeps the default entity's.
      await c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member')`, [orgId, accountant, other]);
      await c.query(
        `INSERT INTO crove_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by) VALUES ($1, $2, 'external_accountant', $3, $5), ($1, $4, 'external_accountant', $6, $5)`,
        [orgId, accountant, branch, other, owner, defaultEntity],
      );
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

  it('gives the first reading of its upload the uploader entity, so it sees the reading, the notice and reads again', async () => {
    const fileId = await upload(accountant);
    await extractAndPropose({ runtime: workerRuntime, store, extractor: ai, extract }, orgId, fileId);
    const entity = await admin((c) => c.query<{ legal_entity_id: string }>('SELECT legal_entity_id FROM crove_kernel.extraction WHERE org_id = $1 AND file_id = $2', [orgId, fileId]));
    expect(entity.rows).toEqual([{ legal_entity_id: branch }]);

    expect(await recent(fileId, accountant)).toMatchObject({ status: 'failed', version: 1, canReextract: true });
    await dispatchUnreadable();
    const unreadable = (await notices(accountant)).filter((n) => n.kind === 'kernel.file_unreadable' && n.subjectId === fileId);
    expect(unreadable).toHaveLength(1);

    const { version } = await runtime.execute<{ version: number }>('kernel.file.reextract', { fileId }, { actor: asUser(accountant), orgId });
    expect(version).toBe(2);
    expect(await recent(fileId, accountant)).toMatchObject({ status: 'processing', version: 2 });
    const runs = await admin((c) => c.query<{ legal_entity_id: string }>('SELECT DISTINCT legal_entity_id FROM crove_kernel.extraction WHERE org_id = $1 AND file_id = $2', [orgId, fileId]));
    expect(runs.rows).toEqual([{ legal_entity_id: branch }]);

    // A member limited to the default entity sees no reading of it; the owner sees it all.
    expect(await recent(fileId, other)).toMatchObject({ version: null, canReextract: false });
    expect(await recent(fileId, owner)).toMatchObject({ version: 2 });
  });

  it("keeps an owner's upload in the default entity", async () => {
    const fileId = await upload(owner);
    await extractAndPropose({ runtime: workerRuntime, store, extractor: ai, extract }, orgId, fileId);
    expect(await recent(fileId, other)).toMatchObject({ status: 'failed', version: 1 });
    expect(await recent(fileId, accountant)).toMatchObject({ version: null });
  });
});
