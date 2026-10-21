// Per-org abuse limits on PostgreSQL 17 (#675): the sliding 24-hour window of crove_kernel.org_usage, what the worker
// records, deferrals that keep an item and mail the owners once per metric a day, an inbound message and a document
// kept for the org's next budget, and the use counted when they go through. Set CROVE_TEST_ADMIN_URL to a superuser
// URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { DEFAULT_USAGE_LIMITS, WAITING_FOR_BUDGET, createOrg, kernelCommands, kernelQueries, upsertIdentity, type UsageLimits, type UsageOver } from '@crove/kernel';
import { Runtime, fileKey, inboundKey, newInboundBlobId, sha256Hex, type BlobStore } from '@crove/kernel-runtime';
import { aiCost, extractAndPropose, financeCommands, financeQueries } from '@crove/mod-finance';
import type { ExtractClient } from '@crove/extract-contract';
import { processInboundEmail } from '../src/inbound.ts';
import { renderUsageDeferredMail } from '../src/usage-deferred-mail.ts';
import { inProcessExtract } from './extract-service.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const FIXTURE = readFileSync(new URL('../../extract/test/fixtures/einvoice-basic.xml', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

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

describe('the abuse-limit mail (#675)', () => {
  const input = (payload: Record<string, unknown>) => ({ subject: null, payload, publicUrl: 'https://crove.example/' }) as Parameters<typeof renderUsageDeferredMail>[0];

  it('names the limit, says nothing is lost and links the Inbox', async () => {
    const mail = await renderUsageDeferredMail(input({ metric: 'extraction_pages', org: 'Công ty <A>', retryAt: '2026-10-21T07:05:00.000Z', path: '/o/cong-ty-a/inbox' }));
    expect(mail?.text).toContain('số trang đọc chứng từ');
    expect(mail?.text).toContain('14:05 ngày 21/10/2026');
    expect(mail?.text).toContain('không bị mất');
    expect(mail?.text).toContain('https://crove.example/o/cong-ty-a/inbox');
    expect(mail?.html).toContain('Công ty &lt;A&gt;');
  });

  it('renders nothing for a payload it does not know', async () => {
    const ok = { metric: 'ai_cost', org: 'A', retryAt: '2026-10-21T07:05:00.000Z', path: '/o/a/inbox' };
    for (const bad of [{ metric: 'pages' }, { path: 'https://evil.example/o/a/inbox' }, { path: '/o/a/inbox/../settings' }, { retryAt: 'tomorrow' }, { org: 1 }]) {
      expect(await renderUsageDeferredMail(input({ ...ok, ...bad }))).toBeNull();
    }
  });

  it('prices AI calls per million tokens, as a decimal string', () => {
    const price = { inputPerMTok: '0.15', outputPerMTok: '0.6' };
    expect(aiCost([{ inputTokens: 2000, outputTokens: 500 }, { inputTokens: 1000, outputTokens: 0 }], price)).toBe('0.000750');
    expect(aiCost([{ inputTokens: 2000, outputTokens: 500 }], undefined)).toBe('0');
    expect(aiCost([], price)).toBe('0.000000');
  });
});

suite('per-org abuse limits on PostgreSQL (#675)', () => {
  const dbName = `crove_test_usage_limits_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  let workerPool: pg.Pool;
  let worker: Runtime;
  let extract: ExtractClient;
  const store = new MemoryStore();
  const system = { type: 'system' as const, component: 'test' };
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  async function org(): Promise<{ orgId: string; owner: string; token: string }> {
    const owner = await upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `owner-${randomUUID().slice(0, 8)}@limits.test`, name: null });
    const { orgId } = await createOrg(rt, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    const token = await admin(async (c) => (await c.query<{ t: string }>('SELECT inbound_token AS t FROM crove_kernel.tenant WHERE org_id = $1', [orgId])).rows[0]?.t ?? '');
    return { orgId, owner, token };
  }

  const used = (orgId: string, metric: string, amount: string, hoursAgo: number) =>
    admin((c) => c.query("INSERT INTO crove_kernel.org_usage (org_id, metric, amount, created_at) VALUES ($1, $2, $3, now() - make_interval(secs => $4 * 3600))", [orgId, metric, amount, hoursAgo]));
  const over = (orgId: string, metrics: string[], limits: Partial<UsageLimits>) => worker.query<UsageOver | null>('kernel.usage.over', { metrics, limits }, { actor: system, orgId });
  const usageOf = (orgId: string) =>
    admin(async (c) => (await c.query<{ metric: string; amount: string }>('SELECT metric, sum(amount)::text AS amount FROM crove_kernel.org_usage WHERE org_id = $1 GROUP BY metric ORDER BY metric', [orgId])).rows);
  const deferrals = (orgId: string) =>
    admin(async (c) => (await c.query<{ metric: string; subject_type: string; subject_id: string; notified: boolean }>('SELECT metric, subject_type, subject_id, notified FROM crove_kernel.usage_deferral WHERE org_id = $1 ORDER BY created_at, id', [orgId])).rows);
  const mails = (orgId: string) =>
    admin(async (c) => (await c.query<{ to_address: string; template_key: string; payload: Record<string, unknown> }>("SELECT to_address, template_key, payload FROM crove_kernel.mail_message WHERE org_id = $1 AND source = 'kernel.usage.defer' ORDER BY created_at", [orgId])).rows);

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
    const registry = { commands: [...kernelCommands, ...financeCommands], queries: [...kernelQueries({ inboundDomain: 'in.test' }), ...financeQueries] };
    rt = new Runtime(db).register(registry);
    const asWorker = new URL(adminUrl);
    asWorker.username = 'crove_worker';
    asWorker.password = 'test-worker-pw';
    workerPool = createPool({ connectionString: asWorker.toString(), max: 2 });
    worker = new Runtime(createDb(workerPool)).register(registry);
    extract = inProcessExtract();
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

  it('counts the last 24 hours, and says when enough of them has passed', async () => {
    const o = await org();
    await used(o.orgId, 'inbound_emails', '1', 23);
    await used(o.orgId, 'inbound_emails', '1', 10);
    await used(o.orgId, 'inbound_emails', '1', 1);
    // Use older than the window does not count.
    await used(o.orgId, 'inbound_emails', '100', 25);
    expect(await over(o.orgId, ['inbound_emails'], { inbound_emails: '4' })).toBeNull();

    const at3 = await over(o.orgId, ['inbound_emails'], { inbound_emails: '3' });
    expect(at3).toMatchObject({ metric: 'inbound_emails', used: '3.000000', limit: '3' });
    // Under 3 again once the oldest row leaves the window: in about one hour.
    const in1h = Date.parse(at3?.retryAt ?? '') - Date.now();
    expect(in1h).toBeGreaterThan(59 * 60_000);
    expect(in1h).toBeLessThan(61 * 60_000);
    // Under 2 again only once the second row leaves too: in about 14 hours.
    const at2 = await over(o.orgId, ['inbound_emails'], { inbound_emails: '2' });
    const in14h = Date.parse(at2?.retryAt ?? '') - Date.now();
    expect(in14h).toBeGreaterThan(14 * 3600_000 - 60_000);
    expect(in14h).toBeLessThan(14 * 3600_000 + 60_000);

    // Other metrics and other orgs are counted apart; the first metric over its limit is named.
    const other = await org();
    expect(await over(other.orgId, ['inbound_emails'], { inbound_emails: '1' })).toBeNull();
    await used(o.orgId, 'ai_cost', '0.5', 2);
    expect(await over(o.orgId, ['extraction_pages', 'ai_cost'], { extraction_pages: '10', ai_cost: '0.5' })).toMatchObject({ metric: 'ai_cost' });
    expect(await over(o.orgId, ['extraction_pages', 'ai_cost'], { extraction_pages: '10', ai_cost: '0.500001' })).toBeNull();
  });

  it('records use for the worker only, and keeps the rows from tenants', async () => {
    const o = await org();
    await worker.execute('kernel.usage.record', { entries: [{ metric: 'extraction_pages', amount: '3' }, { metric: 'ai_cost', amount: '0.000000' }] }, { actor: system, orgId: o.orgId });
    expect(await usageOf(o.orgId)).toEqual([{ metric: 'extraction_pages', amount: '3.000000' }]);
    for (const [name, input] of [
      ['kernel.usage.record', { entries: [{ metric: 'extraction_pages', amount: '1' }] }],
      ['kernel.usage.defer', { metric: 'extraction_pages', subjectType: 'file', subjectId: randomUUID(), retryAt: new Date().toISOString() }],
    ] as const) {
      await expect(rt.execute(name, input, { actor: asUser(o.owner), orgId: o.orgId })).rejects.toMatchObject({ status: 403 });
    }
    await expect(rt.query('kernel.usage.over', { metrics: ['ai_cost'], limits: { ai_cost: '1' } }, { actor: asUser(o.owner), orgId: o.orgId })).rejects.toMatchObject({ status: 403 });
    const grants = await admin(async (c) =>
      (
        await c.query<{ t: string; update: boolean; delete: boolean }>(
          `SELECT t, has_table_privilege('crove_tenant', t, 'UPDATE') AS update, has_table_privilege('crove_tenant', t, 'DELETE') AS delete
           FROM unnest(ARRAY['crove_kernel.org_usage', 'crove_kernel.usage_deferral']) t ORDER BY t`,
        )
      ).rows,
    );
    expect(grants).toEqual([
      { t: 'crove_kernel.org_usage', update: false, delete: false },
      { t: 'crove_kernel.usage_deferral', update: false, delete: false },
    ]);
  });

  it('keeps a deferred item, and mails the owners once per limit in 24 hours', async () => {
    const o = await org();
    const retryAt = new Date(Date.now() + 3600_000).toISOString();
    const defer = (metric: string) =>
      worker.execute<{ notified: boolean; queued: number }>('kernel.usage.defer', { metric, subjectType: 'inbound_email', subjectId: 'a'.repeat(64), retryAt }, { actor: system, orgId: o.orgId });
    expect(await defer('inbound_emails')).toEqual({ notified: true, queued: 1 });
    expect(await defer('inbound_emails')).toEqual({ notified: false, queued: 0 });
    expect(await defer('attachment_bytes')).toEqual({ notified: true, queued: 1 });
    expect((await deferrals(o.orgId)).map((d) => [d.metric, d.notified])).toEqual([
      ['inbound_emails', true],
      ['inbound_emails', false],
      ['attachment_bytes', true],
    ]);
    const sent = await mails(o.orgId);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({ template_key: 'kernel.usage.deferred', payload: { metric: 'inbound_emails', retryAt } });
    expect(String(sent[0]?.payload.path)).toMatch(/^\/o\/[a-z0-9-]+\/inbox$/);
    const owner = await admin(async (c) => (await c.query<{ email: string }>('SELECT email FROM crove_kernel.user_account WHERE id = $1', [o.owner])).rows[0]?.email);
    expect(sent[0]?.to_address).toBe(owner);
  });

  // An inbound message whose only attachment is the fixture invoice under a new number.
  async function message(token: string, number: string) {
    const xml = FIXTURE.toString('utf8').replace('<SHDon>1234</SHDon>', `<SHDon>${number}</SHDon>`);
    const attachment = Buffer.from(xml).toString('base64').replace(/.{76}/g, '$&\r\n');
    const mime = [
      'From: Nha cung cap <ketoan@vendor.example>',
      `To: ${token}@in.test`,
      `Subject: Hoa don ${number}`,
      `Message-ID: <hd-${number}@vendor.example>`,
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="b1"',
      '',
      '--b1',
      `Content-Type: application/xml; name="hd-${number}.xml"`,
      `Content-Disposition: attachment; filename="hd-${number}.xml"`,
      'Content-Transfer-Encoding: base64',
      '',
      attachment,
      '--b1--',
      '',
    ].join('\r\n');
    const raw = new TextEncoder().encode(mime);
    const blobId = newInboundBlobId();
    await store.put(inboundKey(blobId), raw);
    return { job: { blobId, sha256: sha256Hex(raw), sizeBytes: raw.byteLength, recipient: `${token}@in.test` }, xmlBytes: Buffer.byteLength(xml) };
  }

  it('files an inbound message and counts it, and keeps one past the limit for later', async () => {
    const o = await org();
    const limits = { ...DEFAULT_USAGE_LIMITS, inbound_emails: '1' };
    const first = await message(o.token, '7001');
    const filed = await processInboundEmail({ runtime: worker, store, domain: 'in.test', extract, limits }, first.job);
    expect(filed).toMatchObject({ duplicate: false, fileIds: [expect.any(String)] });
    expect(await usageOf(o.orgId)).toEqual([
      { metric: 'attachment_bytes', amount: `${first.xmlBytes}.000000` },
      { metric: 'inbound_emails', amount: '1.000000' },
    ]);

    const second = await message(o.token, '7002');
    const kept = await processInboundEmail({ runtime: worker, store, domain: 'in.test', extract, limits }, second.job);
    expect(kept).toEqual({ deferred: expect.any(String) });
    if (!('deferred' in kept)) throw new Error('not deferred');
    expect(Date.parse(kept.deferred)).toBeGreaterThan(Date.now() + 23 * 3600_000);
    // Not filed, nothing stored for the org, and its raw message is still there for the next try.
    const messages = await admin(async (c) => (await c.query('SELECT 1 FROM crove_kernel.inbound_message WHERE org_id = $1', [o.orgId])).rowCount);
    expect(messages).toBe(1);
    expect(await store.get(inboundKey(second.job.blobId))).toBeInstanceOf(Uint8Array);
    expect(await deferrals(o.orgId)).toEqual([{ metric: 'inbound_emails', subject_type: 'inbound_email', subject_id: second.job.sha256, notified: true }]);

    // Without limits (an embedder that sets none) nothing is checked.
    expect(await processInboundEmail({ runtime: worker, store, domain: 'in.test', extract }, second.job)).toMatchObject({ duplicate: false });
  });

  it('keeps a document unread past the page limit, shows it waiting, and counts the pages it reads', async () => {
    const o = await org();
    const ingest = async (number: string) => {
      const bytes = new TextEncoder().encode(FIXTURE.toString('utf8').replace('<SHDon>1234</SHDon>', `<SHDon>${number}</SHDon>`));
      const sha256 = sha256Hex(bytes);
      const storageKey = fileKey(o.orgId, sha256);
      const generation = await store.put(storageKey, bytes);
      const { fileId } = await rt.execute<{ fileId: string }>(
        'kernel.file.ingest',
        { filename: `hd-${number}.xml`, contentType: 'application/xml', sizeBytes: bytes.byteLength, sha256, storageKey, generation, source: 'upload' },
        { actor: asUser(o.owner), orgId: o.orgId },
      );
      return fileId;
    };
    const limits = { ...DEFAULT_USAGE_LIMITS, extraction_pages: '1' };
    const deps = { runtime: worker, store, extractor: null, extract, today: () => '2026-10-13', limits };

    const read = await ingest('8001');
    const done = await extractAndPropose(deps, o.orgId, read);
    expect(done.proposalId).toEqual(expect.any(String));
    expect(done.deferred).toBeUndefined();
    expect(await usageOf(o.orgId)).toEqual([{ metric: 'extraction_pages', amount: '1.000000' }]);

    const waiting = await ingest('8002');
    const kept = await extractAndPropose(deps, o.orgId, waiting);
    expect(kept).toEqual({ proposalId: null, deferred: expect.any(String) });
    expect(await deferrals(o.orgId)).toEqual([{ metric: 'extraction_pages', subject_type: 'file', subject_id: waiting, notified: true }]);
    const files = await rt.query<Array<{ id: string; status: string; error: string | null }>>('kernel.files.recent', {}, { actor: asUser(o.owner), orgId: o.orgId });
    expect(files.find((f) => f.id === waiting)).toMatchObject({ status: 'waiting', error: WAITING_FOR_BUDGET });
    expect(files.find((f) => f.id === read)).toMatchObject({ status: 'proposed' });
    // No extraction run was recorded for it, so it is read as new when its turn comes.
    const runs = await admin(async (c) => (await c.query('SELECT 1 FROM crove_kernel.extraction WHERE org_id = $1 AND file_id = $2', [o.orgId, waiting])).rowCount);
    expect(runs).toBe(0);
    // Once the window allows it (here: a higher limit), the same job reads it.
    const later = await extractAndPropose({ ...deps, limits: { ...limits, extraction_pages: '5' } }, o.orgId, waiting);
    expect(later.proposalId).toEqual(expect.any(String));
  });
});
