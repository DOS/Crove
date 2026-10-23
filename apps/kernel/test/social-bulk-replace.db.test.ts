// Find and replace across Social posts on PostgreSQL 17 (#1144): the preview and the command agree post by post; each
// change runs as the single edits (social.post.update, social.variant.update) with their audit rows and versions; an
// approved and scheduled channel goes back to draft as after a single edit; a blocked word the change would add leaves
// that post out and the others go on; a member limited to some channels (#1081) changes nothing on the others and
// learns nothing of a post they cannot see (#1099); and the input is bounded, the pattern literal.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { socialCommands, socialQueries, type BulkEditResult, type BulkReplacePreview, type PostView, type VersionView } from '@crove/mod-social';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const HOUR = 3_600_000;

suite('social find and replace on PostgreSQL (#1144)', () => {
  const dbName = `crove_test_social_bulk_replace_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  type Org = { orgId: string; owner: string; member: string; viewer: string; a: string; b: string };

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  const person = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@bulk-replace.test`, name: null });
  async function connection(orgId: string, owner: string, name: string) {
    const id = randomUUID();
    await admin((c) =>
      c.query('INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, $3, $4, $5, $6)', [orgId, id, 'sandbox', `acct-${id.slice(0, 8)}`, name, owner]),
    );
    return id;
  }
  // An org with an owner, a member and a viewer, and two channels A and B.
  async function org(): Promise<Org> {
    const owner = await person('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    const member = await person('member');
    const viewer = await person('viewer');
    await admin((c) => c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'viewer')", [orgId, member, viewer]));
    return { orgId, owner, member, viewer, a: await connection(orgId, owner, 'Kênh A'), b: await connection(orgId, owner, 'Kênh B') };
  }

  const exec = <O>(o: Org, user: string, name: string, input: unknown) => rt.execute<O>(name, input, { actor: asUser(user), orgId: o.orgId });
  const get = (o: Org, postId: string) => rt.query<PostView>('social.post.get', { postId }, { actor: asUser(o.owner), orgId: o.orgId });
  async function post(o: Org, connections: string[], content: { body: string; title?: string; linkUrl?: string }) {
    const { postId } = await exec<{ postId: string }>(o, o.owner, 'social.post.create', { ...content, channels: connections.map((connectionId) => ({ connectionId })) });
    return postId;
  }
  const variantOn = async (o: Org, postId: string, connectionId: string) => {
    const v = (await get(o, postId)).variants.find((x) => x.connectionId === connectionId);
    if (!v) throw new Error('no variant on that channel');
    return v;
  };
  const own = async (o: Org, postId: string, connectionId: string, edit: Record<string, unknown>) => {
    const v = await variantOn(o, postId, connectionId);
    await exec(o, o.owner, 'social.variant.update', { variantId: v.id, revision: v.revision, ...edit });
  };
  const preview = (o: Org, user: string, input: Record<string, unknown>) => rt.query<BulkReplacePreview>('social.post.bulk_replace_preview', input, { actor: asUser(user), orgId: o.orgId });
  const replace = (o: Org, user: string, input: Record<string, unknown>) => exec<BulkEditResult>(o, user, 'social.post.bulk_replace', input);
  const versions = async (o: Org, postId: string) => (await rt.query<{ versions: VersionView[] }>('social.post.versions', { postId }, { actor: asUser(o.owner), orgId: o.orgId })).versions;
  const audits = (o: Org, command: string, outcome = 'ok') =>
    admin(async (c) => (await c.query<{ target_id: string | null; detail: Record<string, unknown> | null }>('SELECT target_id, detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = $2 AND outcome = $3 ORDER BY occurred_at, id', [o.orgId, command, outcome])).rows);
  const publish = (o: Org, postId: string) =>
    admin(async (c) => {
      await c.query("UPDATE crove_social.post_variant SET status = 'published', published_at = now() WHERE org_id = $1 AND post_id = $2", [o.orgId, postId]);
      await c.query("UPDATE crove_social.post SET status = 'published' WHERE org_id = $1 AND id = $2", [o.orgId, postId]);
    });
  const sorted = (ids: readonly string[]) => [...ids].sort();
  // What the preview says of each post, as the command answers it.
  const expected = (p: BulkReplacePreview) => ({
    done: p.posts.filter((x) => x.skip === null).map((x) => x.postId),
    skipped: p.posts.filter((x) => x.skip !== null).map((x) => ({ postId: x.postId, reason: x.skip })),
  });

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

  it('changes exactly what the preview listed, through the single edits, with a version before and after', async () => {
    const o = await org();
    const OLD = 'https://shop.example/spring';
    const NEW = 'https://shop.example/summer';
    // The link in the shared text, in B's own text and in A's first comment.
    const shared = await post(o, [o.a, o.b], { body: `Mua tại ${OLD} hôm nay` });
    await own(o, shared, o.b, { body: `Kênh B: ${OLD}` });
    await own(o, shared, o.a, { settings: { firstComment: `Chi tiết: ${OLD}` } });
    // The post's link, approved and scheduled.
    const scheduled = await post(o, [o.a], { body: 'Bài đã lên lịch', linkUrl: OLD });
    await exec(o, o.member, 'social.post.submit', { postId: scheduled });
    const inReview = await variantOn(o, scheduled, o.a);
    await exec(o, o.owner, 'social.variant.decide', { postId: scheduled, decision: 'approved', variants: [{ variantId: inReview.id, revision: inReview.revision, contentHash: inReview.contentHash }] });
    await exec(o, o.owner, 'social.variant.schedule', { postId: scheduled, at: new Date(Date.now() + 2 * HOUR).toISOString() });
    const wasScheduled = await variantOn(o, scheduled, o.a);
    expect(wasScheduled.status).toBe('scheduled');
    const none = await post(o, [o.a], { body: 'Không có liên kết' });
    const published = await post(o, [o.a], { body: `Đã đăng ${OLD}` });
    await publish(o, published);
    const missing = randomUUID();
    const foreign = await org();
    const theirs = await post(foreign, [foreign.a], { body: `Tổ chức khác ${OLD}` });
    const input = { postIds: [shared, scheduled, none, published, missing, theirs], find: OLD, replace: NEW };
    const sharedRevision = (await get(o, shared)).revision;

    const seen = await preview(o, o.member, input);
    // In the order the command takes them, by id.
    expect(seen.posts.map((p) => p.postId)).toEqual(sorted(input.postIds));
    const of = (postId: string) => seen.posts.find((p) => p.postId === postId);
    const va = await variantOn(o, shared, o.a);
    const vb = await variantOn(o, shared, o.b);
    expect(of(shared)?.skip).toBeNull();
    expect(of(shared)?.matches).toEqual(
      expect.arrayContaining([
        { variantId: null, connectionId: null, field: 'body', count: 1, before: 'Mua tại ', match: OLD, after: ' hôm nay' },
        { variantId: vb.id, connectionId: o.b, field: 'body', count: 1, before: 'Kênh B: ', match: OLD, after: '' },
        { variantId: va.id, connectionId: o.a, field: 'first_comment', count: 1, before: 'Chi tiết: ', match: OLD, after: '' },
      ]),
    );
    expect(of(shared)?.matches).toHaveLength(3);
    expect(of(scheduled)).toMatchObject({ skip: null, matches: [{ variantId: null, field: 'link', count: 1 }] });
    expect(of(none)).toEqual({ postId: none, skip: 'no_match', matches: [] });
    expect(of(published)).toEqual({ postId: published, skip: 'published', matches: [] });
    expect(of(missing)).toEqual({ postId: missing, skip: 'not_found', matches: [] });
    // Another org's post is no post of this one.
    expect(of(theirs)).toEqual({ postId: theirs, skip: 'not_found', matches: [] });
    // The preview changed nothing.
    expect((await get(o, shared)).revision).toBe(sharedRevision);

    const result = await replace(o, o.member, input);
    expect(result).toEqual(expected(seen));

    const after = await get(o, shared);
    expect(after.body).toBe(`Mua tại ${NEW} hôm nay`);
    const [na, nb] = [after.variants.find((v) => v.connectionId === o.a), after.variants.find((v) => v.connectionId === o.b)];
    expect(na?.effective.body).toBe(`Mua tại ${NEW} hôm nay`);
    expect(na?.settings.firstComment).toBe(`Chi tiết: ${NEW}`);
    expect(nb?.overrides.body).toBe(`Kênh B: ${NEW}`);
    expect((await get(foreign, theirs)).body).toBe(`Tổ chức khác ${OLD}`);
    expect((await get(o, published)).body).toBe(`Đã đăng ${OLD}`);

    // The scheduled channel goes back to draft with a new revision, as after a single edit, and is no longer scheduled.
    const back = await variantOn(o, scheduled, o.a);
    expect(back).toMatchObject({ status: 'draft', revision: wasScheduled.revision + 1, effective: { linkUrl: NEW, body: 'Bài đã lên lịch' } });
    expect((await get(o, scheduled)).status).toBe('draft');

    // Each change is a single edit's: its own audit row on its post or channel, linked to nothing it did not do.
    expect(sorted((await audits(o, 'social.post.update')).map((r) => r.target_id as string))).toEqual(sorted([shared, scheduled]));
    expect(sorted((await audits(o, 'social.variant.update')).slice(-2).map((r) => r.target_id as string))).toEqual(sorted([va.id, vb.id]));
    const [bulk] = await audits(o, 'social.post.bulk_replace');
    expect(bulk?.detail).toMatchObject({ find: OLD, replace: NEW, case_sensitive: false, whole_word: false, done: 2, post_ids: result.done });

    // The history shows the content before and after.
    const history = await versions(o, scheduled);
    expect(history[0]?.variants[0]?.content.linkUrl).toBe(NEW);
    expect(history.at(-1)?.variants[0]?.content.linkUrl).toBe(OLD);
    const sharedHistory = await versions(o, shared);
    const newest = sharedHistory[0]?.variants.find((v) => v.variantId === vb.id);
    expect(newest?.content.body).toBe(`Kênh B: ${NEW}`);
    expect(sharedHistory.some((v) => v.variants.find((x) => x.variantId === va.id)?.content.body === `Mua tại ${OLD} hôm nay`)).toBe(true);

    // Run again, nothing matches any more.
    expect((await preview(o, o.member, input)).posts.filter((p) => p.skip === null)).toEqual([]);
  });

  it('leaves out a post the change would give a blocked word, and goes on with the others', async () => {
    const o = await org();
    // Blocked on channel A only.
    await exec(o, o.owner, 'social.banned_word.add', { phrase: 'thần dược', level: 'block', connectionIds: [o.a] });
    const onA = await post(o, [o.a], { body: 'Trà xanh MÃ1 mỗi ngày' });
    const onB = await post(o, [o.b], { body: 'Trà xanh MÃ1 mỗi ngày' });
    // Already holds the word: the change does not add it, so it goes on.
    const already = await post(o, [o.a], { body: 'Thần dược MÃ1' });
    const input = { postIds: [onA, onB, already], find: 'mã1', replace: 'thần dược', caseSensitive: false };
    const seen = await preview(o, o.member, input);
    expect(seen.posts.find((p) => p.postId === onA)).toMatchObject({ skip: 'banned_words', matches: [{ field: 'body', count: 1, match: 'MÃ1' }] });
    const result = await replace(o, o.member, input);
    expect(result).toEqual(expected(seen));
    expect(sorted(result.done)).toEqual(sorted([onB, already]));
    expect(result.skipped).toEqual([{ postId: onA, reason: 'banned_words' }]);
    expect((await get(o, onA)).body).toBe('Trà xanh MÃ1 mỗi ngày');
    expect((await get(o, onB)).body).toBe('Trà xanh thần dược mỗi ngày');
    expect((await get(o, already)).body).toBe('Thần dược thần dược');
    // Nothing of the skipped post was saved: no edit, no version.
    expect((await audits(o, 'social.post.update')).map((r) => r.target_id)).not.toContain(onA);
    expect(await versions(o, onA)).toEqual([]);
  });

  it('keeps a member limited to some channels off the others, saying nothing of a post they cannot see', async () => {
    const o = await org();
    await exec(o, o.owner, 'social.channel_access.set', { userId: o.member, channelConnectionIds: [o.a] });
    const mine = await post(o, [o.a], { body: 'Mã XUAN2026 trên A' });
    // B inherits the shared text: changing it would change B.
    const both = await post(o, [o.a, o.b], { body: 'Mã XUAN2026 cho cả hai' });
    // B has its own text: the shared one reaches A only.
    const ownB = await post(o, [o.a, o.b], { body: 'Mã XUAN2026 chung' });
    await own(o, ownB, o.b, { body: 'Kênh B riêng, mã XUAN2026' });
    // Only B's own text matches: B is not the member's, so it is not even looked at.
    const onlyB = await post(o, [o.a, o.b], { body: 'Chung, không có mã' });
    await own(o, onlyB, o.b, { body: 'Kênh B có XUAN2026' });
    // On B only, and published: the member hears not_allowed, not that it is published.
    const hidden = await post(o, [o.b], { body: 'Chỉ B, XUAN2026' });
    await publish(o, hidden);
    const input = { postIds: [mine, both, ownB, onlyB, hidden], find: 'XUAN2026', replace: 'HE2026', wholeWord: true };

    const seen = await preview(o, o.member, input);
    const of = (postId: string) => seen.posts.find((p) => p.postId === postId);
    expect(of(mine)?.skip).toBeNull();
    expect(of(both)).toMatchObject({ skip: 'not_allowed', matches: [{ variantId: null, field: 'body' }] });
    expect(of(ownB)?.skip).toBeNull();
    expect(of(ownB)?.matches).toEqual([expect.objectContaining({ variantId: null, field: 'body' })]);
    expect(of(onlyB)).toEqual({ postId: onlyB, skip: 'no_match', matches: [] });
    expect(of(hidden)).toEqual({ postId: hidden, skip: 'not_allowed', matches: [] });

    const result = await replace(o, o.member, input);
    expect(result).toEqual(expected(seen));
    expect((await get(o, mine)).body).toBe('Mã HE2026 trên A');
    expect((await get(o, both)).body).toBe('Mã XUAN2026 cho cả hai');
    expect((await get(o, ownB)).body).toBe('Mã HE2026 chung');
    expect((await variantOn(o, ownB, o.b)).overrides.body).toBe('Kênh B riêng, mã XUAN2026');
    expect((await variantOn(o, onlyB, o.b)).overrides.body).toBe('Kênh B có XUAN2026');

    // The owner is never limited: the same replace changes B too.
    const full = await replace(o, o.owner, { ...input, postIds: [both, ownB, onlyB] });
    expect(sorted(full.done)).toEqual(sorted([both, ownB, onlyB]));
    expect((await variantOn(o, ownB, o.b)).overrides.body).toBe('Kênh B riêng, mã HE2026');
  });

  it('leaves out what an edit would refuse or a channel would no longer take', async () => {
    const o = await org();
    const long = await post(o, [o.a], { body: 'Tiêu đề dài', title: `${'x'.repeat(490)} AB` });
    const link = await post(o, [o.a], { body: 'Có liên kết', linkUrl: 'https://shop.example/AB' });
    const going = await post(o, [o.a], { body: 'Đang đăng AB' });
    await admin((c) => c.query("UPDATE crove_social.post_variant SET status = 'publishing' WHERE org_id = $1 AND post_id = $2", [o.orgId, going]));
    // The sandbox channel takes 1000 characters of text.
    const fits = await post(o, [o.a], { body: `${'y'.repeat(990)} AB` });
    const same = await post(o, [o.a], { body: 'Đã là AB' });
    const fine = await post(o, [o.a], { body: 'Bình thường AB' });
    const seen = await preview(o, o.member, { postIds: [long, going, fits, fine], find: 'AB', replace: 'C'.repeat(20) });
    const reasons = Object.fromEntries(seen.posts.map((p) => [p.postId, p.skip]));
    expect(reasons).toEqual({ [long]: 'over_limit', [going]: 'in_flight', [fits]: 'over_limit', [fine]: null });
    expect(await replace(o, o.member, { postIds: [long, going, fits, fine], find: 'AB', replace: 'C'.repeat(20) })).toEqual(expected(seen));
    expect((await get(o, fine)).body).toBe(`Bình thường ${'C'.repeat(20)}`);
    expect((await get(o, going)).body).toBe('Đang đăng AB');

    // A link that would no longer be one; a replacement the same as what was there.
    const linkSeen = await preview(o, o.member, { postIds: [link, same], find: 'https://shop.example/AB', replace: 'shop AB', caseSensitive: true });
    expect(Object.fromEntries(linkSeen.posts.map((p) => [p.postId, p.skip]))).toEqual({ [link]: 'invalid_link', [same]: 'no_match' });
    expect((await preview(o, o.member, { postIds: [same], find: 'ab', replace: 'AB' })).posts[0]?.skip).toBe('unchanged');
    expect((await replace(o, o.member, { postIds: [same], find: 'ab', replace: 'AB' })).skipped).toEqual([{ postId: same, reason: 'unchanged' }]);

    // The pattern is literal: a dot is a dot, and the replacement goes in as typed.
    const dots = await post(o, [o.a], { body: 'a.b axb (x)' });
    await replace(o, o.member, { postIds: [dots], find: 'a.b', replace: '$&' });
    await replace(o, o.member, { postIds: [dots], find: '(x)', replace: '[y]' });
    expect((await get(o, dots)).body).toBe('$& axb [y]');
  });

  it('refuses viewers and input past its bounds, changing nothing', async () => {
    const o = await org();
    const a = await post(o, [o.a], { body: 'Bài AB' });
    await expect(replace(o, o.viewer, { postIds: [a], find: 'AB', replace: 'CD' })).rejects.toMatchObject({ status: 403 });
    await expect(preview(o, o.viewer, { postIds: [a], find: 'AB', replace: 'CD' })).rejects.toMatchObject({ status: 403 });
    const many = Array.from({ length: 51 }, () => randomUUID());
    for (const input of [
      { postIds: many, find: 'AB', replace: 'CD' },
      { postIds: [a, a], find: 'AB', replace: 'CD' },
      { postIds: [a], find: '', replace: 'CD' },
      { postIds: [a], find: 'A'.repeat(201), replace: 'CD' },
      { postIds: [a], find: 'AB', replace: 'C'.repeat(2001) },
      { postIds: [a], find: '\uD800', replace: 'CD' },
    ]) {
      await expect(replace(o, o.member, input)).rejects.toMatchObject({ code: 'VALIDATION' });
    }
    expect((await get(o, a)).body).toBe('Bài AB');
    expect(await audits(o, 'social.post.update')).toEqual([]);
  });
});
