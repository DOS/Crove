// Suggested edits on PostgreSQL 17 (issue #1236): a reviewer selects words of a post's text or of a channel's own text
// and suggests others; the author accepts through the ordinary edit (a new revision, content hash and version, the
// channel back in review) or skips it. Outdated suggestions are refused, never applied; channel limits (#1081) hold for
// suggesting and accepting; viewers do neither; a channel that went out takes no suggestion. The table's CHECKs, the
// one column crove_tenant may update, and the comment's events. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run
// makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { socialCommands, socialQueries, textHash, type ActivityItem, type PostView } from '@crove/mod-social';
import { mentionToken } from '@crove/mod-social/contract';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('suggested edits on PostgreSQL (#1236)', () => {
  const dbName = `crove_test_social_suggestions_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  type Org = { orgId: string; owner: string; admin: string; member: string; viewer: string };
  type Decided = { commentId: string; postId: string; state: string; changedVariants: string[]; resubmitted: string[] };

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
    return upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@suggest.test`, name: null });
  }

  async function org(): Promise<Org> {
    const owner = await person('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    const roles = { admin: await person('admin'), member: await person('member'), viewer: await person('viewer') };
    for (const [role, id] of Object.entries(roles)) {
      await admin((c) => c.query('INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, $3)', [orgId, id, role]));
    }
    return { orgId, owner, ...roles };
  }

  async function connection(o: Org) {
    const id = randomUUID();
    await admin((c) =>
      c.query('INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, $3, $4, $5, $6)', [
        o.orgId,
        id,
        'sandbox',
        `acct-${id.slice(0, 8)}`,
        'Kênh thử',
        o.owner,
      ]),
    );
    return id;
  }

  const exec = <O>(o: Org, user: string, name: string, input: unknown) => rt.execute<O>(name, input, { actor: asUser(user), orgId: o.orgId });
  const get = (o: Org, postId: string, user = o.member) => rt.query<PostView>('social.post.get', { postId }, { actor: asUser(user), orgId: o.orgId });
  const activity = async (o: Org, user: string, postId: string) =>
    (await rt.query<{ items: ActivityItem[]; more: boolean }>('social.post.activity', { postId }, { actor: asUser(user), orgId: o.orgId })).items;
  const refusal = (p: Promise<unknown>) => p.then(() => 'resolved', (e: unknown) => (e as { code?: string }).code ?? String(e));
  const range = (text: string, quote: string) => {
    const start = text.indexOf(quote);
    if (start === -1) throw new Error(`no ${quote} in ${text}`);
    return { start, end: start + quote.length, quote };
  };
  const suggest = (o: Org, user: string, postId: string, field: 'post' | 'channel', text: string, quote: string, replacement: string, extra: Record<string, unknown> = {}) =>
    exec<{ commentId: string }>(o, user, 'social.post_comment.suggest', { postId, suggestion: { field, ...range(text, quote), text: replacement }, ...extra });
  const accept = (o: Org, user: string, commentId: string, revision: number) => exec<Decided>(o, user, 'social.post_comment.accept', { commentId, revision });
  const skip = (o: Org, user: string, commentId: string) => exec<Decided>(o, user, 'social.post_comment.skip', { commentId });
  const suggestionOf = async (o: Org, postId: string, commentId: string, user = o.member) => (await activity(o, user, postId)).find((i) => i.id === commentId)?.suggestion;
  const versions = (postId: string) => admin(async (c) => Number((await c.query<{ n: string }>('SELECT count(*) AS n FROM crove_social.post_version WHERE post_id = $1', [postId])).rows[0]?.n));

  // A post the member wrote on these channels, sent for review.
  async function inReview(o: Org, channels: Array<{ connectionId: string; body?: string }>, body: string) {
    const { postId } = await exec<{ postId: string }>(o, o.member, 'social.post.create', { body, channels });
    await exec(o, o.member, 'social.post.submit', { postId });
    return postId;
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

  it('a reviewer suggests, the author accepts: the text changes with a new version and the post is reviewed again', async () => {
    const o = await org();
    const conn = await connection(o);
    const body = 'Khai trương cửa hàng mới, giảm 20% cả tuần.';
    const postId = await inReview(o, [{ connectionId: conn }], body);
    const before = await get(o, postId);
    const v = before.variants[0] as PostView['variants'][number];
    expect(v.status).toBe('in_review');
    // A first approval round that the edit must end: the channel needs two approvals, the admin gives one.
    await exec(o, o.owner, 'social.channel.set_policy', { connectionId: conn, approvalsRequired: 2 });
    await exec(o, o.admin, 'social.variant.decide', { postId, decision: 'approved', variants: [{ variantId: v.id, revision: v.revision, contentHash: v.contentHash }] });
    expect((await get(o, postId)).variants[0]?.review.approvedBy).toEqual([o.admin]);
    const versionsBefore = await versions(postId);

    const { commentId } = await suggest(o, o.owner, postId, 'post', body, 'giảm 20%', 'giảm 25%', { body: `Đúng mức giảm ${mentionToken(o.admin)} nhé` });
    const open = await suggestionOf(o, postId, commentId);
    expect(open).toEqual({ field: 'post', quote: 'giảm 20%', text: 'giảm 25%', state: 'open', outdated: false, frozen: false, before: 'Khai trương cửa hàng mới, ', after: ' cả tuần.', revision: before.revision, decidable: true });
    // Viewers read it and cannot act on it.
    expect((await suggestionOf(o, postId, commentId, o.viewer))?.decidable).toBe(false);
    // Stored with the hash of the text it was made against; an open comment counts on the post.
    const row = await admin(async (c) => (await c.query('SELECT suggest_hash, suggest_state, resolved_at FROM crove_social.post_comment WHERE id = $1', [commentId])).rows[0]);
    expect(row).toEqual({ suggest_hash: textHash(body), suggest_state: 'open', resolved_at: null });
    expect((await get(o, postId)).openComments).toBe(1);
    // Told as a comment is, the mention as a mention.
    const events = await admin(async (c) => (await c.query<{ type: string; payload: Record<string, unknown> }>("SELECT type, payload FROM crove_kernel.outbox_event WHERE org_id = $1 AND payload ->> 'comment_id' = $2 ORDER BY created_at, type", [o.orgId, commentId])).rows);
    expect(events).toEqual([
      { type: 'social.post.commented', payload: { post_id: postId, comment_id: commentId, mentioned: [o.admin] } },
      { type: 'social.post.mentioned', payload: { post_id: postId, comment_id: commentId, user_ids: [o.admin] } },
    ]);

    const decided = await accept(o, o.member, commentId, before.revision);
    expect(decided).toEqual({ commentId, postId, state: 'accepted', changedVariants: [v.id], resubmitted: [v.id] });
    const after = await get(o, postId);
    const va = after.variants[0] as PostView['variants'][number];
    expect(after.body).toBe('Khai trương cửa hàng mới, giảm 25% cả tuần.');
    expect(after.revision).toBe(before.revision + 1);
    expect(va.revision).toBe(v.revision + 1);
    expect(va.contentHash).not.toBe(v.contentHash);
    // Back in review, in a new round: the earlier approval no longer counts.
    expect(va.status).toBe('in_review');
    expect(va.review.approvedBy).toEqual([]);
    expect(await versions(postId)).toBeGreaterThan(versionsBefore);
    expect(after.openComments).toBe(0);
    const closed = await suggestionOf(o, postId, commentId);
    expect(closed).toMatchObject({ state: 'accepted', outdated: false, revision: null, decidable: false });
    const items = await activity(o, o.member, postId);
    expect(items.find((i) => i.id === commentId)).toMatchObject({ resolvedBy: o.member, resolvable: false });
    // The timeline shows the edit and the new submission, by the author.
    expect(items.filter((i) => i.kind === 'edited' && i.userId === o.member)).toHaveLength(1);
    expect(items.filter((i) => i.kind === 'submitted' && i.userId === o.member).length).toBeGreaterThanOrEqual(2);
    // Audited: the accept and the nested edit and submit.
    const audit = await admin(async (c) => (await c.query<{ command: string; outcome: string }>("SELECT command, outcome FROM crove_kernel.audit_event WHERE org_id = $1 AND command IN ('social.post_comment.suggest', 'social.post_comment.accept', 'social.post.update', 'social.post.submit') AND occurred_at >= $2 ORDER BY occurred_at, command", [o.orgId, new Date(Date.now() - 600_000)])).rows);
    expect(audit.filter((a) => a.command === 'social.post_comment.accept')).toEqual([{ command: 'social.post_comment.accept', outcome: 'ok' }]);
    expect(audit.filter((a) => a.command === 'social.post.update')).toEqual([{ command: 'social.post.update', outcome: 'ok' }]);

    // Accepted once only.
    expect(await refusal(accept(o, o.member, commentId, after.revision))).toBe('SUGGESTION_CLOSED');
    expect(await refusal(skip(o, o.member, commentId))).toBe('SUGGESTION_CLOSED');
    // A suggestion is not resolved or reopened by hand.
    expect(await refusal(exec(o, o.owner, 'social.post_comment.reopen', { commentId }))).toBe('SUGGESTION_NOT_RESOLVABLE');
  });

  it("accepts a suggestion on a channel's own text through the channel's edit, and leaves a draft a draft", async () => {
    const o = await org();
    const [a, b] = [await connection(o), await connection(o)];
    const own = 'Bài riêng cho kênh A: ghé thăm ngay hôm nay!';
    const { postId } = await exec<{ postId: string }>(o, o.member, 'social.post.create', { body: 'Bài chung', channels: [{ connectionId: a, body: own }, { connectionId: b }] });
    const post = await get(o, postId);
    const va = post.variants.find((v) => v.connectionId === a) as PostView['variants'][number];
    const vb = post.variants.find((v) => v.connectionId === b) as PostView['variants'][number];
    // The channel's own text needs the channel, and one with its own text.
    expect(await refusal(suggest(o, o.owner, postId, 'channel', own, 'hôm nay', 'cuối tuần'))).toBe('SUGGESTION_NEEDS_CHANNEL');
    expect(await refusal(suggest(o, o.owner, postId, 'channel', 'Bài chung', 'chung', 'mới', { variantId: vb.id }))).toBe('SUGGESTION_NO_OWN_TEXT');
    const { commentId } = await suggest(o, o.owner, postId, 'channel', own, 'hôm nay', 'cuối tuần', { variantId: va.id });
    expect(await suggestionOf(o, postId, commentId)).toMatchObject({ field: 'channel', revision: va.revision, outdated: false });
    // The channel's revision, not the post's.
    expect(await refusal(accept(o, o.member, commentId, va.revision + 1))).toBe('STALE_REVISION');
    const decided = await accept(o, o.member, commentId, va.revision);
    // A draft stays a draft: nothing is sent to review that was not there.
    expect(decided).toMatchObject({ state: 'accepted', changedVariants: [va.id], resubmitted: [] });
    const after = await get(o, postId);
    expect(after.variants.find((v) => v.id === va.id)).toMatchObject({ overrides: { body: 'Bài riêng cho kênh A: ghé thăm ngay cuối tuần!' }, revision: va.revision + 1, status: 'draft' });
    expect(after.variants.find((v) => v.id === vb.id)).toMatchObject({ revision: vb.revision, contentHash: vb.contentHash });
    expect(after.body).toBe('Bài chung');
  });

  it('applies a suggestion whose words moved, and refuses one whose words are gone or were never there', async () => {
    const o = await org();
    const conn = await connection(o);
    const body = 'Giờ mở cửa: 8h đến 22h mỗi ngày.';
    const postId = await inReview(o, [{ connectionId: conn }], body);
    const p0 = await get(o, postId);
    // The page was not up to date: the words are not where the member says.
    expect(await refusal(exec(o, o.owner, 'social.post_comment.suggest', { postId, suggestion: { field: 'post', start: 0, end: 3, quote: 'Mở ', text: 'x' } }))).toBe('SUGGESTION_STALE');
    // A range that does not hold its quote, or that changes nothing.
    expect(await refusal(exec(o, o.owner, 'social.post_comment.suggest', { postId, suggestion: { field: 'post', start: 0, end: 4, quote: 'Giờ', text: 'x' } }))).toBe('VALIDATION');
    expect(await refusal(exec(o, o.owner, 'social.post_comment.suggest', { postId, suggestion: { field: 'post', ...range(body, '8h'), text: '8h' } }))).toBe('VALIDATION');
    const moved = await suggest(o, o.owner, postId, 'post', body, '22h', '23h');
    const gone = await suggest(o, o.owner, postId, 'post', body, 'mỗi ngày', 'trừ Chủ nhật');
    const skipped = await suggest(o, o.owner, postId, 'post', body, '8h', '7h');

    // An edit elsewhere adds words before them and rewrites the end.
    const edited = 'Thông báo! Giờ mở cửa: 8h đến 22h.';
    await exec(o, o.member, 'social.post.update', { postId, revision: p0.revision, body: edited });
    const p1 = await get(o, postId);
    expect(await suggestionOf(o, postId, moved.commentId)).toMatchObject({ outdated: false, before: 'Thông báo! Giờ mở cửa: 8h đến ', after: '.' });
    expect(await suggestionOf(o, postId, gone.commentId)).toMatchObject({ outdated: true, before: '', after: '' });
    // The revision the member saw, else nothing is applied.
    expect(await refusal(accept(o, o.member, moved.commentId, p0.revision))).toBe('STALE_REVISION');
    expect(await refusal(accept(o, o.member, gone.commentId, p1.revision))).toBe('SUGGESTION_OUTDATED');
    expect((await get(o, postId)).body).toBe(edited);
    await accept(o, o.member, moved.commentId, p1.revision);
    expect((await get(o, postId)).body).toBe('Thông báo! Giờ mở cửa: 8h đến 23h.');
    // Skipping: an outdated one closes as outdated, another as skipped; neither changes the text.
    expect((await skip(o, o.member, gone.commentId)).state).toBe('outdated');
    expect((await skip(o, o.admin, skipped.commentId)).state).toBe('skipped');
    expect((await get(o, postId)).body).toBe('Thông báo! Giờ mở cửa: 8h đến 23h.');
    expect(await suggestionOf(o, postId, gone.commentId)).toMatchObject({ state: 'outdated', decidable: false });
    // A word now in two places no longer says which one.
    const twice = await get(o, postId);
    const again = await suggest(o, o.owner, postId, 'post', twice.body, 'Thông báo', 'Tin vui');
    await exec(o, o.member, 'social.post.update', { postId, revision: twice.revision, body: `Tin mới: ${twice.body} Thông báo hết.` });
    expect(await suggestionOf(o, postId, again.commentId)).toMatchObject({ outdated: true });
  });

  it('keeps viewers out and channel limits (#1081) for suggesting and accepting', async () => {
    const o = await org();
    const [a, b] = [await connection(o), await connection(o)];
    const own = 'Riêng kênh B';
    const body = 'Nội dung chung cho hai kênh';
    const postId = await inReview(o, [{ connectionId: a }, { connectionId: b, body: own }], body);
    const post = await get(o, postId, o.owner);
    const vb = post.variants.find((v) => v.connectionId === b) as PostView['variants'][number];
    // A second post whose two channels both take the shared text.
    const shared = 'Một nội dung cho cả hai';
    const both = await inReview(o, [{ connectionId: a }, { connectionId: b }], shared);
    // Viewers comment on nothing, so they suggest nothing; nor accept or skip.
    expect(await refusal(suggest(o, o.viewer, postId, 'post', body, 'chung', 'riêng'))).toBe('FORBIDDEN');
    const onBase = await suggest(o, o.owner, postId, 'post', body, 'hai kênh', 'mọi kênh');
    const onB = await suggest(o, o.owner, postId, 'channel', own, 'Riêng', 'Chỉ', { variantId: vb.id });
    expect(await refusal(accept(o, o.viewer, onBase.commentId, post.revision))).toBe('FORBIDDEN');
    expect(await refusal(skip(o, o.viewer, onBase.commentId))).toBe('FORBIDDEN');

    // A member limited to channel A: the suggestion on channel B's own text is out of their reach; the shared text,
    // which only channel A takes on this post, is theirs to change.
    await exec(o, o.owner, 'social.channel_access.set', { userId: o.member, channelConnectionIds: [a] });
    const notAllowed = 'CHANNEL_NOT_ALLOWED';
    expect(await refusal(suggest(o, o.member, postId, 'channel', own, 'Riêng', 'Chỉ', { variantId: vb.id }))).toBe(notAllowed);
    expect(await refusal(accept(o, o.member, onB.commentId, vb.revision))).toBe(notAllowed);
    expect(await refusal(skip(o, o.member, onB.commentId))).toBe(notAllowed);
    expect((await activity(o, o.member, postId)).some((i) => i.id === onB.commentId)).toBe(false);
    expect((await accept(o, o.member, onBase.commentId, post.revision)).changedVariants).toHaveLength(1);

    // Where channel B takes the shared text too, the limited member cannot change it through a suggestion.
    const sb = await suggest(o, o.owner, both, 'post', shared, 'cả hai', 'tất cả');
    expect(await refusal(accept(o, o.member, sb.commentId, (await get(o, both, o.owner)).revision))).toBe(notAllowed);
    expect((await get(o, both, o.owner)).body).toBe(shared);
    expect(await suggestionOf(o, both, sb.commentId, o.owner)).toMatchObject({ state: 'open' });
    // An admin accepts it.
    await accept(o, o.admin, sb.commentId, (await get(o, both, o.owner)).revision);
    expect((await get(o, both, o.owner)).body).toBe('Một nội dung cho tất cả');
  });

  it('takes no suggestion on a channel that went out, nor applies one there', async () => {
    const o = await org();
    const [a, b] = [await connection(o), await connection(o)];
    const own = 'Kênh A đã đăng bài này';
    const body = 'Bài chung đã đăng';
    const postId = await inReview(o, [{ connectionId: a, body: own }, { connectionId: b }], body);
    const post = await get(o, postId, o.owner);
    const va = post.variants.find((v) => v.connectionId === a) as PostView['variants'][number];
    const early = await suggest(o, o.owner, postId, 'channel', own, 'đã đăng', 'sắp đăng', { variantId: va.id });
    const onBase = await suggest(o, o.owner, postId, 'post', body, 'đã đăng', 'mới');
    // Channel A went out (as the publisher leaves it), then channel B too.
    await admin((c) => c.query("UPDATE crove_social.post_variant SET status = 'published', content_frozen = true, published_at = now() WHERE id = $1", [va.id]));
    expect(await refusal(suggest(o, o.owner, postId, 'channel', own, 'Kênh A', 'Trang A', { variantId: va.id }))).toBe('SUGGESTION_FROZEN');
    expect(await suggestionOf(o, postId, early.commentId, o.owner)).toMatchObject({ frozen: true });
    expect(await refusal(accept(o, o.member, early.commentId, va.revision))).toBe('SUGGESTION_FROZEN');
    await admin((c) => c.query("UPDATE crove_social.post_variant SET status = 'published', content_frozen = true, published_at = now() WHERE post_id = $1", [postId]));
    expect(await refusal(suggest(o, o.owner, postId, 'post', body, 'Bài', 'Tin'))).toBe('SUGGESTION_FROZEN');
    expect(await refusal(accept(o, o.member, onBase.commentId, post.revision))).toBe('SUGGESTION_FROZEN');
    // Skipping still closes them.
    expect((await skip(o, o.member, early.commentId)).state).toBe('skipped');
  });

  it('keeps the CHECKs in the table and lets crove_tenant update only the state', async () => {
    const o = await org();
    const conn = await connection(o);
    const { postId } = await exec<{ postId: string }>(o, o.member, 'social.post.create', { body: 'Bài', channels: [{ connectionId: conn }] });
    const hash = textHash('Bài');
    const full = { suggest_field: 'post', suggest_start: 0, suggest_end: 3, suggest_quote: 'Bài', suggest_text: 'Tin', suggest_hash: hash, suggest_state: 'open' };
    const insert = (cols: Record<string, unknown>, body = '') =>
      admin((c) => {
        const names = ['org_id', 'post_id', 'author_user_id', 'body', ...Object.keys(cols)];
        const values = [o.orgId, postId, o.member, body, ...Object.values(cols)];
        return c.query(`INSERT INTO crove_social.post_comment (${names.join(', ')}) VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')})`, values).then(
          () => 'ok',
          (e: { constraint?: string; code?: string }) => e.constraint ?? e.code ?? 'error',
        );
      });
    expect(await insert(full)).toBe('ok');
    // A comment that is no suggestion keeps 1 to 4000 characters; a suggestion's note may be empty.
    expect(await insert({})).toBe('post_comment_note_check');
    expect(await insert({}, 'x'.repeat(4001))).toBe('post_comment_note_check');
    expect(await insert(full, 'x'.repeat(4001))).toBe('post_comment_note_check');
    expect(await insert({}, 'Ghi chú')).toBe('ok');
    // All seven or none, a range that holds something, a real change, the hash's form.
    expect(await insert({ ...full, suggest_hash: null })).toBe('post_comment_suggest_check');
    expect(await insert({ suggest_field: 'post' }, 'x')).toBe('post_comment_suggest_check');
    expect(await insert({ ...full, suggest_end: 0 })).toBe('post_comment_suggest_check');
    expect(await insert({ ...full, suggest_start: -1 })).toBe('post_comment_suggest_check');
    expect(await insert({ ...full, suggest_end: 100_001 })).toBe('post_comment_suggest_check');
    expect(await insert({ ...full, suggest_text: 'Bài' })).toBe('post_comment_suggest_check');
    expect(await insert({ ...full, suggest_quote: '' })).toBe('post_comment_suggest_check');
    expect(await insert({ ...full, suggest_text: 'x'.repeat(4001) })).toBe('post_comment_suggest_check');
    expect(await insert({ ...full, suggest_hash: 'md5:abc' })).toBe('post_comment_suggest_check');
    expect(await insert({ ...full, suggest_field: 'title' })).toBe('post_comment_suggest_field_check');
    expect(await insert({ ...full, suggest_state: 'maybe', resolved_at: new Date(), resolved_by: o.owner })).toBe('post_comment_suggest_state_check');
    // Closed exactly when resolved.
    expect(await insert({ ...full, suggest_state: 'accepted' })).toBe('post_comment_suggest_resolved_check');
    expect(await insert({ ...full, resolved_at: new Date(), resolved_by: o.owner })).toBe('post_comment_suggest_resolved_check');
    expect(await insert({ ...full, suggest_state: 'skipped', resolved_at: new Date(), resolved_by: o.owner })).toBe('ok');

    // crove_tenant inserts a suggestion and changes only its state.
    for (const column of ['suggest_field', 'suggest_start', 'suggest_end', 'suggest_quote', 'suggest_text', 'suggest_hash']) {
      await expect(
        admin(async (c) => {
          await c.query('BEGIN');
          try {
            await c.query('SET LOCAL ROLE crove_tenant');
            await c.query(`UPDATE crove_social.post_comment SET ${column} = NULL WHERE false`);
          } finally {
            await c.query('ROLLBACK');
          }
        }),
      ).rejects.toMatchObject({ code: '42501' });
    }
    const grants = await admin((c) =>
      c.query<{ column_name: string }>(
        "SELECT column_name FROM information_schema.column_privileges WHERE table_schema = 'crove_social' AND table_name = 'post_comment' AND grantee = 'crove_tenant' AND privilege_type = 'UPDATE' ORDER BY column_name",
      ),
    );
    expect(grants.rows.map((r) => r.column_name)).toEqual(['body', 'edited_at', 'resolved_at', 'resolved_by', 'suggest_state']);
  });
});
