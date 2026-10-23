// A default signature per channel (#1190) on PostgreSQL 17: owners and admins set it, a channel added to a post copies
// it into the variant, the text sent ends with it, a later change leaves existing posts and their approvals alone,
// leaving it off changes the content hash, Instagram's hashtag and @ tag caps are checked before review, and the client
// review link shows the signature, so a client approves the whole text. Set CROVE_TEST_ADMIN_URL to a superuser URL;
// each run makes its own database.
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { socialCommands, socialQueries, withSignature, type PostView } from '@crove/mod-social';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const SIGNATURE = 'Hotline 0901 234 567\n12 Lê Lợi, Q.1\n#TiemBanhAnNhien';

suite('social channel signatures on PostgreSQL (#1190)', () => {
  const dbName = `crove_test_social_signature_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let rt: Runtime;
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

  async function person(name: string) {
    return upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@social.test`, name: null });
  }

  type Org = { orgId: string; owner: string; admin: string; member: string; other: string };
  async function org(): Promise<Org> {
    const owner = await person('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    const roles = { admin: await person('admin'), member: await person('member'), other: await person('other') };
    const role = { admin: 'admin', member: 'member', other: 'member' } as const;
    for (const [key, id] of Object.entries(roles)) {
      await admin((c) => c.query('INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, $3)', [orgId, id, role[key as keyof typeof role]]));
    }
    return { orgId, owner, ...roles };
  }

  async function connection(orgId: string, owner: string, provider = 'sandbox') {
    const id = randomUUID();
    await admin((c) =>
      c.query('INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, $3, $4, $5, $6)', [orgId, id, provider, `acct-${id.slice(0, 8)}`, 'Kênh thử', owner]),
    );
    return id;
  }

  async function image(orgId: string) {
    const id = randomUUID();
    const sha = createHash('sha256').update(id).digest('hex');
    await admin((c) =>
      c.query(
        `INSERT INTO crove_kernel.file (org_id, id, sha256, storage_key, generation, filename, content_type, size_bytes, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [orgId, id, sha, `org/${orgId}/${sha}`, `content:${sha}`, 'anh.jpg', 'image/jpeg', 120_000, 'social'],
      ),
    );
    return id;
  }

  const exec = <O>(o: Org, user: string, name: string, input: unknown) => rt.execute<O>(name, input, { actor: asUser(user), orgId: o.orgId });
  const get = (o: Org, postId: string) => rt.query<PostView>('social.post.get', { postId }, { actor: asUser(o.owner), orgId: o.orgId });
  const seen = (p: PostView) => p.variants.map((v) => ({ variantId: v.id, revision: v.revision, contentHash: v.contentHash }));
  const sign = (o: Org, user: string, connectionId: string, signature: string | null) => exec<{ signature: string | null }>(o, user, 'social.channel.set_signature', { connectionId, signature });
  const refusal = (p: Promise<unknown>) => p.then(() => 'resolved', (e: unknown) => (e as { code?: string }).code ?? String(e));
  const policy = async (o: Org, connectionId: string) =>
    (await rt.query<{ connectionId: string; signature: string | null }[]>('social.channel.policies', {}, { actor: asUser(o.member), orgId: o.orgId })).find((p) => p.connectionId === connectionId)?.signature ?? null;

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
    rt = new Runtime(db).register({ commands: [...kernelCommands, ...socialCommands], queries: [...kernelQueries({ inboundDomain: null }), ...socialQueries] });
  });

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('lets owners and admins set it, kept as clean plain text and audited, and refuses members and long ones', async () => {
    const o = await org();
    const conn = await connection(o.orgId, o.owner);
    expect(await refusal(sign(o, o.member, conn, SIGNATURE))).toBe('FORBIDDEN');
    // NFC, LF line breaks, no hidden characters, trimmed.
    const saved = await sign(o, o.admin, conn, `  ${SIGNATURE.normalize('NFD').replace(/\n/g, '\r\n')}​ \n`);
    expect(saved.signature).toBe(SIGNATURE);
    expect(await policy(o, conn)).toBe(SIGNATURE);
    expect(await refusal(sign(o, o.owner, conn, 'x'.repeat(501)))).toBe('VALIDATION');
    expect(await sign(o, o.owner, conn, 'ầ'.repeat(500))).toMatchObject({ signature: 'ầ'.repeat(500) });
    // The table refuses one over the cap whoever writes it.
    await expect(admin((c) => c.query('UPDATE crove_social.channel_policy SET signature = $1 WHERE org_id = $2', ['x'.repeat(501), o.orgId]))).rejects.toThrow(/channel_policy_signature_length/);
    await expect(admin((c) => c.query("UPDATE crove_social.channel_policy SET signature = '' WHERE org_id = $1", [o.orgId]))).rejects.toThrow(/channel_policy_signature_length/);
    // Null or empty clears it.
    expect((await sign(o, o.owner, conn, '  ')).signature).toBeNull();
    expect(await policy(o, conn)).toBeNull();
    const { rows } = await admin((c) => c.query<{ count: string }>("SELECT count(*) FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'social.channel.set_signature' AND outcome = 'ok'", [o.orgId]));
    expect(Number(rows[0]?.count)).toBe(3);
  });

  it('adds it to new posts on that channel only, before the link, and the text sent ends with it', async () => {
    const o = await org();
    const signed = await connection(o.orgId, o.owner);
    const plain = await connection(o.orgId, o.owner);
    await sign(o, o.owner, signed, SIGNATURE);
    const { postId } = await exec<{ postId: string }>(o, o.member, 'social.post.create', { body: 'Bánh mới ra lò', channels: [{ connectionId: signed }, { connectionId: plain }] });
    const post = await get(o, postId);
    const [a, b] = [post.variants.find((v) => v.connectionId === signed), post.variants.find((v) => v.connectionId === plain)];
    expect(a?.settings).toEqual({ signature: SIGNATURE });
    expect(a?.effective.body).toBe(`Bánh mới ra lò\n\n${SIGNATURE}`);
    // The post's shared text stays as written: the signature belongs to the channel's variant.
    expect(post.body).toBe('Bánh mới ra lò');
    expect(b?.settings).toEqual({});
    expect(b?.effective.body).toBe('Bánh mới ra lò');
    // A channel's own text gets it too; one left off at create stays off.
    const own = await exec<{ postId: string }>(o, o.member, 'social.post.create', {
      body: 'Chung',
      channels: [{ connectionId: signed, body: `Riêng\n\n${SIGNATURE}` }],
    });
    expect((await get(o, own.postId)).variants[0]?.effective.body).toBe(`Riêng\n\n${SIGNATURE}`);
    const off = await exec<{ postId: string }>(o, o.member, 'social.post.create', { body: 'Không chữ ký', channels: [{ connectionId: signed, settings: { signature: false } }] });
    expect((await get(o, off.postId)).variants[0]).toMatchObject({ settings: { signature: false }, effective: { body: 'Không chữ ký' } });
    // A member limited to the other channel (#1081) does not read this one's signature.
    await exec(o, o.owner, 'social.channel_access.set', { userId: o.other, channelConnectionIds: [plain] });
    const limited = await rt.query<{ connectionId: string; signature: string | null }[]>('social.channel.policies', {}, { actor: asUser(o.other), orgId: o.orgId });
    expect(limited.find((p) => p.connectionId === signed)?.signature ?? null).toBeNull();
    expect(await policy(o, signed)).toBe(SIGNATURE);
  });

  it('copies it on every path that adds a channel, and a copy keeps its source settings', async () => {
    const o = await org();
    const signed = await connection(o.orgId, o.owner);
    const other = await connection(o.orgId, o.owner);
    // A post written before the channel had a signature.
    const old = (await exec<{ postId: string }>(o, o.member, 'social.post.create', { body: 'Bài cũ', channels: [{ connectionId: signed }] })).postId;
    await sign(o, o.owner, signed, SIGNATURE);
    // Added channels.
    const added = (await exec<{ postId: string }>(o, o.member, 'social.post.create', { body: 'Thêm kênh', channels: [{ connectionId: other }] })).postId;
    await exec(o, o.member, 'social.post.add_channels', { postId: added, channels: [{ connectionId: signed }] });
    expect((await get(o, added)).variants.find((v) => v.connectionId === signed)?.settings).toEqual({ signature: SIGNATURE });
    // The bulk add.
    const bulk = (await exec<{ postId: string }>(o, o.member, 'social.post.create', { body: 'Thêm hàng loạt', channels: [{ connectionId: other }] })).postId;
    await exec(o, o.member, 'social.post.bulk_add_channel', { postIds: [bulk], connectionId: signed });
    expect((await get(o, bulk)).variants.find((v) => v.connectionId === signed)?.effective.body).toBe(`Thêm hàng loạt\n\n${SIGNATURE}`);
    // The import.
    const imported = await exec<{ posts: { postId: string }[] }>(o, o.member, 'social.post.import', { posts: [{ body: 'Từ bảng tính', connectionIds: [signed, other] }] });
    const fromSheet = await get(o, imported.posts[0]?.postId as string);
    expect(fromSheet.variants.find((v) => v.connectionId === signed)?.effective.body).toBe(`Từ bảng tính\n\n${SIGNATURE}`);
    expect(fromSheet.variants.find((v) => v.connectionId === other)?.effective.body).toBe('Từ bảng tính');
    // A duplicate keeps its source's settings: the old post had none, so its copy has none either.
    const copyOfOld = (await exec<{ postId: string }>(o, o.member, 'social.post.duplicate', { postId: old })).postId;
    expect((await get(o, copyOfOld)).variants[0]).toMatchObject({ settings: {}, effective: { body: 'Bài cũ' } });
    // A copy of a signed post keeps the signature as a setting, not baked into the copy's text.
    const copyOfAdded = await get(o, (await exec<{ postId: string }>(o, o.member, 'social.post.duplicate', { postId: added })).postId);
    const copied = copyOfAdded.variants.find((v) => v.connectionId === signed);
    expect(copied).toMatchObject({ settings: { signature: SIGNATURE }, overrides: { body: null }, effective: { body: `Thêm kênh\n\n${SIGNATURE}` } });
  });

  it('leaves existing posts and their approvals alone when the channel signature changes, and leaving it off sends a post back to review', async () => {
    const o = await org();
    const conn = await connection(o.orgId, o.owner);
    // Approved before the channel had a signature: same hash, still approved, nothing added after one is set.
    const before = (await exec<{ postId: string }>(o, o.member, 'social.post.create', { body: 'Trước chữ ký', channels: [{ connectionId: conn }] })).postId;
    await exec(o, o.member, 'social.post.submit', { postId: before });
    await exec(o, o.owner, 'social.variant.decide', { postId: before, decision: 'approved', variants: seen(await get(o, before)) });
    const approvedBefore = await get(o, before);
    await sign(o, o.owner, conn, SIGNATURE);
    const afterSet = await get(o, before);
    expect(afterSet.variants[0]).toMatchObject({ status: 'approved', contentHash: approvedBefore.variants[0]?.contentHash, revision: approvedBefore.variants[0]?.revision, effective: { body: 'Trước chữ ký' } });

    // Approved with the signature: a new one on the channel changes nothing on it.
    const signed = (await exec<{ postId: string }>(o, o.member, 'social.post.create', { body: 'Có chữ ký', channels: [{ connectionId: conn }] })).postId;
    await exec(o, o.member, 'social.post.submit', { postId: signed });
    await exec(o, o.owner, 'social.variant.decide', { postId: signed, decision: 'approved', variants: seen(await get(o, signed)) });
    const approved = (await get(o, signed)).variants[0];
    await sign(o, o.admin, conn, 'Hotline mới 0999 888 777');
    await sign(o, o.admin, conn, null);
    expect((await get(o, signed)).variants[0]).toMatchObject({ status: 'approved', contentHash: approved?.contentHash, effective: { body: `Có chữ ký\n\n${SIGNATURE}` } });

    // Left off: another content hash, a new revision, and the post is reviewed again.
    const edit = await exec<{ changed: boolean }>(o, o.member, 'social.variant.update', { variantId: approved?.id, revision: approved?.revision, settings: { signature: false } });
    expect(edit.changed).toBe(true);
    const off = (await get(o, signed)).variants[0];
    expect(off?.contentHash).not.toBe(approved?.contentHash);
    expect(off).toMatchObject({ status: 'draft', effective: { body: 'Có chữ ký' } });
  });

  it('counts the signature in the channel checks: an X post pushed over 280 is too long and stays out of review', async () => {
    const o = await org();
    const x = await connection(o.orgId, o.owner, 'x');
    await sign(o, o.owner, x, 'Hotline 0901 234 567 · Ghé tiệm nhé!');
    const { postId } = await exec<{ postId: string }>(o, o.member, 'social.post.create', { body: 'a'.repeat(260), channels: [{ connectionId: x }] });
    const post = await get(o, postId);
    expect(post.variants[0]?.issues).toContainEqual(expect.objectContaining({ code: 'TEXT_TOO_LONG', limit: 280 }));
    expect(await refusal(exec(o, o.member, 'social.post.submit', { postId }))).toBe('VARIANT_INVALID');
    // Without the signature it fits.
    await exec(o, o.member, 'social.variant.update', { variantId: post.variants[0]?.id, revision: post.variants[0]?.revision, settings: { signature: false } });
    expect((await get(o, postId)).variants[0]?.issues).toEqual([]);
  });

  it('refuses an Instagram caption with 31 hashtags or 21 @ tags before approval, the signature counted', async () => {
    const o = await org();
    const ig = await connection(o.orgId, o.owner, 'instagram');
    const media = [{ fileId: await image(o.orgId) }];
    const tags = (n: number) => Array.from({ length: n }, (_, i) => `#banh${i}`).join(' ');
    const mentions = (n: number) => Array.from({ length: n }, (_, i) => `@tiem_${i}`).join(' ');
    const create = async (body: string) => (await exec<{ postId: string }>(o, o.member, 'social.post.create', { body, media, channels: [{ connectionId: ig }] })).postId;
    const codes = async (postId: string) => (await get(o, postId)).variants[0]?.issues.map((i) => i.code);

    const fine = await create(`${tags(30)} ${mentions(20)}`);
    expect(await codes(fine)).toEqual([]);
    const hashtags = await create(tags(31));
    expect(await codes(hashtags)).toEqual(['IG_TOO_MANY_HASHTAGS']);
    expect(await refusal(exec(o, o.member, 'social.post.submit', { postId: hashtags }))).toBe('VARIANT_INVALID');
    const tagged = await create(mentions(21));
    expect(await codes(tagged)).toEqual(['IG_TOO_MANY_MENTIONS']);
    expect(await refusal(exec(o, o.member, 'social.post.submit', { postId: tagged }))).toBe('VARIANT_INVALID');
    // The signature's hashtag is the 31st.
    await sign(o, o.owner, ig, '#TiemBanhAnNhien');
    const withSignature = await create(tags(30));
    expect(await codes(withSignature)).toEqual(['IG_TOO_MANY_HASHTAGS']);
  });

  it('compares the text with its signature in the duplicate check', async () => {
    const o = await org();
    const conn = await connection(o.orgId, o.owner);
    await sign(o, o.owner, conn, SIGNATURE);
    const first = (await exec<{ postId: string }>(o, o.member, 'social.post.create', { body: 'Khuyến mãi cuối tuần', channels: [{ connectionId: conn }] })).postId;
    await exec(o, o.member, 'social.post.submit', { postId: first });
    await exec(o, o.owner, 'social.variant.decide', { postId: first, decision: 'approved', variants: seen(await get(o, first)) });
    await exec(o, o.owner, 'social.variant.schedule', { postId: first, at: new Date(Date.now() + 86_400_000).toISOString() });
    // The same text typed with the signature by hand is the same text sent.
    const again = (await exec<{ postId: string }>(o, o.member, 'social.post.create', { body: `Khuyến mãi cuối tuần\n\n${SIGNATURE}`, channels: [{ connectionId: conn }] })).postId;
    const view = await get(o, again);
    expect(view.variants[0]?.effective.body).toBe(`Khuyến mãi cuối tuần\n\n${SIGNATURE}`);
    expect(view.variants[0]?.duplicateOf?.status).toBe('scheduled');
    // Another text is not, though both end with the same signature.
    const other = (await exec<{ postId: string }>(o, o.member, 'social.post.create', { body: 'Bánh mới', channels: [{ connectionId: conn }] })).postId;
    expect((await get(o, other)).variants[0]?.duplicateOf).toBeNull();
  });

  // The client review link (#1190): each channel's signature beside its body, so the page shows the text that is sent.
  type ReviewChannel = { channel: string; body: string; signature: string | null };
  type ReviewPage = { kind?: 'plan'; channels?: ReviewChannel[]; posts?: { id: string; channels?: ReviewChannel[] }[] };
  const review = async (token: string) => (await pool.query<{ page: ReviewPage | null }>('SELECT crove_social.review_link_view($1) AS page', [token])).rows[0]?.page ?? null;
  // A post on a signed channel, a channel without one and a signed channel left off, with an answer.
  async function reviewed(o: Org) {
    const signed = await connection(o.orgId, o.owner);
    const plain = await connection(o.orgId, o.owner);
    const left = await connection(o.orgId, o.owner);
    await sign(o, o.owner, signed, SIGNATURE);
    await sign(o, o.owner, left, 'Không hiện');
    const { postId } = await exec<{ postId: string }>(o, o.member, 'social.post.create', {
      body: 'Bánh mới ra lò',
      scheduledAt: new Date(Date.now() + 86_400_000).toISOString(),
      channels: [{ connectionId: signed }, { connectionId: plain, body: 'Riêng kênh này' }, { connectionId: left, settings: { signature: false } }],
    });
    const single = await exec<{ token: string }>(o, o.owner, 'social.review_link.create', { postId });
    const plan = await exec<{ token: string }>(o, o.owner, 'social.review_link.create_plan', { postIds: [postId] });
    await pool.query("SELECT crove_social.review_feedback_add($1, 'Khách', 'comment', 'Xem giúp')", [single.token]);
    return { postId, single: single.token, plan: plan.token };
  }

  it('shows each channel signature on the client review link, so the client approves the text that is sent', async () => {
    const o = await org();
    const { postId, single, plan } = await reviewed(o);
    const sent = (await get(o, postId)).variants.map((v) => v.effective.body);
    expect(sent[0]).toBe(`Bánh mới ra lò\n\n${SIGNATURE}`);
    for (const channels of [(await review(single))?.channels, (await review(plan))?.posts?.[0]?.channels]) {
      expect(channels?.map((c) => ({ body: c.body, signature: c.signature }))).toEqual([
        { body: 'Bánh mới ra lò', signature: SIGNATURE },
        { body: 'Riêng kênh này', signature: null },
        { body: 'Bánh mới ra lò', signature: null },
      ]);
      // The page's text, the body with its signature as effectiveContent appends it, is the text sent.
      expect(channels?.map((c) => withSignature(c.body, { signature: c.signature }))).toEqual(sent);
    }
    // A signature that is not a text (a hand-written setting) shows as none, as it is never appended.
    await admin((c) => c.query(`UPDATE crove_social.post_variant SET settings = '{"signature": 7}' WHERE org_id = $1 AND post_id = $2 AND settings->>'signature' = $3`, [o.orgId, postId, SIGNATURE]));
    expect((await review(single))?.channels?.[0]?.signature).toBeNull();
  });

  // The migration re-created review_plan_page and review_link_view with only 'signature' added: both kinds of link give
  // byte for byte what the previous definitions (migrations 20261023233000 and 20261028150000) give, but for it.
  it('gives exactly the previous review link output, but for the signature', async () => {
    const o = await org();
    const { single, plan } = await reviewed(o);
    const previous = (file: string, name: string) => {
      const text = readFileSync(join(MIGRATIONS, file), 'utf8');
      const start = text.indexOf(`CREATE OR REPLACE FUNCTION ${name}(`);
      const end = text.indexOf('$$;', start);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeGreaterThan(start);
      return text.slice(start, end + 3);
    };
    const planPage = previous('20261023233000_crove_social_plan_review_link.sql', 'crove_social.review_plan_page');
    const linkView = previous('20261028150000_crove_social_report_branding.sql', 'crove_social.review_link_view');
    const pages = await admin(async (c) => {
      const read = async (token: string) => (await c.query<{ page: string }>('SELECT crove_social.review_link_view($1)::text AS page', [token])).rows[0]?.page as string;
      const now = [await read(single), await read(plan)];
      await c.query('BEGIN');
      try {
        await c.query(planPage);
        await c.query(linkView);
        return { now, before: [await read(single), await read(plan)] };
      } finally {
        await c.query('ROLLBACK');
      }
    });
    const withoutSignatures = (page: string): unknown => JSON.parse(page, (key, value: unknown) => (key === 'signature' ? undefined : value));
    // The new field is there now, on every channel, and was not before.
    for (const page of pages.now) expect(page.match(/"signature": /g)?.length).toBe(3);
    for (const page of pages.before) expect(page).not.toContain('"signature"');
    expect(JSON.parse(pages.now[0] as string)).toMatchObject({ channels: [{ signature: SIGNATURE }, { signature: null }, { signature: null }], feedback: [{ body: 'Xem giúp' }] });
    expect(pages.now.map(withoutSignatures)).toEqual(pages.before.map((page) => JSON.parse(page) as unknown));
    // The live definitions are back after the rollback.
    expect((await review(single))?.channels?.[0]?.signature).toBe(SIGNATURE);
  });
});
