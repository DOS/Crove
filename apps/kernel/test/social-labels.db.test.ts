// Social labels on PostgreSQL 17 (issue #639): who may create, change and delete labels, names unique per org, the
// cap per org, putting labels on a post without touching its content, the list and metrics filters, the CSV column,
// and isolation between orgs. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { LABEL_LIMIT, socialCommands, socialQueries, type Label, type MetricsRow, type PostView } from '@crove/mod-social';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('social labels on PostgreSQL (#639)', () => {
  const dbName = `crove_test_social_labels_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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

  async function org() {
    const owner = await person('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    const roles: Record<'admin' | 'member' | 'viewer', string> = { admin: await person('admin'), member: await person('member'), viewer: await person('viewer') };
    for (const [role, id] of Object.entries(roles)) {
      await admin((c) => c.query('INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, $3)', [orgId, id, role]));
    }
    const connection = randomUUID();
    await admin((c) =>
      c.query(
        'INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, $3, $4, $5, $6)',
        [orgId, connection, 'sandbox', `acct-${connection.slice(0, 8)}`, 'Trang thử', owner],
      ),
    );
    return { orgId, owner, connection, ...roles };
  }

  const exec = <O>(o: { orgId: string }, user: string, name: string, input: unknown) => rt.execute<O>(name, input, { actor: asUser(user), orgId: o.orgId });
  const query = <O>(o: { orgId: string }, user: string, name: string, input: unknown) => rt.query<O>(name, input, { actor: asUser(user), orgId: o.orgId });
  const labels = (o: { orgId: string }, user: string) => query<Label[]>(o, user, 'social.label.list', {});
  const create = async (o: { orgId: string }, user: string, name: string, color?: string) =>
    (await exec<{ labelId: string }>(o, user, 'social.label.create', { name, ...(color ? { color } : {}) })).labelId;
  const post = async (o: { orgId: string; member: string; connection: string }, body: string) =>
    (await exec<{ postId: string }>(o, o.member, 'social.post.create', { body, channels: [{ connectionId: o.connection }] })).postId;
  const get = (o: { orgId: string; owner: string }, postId: string) => query<PostView>(o, o.owner, 'social.post.get', { postId });

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
    rt = new Runtime(db).register({
      commands: [...kernelCommands, ...socialCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...socialQueries],
    });
  });

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('lets members create labels, and only owners and admins rename, recolour or delete them', async () => {
    const o = await org();
    const launch = await create(o, o.member, 'Khai trương', 'green');
    const tet = await create(o, o.owner, 'tết 2027');
    await expect(create(o, o.viewer, 'x')).rejects.toMatchObject({ status: 403 });
    // Names are unique per org, whatever the case or the way the marks were typed.
    await expect(create(o, o.admin, 'KHAI TRƯƠNG')).rejects.toMatchObject({ code: 'LABEL_NAME_TAKEN' });
    await expect(create(o, o.admin, 'Khai trương'.normalize('NFD'))).rejects.toMatchObject({ code: 'LABEL_NAME_TAKEN' });
    // A name that NFC lengthens past 50 characters, and a colour outside the palette, are refused as input.
    await expect(create(o, o.member, 'क़'.repeat(30))).rejects.toMatchObject({ code: 'VALIDATION', status: 422 });
    await expect(create(o, o.member, 'Lạ', 'magenta')).rejects.toMatchObject({ code: 'VALIDATION' });

    expect((await labels(o, o.viewer)).map((l) => [l.name, l.color, l.postCount])).toEqual([
      ['Khai trương', 'green', 0],
      ['tết 2027', 'gray', 0],
    ]);

    await expect(exec(o, o.member, 'social.label.update', { labelId: launch, name: 'Khai trương', color: 'red' })).rejects.toMatchObject({ status: 403 });
    await expect(exec(o, o.member, 'social.label.delete', { labelId: launch })).rejects.toMatchObject({ status: 403 });
    await expect(exec(o, o.admin, 'social.label.update', { labelId: launch, name: 'Tết 2027', color: 'red' })).rejects.toMatchObject({ code: 'LABEL_NAME_TAKEN' });
    // Its own name in another case is no clash.
    await exec(o, o.admin, 'social.label.update', { labelId: tet, name: 'Tết 2027', color: 'red' });
    await exec(o, o.owner, 'social.label.update', { labelId: launch, name: 'Khai trương quán', color: 'teal' });
    expect((await labels(o, o.member)).map((l) => [l.name, l.color, l.createdBy])).toEqual([
      ['Khai trương quán', 'teal', o.member],
      ['Tết 2027', 'red', o.owner],
    ]);
    await exec(o, o.admin, 'social.label.delete', { labelId: tet });
    await expect(exec(o, o.admin, 'social.label.delete', { labelId: tet })).rejects.toMatchObject({ code: 'LABEL_NOT_FOUND' });
    expect((await labels(o, o.member)).map((l) => l.name)).toEqual(['Khai trương quán']);
  });

  it(`keeps an org to ${LABEL_LIMIT} labels`, async () => {
    const o = await org();
    await admin((c) =>
      c.query("INSERT INTO crove_social.label (org_id, name, created_by) SELECT $1, 'Nhãn ' || g, $2 FROM generate_series(1, $3::int - 1) g", [o.orgId, o.owner, LABEL_LIMIT]),
    );
    const last = await create(o, o.member, 'Cuối cùng');
    await expect(create(o, o.member, 'Quá số')).rejects.toMatchObject({ code: 'LABEL_LIMIT', status: 409 });
    expect(await labels(o, o.viewer)).toHaveLength(LABEL_LIMIT);
    // Deleting one makes room again.
    await exec(o, o.owner, 'social.label.delete', { labelId: last });
    await create(o, o.member, 'Quá số');
  });

  it("replaces a post's labels without touching its content, and filters the list by label", async () => {
    const o = await org();
    const stranger = await org();
    const a = await create(o, o.member, 'B chiến dịch', 'blue');
    const b = await create(o, o.member, 'A khách hàng', 'pink');
    const c = await create(o, o.member, 'C chủ đề');
    const foreign = await create(stranger, stranger.member, 'Của người khác');
    const first = await post(o, 'Bài một');
    const second = await post(o, 'Bài hai');
    const before = await get(o, first);
    expect(before.labelIds).toEqual([]);

    expect(await exec(o, o.member, 'social.post.set_labels', { postId: first, labelIds: [a, b] })).toEqual({ postId: first, labelIds: [a, b] });
    const after = await get(o, first);
    // By label name; the content, its revision and hash and the change time stay as they were.
    expect(after.labelIds).toEqual([b, a]);
    expect([after.revision, after.updatedAt, after.variants.map((v) => [v.revision, v.contentHash, v.status])]).toEqual([
      before.revision,
      before.updatedAt,
      before.variants.map((v) => [v.revision, v.contentHash, v.status]),
    ]);
    // Replaced, not added to.
    await exec(o, o.admin, 'social.post.set_labels', { postId: first, labelIds: [c, a] });
    expect((await get(o, first)).labelIds).toEqual([a, c]);
    await exec(o, o.member, 'social.post.set_labels', { postId: second, labelIds: [a] });

    await expect(exec(o, o.viewer, 'social.post.set_labels', { postId: first, labelIds: [] })).rejects.toMatchObject({ status: 403 });
    await expect(exec(o, o.member, 'social.post.set_labels', { postId: first, labelIds: [a, foreign] })).rejects.toMatchObject({ code: 'LABEL_NOT_FOUND', status: 404 });
    await expect(exec(o, o.member, 'social.post.set_labels', { postId: first, labelIds: [a, a] })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(exec(o, o.member, 'social.post.set_labels', { postId: first, labelIds: Array.from({ length: 11 }, () => randomUUID()) })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(exec(o, o.member, 'social.post.set_labels', { postId: randomUUID(), labelIds: [a] })).rejects.toMatchObject({ code: 'POST_NOT_FOUND' });
    // Another org can neither label this org's post nor use this org's label.
    await expect(exec(stranger, stranger.member, 'social.post.set_labels', { postId: first, labelIds: [] })).rejects.toMatchObject({ code: 'POST_NOT_FOUND' });
    const theirs = await post(stranger, 'Bài của họ');
    await expect(exec(stranger, stranger.member, 'social.post.set_labels', { postId: theirs, labelIds: [a] })).rejects.toMatchObject({ code: 'LABEL_NOT_FOUND' });
    expect((await get(o, first)).labelIds).toEqual([a, c]);

    const list = (labelId: string) => query<PostView[]>(o, o.viewer, 'social.post.list', { labelId });
    expect((await list(a)).map((p) => p.id).sort()).toEqual([first, second].sort());
    expect((await list(c)).map((p) => p.id)).toEqual([first]);
    expect(await list(b)).toEqual([]);
    expect(await query<PostView[]>(o, o.viewer, 'social.post.list', { labelId: foreign })).toEqual([]);
    expect((await labels(o, o.viewer)).map((l) => [l.name, l.postCount])).toEqual([
      ['A khách hàng', 0],
      ['B chiến dịch', 2],
      ['C chủ đề', 1],
    ]);

    // Clearing them, and deleting a label takes it off every post.
    await exec(o, o.member, 'social.post.set_labels', { postId: second, labelIds: [] });
    expect((await get(o, second)).labelIds).toEqual([]);
    await exec(o, o.owner, 'social.label.delete', { labelId: a });
    expect((await get(o, first)).labelIds).toEqual([c]);
    expect(await admin(async (cl) => (await cl.query('SELECT 1 FROM crove_social.post_label WHERE label_id = $1', [a])).rowCount)).toBe(0);
  });

  it('compares posts by label, format and hashtag in What works (#705)', async () => {
    const o = await org();
    const sale = await create(o, o.member, 'Khuyến mãi');
    const rows: [string, number, boolean][] = [
      ['#GiamGia Bài một', 30, true],
      ['#giamgia Bài hai', 10, true],
      ['#giamgia Bài ba', 20, false],
      ['Bài bốn', 2, false],
    ];
    for (const [body, reactions, tagged] of rows) {
      const postId = await post(o, body);
      if (tagged) await exec(o, o.member, 'social.post.set_labels', { postId, labelIds: [sale] });
      await admin(async (c) => {
        const { rows: v } = await c.query<{ id: string }>("UPDATE crove_social.post_variant SET status = 'published', published_at = now() WHERE post_id = $1 RETURNING id", [postId]);
        await c.query('INSERT INTO crove_social.metric_snapshot (org_id, variant_id, capture_key, metrics) VALUES ($1, $2, $3, $4)', [o.orgId, v[0]?.id, 'k1', JSON.stringify({ reactions })]);
      });
    }
    type Insights = { channels: { posts: number; median: number; best: { excerpt: string; engagement: number }[]; byLabel: unknown[]; byFormat: { key: string }[]; byHashtag: unknown[] }[]; truncated: boolean };
    const insights = (input: Record<string, unknown>) => query<Insights>(o, o.viewer, 'social.metrics.insights', { days: 30, timeZone: 'Asia/Ho_Chi_Minh', ...input });
    const all = await insights({});
    expect(all.truncated).toBe(false);
    expect(all.channels).toHaveLength(1);
    const [c] = all.channels;
    expect(c).toMatchObject({ posts: 4, median: 15 });
    expect(c?.best[0]).toEqual(expect.objectContaining({ excerpt: '#GiamGia Bài một', engagement: 30 }));
    expect(c?.byLabel).toEqual([{ key: sale, posts: 2, median: 20, ratio: 20 / 15 }]);
    expect(c?.byHashtag).toEqual([{ key: 'giamgia', posts: 3, median: 20, ratio: 20 / 15 }]);
    expect(c?.byFormat.map((g) => g.key)).toEqual(['text']);
    expect((await insights({ labelId: sale })).channels[0]).toMatchObject({ posts: 2, median: 20 });
    await expect(insights({ timeZone: 'Mars/Base' })).rejects.toThrow();
  });
  it('filters the metrics summary and export by label and writes the labels column', async () => {
    const o = await org();
    const campaign = await create(o, o.member, 'Tết 2027', 'red');
    const client = await create(o, o.member, '=Khách A');
    const tagged = await post(o, 'Bài có nhãn');
    const plain = await post(o, 'Bài không nhãn');
    await exec(o, o.member, 'social.post.set_labels', { postId: tagged, labelIds: [campaign, client] });
    for (const postId of [tagged, plain]) {
      await admin(async (c) => {
        const { rows } = await c.query<{ id: string }>("UPDATE crove_social.post_variant SET status = 'published', published_at = now() WHERE post_id = $1 RETURNING id", [postId]);
        await c.query("INSERT INTO crove_social.metric_snapshot (org_id, variant_id, capture_key, metrics) VALUES ($1, $2, 'k1', '{\"reach\": 7}')", [o.orgId, rows[0]?.id]);
      });
    }
    const summary = (input: Record<string, unknown>) => query<MetricsRow[]>(o, o.viewer, 'social.metrics.summary', input);
    expect((await summary({})).map((r) => r.postId).sort()).toEqual([tagged, plain].sort());
    expect((await summary({ labelId: campaign })).map((r) => [r.postId, r.metrics.reach])).toEqual([[tagged, 7]]);
    expect(await summary({ labelId: randomUUID() })).toEqual([]);

    const file = await exec<{ csv: string }>(o, o.viewer, 'social.metrics.export', { days: 30, labelId: campaign });
    const lines = file.csv.replace(/^﻿/, '').trim().split('\r\n');
    expect(lines[0]?.split(',').slice(5, 8)).toEqual(['text', 'labels', 'impressions']);
    expect(lines).toHaveLength(2);
    // Label names by name, joined; a name a spreadsheet would run as a formula is kept as text.
    expect(lines[1]).toContain(`,Bài có nhãn,'=Khách A; Tết 2027,`);
    const all = await exec<{ csv: string }>(o, o.viewer, 'social.metrics.export', { days: 30 });
    const rows = all.csv.replace(/^﻿/, '').trim().split('\r\n').slice(1);
    expect(rows).toHaveLength(2);
    expect(rows.find((l) => l.startsWith(plain))).toContain(',Bài không nhãn,,');
    const audits = await admin(
      async (c) =>
        (await c.query<{ detail: Record<string, unknown> }>("SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'social.metrics.export' AND outcome = 'ok' ORDER BY occurred_at", [o.orgId]))
          .rows,
    );
    expect(audits.map((a) => a.detail.labelId ?? null)).toEqual([campaign, null]);
  });

  it('keeps labels to their org and lets tenant roles change only the name and colour', async () => {
    const o = await org();
    const stranger = await org();
    const labelId = await create(o, o.member, 'Riêng');
    expect(await labels(stranger, stranger.owner)).toEqual([]);
    await expect(exec(stranger, stranger.owner, 'social.label.update', { labelId, name: 'x', color: 'gray' })).rejects.toMatchObject({ code: 'LABEL_NOT_FOUND' });
    await expect(exec(stranger, stranger.owner, 'social.label.delete', { labelId })).rejects.toMatchObject({ code: 'LABEL_NOT_FOUND' });
    // The same name is free in another org.
    await create(stranger, stranger.owner, 'Riêng');
    const updatable = (table: string) =>
      admin(async (c) =>
        (
          await c.query<{ column_name: string }>(
            "SELECT column_name FROM information_schema.column_privileges WHERE grantee = 'crove_tenant' AND table_schema = 'crove_social' AND table_name = $1 AND privilege_type = 'UPDATE' ORDER BY 1",
            [table],
          )
        ).rows.map((r) => r.column_name),
      );
    // The name and colour, and the campaign's dates and tags (#1169).
    expect(await updatable('label')).toEqual(['color', 'ends_on', 'name', 'starts_on', 'utm_campaign', 'utm_medium']);
    expect(await updatable('post_label')).toEqual([]);
    const asTenant = (statement: string, params: unknown[]) =>
      admin(async (c) => {
        await c.query('BEGIN');
        try {
          await c.query('SET LOCAL ROLE crove_tenant');
          await c.query(statement, params);
        } finally {
          await c.query('ROLLBACK');
        }
      });
    await expect(asTenant('UPDATE crove_social.label SET created_by = $1 WHERE id = $2', [o.owner, labelId])).rejects.toThrow(/permission denied/);
    await expect(asTenant('UPDATE crove_social.label SET created_at = now() WHERE id = $1', [labelId])).rejects.toThrow(/permission denied/);
    await expect(asTenant('UPDATE crove_social.label SET org_id = $1 WHERE id = $2', [stranger.orgId, labelId])).rejects.toThrow(/permission denied/);
    // The campaign's columns are writable (RLS still keeps the row to its org; this transaction sets none, so it sees
    // and changes nothing).
    await asTenant("UPDATE crove_social.label SET starts_on = '2027-01-01', ends_on = '2027-01-31', utm_campaign = 'tet', utm_medium = 'social' WHERE id = $1", [labelId]);
  });

  it('keeps a campaign label to real dates and UTM tags, whoever writes it (#1169)', async () => {
    const o = await org();
    const labelId = await create(o, o.member, 'Thường');
    const set = (columns: string, values: unknown[]) => admin((c) => c.query(`UPDATE crove_social.label SET ${columns} WHERE id = $1`, [labelId, ...values]));
    // A label without a campaign keeps NULL in all four.
    expect(
      await admin(async (c) => (await c.query('SELECT starts_on, ends_on, utm_campaign, utm_medium FROM crove_social.label WHERE id = $1', [labelId])).rows[0]),
    ).toEqual({ starts_on: null, ends_on: null, utm_campaign: null, utm_medium: null });
    await set("starts_on = '2027-02-01', ends_on = '2027-02-01'", []);
    await set("starts_on = NULL, ends_on = '2027-02-01'", []);
    await expect(set("starts_on = '2027-02-02', ends_on = '2027-02-01'", [])).rejects.toThrow(/label_campaign_dates_check/);
    for (const ok of ['tet-2027', 'Tết Nguyên Đán 2027', 'q1_sale/vn+hcm', "a.b,c:d;e!f?g'h(i)&j%k@l#m", '中文活动', 'x'.repeat(100)]) {
      await set('utm_campaign = $2, utm_medium = $2', [ok]);
    }
    for (const bad of ['a*b', 'a"b', 'a<b>', 'a=b', 'a|b', 'a\tb', 'a\nb', '😀', ' lead', 'trail ', '', 'x'.repeat(101), 'Tết'.normalize('NFD')]) {
      await expect(set('utm_campaign = $2', [bad])).rejects.toThrow(/label_utm_campaign_check/);
      await expect(set("utm_campaign = 'ok', utm_medium = $2", [bad])).rejects.toThrow(/label_utm_medium_check/);
    }
    // A medium only with a campaign.
    await expect(set("utm_campaign = NULL, utm_medium = 'email'", [])).rejects.toThrow(/label_utm_medium_check/);
  });

  it('lets owners and admins give a label its campaign, and members only plain labels (#1169)', async () => {
    const o = await org();
    const find = async (id: string) => (await labels(o, o.viewer)).find((l) => l.id === id);
    const tet = (await exec<{ labelId: string }>(o, o.owner, 'social.label.create', { name: 'Tết', startsOn: '2027-01-20', endsOn: '2027-02-15', utmCampaign: '  Tết 2027 '.normalize('NFD'), utmMedium: 'social' })).labelId;
    // Kept NFC and trimmed, as the links carry it.
    expect(await find(tet)).toMatchObject({ startsOn: '2027-01-20', endsOn: '2027-02-15', utmCampaign: 'Tết 2027', utmMedium: 'social' });
    const plain = await create(o, o.member, 'Khách A');
    expect(await find(plain)).toMatchObject({ startsOn: null, endsOn: null, utmCampaign: null, utmMedium: null });
    await expect(exec(o, o.member, 'social.label.create', { name: 'Hè', utmCampaign: 'he' })).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    await expect(exec(o, o.member, 'social.label.create', { name: 'Hè', startsOn: '2027-06-01' })).rejects.toMatchObject({ status: 403 });
    // Explicit nulls from a member are no campaign.
    await exec(o, o.member, 'social.label.create', { name: 'Hè', startsOn: null, utmCampaign: null });
    await expect(exec(o, o.admin, 'social.label.create', { name: 'Thu', startsOn: '2027-09-30', endsOn: '2027-09-01' })).rejects.toMatchObject({ code: 'LABEL_CAMPAIGN_DATES', status: 422 });
    await expect(exec(o, o.admin, 'social.label.create', { name: 'Thu', startsOn: '2027-02-30' })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(exec(o, o.admin, 'social.label.create', { name: 'Thu', utmCampaign: 'a*b' })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(exec(o, o.admin, 'social.label.create', { name: 'Thu', utmCampaign: '½ giá' })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(exec(o, o.admin, 'social.label.create', { name: 'Thu', utmMedium: 'email' })).rejects.toMatchObject({ code: 'LABEL_UTM_MEDIUM' });

    // A rename alone keeps the campaign; null or an empty tag clears a field; members still change nothing.
    await exec(o, o.admin, 'social.label.update', { labelId: tet, name: 'Tết 2027', color: 'red' });
    expect(await find(tet)).toMatchObject({ name: 'Tết 2027', startsOn: '2027-01-20', endsOn: '2027-02-15', utmCampaign: 'Tết 2027', utmMedium: 'social' });
    await exec(o, o.owner, 'social.label.update', { labelId: tet, name: 'Tết 2027', color: 'red', endsOn: null, utmMedium: '' });
    expect(await find(tet)).toMatchObject({ startsOn: '2027-01-20', endsOn: null, utmCampaign: 'Tết 2027', utmMedium: null });
    await expect(exec(o, o.owner, 'social.label.update', { labelId: tet, name: 'Tết 2027', color: 'red', endsOn: '2027-01-01' })).rejects.toMatchObject({ code: 'LABEL_CAMPAIGN_DATES' });
    await expect(exec(o, o.owner, 'social.label.update', { labelId: tet, name: 'Tết 2027', color: 'red', utmCampaign: null, utmMedium: 'email' })).rejects.toMatchObject({ code: 'LABEL_UTM_MEDIUM' });
    await expect(exec(o, o.member, 'social.label.update', { labelId: tet, name: 'Tết 2027', color: 'red', utmCampaign: 'x' })).rejects.toMatchObject({ status: 403 });
    await exec(o, o.admin, 'social.label.update', { labelId: plain, name: 'Khách A', color: 'gray', utmCampaign: 'khach-a' });
    expect(await find(plain)).toMatchObject({ startsOn: null, endsOn: null, utmCampaign: 'khach-a', utmMedium: null });
  });

  it("flags a waiting channel that misses its campaign label's UTM campaign or dates in pre_review (#1169)", async () => {
    const o = await org();
    const second = randomUUID();
    await admin((c) =>
      c.query('INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, $3, $4, $5, $6)', [
        o.orgId,
        second,
        'sandbox',
        `acct-${second.slice(0, 8)}`,
        'Trang hai',
        o.owner,
      ]),
    );
    const tet = (await exec<{ labelId: string }>(o, o.owner, 'social.label.create', { name: 'Tết', startsOn: '2099-01-20', endsOn: '2099-02-15', utmCampaign: 'tet-2099' })).labelId;
    const plain = await create(o, o.member, 'Khách A');
    // Noon in Hồ Chí Minh City on 10 March 2099, after the campaign.
    const { postId } = await exec<{ postId: string }>(o, o.member, 'social.post.create', {
      body: 'Ưu đãi',
      linkUrl: 'https://shop.example/uu-dai',
      timeZone: 'Asia/Ho_Chi_Minh',
      scheduledAt: '2099-03-10T05:00:00Z',
      channels: [
        { connectionId: o.connection, settings: { utm: { campaign: 'Tet-2099', medium: 'social' } } },
        { connectionId: second, settings: { utm: { campaign: 'tet-2099', medium: 'social' } } },
      ],
    });
    type Review = { findings: string[] };
    const review = async () => (await query<Review>(o, o.owner, 'social.post.pre_review', { postId })).findings;
    // Before review nothing waits; with a plain label, nothing about campaigns.
    await exec(o, o.member, 'social.post.set_labels', { postId, labelIds: [plain] });
    await exec(o, o.member, 'social.post.submit', { postId });
    expect((await review()).filter((f) => f.includes('chiến dịch') || f.includes('UTM'))).toEqual([]);

    await exec(o, o.member, 'social.post.set_labels', { postId, labelIds: [plain, tet] });
    const found = (await review()).filter((f) => f.includes('chiến dịch') || f.includes('UTM'));
    expect(found).toEqual([
      'Trang thử: UTM campaign "Tet-2099" khác với "tet-2099" của nhãn "Tết", số liệu chiến dịch sẽ bị tách làm hai.',
      'Trang thử: hẹn đăng ngày 10/03/2099, ngoài thời gian chiến dịch "Tết" (từ 20/01/2099 đến 15/02/2099).',
      'Trang hai: hẹn đăng ngày 10/03/2099, ngoài thời gian chiến dịch "Tết" (từ 20/01/2099 đến 15/02/2099).',
    ]);
    // Inside the dates and with the label's campaign, nothing.
    await exec(o, o.owner, 'social.label.update', { labelId: tet, name: 'Tết', color: 'gray', utmCampaign: 'Tet-2099', endsOn: '2099-03-10' });
    expect((await review()).filter((f) => f.includes('chiến dịch') || f.includes('UTM'))).toEqual([
      'Trang hai: UTM campaign "tet-2099" khác với "Tet-2099" của nhãn "Tết", số liệu chiến dịch sẽ bị tách làm hai.',
    ]);
  });
});
