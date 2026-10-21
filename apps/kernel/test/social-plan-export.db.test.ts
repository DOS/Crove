// The content plan export (#978) on PostgreSQL 17: members and above export the channel posts of a range as a CSV
// file, one row per channel post with its time in the zone asked for, filtered by channel and label, capped at 500
// rows with a truncated flag, audited with counts only; another org's posts never join; and the file stripped to the
// import's columns goes back through the app's own import as the same drafts. Set CROVE_TEST_ADMIN_URL to a superuser
// URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { socialCommands, socialQueries, type PlanRow, type PostView } from '@crove/mod-social';
import { parseCsv } from '../../app/src/lib/bank-statement.ts';
import { importRows } from '../../app/src/lib/social-import.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const DAY = 86_400_000;
const HOUR = 3_600_000;

type Export = { filename: string; csv: string | null; rows: PlanRow[] | null; truncated: boolean };

suite('social content plan export on PostgreSQL (#978)', () => {
  const dbName = `crove_test_social_plan_export_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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

  const person = async (name: string) => {
    const email = `${name}-${randomUUID().slice(0, 8)}@plan-export.test`;
    return { id: await upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email, name: null }), email };
  };

  type Org = { orgId: string; owner: string; admin: string; member: string; viewer: string; memberEmail: string };
  async function org(): Promise<Org> {
    const owner = await person('owner');
    const { orgId } = await createOrg(rt, asUser(owner.id), `Org ${randomUUID().slice(0, 6)}`);
    const roles = { admin: await person('admin'), member: await person('member'), viewer: await person('viewer') };
    for (const [role, p] of Object.entries(roles)) {
      await admin((c) => c.query('INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, $3)', [orgId, p.id, role]));
    }
    return { orgId, owner: owner.id, admin: roles.admin.id, member: roles.member.id, viewer: roles.viewer.id, memberEmail: roles.member.email };
  }

  async function connection(o: Org, name: string) {
    const id = randomUUID();
    await admin((c) =>
      c.query('INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, $3, $4, $5, $6)', [
        o.orgId,
        id,
        'sandbox',
        `acct-${id.slice(0, 8)}`,
        name,
        o.owner,
      ]),
    );
    return id;
  }

  const exec = <O>(o: Org, user: string, name: string, input: unknown) => rt.execute<O>(name, input, { actor: asUser(user), orgId: o.orgId });
  const get = (o: Org, postId: string) => rt.query<PostView>('social.post.get', { postId }, { actor: asUser(o.owner), orgId: o.orgId });
  const create = async (o: Org, input: { body: string; title?: string; linkUrl?: string; at?: Date; channels: string[] }) =>
    (
      await exec<{ postId: string; variants: { variantId: string; connectionId: string }[] }>(o, o.member, 'social.post.create', {
        body: input.body,
        ...(input.title ? { title: input.title } : {}),
        ...(input.linkUrl ? { linkUrl: input.linkUrl } : {}),
        ...(input.at ? { scheduledAt: input.at.toISOString() } : {}),
        channels: input.channels.map((connectionId) => ({ connectionId })),
      })
    );
  const exportPlan = (o: Org, user: string, input: Record<string, unknown>) => exec<Export>(o, user, 'social.plan.export', input);
  const refusal = (p: Promise<unknown>) => p.then(() => 'resolved', (e: unknown) => (e as { code?: string }).code ?? String(e));
  const lines = (csv: string | null) => (csv ?? '').replace(/^\uFEFF/, '').split('\r\n').filter((l) => l !== '');

  // A day well ahead at 00:00 UTC, so every planned time is in the future and the import takes it.
  const base = new Date(Math.floor((Date.now() + 40 * DAY) / DAY) * DAY);
  const range = { from: base.toISOString(), to: new Date(base.getTime() + 3 * DAY).toISOString() };

  let a: Org;
  let other: Org;
  let quanA: string;
  let quanB: string;
  let launch: string;
  let tet: string;
  const posts: Record<string, { postId: string; variants: { variantId: string; connectionId: string }[] }> = {};

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const url = new URL(ADMIN as string);
    url.pathname = `/${dbName}`;
    adminUrl = url.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    const registry = { commands: [...kernelCommands, ...socialCommands], queries: [...kernelQueries({ inboundDomain: null }), ...socialQueries] };
    const app = new URL(adminUrl);
    app.username = 'crove_app';
    app.password = 'test-app-pw';
    pool = createPool({ connectionString: app.toString(), max: 4 });
    db = createDb(pool);
    rt = new Runtime(db).register(registry);

    a = await org();
    other = await org();
    quanA = await connection(a, 'Quán A');
    quanB = await connection(a, 'Quán B');
    launch = (await exec<{ labelId: string }>(a, a.member, 'social.label.create', { name: 'Khai trương' })).labelId;
    tet = (await exec<{ labelId: string }>(a, a.member, 'social.label.create', { name: 'Tết' })).labelId;
    // 09:00 in Ho Chi Minh City on the first day, on both channels, with a title, a link, a label and an assignee.
    posts.opening = await create(a, { body: 'Khai trương chi nhánh Quận 3, giảm 20% tuần đầu', title: 'Khai trương', linkUrl: 'https://example.test/q3', at: new Date(base.getTime() + 2 * HOUR), channels: [quanA, quanB] });
    await exec(a, a.member, 'social.post.set_labels', { postId: posts.opening.postId, labelIds: [launch] });
    await exec(a, a.member, 'social.post.assign', { postId: posts.opening.postId, assigneeUserId: a.member, dueAt: null });
    // The next day, sent to review, with the other label; its text starts with what a spreadsheet would run.
    posts.review = await create(a, { body: '- Lì xì đầu năm\n- Quà cho khách quen', at: new Date(base.getTime() + DAY + 3 * HOUR), channels: [quanA] });
    await exec(a, a.member, 'social.post.set_labels', { postId: posts.review.postId, labelIds: [tet] });
    await exec(a, a.member, 'social.post.submit', { postId: posts.review.postId });
    // Left out: a draft with no time, one after the range, and a cancelled channel.
    posts.untimed = await create(a, { body: 'Chưa có giờ', channels: [quanA] });
    posts.later = await create(a, { body: 'Tháng sau', at: new Date(base.getTime() + 10 * DAY), channels: [quanA] });
    posts.cancelled = await create(a, { body: 'Đã hủy', at: new Date(base.getTime() + 5 * HOUR), channels: [quanB] });
    await exec(a, a.member, 'social.variant.cancel', { variantIds: posts.cancelled.variants.map((v) => v.variantId) });
    // Another org's post in the same hours.
    const theirs = await connection(other, 'Quán A');
    posts.theirs = await create(other, { body: 'Bài của tổ chức khác', at: new Date(base.getTime() + 2 * HOUR), channels: [theirs] });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('writes one row per channel post of the range, in the zone asked for, with labels, assignee and status', async () => {
    const file = await exportPlan(a, a.member, { ...range, timeZone: 'Asia/Ho_Chi_Minh' });
    expect(file.truncated).toBe(false);
    expect(file.rows).toBeNull();
    expect(file.filename).toBe(`crove-ke-hoach-${base.toISOString().slice(0, 7)}.csv`);
    expect(file.csv?.startsWith('\uFEFF')).toBe(true);
    const day = (offset: number) => new Date(base.getTime() + offset * DAY).toISOString().slice(0, 10);
    expect(lines(file.csv)).toEqual([
      'text,title,link,channels,time,status,labels,assignee,post_id',
      `"Khai trương chi nhánh Quận 3, giảm 20% tuần đầu",Khai trương,https://example.test/q3,Quán A,${day(0)} 09:00,draft,Khai trương,${a.memberEmail},${posts.opening?.postId}`,
      `"Khai trương chi nhánh Quận 3, giảm 20% tuần đầu",Khai trương,https://example.test/q3,Quán B,${day(0)} 09:00,draft,Khai trương,${a.memberEmail},${posts.opening?.postId}`,
      `"'- Lì xì đầu năm\n- Quà cho khách quen",,,Quán A,${day(1)} 10:00,in_review,Tết,,${posts.review?.postId}`,
    ]);
    // The same instants in New York: the evening before there.
    const ny = await exportPlan(a, a.owner, { ...range, timeZone: 'America/New_York' });
    const inNewYork = (ms: number) => {
      const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(ms).map((x) => [x.type, x.value]));
      return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
    };
    const opening = base.getTime() + 2 * HOUR;
    expect(lines(ny.csv).slice(1).map((l) => /,(\d{4}-\d{2}-\d{2} \d{2}:\d{2}),/.exec(l)?.[1])).toEqual([inNewYork(opening), inNewYork(opening), inNewYork(base.getTime() + DAY + 3 * HOUR)]);
    expect(inNewYork(opening).slice(0, 10)).toBe(new Date(base.getTime() - DAY).toISOString().slice(0, 10));
  });

  it('keeps to the channels and labels picked, and gives rows for the print layout', async () => {
    const onB = await exportPlan(a, a.member, { ...range, timeZone: 'UTC', connectionIds: [quanB] });
    expect(lines(onB.csv).slice(1).map((l) => l.split(',').at(-1))).toEqual([posts.opening?.postId]);
    const tagged = await exportPlan(a, a.member, { ...range, timeZone: 'UTC', labelIds: [tet] });
    expect(lines(tagged.csv)).toHaveLength(2);
    expect(lines(tagged.csv)[1]).toContain(posts.review?.postId);
    const either = await exportPlan(a, a.member, { ...range, timeZone: 'UTC', labelIds: [tet, launch], connectionIds: [quanA] });
    expect(lines(either.csv)).toHaveLength(3);

    const print = await exportPlan(a, a.admin, { ...range, timeZone: 'UTC', format: 'print' });
    expect(print.csv).toBeNull();
    expect(print.rows?.map((r) => [r.postId, r.channel, r.status, r.labels, r.assignee])).toEqual([
      [posts.opening?.postId, 'Quán A', 'draft', ['Khai trương'], a.memberEmail],
      [posts.opening?.postId, 'Quán B', 'draft', ['Khai trương'], a.memberEmail],
      [posts.review?.postId, 'Quán A', 'in_review', ['Tết'], null],
    ]);
    expect(print.rows?.[0]).toMatchObject({ title: 'Khai trương', linkUrl: 'https://example.test/q3', at: new Date(base.getTime() + 2 * HOUR).toISOString(), provider: 'sandbox' });
  });

  it('shows a published channel at its publish time with the text it went out with', async () => {
    const out = await create(a, { body: 'Đã đăng', at: new Date(base.getTime() + 30 * HOUR), channels: [quanA] });
    const variantId = out.variants[0]?.variantId as string;
    await admin((c) =>
      c.query("UPDATE crove_social.post_variant SET status = 'published', published_at = $2, content_frozen = true, body = 'Bản đã đăng' WHERE org_id = $1 AND id = $3", [
        a.orgId,
        new Date(base.getTime() + 2 * DAY + 4 * HOUR),
        variantId,
      ]),
    );
    const print = await exportPlan(a, a.member, { ...range, timeZone: 'UTC', format: 'print' });
    expect(print.rows?.at(-1)).toMatchObject({ variantId, status: 'published', body: 'Bản đã đăng', at: new Date(base.getTime() + 2 * DAY + 4 * HOUR).toISOString() });
    await admin((c) => c.query("UPDATE crove_social.post_variant SET status = 'cancelled' WHERE org_id = $1 AND id = $2", [a.orgId, variantId]));
  });

  it("never holds another org's posts, and is for members and above over at most 92 days", async () => {
    const mine = await exportPlan(a, a.member, { ...range, timeZone: 'UTC' });
    expect(mine.csv).not.toContain('Bài của tổ chức khác');
    expect(mine.csv).not.toContain(posts.theirs?.postId);
    const theirs = await exportPlan(other, other.member, { ...range, timeZone: 'UTC' });
    expect(lines(theirs.csv).slice(1)).toEqual([expect.stringContaining(posts.theirs?.postId as string)]);
    // Another org's channel as a filter finds nothing here.
    const foreign = posts.theirs?.variants[0]?.connectionId as string;
    expect(lines((await exportPlan(a, a.member, { ...range, timeZone: 'UTC', connectionIds: [foreign] })).csv)).toHaveLength(1);

    await expect(exportPlan(a, a.viewer, { ...range, timeZone: 'UTC' })).rejects.toMatchObject({ status: 403 });
    expect(await refusal(exportPlan(a, a.member, { from: range.from, to: new Date(base.getTime() + 93 * DAY).toISOString(), timeZone: 'UTC' }))).toBe('PLAN_RANGE_INVALID');
    expect(await refusal(exportPlan(a, a.member, { from: range.to, to: range.from, timeZone: 'UTC' }))).toBe('PLAN_RANGE_INVALID');
    expect(await refusal(exportPlan(a, a.member, { ...range, timeZone: '+07:00' }))).toBe('VALIDATION');
    expect((await exportPlan(a, a.member, { from: range.from, to: new Date(base.getTime() + 92 * DAY).toISOString(), timeZone: 'UTC' })).truncated).toBe(false);
  });

  it('audits every export with its counts only', async () => {
    const audits = await admin(
      async (c) =>
        (await c.query<{ actor_id: string; detail: Record<string, unknown> }>("SELECT actor_id, detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'social.plan.export' AND outcome = 'ok' ORDER BY occurred_at, id", [a.orgId]))
          .rows,
    );
    expect(audits.length).toBeGreaterThanOrEqual(8);
    expect(audits[0]?.actor_id).toBe(a.member);
    expect(audits[0]?.detail).toMatchObject({ format: 'csv', days: 3, rows: 3, truncated: false, channels: 0, labels: 0 });
    expect(audits.find((x) => x.detail.format === 'print')?.detail).toMatchObject({ rows: 3, channels: 0, labels: 0 });
    expect(audits.some((x) => x.detail.channels === 1 && x.detail.labels === 0)).toBe(true);
    const text = JSON.stringify(audits.map((x) => x.detail));
    for (const secret of [quanA, quanB, tet, launch, posts.opening?.postId as string, 'Khai trương', a.memberEmail]) expect(text).not.toContain(secret);
  });

  it('goes back through the import as the same drafts once stripped to its columns', async () => {
    // The browser's zone, the one the app sends and the import reads times in.
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const file = await exportPlan(a, a.member, { ...range, timeZone: zone, connectionIds: [quanA, quanB] });
    // What a client does in a spreadsheet: keep the first five columns.
    const sheet = parseCsv(file.csv as string);
    for (const cells of sheet.values()) for (const col of cells.keys()) if (col >= 5) cells.delete(col);
    const channels = [
      { id: quanA, displayName: 'Quán A', provider: 'sandbox', status: 'active' },
      { id: quanB, displayName: 'Quán B', provider: 'sandbox', status: 'active' },
    ];
    const rows = importRows(sheet, channels) ?? [];
    expect(rows).toHaveLength(3);
    expect(rows.flatMap((r) => r.problems)).toEqual([]);
    const done = await exec<{ posts: { postId: string }[] }>(a, a.member, 'social.post.import', {
      posts: rows.map((r) => ({ body: r.body, title: r.title || null, linkUrl: r.link || null, ...(r.plannedAt ? { scheduledAt: r.plannedAt } : {}), timeZone: zone, connectionIds: r.connectionIds })),
    });
    const shape = (p: PostView) =>
      p.variants
        .filter((v) => v.status !== 'cancelled')
        .map((v) => ({ connectionId: v.connectionId, body: v.effective.body, title: v.effective.title, linkUrl: v.effective.linkUrl, at: v.effectiveAt, status: v.status === 'in_review' ? 'draft' : v.status }));
    const before = [...shape(await get(a, posts.opening?.postId as string)), ...shape(await get(a, posts.review?.postId as string))];
    const after = (await Promise.all(done.posts.map(async (p) => shape(await get(a, p.postId))))).flat();
    expect(after).toEqual(before);
    // They are new drafts, not the old posts.
    expect(done.posts.map((p) => p.postId)).not.toContain(posts.opening?.postId);
  });

  it('stops at 500 rows and says it was cut', async () => {
    const big = await org();
    const conn = await connection(big, 'Kênh lớn');
    const at = (i: number) => new Date(base.getTime() + 4 * HOUR + i * 60_000).toISOString();
    for (const [start, count] of [
      [0, 200],
      [200, 200],
      [400, 101],
    ] as const) {
      await exec(big, big.member, 'social.post.import', { posts: Array.from({ length: count }, (_, i) => ({ body: `Bài ${start + i + 1}`, scheduledAt: at(start + i), connectionIds: [conn] })) });
    }
    const file = await exportPlan(big, big.member, { ...range, timeZone: 'UTC' });
    expect(file.truncated).toBe(true);
    expect(lines(file.csv)).toHaveLength(501);
    // The first 500 by time: the last one left out is the 501st.
    expect(file.csv).toContain('Bài 500,');
    expect(file.csv).not.toContain('Bài 501,');
    const audit = await admin(async (c) => (await c.query<{ detail: Record<string, unknown> }>("SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'social.plan.export'", [big.orgId])).rows);
    expect(audit.map((x) => x.detail)).toEqual([expect.objectContaining({ rows: 500, truncated: true })]);
  }, 180_000);
});
