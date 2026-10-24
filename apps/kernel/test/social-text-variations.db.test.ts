// Crove Social text variations on PostgreSQL 17 (issue #1260): an evergreen post's reposts and a series' copies take
// the post's text variations in turn, wrapping around, with the cursor moved in the copy's transaction; a copy on X
// passes over a variation the account sent in the last 30 days while another is left, and the duplicate check, the
// banned words and the approval see the variation sent. Only members of the org who write posts set them, on an
// evergreen or series post, and the table refuses any other shape. Folded in from #1001: a sweep is no longer filled by
// posts and series that only wait, a series whose original was taken down ends with that reason, and the first copy
// keeps its distance from the original's publish.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Publisher, PublishResult, ReconcileResult } from '@crove/channel';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { CredentialVault, Runtime, parseVaultKey } from '@crove/kernel-runtime';
import {
  RECURRING_FIRST_GAP_MS,
  localTime,
  nextOccurrence,
  runPublishJob,
  socialCommands,
  socialQueries,
  sweepEvergreen,
  sweepRecurring,
  type PostView,
  type Recurrence,
  type RecurringResult,
  type TextVariation,
} from '@crove/mod-social';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const HCM = 'Asia/Ho_Chi_Minh';
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];

// A platform that takes every post.
class Platform implements Publisher {
  readonly provider = 'sandbox' as const;
  readonly publishSafety = 'reconcile_only' as const;
  n = 0;
  async publish(): Promise<PublishResult> {
    this.n += 1;
    return { kind: 'accepted', externalId: `post-${this.n}`, url: null };
  }
  async status(): Promise<PublishResult> {
    return { kind: 'unknown' };
  }
  async reconcile(): Promise<ReconcileResult> {
    return { found: 'unknown' };
  }
}

suite('social text variations on PostgreSQL (#1260, #1001)', () => {
  const dbName = `crove_test_social_variations_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appPool: pg.Pool;
  let workerPool: pg.Pool;
  let appDb: Db;
  let workerDb: Db;
  let api: Runtime;
  let worker: Runtime;
  const vault = new CredentialVault([parseVaultKey(randomBytes(32).toString('base64'))]);
  const platform = new Platform();
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const SYSTEM = { type: 'system' as const, component: 'social-variations-test' };
  type Org = { orgId: string; owner: string; member: string; viewer: string };

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  const person = (name: string) => upsertIdentity(appDb, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@variations.test`, name: null });
  async function org(): Promise<Org> {
    const owner = await person('owner');
    const { orgId } = await createOrg(api, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    const people = { member: await person('member'), viewer: await person('viewer') };
    for (const [role, id] of Object.entries(people)) {
      await admin((c) => c.query('INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, $3)', [orgId, id, role]));
    }
    return { orgId, owner, ...people };
  }

  const exec = <O>(o: Org, name: string, input: unknown, user = o.owner) => api.execute<O>(name, input, { actor: asUser(user), orgId: o.orgId });
  const get = (o: Org, postId: string) => api.query<PostView>('social.post.get', { postId }, { actor: asUser(o.owner), orgId: o.orgId });
  const setVariations = (o: Org, postId: string, texts: (string | TextVariation)[], user = o.owner) =>
    exec<{ postId: string; variations: TextVariation[]; next: number }>(o, 'social.post.set_text_variations', { postId, variations: texts.map((t) => (typeof t === 'string' ? { text: t, ai: false } : t)) }, user);
  const setRule = (o: Org, postId: string, recurrence: Partial<Recurrence>) =>
    exec(o, 'social.post.recurrence_set', { postId, recurrence: { everyWeeks: 1, weekdays: EVERY_DAY, time: '09:00', until: null, times: null, ...recurrence } });
  const repostNow = (o: Org, postId: string) => worker.execute<{ postId: string | null }>('social.post.repost_evergreen', { postId }, { actor: SYSTEM, orgId: o.orgId });
  const nextCopy = (o: Org, postId: string) => worker.execute<RecurringResult>('social.recurring.next', { postId }, { actor: SYSTEM, orgId: o.orgId });
  const reposts = (sourceId: string) =>
    admin(async (c) => (await c.query<{ id: string; body: string; tainted: boolean }>('SELECT id, body, tainted FROM crove_social.post WHERE repost_of = $1 ORDER BY created_at, id', [sourceId])).rows);
  const copies = (seriesId: string) =>
    admin(async (c) => (await c.query<{ id: string; body: string; scheduled_at: Date | null }>('SELECT id, body, scheduled_at FROM crove_social.post WHERE recurrence_source_id = $1 ORDER BY created_at, id', [seriesId])).rows);
  const cancel = async (o: Org, postId: string) => exec(o, 'social.variant.cancel', { variantIds: (await get(o, postId)).variants.map((v) => v.id) });
  // The last repost made long enough ago for the next one to be due.
  const ageReposts = (sourceId: string) => admin((c) => c.query("UPDATE crove_social.post SET created_at = created_at - interval '8 days' WHERE repost_of = $1", [sourceId]));

  async function connect(o: Org) {
    const account = `acct-${randomUUID().slice(0, 8)}`;
    const sealed = vault.seal(JSON.stringify({ accessToken: 'sbx_test' }), { orgId: o.orgId, provider: 'sandbox', externalAccountId: account });
    const { connectionId } = await exec<{ connectionId: string }>(o, 'kernel.channel.connect', {
      provider: 'sandbox',
      externalAccountId: account,
      displayName: 'Trang thử',
      scopes: ['publish'],
      expiresAt: null,
      credential: { keyId: sealed.keyId, envelope: sealed.envelope.toString('base64') },
    });
    return connectionId;
  }

  // A post on one sandbox channel, approved, scheduled and published now.
  async function published(o: Org, body = `Khai trương ${randomUUID().slice(0, 6)}`) {
    const connectionId = await connect(o);
    const { postId } = await exec<{ postId: string }>(o, 'social.post.create', { body, timeZone: HCM, channels: [{ connectionId }] });
    await exec(o, 'social.post.submit', { postId });
    const post = await get(o, postId);
    await exec(o, 'social.variant.decide', { postId, decision: 'approved', variants: post.variants.map((v) => ({ variantId: v.id, revision: v.revision, contentHash: v.contentHash })) });
    await exec(o, 'social.variant.schedule', { postId, at: new Date(Date.now() + 3_600_000).toISOString() });
    await admin((c) => c.query("UPDATE crove_social.post_variant SET scheduled_at = now() - interval '1 second' WHERE post_id = $1", [postId]));
    for (const v of post.variants) await runPublishJob({ runtime: worker, broker: vault, publishers: { sandbox: platform }, callTimeoutMs: 2_000 }, o.orgId, v.id, 'sandbox');
    expect((await get(o, postId)).status).toBe('published');
    return { postId, connectionId, body };
  }

  // An evergreen post due for its repost now.
  async function evergreen(o: Org, body?: string) {
    const p = await published(o, body);
    await exec(o, 'social.post.set_evergreen', { postId: p.postId, days: 7 });
    await admin((c) => c.query("UPDATE crove_social.post_variant SET published_at = now() - interval '8 days' WHERE post_id = $1", [p.postId]));
    return p;
  }

  // An X channel of the org and a post on it marked as published there now, as the publisher leaves it (the duplicate
  // check reads the text a published channel went out with).
  async function xChannel(o: Org) {
    const id = randomUUID();
    await admin((c) =>
      c.query('INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, $3, $4, $5, $6)', [o.orgId, id, 'x', `acct-${id.slice(0, 8)}`, 'Kênh X', o.owner]),
    );
    return id;
  }
  const markPublished = (postId: string) =>
    admin(async (c) => {
      await c.query(
        `UPDATE crove_social.post_variant v SET status = 'published', published_at = now(), content_frozen = true, body = coalesce(v.body, p.body), external_post_id = 'x-' || v.id
           FROM crove_social.post p WHERE p.org_id = v.org_id AND p.id = v.post_id AND v.post_id = $1`,
        [postId],
      );
      await c.query("UPDATE crove_social.post SET status = 'published' WHERE id = $1", [postId]);
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
    const as = (user: string, password: string) => {
      const u = new URL(adminUrl);
      u.username = user;
      u.password = password;
      return u.toString();
    };
    appPool = createPool({ connectionString: as('crove_app', 'test-app-pw'), max: 4 });
    workerPool = createPool({ connectionString: as('crove_worker', 'test-worker-pw'), max: 4 });
    appDb = createDb(appPool);
    workerDb = createDb(workerPool);
    const registry = { commands: [...kernelCommands, ...socialCommands], queries: [...kernelQueries({ inboundDomain: null }), ...socialQueries] };
    api = new Runtime(appDb).register(registry);
    worker = new Runtime(workerDb).register(registry);
  });

  afterAll(async () => {
    await appPool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  // First in the file: the sweeps below see only what this test made.
  it('does not let posts and series that only wait fill a sweep and keep another org out (#1001)', async () => {
    const [a, b] = [await org(), await org()];
    // Three evergreen posts and three series of org A whose channels are only expired: each sweep finds them again.
    for (let i = 0; i < 3; i += 1) {
      const e = await evergreen(a);
      const s = await published(a);
      await setRule(a, s.postId, { time: '09:00' });
      await admin((c) => c.query("UPDATE crove_kernel.channel_connection SET status = 'expired' WHERE id = ANY($1::uuid[])", [[e.connectionId, s.connectionId]]));
    }
    const e = await evergreen(b);
    const s = await published(b);
    await setRule(b, s.postId, { time: '09:00' });
    // A page of one: org B's post and series come up in the same pass however the scan orders them.
    expect(await sweepEvergreen({ runtime: worker, workerDb, pageSize: 1 })).toBe(1);
    expect(await reposts(e.postId)).toHaveLength(1);
    expect(await sweepRecurring({ runtime: worker, workerDb, pageSize: 1 })).toBe(1);
    expect(await copies(s.postId)).toHaveLength(1);
    // The scans take the ids already tried and are the worker's alone.
    const can = await admin(async (c) =>
      (
        await c.query<{ fn: string; role: string }>(
          `SELECT f AS fn, r AS role FROM unnest(ARRAY['crove_social.evergreen_due(int, uuid[])', 'crove_social.recurring_due(int, uuid[])']) f,
             unnest(ARRAY['crove_app', 'crove_worker', 'crove_tenant', 'crove_definer_tenant']) r WHERE has_function_privilege(r, f, 'EXECUTE') ORDER BY 1, 2`,
        )
      ).rows,
    );
    expect(can.map((r) => r.role)).toEqual(['crove_worker', 'crove_worker']);
    await expect(appPool.query("SELECT * FROM crove_social.recurring_due(10, '{}')")).rejects.toMatchObject({ code: '42501' });
  });

  it('sends variations 1, 2 and 3 on three evergreen cycles, then 1 again', async () => {
    const o = await org();
    const { postId } = await evergreen(o);
    const texts = ['Biến thể một', 'Biến thể hai', 'Biến thể ba'];
    expect(await setVariations(o, postId, texts)).toEqual({ postId, variations: texts.map((text) => ({ text, ai: false })), next: 0 });
    const sent: string[] = [];
    for (let cycle = 0; cycle < 4; cycle += 1) {
      expect(await sweepEvergreen({ runtime: worker, workerDb })).toBeGreaterThanOrEqual(1);
      const last = (await reposts(postId)).at(-1);
      if (!last) throw new Error('no repost');
      const view = await get(o, last.id);
      // The variation is the copy's text on its channel, and the copy goes to review as before.
      expect(view.variants.map((v) => [v.status, v.effective.body])).toEqual([['in_review', last.body]]);
      sent.push(last.body);
      expect((await get(o, postId)).textVariationNext).toBe((cycle + 1) % 3);
      await cancel(o, last.id);
      await ageReposts(postId);
    }
    expect(sent).toEqual([...texts, texts[0]]);
  });

  it('rotates a recurring series through its variations, a day apart', async () => {
    const o = await org();
    const { postId } = await published(o);
    await setRule(o, postId, { time: '10:00' });
    await setVariations(o, postId, ['Thứ nhất', 'Thứ hai']);
    const made: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const done = await nextCopy(o, postId);
      if (!done.postId) throw new Error(`no copy: ${JSON.stringify(done)}`);
      const [copy] = (await copies(postId)).slice(-1);
      made.push(copy?.body ?? '');
      expect((await get(o, copy?.id as string)).variants.map((v) => v.status)).toEqual(['in_review']);
      await cancel(o, copy?.id as string);
    }
    expect(made).toEqual(['Thứ nhất', 'Thứ hai', 'Thứ nhất']);
    const list = await copies(postId);
    expect((list[1]?.scheduled_at?.getTime() ?? 0) - (list[0]?.scheduled_at?.getTime() ?? 0)).toBe(86_400_000);
  });

  it('refuses at approval a variation that holds a blocked word, and keeps one blocked already a draft', async () => {
    const o = await org();
    const { postId } = await evergreen(o);
    await setVariations(o, postId, ['Giảm giá sốc cuối tuần', 'Tuần này có món mới', { text: 'Bản AI: giảm giá sốc', ai: true }]);
    await repostNow(o, postId);
    const [first] = await reposts(postId);
    if (!first) throw new Error('no repost');
    const view = await get(o, first.id);
    expect(view.variants[0]?.status).toBe('in_review');
    // A word blocked since: the reviewer cannot approve the variation that holds it.
    await exec(o, 'social.banned_word.add', { phrase: 'giảm giá sốc', level: 'block' });
    await expect(
      exec(o, 'social.variant.decide', { postId: first.id, decision: 'approved', variants: view.variants.map((v) => ({ variantId: v.id, revision: v.revision, contentHash: v.contentHash })) }),
    ).rejects.toMatchObject({ code: 'BANNED_WORDS', status: 422 });
    await cancel(o, first.id);
    // The next copy takes the clean variation and goes to review; the one after holds the word, so it stays a draft,
    // a submit is refused, and the copy is tainted as AI wrote it.
    await ageReposts(postId);
    await repostNow(o, postId);
    const second = (await reposts(postId))[1];
    expect([second?.body, (await get(o, second?.id as string)).variants[0]?.status]).toEqual(['Tuần này có món mới', 'in_review']);
    await cancel(o, second?.id as string);
    await ageReposts(postId);
    await repostNow(o, postId);
    const third = (await reposts(postId))[2];
    expect([third?.body, third?.tainted, (await get(o, third?.id as string)).variants[0]?.status]).toEqual(['Bản AI: giảm giá sốc', true, 'draft']);
    await expect(exec(o, 'social.post.submit', { postId: third?.id })).rejects.toMatchObject({ code: 'BANNED_WORDS' });
    // The first two came from texts a person wrote: as tainted as their source, which was not.
    expect((await reposts(postId)).slice(0, 2).map((r) => r.tainted)).toEqual([false, false]);
  });

  it('passes over a variation X saw in the last 30 days while another is left, and the duplicate check sees the one sent', async () => {
    const o = await org();
    const x = await xChannel(o);
    const { postId } = await exec<{ postId: string }>(o, 'social.post.create', { body: 'Bài gốc trên X', channels: [{ connectionId: x }] });
    await markPublished(postId);
    await exec(o, 'social.post.set_evergreen', { postId, days: 7 });
    await setVariations(o, postId, ['Một cách nói', 'Cách nói khác']);
    // The first copy takes the first variation and goes out on X.
    const first = await repostNow(o, postId);
    expect((await get(o, first.postId as string)).body).toBe('Một cách nói');
    await markPublished(first.postId as string);
    // The second takes the second, and is cancelled.
    const second = await repostNow(o, postId);
    expect((await get(o, second.postId as string)).body).toBe('Cách nói khác');
    await cancel(o, second.postId as string);
    // The cursor is back on the first, which X saw today: the copy takes the second instead, and the cursor moves past it.
    expect((await get(o, postId)).textVariationNext).toBe(0);
    const third = await repostNow(o, postId);
    const view = await get(o, third.postId as string);
    expect(view.body).toBe('Cách nói khác');
    expect(view.variants[0]?.duplicateOf).toBeNull();
    expect((await get(o, postId)).textVariationNext).toBe(0);
    // Both went out now: none is left, so the one at the cursor is taken, and the post page warns of the repeat.
    await markPublished(third.postId as string);
    const fourth = await get(o, (await repostNow(o, postId)).postId as string);
    expect(fourth.body).toBe('Một cách nói');
    expect(fourth.variants[0]?.duplicateOf?.status).toBe('published');
  });

  it('ends a series whose original was taken down on every channel, with that reason (#1001)', async () => {
    const o = await org();
    const { postId } = await published(o);
    await setRule(o, postId, { time: '11:00' });
    await admin((c) => c.query("UPDATE crove_social.post_variant SET status = 'removed', removed_at = now() WHERE post_id = $1", [postId]));
    expect(await admin(async (c) => (await c.query<{ post_id: string }>("SELECT post_id FROM crove_social.recurring_due(500, '{}')")).rows.map((r) => r.post_id))).toContain(postId);
    expect(await nextCopy(o, postId)).toEqual({ postId: null, reason: 'taken_down' });
    expect((await get(o, postId)).recurrence).toBeNull();
    expect(await copies(postId)).toEqual([]);
    const audit = await admin(async (c) => (await c.query<{ detail: { reason?: string } }>("SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'social.recurring.next' AND outcome = 'ok'", [o.orgId])).rows);
    expect(audit.map((r) => r.detail.reason)).toContain('taken_down');
  });

  it('makes the first copy no sooner than the gap after the original went out (#1001)', async () => {
    const o = await org();
    const { postId } = await published(o);
    const firstAt = (await admin(async (c) => (await c.query<{ at: Date }>('SELECT min(published_at) AS at FROM crove_social.post_variant WHERE post_id = $1', [postId])).rows[0]?.at)) as Date;
    // Every day, two hours after the original went out: today's occurrence is too close, so the first copy is tomorrow's.
    const soon = localTime(firstAt.getTime() + 2 * 3_600_000, HCM);
    const time = `${String(soon.hour).padStart(2, '0')}:${String(soon.minute).padStart(2, '0')}`;
    await setRule(o, postId, { time });
    const done = await nextCopy(o, postId);
    if (!done.postId) throw new Error(`no copy: ${JSON.stringify(done)}`);
    const rule: Recurrence = { everyWeeks: 1, weekdays: EVERY_DAY, time, until: null, times: null };
    expect(done.at).toBe(new Date(nextOccurrence(rule, HCM, firstAt.getTime(), firstAt.getTime() + RECURRING_FIRST_GAP_MS) as number).toISOString());
    expect(Date.parse(done.at) - firstAt.getTime()).toBeGreaterThan(RECURRING_FIRST_GAP_MS);
    expect(Date.parse(done.at) - firstAt.getTime()).toBeLessThan(27 * 3_600_000);
  });

  it('is set only by members who write posts, on an evergreen or series post, and the table holds the shape', async () => {
    const o = await org();
    const outsider = await org();
    const { postId } = await published(o);
    // Not repeating yet: refused, though clearing is allowed.
    await expect(setVariations(o, postId, ['A'])).rejects.toMatchObject({ code: 'VARIATIONS_NOT_REPEATING', status: 409 });
    expect(await setVariations(o, postId, [])).toMatchObject({ variations: [], next: 0 });
    await exec(o, 'social.post.set_evergreen', { postId, days: 30 });
    expect(await setVariations(o, postId, ['A', 'B'], o.member)).toMatchObject({ next: 0 });
    await expect(setVariations(o, postId, ['C'], o.viewer)).rejects.toMatchObject({ status: 403 });
    await expect(setVariations(o, postId, ['C'], outsider.owner)).rejects.toMatchObject({ status: 403 });
    await expect(setVariations(outsider, postId, ['C'])).rejects.toMatchObject({ code: 'POST_NOT_FOUND' });
    await expect(setVariations(o, postId, ['A', ' A '])).rejects.toBeDefined();
    await expect(setVariations(o, postId, ['1', '2', '3', '4', '5', '6'])).rejects.toBeDefined();
    // The cursor follows its text when the list is reordered, and an AI mark is never dropped from a kept text.
    await admin((c) => c.query('UPDATE crove_social.post SET text_variation_next = 1 WHERE id = $1', [postId]));
    await setVariations(o, postId, [{ text: 'B', ai: true }, 'A']);
    expect(await setVariations(o, postId, ['C', 'B', 'A'])).toEqual({ postId, variations: [{ text: 'C', ai: false }, { text: 'B', ai: true }, { text: 'A', ai: false }], next: 1 });
    expect((await get(o, postId)).textVariations).toEqual([{ text: 'C', ai: false }, { text: 'B', ai: true }, { text: 'A', ai: false }]);
    // The table refuses what no command writes.
    for (const bad of ['{}', '"A"', '[{"text":"A"}]', '[{"text":"A","ai":"no"}]', '[{"text":"  ","ai":false}]', '[{"text":"A","ai":false},{"text":"A","ai":false}]', '[{"text":"A","ai":false,"x":1}]', '[1]', JSON.stringify(Array.from({ length: 6 }, (_, i) => ({ text: `T${i}`, ai: false })))]) {
      await expect(admin((c) => c.query('UPDATE crove_social.post SET text_variations = $2::jsonb, text_variation_next = 0 WHERE id = $1', [postId, bad])), bad).rejects.toMatchObject({ code: '23514' });
    }
    await expect(admin((c) => c.query('UPDATE crove_social.post SET text_variation_next = 3 WHERE id = $1', [postId]))).rejects.toMatchObject({ code: '23514' });
    await expect(admin((c) => c.query("UPDATE crove_social.post SET text_variations = '[]', text_variation_next = 1 WHERE id = $1", [postId]))).rejects.toMatchObject({ code: '23514' });
    // A copy of a series takes its series' variations, never its own.
    const series = await published(o);
    await setRule(o, series.postId, { time: '08:00' });
    const done = await nextCopy(o, series.postId);
    await expect(setVariations(o, done.postId as string, ['X'])).rejects.toMatchObject({ code: 'VARIATIONS_ON_COPY' });
  });
});
