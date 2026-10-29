// Open queue slots on the calendar on PostgreSQL 17 (issue #1158): social.queue.open_slots lists a channel's slots after
// now that no post holds, with their labels, for 31 days at most and only on a channel the caller may use; an owner or
// admin puts one approved or scheduled channel into exactly one of them (social.variant.schedule with slotAt), refused
// with SLOT_TAKEN, SLOT_NOT_IN_QUEUE, SLOT_KEPT_FOR_LABEL, SCHEDULE_IN_PAST or a takedown misfit with nothing changed; a
// post put there is queued like any other, so the queue's next free slots and its shuffle treat it as such.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { CredentialVault, Runtime, parseVaultKey } from '@crove/kernel-runtime';
import { socialCommands, socialQueries, type PostView } from '@crove/mod-social';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const HCM = 'Asia/Ho_Chi_Minh';
const DAYS = [1, 2, 3, 4, 5, 6, 7];
const DAY = 86_400_000;

type OpenSlots = { connectionId: string; timeZone: string | null; paused: boolean; slots: { at: string; labelId: string | null; label: string | null }[]; capped: boolean };
type Scheduled = { postId: string; scheduled: { variantId: string; at: string }[] };
type Row = { status: string; queue_slot_at: Date | null; scheduled_at: Date | null };

suite('social open queue slots on PostgreSQL (#1158)', () => {
  const dbName = `crove_test_social_queue_slots_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appPool: pg.Pool;
  let appDb: Db;
  let api: Runtime;
  const vault = new CredentialVault([parseVaultKey(randomBytes(32).toString('base64'))]);
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

  const person = (name: string) => upsertIdentity(appDb, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@queue-slots.test`, name: null });

  type Org = { orgId: string; owner: string; admin: string; member: string; viewer: string };
  async function org(): Promise<Org> {
    const owner = await person('owner');
    const { orgId } = await createOrg(api, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    const people = { admin: await person('admin'), member: await person('member'), viewer: await person('viewer') };
    for (const [role, id] of Object.entries(people)) {
      await admin((c) => c.query('INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, $3)', [orgId, id, role]));
    }
    return { orgId, owner, ...people };
  }

  const exec = <O>(o: Org, name: string, input: unknown, user = o.owner) => api.execute<O>(name, input, { actor: asUser(user), orgId: o.orgId });
  const query = <O>(o: Org, name: string, input: unknown, user = o.owner) => api.query<O>(name, input, { actor: asUser(user), orgId: o.orgId });
  const get = (o: Org, postId: string) => query<PostView>(o, 'social.post.get', { postId });

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

  // An approved post on the channel, its labels and channel settings set first.
  async function approved(o: Org, connectionId: string, body: string, opts: { labelIds?: string[]; settings?: Record<string, unknown> } = {}) {
    const { postId } = await exec<{ postId: string }>(o, 'social.post.create', { body, channels: [{ connectionId, ...(opts.settings ? { settings: opts.settings } : {}) }] }, o.member);
    if (opts.labelIds) await exec(o, 'social.post.set_labels', { postId, labelIds: opts.labelIds }, o.member);
    await exec(o, 'social.post.submit', { postId }, o.member);
    const post = await get(o, postId);
    await exec(o, 'social.variant.decide', { postId, decision: 'approved', variants: post.variants.map((v) => ({ variantId: v.id, revision: v.revision, contentHash: v.contentHash })) });
    return { postId, variantId: (post.variants[0] as PostView['variants'][number]).id };
  }

  const toSlot = (o: Org, p: { postId: string; variantId: string }, slotAt: string, user = o.owner) => exec<Scheduled>(o, 'social.variant.schedule', { postId: p.postId, variantIds: [p.variantId], queue: true, slotAt }, user);
  const row = (variantId: string) => admin(async (c) => (await c.query<Row>('SELECT status, queue_slot_at, scheduled_at FROM crove_social.post_variant WHERE id = $1', [variantId])).rows[0] as Row);
  const range = (days = 14) => ({ from: new Date().toISOString(), to: new Date(Date.now() + days * DAY).toISOString() });
  const open = (o: Org, connectionId: string, user = o.owner, days = 14) => query<OpenSlots>(o, 'social.queue.open_slots', { connectionId, ...range(days) }, user);
  const local = (at: Date | string) => new Intl.DateTimeFormat('en-GB', { timeZone: HCM, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(at));

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
    const u = new URL(adminUrl);
    u.username = 'crove_app';
    u.password = 'test-app-pw';
    appPool = createPool({ connectionString: u.toString(), max: 6 });
    appDb = createDb(appPool);
    api = new Runtime(appDb, { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands, ...socialCommands], queries: [...kernelQueries({ inboundDomain: null }), ...socialQueries] });
  });

  afterAll(async () => {
    await appPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('lists the open slots after now with their labels, for 31 days at most, on channels the caller may use', async () => {
    const o = await org();
    const conn = await connect(o);
    const other = await connect(o);
    // No queue yet: nothing open.
    expect(await open(o, conn)).toEqual({ connectionId: conn, timeZone: null, paused: false, slots: [], capped: false });
    const { labelId } = await exec<{ labelId: string }>(o, 'social.label.create', { name: 'Khuyến mãi' }, o.member);
    await exec(o, 'social.queue.set', { connectionId: conn, timeZone: HCM, slots: [...DAYS.map((weekday) => ({ weekday, minute: 540 })), ...DAYS.map((weekday) => ({ weekday, minute: 1200, labelId }))] });
    const before = await open(o, conn, o.viewer);
    // Two slots a day for 14 days, give or take the ones of today already gone.
    expect(before.slots.length).toBeGreaterThanOrEqual(27);
    expect(before.slots.length).toBeLessThanOrEqual(28);
    expect(before.slots.every((s) => Date.parse(s.at) > Date.now() - 60_000)).toBe(true);
    const times = before.slots.map((s) => s.at);
    expect(times).toEqual(times.toSorted());
    for (const s of before.slots) expect(s.labelId === null ? [local(s.at), s.label] : [local(s.at), s.labelId, s.label]).toEqual(s.labelId === null ? ['09:00', null] : ['20:00', labelId, 'Khuyến mãi']);
    expect([before.timeZone, before.paused, before.capped]).toEqual([HCM, false, false]);

    // A queued post's slot is no longer open.
    const first = await approved(o, conn, 'Bài đầu');
    const queued = await exec<Scheduled>(o, 'social.variant.schedule', { postId: first.postId, queue: true });
    const at = (queued.scheduled[0] as Scheduled['scheduled'][number]).at;
    expect((await open(o, conn)).slots.map((s) => s.at)).not.toContain(at);

    // A paused queue says so; its slots are still listed (posts put there wait for it).
    await exec(o, 'social.queue.set', { connectionId: conn, timeZone: HCM, paused: true, slots: [...DAYS.map((weekday) => ({ weekday, minute: 540 })), ...DAYS.map((weekday) => ({ weekday, minute: 1200, labelId }))] });
    expect((await open(o, conn)).paused).toBe(true);

    // More than 31 days, or a range that ends before it starts, is refused.
    await expect(query(o, 'social.queue.open_slots', { connectionId: conn, from: new Date().toISOString(), to: new Date(Date.now() + 32 * DAY).toISOString() })).rejects.toMatchObject({ code: 'VALIDATION', status: 422 });
    await expect(query(o, 'social.queue.open_slots', { connectionId: conn, from: new Date(Date.now() + DAY).toISOString(), to: new Date().toISOString() })).rejects.toMatchObject({ code: 'VALIDATION', status: 422 });
    expect((await open(o, conn, o.owner, 31)).slots.length).toBeGreaterThan(before.slots.length);

    // A member limited to the other channel (#1081) may not read this one.
    await exec(o, 'social.channel_access.set', { userId: o.member, channelConnectionIds: [other] }, o.admin);
    await expect(open(o, conn, o.member)).rejects.toMatchObject({ code: 'CHANNEL_NOT_ALLOWED', status: 403 });
    expect((await open(o, other, o.member)).slots).toEqual([]);

    // Another org sees nothing of this queue.
    const stranger = await org();
    expect((await open(stranger, conn)).slots).toEqual([]);
  });

  it('puts an approved channel into exactly the slot dropped on, and moves a scheduled one there', async () => {
    const o = await org();
    const conn = await connect(o);
    await exec(o, 'social.queue.set', { connectionId: conn, timeZone: HCM, slots: DAYS.map((weekday) => ({ weekday, minute: 540 })) });
    const slots = (await open(o, conn)).slots.map((s) => s.at);
    // The fourth open slot, not the next free one.
    const target = slots[3] as string;
    const p = await approved(o, conn, 'Thứ Năm 9 giờ');
    // Members and viewers do not schedule.
    for (const user of [o.member, o.viewer]) await expect(toSlot(o, p, target, user)).rejects.toMatchObject({ status: 403 });
    const result = await toSlot(o, p, target, o.admin);
    expect(result.scheduled).toEqual([{ variantId: p.variantId, at: target }]);
    expect(await row(p.variantId)).toEqual({ status: 'scheduled', queue_slot_at: new Date(target), scheduled_at: null });
    // The slot is no longer open, and the ones before it still are.
    const after = (await open(o, conn)).slots.map((s) => s.at);
    expect(after).not.toContain(target);
    expect(after.slice(0, 3)).toEqual(slots.slice(0, 3));
    const view = await get(o, p.postId);
    expect(view.variants[0]).toMatchObject({ status: 'scheduled', queueSlotAt: target, effectiveAt: target });

    // A channel scheduled at a time of its own moves into a slot and stays scheduled, with its own time gone.
    const fixed = await approved(o, conn, 'Giờ cố định');
    await exec(o, 'social.variant.schedule', { postId: fixed.postId, at: new Date(Date.now() + 2 * DAY + 3_600_000).toISOString() });
    const second = slots[5] as string;
    await toSlot(o, fixed, second);
    expect(await row(fixed.variantId)).toEqual({ status: 'scheduled', queue_slot_at: new Date(second), scheduled_at: null });
    // And from one slot to another.
    await toSlot(o, fixed, slots[6] as string);
    expect((await row(fixed.variantId)).queue_slot_at).toEqual(new Date(slots[6] as string));
    expect((await open(o, conn)).slots.map((s) => s.at)).toContain(second);

    // Without the queue, or for more than one channel, slotAt is refused before anything happens.
    await expect(exec(o, 'social.variant.schedule', { postId: p.postId, variantIds: [p.variantId], slotAt: slots[7] })).rejects.toMatchObject({ code: 'VALIDATION', status: 422 });
    await expect(exec(o, 'social.variant.schedule', { postId: p.postId, queue: true, slotAt: slots[7] })).rejects.toMatchObject({ code: 'VALIDATION', status: 422 });
  });

  it('refuses a slot taken, a time outside the queue, a past slot, a label mismatch and a takedown misfit, changing nothing', async () => {
    const o = await org();
    const conn = await connect(o);
    const { labelId } = await exec<{ labelId: string }>(o, 'social.label.create', { name: 'Khuyến mãi' }, o.member);
    await exec(o, 'social.queue.set', { connectionId: conn, timeZone: HCM, slots: [...DAYS.map((weekday) => ({ weekday, minute: 540 })), ...DAYS.map((weekday) => ({ weekday, minute: 1200, labelId }))] });
    const list = (await open(o, conn)).slots;
    const plain = list.filter((s) => s.labelId === null).map((s) => s.at);
    const promo = list.filter((s) => s.labelId !== null).map((s) => s.at);
    const holder = await approved(o, conn, 'Đã giữ chỗ');
    await toSlot(o, holder, plain[2] as string);

    const p = await approved(o, conn, 'Bài thử');
    const untouched = await row(p.variantId);
    expect(untouched).toEqual({ status: 'approved', queue_slot_at: null, scheduled_at: null });
    await expect(toSlot(o, p, plain[2] as string)).rejects.toMatchObject({ code: 'SLOT_TAKEN', status: 409 });
    // 09:01 is no slot of this queue, nor is a slot past the year ahead.
    await expect(toSlot(o, p, new Date(Date.parse(plain[3] as string) + 60_000).toISOString())).rejects.toMatchObject({ code: 'SLOT_NOT_IN_QUEUE', status: 422 });
    await expect(toSlot(o, p, new Date(Date.parse(plain[3] as string) + 400 * DAY).toISOString())).rejects.toMatchObject({ code: 'SLOT_NOT_IN_QUEUE', status: 422 });
    // Yesterday's 09:00 was a slot, and is gone.
    await expect(toSlot(o, p, new Date(Date.parse(plain[0] as string) - 2 * DAY).toISOString())).rejects.toMatchObject({ code: 'SCHEDULE_IN_PAST', status: 422 });
    // 20:00 is kept for promotions (#745).
    await expect(toSlot(o, p, promo[1] as string)).rejects.toMatchObject({ code: 'SLOT_KEPT_FOR_LABEL', status: 409 });
    expect(await row(p.variantId)).toEqual(untouched);
    const promotion = await approved(o, conn, 'Giảm giá', { labelIds: [labelId] });
    await toSlot(o, promotion, promo[1] as string);
    expect((await row(promotion.variantId)).queue_slot_at).toEqual(new Date(promo[1] as string));

    // A planned takedown (#861) before the slot refuses it; one after it fits.
    const removeAt = new Date(Date.parse(plain[1] as string) + 30 * 60_000).toISOString();
    const takedown = await approved(o, conn, 'Gỡ sau 30 phút', { settings: { removeAt } });
    await expect(toSlot(o, takedown, plain[4] as string)).rejects.toMatchObject({ code: 'REMOVE_AT_BEFORE_PUBLISH', status: 422 });
    expect(await row(takedown.variantId)).toEqual({ status: 'approved', queue_slot_at: null, scheduled_at: null });
    await toSlot(o, takedown, plain[1] as string);
    expect((await row(takedown.variantId)).queue_slot_at).toEqual(new Date(plain[1] as string));

    // A scheduled channel dropped on a taken slot keeps its own.
    await expect(toSlot(o, holder, plain[1] as string)).rejects.toMatchObject({ code: 'SLOT_TAKEN' });
    expect((await row(holder.variantId)).queue_slot_at).toEqual(new Date(plain[2] as string));
  });

  it('leaves a post put in a slot queued like any other: next free slots and the shuffle treat it so', async () => {
    const o = await org();
    const conn = await connect(o);
    await exec(o, 'social.queue.set', { connectionId: conn, timeZone: HCM, slots: DAYS.map((weekday) => ({ weekday, minute: 540 })) });
    const slots = (await open(o, conn)).slots.map((s) => s.at);
    const dropped = await approved(o, conn, 'Thả vào khung giờ');
    await toSlot(o, dropped, slots[0] as string);
    // The queue's next free slots skip it, and the next post queued takes the one after.
    const queue = await query<{ nextFree: string[] }>(o, 'social.queue.get', { connectionId: conn });
    expect(queue.nextFree[0]).toBe(slots[1]);
    const next = await approved(o, conn, 'Bài kế tiếp');
    const queued = await exec<Scheduled>(o, 'social.variant.schedule', { postId: next.postId, queue: true });
    expect(queued.scheduled[0]?.at).toBe(slots[1]);
    // The shuffle trades the two times, so the dropped post moves like any queued one.
    const shuffled = await exec<{ moved: { variantId: string; from: string; at: string }[] }>(o, 'social.queue.shuffle', { connectionId: conn });
    expect(shuffled.moved.map((m) => [m.variantId, m.from, m.at]).sort()).toEqual(
      [
        [dropped.variantId, slots[0], slots[1]],
        [next.variantId, slots[1], slots[0]],
      ].sort(),
    );
    // And unscheduling frees its slot again.
    await exec(o, 'social.variant.unschedule', { variantIds: [dropped.variantId] });
    expect((await open(o, conn)).slots.map((s) => s.at)).toContain(slots[1]);
  });
});
