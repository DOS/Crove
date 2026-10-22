// Crove Social recurring posts on PostgreSQL 17 (issue #979): a series post set to repeat on weekdays at a local time
// gets its next copy after the last one is done, planned for the occurrence in the post's time zone (across a DST
// change) and sent to review; one copy at a time, none while the org's publishing is held, and the series stops at its
// end. Only members of the org set it, and only the worker scans for due series.
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
import { localDate, localTime, nextOccurrence, runPublishJob, socialCommands, socialQueries, sweepRecurring, zonedToEpoch, type PostView, type Recurrence, type RecurringResult } from '@crove/mod-social';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const NY = 'America/New_York';
const HCM = 'Asia/Ho_Chi_Minh';
const WEEK = 7 * 86_400_000;
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

suite('social recurring posts on PostgreSQL (#979)', () => {
  const dbName = `crove_test_social_recurring_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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

  const person = (name: string) => upsertIdentity(appDb, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@recurring.test`, name: null });
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
  const setRule = (o: Org, postId: string, recurrence: Partial<Recurrence>, user = o.owner) =>
    exec<{ postId: string; recurrence: Recurrence }>(o, 'social.post.recurrence_set', { postId, recurrence: { everyWeeks: 1, weekdays: [1], time: '09:00', until: null, times: null, ...recurrence } }, user);
  const next = (o: Org, postId: string) => worker.execute<RecurringResult>('social.recurring.next', { postId }, { actor: { type: 'system', component: 'social-recurring-test' }, orgId: o.orgId });
  const sweep = () => sweepRecurring({ runtime: worker, workerDb });
  const due = () => admin(async (c) => (await c.query<{ post_id: string }>('SELECT post_id FROM crove_social.recurring_due(500)')).rows.map((r) => r.post_id));
  const copies = (seriesId: string) =>
    admin(async (c) => (await c.query<{ id: string; status: string; scheduled_at: Date | null; repost_of: string | null }>('SELECT id, status, scheduled_at, repost_of FROM crove_social.post WHERE recurrence_source_id = $1 ORDER BY created_at, id', [seriesId])).rows);
  const series = (postId: string) =>
    admin(async (c) => (await c.query<{ recurrence_count: number; recurrence_last_at: Date | null; recurrence_next_at: Date | null }>('SELECT recurrence_count, recurrence_last_at, recurrence_next_at FROM crove_social.post WHERE id = $1', [postId])).rows[0]);

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

  // Approves a post in review, schedules it at its planned time (or in an hour), makes it due and publishes it.
  async function approveAndPublish(o: Org, postId: string) {
    const post = await get(o, postId);
    await exec(o, 'social.variant.decide', { postId, decision: 'approved', variants: post.variants.map((v) => ({ variantId: v.id, revision: v.revision, contentHash: v.contentHash })) });
    await exec(o, 'social.variant.schedule', post.scheduledAt ? { postId } : { postId, at: new Date(Date.now() + 3_600_000).toISOString() });
    await admin((c) => c.query("UPDATE crove_social.post_variant SET scheduled_at = now() - interval '1 second' WHERE post_id = $1", [postId]));
    for (const v of post.variants) await runPublishJob({ runtime: worker, broker: vault, publishers: { sandbox: platform }, callTimeoutMs: 2_000 }, o.orgId, v.id, 'sandbox');
    expect((await get(o, postId)).status).toBe('published');
  }

  // A post in a time zone, published on one channel.
  async function published(o: Org, timeZone: string) {
    const connectionId = await connect(o);
    const { postId } = await exec<{ postId: string }>(o, 'social.post.create', { body: `Livestream ${randomUUID().slice(0, 6)}`, timeZone, channels: [{ connectionId }] });
    await exec(o, 'social.post.submit', { postId });
    await approveAndPublish(o, postId);
    return { postId, connectionId };
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

  it("makes the next Monday's copy after the post went out, in review, at 09:00 New York time across a DST change", async () => {
    const o = await org();
    const { postId } = await published(o, NY);
    // The next Monday 09:00 in New York, and a Monday 09:00 on the other side of a DST change, when the original went out.
    const weekly: Recurrence = { everyWeeks: 1, weekdays: [1], time: '09:00', until: null, times: null };
    const monday = nextOccurrence(weekly, NY, Date.now(), Date.now()) as number;
    const offset = (ms: number) => new Date(ms).getUTCHours();
    const day = localTime(monday, NY);
    const mondayWeeksBefore = (k: number) => {
      const d = new Date(Date.UTC(day.year, day.month - 1, day.day) - k * WEEK);
      return zonedToEpoch({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: 9, minute: 0 }, NY);
    };
    let k = 1;
    while (k < 60 && offset(mondayWeeksBefore(k)) === offset(monday)) k += 1;
    const origin = mondayWeeksBefore(k);
    expect(offset(origin)).not.toBe(offset(monday));
    expect(localTime(origin, NY)).toMatchObject({ weekday: 1, hour: 9, minute: 0 });
    await admin((c) => c.query('UPDATE crove_social.post_variant SET published_at = $2 WHERE post_id = $1', [postId, new Date(origin)]));

    expect(await setRule(o, postId, { weekdays: [1], time: '09:00' })).toEqual({ postId, recurrence: weekly });
    expect(await due()).toContain(postId);
    expect(await sweep()).toBeGreaterThanOrEqual(1);
    const [copy] = await copies(postId);
    if (!copy) throw new Error('no copy');
    expect(copy.scheduled_at?.toISOString()).toBe(new Date(monday).toISOString());
    expect(localTime(copy.scheduled_at?.getTime() as number, NY)).toMatchObject({ weekday: 1, hour: 9, minute: 0 });
    const view = await get(o, copy.id);
    expect([view.repostOf, view.recurrenceSourceId, view.recurrence, view.timeZone]).toEqual([postId, postId, null, NY]);
    expect(view.variants.map((v) => v.status)).toEqual(['in_review']);
    expect(await get(o, postId)).toMatchObject({ recurrence: weekly, recurrenceCount: 1 });

    // No second copy while this one is open.
    expect(await due()).not.toContain(postId);
    await sweep();
    expect(await copies(postId)).toHaveLength(1);
    expect(await next(o, postId)).toEqual({ postId: null, reason: 'open_copy' });

    // Approved and scheduled at its planned time, then out: the following Monday is more than a week away, so the series
    // waits with that time noted for the scan.
    await approveAndPublish(o, copy.id);
    expect(await next(o, postId)).toEqual({ postId: null, reason: 'not_due' });
    const state = await series(postId);
    expect(state?.recurrence_last_at?.toISOString()).toBe(new Date(monday).toISOString());
    expect(localTime(state?.recurrence_next_at?.getTime() as number, NY)).toMatchObject({ weekday: 1, hour: 9, minute: 0 });
    expect(state?.recurrence_next_at?.getTime()).toBe(nextOccurrence(weekly, NY, monday, monday));
    expect(await due()).not.toContain(postId);
    expect(await copies(postId)).toHaveLength(1);
  });

  it('stops after its number of times, and at its end date', async () => {
    const o = await org();
    const { postId } = await published(o, HCM);
    await setRule(o, postId, { weekdays: EVERY_DAY, time: '10:00', times: 2 });
    await sweep();
    const [first] = await copies(postId);
    if (!first?.scheduled_at) throw new Error('no copy');
    // A cancelled copy is done: the next one comes, a day later at the same time.
    await exec(o, 'social.variant.cancel', { variantIds: (await get(o, first.id)).variants.map((v) => v.id) });
    await sweep();
    const list = await copies(postId);
    expect(list).toHaveLength(2);
    expect((list[1]?.scheduled_at?.getTime() ?? 0) - first.scheduled_at.getTime()).toBe(86_400_000);
    // Two times made: the series is over, its count kept.
    expect(await get(o, postId)).toMatchObject({ recurrence: null, recurrenceCount: 2 });
    await exec(o, 'social.variant.cancel', { variantIds: (await get(o, list[1]?.id as string)).variants.map((v) => v.id) });
    await sweep();
    expect(await copies(postId)).toHaveLength(2);

    // A new run counts from zero; a number of times at or below the count of a running rule is refused.
    await setRule(o, postId, { weekdays: EVERY_DAY, time: '10:00', times: 3 });
    await sweep();
    expect(await get(o, postId)).toMatchObject({ recurrenceCount: 1 });
    await expect(setRule(o, postId, { weekdays: EVERY_DAY, time: '10:00', times: 1 })).rejects.toMatchObject({ code: 'RECURRENCE_TIMES_REACHED' });

    // An end date today with a time already gone today: nothing is left, the series ends without a copy.
    const other = await published(o, HCM);
    const today = localDate(Date.now(), HCM);
    await expect(setRule(o, other.postId, { weekdays: EVERY_DAY, time: '00:00', until: '2020-01-01' })).rejects.toMatchObject({ code: 'RECURRENCE_UNTIL_PAST' });
    await setRule(o, other.postId, { weekdays: EVERY_DAY, time: '00:00', until: today });
    expect(await next(o, other.postId)).toEqual({ postId: null, reason: 'until' });
    expect(await copies(other.postId)).toEqual([]);
    expect((await get(o, other.postId)).recurrence).toBeNull();
  });

  it('makes no copy while the org is held, leaves another org alone, and makes it after the release', async () => {
    const [a, b] = [await org(), await org()];
    const sa = await published(a, HCM);
    const sb = await published(b, HCM);
    await setRule(a, sa.postId, { weekdays: EVERY_DAY, time: '12:00' });
    await setRule(b, sb.postId, { weekdays: EVERY_DAY, time: '12:00' });
    await exec(a, 'social.publishing.hold', { reason: 'Ngày quốc tang' });
    const listed = await due();
    expect(listed).not.toContain(sa.postId);
    expect(listed).toContain(sb.postId);
    expect(await next(a, sa.postId)).toEqual({ postId: null, reason: 'held' });
    await sweep();
    expect(await copies(sa.postId)).toEqual([]);
    expect(await copies(sb.postId)).toHaveLength(1);
    await exec(a, 'social.publishing.release', {});
    await sweep();
    expect(await copies(sa.postId)).toHaveLength(1);
  });

  it('is set only by members of the org who write posts, never on a copy or with evergreen, and only the worker scans', async () => {
    const o = await org();
    const outsider = await org();
    const { postId } = await published(o, HCM);
    // Members may set it; viewers may not; nobody of another org may, in either org.
    await setRule(o, postId, { weekdays: [5], time: '20:00' }, o.member);
    await expect(setRule(o, postId, { weekdays: [5] }, o.viewer)).rejects.toMatchObject({ status: 403 });
    await expect(setRule(o, postId, { weekdays: [5] }, outsider.owner)).rejects.toMatchObject({ status: 403 });
    await expect(setRule(outsider, postId, { weekdays: [5] })).rejects.toMatchObject({ code: 'POST_NOT_FOUND' });
    await expect(exec(outsider, 'social.post.recurrence_clear', { postId })).rejects.toMatchObject({ code: 'POST_NOT_FOUND' });
    expect((await get(o, postId)).recurrence).toMatchObject({ weekdays: [5], time: '20:00' });

    // The rule's shape: refused by the command, and by the table for a value no command writes.
    await expect(setRule(o, postId, { weekdays: [] })).rejects.toBeDefined();
    await expect(setRule(o, postId, { weekdays: [1, 1] })).rejects.toBeDefined();
    await expect(setRule(o, postId, { everyWeeks: 5 })).rejects.toBeDefined();
    await expect(setRule(o, postId, { time: '24:00' })).rejects.toBeDefined();
    await expect(setRule(o, postId, { until: '2027-02-30' })).rejects.toBeDefined();
    for (const bad of ['"weekly"', '[]', '{"everyWeeks":"x","weekdays":[1],"time":"09:00"}', '{"everyWeeks":1,"weekdays":"1","time":"09:00"}', '{"everyWeeks":1,"weekdays":[1],"time":"09:00","until":"2027-02-30"}', '{"everyWeeks":1,"weekdays":[1],"time":"09:00","times":1e9}', '{"everyWeeks":1,"weekdays":[1],"time":"09:00","extra":true}']) {
      await expect(admin((c) => c.query('UPDATE crove_social.post SET recurrence = $2::jsonb WHERE id = $1', [postId, bad])), bad).rejects.toMatchObject({ code: '23514' });
    }

    // One kind of repeat per post.
    await expect(exec(o, 'social.post.set_evergreen', { postId, days: 30 })).rejects.toMatchObject({ code: 'RECURRENCE_WITH_EVERGREEN' });
    await exec(o, 'social.post.recurrence_clear', { postId }, o.member);
    expect((await get(o, postId)).recurrence).toBeNull();
    await exec(o, 'social.post.set_evergreen', { postId, days: 30 });
    await expect(setRule(o, postId, {})).rejects.toMatchObject({ code: 'RECURRENCE_WITH_EVERGREEN' });
    await exec(o, 'social.post.set_evergreen', { postId, days: null });

    // A copy never becomes a series of its own.
    await setRule(o, postId, { weekdays: EVERY_DAY });
    await sweep();
    const [copy] = await copies(postId);
    if (!copy) throw new Error('no copy');
    await expect(setRule(o, copy.id, {})).rejects.toMatchObject({ code: 'RECURRENCE_ON_COPY' });

    // The next copy is the worker's alone, and so is the scan.
    await expect(exec(o, 'social.recurring.next', { postId })).rejects.toBeDefined();
    await expect(appPool.query('SELECT * FROM crove_social.recurring_due(10)')).rejects.toMatchObject({ code: '42501' });
    const can = await admin(async (c) =>
      (
        await c.query<{ role: string }>(
          `SELECT r AS role FROM unnest(ARRAY['crove_app', 'crove_worker', 'crove_tenant', 'crove_definer_tenant']) r WHERE has_function_privilege(r, 'crove_social.recurring_due(int)', 'EXECUTE') ORDER BY 1`,
        )
      ).rows.map((r) => r.role),
    );
    expect(can).toEqual(['crove_worker']);
  });
});
