// Link preview cards of Crove Social on PostgreSQL 17 (#641): a request is cached per org and URL, queued for the
// worker once, read through crove-extract (the real parser process) and recorded; failures say why; fresh answers
// are reused for a day; an org's requests are capped per minute. The page fetch is a stub here (the egress guard has
// its own tests). Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { EgressError, Runtime, type EgressResponse } from '@crove/kernel-runtime';
import { LINK_PREVIEW_PER_MINUTE, socialCommands, socialQueries, type LinkPreview } from '@crove/mod-social';
import type { ExtractClient } from '@crove/extract-contract';
import { runLinkPreviewJob } from '../src/link-preview.ts';
import { inProcessExtract } from './extract-service.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('social link previews on PostgreSQL (#641)', () => {
  const dbName = `crove_test_social_link_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  let worker: Runtime;
  let extract: ExtractClient;
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

  async function org() {
    const person = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@social.test`, name: null });
    const owner = await person('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    const viewer = await person('viewer');
    await admin((c) => c.query('INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, $3)', [orgId, viewer, 'viewer']));
    return { orgId, owner, viewer };
  }

  const request = (o: { orgId: string }, user: string, url: string) => rt.execute<LinkPreview>('social.link_preview.request', { url }, { actor: asUser(user), orgId: o.orgId });
  const get = (o: { orgId: string }, user: string, url: string) => rt.query<LinkPreview | null>('social.link_preview.get', { url }, { actor: asUser(user), orgId: o.orgId });
  const requests = (o: { orgId: string }) =>
    admin(async (c) => (await c.query<{ id: string; payload: { preview_id: string } }>("SELECT id, payload FROM crove_kernel.outbox_event WHERE org_id = $1 AND type = 'social.link_preview.requested' ORDER BY created_at", [o.orgId])).rows);
  const html = (body: string, contentType = 'text/html; charset=utf-8', status = 200) => async (url: string): Promise<EgressResponse> => ({ url, status, contentType, body: Buffer.from(body), truncated: false });
  const job = (o: { orgId: string }, previewId: string, fetch: (url: string) => Promise<EgressResponse>, client = extract) => runLinkPreviewJob({ runtime: worker, extract: client, fetch }, o.orgId, previewId);

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
    const as = (user: string, password: string) => {
      const u = new URL(adminUrl);
      u.username = user;
      u.password = password;
      return u.toString();
    };
    pool = createPool({ connectionString: as('crove_app', 'test-app-pw'), max: 4 });
    workerPool = createPool({ connectionString: as('crove_worker', 'test-worker-pw'), max: 2 });
    db = createDb(pool);
    const registry = { commands: [...kernelCommands, ...socialCommands], queries: [...kernelQueries({ inboundDomain: null }), ...socialQueries] };
    rt = new Runtime(db).register(registry);
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

  it('queues a link once, reads its page in crove-extract, and reuses the answer', async () => {
    const o = await org();
    const url = 'https://shop.example.vn/khai-truong#top';
    const first = await request(o, o.viewer, url);
    expect(first).toMatchObject({ url: 'https://shop.example.vn/khai-truong', status: 'pending', title: null });
    // Asked again while it waits: no second job.
    await request(o, o.owner, 'https://shop.example.vn/khai-truong');
    const queued = await requests(o);
    expect(queued).toHaveLength(1);

    const previewId = queued[0]?.payload.preview_id as string;
    const page = '<html><head><meta property="og:title" content="Khai trương cửa hàng"><meta property="og:description" content="Giảm 20% tuần đầu"><meta property="og:site_name" content="Shop"></head><body><nav>Menu</nav><article><p>Mở cửa 7 giờ sáng.</p></article></body></html>';
    await expect(job(o, previewId, html(page))).resolves.toBe('ready');
    // The page's main text (#779) is kept with the answer, for AI drafts.
    expect(await get(o, o.viewer, url)).toMatchObject({ status: 'ready', title: 'Khai trương cửa hàng', description: 'Giảm 20% tuần đầu', siteName: 'Shop', text: 'Mở cửa 7 giờ sáng.', error: null });
    // Answered: a second run does nothing; a fresh answer is reused without a job.
    await expect(job(o, previewId, html(page))).resolves.toBe('none');
    expect(await request(o, o.owner, url)).toMatchObject({ status: 'ready', title: 'Khai trương cửa hàng' });
    expect(await requests(o)).toHaveLength(1);

    // A day later it is read again, keeping the old answer meanwhile.
    await admin((c) => c.query("UPDATE crove_social.link_preview SET fetched_at = now() - interval '25 hours' WHERE org_id = $1", [o.orgId]));
    expect(await request(o, o.owner, url)).toMatchObject({ status: 'pending', title: 'Khai trương cửa hàng' });
    expect(await requests(o)).toHaveLength(2);
  });

  it('records why a page could not be read, and retries only a failure of the extract service', async () => {
    const o = await org();
    const cases: [string, (url: string) => Promise<EgressResponse>, string][] = [
      ['https://a.example/blocked', () => Promise.reject(new EgressError('blocked', 'not a public address')), 'blocked'],
      ['https://a.example/missing', html('nope', 'text/html', 404), 'http'],
      ['https://a.example/file.pdf', html('%PDF-1.7', 'application/pdf'), 'not_html'],
      ['https://a.example/json', html('{"a":1}', ''), 'not_html'],
    ];
    for (const [url, fetch, error] of cases) {
      await request(o, o.owner, url);
      const id = (await requests(o)).at(-1)?.payload.preview_id as string;
      await expect(job(o, id, fetch)).resolves.toBe('failed');
      expect(await get(o, o.owner, url)).toMatchObject({ status: 'failed', error, title: null });
    }
    const busy: ExtractClient = { extract: async () => ({ ok: false, code: 'busy', message: 'busy' }) } as unknown as ExtractClient;
    await request(o, o.owner, 'https://a.example/busy');
    const id = (await requests(o)).at(-1)?.payload.preview_id as string;
    await expect(job(o, id, html('<title>x</title>'), busy)).rejects.toThrow(/busy/);
    expect(await get(o, o.owner, 'https://a.example/busy')).toMatchObject({ status: 'pending' });
  });

  it('refuses links that are not http(s), caps an org per minute, and keeps answers to their org', async () => {
    const o = await org();
    const stranger = await org();
    for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'ftp://example.com/', 'https://user:pw@example.com/', 'not a link']) {
      await expect(request(o, o.owner, bad), bad).rejects.toMatchObject({ code: 'LINK_INVALID', status: 422 });
    }
    await request(o, o.owner, 'https://shared.example/');
    expect(await get(stranger, stranger.owner, 'https://shared.example/')).toBeNull();
    const id = (await requests(o))[0]?.payload.preview_id as string;
    await expect(job(stranger, id, html('<title>x</title>'))).resolves.toBe('none');
    await expect(rt.execute('social.link_preview.record', { previewId: id, result: { ok: false, error: 'http' } }, { actor: asUser(o.owner), orgId: o.orgId })).rejects.toMatchObject({ status: 403 });

    await admin((c) =>
      c.query(
        "INSERT INTO crove_social.link_preview (org_id, url, url_sha256, status, requested_at) SELECT $1, 'https://n.example/' || g, md5(g::text) || md5((g + 1)::text), 'pending', now() FROM generate_series(1, $2) g",
        [o.orgId, LINK_PREVIEW_PER_MINUTE],
      ),
    );
    await expect(request(o, o.owner, 'https://one-more.example/')).rejects.toMatchObject({ code: 'LINK_PREVIEW_LIMIT', status: 429 });
    // A cached answer is still served at the cap.
    expect(await request(o, o.owner, 'https://shared.example/')).toMatchObject({ status: 'pending' });

    const grants = await admin(async (c) =>
      (
        await c.query<{ privilege_type: string }>(
          "SELECT privilege_type FROM information_schema.role_table_grants WHERE grantee = 'crove_tenant' AND table_schema = 'crove_social' AND table_name = 'link_preview' ORDER BY 1",
        )
      ).rows.map((r) => r.privilege_type),
    );
    expect(grants).toEqual(['INSERT', 'SELECT']);
  });
});
